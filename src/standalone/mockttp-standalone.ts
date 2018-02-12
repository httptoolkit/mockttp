/**
 * @module Mockttp
 */

import * as path from 'path';
import * as fs from '../util/fs';
import * as _ from "lodash";
import * as express from 'express';
import * as cors from 'cors';
import * as http from 'http';
import * as net from 'net';
import * as bodyParser from 'body-parser';

import { graphqlExpress } from 'apollo-server-express';
import { GraphQLSchema, GraphQLScalarType, execute, subscribe } from 'graphql';
import { makeExecutableSchema } from 'graphql-tools';
import { SubscriptionServer } from 'subscriptions-transport-ws';

import destroyable, { DestroyableServer } from "../util/destroyable-server";
import MockttpServer from "../server/mockttp-server";
import { buildStandaloneModel } from "./standalone-model";
import { DEFAULT_STANDALONE_PORT } from '../types';
import { MockttpOptions } from '../mockttp';

export interface StandaloneServerOptions {
    debug?: boolean;
}

export class MockttpStandalone {
    private debug: boolean;
    private app: express.Application = express();
    private server: DestroyableServer | null = null;

    private mockServers: MockttpServer[] = [];

    constructor(options: StandaloneServerOptions = {}) {
        this.debug = options.debug || false;
        if (this.debug) console.log('Standalone server started in debug mode');

        this.app.use(cors());
        this.app.use(bodyParser.json());

        this.app.post('/start', async (req, res) => {
            if (this.debug) console.log('Standalone starting mock server on port', req.query.port);

            try {
                const port: number | undefined = req.query.port ?
                    parseInt(req.query.port, 10) : undefined;
                const options: MockttpOptions = req.body || {};

                if (port != null && this.routers[port] != null) {
                    res.status(409).json({
                        error: `Cannot start: mock server is already running on port ${port}`
                    });
                    return;
                }

                const { mockPort, mockServer } = await this.startMockServer(options, port);

                const config: MockServerConfig = {
                    port: mockPort,
                    mockRoot: mockServer.url
                };

                res.json(config);
            } catch (e) {
                res.status(500).json({ error: `Failed to start server: ${e.message || e}` });
            }
        });

        // Dynamically route to admin servers ourselves, so we can easily add/remove
        // servers as we see fit later on.
        this.app.use('/server/:port/', (req, res, next) => {
            this.routers[req.params.port](req, res, next);
        });
    }

    private loadSchema(schemaFilename: string, mockServer: MockttpServer): Promise<GraphQLSchema> {
        return fs.readFile(path.join(__dirname, schemaFilename), 'utf8')
        .then((schemaString) => makeExecutableSchema({
            typeDefs: schemaString,
            resolvers: buildStandaloneModel(mockServer)
        }));
    }

    async start() {
        if (this.server) throw new Error('Standalone server already running');

        await new Promise<void>((resolve, reject) => {
            this.server = destroyable(this.app.listen(DEFAULT_STANDALONE_PORT, resolve));

            this.server.on('upgrade', (req: Request, socket: net.Socket, head: Buffer) => {
                let serverMatch = req.url.match(/\/server\/(\d+)\/?$/)
                if (serverMatch) {
                    let port = parseInt(serverMatch[1], 10);
                    if (this.subscriptionServers[port]) {
                        let wsServer = (<any> this.subscriptionServers[port]).wsServer;
                        wsServer.handleUpgrade(req, socket, head, (ws: net.Socket) => {
                            wsServer.emit('connection', ws);
                        });
                    } else {
                        console.warn(`Unrecognized websocket request for unknown server port ${port}`);
                        socket.destroy();
                    }
                } else {
                    console.warn(`Unrecognized websocket request for ${req.url}`);
                    socket.destroy();
                }
            });
        });
    }

    private routers: { [port: number]: express.Router } = { };
    private subscriptionServers: { [port: number]: SubscriptionServer } = { };

    private async startMockServer(options: MockttpOptions, port?: number): Promise<{
        mockPort: number,
        mockServer: MockttpServer
    }> {
        const mockServer = new MockttpServer(_.defaults({
            debug: this.debug // Use debug mode if the client requests it, or if the standalone has it set
        }, options));
        this.mockServers.push(mockServer);
        await mockServer.start(port);

        const mockPort = mockServer.port!;

        const mockServerRouter = express.Router();
        this.routers[mockPort] = mockServerRouter;

        mockServerRouter.get('/pendingMocks', async (req, res) => {
            try {
                var checkRequests = await mockServer.pendingMocks();
                res.status(200).send(JSON.stringify(checkRequests));
            } catch (error) {
                res.status(500).send(JSON.stringify({ message : error.message }));
            }
        });

        mockServerRouter.post('/stop', async (req, res) => {
            await mockServer.stop();

            this.mockServers = _.reject(this.mockServers, mockServer);
            delete this.routers[mockPort];

            res.status(200).send(JSON.stringify({
                success: true
            }));
        });

        const schema = await this.loadSchema('schema.gql', mockServer);

        this.subscriptionServers[mockPort] = SubscriptionServer.create({
            schema, execute, subscribe
        }, {
            noServer: true
        });

        mockServerRouter.use(bodyParser.json(), graphqlExpress({
            schema
        }));

        return {
            mockPort,
            mockServer
        };
    }

    stop(): Promise<void> {
        if (!this.server) return Promise.resolve<void>();

        return Promise.all([
            this.server.destroy(),
        ].concat(
            this.mockServers.map((s) => s.stop())
        )).then(() => {
            this.server = null;
        });
    }
}

export interface MockServerConfig {
    port: number,
    mockRoot: string
}
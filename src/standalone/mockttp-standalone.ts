/**
 * @module Mockttp
 */

/// <reference path="../../custom-typings/asynciterator.d.ts" />

import * as path from 'path';
import * as fs from '../util/fs';
import * as _ from 'lodash';
import * as express from 'express';
import * as cors from 'cors';
import * as http from 'http';
import * as net from 'net';
import * as bodyParser from 'body-parser';
import * as ws from 'ws';

import { graphqlExpress } from 'apollo-server-express';
import { GraphQLSchema, GraphQLScalarType, execute, subscribe } from 'graphql';
import { makeExecutableSchema } from 'graphql-tools';
import { SubscriptionServer } from 'subscriptions-transport-ws';
import connectWebSocketStream = require('websocket-stream');
import DuplexPassthrough = require('duplex-passthrough');

import destroyable, { DestroyableServer } from "../util/destroyable-server";
import MockttpServer from "../server/mockttp-server";
import { buildStandaloneModel } from "./standalone-model";
import { DEFAULT_STANDALONE_PORT } from '../types';
import { MockttpOptions } from '../mockttp';
import { Duplex, PassThrough } from 'stream';

export interface StandaloneServerOptions {
    debug?: boolean;
    serverDefaults?: MockttpOptions;
}

export class MockttpStandalone {
    private debug: boolean;
    private app = express();
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
                const mockServerOptions: MockttpOptions = _.defaults(
                    {},
                    req.body,
                    options.serverDefaults
                );

                if (port != null && this.routers[port] != null) {
                    res.status(409).json({
                        error: `Cannot start: mock server is already running on port ${port}`
                    });
                    return;
                }

                const { mockPort, mockServer } = await this.startMockServer(mockServerOptions, port);

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
            if (!this.routers[req.params.port]) {
                res.status(404).send('Unknown mock server');
                throw new Error(`Request for unknown mock server port: ${req.params.port}`);
            }

            this.routers[req.params.port](req, res, next);
        });
    }

    private loadSchema(schemaFilename: string, mockServer: MockttpServer, stream: Duplex): Promise<GraphQLSchema> {
        return fs.readFile(path.join(__dirname, schemaFilename), 'utf8')
        .then((schemaString) => makeExecutableSchema({
            typeDefs: schemaString,
            resolvers: buildStandaloneModel(mockServer, stream)
        }));
    }

    async start(standalonePort: number = DEFAULT_STANDALONE_PORT) {
        if (this.server) throw new Error('Standalone server already running');

        await new Promise<void>((resolve, reject) => {
            this.server = destroyable(this.app.listen(standalonePort, resolve));

            this.server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
                let isSubscriptionRequest = req.url!.match(/^\/server\/(\d+)\/subscription$/);
                let isStreamRequest = req.url!.match(/^\/server\/(\d+)\/stream$/);
                let isMatch = isSubscriptionRequest || isStreamRequest;

                if (isMatch) {
                    let port = parseInt(isMatch[1], 10);

                    let wsServer: ws.Server = isSubscriptionRequest ?
                        (<any> this.subscriptionServers[port]).wsServer :
                        this.streamServers[port];

                    if (wsServer) {
                        wsServer.handleUpgrade(req, socket, head, (ws) => {
                            wsServer.emit('connection', ws, req);
                        });
                    } else {
                        console.warn(`Websocket request for unrecognized mock server: ${port}`);
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
    private streamServers: { [port: number]: ws.Server } = { };

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

        mockServerRouter.post('/stop', async (req, res) => {
            await mockServer.stop();

            this.mockServers = _.reject(this.mockServers, mockServer);
            delete this.routers[mockPort];
            delete this.subscriptionServers[mockPort];

            this.streamServers[mockPort].close();
            this.streamServers[mockPort].emit('close');
            delete this.streamServers[mockPort];

            res.status(200).send(JSON.stringify({
                success: true
            }));
        });

        const serverSideStream = new DuplexPassthrough(null, { objectMode: true });
        const clientSideStream = new DuplexPassthrough(null, { objectMode: true });

        serverSideStream._writer.pipe(clientSideStream._reader);
        clientSideStream._writer.pipe(serverSideStream._reader);

        if (this.debug) {
            clientSideStream._writer.on('data', (d) => {
                console.debug('Streaming data to clients:', d.toString());
            });
            clientSideStream._reader.on('data', (d) => {
                console.debug('Streaming data from clients:', d.toString());
            });
        }

        this.streamServers[mockPort] = new ws.Server({ noServer: true });
        this.streamServers[mockPort].on('connection', (ws: WebSocket) => {
            let newClientStream = connectWebSocketStream(ws, { objectMode: true });
            newClientStream.pipe(clientSideStream, { end: false });
            clientSideStream.pipe(newClientStream);
        });
        this.streamServers[mockPort].on('close', () => clientSideStream.end());

        const schema = await this.loadSchema('schema.gql', mockServer, serverSideStream);

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
        if (!this.server) return Promise.resolve();

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
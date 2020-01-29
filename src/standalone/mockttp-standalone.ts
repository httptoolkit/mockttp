/**
 * @module Mockttp
 */

/// <reference path="../../custom-typings/asynciterator.d.ts" />

import * as path from 'path';
import * as fs from '../util/fs';
import * as _ from 'lodash';
import * as express from 'express';
import * as cors from 'cors';
import corsGate = require('cors-gate');
import * as http from 'http';
import * as net from 'net';
import * as bodyParser from 'body-parser';
import * as ws from 'ws';

import { graphqlExpress } from 'apollo-server-express';
import { GraphQLSchema, execute, subscribe } from 'graphql';
import { makeExecutableSchema } from 'graphql-tools';
import { SubscriptionServer } from 'subscriptions-transport-ws';
import connectWebSocketStream = require('websocket-stream');
import { Duplex } from 'stream';
import DuplexPair = require('native-duplexpair');

import { destroyable, DestroyableServer } from "../util/destroyable-server";
import MockttpServer from "../server/mockttp-server";
import { buildStandaloneModel } from "./standalone-model";
import { DEFAULT_STANDALONE_PORT } from '../types';
import { MockttpOptions, PortRange } from '../mockttp';

export interface StandaloneServerOptions {
    debug?: boolean;
    serverDefaults?: MockttpOptions;
    corsOptions?: cors.CorsOptions & { strict: boolean };
}

export class MockttpStandalone {
    private debug: boolean;
    private app = express();
    private server: DestroyableServer | null = null;

    private mockServers: MockttpServer[] = [];

    constructor(options: StandaloneServerOptions = {}) {
        this.debug = options.debug || false;
        if (this.debug) console.log('Standalone server started in debug mode');

        this.app.use(cors(options.corsOptions));
        if (options.corsOptions && options.corsOptions.strict) {
            this.app.use(corsGate({
                strict: true, // MUST send an allowed origin
                allowSafe: false, // Even for HEAD/GET requests (should be none anyway)
                origin: '' // No origin - we accept *no* same-origin requests
            }));
        }

        this.app.use(bodyParser.json({ limit: '50mb' }));

        this.app.post('/start', async (req, res) => {
            if (this.debug) console.log('Standalone starting mock server on port', req.query.port);

            try {
                const port: number | PortRange | undefined = req.query.port
                    ? JSON.parse(req.query.port)
                    : undefined;
                const mockServerOptions: MockttpOptions = _.defaults(
                    {},
                    req.body,
                    options.serverDefaults
                );

                if (_.isNumber(port) && this.routers[port] != null) {
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
            const serverPort = Number(req.params.port);
            const serverRouter = this.routers[serverPort];

            if (!serverRouter) {
                res.status(404).send('Unknown mock server');
                console.error(`Request for unknown mock server port: ${req.params.port}`);
                return;
            }

            serverRouter(req, res, next);
        });
    }

    private loadSchema(schemaFilename: string, mockServer: MockttpServer, stream: Duplex): Promise<GraphQLSchema> {
        return fs.readFile(path.join(__dirname, schemaFilename), 'utf8')
        .then((schemaString) => makeExecutableSchema({
            typeDefs: schemaString,
            resolvers: buildStandaloneModel(mockServer, stream)
        }));
    }

    async start(listenOptions: number | {
            port: number,
            host: string
        } = DEFAULT_STANDALONE_PORT
    ) {
        if (this.server) throw new Error('Standalone server already running');

        await new Promise<void>((resolve, reject) => {
            this.server = destroyable(this.app.listen(listenOptions, resolve));

            this.server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
                let isSubscriptionRequest = req.url!.match(/^\/server\/(\d+)\/subscription$/);
                let isStreamRequest = req.url!.match(/^\/server\/(\d+)\/stream$/);
                let isMatch = isSubscriptionRequest || isStreamRequest;

                if (isMatch) {
                    let port = parseInt(isMatch[1], 10);

                    let wsServer: ws.Server = isSubscriptionRequest ?
                        (<any> this.subscriptionServers[port])?.wsServer :
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

    private async startMockServer(options: MockttpOptions, portConfig?: number | PortRange): Promise<{
        mockPort: number,
        mockServer: MockttpServer
    }> {
        const mockServer = new MockttpServer(_.defaults(options, {
            // Use debug mode if the client requests it, or if the standalone has it set
            debug: this.debug
        }));
        await mockServer.start(portConfig);
        this.mockServers.push(mockServer);

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

        // A pair of sockets, representing the 2-way connection between the server & WSs.
        // All websocket messages are written to wsSocket, and then read from serverSocket
        // All server messages are written to serverSocket, and then read from wsSocket and sent
        const { socket1: wsSocket, socket2: serverSocket } = new DuplexPair();

        if (this.debug) {
            serverSocket.on('data', (d: any) => {
                console.debug('Streaming data to WS clients:', d.toString());
            });
            wsSocket.on('data', (d: any) => {
                console.debug('Streaming data from WS clients:', d.toString());
            });
        }

        this.streamServers[mockPort] = new ws.Server({ noServer: true });
        this.streamServers[mockPort].on('connection', (ws: WebSocket) => {
            let newClientStream = connectWebSocketStream(ws);
            wsSocket.pipe(newClientStream).pipe(wsSocket, { end: false });
        });
        this.streamServers[mockPort].on('close', () => {
            wsSocket.end();
            serverSocket.end();
        });

        const schema = await this.loadSchema('schema.gql', mockServer, serverSocket);

        this.subscriptionServers[mockPort] = SubscriptionServer.create({
            schema, execute, subscribe
        }, {
            noServer: true
        });

        mockServerRouter.use(graphqlExpress({ schema }));

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

    get activeServerPorts() {
        return this.mockServers.map(s => s.port);
    }
}

export interface MockServerConfig {
    port: number,
    mockRoot: string
}
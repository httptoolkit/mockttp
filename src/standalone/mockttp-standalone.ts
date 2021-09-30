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
import * as Ws from 'ws';

import { graphqlHTTP } from 'express-graphql';
import { GraphQLSchema, execute, subscribe } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { SubscriptionServer } from '@httptoolkit/subscriptions-transport-ws';
import { Duplex, EventEmitter } from 'stream';
import DuplexPair = require('native-duplexpair');

import { destroyable, DestroyableServer } from "../util/destroyable-server";
import { MockttpServer } from "../server/mockttp-server";
import { buildStandaloneModel } from "./standalone-model";
import { DEFAULT_STANDALONE_PORT } from '../types';
import { Mockttp, MockttpOptions, PortRange } from '../mockttp';

export interface StandaloneServerOptions {
    debug?: boolean;
    serverDefaults?: MockttpOptions;
    corsOptions?: cors.CorsOptions & { strict?: boolean };
    webSocketKeepAlive?: number;
}

async function strictOriginMatch(
    origin: string | undefined,
    expectedOrigin: cors.CorsOptions['origin']
): Promise<boolean> {
    if (!origin) return false;

    if (typeof expectedOrigin === 'string') {
        return expectedOrigin === origin;
    }

    if (_.isRegExp(expectedOrigin)) {
        return !!origin.match(expectedOrigin);
    }

    if (_.isArray(expectedOrigin)) {
        return _.some(expectedOrigin, (exp) =>
            strictOriginMatch(origin, exp)
        );
    }

    if (_.isFunction(expectedOrigin)) {
        return new Promise<boolean>((resolve, reject) => {
            expectedOrigin(origin, (error, result) => {
                if (error) reject(error);
                else resolve(strictOriginMatch(origin, result));
            });
        });
    }

    // We don't allow boolean or undefined matches
    return false;
}

export class MockttpStandalone {

    private debug: boolean;
    private requiredOrigin: cors.CorsOptions['origin'] | false;
    private webSocketKeepAlive: number | undefined;

    private app = express();
    private server: DestroyableServer | null = null;
    private eventEmitter = new EventEmitter();

    private servers: { [port: number]: {
        router: express.Router,
        stop: () => Promise<void>,

        mockServer: MockttpServer,
        subscriptionServer: SubscriptionServer,
        streamServer: Ws.Server
    } } = { };

    constructor(options: StandaloneServerOptions = {}) {
        this.debug = options.debug || false;
        if (this.debug) console.log('Standalone server started in debug mode');

        this.webSocketKeepAlive = options.webSocketKeepAlive || undefined;

        this.app.use(cors(options.corsOptions));

        // If you use strict CORS, and set a specific origin, we'll enforce it:
        this.requiredOrigin = !!options.corsOptions &&
            !!options.corsOptions.strict &&
            !!options.corsOptions.origin &&
            typeof options.corsOptions.origin !== 'boolean' &&
            options.corsOptions.origin;

        if (this.requiredOrigin) {
            this.app.use(corsGate({
                strict: true, // MUST send an allowed origin
                allowSafe: false, // Even for HEAD/GET requests (should be none anyway)
                origin: '' // No base origin - we accept *no* same-origin requests
            }));
        }

        this.app.use(bodyParser.json({ limit: '50mb' }));

        this.app.post('/start', async (req, res) => {
            if (this.debug) console.log('Standalone starting mock server on port', req.query.port);

            try {
                const port: number | PortRange | undefined = (typeof req.query.port === 'string')
                    ? JSON.parse(req.query.port)
                    : undefined;
                const mockServerOptions: MockttpOptions = _.defaults(
                    {},
                    req.body,
                    options.serverDefaults
                );

                if (_.isNumber(port) && this.servers[port] != null) {
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

        this.app.post('/reset', async (req, res) => {
            if (this.debug) console.log('Resetting standalone server');

            try {
                await Promise.all(
                    Object.values(this.servers).map(({ stop }) => stop())
                );
                res.json({ success: true });
            } catch (e) {
                res.status(500).json({ error: e?.message || 'Unknown error' });
            }
        });


        // Dynamically route to admin servers ourselves, so we can easily add/remove
        // servers as we see fit later on.
        this.app.use('/server/:port/', (req, res, next) => {
            const serverPort = Number(req.params.port);
            const serverRouter = this.servers[serverPort]?.router;

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

    /**
     * Subscribe to hear when each mock server is started. The listener is provided the
     * server instance, which can be used to log server startup, add side-effects that
     * run elsewhere at startup, or preconfigure every started server.
     *
     * This is run synchronously when a server is created, after it has fully started
     * but before its been returned to remote clients.
     */
    on(event: 'mock-server-started', listener: (server: Mockttp) => void): void;

    /**
     * Subscribe to hear when each mock server is stopped. The listener is provided the
     * server instance, which can be used to log server shutdown, add side-effects that
     * run elsewhere at shutdown, or clean up after servers in other ways.
     *
     * This is run synchronously immediately before the server is shutdown, whilst all
     * its state is still available, and before remote clients have had any response to
     * their request to shut the server down. This is also run before shutdown when the
     * standalone server itself is cleanly shutdown with `standalone.stop()`.
     */
    on(event: 'mock-server-stopping', listener: (server: Mockttp) => void): void;
    on(event: string, listener: (...args: any) => void): void {
        this.eventEmitter.on(event, listener);
    }

    async start(
        listenOptions: number | {
            port: number,
            host: string
        } = DEFAULT_STANDALONE_PORT
    ) {
        if (this.server) throw new Error('Standalone server already running');

        await new Promise<void>((resolve, reject) => {
            this.server = destroyable(this.app.listen(listenOptions, resolve));

            this.server.on('error', reject);

            this.server.on('upgrade', async (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
                const reqOrigin = req.headers['origin'] as string | undefined;
                if (this.requiredOrigin && !await strictOriginMatch(reqOrigin, this.requiredOrigin)) {
                    console.warn(`Websocket request from invalid origin: ${req.headers['origin']}`);
                    socket.destroy();
                    return;
                }

                let isSubscriptionRequest = req.url!.match(/^\/server\/(\d+)\/subscription$/);
                let isStreamRequest = req.url!.match(/^\/server\/(\d+)\/stream$/);
                let isMatch = isSubscriptionRequest || isStreamRequest;

                if (isMatch) {
                    let port = parseInt(isMatch[1], 10);

                    let wsServer: Ws.Server = isSubscriptionRequest
                        ? (<any> this.servers[port]?.subscriptionServer)?.wsServer
                        : this.servers[port]?.streamServer;

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

    private async startMockServer(options: MockttpOptions, portConfig?: number | PortRange): Promise<{
        mockPort: number,
        mockServer: MockttpServer
    }> {
        const mockServer = new MockttpServer(_.defaults(options, {
            // Use debug mode if the client requests it, or if the standalone has it set
            debug: this.debug
        }));

        await mockServer.start(portConfig);

        const mockPort = mockServer.port!;

        const mockServerRouter = express.Router();

        let running = true;
        const stopServer = async () => {
            if (!running) return;
            running = false;

            this.eventEmitter.emit('mock-server-stopping', mockServer);

            const server = this.servers[mockPort];
            delete this.servers[mockPort];

            await mockServer.stop();
            server.subscriptionServer.close();

            // Close with code 1000 (purpose is complete - no more streaming happening)
            server.streamServer.clients.forEach((client) => {
                client.close(1000);
            });
            server.streamServer.close();
            server.streamServer.emit('close');
        };

        mockServerRouter.post('/stop', async (req, res) => {
            await stopServer();
            res.json({ success: true });
        });

        // A pair of sockets, representing the 2-way connection between the server & WSs.
        // All websocket messages are written to wsSocket, and then read from serverSocket
        // All server messages are written to serverSocket, and then read from wsSocket and sent
        const { socket1: wsSocket, socket2: serverSocket } = new DuplexPair();

        if (this.debug) {
            serverSocket.on('data', (d: any) => {
                console.log('Streaming data from WS clients:', d.toString());
            });
            wsSocket.on('data', (d: any) => {
                console.log('Streaming data to WS clients:', d.toString());
            });
        }

        const streamServer = new Ws.Server({ noServer: true });
        streamServer.on('connection', (ws) => {
            let newClientStream = Ws.createWebSocketStream(ws, {});
            wsSocket.pipe(newClientStream).pipe(wsSocket, { end: false });

            const unpipe = () => {
                wsSocket.unpipe(newClientStream);
                newClientStream.unpipe(wsSocket);
            };

            newClientStream.on('error', unpipe);
            wsSocket.on('end', unpipe);
        });

        streamServer.on('close', () => {
            wsSocket.end();
            serverSocket.end();
        });

        if (this.webSocketKeepAlive) {
            // If we have a keep-alive set, send the client a ping frame every Xms to
            // try and stop closes (especially by browsers) due to inactivity.
            const streamServerKeepAlive = setInterval(() => {
                streamServer.clients.forEach((client) => {
                    if (client.readyState !== Ws.OPEN) return;
                    client.ping(() => {});
                });
            }, this.webSocketKeepAlive);
            streamServer.on('close', () => clearInterval(streamServerKeepAlive));
        }

        // Handle errors by logging & stopping this server instance
        const onStreamError = (e: Error) => {
            if (!running) return; // We don't care about connection issues during shutdown
            console.error("Error in server standalone stream, shutting down mock server");
            console.error(e);
            stopServer();
        };
        wsSocket.on('error', onStreamError);
        serverSocket.on('error', onStreamError);

        const schema = await this.loadSchema('schema.gql', mockServer, serverSocket);

        const subscriptionServer = SubscriptionServer.create({
            schema,
            execute,
            subscribe,
            keepAlive: this.webSocketKeepAlive
        }, {
            noServer: true
        });

        mockServerRouter.use(graphqlHTTP({ schema }));

        this.servers[mockPort] = {
            mockServer,
            router: mockServerRouter,
            streamServer,
            subscriptionServer,
            stop: stopServer
        };

        this.eventEmitter.emit('mock-server-started', mockServer);

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
            Object.values(this.servers).map((s) => s.stop())
        )).then(() => {
            this.server = null;
        });
    }

    get activeServerPorts() {
        return Object.keys(this.servers);
    }
}

export interface MockServerConfig {
    port: number,
    mockRoot: string
}
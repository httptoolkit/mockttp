import * as _ from 'lodash';
import * as express from 'express';
import * as cors from 'cors';
import corsGate = require('cors-gate');
import * as http from 'http';
import * as net from 'net';
import * as bodyParser from 'body-parser';
import * as Ws from 'ws';
import { v4 as uuid } from "uuid";

import { createHandler as createGraphQLHandler } from 'graphql-http/lib/use/express';
import { execute, formatError, GraphQLScalarType, subscribe } from 'graphql';
import gql from 'graphql-tag';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { SubscriptionServer } from '@httptoolkit/subscriptions-transport-ws';
import { EventEmitter } from 'stream';
import DuplexPair = require('native-duplexpair');

import { makeDestroyable, DestroyableServer } from "destroyable-server";
import { isErrorLike } from '../util/error';
import { objectAllPromise } from '../util/promise';

import { DEFAULT_ADMIN_SERVER_PORT } from '../types';

import { RuleParameters } from '../rules/rule-parameters';
import { AdminPlugin, PluginConstructorMap, PluginStartParamsMap } from './admin-plugin-types';
import { parseAnyAst } from './graphql-utils';
import { MockttpAdminPlugin } from './mockttp-admin-plugin';

export interface AdminServerOptions<Plugins extends { [key: string]: AdminPlugin<any, any> }> {
    /**
     * Should the admin server print extra debug information? This enables admin server debugging
     * only - individual mock session debugging must be enabled separately.
     */
    debug?: boolean;

    /**
     * Set CORS options to limit the sites which can send requests to manage this admin server.
     */
    corsOptions?: cors.CorsOptions & {
        strict?: boolean,
        allowPrivateNetworkAccess?: boolean
    };

    /**
     * Set a keep alive frequency in milliseconds for the subscription & stream websockets of each
     * session, to ensure they remain connected in long-lived connections, especially in browsers which
     * often close quiet background connections automatically.
     */
    webSocketKeepAlive?: number;

    /**
     * Override the default parameters for sessions started from this admin server. These values will be
     * used for each setting that is not explicitly specified by the client when creating a mock session.
     */
    pluginDefaults?: Partial<PluginStartParamsMap<Plugins>>;

    /**
     * Some rule options can't easily be specified in remote clients, since they need to access
     * server-side state or Node APIs directly. To handle this, referenceable parameters can
     * be provided here, and referenced with a `{ [MOCKTTP_PARAM_REF]: <value> }` value in place
     * of the real parameter in the remote client.
     */
    ruleParameters?: {
        [key: string]: any
    }

    /**
     * @internal
     *
     * This API is not yet stable, and is intended for internal use only. It may change in future
     * in minor versions without warning.
     *
     * This defines admin plugin modules: remote-controlled types of mocks that should be attached to this
     * admin server, to allow configuring other mocking services through the same HTTP infrastructure.
     *
     * This can be useful when mocking non-HTTP protocols like WebRTC.
     */
    adminPlugins?: PluginConstructorMap<Plugins>
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

export class AdminServer<Plugins extends { [key: string]: AdminPlugin<any, any> }> {

    private debug: boolean;
    private requiredOrigin: cors.CorsOptions['origin'] | false;
    private webSocketKeepAlive: number | undefined;
    private ruleParams: RuleParameters;

    private app = express();
    private server: DestroyableServer<http.Server> | null = null;
    private eventEmitter = new EventEmitter();

    private adminPlugins: PluginConstructorMap<Plugins>;

    private sessions: { [id: string]: {
        router: express.Router,
        stop: () => Promise<void>,

        subscriptionServer: SubscriptionServer,
        streamServer: Ws.Server,

        sessionPlugins: Plugins
    } } = { };

    constructor(options: AdminServerOptions<Plugins> = {}) {
        this.debug = options.debug || false;
        if (this.debug) console.log('Admin server started in debug mode');

        this.webSocketKeepAlive = options.webSocketKeepAlive || undefined;
        this.ruleParams = options.ruleParameters || {};
        this.adminPlugins = options.adminPlugins || {} as PluginConstructorMap<Plugins>;

        if (options.corsOptions?.allowPrivateNetworkAccess) {
            // Allow web pages on non-local URLs (testsite.example.com, not localhost) to
            // send requests to this admin server too. Without this, those requests will
            // fail after rejected preflights in recent Chrome (from ~v102, ish? Unclear).
            // This is combined with the origin restrictions that may be set, so only
            // accepted origins will be allowed to make these requests.
            this.app.use((req, res, next) => {
                if (req.headers["access-control-request-private-network"]) {
                    res.setHeader("access-control-allow-private-network", "true");
                }
                next(null);
            });
        }

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

        const defaultPluginStartParams: Partial<PluginStartParamsMap<Plugins>> = options.pluginDefaults ?? {};

        this.app.post('/start', async (req, res) => {
            try {
                const rawConfig = req.body;

                // New clients send: "{ plugins: { http: {...}, webrtc: {...} } }" etc. Old clients just send
                // the HTTP options bare with no wrapper, so we wrap them for backward compat.
                const isPluginAwareClient = ('plugins' in rawConfig);

                const providedPluginStartParams = (!isPluginAwareClient
                    ? { // Backward compat: this means the client is not plugin-aware, and so all options are Mockttp options
                        http: {
                            options: _.cloneDeep(rawConfig),
                            port: (typeof req.query.port === 'string')
                                ? JSON.parse(req.query.port)
                                : undefined
                        }
                    }
                    : rawConfig.plugins
                ) as PluginStartParamsMap<Plugins>;

                // For each plugin that was specified, we pull default params into their start params.
                const pluginStartParams = _.mapValues((providedPluginStartParams), (params, pluginId) => {
                    return _.merge({}, defaultPluginStartParams[pluginId], params);
                });

                if (this.debug) console.log('Admin server starting mock session with config', pluginStartParams);

                // Backward compat: do an explicit check for HTTP port conflicts
                const httpPort = (pluginStartParams as { http?: { port: number } }).http?.port;
                if (_.isNumber(httpPort) && this.sessions[httpPort] != null) {
                    res.status(409).json({
                        error: `Cannot start: mock server is already running on port ${httpPort}`
                    });
                    return;
                }

                const missingPluginId = Object.keys(pluginStartParams).find(pluginId => !(pluginId in this.adminPlugins));
                if (missingPluginId) {
                    res.status(400).json({
                        error: `Request to mock using unrecognized plugin: ${missingPluginId}`
                    });
                    return;
                }

                const sessionPlugins = _.mapValues(pluginStartParams, (__, pluginId: keyof Plugins) => {
                    const PluginType = this.adminPlugins[pluginId];
                    return new PluginType();
                }) as Plugins;

                const pluginStartResults = await objectAllPromise(
                    _.mapValues(sessionPlugins, (plugin, pluginId: keyof Plugins) =>
                        plugin.start(pluginStartParams[pluginId])
                    )
                );

                // More backward compat: old clients assume that the port is also the management id.
                const sessionId = isPluginAwareClient
                    ? uuid()
                    : (sessionPlugins as any as {
                        'http': MockttpAdminPlugin
                    }).http.getMockServer().port.toString();

                await this.startSessionManagementAPI(sessionId, sessionPlugins);

                if (isPluginAwareClient) {
                    res.json({
                        id: sessionId,
                        pluginData: _.mapValues(pluginStartResults, (r: unknown) =>
                            r ?? {} // Always return _something_, even if the plugin returns null/undefined.
                        )
                    });
                } else {
                    res.json({
                        id: sessionId,
                        ...(pluginStartResults['http']!)
                    });
                }
            } catch (e) {
                res.status(500).json({ error: `Failed to start mock session: ${
                    (isErrorLike(e) && e.message) || e
                }` });
            }
        });

        this.app.post('/reset', async (req, res) => {
            try {
                await this.resetAdminServer();
                res.json({ success: true });
            } catch (e) {
                res.status(500).json({
                    error: (isErrorLike(e) && e.message) || 'Unknown error'
                });
            }
        });


        // Dynamically route to mock sessions ourselves, so we can easily add/remove
        // sessions as we see fit later on.
        const sessionRequest = (req: express.Request, res: express.Response, next: express.NextFunction) => {
            const sessionId = req.params.id;
            const sessionRouter = this.sessions[sessionId]?.router;

            if (!sessionRouter) {
                res.status(404).send('Unknown mock session');
                console.error(`Request for unknown mock session with id: ${sessionId}`);
                return;
            }

            sessionRouter(req, res, next);
        }

        this.app.use('/session/:id/', sessionRequest);
        this.app.use('/server/:id/', sessionRequest); // Old URL for backward compat
    }

    async resetAdminServer() {
        if (this.debug) console.log('Resetting admin server');
        await Promise.all(
            Object.values(this.sessions).map(({ stop }) => stop())
        );
    }

    /**
     * Subscribe to hear when each mock ession is started. The listener is provided the
     * session plugin data, which can be used to log session startup, add side-effects that
     * run elsewhere at startup, or preconfigure every started plugin in addition ways.
     *
     * This is run synchronously when a session is created, after it has fully started
     * but before its been returned to remote clients.
     */
    on(event: 'mock-session-started', listener: (plugins: Plugins, sessionId: string) => void): void;

    /**
     * Subscribe to hear when a mock session is stopped. The listener is provided with
     * the state of all plugins that are about to be stopped. This can be used to log
     * mock session shutdown, add side-effects that run elsewhere at shutdown, or clean
     * up after sessions in other ways.
     *
     * This is run synchronously immediately before the session is shutdown, whilst all
     * its state is still available, and before remote clients have had any response to
     * their request. This is also run before shutdown when the admin server itself is
     * cleanly shutdown with `adminServer.stop()`.
     */
    on(event: 'mock-session-stopping', listener: (plugins: Plugins, sessionId: string) => void): void;
    on(event: string, listener: (...args: any) => void): void {
        this.eventEmitter.on(event, listener);
    }

    async start(
        listenOptions: number | {
            port: number,
            host: string
        } = DEFAULT_ADMIN_SERVER_PORT
    ) {
        if (this.server) throw new Error('Admin server already running');

        await new Promise<void>((resolve, reject) => {
            this.server = makeDestroyable(this.app.listen(listenOptions, resolve));

            this.server.on('error', reject);

            this.server.on('upgrade', async (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
                const reqOrigin = req.headers['origin'] as string | undefined;
                if (this.requiredOrigin && !await strictOriginMatch(reqOrigin, this.requiredOrigin)) {
                    console.warn(`Websocket request from invalid origin: ${req.headers['origin']}`);
                    socket.destroy();
                    return;
                }

                const isSubscriptionRequest = req.url!.match(/^\/(?:server|session)\/([\w\d\-]+)\/subscription$/);
                const isStreamRequest = req.url!.match(/^\/(?:server|session)\/([\w\d\-]+)\/stream$/);
                const isMatch = isSubscriptionRequest || isStreamRequest;

                if (isMatch) {
                    const sessionId = isMatch[1];

                    let wsServer: Ws.Server = isSubscriptionRequest
                        ? this.sessions[sessionId]?.subscriptionServer.server
                        : this.sessions[sessionId]?.streamServer;

                    if (wsServer) {
                        wsServer.handleUpgrade(req, socket, head, (ws) => {
                            wsServer.emit('connection', ws, req);
                        });
                    } else {
                        console.warn(`Websocket request for unrecognized mock session: ${sessionId}`);
                        socket.destroy();
                    }
                } else {
                    console.warn(`Unrecognized websocket request for ${req.url}`);
                    socket.destroy();
                }
            });
        });
    }

    private async startSessionManagementAPI(sessionId: string, plugins: Plugins): Promise<void> {
        const mockSessionRouter = express.Router();

        let running = true;
        const stopSession = async () => {
            if (!running) return;
            running = false;

            this.eventEmitter.emit('mock-session-stopping', plugins);

            const session = this.sessions[sessionId];
            delete this.sessions[sessionId];

            await Promise.all(Object.values(plugins).map(plugin => plugin.stop()));

            session.subscriptionServer.close();

            // Close with code 1000 (purpose is complete - no more streaming happening)
            session.streamServer.clients.forEach((client) => {
                client.close(1000);
            });
            session.streamServer.close();
            session.streamServer.emit('close');
        };

        mockSessionRouter.post('/stop', async (req, res) => {
            await stopSession();
            res.json({ success: true });
        });

        // A pair of sockets, representing the 2-way connection between the session & WSs.
        // All websocket messages are written to wsSocket, and then read from sessionSocket
        // All session messages are written to sessionSocket, and then read from wsSocket and sent
        const { socket1: wsSocket, socket2: sessionSocket } = new DuplexPair();

        // This receives a lot of listeners! One channel per matcher, handler & completion checker,
        // and each adds listeners for data/error/finish/etc. That's OK, it's not generally a leak,
        // but maybe 100 would be a bit suspicious (unless you have 30+ active rules).
        sessionSocket.setMaxListeners(100);

        if (this.debug) {
            sessionSocket.on('data', (d: any) => {
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
            sessionSocket.end();
        });

        // Handle errors by logging & stopping this session
        const onStreamError = (e: Error) => {
            if (!running) return; // We don't care about connection issues during shutdown
            console.error("Error in admin server stream, shutting down mock session");
            console.error(e);
            stopSession();
        };
        wsSocket.on('error', onStreamError);
        sessionSocket.on('error', onStreamError);

        const schema = makeExecutableSchema({
            typeDefs: [
                AdminServer.baseSchema,
                ...Object.values(plugins).map(plugin => plugin.schema)
            ],
            resolvers: [
                this.buildBaseResolvers(sessionId),
                ...Object.values(plugins).map(plugin =>
                    plugin.buildResolvers(sessionSocket, this.ruleParams)
                )
            ]
        });

        const subscriptionServer = SubscriptionServer.create({
            schema,
            execute,
            subscribe,
            keepAlive: this.webSocketKeepAlive
        }, {
            noServer: true
        });

        mockSessionRouter.use(
            createGraphQLHandler({
                schema,

                // Add console logging of all GQL errors:
                formatError: (error) => {
                    console.error(error.stack);
                    return error;
                }
            }
        ));

        if (this.webSocketKeepAlive) {
            // If we have a keep-alive set, send the client a ping frame every Xms to
            // try and stop closes (especially by browsers) due to inactivity.
            const webSocketKeepAlive = setInterval(() => {
                [
                    ...streamServer.clients,
                    ...subscriptionServer.server.clients
                ].forEach((client) => {
                    if (client.readyState !== Ws.OPEN) return;
                    client.ping();
                });
            }, this.webSocketKeepAlive);

            // We use the stream server's shutdown as an easy proxy event for full shutdown:
            streamServer.on('close', () => clearInterval(webSocketKeepAlive));
        }

        this.sessions[sessionId] = {
            sessionPlugins: plugins,
            router: mockSessionRouter,
            streamServer,
            subscriptionServer,
            stop: stopSession
        };

        this.eventEmitter.emit('mock-session-started', plugins, sessionId);
    }

    stop(): Promise<void> {
        if (!this.server) return Promise.resolve();

        return Promise.all([
            this.server.destroy(),
        ].concat(
            Object.values(this.sessions).map((s) => s.stop())
        )).then(() => {
            this.server = null;
        });
    }

    private static baseSchema = gql`
        type Mutation {
            reset: Void
            enableDebug: Void
        }

        type Query {
            ruleParameterKeys: [String!]!
        }

        type Subscription {
            _empty_placeholder_: Void # A placeholder so we can define an empty extendable type
        }

        scalar Void
        scalar Raw
        scalar Json
        scalar Buffer
    `;

    private buildBaseResolvers(sessionId: string) {
        return {
            Query: {
                ruleParameterKeys: () => this.ruleParameterKeys
            },

            Mutation: {
                reset: () => this.resetPluginsForSession(sessionId),
                enableDebug: () => this.enableDebugForSession(sessionId)
            },

            Raw: new GraphQLScalarType({
                name: 'Raw',
                description: 'A raw entity, serialized directly (must be JSON-compatible)',
                serialize: (value: any) => value,
                parseValue: (input: string): any => input,
                parseLiteral: parseAnyAst
            }),

            // Json exists just for API backward compatibility - all new data should be Raw.
            // Converting to JSON is pointless, since bodies all contain JSON anyway.
            Json: new GraphQLScalarType({
                name: 'Json',
                description: 'A JSON entity, serialized as a simple JSON string',
                serialize: (value: any) => JSON.stringify(value),
                parseValue: (input: string): any => JSON.parse(input),
                parseLiteral: parseAnyAst
            }),

            Void: new GraphQLScalarType({
                name: 'Void',
                description: 'Nothing at all',
                serialize: (value: any) => null,
                parseValue: (input: string): any => null,
                parseLiteral: (): any => { throw new Error('Void literals are not supported') }
            }),

            Buffer: new GraphQLScalarType({
                name: 'Buffer',
                description: 'A buffer',
                serialize: (value: Buffer) => {
                    return value.toString('base64');
                },
                parseValue: (input: string) => {
                    return Buffer.from(input, 'base64');
                },
                parseLiteral: parseAnyAst
            })
        };
    };

    private resetPluginsForSession(sessionId: string) {
        return Promise.all(
            Object.values(this.sessions[sessionId].sessionPlugins).map(plugin =>
                plugin.reset?.()
            )
        );
    }

    private enableDebugForSession(sessionId: string) {
        return Promise.all(
            Object.values(this.sessions[sessionId].sessionPlugins).map(plugin =>
                plugin.enableDebug?.()
            )
        );
    }

    get ruleParameterKeys() {
        return Object.keys(this.ruleParams);
    }
}
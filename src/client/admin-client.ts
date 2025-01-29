import _ = require('lodash');
import { EventEmitter } from 'events';
import { Duplex } from 'stream';
import DuplexPair = require('native-duplexpair');
import { TypedError } from 'typed-error';
import * as CrossFetch from 'cross-fetch';
import * as WebSocket from 'isomorphic-ws';
import connectWebSocketStream = require('@httptoolkit/websocket-stream');
import { SubscriptionClient } from '@httptoolkit/subscriptions-transport-ws';
import { print } from 'graphql';

import { DEFAULT_ADMIN_SERVER_PORT } from "../types";

import { MaybePromise, RequireProps } from '../util/type-utils';
import { delay, isNode } from '../util/util';
import { isErrorLike } from '../util/error';
import { getDeferred } from '../util/promise';

import { introspectionQuery } from './schema-introspection';
import { MockttpPluginOptions } from '../admin/mockttp-admin-plugin';
import { AdminPlugin, PluginClientResponsesMap, PluginStartParamsMap } from '../admin/admin-plugin-types';
import { SchemaIntrospector } from './schema-introspection';
import { AdminQuery, getSingleSelectedFieldName } from './admin-query';
import { MockttpOptions } from '../mockttp';

const { fetch, Headers } = isNode || typeof globalThis.fetch === 'undefined'
    ? CrossFetch
    : globalThis;

export class ConnectionError extends TypedError { }

// The Response type requires lib.dom. We include an empty placeholder here to
// avoid the types breaking if you don't have that available. Once day TS will
// fix this: https://github.com/microsoft/TypeScript/issues/31894
declare global {
    interface Response {}
}

export class RequestError extends TypedError {
    constructor(
        message: string,
        public response: Response
    ) {
        super(message);
    }
}

export class GraphQLError extends RequestError {
    constructor(
        response: Response,
        public errors: Array<{ message: string }>
    ) {
        super(
            errors.length === 0
                ? `GraphQL request failed with ${response.status} response`
            : errors.length === 1
                ? `GraphQL request failed with: ${errors[0].message}`
            : // >1
                `GraphQL request failed, with errors:\n${errors.map((e) => e.message).join('\n')}`,
            response
        );
    }
}

// The various events that the admin client can emit:
export type AdminClientEvent =
    | 'starting'
    | 'started'
    | 'start-failed'
    | 'stopping'
    | 'stopped'
    | 'stream-error'
    | 'stream-reconnecting'
    | 'stream-reconnected'
    | 'stream-reconnect-failed'
    | 'subscription-error'
    | 'subscription-reconnecting';

export interface AdminClientOptions {

    /**
     * Should the client print extra debug information?
     */
    debug?: boolean;

    /**
     * The full URL to use to connect to a Mockttp admin server when using a
     * remote (or local but browser) client.
     *
     * When using a local server, this option is ignored.
     */
    adminServerUrl?: string;

    /**
     * If the admin stream disconnects, how many times should we try to
     * reconnect? Increasing this can be useful in unstable environments, such
     * as desktop app use case, while fewer retries will provide faster shutdown
     * in environments where you may be killing processes intentionally.
     */
    adminStreamReconnectAttempts?: number;

    /**
     * Options to include on all client requests.
     */
    requestOptions?: {
        headers?: { [key: string]: string };
    };
}

const mergeClientOptions = (
    options: RequestInit | undefined,
    defaultOptions: AdminClientOptions['requestOptions']
) => {
    if (!defaultOptions) return options;
    if (!options) return defaultOptions;

    if (defaultOptions.headers) {
        if (!options.headers) {
            options.headers = defaultOptions.headers;
        } else if (options.headers instanceof Headers) {
            _.forEach(defaultOptions.headers, (value, key) => {
                (options.headers as Headers).append(key, value);
            });
        } else if (_.isObject(options.headers)) {
            Object.assign(options.headers, defaultOptions.headers);
        }
    }

    return options;
};

async function requestFromAdminServer<T>(serverUrl: string, path: string, options?: RequestInit): Promise<T> {
    const url = `${serverUrl}${path}`;

    let response;
    try {
        response = await fetch(url, options);
    } catch (e) {
        if (isErrorLike(e) && e.code === 'ECONNREFUSED') {
            throw new ConnectionError(`Failed to connect to admin server at ${serverUrl}`);
        } else throw e;
    }

    if (response.status >= 400) {
        let body = await response.text();

        let jsonBody: { error?: string } | null = null;
        try {
            jsonBody = JSON.parse(body);
        } catch (e) { }

        if (jsonBody && jsonBody.error) {
            throw new RequestError(
                jsonBody.error,
                response
            );
        } else {
            throw new RequestError(
                `Request to ${url} failed, with status ${response.status} and response body: ${body}`,
                response
            );
        }
    } else {
        return response.json();
    }
}

/**
 * Reset a remote admin server, shutting down all Mockttp servers controlled by that
 * admin server. This is equivalent to calling `client.stop()` for all remote
 * clients of the target server.
 *
 * This can be useful in some rare cases, where a client might fail to reliably tear down
 * its own server, e.g. in Cypress testing. In this case, it's useful to reset the
 * admin server completely remotely without needing access to any previous client
 * instances, to ensure all servers from previous test runs have been shut down.
 *
 * After this is called, behaviour of any previously connected clients is undefined, and
 * it's likely that they may throw errors or experience other undefined behaviour. Ensure
 * that `client.stop()` has been called on all active clients before calling this method.
 */
export async function resetAdminServer(options: AdminClientOptions = {}): Promise<void> {
    const serverUrl = options.adminServerUrl ||
        `http://localhost:${DEFAULT_ADMIN_SERVER_PORT}`;
    await requestFromAdminServer(serverUrl, '/reset', {
        ...options.requestOptions,
        method: 'POST'
    });
}

/**
 * A bare admin server client. This is not intended for general use, but can be useful when
 * building admin server plugins to mock non-HTTP protocols and other advanced use cases.
 *
 * For normal usage of Mockttp, you should use `Mockttp.getRemote()` instead, to get a Mockttp
 * remote client, which wraps this class with the full Mockttp API for mocking HTTP.
 *
 * This is part of Mockttp's experimental 'pluggable admin' API. It may change
 * unpredictably, even in minor releases.
 */
export class AdminClient<Plugins extends { [key: string]: AdminPlugin<any, any> }> extends EventEmitter {

    private adminClientOptions: RequireProps<AdminClientOptions,
        'adminServerUrl' | 'adminStreamReconnectAttempts'
    >;

    private adminSessionBaseUrl: string | undefined;
    private adminServerStream: Duplex | undefined;
    private subscriptionClient: SubscriptionClient | undefined;

    // Metadata from the last start() call, if the server is currently connected:
    private adminServerSchema: SchemaIntrospector | undefined;
    private adminServerMetadata: PluginClientResponsesMap<Plugins> | undefined;

    private debug: boolean = false;

    // True if server is entirely initialized, false if it's entirely shut down, or a promise
    // that resolves to one or the other if it's currently changing state.
    private running: MaybePromise<boolean> = false;

    constructor(options: AdminClientOptions = {}) {
        super();
        this.debug = !!options.debug;
        this.adminClientOptions = _.defaults(options, {
            adminServerUrl: `http://localhost:${DEFAULT_ADMIN_SERVER_PORT}`,
            adminStreamReconnectAttempts: 5
        });
    }

    private attachStreamWebsocket(adminSessionBaseUrl: string, targetStream: Duplex): Duplex {
        const adminSessionBaseWSUrl = adminSessionBaseUrl.replace(/^http/, 'ws');
        const wsStream = connectWebSocketStream(`${adminSessionBaseWSUrl}/stream`, {
            headers: this.adminClientOptions.requestOptions?.headers // Only used in Node.js (via WS)
        });

        let streamConnected = false;
        wsStream.on('connect', () => {
            streamConnected = true;

            targetStream.pipe(wsStream);
            wsStream.pipe(targetStream, { end: false });
        });

        // We ignore errors, but websocket closure eventually results in reconnect or shutdown
        wsStream.on('error', (e) => {
            if (this.debug) console.warn('Admin client stream error', e);
            this.emit('stream-error', e);
        });

        // When the websocket closes (after connect, either close frame, error, or socket shutdown):
        wsStream.on('ws-close', async (closeEvent) => {
            targetStream.unpipe(wsStream);

            const serverShutdown = closeEvent.code === 1000;
            if (serverShutdown) {
                // Clean shutdown implies the server is gone, and we need to shutdown & cleanup.
                targetStream.emit('server-shutdown');
            } else if (streamConnected && (await this.running) === true) {
                console.warn('Admin client stream unexpectedly disconnected', closeEvent);

                if (this.adminClientOptions.adminStreamReconnectAttempts > 0) {
                    this.tryToReconnectStream(adminSessionBaseUrl, targetStream);
                } else {
                    // If retries are disabled, shut down immediately:
                    console.log('Admin client stream reconnect disabled, shutting down');
                    targetStream.emit('server-shutdown');
                }
            }
            // If never connected successfully, we do nothing.
        });

        targetStream.on('finish', () => { // Client has shutdown
            // Ignore any further WebSocket events - the websocket stream is no longer useful
            wsStream.removeAllListeners('connect');
            wsStream.removeAllListeners('ws-close');
            wsStream.destroy();
        });

        return wsStream;
    }

    /**
     * Attempt to recreate a stream after disconnection, up to a limited number of retries. This is
     * different to normal connection setup, as it assumes the target stream is otherwise already
     * set up and active.
     */
    private async tryToReconnectStream(
        adminSessionBaseUrl: string,
        targetStream: Duplex,
        retries = this.adminClientOptions.adminStreamReconnectAttempts
    ) {
        this.emit('stream-reconnecting');

        // Unclean shutdown means something has gone wrong somewhere. Try to reconnect.
        const newStream = this.attachStreamWebsocket(adminSessionBaseUrl, targetStream);

        new Promise((resolve, reject) => {
            newStream.once('connect', resolve);
            newStream.once('error', reject);
        }).then(() => {
            // On a successful connect, business resumes as normal.
            console.warn('Admin client stream reconnected');
            this.emit('stream-reconnected');
        }).catch(async (err) => {
            if (retries > 0) {
                // We delay re-retrying briefly - this helps to handle cases like the computer going
                // to sleep (where the server & client pause in parallel, but race to do so).
                // The delay increases exponentially with retry attempts (10ms, 50, 250, 1250, 6250)
                const retryAttempt = this.adminClientOptions.adminStreamReconnectAttempts - retries;
                await delay(10 * Math.pow(5, retryAttempt));

                return this.tryToReconnectStream(adminSessionBaseUrl, targetStream, retries - 1);
            }

            // Otherwise, once retries have failed, we give up entirely:
            console.warn('Admin client stream reconnection failed, shutting down:', err.message);
            if (this.debug) console.warn(err);
            this.emit('stream-reconnect-failed', err);
            targetStream.emit('server-shutdown');
        });
    }

    private openStreamToMockServer(adminSessionBaseUrl: string): Promise<Duplex> {
        // To allow reconnects, we need to not end the client stream when an individual web socket ends.
        // To make that work, we return a separate stream, which isn't directly connected to the websocket
        // and doesn't receive WS 'end' events, and then we can swap the WS inputs accordingly.
        const { socket1: wsTarget, socket2: exposedStream } = new DuplexPair();

        const wsStream = this.attachStreamWebsocket(adminSessionBaseUrl, wsTarget);
        wsTarget.on('error', (e) => exposedStream.emit('error', e));

        // When the server stream ends, end the target stream, which will automatically end all websockets.
        exposedStream.on('finish', () => wsTarget.end());

        // Propagate 'server is definitely no longer available' back from the websockets:
        wsTarget.on('server-shutdown', () => exposedStream.emit('server-shutdown'));

        // These receive a lot of listeners! One channel per matcher, handler & completion checker,
        // and each adds listeners for data/error/finish/etc. That's OK, it's not generally a leak,
        // but maybe 100 would be a bit suspicious (unless you have 30+ active rules).
        exposedStream.setMaxListeners(100);

        return new Promise((resolve, reject) => {
            wsStream.once('connect', () => resolve(exposedStream));
            wsStream.once('error', reject);
        });
    }

    private prepareSubscriptionClientToAdminServer(adminSessionBaseUrl: string) {
        const adminSessionBaseWSUrl = adminSessionBaseUrl.replace(/^http/, 'ws');
        const subscriptionUrl = `${adminSessionBaseWSUrl}/subscription`;
        this.subscriptionClient = new SubscriptionClient(subscriptionUrl, {
            lazy: true, // Doesn't actually connect until you use subscriptions
            reconnect: true,
            reconnectionAttempts: 8,
            wsOptionArguments: [this.adminClientOptions.requestOptions]
        }, WebSocket);

        this.subscriptionClient.onError((e) => {
            this.emit('subscription-error', e);
            if (this.debug) console.error("Subscription error", e)
        });

        this.subscriptionClient.onReconnecting(() => {
            this.emit('subscription-reconnecting');
            console.warn('Reconnecting Mockttp subscription client')
        });
    }

    private async requestFromMockServer(path: string, options?: RequestInit): Promise<Response> {
        // Must check for session URL, not this.running, or we can't send the /stop request during shutdown!
        if (!this.adminSessionBaseUrl) throw new Error('Not connected to mock server');

        let url = this.adminSessionBaseUrl + path;
        let response = await fetch(url, mergeClientOptions(options, this.adminClientOptions.requestOptions));

        if (response.status >= 400) {
            if (this.debug) console.error(`Remote client server request failed with status ${response.status}`);
            throw new RequestError(
                `Request to ${url} failed, with status ${response.status}`,
                response
            );
        } else {
            return response;
        }
    }

    private async queryMockServer<T>(query: string, variables?: {}): Promise<T> {
        try {
            const response = (await this.requestFromMockServer('/', {
                method: 'POST',
                headers: new Headers({
                    'Content-Type': 'application/json'
                }),
                body: JSON.stringify({ query, variables })
            }));

            const { data, errors }: { data?: T, errors?: Error[] } = await response.json();

            if (errors && errors.length) {
                throw new GraphQLError(response, errors);
            } else {
                return data as T;
            }
        } catch (e) {
            if (this.debug) console.error(`Remote client query error: ${e}`);

            if (!(e instanceof RequestError)) throw e;

            let graphQLErrors: Error[] | undefined = undefined;
            try {
                graphQLErrors = (await e.response.json()).errors;
            } catch (e2) {}

            if (graphQLErrors) {
                throw new GraphQLError(e.response, graphQLErrors);
            } else {
                throw e;
            }
        }
    }

    async start(
        pluginStartParams: PluginStartParamsMap<Plugins>
    ): Promise<PluginClientResponsesMap<Plugins>> {
        if (this.adminSessionBaseUrl || await this.running) throw new Error('Server is already started');
        if (this.debug) console.log(`Starting remote mock server`);
        this.emit('starting');

        const startPromise = getDeferred<boolean>();
        this.running = startPromise.then((result) => {
            this.emit(result ? 'started' : 'start-failed');
            this.running = result;
            return result;
        });

        try {
            const supportOldServers = 'http' in pluginStartParams;
            const portConfig = supportOldServers
                ? (pluginStartParams['http'] as MockttpPluginOptions).port
                : undefined;

            const path = portConfig ? `/start?port=${JSON.stringify(portConfig)}` : '/start';
            const adminServerResponse = await requestFromAdminServer<
                | { port: number, mockRoot: string } // Backward compat for old servers
                | { id: string, pluginData: PluginClientResponsesMap<Plugins> } // New plugin-aware servers
            >(
                this.adminClientOptions.adminServerUrl,
                path,
                mergeClientOptions({
                    method: 'POST',
                    headers: new Headers({
                        'Content-Type': 'application/json'
                    }),
                    body: JSON.stringify({
                        plugins: pluginStartParams,
                        // Include all the Mockttp params at the root too, for backward compat with old admin servers:
                        ...(pluginStartParams.http?.options as MockttpOptions | undefined)
                    })
                }, this.adminClientOptions.requestOptions)
            );

            // Backward compat for old servers
            const isPluginAwareServer = 'id' in adminServerResponse;

            const sessionId = isPluginAwareServer
                ? adminServerResponse.id
                : adminServerResponse.port.toString();

            const adminSessionBaseUrl = `${this.adminClientOptions.adminServerUrl}/${
                isPluginAwareServer ? 'session' : 'server'
            }/${sessionId}`

            // Also open a stream connection, for 2-way communication we might need later.
            const adminServerStream = await this.openStreamToMockServer(adminSessionBaseUrl);
            adminServerStream.on('server-shutdown', () => {
                // When the server remotely disconnects the stream, shut down the client iff the client hasn't
                // stopped & restarted in the meantime (can happen, since all shutdown is async).
                if (this.adminServerStream === adminServerStream) {
                    console.warn('Client stopping due to admin server shutdown');
                    this.stop();
                }
            });
            this.adminServerStream = adminServerStream;

            // Create a subscription client, preconfigured & ready to connect if on() is called later:
            this.prepareSubscriptionClientToAdminServer(adminSessionBaseUrl);

            // We don't persist the id or resolve the start promise until everything is set up
            this.adminSessionBaseUrl = adminSessionBaseUrl;

            // Load the schema on server start, so we can check for feature support
            this.adminServerSchema = new SchemaIntrospector(
                (await this.queryMockServer<any>(introspectionQuery)).__schema
            );

            if (this.debug) console.log('Started remote mock server');

            const serverMetadata =
                this.adminServerMetadata = // Set field before we resolve the promise
                    'pluginData' in adminServerResponse
                        ? adminServerResponse.pluginData
                        : {
                            // Backward compat - convert old always-HTTP data into per-plugin format:
                            http: adminServerResponse
                        } as unknown as PluginClientResponsesMap<Plugins>;

            startPromise.resolve(true);
            return serverMetadata;
        } catch (e) {
            startPromise.resolve(false);
            throw e;
        }
    }

    isRunning() {
        return this.running === true;
    }

    get metadata() {
        if (!this.isRunning()) throw new Error("Metadata is not available until the mock server is started");
        return this.adminServerMetadata!;
    }

    get schema() {
        if (!this.isRunning()) throw new Error("Admin schema is not available until the mock server is started");
        return this.adminServerSchema!;
    }

    get adminStream() {
        if (!this.isRunning()) throw new Error("Admin stream is not available until the mock server is started");
        return this.adminServerStream!;
    }

    // Call when either we want the server to stop, or it appears that the server has already stopped,
    // and we just want to ensure that's happened and clean everything up.
    async stop(): Promise<void> {
        if (await this.running === false) return; // If stopped or stopping, do nothing.
        this.emit('stopping');

        const stopPromise = getDeferred<boolean>();
        this.running = stopPromise.then((result) => {
            this.emit('stopped');
            this.running = result;
            return result;
        });

        try {
            if (this.debug) console.log('Stopping remote mock server');

            try { this.subscriptionClient?.close(); } catch (e) { console.log(e); }
            this.subscriptionClient = undefined;

            try { this.adminServerStream?.end(); } catch (e) { console.log(e); }
            this.adminServerStream = undefined;

            await this.requestServerStop();
        } finally {
            // The client is always stopped (and so restartable) once stopping completes, in all
            // cases, since it can always be started again to reset it. The promise is just here
            // so that we successfully handle (and always wait for) parallel stops.
            stopPromise.resolve(false);
        }
    }

    private requestServerStop() {
        return this.requestFromMockServer('/stop', {
            method: 'POST'
        }).catch((e) => {
            if (e instanceof RequestError && e.response.status === 404) {
                // 404 means it doesn't exist, generally because it was already stopped
                // by some other parallel shutdown process.
                return;
            } else {
                throw e;
            }
        }).then(() => {
            this.adminSessionBaseUrl = undefined;
            this.adminServerSchema = undefined;
            this.adminServerMetadata = undefined;
        });
    }

    public enableDebug = async (): Promise<void> => {
        this.debug = true;
        return (await this.queryMockServer<void>(
            `mutation EnableDebug {
                enableDebug
            }`
        ));
    }

    public reset = async (): Promise<void> => {
        return (await this.queryMockServer<void>(
            `mutation Reset {
                reset
            }`
        ));
    }

    public async sendQuery<Response, Result = Response>(query: AdminQuery<Response, Result>): Promise<Result> {
        return (await this.sendQueries(query))[0];
    }

    public async sendQueries<Queries extends Array<AdminQuery<any>>>(
        ...queries: [...Queries]
    ): Promise<{ [n in keyof Queries]: Queries[n] extends AdminQuery<any, infer R> ? R : never }> {
        const results = queries.map<Promise<Array<unknown>>>(
            async ({ query, variables, transformResponse }) => {
                const result = await this.queryMockServer(print(query), variables);
                return transformResponse
                    ? transformResponse(result, { adminClient: this })
                    : result;
            }
        );

        return Promise.all(results) as Promise<{
            [n in keyof Queries]: Queries[n] extends AdminQuery<any, infer R> ? R : never
        }>;
    }

    public async subscribe<Response, Result = Response>(
        query: AdminQuery<Response, Result>,
        callback: (data: Result) => void
    ): Promise<void> {
        if (await this.running === false) throw new Error('Not connected to mock server');

        const fieldName = getSingleSelectedFieldName(query);
        if (!this.schema!.typeHasField('Subscription', fieldName)) {
            console.warn(`Ignoring client subscription for event unrecognized by Mockttp server: ${fieldName}`);
            return Promise.resolve();
        }

        // This isn't 100% correct (you can be WS-connected, but still negotiating some GQL
        // setup) but it's good enough for our purposes (knowing-ish if the connection worked).
        let isConnected = !!this.subscriptionClient!.client;

        this.subscriptionClient!.request(query).subscribe({
            next: async (value) => {
                if (value.data) {
                    const response = value.data[fieldName];
                    const result = query.transformResponse
                        ? await query.transformResponse(response, { adminClient: this })
                        : response as Result;
                    callback(result);
                } else if (value.errors) {
                    console.error('Error in subscription', value.errors);
                }
            },
            error: (e) => this.debug && console.warn('Error in remote subscription:', e)
        });

        return new Promise((resolve, reject) => {
            if (isConnected) resolve();
            else {
                this.subscriptionClient!.onConnected(resolve);
                this.subscriptionClient!.onDisconnected(reject);
                this.subscriptionClient!.onError(reject);
            }
        });
    }

    /**
     * List the names of the rule parameters defined by the admin server. This can be
     * used in some advanced use cases to confirm that the parameters a client wishes to
     * reference are available.
     *
     * Only defined for remote clients.
     */
    public async getRuleParameterKeys() {
        if (await this.running === false) {
            throw new Error('Cannot query rule parameters before the server is started');
        }

        if (!this.schema!.queryTypeDefined('ruleParameterKeys')) {
            // If this endpoint isn't supported, that's because parameters aren't supported
            // at all, so we can safely report that immediately.
            return [];
        }

        let result = await this.queryMockServer<{
            ruleParameterKeys: string[]
        }>(
            `query GetRuleParameterNames {
                ruleParameterKeys
            }`
        );

        return result.ruleParameterKeys;
    }

}
/**
 * @module Mockttp
 */

import { TypedError } from 'typed-error';
import getFetchPonyfill = require('fetch-ponyfill');
import _ = require('lodash');
import * as WebSocket from 'universal-websocket-client';
import connectWebSocketStream = require('websocket-stream');
import { SubscriptionClient } from 'subscriptions-transport-ws';
import { Duplex } from 'stream';

const {
    /** @hidden */
    fetch,
    /** @hidden */
    Headers
} = getFetchPonyfill();

import { MockedEndpoint } from "../types";
import { Mockttp, AbstractMockttp, MockttpOptions, PortRange } from "../mockttp";
import { MockServerConfig } from "../standalone/mockttp-standalone";
import { MockRuleData, serializeRuleData } from "../rules/mock-rule";
import { MockedEndpointData, DEFAULT_STANDALONE_PORT } from "../types";
import { MockedEndpointClient } from "./mocked-endpoint-client";
import { buildBodyReader } from '../util/request-utils';
import { RequireProps } from '../util/type-utils';
import { introspectionQuery } from './introspection-query';

export class ConnectionError extends TypedError { }

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
            `GraphQL request failed, with errors:\n${errors.map((e) => e.message).join('\n')}`,
            response
        );
    }
}

type SubscribableEvent = 'request-initiated' | 'request' | 'response' | 'abort' | 'tlsClientError';

export interface MockttpClientOptions extends MockttpOptions {
    client?: {
        headers?: { [key: string]: string };
    }
}

const mergeClientOptions = (
    options: RequestInit | undefined,
    defaultOptions: MockttpClientOptions['client']
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

/**
 * A Mockttp implementation, controlling a remote Mockttp standalone server.
 *
 * This starts servers by making requests to the remote standalone server, and exposes
 * methods to directly manage them.
 */
export default class MockttpClient extends AbstractMockttp implements Mockttp {

    private mockServerOptions: RequireProps<MockttpClientOptions, 'cors' | 'standaloneServerUrl'>;
    private mockClientOptions: MockttpClientOptions['client'];

    private mockServerConfig: MockServerConfig | undefined;
    private mockServerStream: Duplex | undefined;
    private mockServerSchema: any;

    constructor(options: MockttpClientOptions = {}) {
        super(_.defaults(options, {
            // Browser clients generally want cors enabled. For other clients, it doesn't hurt.
            // TODO: Maybe detect whether we're in a browser in future
            cors: true,
            standaloneServerUrl: `http://localhost:${DEFAULT_STANDALONE_PORT}`
        }));

        // Note that 'defaults' above mutates this, so this includes
        // the default parameter values too (and thus the type assertion)
        this.mockServerOptions = _.omit(options, 'client') as RequireProps<
            MockttpOptions, 'cors' | 'standaloneServerUrl'
        >
        this.mockClientOptions = options.client || {};
    }

    private async requestFromStandalone<T>(path: string, options?: RequestInit): Promise<T> {
        const url = `${this.mockServerOptions.standaloneServerUrl}${path}`;

        let response;
        try {
            response = await fetch(url, mergeClientOptions(options, this.mockClientOptions));
        } catch (e) {
            if (e.code === 'ECONNREFUSED') {
                throw new ConnectionError(`Failed to connect to standalone server at ${this.mockServerOptions.standaloneServerUrl}`);
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

    private openStreamToMockServer(config: MockServerConfig): Promise<Duplex> {
        const standaloneStreamServer = this.mockServerOptions.standaloneServerUrl.replace(/^http/, 'ws');
        const stream = connectWebSocketStream(`${standaloneStreamServer}/server/${config.port}/stream`, {
            objectMode: true
        });

        return new Promise((resolve, reject) => {
            stream.once('connect', () => resolve(stream));
            stream.once('error', reject);
        });
    }

    private async requestFromMockServer(path: string, options?: RequestInit): Promise<Response> {
        if (!this.mockServerConfig) throw new Error('Not connected to mock server');

        let url = `${this.mockServerOptions.standaloneServerUrl}/server/${this.mockServerConfig.port}${path}`;
        let response = await fetch(url, mergeClientOptions(options, this.mockClientOptions));

        if (response.status >= 400) {
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
            try {
                let graphQLErrors = (await e.response.json()).errors;
                throw new GraphQLError(e, graphQLErrors);
            } catch (e2) {
                // If we fail to get a proper JSON graphql error, just throw the
                // underlying exception without decoration
                throw e;
            }
        }
    }

    async start(portConfig?: number | PortRange): Promise<void> {
        if (this.mockServerConfig) throw new Error('Server is already started');

        const path = portConfig ? `/start?port=${JSON.stringify(portConfig)}` : '/start';
        let mockServerConfig = await this.requestFromStandalone<MockServerConfig>(path, {
            method: 'POST',
            headers: new Headers({
                'Content-Type': 'application/json'
            }),
            body: JSON.stringify(this.mockServerOptions)
        });

        // Also open a stream connection, for 2-way communication we might need later.
        this.mockServerStream = await this.openStreamToMockServer(mockServerConfig);

        // We don't persist the config or resolve this promise until everything is set up
        this.mockServerConfig = mockServerConfig;

        // Load the schema on server start, so we can check for feature support
        this.mockServerSchema = (await this.queryMockServer<any>(introspectionQuery)).__schema;
    }

    async stop(): Promise<void> {
        if (!this.mockServerConfig) return;

        this.mockServerStream!.end();
        await this.requestFromMockServer('/stop', {
            method: 'POST'
        });

        this.mockServerConfig = this.mockServerStream = undefined;
    }

    private typeHasField(typeName: string, fieldName: string): boolean {
        const type: any = _.find(this.mockServerSchema.types, { name: typeName });
        if (!type) return false;
        return !!_.find(type.fields, { name: fieldName });
    }

    private typeHasInputField(typeName: string, fieldName: string): boolean {
        const type: any = _.find(this.mockServerSchema.types, { name: typeName });
        if (!type) return false;
        return !!_.find(type.inputFields, { name: fieldName });
    }

    enableDebug(): void {
        throw new Error("Client-side debug info not implemented.");
    }

    reset = async (): Promise<boolean> => {
        return (await this.queryMockServer<boolean>(
            `mutation Reset {
                    reset
            }`
        ));
    }

    get url(): string {
        if (!this.mockServerConfig) throw new Error('Cannot get url before server is started');

        return this.mockServerConfig!.mockRoot;
    }

    get port(): number {
        if (!this.mockServerConfig) throw new Error('Cannot get port before server is started');

        return this.mockServerConfig!.port;
    }

    public addRules = async (...rules: MockRuleData[]): Promise<MockedEndpoint[]> => {
        return this._addRules(rules, false);
    }

    public setRules = async (...rules: MockRuleData[]): Promise<MockedEndpoint[]> => {
        return this._addRules(rules, true);
    }

    private _addRules = async (rules: MockRuleData[], reset: boolean = false): Promise<MockedEndpoint[]> => {
        // Backward compat: make Add/SetRules work with servers that only define reset & addRule (singular).
        // Adds a small risk of odd behaviour in the gap between reset & all the rules being added, but it
        // should be extremely brief, and no worse than existing behaviour for those server versions.
        if (!this.typeHasField('Mutation', 'addRules')) {
            if (reset) await this.reset();

            // Sequentially add the rules:
            return rules.reduce((acc: Promise<MockedEndpoint[]>, rule) => {
                return acc.then(async (endpoints) => {
                    endpoints.push(await this._addRule(rule));
                    return endpoints;
                });
            }, Promise.resolve<MockedEndpoint[]>([]));
        }

        const requestName = reset ? 'SetRules' : 'AddRules';
        const mutationName = reset ? 'setRules' : 'addRules';

        let ruleIds = (await this.queryMockServer<{ rules: Array<{ id: string }> }>(
            `mutation ${requestName}($newRules: [MockRule!]!) {
                rules: ${mutationName}(input: $newRules) {
                    id
                }
            }`, {
                newRules: rules.map((rule) => {
                    const serializedData = serializeRuleData(rule, this.mockServerStream!)
                    if (!this.typeHasInputField('MockRule', 'id')) {
                        delete serializedData.id;
                    }
                    return serializedData;
                })
            }
        )).rules.map(r => r.id);

        return ruleIds.map(ruleId =>
            new MockedEndpointClient(ruleId, this.getEndpointData(ruleId))
        );
    }

    // Exists purely for backward compat with servers that don't support AddRules/SetRules.
    private _addRule = async (rule: MockRuleData): Promise<MockedEndpoint> => {
        const ruleData = serializeRuleData(rule, this.mockServerStream!)
        delete ruleData.id; // Old servers don't support sending ids.

        const response = await this.queryMockServer<{
            addRule: { id: string }
        }>(
            `mutation AddRule($newRule: MockRule!) {
                addRule(input: $newRule) {
                    id
                }
            }`, {
                newRule: ruleData
            }
        );

        const ruleId = response.addRule.id;
        return new MockedEndpointClient(ruleId, this.getEndpointData(ruleId));
    }

    public on(event: SubscribableEvent, callback: (data: any) => void): Promise<void> {
        const queryResultName = {
            'request-initiated': 'requestInitiated',
            request: 'requestReceived',
            response: 'responseCompleted',
            abort: 'requestAborted',
            tlsClientError: 'failedTlsRequest'
        }[event];

        // Ignore events unknown to either us or the server
        if (
            !queryResultName ||
            !this.typeHasField('Subscription', queryResultName)
        ) return Promise.resolve();

        const standaloneStreamServer = this.mockServerOptions.standaloneServerUrl.replace(/^http/, 'ws');
        const url = `${standaloneStreamServer}/server/${this.port}/subscription`;
        const client = new SubscriptionClient(url, {
            reconnect: true,
            reconnectionAttempts: 8
        }, WebSocket);

        // Note the typeHasField checks - these are a quick hack for backward compatibility,
        // introspecting the server schema to avoid requesting fields that don't exist on old servers.

        const query = {
            'request-initiated': {
                operationName: 'OnRequestInitiated',
                query: `subscription OnRequestInitiated {
                    ${queryResultName} {
                        id,
                        protocol,
                        method,
                        url,
                        path,
                        hostname,

                        headers,
                        timingEvents,
                        httpVersion,
                        ${this.typeHasField('InitiatedRequest', 'tags') ? 'tags' : ''}
                    }
                }`
            },
            request: {
                operationName: 'OnRequest',
                query: `subscription OnRequest {
                    ${queryResultName} {
                        id,
                        ${this.typeHasField('Request', 'matchedRuleId') ? 'matchedRuleId' : ''}
                        protocol,
                        method,
                        url,
                        path,
                        hostname,

                        headers,
                        body,
                        ${this.typeHasField('Request', 'timingEvents') ? 'timingEvents' : ''}
                        ${this.typeHasField('Request', 'httpVersion') ? 'httpVersion' : ''}
                        ${this.typeHasField('Request', 'tags') ? 'tags' : ''}
                    }
                }`
            },
            response: {
                operationName: 'OnResponse',
                query: `subscription OnResponse {
                    ${queryResultName} {
                        id,
                        statusCode,
                        statusMessage,
                        headers,
                        body,
                        ${this.typeHasField('Response', 'timingEvents') ? 'timingEvents' : ''}
                        ${this.typeHasField('Response', 'tags') ? 'tags' : ''}
                    }
                }`
            },
            abort: {
                operationName: 'OnAbort',
                query: `subscription OnAbort {
                    ${queryResultName} {
                        id,
                        protocol,
                        method,
                        url,
                        path,
                        hostname,

                        headers,
                        body,
                        ${this.typeHasField('Response', 'timingEvents') ? 'timingEvents' : ''}
                        ${this.typeHasField('Response', 'tags') ? 'tags' : ''}
                    }
                }`
            },
            tlsClientError: {
                operationName: 'OnTlsClientError',
                query: `subscription OnTlsClientError {
                    ${queryResultName} {
                        failureCause
                        hostname
                        remoteIpAddress
                        ${this.typeHasField('TlsRequest', 'tags') ? 'tags' : ''}
                    }
                }`
            }
        }[event];

        client.request(query).subscribe({
            next: (value) => {
                if (value.data) {
                    const data = (<any> value.data)[queryResultName];
                    // TODO: Get a proper graphql client that does all this automatically from the schema itself
                    if (data.headers) {
                        data.headers = JSON.parse(data.headers);
                    }

                    if (data.timingEvents) {
                        data.timingEvents = JSON.parse(data.timingEvents);
                    } else if (event !== 'tlsClientError') {
                        data.timingEvents = {}; // For backward compat
                    }

                    if (!data.tags) data.tags = [];

                    if (data.body) {
                        data.body = buildBodyReader(Buffer.from(data.body, 'base64'), data.headers);
                    }
                    callback(data);
                } else if (value.errors) {
                    console.error('Error in subscription', value.errors);
                }
            },
            error: (e) => this.debug && console.warn('Error in remote subscription:', e)
        });

        return new Promise((resolve, reject) => {
            client.onConnected(() => {
                if (this.debug) console.log("Subscription connected");
                resolve();
            });
            client.onDisconnected(() => {
                if (this.debug) console.warn("Subscription disconnected");
                reject();
            });
            client.onError((e) => {
                if (this.debug) console.error("Subscription error", e)
            });
            client.onReconnecting(() => console.warn(`Reconnecting ${event} subscription`));
        });
    }

    private getEndpointData = (ruleId: string) => async (): Promise<MockedEndpointData | null> => {
        let result = await this.queryMockServer<{
            mockedEndpoint: MockedEndpointData | null
        }>(
            `query GetEndpointData($id: ID!) {
                mockedEndpoint(id: $id) {
                    seenRequests {
                        protocol,
                        method,
                        url,
                        path,
                        hostname,
                        headers,
                        body,
                        ${this.typeHasField('Request', 'timingEvents') ? 'timingEvents' : ''}
                        ${this.typeHasField('Request', 'httpVersion') ? 'httpVersion' : ''}
                    }
                }
            }`, {
                id: ruleId
            }
        );

        const mockedEndpoint = result.mockedEndpoint;

        if (!mockedEndpoint) return null;

        mockedEndpoint.seenRequests.forEach((request: any) => {
            request.body = buildBodyReader(Buffer.from(request.body, 'base64'), request.headers);
        });

        return mockedEndpoint;
    }
}
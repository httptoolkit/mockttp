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
import { RequestRuleData } from "../rules/requests/request-rule";
import { WebSocketRuleData } from '../rules/websockets/websocket-rule';
import { serializeRuleData } from '../rules/rule-serialization';

import { MockedEndpointData, DEFAULT_STANDALONE_PORT } from "../types";

import { MockedEndpointClient } from "./mocked-endpoint-client";
import { buildBodyReader } from '../util/request-utils';
import { RequireProps } from '../util/type-utils';
import { introspectionQuery } from './introspection-query';

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

type SubscribableEvent =
    | 'request-initiated'
    | 'request'
    | 'response'
    | 'abort'
    | 'tls-client-error'
    | 'tlsClientError' // Deprecated
    | 'client-error';

export interface MockttpClientOptions extends MockttpOptions {
    /**
     * Options to include on all client requests, e.g. to add extra
     * headers for authentication.
     */
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

function normalizeHttpMessage(event: SubscribableEvent, message: any) {
    if (message.timingEvents) {
        // Timing events are serialized as raw JSON
        message.timingEvents = JSON.parse(message.timingEvents);
    } else if (event !== 'tls-client-error' && event !== 'client-error') {
        // For backwards compat, all except errors should have timing events if they're missing
        message.timingEvents = {};
    }

    if (message.headers) {
        message.headers = JSON.parse(message.headers);
    }

    if (message.body !== undefined) {
        // Body is serialized as the raw encoded buffer in base64
        message.body = buildBodyReader(Buffer.from(message.body, 'base64'), message.headers);
    }

    // For backwards compat, all except errors should have tags if they're missing
    if (!message.tags) message.tags = [];
}

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
            objectMode: true,
            headers: this.mockClientOptions?.headers
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
            let graphQLErrors: Error[] | undefined = undefined;
            try {
                graphQLErrors = (await e.response.json()).errors;
            } catch (e2) {}

            if (graphQLErrors) {
                throw new GraphQLError(e, graphQLErrors);
            } else {
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

    private optionalField(typeName: string, fieldName: string): string {
        return (this.typeHasField(typeName, fieldName))
            ? fieldName
            : '';
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

    public addRequestRules = async (...rules: RequestRuleData[]): Promise<MockedEndpoint[]> => {
        return this._addRules(rules, false);
    }

    public setRequestRules = async (...rules: RequestRuleData[]): Promise<MockedEndpoint[]> => {
        return this._addRules(rules, true);
    }

    public addWebSocketRules = async (...rules: WebSocketRuleData[]): Promise<MockedEndpoint[]> => {
        return this._addWsRules(rules, false);
    }

    public setWebSocketRules = async (...rules: WebSocketRuleData[]): Promise<MockedEndpoint[]> => {
        return this._addWsRules(rules, true);
    }

    private _addRules = async (
        rules: Array<RequestRuleData>,
        reset: boolean
    ): Promise<MockedEndpoint[]> => {
        if (!this.mockServerConfig) throw new Error('Cannot add rules before the server is started');

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

        let endpoints = (await this.queryMockServer<{ endpoints: Array<{ id: string, explanation?: string }> }>(
            `mutation ${requestName}($newRules: [MockRule!]!) {
                endpoints: ${mutationName}(input: $newRules) {
                    id,
                    ${this.optionalField('MockedEndpoint', 'explanation')}
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
        )).endpoints;

        return endpoints.map(({ id, explanation }) =>
            new MockedEndpointClient(id, explanation, this.getEndpointDataGetter(id))
        );
    }

    private _addWsRules = async (
        rules: Array<WebSocketRuleData>,
        reset: boolean
    ): Promise<MockedEndpoint[]> => {
        // Seperate and much simpler than _addRules, because it doesn't have to deal with
        // backward compatibility.

        if (!this.mockServerConfig) throw new Error('Cannot add rules before the server is started');

        const requestName = (reset ? 'Set' : 'Add') + 'WebSocketRules';
        const mutationName = (reset ? 'set' : 'add') + 'WebSocketRules';

        let endpoints = (await this.queryMockServer<{ endpoints: Array<{ id: string, explanation?: string }> }>(
            `mutation ${requestName}($newRules: [WebSocketMockRule!]!) {
                endpoints: ${mutationName}(input: $newRules) {
                    id,
                    explanation
                }
            }`, {
                newRules: rules.map((rule) => serializeRuleData(rule, this.mockServerStream!))
            }
        )).endpoints;

        return endpoints.map(({ id, explanation }) =>
            new MockedEndpointClient(id, explanation, this.getEndpointDataGetter(id))
        );
    }

    public async getMockedEndpoints() {
        let result = await this.queryMockServer<{
            mockedEndpoints: MockedEndpointData[]
        }>(
            `query GetAllEndpointData {
                mockedEndpoints {
                    id,
                    ${this.optionalField('MockedEndpoint', 'explanation')}
                }
            }`
        );

        const mockedEndpoints = result.mockedEndpoints;

        return mockedEndpoints.map(e =>
            new MockedEndpointClient(e.id, e.explanation, this.getEndpointDataGetter(e.id))
        );
    }

    public async getPendingEndpoints() {
        let result = await this.queryMockServer<{
            pendingEndpoints: MockedEndpointData[]
        }>(
            `query GetPendingEndpointData {
                pendingEndpoints {
                    id,
                    explanation
                }
            }`
        );

        const pendingEndpoints = result.pendingEndpoints;

        return pendingEndpoints.map(e =>
            new MockedEndpointClient(e.id, e.explanation, this.getEndpointDataGetter(e.id))
        );
    }

    // Exists purely for backward compat with servers that don't support AddRules/SetRules.
    private _addRule = async (rule: RequestRuleData): Promise<MockedEndpoint> => {
        const ruleData = serializeRuleData(rule, this.mockServerStream!)
        delete ruleData.id; // Old servers don't support sending ids.

        const response = await this.queryMockServer<{
            addRule: { id: string, explanation?: string }
        }>(
            `mutation AddRule($newRule: MockRule!) {
                addRule(input: $newRule) {
                    id,
                    ${this.optionalField('MockedEndpoint', 'explanation')}
                }
            }`, {
                newRule: ruleData
            }
        );

        const mockedEndpoint = response.addRule;
        return new MockedEndpointClient(
            mockedEndpoint.id,
            mockedEndpoint.explanation,
            this.getEndpointDataGetter(mockedEndpoint.id)
        );
    }

    public on(event: SubscribableEvent, callback: (data: any) => void): Promise<void> {
        if (event === 'tlsClientError') event = 'tls-client-error';

        const queryResultName = {
            'request-initiated': 'requestInitiated',
            request: 'requestReceived',
            response: 'responseCompleted',
            abort: 'requestAborted',
            'tls-client-error': 'failedTlsRequest',
            'client-error': 'failedClientRequest',
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
            reconnectionAttempts: 8,
            wsOptionArguments: [this.mockClientOptions]
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
                        ${this.optionalField('InitiatedRequest', 'tags')}
                    }
                }`
            },
            request: {
                operationName: 'OnRequest',
                query: `subscription OnRequest {
                    ${queryResultName} {
                        id,
                        ${this.optionalField('Request', 'matchedRuleId')}
                        protocol,
                        method,
                        url,
                        path,
                        hostname,

                        headers,
                        body,
                        ${this.optionalField('Request', 'timingEvents')}
                        ${this.optionalField('Request', 'httpVersion')}
                        ${this.optionalField('Request', 'tags')}
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
                        ${this.optionalField('Response', 'timingEvents')}
                        ${this.optionalField('Response', 'tags')}
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
                        ${this.optionalField('Response', 'timingEvents')}
                        ${this.optionalField('Response', 'tags')}
                    }
                }`
            },
            'tls-client-error': {
                operationName: 'OnTlsClientError',
                query: `subscription OnTlsClientError {
                    ${queryResultName} {
                        failureCause
                        hostname
                        remoteIpAddress
                        ${this.optionalField('TlsRequest', 'remotePort')}
                        ${this.optionalField('TlsRequest', 'tags')}
                        ${this.optionalField('TlsRequest', 'timingEvents')}
                    }
                }`
            },
            'client-error': {
                operationName: 'OnClientError',
                query: `subscription OnClientError {
                    ${queryResultName} {
                        errorCode
                        request {
                            id
                            timingEvents
                            tags
                            protocol
                            httpVersion
                            method
                            url
                            path
                            headers
                        }
                        response {
                            id
                            timingEvents
                            tags
                            statusCode
                            statusMessage
                            headers
                            body
                        }
                    }
                }`
            }
        }[event];

        client.request(query).subscribe({
            next: (value) => {
                if (value.data) {
                    const data = (<any> value.data)[queryResultName];

                    if (event === 'client-error') {
                        data.request = _.mapValues(data.request, (v) =>
                            // Normalize missing values to undefined to match the local result
                            v === null ? undefined : v
                        );

                        normalizeHttpMessage(event, data.request);
                        if (data.response) {
                            normalizeHttpMessage(event, data.response);
                        } else {
                            data.response = 'aborted';
                        }
                    } else {
                        normalizeHttpMessage(event, data);
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

    private getEndpointDataGetter = (ruleId: string) => async (): Promise<MockedEndpointData | null> => {
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
                        ${this.optionalField('Request', 'timingEvents')}
                        ${this.optionalField('Request', 'httpVersion')}
                    }
                    ${this.optionalField('MockedEndpoint', 'isPending')}
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
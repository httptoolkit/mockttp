/**
 * @module Mockttp
 */

import TypedError = require('typed-error');
import getFetch = require('fetch-ponyfill');
import _ = require('lodash');
import * as WebSocket from 'universal-websocket-client';
import connectWebSocketStream = require('websocket-stream');
import { SubscriptionClient } from 'subscriptions-transport-ws';

const {
    /** @hidden */
    fetch,
    /** @hidden */
    Headers
} = getFetch();

import { ProxyConfig, Method, MockedEndpoint, OngoingRequest, CompletedRequest } from "../types";
import {
  MockRule,
  MockRuleData
} from "../rules/mock-rule-types";
import MockRuleBuilder from "../rules/mock-rule-builder";
import { Mockttp, AbstractMockttp, MockttpOptions } from "../mockttp";
import { MockServerConfig } from "../standalone/mockttp-standalone";
import { serializeRuleData } from "../rules/mock-rule";
import { MockedEndpointData, DEFAULT_STANDALONE_PORT } from "../types";
import { MockedEndpointClient } from "./mocked-endpoint-client";
import { Duplex } from 'stream';

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
        error: RequestError,
        public errors: [ { message: string } ]
    ) {
        super(
            `GraphQL request failed, with errors:\n${errors.map((e) => e.message).join('\n')}`,
            error.response
        );
    }
}

/** @hidden */
interface RequestData { }

/** @hidden */
interface MockedEndpointState {
    id: string;
    seenRequests: RequestData[]
}

/**
 * A Mockttp implementation, controlling a remote Mockttp standalone server.
 * 
 * This starts servers by making requests to the remote standalone server, and exposes
 * methods to directly manage them.
 */
export default class MockttpClient extends AbstractMockttp implements Mockttp {
    private readonly standaloneServerUrl = `http://localhost:${DEFAULT_STANDALONE_PORT}`;

    private mockServerOptions: MockttpOptions;
    private mockServerConfig: MockServerConfig | undefined;
    private mockServerStream: Duplex | undefined;

    constructor(mockServerOptions: MockttpOptions = {}) {
        super(_.defaults(mockServerOptions, {
            // Browser clients generally want cors enabled. For other clients, it doesn't hurt.
            // TODO: Maybe detect whether we're in a browser in future
            cors: true
        }));
        this.mockServerOptions = mockServerOptions;
    }

    private async requestFromStandalone<T>(path: string, options?: RequestInit): Promise<T> {
        const url = `${this.standaloneServerUrl}${path}`;

        let response;
        try {
            response = await fetch(url, options);
        } catch (e) {
            if (e.code === 'ECONNREFUSED') {
                throw new ConnectionError(`Failed to connect to standalone server at ${this.standaloneServerUrl}`);
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
        const stream = connectWebSocketStream(`ws://localhost:${DEFAULT_STANDALONE_PORT}/server/${config.port}/stream`, {
            objectMode: true
        });

        return new Promise((resolve, reject) => {
            stream.once('connect', () => resolve(stream));
            stream.once('error', reject);
        });
    }

    private async requestFromMockServer<T>(path: string, options?: RequestInit): Promise<T> {
        if (!this.mockServerConfig) throw new Error('Not connected to mock server');

        let url = `${this.standaloneServerUrl}/server/${this.mockServerConfig.port}${path}`;
        let response = await fetch(url, options);

        if (response.status >= 400) {
            throw new RequestError(
                `Request to ${url} failed, with status ${response.status}`,
                response
            );
        } else {
            return response.json();
        }
    }

    private async queryMockServer<T>(query: string, variables?: {}): Promise<T> {
        try {
            return await this.requestFromMockServer<T>('/', {
                method: 'POST',
                headers: new Headers({
                    'Content-Type': 'application/json'
                }),
                body: JSON.stringify({ query, variables })
            });
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

    async start(port?: number): Promise<void> {
        if (this.mockServerConfig) throw new Error('Server is already started');

        const path = port ? `/start?port=${port}` : '/start';
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
    }

    async stop(): Promise<void> {
        if (!this.mockServerConfig) return;

        this.mockServerStream!.end();
        await this.requestFromMockServer<void>('/stop', {
            method: 'POST'
        });

        this.mockServerConfig = this.mockServerStream = undefined;
    }

    enableDebug(): void {
        throw new Error("Client-side debug info not implemented.");
    }

    reset = async (): Promise<boolean> => {
        return (await this.queryMockServer<{ data: boolean }>(
            `mutation Reset {
                    reset
            }`
        )).data;
    }

    get url(): string {
        if (!this.mockServerConfig) throw new Error('Cannot get url before server is started');

        return this.mockServerConfig!.mockRoot;
    }

    get port(): number {
        if (!this.mockServerConfig) throw new Error('Cannot get port before server is started');

        return this.mockServerConfig!.port;
    }

    public addRule = async (rule: MockRuleData): Promise<MockedEndpoint> => {
        let ruleId = (await this.queryMockServer<{
            data: { addRule: { id: string } }
        }>(
            `mutation AddRule($newRule: MockRule!) {
                    addRule(input: $newRule) {
                        id
                    }
            }`, {
                newRule: serializeRuleData(rule, { clientStream: this.mockServerStream })
            }
        )).data.addRule.id;

        return new MockedEndpointClient(ruleId, this.getEndpointData(ruleId));
    }

    public on(event: 'request' | 'response', callback: Function): Promise<void> {
        if (!_.includes(['request', 'response'], event)) return Promise.resolve();

        const url = `ws://localhost:${DEFAULT_STANDALONE_PORT}/server/${this.mockServerConfig!.port}/subscription`;
        const client = new SubscriptionClient(url, { }, WebSocket);

        const queryResultName = event === 'request' ? 'requestReceived' : 'responseCompleted';

        const query = event === 'request' ? {
            operationName: 'OnRequest',
            query: `subscription OnRequest {
                ${queryResultName} {
                    protocol,
                    method,
                    url,
                    path,
                    hostname,

                    headers,
                    body {
                        buffer,
                        text,
                        json,
                        formData
                    }
                }
            }`
        } : {
            operationName: 'OnResponse',
            query: `subscription OnResponse {
                ${queryResultName} {
                    statusCode,
                    statusMessage,
                    headers,
                    body {
                        buffer,
                        text,
                        json,
                        formData
                    }
                }
            }`
        }

        client.request(query).subscribe({
            next: (value) => {
                if (value.data) {
                    const data = (<any> value.data)[queryResultName];
                    if (data.headers) {
                        // TODO: Get a proper graphql client that does this automatically from the schema itself
                        data.headers = JSON.parse(data.headers);
                    }
                    callback(data);
                }
            },
            error: (e) => this.debug && console.warn('Error in remote subscription:', e)
        });

        return new Promise((resolve, reject) => {
            client.onConnected(resolve);
            client.onDisconnected(reject);
        });
    }

    private getEndpointData = (ruleId: string) => async (): Promise<MockedEndpointData | null> => {
        let result = await this.queryMockServer<{
            data: { mockedEndpoint: MockedEndpointData | null }
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
                            body {
                                text
                            }
                        }
                    }
            }`, {
                id: ruleId
            }
        );

        return result.data.mockedEndpoint;
    }
}
import TypedError = require('typed-error');
import getFetch = require('fetch-ponyfill');
import _ = require('lodash');
const { fetch, Headers } = getFetch();

import { ProxyConfig, Method, MockedEndpoint } from "../types";
import {
  MockRule,
  MockRuleData
} from "../rules/mock-rule-types";
import PartialMockRule from "../rules/partial-mock-rule";
import { Mockttp, AbstractMockttp } from "../mockttp";
import { MockServerConfig } from "../standalone/mockttp-standalone";
import { serializeRuleData } from "../rules/mock-rule";
import { MockedEndpointData, DEFAULT_STANDALONE_PORT } from "../types";
import { MockedEndpointClient } from "./mocked-endpoint-client";
import { MockServerOptions } from '../server/mockttp-server';

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

interface RequestData { }

interface MockedEndpointState {
    id: string;
    seenRequests: RequestData[]
}

export default class MockttpClient extends AbstractMockttp implements Mockttp {
    private readonly standaloneServerUrl = `http://localhost:${DEFAULT_STANDALONE_PORT}`;

    private mockServerOptions: MockServerOptions;
    private mockServerConfig: MockServerConfig | undefined;

    constructor(mockServerOptions: MockServerOptions = {}) {
        super();
        this.mockServerOptions = _.defaults(mockServerOptions, {
            // Browser clients generally want cors enabled. For other clients, it doesn't hurt.
            // TODO: Maybe detect whether we're in a browser in future
            cors: true
        });
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

    private async requestFromMockServer<T>(path: string, options?: RequestInit): Promise<T> {
        if (!this.mockServerConfig) throw new Error('Not connected to mock server');

        let url = `${this.standaloneServerUrl}/server/${this.mockServerConfig.port}${path}`;
        let response = await fetch(url, options);

        if (response.status >= 400) {
            var body = await response.json();
            var error_msg = `Request to ${url} failed, with status ${response.status}${(body) ? ` with message "${body.message}"` : ``}`;
            throw new RequestError(error_msg, response);
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
            let graphQLErrors = (await e.response.json()).errors;
            throw new GraphQLError(e, graphQLErrors);
        }
    }

    async checkSeenRequestsAllRoutes(): Promise<any> {
        try {
            var requests = await this.requestFromMockServer<any>('/checkSeenRequestsAllRoutes', {
                method: 'GET'
            });
            return requests;
        } catch (error) {
            return Promise.reject(error);
        }
    }

    async start(port?: number): Promise<void> {
        if (this.mockServerConfig) throw new Error('Server is already started');

        const path = port ? `/start?port=${port}` : '/start';
        this.mockServerConfig = await this.requestFromStandalone<MockServerConfig>(path, {
            method: 'POST',
            headers: new Headers({
                'Content-Type': 'application/json'
            }),
            body: JSON.stringify(this.mockServerOptions)
        });
    }

    async stop(): Promise<void> {
        if (!this.mockServerConfig) return;

        await this.requestFromMockServer<void>('/stop', {
            method: 'POST'
        });
        this.mockServerConfig = undefined;
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
                newRule: serializeRuleData(rule)
            }
        )).data.addRule.id;

        return new MockedEndpointClient(ruleId, this.getEndpointData(ruleId));
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
                            body
                        }
                    }
            }`, {
                id: ruleId
            }
        );

        return result.data.mockedEndpoint;
    }
}
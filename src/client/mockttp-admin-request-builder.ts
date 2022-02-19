import _ = require('lodash');
import gql from 'graphql-tag';

import { MockedEndpoint, MockedEndpointData } from "../types";

import { buildBodyReader } from '../util/request-utils';
import type { Serialized } from '../util/serialization';

import { AdminQuery } from './admin-query';
import { AdminSchema } from './admin-schema';

import type { RequestRuleData } from "../rules/requests/request-rule";
import type { WebSocketRuleData } from '../rules/websockets/websocket-rule';

import { MockttpOptions, SubscribableEvent } from '../mockttp';
import { MockedEndpointClient } from "./mocked-endpoint-client";
import { AdminClient } from './admin-client';

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

export class MockttpAdminRequestBuilder {

    constructor(
        private schema: AdminSchema,
        private mockttpOptions: MockttpOptions = {}
    ) {}

    buildAddRequestRulesQuery(
        rules: Array<Serialized<RequestRuleData>>,
        reset: boolean
    ): AdminQuery<
        { endpoints: Array<{ id: string, explanation?: string }> },
        MockedEndpoint[]
    > {
        const requestName = (reset ? 'Set' : 'Add') + 'Rules';
        const mutationName = (reset ? 'set' : 'add') + 'Rules';

        return {
            query: gql`
                mutation ${requestName}($newRules: [MockRule!]!) {
                    endpoints: ${mutationName}(input: $newRules) {
                        id,
                        ${this.schema.asOptionalField('MockedEndpoint', 'explanation')}
                    }
                }
            `,
            variables: {
                newRules: rules
            },
            transformResponse: (response, { adminClient }) => {
                return response.endpoints.map(({ id, explanation }) =>
                    new MockedEndpointClient(
                        id,
                        explanation,
                        this.getEndpointDataGetter(adminClient, id)
                    )
                )
            }
        };
    }

    buildSetFallbackRequestRuleQuery(
        rule: Serialized<RequestRuleData>
    ): AdminQuery<
        { endpoint: { id: string, explanation: string } },
        MockedEndpoint
    > {
        return {
            query: gql`
                mutation SetFallbackRule($fallbackRule: MockRule!) {
                    endpoint: setFallbackRule(input: $fallbackRule) {
                        id,
                        explanation
                    }
                }
            `,
            variables: {
                fallbackRule: rule
            },
            transformResponse: (response, { adminClient }) => {
                const { endpoint: { id, explanation } } = response;
                return new MockedEndpointClient(
                    id,
                    explanation,
                    this.getEndpointDataGetter(adminClient, id)
                );
            }
        };
    };

    buildAddWebSocketRulesQuery(
        rules: Array<Serialized<WebSocketRuleData>>,
        reset: boolean
    ): AdminQuery<
        { endpoints: Array<{ id: string, explanation?: string }> },
        MockedEndpoint[]
    > {
        // Seperate and simpler than buildAddRequestRulesQuery, because it doesn't have to
        // deal with backward compatibility.
        const requestName = (reset ? 'Set' : 'Add') + 'WebSocketRules';
        const mutationName = (reset ? 'set' : 'add') + 'WebSocketRules';

        return {
            query: gql`
                mutation ${requestName}($newRules: [WebSocketMockRule!]!) {
                    endpoints: ${mutationName}(input: $newRules) {
                        id,
                        explanation
                    }
                }
            `,
            variables: {
                newRules: rules
            },
            transformResponse: (response, { adminClient }) => {
                return response.endpoints.map(({ id, explanation }) =>
                    new MockedEndpointClient(
                        id,
                        explanation,
                        this.getEndpointDataGetter(adminClient, id)
                    )
                );
            }
        };
    };

    buildMockedEndpointsQuery(): AdminQuery<
        { mockedEndpoints: MockedEndpointData[] },
        MockedEndpoint[]
    > {
        return {
            query: gql`
                query GetAllEndpointData {
                    mockedEndpoints {
                        id,
                        ${this.schema.asOptionalField('MockedEndpoint', 'explanation')}
                    }
                }
            `,
            transformResponse: (response, { adminClient }) => {
                const mockedEndpoints = response.mockedEndpoints;
                return mockedEndpoints.map(({ id, explanation }) =>
                    new MockedEndpointClient(
                        id,
                        explanation,
                        this.getEndpointDataGetter(adminClient, id)
                    )
                );
            }
        };
    }

    public buildPendingEndpointsQuery(): AdminQuery<
        { pendingEndpoints: MockedEndpointData[] },
        MockedEndpoint[]
    > {
        return {
            query: gql`
                query GetPendingEndpointData {
                    pendingEndpoints {
                        id,
                        explanation
                    }
                }
            `,
            transformResponse: (response, { adminClient }) => {
                const pendingEndpoints = response.pendingEndpoints;
                return pendingEndpoints.map(({ id, explanation }) =>
                    new MockedEndpointClient(
                        id,
                        explanation,
                        this.getEndpointDataGetter(adminClient, id)
                    )
                );
            }
        };
    }

    public buildSubscriptionRequest<T>(event: SubscribableEvent): AdminQuery<unknown, T> {
        if (event === 'tlsClientError') event = 'tls-client-error';

        // Note the asOptionalField checks - these are a quick hack for backward compatibility,
        // introspecting the server schema to avoid requesting fields that don't exist on old servers.

        const query = {
            'request-initiated': gql`subscription OnRequestInitiated {
                requestInitiated {
                    id,
                    protocol,
                    method,
                    url,
                    path,
                    ${this.schema.asOptionalField('InitiatedRequest', 'remoteIpAddress')},
                    ${this.schema.asOptionalField('InitiatedRequest', 'remotePort')},
                    hostname,

                    headers,
                    timingEvents,
                    httpVersion,
                    ${this.schema.asOptionalField('InitiatedRequest', 'tags')}
                }
            }`,
            request: gql`subscription OnRequest {
                requestReceived {
                    id,
                    ${this.schema.asOptionalField('Request', 'matchedRuleId')}
                    protocol,
                    method,
                    url,
                    path,
                    ${this.schema.asOptionalField('Request', 'remoteIpAddress')},
                    ${this.schema.asOptionalField('Request', 'remotePort')},
                    hostname,

                    headers,
                    body,
                    ${this.schema.asOptionalField('Request', 'timingEvents')}
                    ${this.schema.asOptionalField('Request', 'httpVersion')}
                    ${this.schema.asOptionalField('Request', 'tags')}
                }
            }`,
            response: gql`subscription OnResponse {
                responseCompleted {
                    id,
                    statusCode,
                    statusMessage,
                    headers,
                    body,
                    ${this.schema.asOptionalField('Response', 'timingEvents')}
                    ${this.schema.asOptionalField('Response', 'tags')}
                }
            }`,
            abort: gql`subscription OnAbort {
                requestAborted {
                    id,
                    protocol,
                    method,
                    url,
                    path,
                    hostname,

                    headers,
                    body,
                    ${this.schema.asOptionalField('Response', 'timingEvents')}
                    ${this.schema.asOptionalField('Response', 'tags')}
                }
            }`,
            'tls-client-error': gql`subscription OnTlsClientError {
                failedTlsRequest {
                    failureCause
                    hostname
                    remoteIpAddress
                    ${this.schema.asOptionalField('TlsRequest', 'remotePort')}
                    ${this.schema.asOptionalField('TlsRequest', 'tags')}
                    ${this.schema.asOptionalField('TlsRequest', 'timingEvents')}
                }
            }`,
            'client-error': gql`subscription OnClientError {
                failedClientRequest {
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
                        ${this.schema.asOptionalField('ClientErrorRequest', 'remoteIpAddress')},
                        ${this.schema.asOptionalField('ClientErrorRequest', 'remotePort')},
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
        }[event];

        return {
            query,
            transformResponse: (data: any): T => {
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
                return data;
            }
        };
    }

    private getEndpointDataGetter = (adminClient: AdminClient<{}>, ruleId: string) =>
        async (): Promise<MockedEndpointData | null> => {
            let result = await adminClient.sendQuery<{
                mockedEndpoint: MockedEndpointData | null
            }>({
                query: gql`
                    query GetEndpointData($id: ID!) {
                        mockedEndpoint(id: $id) {
                            seenRequests {
                                protocol,
                                method,
                                url,
                                path,
                                hostname,
                                headers,
                                body,
                                ${this.schema.asOptionalField('Request', 'timingEvents')}
                                ${this.schema.asOptionalField('Request', 'httpVersion')}
                            }
                            ${this.schema.asOptionalField('MockedEndpoint', 'isPending')}
                        }
                    }
                `,
                variables: { id: ruleId }
            });

            const mockedEndpoint = result.mockedEndpoint;
            if (!mockedEndpoint) return null;

            mockedEndpoint.seenRequests.forEach((request: any) => {
                request.body = buildBodyReader(Buffer.from(request.body, 'base64'), request.headers);
            });

            return mockedEndpoint;
        }
}
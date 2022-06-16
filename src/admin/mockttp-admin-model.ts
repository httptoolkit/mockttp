import * as _ from "lodash";
import { Duplex } from "stream";

import type { IResolvers } from "@graphql-tools/utils/Interfaces";
import { PubSub } from "graphql-subscriptions";

import type { MockttpServer } from "../server/mockttp-server";
import type { ServerMockedEndpoint } from "../server/mocked-endpoint";
import type {
    MockedEndpoint,
    MockedEndpointData,
    CompletedRequest,
    CompletedResponse,
    ClientError
} from "../types";
import type { Serialized } from "../serialization/serialization";
import type { RequestRuleData } from "../rules/requests/request-rule";
import type { WebSocketRuleData } from "../rules/websockets/websocket-rule";

import { deserializeRuleData, deserializeWebSocketRuleData } from "../rules/rule-deserialization";

const REQUEST_INITIATED_TOPIC = 'request-initiated';
const REQUEST_RECEIVED_TOPIC = 'request-received';
const RESPONSE_COMPLETED_TOPIC = 'response-completed';
const WEBSOCKET_REQUEST_TOPIC = 'websocket-request';
const WEBSOCKET_ACCEPTED_TOPIC = 'websocket-accepted';
const REQUEST_ABORTED_TOPIC = 'request-aborted';
const TLS_CLIENT_ERROR_TOPIC = 'tls-client-error';
const CLIENT_ERROR_TOPIC = 'client-error';

async function buildMockedEndpointData(endpoint: ServerMockedEndpoint): Promise<MockedEndpointData> {
    return {
        id: endpoint.id,
        explanation: endpoint.toString(true),
        seenRequests: await endpoint.getSeenRequests(),
        isPending: await endpoint.isPending()
    };
}

export function buildAdminServerModel(
    mockServer: MockttpServer,
    stream: Duplex,
    ruleParameters: { [key: string]: any }
): IResolvers {
    const pubsub = new PubSub();

    mockServer.on('request-initiated', (request) => {
        pubsub.publish(REQUEST_INITIATED_TOPIC, {
            requestInitiated: request
        })
    });

    mockServer.on('request', (request) => {
        pubsub.publish(REQUEST_RECEIVED_TOPIC, {
            requestReceived: request
        })
    });

    mockServer.on('response', (response) => {
        pubsub.publish(RESPONSE_COMPLETED_TOPIC, {
            responseCompleted: response
        })
    });

    mockServer.on('websocket-request', (request) => {
        pubsub.publish(WEBSOCKET_REQUEST_TOPIC, {
            webSocketRequest: request
        })
    });

    mockServer.on('websocket-accepted', (response) => {
        pubsub.publish(WEBSOCKET_ACCEPTED_TOPIC, {
            webSocketAccepted: response
        })
    });

    mockServer.on('abort', (request) => {
        pubsub.publish(REQUEST_ABORTED_TOPIC, {
            requestAborted: Object.assign(request, {
                // Backward compat: old clients expect this to be present. In future this can be removed
                // and abort events can switch from Request to InitiatedRequest in the schema.
                body: Buffer.alloc(0)
            })
        })
    });

    mockServer.on('tls-client-error', (request) => {
        pubsub.publish(TLS_CLIENT_ERROR_TOPIC, {
            failedTlsRequest: request
        })
    });

    mockServer.on('client-error', (error) => {
        pubsub.publish(CLIENT_ERROR_TOPIC, {
            failedClientRequest: error
        })
    });

    return <any> {
        Query: {
            mockedEndpoints: async (): Promise<MockedEndpointData[]> => {
                return Promise.all((await mockServer.getMockedEndpoints()).map(buildMockedEndpointData));
            },

            pendingEndpoints: async (): Promise<MockedEndpointData[]> => {
                return Promise.all((await mockServer.getPendingEndpoints()).map(buildMockedEndpointData));
            },

            mockedEndpoint: async (__: any, { id }: { id: string }): Promise<MockedEndpointData | null> => {
                let endpoint = _.find(await mockServer.getMockedEndpoints(), (endpoint: MockedEndpoint) => {
                    return endpoint.id === id;
                });

                if (!endpoint) return null;

                return buildMockedEndpointData(endpoint);
            }
        },

        Mutation: {
            addRule: async (__: any, { input }: { input: Serialized<RequestRuleData> }) => {
                return mockServer.addRequestRule(deserializeRuleData(input, stream, ruleParameters));
            },
            addRules: async (__: any, { input }: { input: Array<Serialized<RequestRuleData>> }) => {
                return mockServer.addRequestRules(...input.map((rule) =>
                    deserializeRuleData(rule, stream, ruleParameters)
                ));
            },
            setRules: async (__: any, { input }: { input: Array<Serialized<RequestRuleData>> }) => {
                return mockServer.setRequestRules(...input.map((rule) =>
                    deserializeRuleData(rule, stream, ruleParameters)
                ));
            },
            setFallbackRule: async (__: any, { input }: { input: Serialized<RequestRuleData> }) => {
                // Deprecated endpoint, but preserved for API backward compat
                const ruleData = deserializeRuleData(input, stream, ruleParameters);
                return mockServer.addRequestRules({
                    ...ruleData,
                    priority: 0
                }).then((rules) => rules[0]);
            },

            addWebSocketRule: async (__: any, { input }: { input: Serialized<WebSocketRuleData> }) => {
                return mockServer.addWebSocketRule(deserializeWebSocketRuleData(input, stream, ruleParameters));
            },
            addWebSocketRules: async (__: any, { input }: { input: Array<Serialized<WebSocketRuleData>> }) => {
                return mockServer.addWebSocketRules(...input.map((rule) =>
                    deserializeWebSocketRuleData(rule, stream, ruleParameters)
                ));
            },
            setWebSocketRules: async (__: any, { input }: { input: Array<Serialized<WebSocketRuleData>> }) => {
                return mockServer.setWebSocketRules(...input.map((rule) =>
                    deserializeWebSocketRuleData(rule, stream, ruleParameters)
                ));
            }
        },

        Subscription: {
            requestInitiated: {
                subscribe: () => pubsub.asyncIterator(REQUEST_INITIATED_TOPIC)
            },
            requestReceived: {
                subscribe: () => pubsub.asyncIterator(REQUEST_RECEIVED_TOPIC)
            },
            responseCompleted: {
                subscribe: () => pubsub.asyncIterator(RESPONSE_COMPLETED_TOPIC)
            },
            webSocketRequest: {
                subscribe: () => pubsub.asyncIterator(WEBSOCKET_REQUEST_TOPIC)
            },
            webSocketAccepted: {
                subscribe: () => pubsub.asyncIterator(WEBSOCKET_ACCEPTED_TOPIC)
            },
            requestAborted: {
                subscribe: () => pubsub.asyncIterator(REQUEST_ABORTED_TOPIC)
            },
            failedTlsRequest: {
                subscribe: () => pubsub.asyncIterator(TLS_CLIENT_ERROR_TOPIC)
            },
            failedClientRequest: {
                subscribe: () => pubsub.asyncIterator(CLIENT_ERROR_TOPIC)
            }
        },

        Request: {
            body: (request: CompletedRequest) => {
                return request.body.buffer;
            }
        },

        Response: {
            body: (response: CompletedResponse) => {
                return response.body.buffer;
            }
        },

        ClientError: {
            response: (error: ClientError) => {
                if (error.response === 'aborted') return undefined;
                else return error.response;
            }
        }
    };
}
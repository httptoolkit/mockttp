import * as _ from "lodash";
import { Duplex } from "stream";

import { PubSub } from "graphql-subscriptions";
import type { IResolvers } from "@graphql-tools/utils";

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
const WEBSOCKET_MESSAGE_RECEIVED_TOPIC = 'websocket-message-received';
const WEBSOCKET_MESSAGE_SENT_TOPIC = 'websocket-message-sent';
const WEBSOCKET_CLOSE_TOPIC = 'websocket-close';
const REQUEST_ABORTED_TOPIC = 'request-aborted';
const TLS_PASSTHROUGH_OPENED_TOPIC = 'tls-passthrough-opened';
const TLS_PASSTHROUGH_CLOSED_TOPIC = 'tls-passthrough-closed';
const TLS_CLIENT_ERROR_TOPIC = 'tls-client-error';
const CLIENT_ERROR_TOPIC = 'client-error';
const RULE_EVENT_TOPIC = 'rule-event';

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

    mockServer.on('request-initiated', (evt) => {
        pubsub.publish(REQUEST_INITIATED_TOPIC, {
            requestInitiated: evt
        })
    });

    mockServer.on('request', (evt) => {
        pubsub.publish(REQUEST_RECEIVED_TOPIC, {
            requestReceived: evt
        })
    });

    mockServer.on('response', (evt) => {
        pubsub.publish(RESPONSE_COMPLETED_TOPIC, {
            responseCompleted: evt
        })
    });

    mockServer.on('websocket-request', (evt) => {
        pubsub.publish(WEBSOCKET_REQUEST_TOPIC, {
            webSocketRequest: evt
        })
    });

    mockServer.on('websocket-accepted', (evt) => {
        pubsub.publish(WEBSOCKET_ACCEPTED_TOPIC, {
            webSocketAccepted: evt
        })
    });

    mockServer.on('websocket-message-received', (evt) => {
        pubsub.publish(WEBSOCKET_MESSAGE_RECEIVED_TOPIC, {
            webSocketMessageReceived: evt
        })
    });

    mockServer.on('websocket-message-sent', (evt) => {
        pubsub.publish(WEBSOCKET_MESSAGE_SENT_TOPIC, {
            webSocketMessageSent: evt
        })
    });

    mockServer.on('websocket-close', (evt) => {
        pubsub.publish(WEBSOCKET_CLOSE_TOPIC, {
            webSocketClose: evt
        })
    });

    mockServer.on('abort', (evt) => {
        pubsub.publish(REQUEST_ABORTED_TOPIC, {
            requestAborted: Object.assign(evt, {
                // Backward compat: old clients expect this to be present. In future this can be
                // removed and abort events can lose the 'body' in the schema.
                body: Buffer.alloc(0)
            })
        })
    });

    mockServer.on('tls-passthrough-opened', (evt) => {
        pubsub.publish(TLS_PASSTHROUGH_OPENED_TOPIC, {
            tlsPassthroughOpened: evt
        })
    });

    mockServer.on('tls-passthrough-closed', (evt) => {
        pubsub.publish(TLS_PASSTHROUGH_CLOSED_TOPIC, {
            tlsPassthroughClosed: evt
        })
    });

    mockServer.on('tls-client-error', (evt) => {
        pubsub.publish(TLS_CLIENT_ERROR_TOPIC, {
            failedTlsRequest: evt
        })
    });

    mockServer.on('client-error', (evt) => {
        pubsub.publish(CLIENT_ERROR_TOPIC, {
            failedClientRequest: evt
        })
    });

    mockServer.on('rule-event', (evt) => {
        pubsub.publish(RULE_EVENT_TOPIC, {
            ruleEvent: evt
        })
    });

    return {
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
            webSocketMessageReceived: {
                subscribe: () => pubsub.asyncIterator(WEBSOCKET_MESSAGE_RECEIVED_TOPIC)
            },
            webSocketMessageSent: {
                subscribe: () => pubsub.asyncIterator(WEBSOCKET_MESSAGE_SENT_TOPIC)
            },
            webSocketClose: {
                subscribe: () => pubsub.asyncIterator(WEBSOCKET_CLOSE_TOPIC)
            },
            requestAborted: {
                subscribe: () => pubsub.asyncIterator(REQUEST_ABORTED_TOPIC)
            },
            tlsPassthroughOpened: {
                subscribe: () => pubsub.asyncIterator(TLS_PASSTHROUGH_OPENED_TOPIC)
            },
            tlsPassthroughClosed: {
                subscribe: () => pubsub.asyncIterator(TLS_PASSTHROUGH_CLOSED_TOPIC)
            },
            failedTlsRequest: {
                subscribe: () => pubsub.asyncIterator(TLS_CLIENT_ERROR_TOPIC)
            },
            failedClientRequest: {
                subscribe: () => pubsub.asyncIterator(CLIENT_ERROR_TOPIC)
            },
            ruleEvent: {
                subscribe: () => pubsub.asyncIterator(RULE_EVENT_TOPIC)
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
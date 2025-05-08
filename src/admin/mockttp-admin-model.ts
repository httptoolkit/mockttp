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
import { SubscribableEvent } from "../main";

const graphqlSubscriptionPairs = Object.entries({
    'requestInitiated': 'request-initiated',
    'requestReceived': 'request',
    'responseCompleted': 'response',
    'webSocketRequest': 'websocket-request',
    'webSocketAccepted': 'websocket-accepted',
    'webSocketMessageReceived': 'websocket-message-received',
    'webSocketMessageSent': 'websocket-message-sent',
    'webSocketClose': 'websocket-close',
    'requestAborted': 'abort',
    'tlsPassthroughOpened': 'tls-passthrough-opened',
    'tlsPassthroughClosed': 'tls-passthrough-closed',
    'failedTlsRequest': 'tls-client-error',
    'failedClientRequest': 'client-error',
    'rawPassthroughOpened': 'raw-passthrough-opened',
    'rawPassthroughClosed': 'raw-passthrough-closed',
    'rawPassthroughData': 'raw-passthrough-data',
    'ruleEvent': 'rule-event'
} satisfies { [key: string]: SubscribableEvent });

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

    for (let [gqlName, eventName] of graphqlSubscriptionPairs) {
        mockServer.on(eventName as any, (evt) => {
            pubsub.publish(eventName, { [gqlName]: evt });
        });
    }

    const subscriptionResolvers = Object.fromEntries(graphqlSubscriptionPairs.map(([gqlName, eventName]) => ([
        gqlName, {
            subscribe: () => pubsub.asyncIterator(eventName)
        }
    ])));

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

        Subscription: subscriptionResolvers,

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
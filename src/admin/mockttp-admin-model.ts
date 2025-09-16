import * as _ from "lodash";
import { Duplex } from 'stream';

import { PubSub } from "graphql-subscriptions";
import type { IResolvers } from "@graphql-tools/utils";
import { ErrorLike, UnreachableCheck } from "@httptoolkit/util";

import type { Headers } from '../types';
import type { MockttpServer } from "../server/mockttp-server";
import type { ServerMockedEndpoint } from "../server/mocked-endpoint";
import type {
    MockedEndpoint,
    MockedEndpointData,
    CompletedRequest,
    CompletedResponse,
    ClientError,
    CompletedBody
} from "../types";
import type { Serialized } from "../serialization/serialization";
import type { RequestRuleData } from "../rules/requests/request-rule";
import type { WebSocketRuleData } from "../rules/websockets/websocket-rule";

import {
    deserializeRuleData,
    deserializeWebSocketRuleData,
    MockttpDeserializationOptions
} from "../rules/rule-deserialization";
import { decodeBodyBuffer } from "../util/request-utils";
import { SubscribableEvent } from "../main";

const graphqlSubscriptionPairs = Object.entries({
    'requestInitiated': 'request-initiated',
    'requestReceived': 'request',
    'responseInitiated': 'response-initiated',
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

const decodeAndSerializeBody = async (body: CompletedBody, headers: Headers): Promise<
    | false // Not required
    | { decoded: Buffer, decodingError?: undefined } // Success
    | { decodingError: string, decoded?: undefined } // Failure
> => {
    try {
        const decoded = await decodeBodyBuffer(body.buffer, headers);
        if (decoded === body.buffer) return false; // No decoding required - no-op.
        else return { decoded }; // Successful decoding result
    } catch (e) {
        return { // Failed decoding - we just return the error message.
            decodingError: (e as ErrorLike)?.message ?? 'Failed to decode message body'
        };
    }
};

const serverSideRuleBodySerializer = async (body: CompletedBody, headers: Headers) => {
    const encoded = body.buffer.toString('base64');
    const result = await decodeAndSerializeBody(body, headers);
    if (result === false) { // No decoding required - no-op.
        return { encoded };
    } else if (result.decodingError !== undefined) { // Failed decoding - we just return the error message.
        return { encoded, decodingError: result.decodingError };
    } else if (result.decoded) { // Success - we return both formats to the client
        return { encoded, decoded: result.decoded.toString('base64') };
    } else {
        throw new UnreachableCheck(result);
    }
}

// messageBodyDecoding === 'None' => Just send encoded body as base64
const noopRuleBodySerializer = (body: CompletedBody) => body.buffer.toString('base64')

export function buildAdminServerModel(
    mockServer: MockttpServer,
    stream: Duplex,
    ruleParams: { [key: string]: any },
    options: {
        messageBodyDecoding?: 'server-side' | 'none';
    } = {}
): IResolvers {
    const pubsub = new PubSub();
    const messageBodyDecoding = options.messageBodyDecoding || 'server-side';

    const ruleDeserializationOptions: MockttpDeserializationOptions = {
        bodySerializer: messageBodyDecoding === 'server-side'
            ? serverSideRuleBodySerializer
            : noopRuleBodySerializer,
        ruleParams
    };

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
                return mockServer.addRequestRule(deserializeRuleData(input, stream, ruleDeserializationOptions));
            },
            addRules: async (__: any, { input }: { input: Array<Serialized<RequestRuleData>> }) => {
                return mockServer.addRequestRules(...input.map((rule) =>
                    deserializeRuleData(rule, stream, ruleDeserializationOptions)
                ));
            },
            setRules: async (__: any, { input }: { input: Array<Serialized<RequestRuleData>> }) => {
                return mockServer.setRequestRules(...input.map((rule) =>
                    deserializeRuleData(rule, stream, ruleDeserializationOptions)
                ));
            },

            addWebSocketRule: async (__: any, { input }: { input: Serialized<WebSocketRuleData> }) => {
                return mockServer.addWebSocketRule(deserializeWebSocketRuleData(input, stream, ruleDeserializationOptions));
            },
            addWebSocketRules: async (__: any, { input }: { input: Array<Serialized<WebSocketRuleData>> }) => {
                return mockServer.addWebSocketRules(...input.map((rule) =>
                    deserializeWebSocketRuleData(rule, stream, ruleDeserializationOptions)
                ));
            },
            setWebSocketRules: async (__: any, { input }: { input: Array<Serialized<WebSocketRuleData>> }) => {
                return mockServer.setWebSocketRules(...input.map((rule) =>
                    deserializeWebSocketRuleData(rule, stream, ruleDeserializationOptions)
                ));
            }
        },

        Subscription: subscriptionResolvers,

        Request: {
            body: (request: CompletedRequest) => {
                return request.body.buffer;
            },
            decodedBody: async (request: CompletedRequest) => {
                if (messageBodyDecoding === 'none') {
                    throw new Error('Decoded body requested, but messageBodyDecoding is set to "none"');
                }
                return (await decodeAndSerializeBody(request.body, request.headers))
                    || {}; // No decoding required
            }
        },

        Response: {
            body: (response: CompletedResponse) => {
                return response.body.buffer;
            },
            decodedBody: async (response: CompletedResponse) => {
                if (messageBodyDecoding === 'none') {
                    throw new Error('Decoded body requested, but messageBodyDecoding is set to "none"');
                }
                return (await decodeAndSerializeBody(response.body, response.headers))
                    || {}; // No decoding required
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
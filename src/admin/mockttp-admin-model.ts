import * as _ from "lodash";
import { Duplex } from "stream";

import {
  GraphQLScalarType,
  Kind,
  ObjectValueNode,
  ValueNode
} from "graphql";
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
import type { Serialized } from "../util/serialization";
import type { RequestRuleData } from "../rules/requests/request-rule";
import type { RequestMatcher } from "../rules/matchers";
import type { RequestHandler } from "../rules/requests/request-handlers";
import type { RuleCompletionChecker } from "../rules/completion-checkers";
import type { WebSocketRuleData } from "../rules/websockets/websocket-rule";
import type { WebSocketHandler } from "../rules/websockets/websocket-handlers";

import { deserializeRuleData, deserializeWebSocketRuleData } from "../rules/rule-deserialization";
import { astToObject } from "./graphql-utils";

const REQUEST_INITIATED_TOPIC = 'request-initiated';
const REQUEST_RECEIVED_TOPIC = 'request-received';
const RESPONSE_COMPLETED_TOPIC = 'response-completed';
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

const ScalarResolvers = {
    RequestMatcher: new GraphQLScalarType({
        name: 'RequestMatcher',
        description: 'Matcher for requests',
        serialize: (value) => {
            throw new Error('Matchers are input only values')
        },
        parseValue: (v) => v,
        parseLiteral(ast) {
            if (ast.kind === Kind.OBJECT) {
                return astToObject<RequestMatcher>(ast);
            } else return null;
        }
    }),

    RequestHandler: new GraphQLScalarType({
        name: 'RequestHandler',
        description: 'Handler for requests',
        serialize: (value) => {
            throw new Error('Handlers are input only values')
        },
        parseValue: (v) => v,
        parseLiteral(ast) {
            if (ast.kind === Kind.OBJECT) {
                return astToObject<RequestHandler>(ast);
            } else return null;
        }
    }),

    WebSocketHandler: new GraphQLScalarType({
        name: 'WebSocketHandler',
        description: 'Handler for websockets',
        serialize: (value) => {
            throw new Error('Handlers are input only values')
        },
        parseValue: (v) => v,
        parseLiteral(ast) {
            if (ast.kind === Kind.OBJECT) {
                return astToObject<WebSocketHandler>(ast);
            } else return null;
        }
    }),

    RuleCompletionChecker: new GraphQLScalarType({
        name: 'RuleCompletionChecker',
        description: 'Completion checkers for requests',
        serialize: (value) => {
            throw new Error('Completion checkers are input only values')
        },
        parseValue: (v) => v,
        parseLiteral(ast) {
            if (ast.kind === Kind.OBJECT) {
                return astToObject<RuleCompletionChecker>(ast);
            } else return null;
        }
    })
};

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

    mockServer.on('abort', (request) => {
        pubsub.publish(REQUEST_ABORTED_TOPIC, {
            requestAborted: request
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
                return mockServer.addRule(deserializeRuleData(input, stream, ruleParameters));
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
                return mockServer.setFallbackRequestRule(deserializeRuleData(input, stream, ruleParameters));
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
        },

        ...ScalarResolvers
    };
}
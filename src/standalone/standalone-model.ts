/**
 * @module Internal
 */

import * as _ from "lodash";
import { Duplex } from "stream";

import {
  GraphQLScalarType,
  Kind,
  ObjectValueNode,
  ValueNode
} from "graphql";
import { IResolvers } from "graphql-tools/dist/Interfaces";
import { PubSub } from "graphql-subscriptions";

import MockttpServer from "../server/mockttp-server";
import { MockedEndpoint, MockedEndpointData, CompletedRequest, CompletedResponse } from "../types";
import { Serialized } from "../util/serialization";
import { MockRuleData, deserializeRuleData } from "../rules/mock-rule";
import { RequestMatcher } from "../rules/matchers";
import { RequestHandler } from "../rules/handlers";
import { RuleCompletionChecker } from "../rules/completion-checkers";

const REQUEST_INITIATED_TOPIC = 'request-initiated';
const REQUEST_RECEIVED_TOPIC = 'request-received';
const RESPONSE_COMPLETED_TOPIC = 'response-completed';
const REQUEST_ABORTED_TOPIC = 'request-aborted';
const TLS_CLIENT_ERROR_TOPIC = 'tls-client-error';

function astToObject<T>(ast: ObjectValueNode): T {
    return <T> _.zipObject(
        ast.fields.map((f) => f.name.value),
        ast.fields.map((f) => parseAnyAst(f.value))
    );
}

function parseAnyAst(ast: ValueNode): any {
    switch (ast.kind) {
        case Kind.OBJECT:
            return astToObject<any>(ast);
        case Kind.LIST:
            return ast.values.map(parseAnyAst);
        case Kind.BOOLEAN:
        case Kind.ENUM:
        case Kind.FLOAT:
        case Kind.INT:
        case Kind.STRING:
            return ast.value;
        case Kind.NULL:
            return null;
        case Kind.VARIABLE:
            throw new Error("No idea what parsing a 'variable' means");
    }
}

async function buildMockedEndpointData(endpoint: MockedEndpoint): Promise<MockedEndpointData> {
    return {
        id: endpoint.id,
        seenRequests: await endpoint.getSeenRequests()
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
    }),

    Json: new GraphQLScalarType({
        name: 'Json',
        description: 'A JSON entity, serialized as a simple JSON string',
        serialize: (value: any) => JSON.stringify(value),
        parseValue: (input: string): any => JSON.parse(input),
        parseLiteral: parseAnyAst
    }),

    Any: new GraphQLScalarType({
        name: 'Any',
        description: 'Wildcard Anything! Here be dragons',
        serialize: (value: any) => JSON.stringify(value),
        parseValue: (input: string): any => JSON.parse(input),
        parseLiteral: parseAnyAst
    }),

    Buffer: new GraphQLScalarType({
        name: 'Buffer',
        description: 'A buffer',
        serialize: (value: Buffer) => {
            return value.toString('base64');
        },
        parseValue: (input: string) => {
            return Buffer.from(input, 'base64');
        },
        parseLiteral: parseAnyAst
    })
};

export function buildStandaloneModel(mockServer: MockttpServer, stream: Duplex): IResolvers {
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

    mockServer.on('tlsClientError', (request) => {
        pubsub.publish(TLS_CLIENT_ERROR_TOPIC, {
            failedTlsRequest: request
        })
    });

    return <any> {
        Query: {
            mockedEndpoints: (): Promise<MockedEndpointData[]> => {
                return Promise.all(mockServer.mockedEndpoints.map(buildMockedEndpointData));
            },

            mockedEndpoint: (__: any, { id }: { id: string }): Promise<MockedEndpointData> | null => {
                let endpoint = _.find(mockServer.mockedEndpoints, (endpoint: MockedEndpoint) => {
                    return endpoint.id === id;
                });

                if (!endpoint) return null;

                return buildMockedEndpointData(endpoint);
            }
        },

        Mutation: {
            addRule: async (__: any, { input }: { input: Serialized<MockRuleData> }) => {
                return mockServer.addRule(deserializeRuleData(input, stream));
            },
            addRules: async (__: any, { input }: { input: Array<Serialized<MockRuleData>> }) => {
                return mockServer.addRules(...input.map((rule) =>
                    deserializeRuleData(rule, stream)
                ));
            },
            setRules: async (__: any, { input }: { input: Array<Serialized<MockRuleData>> }) => {
                return mockServer.setRules(...input.map((rule) =>
                    deserializeRuleData(rule, stream)
                ));
            },

            reset: () => {
                mockServer.reset();
                return true;
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

        ...ScalarResolvers
    };
}
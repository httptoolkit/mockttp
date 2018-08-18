/**
 * @module Internal
 */

import * as _ from "lodash";

import {
  GraphQLScalarType,
  Kind,
  ObjectValueNode,
  ValueNode
} from "graphql";
import { IResolvers } from "graphql-tools/dist/Interfaces";
import { PubSub } from "graphql-subscriptions";

import { MatcherData } from "../rules/matchers";
import { HandlerData } from "../rules/handlers";
import { CompletionCheckerData } from "../rules/completion-checkers";
import MockttpServer from "../server/mockttp-server";
import { MockedEndpoint, MockedEndpointData, CompletedBody, CompletedRequest, CompletedResponse } from "../types";
import { deserializeRuleData } from "../rules/mock-rule";
import { Duplex } from "stream";

const REQUEST_RECEIVED_TOPIC = 'request-received';
const RESPONSE_COMPLETED_TOPIC = 'response-completed';

function astToObject<T>(ast: ObjectValueNode): T {
    return <T> _.zipObject(
        ast.fields.map((f) => f.name.value),
        ast.fields.map((f) => parseAnyAst(f.value))
    );
}

function parseAnyAst(ast: ValueNode): any {
    switch (ast.kind) {
        case Kind.OBJECT:
            return astToObject<HandlerData>(ast);
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
                return astToObject<MatcherData>(ast);
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
                return astToObject<HandlerData>(ast);
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
                return astToObject<CompletionCheckerData>(ast);
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
            addRule: async (__: any, { input }: { input: any }) => {
                return mockServer.addRule(deserializeRuleData(input, { clientStream: stream }));
            },

            reset: () => {
                mockServer.reset();
                return true;
            }
        },

        Subscription: {
            requestReceived: {
                subscribe: () => pubsub.asyncIterator(REQUEST_RECEIVED_TOPIC)
            },
            responseCompleted: {
                subscribe: () => pubsub.asyncIterator(RESPONSE_COMPLETED_TOPIC)
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
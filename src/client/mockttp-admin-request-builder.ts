import _ = require('lodash');
import * as stream from 'stream';
import gql from 'graphql-tag';

import { MockedEndpoint, MockedEndpointData } from "../types";

import { rawHeadersToObject } from '../util/header-utils';

import { AdminQuery } from './admin-query';
import { SchemaIntrospector } from './schema-introspection';

import type { RequestRuleData } from "../rules/requests/request-rule";
import type { WebSocketRuleData } from '../rules/websockets/websocket-rule';

import { SubscribableEvent } from '../mockttp';
import { MockedEndpointClient } from "./mocked-endpoint-client";
import { AdminClient } from './admin-client';
import { serializeRuleData } from '../rules/rule-serialization';
import { deserializeBodyReader } from '../serialization/body-serialization';
import { unreachableCheck } from '@httptoolkit/util';

function normalizeHttpMessage(message: any, event?: SubscribableEvent) {
    if (message.timingEvents) {
        // Timing events are serialized as raw JSON
        message.timingEvents = JSON.parse(message.timingEvents);
    }

    if (message.rawHeaders) {
        message.rawHeaders = JSON.parse(message.rawHeaders);
        // We use raw headers where possible to derive headers, instead of using any pre-derived
        // header data, for maximum accuracy (and to avoid any need to query for both).
        message.headers = rawHeadersToObject(message.rawHeaders);
    }

    if (message.rawTrailers) {
        message.rawTrailers = JSON.parse(message.rawTrailers);
        message.trailers = rawHeadersToObject(message.rawTrailers);
    } else if (message.rawHeaders && message.body) { // HTTP events with bodies should have trailers
        message.rawTrailers = [];
        message.trailers = {};
    }

    if (message.body !== undefined) {
        // This will be unset if a) no decoding is required (so message.body is already decoded implicitly),
        // b) if messageBodyDecoding is set to 'none', or c) if the server is <v4 and doesn't do decoding.
        let { decoded, decodingError } = message.decodedBody || {};

        message.body = deserializeBodyReader(
            message.body,
            decoded,
            decodingError,
            message.headers
        );
    }
    delete message.decodedBody;

    if (event?.startsWith('tls-')) {
        // TLS passthrough & error events should have raw JSON socket metadata:
        if (message.tlsMetadata) {
            message.tlsMetadata = JSON.parse(message.tlsMetadata);
        } else {
            // For old servers, just use empty metadata:
            message.tlsMetadata = {};
        }
    }
}

function normalizeWebSocketMessage(message: any) {
    // Timing events are serialized as raw JSON
    message.timingEvents = JSON.parse(message.timingEvents);

    // Content is serialized as the raw encoded buffer in base64
    message.content = Buffer.from(message.content, 'base64');
}

/**
 * This is part of Mockttp's experimental 'pluggable admin' API. This may change
 * unpredictably, even in minor releases.
 *
 * @internal
 */
export class MockttpAdminRequestBuilder {

    private messageBodyDecoding: 'server-side' | 'none';

    constructor(
        private schema: SchemaIntrospector,
        options: { messageBodyDecoding: 'server-side' | 'none' } = { messageBodyDecoding: 'server-side' }
    ) {
        this.messageBodyDecoding = options.messageBodyDecoding;
    }

    buildAddRulesQuery(
        type: 'http' | 'ws',
        rules: Array<RequestRuleData | WebSocketRuleData>,
        reset: boolean,
        adminStream: stream.Duplex
    ): AdminQuery<
        { endpoints: Array<{ id: string, explanation?: string }> },
        MockedEndpoint[]
    > {
        const ruleTypeName = type === 'http'
                ? ''
            : type === 'ws'
                ? 'WebSocket'
            : unreachableCheck(type);
        const requestName = (reset ? 'Set' : 'Add') + ruleTypeName + 'Rules';
        const mutationName = (reset ? 'set' : 'add') + ruleTypeName + 'Rules';

        // Backward compatibility for old servers that don't support steps:
        const supportsSteps = this.schema.typeHasInputField('MockRule', 'steps');
        const serializedRules = rules.map((rule) => serializeRuleData(rule, adminStream, { supportsSteps }));

        return {
            query: gql`
                mutation ${requestName}($newRules: [${ruleTypeName}MockRule!]!) {
                    endpoints: ${mutationName}(input: $newRules) {
                        id,
                        explanation
                    }
                }
            `,
            variables: {
                newRules: serializedRules
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

    public buildSubscriptionRequest<T>(event: SubscribableEvent): AdminQuery<unknown, T> | undefined {
        // Note the asOptionalField checks - these are a quick hack for backward compatibility,
        // introspecting the server schema to avoid requesting fields that don't exist on old servers.

        const query = {
            'request-initiated': gql`subscription OnRequestInitiated {
                requestInitiated {
                    id
                    protocol
                    method
                    url
                    path
                    ${this.schema.asOptionalField('InitiatedRequest', 'remoteIpAddress')}
                    ${this.schema.asOptionalField('InitiatedRequest', 'remotePort')}

                    ${this.schema.typeHasField('InitiatedRequest', 'destination')
                        ? 'destination { hostname, port }'
                        : 'hostname' // Backward compat for old servers
                    }

                    rawHeaders
                    timingEvents
                    httpVersion
                    tags
                }
            }`,
            request: gql`subscription OnRequest {
                requestReceived {
                    id
                    matchedRuleId
                    protocol
                    method
                    url
                    path
                    ${this.schema.asOptionalField('Request', 'remoteIpAddress')}
                    ${this.schema.asOptionalField('Request', 'remotePort')}

                    ${this.schema.typeHasField('Request', 'destination')
                        ? 'destination { hostname, port }'
                        : 'hostname' // Backward compat for old servers
                    }

                    rawHeaders
                    body
                    ${this.schema.typeHasField('Request', 'decodedBody') && this.messageBodyDecoding === 'server-side'
                        ? 'decodedBody { decoded, decodingError }'
                        : ''
                    }
                    ${this.schema.asOptionalField('Request', 'rawTrailers')}

                    timingEvents
                    httpVersion
                    tags
                }
            }`,
            response: gql`subscription OnResponse {
                responseCompleted {
                    id
                    statusCode
                    statusMessage

                    rawHeaders
                    body
                    ${this.schema.typeHasField('Response', 'decodedBody') && this.messageBodyDecoding === 'server-side'
                        ? 'decodedBody { decoded, decodingError }'
                        : ''
                    }
                    ${this.schema.asOptionalField('Response', 'rawTrailers')}

                    timingEvents
                    tags
                }
            }`,
            'websocket-request': gql`subscription OnWebSocketRequest {
                webSocketRequest {
                    id
                    matchedRuleId
                    protocol
                    method
                    url
                    path
                    remoteIpAddress
                    remotePort

                    ${this.schema.typeHasField('Request', 'destination')
                        ? 'destination { hostname, port }'
                        : 'hostname' // Backward compat for old servers
                    }

                    rawHeaders
                    body
                    ${this.schema.typeHasField('Request', 'decodedBody') && this.messageBodyDecoding === 'server-side'
                        ? 'decodedBody { decoded, decodingError }'
                        : ''
                    }
                    ${this.schema.asOptionalField('Request', 'rawTrailers')}

                    timingEvents
                    httpVersion
                    tags
                }
            }`,
            'websocket-accepted': gql`subscription OnWebSocketAccepted {
                webSocketAccepted {
                    id
                    statusCode
                    statusMessage

                    rawHeaders
                    body
                    ${this.schema.typeHasField('Response', 'decodedBody') && this.messageBodyDecoding === 'server-side'
                        ? 'decodedBody { decoded, decodingError }'
                        : ''
                    }
                    ${this.schema.asOptionalField('Response', 'rawTrailers')}

                    timingEvents
                    tags
                }
            }`,
            'websocket-message-received': gql`subscription OnWebSocketMessageReceived {
                webSocketMessageReceived {
                    streamId
                    direction
                    content
                    isBinary
                    eventTimestamp

                    timingEvents
                    tags
                }
            }`,
            'websocket-message-sent': gql`subscription OnWebSocketMessageSent {
                webSocketMessageSent {
                    streamId
                    direction
                    content
                    isBinary
                    eventTimestamp

                    timingEvents
                    tags
                }
            }`,
            'websocket-close': gql`subscription OnWebSocketClose {
                webSocketClose {
                    streamId

                    closeCode
                    closeReason

                    timingEvents
                    tags
                }
            }`,
            abort: gql`subscription OnAbort {
                requestAborted {
                    id
                    protocol
                    method
                    url
                    path

                    ${this.schema.typeHasField('AbortedRequest', 'destination')
                        ? 'destination { hostname, port }'
                        : 'hostname' // Backward compat for old servers
                    }

                    rawHeaders

                    timingEvents
                    tags

                    error
                }
            }`,
            'tls-passthrough-opened': gql`subscription OnTlsPassthroughOpened {
                tlsPassthroughOpened {
                    id

                    ${this.schema.typeHasField('TlsPassthroughEvent', 'destination')
                        ? 'destination { hostname, port }'
                        : `
                            hostname
                            upstreamPort
                        `
                    }

                    remoteIpAddress
                    remotePort
                    tags
                    timingEvents
                    tlsMetadata
                }
            }`,
            'tls-passthrough-closed': gql`subscription OnTlsPassthroughClosed {
                tlsPassthroughClosed {
                    id

                    ${this.schema.typeHasField('TlsPassthroughEvent', 'destination')
                        ? 'destination { hostname, port }'
                        : `
                            hostname
                            upstreamPort
                        `
                    }

                    remoteIpAddress
                    remotePort
                    tags
                    timingEvents
                    tlsMetadata
                }
            }`,
            'tls-client-error': gql`subscription OnTlsClientError {
                failedTlsRequest {
                    failureCause

                    ${this.schema.typeHasField('TlsHandshakeFailure', 'destination')
                        ? 'destination { hostname, port }'
                        : 'hostname'
                    }

                    remoteIpAddress
                    remotePort
                    tags
                    timingEvents
                    tlsMetadata
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

                        rawHeaders

                        ${this.schema.asOptionalField('ClientErrorRequest', 'remoteIpAddress')}
                        ${this.schema.asOptionalField('ClientErrorRequest', 'remotePort')}
                        ${this.schema.asOptionalField('ClientErrorRequest', 'destination', 'destination { hostname, port }')}
                    }
                    response {
                        id
                        timingEvents
                        tags
                        statusCode
                        statusMessage

                        rawHeaders

                        body
                        ${this.schema.typeHasField('Response', 'decodedBody') && this.messageBodyDecoding === 'server-side'
                            ? 'decodedBody { decoded, decodingError }'
                            : ''
                        }

                        ${this.schema.asOptionalField('Response', 'rawTrailers')}
                    }
                }
            }`,
            'raw-passthrough-opened': gql`subscription OnRawPassthroughOpened {
                rawPassthroughOpened {
                    id

                    destination { hostname, port }

                    remoteIpAddress
                    remotePort
                    tags
                    timingEvents
                }
            }`,
            'raw-passthrough-closed': gql`subscription OnRawPassthroughClosed {
                rawPassthroughClosed {
                    id

                    destination { hostname, port }

                    remoteIpAddress
                    remotePort
                    tags
                    timingEvents
                }
            }`,
            'raw-passthrough-data': gql`subscription OnRawPassthroughData {
                rawPassthroughData {
                    id
                    direction
                    content
                    eventTimestamp
                }
            }`,
            'rule-event': gql`subscription OnRuleEvent {
                ruleEvent {
                    requestId
                    ruleId
                    eventType
                    eventData
                }
            }`
        }[event];

        if (!query) return; // Unrecognized event, we can't subscribe to this.

        return {
            query,
            transformResponse: (data: any): T => {
                if (event === 'client-error') {
                    data.request = _.mapValues(data.request, (v) =>
                        // Normalize missing values to undefined to match the local result
                        v === null ? undefined : v
                    );

                    normalizeHttpMessage(data.request, event);
                    if (data.response) {
                        normalizeHttpMessage(data.response, event);
                    } else {
                        data.response = 'aborted';
                    }
                } else if (event === 'websocket-message-received' || event === 'websocket-message-sent') {
                    normalizeWebSocketMessage(data);
                } else if (event === 'raw-passthrough-data') {
                    data.content = Buffer.from(data.content, 'base64');
                } else if (event === 'abort') {
                    normalizeHttpMessage(data, event);
                    data.error = data.error ? JSON.parse(data.error) : undefined;
                } else if (event === 'rule-event') {
                    const { eventData } = data;

                    // Events may include raw body data buffers, serialized as base64:
                    if (eventData.rawBody !== undefined) {
                        eventData.rawBody = Buffer.from(eventData.rawBody, 'base64');
                    }
                } else {
                    normalizeHttpMessage(data, event);
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
                                id,
                                protocol,
                                method,
                                url,
                                path,
                                hostname

                                rawHeaders

                                body
                                ${this.schema.typeHasField('Request', 'decodedBody') && this.messageBodyDecoding === 'server-side'
                                    ? 'decodedBody { decoded, decodingError }'
                                    : ''
                                }
                                timingEvents
                                httpVersion
                            }
                            isPending
                        }
                    }
                `,
                variables: { id: ruleId }
            });

            const mockedEndpoint = result.mockedEndpoint;
            if (!mockedEndpoint) return null;

            mockedEndpoint.seenRequests.forEach(req => normalizeHttpMessage(req));

            return mockedEndpoint;
        }
}
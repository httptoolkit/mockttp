import _ = require('lodash');
import * as stream from 'stream';
import gql from 'graphql-tag';

import { MockedEndpoint, MockedEndpointData } from "../types";

import { buildBodyReader } from '../util/request-utils';
import { objectHeadersToRaw, rawHeadersToObject } from '../util/header-utils';

import { AdminQuery } from './admin-query';
import { SchemaIntrospector } from './schema-introspection';

import type { RequestRuleData } from "../rules/requests/request-rule";
import type { WebSocketRuleData } from '../rules/websockets/websocket-rule';

import { SubscribableEvent } from '../mockttp';
import { MockedEndpointClient } from "./mocked-endpoint-client";
import { AdminClient } from './admin-client';
import { serializeRuleData } from '../rules/rule-serialization';

function normalizeHttpMessage(message: any, event?: SubscribableEvent) {
    if (message.timingEvents) {
        // Timing events are serialized as raw JSON
        message.timingEvents = JSON.parse(message.timingEvents);
    } else if (event !== 'tls-client-error' && event !== 'client-error') {
        // For backwards compat, all except errors should have timing events if they're missing
        message.timingEvents = {};
    }

    if (message.rawHeaders) {
        message.rawHeaders = JSON.parse(message.rawHeaders);
        // We use raw headers where possible to derive headers, instead of using any pre-derived
        // header data, for maximum accuracy (and to avoid any need to query for both).
        message.headers = rawHeadersToObject(message.rawHeaders);
    } else if (message.headers) {
        // Backward compat for older servers:
        message.headers = JSON.parse(message.headers);
        message.rawHeaders = objectHeadersToRaw(message.headers);
    }

    if (message.rawTrailers) {
        message.rawTrailers = JSON.parse(message.rawTrailers);
        message.trailers = rawHeadersToObject(message.rawTrailers);
    } else if (message.rawHeaders && message.body) { // HTTP events with bodies should have trailers
        message.rawTrailers = [];
        message.trailers = {};
    }

    if (message.body !== undefined) {
        // Body is serialized as the raw encoded buffer in base64
        message.body = buildBodyReader(Buffer.from(message.body, 'base64'), message.headers);
    }

    // For backwards compat, all except errors should have tags if they're missing
    if (!message.tags) message.tags = [];

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

    constructor(
        private schema: SchemaIntrospector
    ) {}

    buildAddRequestRulesQuery(
        rules: Array<RequestRuleData>,
        reset: boolean,
        adminStream: stream.Duplex
    ): AdminQuery<
        { endpoints: Array<{ id: string, explanation?: string }> },
        MockedEndpoint[]
    > {
        const requestName = (reset ? 'Set' : 'Add') + 'Rules';
        const mutationName = (reset ? 'set' : 'add') + 'Rules';

        const serializedRules = rules.map((rule) => {
            const serializedRule = serializeRuleData(rule, adminStream)
            if (!this.schema.typeHasInputField('MockRule', 'id')) {
                delete serializedRule.id;
            }
            return serializedRule;
        });

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
                newRules: serializedRules
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

    buildAddWebSocketRulesQuery(
        rules: Array<WebSocketRuleData>,
        reset: boolean,
        adminStream: stream.Duplex
    ): AdminQuery<
        { endpoints: Array<{ id: string, explanation?: string }> },
        MockedEndpoint[]
    > {
        // Seperate and simpler than buildAddRequestRulesQuery, because it doesn't have to
        // deal with backward compatibility.
        const requestName = (reset ? 'Set' : 'Add') + 'WebSocketRules';
        const mutationName = (reset ? 'set' : 'add') + 'WebSocketRules';

        const serializedRules = rules.map((rule) => serializeRuleData(rule, adminStream));

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
                    hostname

                    ${this.schema.typeHasField('InitiatedRequest', 'rawHeaders')
                        ? 'rawHeaders'
                        : 'headers'
                    }
                    timingEvents
                    httpVersion
                    ${this.schema.asOptionalField('InitiatedRequest', 'tags')}
                }
            }`,
            request: gql`subscription OnRequest {
                requestReceived {
                    id
                    ${this.schema.asOptionalField('Request', 'matchedRuleId')}
                    protocol
                    method
                    url
                    path
                    ${this.schema.asOptionalField('Request', 'remoteIpAddress')}
                    ${this.schema.asOptionalField('Request', 'remotePort')}
                    hostname

                    ${this.schema.typeHasField('Request', 'rawHeaders')
                        ? 'rawHeaders'
                        : 'headers'
                    }

                    body
                    ${this.schema.asOptionalField('Request', 'rawTrailers')}

                    ${this.schema.asOptionalField('Request', 'timingEvents')}
                    ${this.schema.asOptionalField('Request', 'httpVersion')}
                    ${this.schema.asOptionalField('Request', 'tags')}
                }
            }`,
            response: gql`subscription OnResponse {
                responseCompleted {
                    id
                    statusCode
                    statusMessage

                    ${this.schema.typeHasField('Response', 'rawHeaders')
                        ? 'rawHeaders'
                        : 'headers'
                    }

                    body
                    ${this.schema.asOptionalField('Response', 'rawTrailers')}

                    ${this.schema.asOptionalField('Response', 'timingEvents')}
                    ${this.schema.asOptionalField('Response', 'tags')}
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
                    hostname

                    rawHeaders
                    body
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
                    id,
                    protocol,
                    method,
                    url,
                    path,
                    hostname,

                    ${this.schema.typeHasField('Request', 'rawHeaders')
                        ? 'rawHeaders'
                        : 'headers'
                    }

                    ${this.schema.asOptionalField('Request', 'timingEvents')}
                    ${this.schema.asOptionalField('Request', 'tags')}
                    ${this.schema.asOptionalField('AbortedRequest', 'error')}
                }
            }`,
            'tls-passthrough-opened': gql`subscription OnTlsPassthroughOpened {
                tlsPassthroughOpened {
                    id
                    upstreamPort

                    hostname
                    remoteIpAddress
                    remotePort
                    tags
                    timingEvents
                    ${this.schema.asOptionalField('TlsPassthroughEvent', 'tlsMetadata')}
                }
            }`,
            'tls-passthrough-closed': gql`subscription OnTlsPassthroughClosed {
                tlsPassthroughClosed {
                    id
                    upstreamPort

                    hostname
                    remoteIpAddress
                    remotePort
                    tags
                    timingEvents
                    ${this.schema.asOptionalField('TlsPassthroughEvent', 'tlsMetadata')}
                }
            }`,
            'tls-client-error': gql`subscription OnTlsClientError {
                failedTlsRequest {
                    failureCause
                    hostname
                    remoteIpAddress
                    ${this.schema.asOptionalField(['TlsHandshakeFailure', 'TlsRequest'], 'remotePort')}
                    ${this.schema.asOptionalField(['TlsHandshakeFailure', 'TlsRequest'], 'tags')}
                    ${this.schema.asOptionalField(['TlsHandshakeFailure', 'TlsRequest'], 'timingEvents')}
                    ${this.schema.asOptionalField(['TlsHandshakeFailure', 'TlsRequest'], 'tlsMetadata')}
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

                        ${this.schema.typeHasField('ClientErrorRequest', 'rawHeaders')
                            ? 'rawHeaders'
                            : 'headers'
                        }

                        ${this.schema.asOptionalField('ClientErrorRequest', 'remoteIpAddress')}
                        ${this.schema.asOptionalField('ClientErrorRequest', 'remotePort')}
                    }
                    response {
                        id
                        timingEvents
                        tags
                        statusCode
                        statusMessage

                        ${this.schema.typeHasField('Response', 'rawHeaders')
                            ? 'rawHeaders'
                            : 'headers'
                        }

                        body
                        ${this.schema.asOptionalField('Response', 'rawTrailers')}
                    }
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

                                ${this.schema.typeHasField('Request', 'rawHeaders')
                                    ? 'rawHeaders'
                                    : 'headers'
                                }

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

            mockedEndpoint.seenRequests.forEach(req => normalizeHttpMessage(req));

            return mockedEndpoint;
        }
}
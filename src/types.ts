import stream = require('stream');
import http = require('http');
import { EventEmitter } from 'events';

export const DEFAULT_ADMIN_SERVER_PORT = 45454;

export enum Method {
    GET,
    POST,
    PUT,
    DELETE,
    PATCH,
    HEAD,
    OPTIONS
}

export enum RulePriority {
    FALLBACK = 0,
    DEFAULT = 1
}

export interface Headers {
    // An arbitrary set of headers that are known to
    // only ever appear once (for valid requests).
    host?: string;
    'content-length'?: string;
    'content-type'?: string;
    'user-agent'?: string;
    cookie?: string;
    ':method'?: string;
    ':scheme'?: string;
    ':authority'?: string;
    ':path'?: string;

    // In general there may be 0+ of any header
    [key: string]: undefined | string | string[];
}

export interface Trailers {
    // 0+ of any trailer
    [key: string]: undefined | string | string[];
}

export type RawHeaders = Array<[key: string, value: string]>;
export type RawTrailers = RawHeaders; // Just a convenient alias

export interface Request {
    id: string;
    matchedRuleId?: string;

    protocol: string;
    httpVersion?: string; // Like timingEvents - not set remotely with older servers
    method: string;
    url: string;
    path: string;

    remoteIpAddress?: string; // Not set remotely with older servers or in some error cases
    remotePort?: number; // Not set remotely with older servers or in some error cases

    // Exists only if a host header is sent. A strong candidate for deprecation
    // in future, since it's not clear that this comes from headers not the URL, and
    // either way it duplicates existing data.
    hostname?: string;

    headers: Headers;
    rawHeaders: RawHeaders;

    timingEvents: TimingEvents;
    tags: string[];
}

export interface TlsConnectionEvent {
    hostname?: string;
    remoteIpAddress?: string; // Can be unavailable in some error cases
    remotePort?: number; // Can be unavailable in some error cases
    tags: string[];
    timingEvents: TlsTimingEvents;
    tlsMetadata: TlsSocketMetadata;
}

export interface TlsSocketMetadata {
    sniHostname?: string;
    connectHostname?: string;
    connectPort?: string;
    clientAlpn?: string[];
    ja3Fingerprint?: string;
    ja4Fingerprint?: string;
}

export interface TlsPassthroughEvent extends TlsConnectionEvent {
    id: string;
    upstreamPort: number;

    remoteIpAddress: string;
    remotePort: number;
}

export interface TlsHandshakeFailure extends TlsConnectionEvent {
    failureCause:
        | 'closed'
        | 'reset'
        | 'cert-rejected'
        | 'no-shared-cipher'
        | 'handshake-timeout'
        | 'unknown';
    timingEvents: TlsFailureTimingEvents;
}

export interface TlsTimingEvents {
    /**
     * When the socket initially connected, in MS since the unix
     * epoch.
     */
    startTime: number;

    /**
     * When the socket initially connected, equivalent to startTime.
     *
     * High-precision floating-point monotonically increasing timestamps.
     * Comparable and precise, but not related to specific current time.
     */
    connectTimestamp: number;

    /**
     * When Mockttp's handshake for this connection was completed (if there
     * was one). This is not set for passed through connections.
     */
    handshakeTimestamp?: number;

    /**
     * When the outer tunnel (e.g. a preceeding CONNECT request) was created,
     * if there was one.
     */
    tunnelTimestamp?: number;

    /**
     * When the connection was closed, if it has been closed.
     */
    disconnectTimestamp?: number;
}

export interface TlsFailureTimingEvents extends TlsTimingEvents {
    /**
     * When the TLS connection failed. This may be due to a failed handshake
     * (in which case `handshakeTimestamp` will be undefined) or due to a
     * subsequent error which means the TLS connection was not usable (like
     * an immediate closure due to an async certificate rejection).
     */
    failureTimestamp: number;
}

// Internal representation of an ongoing HTTP request whilst it's being processed
export interface OngoingRequest extends Request, EventEmitter {
    body: OngoingBody;
    rawTrailers?: RawHeaders;
}

export interface OngoingBody {
    asStream: () => stream.Readable;
    asBuffer: () => Promise<Buffer>;
    asDecodedBuffer: () => Promise<Buffer>;
    asText: () => Promise<string>;
    asJson: () => Promise<object>;
    asFormData: () => Promise<{ [key: string]: string | string[] | undefined }>;
}

export interface CompletedBody {
    /**
     * The raw bytes of the response. If a content encoding was used, this is
     * the raw encoded data.
     */
    buffer: Buffer;

    /**
     * The decoded bytes of the response. If no encoding was used, this is the
     * same as `.buffer`. The response is decoded and returned asynchronously
     * as a Promise.
     */
    getDecodedBuffer(): Promise<Buffer | undefined>;

    /**
     * The contents of the response, decoded and parsed as a UTF-8 string.
     * The response is decoded and returned asynchronously as a Promise.
     */
    getText(): Promise<string | undefined>;

    /**
     * The contents of the response, decoded, parsed as UTF-8 string, and
     * then parsed a JSON. The response is decoded and returned asynchronously
     * as a Promise.
     */
    getJson(): Promise<object | undefined>;

    /**
     * The contents of the response, decoded, and then parsed automatically as
     * either one of the form encoding types (either URL-encoded or multipart),
     * determined automatically from the message content-type header.
     *
     * This method is convenient and offers a single mechanism to parse both
     * formats, but you may want to consider parsing on format explicitly with
     * the `getUrlEncodedFormData()` or `getMultipartFormData()` methods instead.
     *
     * After parsing & decoding, the result is returned asynchronously as a
     * Promise for a key-value(s) object.
     */
    getFormData(): Promise<{ [key: string]: string | string[] | undefined } | undefined>;

    /**
     * The contents of the response, decoded, parsed as UTF-8 string, and then
     * parsed as URL-encoded form data. After parsing & decoding, the result is
     * returned asynchronously as a Promise for a key-value(s) object.
     */
    getUrlEncodedFormData(): Promise<{ [key: string]: string | string[] | undefined } | undefined>;

    /**
     * The contents of the response, decoded, and then parsed as multi-part
     * form data. The response is result is returned asynchronously as a
     * Promise for an array of parts with their names, data and metadata.
     */
    getMultipartFormData(): Promise<Array<{ name?: string, filename?: string, type?: string, data: Buffer }> | undefined>;
}

// Internal & external representation of an initiated (no body yet received) HTTP request.
export type InitiatedRequest = Request;

export interface AbortedRequest extends InitiatedRequest {
    error?: {
        name?: string;
        code?: string;
        message?: string;
        stack?: string;
    };
}

// Internal & external representation of a fully completed HTTP request
export interface CompletedRequest extends Request {
    body: CompletedBody;
    rawTrailers: RawTrailers;
    trailers: Trailers;
}

export interface TimingEvents {
    // Milliseconds since unix epoch
    startTime: number;

    // High-precision floating-point monotonically increasing timestamps.
    // Comparable and precise, but not related to specific current time.
    startTimestamp: number; // When the request was initially received
    bodyReceivedTimestamp?: number; // When the request body was fully received
    headersSentTimestamp?: number; // When the response headers were sent
    responseSentTimestamp?: number; // When the response was fully completed

    wsAcceptedTimestamp?: number; // When the websocket was accepted
    wsClosedTimestamp?: number; // When the websocket was closed

    abortedTimestamp?: number; // When the connected was aborted
}

export interface OngoingResponse extends http.ServerResponse {
    id: string;
    getHeaders(): Headers;
    getRawHeaders(): RawHeaders;
    body: OngoingBody;
    getRawTrailers(): RawTrailers;
    timingEvents: TimingEvents;
    tags: string[];
}

export interface CompletedResponse {
    id: string;
    statusCode: number;
    statusMessage: string;
    headers: Headers;
    rawHeaders: RawHeaders;
    body: CompletedBody;
    rawTrailers: RawTrailers;
    trailers: Trailers;
    timingEvents: TimingEvents;
    tags: string[];
}

export interface WebSocketMessage {
    /**
     * The id of this websocket stream. This will match the id of the request,
     * the initial connection response, and any other WebSocket events for the
     * same connection stream.
     */
    streamId: string;

    /**
     * Whether the message was sent by Mockttp, or received from a Mockttp client.
     */
    direction: 'sent' | 'received';

    /**
     * The contents of the message as a raw buffer. This is already decompressed,
     * if the WebSocket uses compression.
     */
    content: Uint8Array;

    /**
     * Whether this is a string message or a raw binary data message.
     */
    isBinary: boolean;

    /**
     * A high-precision floating-point monotonically increasing timestamp.
     * Comparable and precise, but not related to specific current time.
     *
     * To link this to the current time, compare it to `timingEvents.startTime`.
     */
    eventTimestamp: number;

    timingEvents: TimingEvents;
    tags: string[];
}

export interface WebSocketClose {
    /**
     * The id of this websocket stream. This will match the id of the request,
     * the initial connection response, and any other WebSocket events for the
     * same connection stream.
     */
    streamId: string;

    /**
     * The close code of the shutdown. This is the close code that was received
     * from the remote client (either initiated remotely, or echoing our own sent
     * close frame).
     *
     * This may be undefined only if a close frame was received but did not contain
     * any close code. If no close frame was received before the connection was
     * lost (i.e. the connection was not cleanly closed) this event will not
     * fire at all, and an 'abort' event will fire instead.
     */
    closeCode: number | undefined;

    /**
     * The close reason of the shutdown.
     */
    closeReason: string;

    timingEvents: TimingEvents;
    tags: string[];
}

/**
 * A client error event describes a request (or our best guess at parsing it),
 * that wasn't correctly completed, and the error response it received, or
 * 'aborted' if the connection was disconnected before we could respond.
 */
export interface ClientError {
    errorCode?: string;
    request: {
        id: string;
        timingEvents: TimingEvents;
        tags: string[];

        // All of these are best guess, depending on what's parseable:
        protocol?: string;
        httpVersion?: string;
        method?: string;
        url?: string;
        path?: string;

        headers: Headers;
        rawHeaders: RawHeaders;

        remoteIpAddress?: string;
        remotePort?: number;
    };
    response: CompletedResponse | 'aborted';
}

/**
 * An event fired from an individual rule during request processing.
 */
export interface RuleEvent<T = unknown> {
    requestId: string;
    ruleId: string;
    eventType: string;
    eventData: T;
}

/**
 * A mocked endpoint provides methods to see the current state of
 * a mock rule.
 */
export interface MockedEndpoint {
    id: string;

    /**
     * Get the requests that this endpoint has seen so far.
     *
     * This method returns a promise, which resolves with the requests seen
     * up until now, once all ongoing requests have terminated. The returned
     * lists are immutable, so won't change if more requests arrive in future.
     * Call `getSeenRequests` again later to get an updated list.
     *
     * Requests are included here once the response is completed, even if the request
     * itself failed, the responses failed or exceptions are thrown elsewhere. To
     * watch for errors or detailed response info, look at the various server.on(event)
     * methods.
     */
    getSeenRequests(): Promise<CompletedRequest[]>;

    /**
     * Reports whether this endpoint is still pending: if it either hasn't seen the
     * specified number of requests (if one was specified e.g. with .twice())
     * or if it hasn't seen at least one request, by default.
     *
     * This method returns a promise, which resolves with the result once all
     * ongoing requests have terminated.
     */
    isPending(): Promise<boolean>;
}

export interface MockedEndpointData {
    id: string;
    explanation?: string;
    seenRequests: CompletedRequest[];
    isPending: boolean;
}

export interface Explainable {
    explain(): string;
}

export interface ProxyEnvConfig {
    HTTP_PROXY: string;
    HTTPS_PROXY: string;
}

// A slightly weird one: this is necessary because we export types that inherit from EventEmitter,
// so the docs include EventEmitter's methods, which @link to this type, that's otherwise not
// defined in this module. Reexporting the values avoids warnings for that.
export type defaultMaxListeners = typeof EventEmitter.defaultMaxListeners;
/**
 * @module Internal
 */

import stream = require('stream');
import http = require('http');
import { EventEmitter } from 'events';

export const DEFAULT_STANDALONE_PORT = 45454;

export enum Method {
    GET,
    POST,
    PUT,
    DELETE,
    PATCH,
    HEAD,
    OPTIONS
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

export interface Request {
    id: string;
    matchedRuleId?: string;

    protocol: string;
    httpVersion?: string; // Like timingEvents - not set remotely with older servers
    method: string;
    url: string;
    path: string;

    // Exists only if a host header is sent. A strong candidate for deprecation
    // in future, since it's not clear that this comes from headers not the URL, and
    // either way it duplicates existing data.
    hostname?: string;

    headers: Headers;

    timingEvents: TimingEvents | {};
    tags: string[];
}

export interface TlsRequest {
    hostname?: string;
    remoteIpAddress: string;
    remotePort: number;
    failureCause: 'closed' | 'reset' | 'cert-rejected' | 'no-shared-cipher' | 'unknown';
    tags: string[];
    timingEvents: TlsTimingEvents;
}

export interface TlsTimingEvents {
    startTime: number; // Ms since unix epoch

    // High-precision floating-point monotonically increasing timestamps.
    // Comparable and precise, but not related to specific current time.
    connectTimestamp: number; // When the socket initially connected
    failureTimestamp: number; // When the error occurred
    handshakeTimestamp?: number; // When the handshake completed (if it did)
    tunnelTimestamp?: number; // When the outer tunnel was create (if present)
}

// Internal representation of an ongoing HTTP request whilst it's being processed
export interface OngoingRequest extends Request, EventEmitter {
    body: ParsedBody;
    timingEvents: TimingEvents;
}

export interface ParsedBody {
    asStream: () => stream.Readable;
    asBuffer: () => Promise<Buffer>;
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
     * @deprecated Use `getDecodedBuffer()` instead with promises, to support
     * more encodings and improve performance.
     */
    decodedBuffer: Buffer | undefined;

    /**
     * The decoded bytes of the response. If no encoding was used, this is the
     * same as `.buffer`. The response is decoded and returned asynchronously
     * as a Promise.
     */
    getDecodedBuffer(): Promise<Buffer | undefined>;

    /**
     * @deprecated Use `getText()` instead with promises, to support
     * more encodings and improve performance.
     */
    text: string | undefined;

    /**
     * The contents of the response, decoded and parsed as a UTF-8 string.
     * The response is decoded and returned asynchronously as a Promise.
     */
    getText(): Promise<string | undefined>;

    /**
     * @deprecated Use `getJson()` instead with promises, to support
     * more encodings and improve performance.
     */
    json: object | undefined;

    /**
     * The contents of the response, decoded, parsed as UTF-8 string, and
     * then parsed a JSON. The response is decoded and returned asynchronously
     * as a Promise.
     */
    getJson(): Promise<object | undefined>;

    /**
     * @deprecated Use `getDecodedBuffer()` instead with promises, to support
     * more encodings and improve performance.
     */
    formData: { [key: string]: string | string[] | undefined } | undefined;

    /**
     * The contents of the response, decoded, parsed as UTF-8 string, and
     * then parsed form-encoded data. The response is decoded and returned
     * asynchronously as a Promise.
     */
    getFormData(): Promise<{ [key: string]: string | string[] | undefined } | undefined>;
}

// Internal & external representation of an initiated (no body yet received) HTTP request.
export interface InitiatedRequest extends Request {
    timingEvents: TimingEvents;
}

// Internal & external representation of a fully completed HTTP request
export interface CompletedRequest extends Request {
    body: CompletedBody;
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
    abortedTimestamp?: number; // When the request was aborted
}

export interface OngoingResponse extends http.ServerResponse {
    id: string;
    getHeaders(): Headers;
    body: ParsedBody;
    timingEvents: TimingEvents;
    tags: string[];
}

export interface CompletedResponse {
    id: string;
    statusCode: number;
    statusMessage: string;
    headers: Headers;
    body: CompletedBody;
    timingEvents: TimingEvents | {};
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
    };
    response: CompletedResponse | 'aborted';
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

export interface ProxyConfig {
    HTTP_PROXY: string;
    HTTPS_PROXY: string;
}
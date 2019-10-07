/**
 * @module Internal
 */

import stream = require('stream');
import express = require("express");
import { EventEmitter } from 'events';

export const DEFAULT_STANDALONE_PORT = 45456;

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

    // In general there may be 0+ of any header
    [key: string]: undefined | string | string[];
}

export interface RequestHeaders extends Headers {
    // An arbitrary set of headers that are known to
    // only ever appear once (for legal requests).
    host: string;
    cookie?: string;
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

    headers: RequestHeaders;

    timingEvents: TimingEvents | {};
    tags: string[];
}

export interface TlsRequest {
    hostname?: string;
    remoteIpAddress: string;
    failureCause: 'closed' | 'reset' | 'cert-rejected' | 'no-shared-cipher' | 'unknown';
    tags: string[];
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
    asFormData: () => Promise<{ [key: string]: string | string[] }>;
}

export interface CompletedBody {
    buffer: Buffer;
    decodedBuffer: Buffer | undefined;
    text: string | undefined;
    json: object | undefined;
    formData: { [key: string]: string | string[] } | undefined;
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

export interface OngoingResponse extends express.Response {
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
 * A mocked endpoint provides methods to see the current state of
 * a mock rule.
 */
export interface MockedEndpoint {
    id: string;
    /**
     * Get the requests that this endpoint has seen so far.
     *
     * This method returns a promise, which resolves with the requests seen
     * up until now. The returned lists are immutable, so won't change if more
     * requests rrive in future. Call `getSeenRequests` again later to get
     * an updated list.
     */
    getSeenRequests(): Promise<CompletedRequest[]>;
}

export interface MockedEndpointData {
    id: string;
    seenRequests: CompletedRequest[];
}

export interface Explainable {
    explain(): string;
}

export interface ProxyConfig {
    HTTP_PROXY: string;
    HTTPS_PROXY: string;
}
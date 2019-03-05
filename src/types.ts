/**
 * @module Internal
 */

import stream = require('stream');
import express = require("express");

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
    // only ever appear once (for legal requests).
    'content-encoding'?: string;

    // In general there may be 0+ of any header
    [key: string]: undefined | string | string[];
}

interface RequestHeaders extends Headers {
    // An arbitrary set of headers that are known to
    // only ever appear once (for legal requests).
    host: string;
    cookie?: string;
}

export interface Request {
    protocol: string;
    method: string;
    url: string;
    path: string;
    hostname: string;

    headers: RequestHeaders;
}

export interface OngoingRequest extends Request {
    id: string;
    originalUrl: string;

    body: ParsedBody;
}

export interface ParsedBody {
    rawStream: stream.Readable;

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

export interface CompletedRequest extends Request {
    id: string;
    body: CompletedBody;
}

export interface OngoingResponse extends express.Response {
    id: string;
    getHeaders(): Headers;
    body: ParsedBody;
}

export interface CompletedResponse {
    id: string;
    statusCode: number;
    statusMessage: string;
    headers: Headers;
    body: CompletedBody;
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
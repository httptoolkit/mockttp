import stream = require('stream');
import express = require("express");

export const DEFAULT_STANDALONE_PORT = 45456;

export enum Method {
    GET,
    POST,
    PUT,
    DELETE,
    PATCH,
    OPTIONS
}

export interface Request {
    protocol: string;
    method: string;
    url: string;
    path: string;
    hostname: string;

    headers: { [key: string]: string; };
}

export interface OngoingRequest extends Request {
    originalUrl: string;
    
    body: {
        rawStream: stream.Readable,

        asBuffer: () => Promise<Buffer>,
        asText: () => Promise<string>,
        asJson: () => Promise<object>,
        asFormData: () => Promise<{ [key: string]: string }>
    }
}

export interface CompletedRequest extends Request {
    body: {
        buffer: Buffer,
        text: string | undefined,
        json: object | undefined,
        formData: { [key: string]: string } | undefined
    }
}

export interface Response extends express.Response { }

// The external interface of a rule, for users to later verify with
export interface MockedEndpoint {
    id: string;
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
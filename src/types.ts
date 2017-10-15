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
    body: any;
}

export interface Response extends express.Response { }

// The external interface of a rule, for users to later verify with
export interface MockedEndpoint {
    id: string;
    getSeenRequests(): Promise<Request[]>;
}

export interface MockedEndpointData {
    id: string;
    seenRequests: Request[];
}

export interface Explainable {
    explain(): string;
}

export interface ProxyConfig {
    HTTP_PROXY: string;
    HTTPS_PROXY: string;
}
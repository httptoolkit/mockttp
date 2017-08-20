import express = require("express");

export enum Method {
    GET,
    POST,
    PUT
}

export interface Request extends express.Request {
    body: any; // Added by body-parser
    // TODO: Push https://github.com/types/npm-body-parser to DefinitelyTyped, to do this neater
}

export interface Explainable {
    explain(): string;
}

export interface ProxyConfig {
    HTTP_PROXY: string;
    HTTPS_PROXY: string;
}
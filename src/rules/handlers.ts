import _ = require('lodash');
import url = require('url');
import http = require('http');
import https = require('https');
import express = require("express");
import { OngoingRequest } from "../types";
import { RequestHandler } from "./mock-rule-types";

export type HandlerData = (
    SimpleHandlerData |
    PassThroughHandlerData
);

export type HandlerType = HandlerData['type'];

export type HandlerDataLookup = {
    'simple': SimpleHandlerData,
    'passthrough': PassThroughHandlerData
}

export class SimpleHandlerData {
    readonly type: 'simple' = 'simple';

    constructor(
        public status: number,
        public data?: string
    ) {}
}

export class PassThroughHandlerData {
    readonly type: 'passthrough' = 'passthrough';
}

type HandlerBuilder<D extends HandlerData> = (data: D) => RequestHandler;

export function buildHandler
    <T extends HandlerType, D extends HandlerDataLookup[T]>
    (handlerData: D): RequestHandler
{
    // Neither of these casts should really be required imo, seem like TS bugs
    const type = <T> handlerData.type;
    const builder = <HandlerBuilder<D>> handlerBuilders[type];
    return builder(handlerData);
}

const handlerBuilders: { [T in HandlerType]: HandlerBuilder<HandlerDataLookup[T]> } = {
    simple: ({ data, status }: SimpleHandlerData): RequestHandler => {
        let responder = _.assign(async function(request: OngoingRequest, response: express.Response) {
            response.writeHead(status);
            response.end(data || "");
        }, { explain: () => `respond with status ${status}` + (data ? ` and body "${data}"` : "") });
        return responder;
    },
    passthrough: (): RequestHandler => {
        let responder = _.assign(async function(request: OngoingRequest, response: express.Response) {
            let { protocol, method, hostname, path, headers } = request;
            
            if (!url.parse(request.url).host) {
                throw new Error(
`Cannot pass through request to ${request.url}, since it doesn't specify an upstream host.
To pass requests through, use the mock server as a proxy whilst making requests to the real target server.`);
            }
            
            let makeRequest = protocol === 'https' ? https.request : http.request;

            return new Promise<void>((resolve, reject) => {
                let req = makeRequest({
                    protocol: protocol + ':',
                    method,
                    hostname,
                    path,
                    headers
                }, (res) => {
                    res.pipe(response);
                    res.on('end', resolve);
                    res.on('error', reject);
                });
                
                request.body.rawStream.pipe(req);

                req.on('error', (e) => {
                    try {
                        response.writeHead(502);
                    } catch (e) {}
                    response.end(`Error connecting to upstream server: ${e}`);
                    reject(e);
                });
            });
        }, { explain: () => 'pass the request through to the real server' });
        return responder;
    }
};
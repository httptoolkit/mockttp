/**
 * @module MockRuleData
 */

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
        return _.assign(async function(clientReq: OngoingRequest, clientRes: express.Response) {
            const { method, originalUrl, headers } = clientReq;
            const { protocol, hostname, port, path } = url.parse(originalUrl);
            
            if (!hostname) {
                throw new Error(
`Cannot pass through request to ${clientReq.url}, since it doesn't specify an upstream host.
To pass requests through, use the mock server as a proxy whilst making requests to the real target server.`);
            }
            
            let makeRequest = protocol === 'https:' ? https.request : http.request;

            return new Promise<void>((resolve, reject) => {
                let serverReq = makeRequest({
                    protocol,
                    method,
                    hostname,
                    port,
                    path,
                    headers
                }, (serverRes) => {
                    Object.keys(serverRes.headers).forEach((header) => {
                        try {
                            clientRes.setHeader(header, serverRes.headers[header]!);
                        } catch (e) {
                            // A surprising number of real sites have slightly invalid headers (e.g. extra spaces)
                            // If we hit any, just drop that header and print a message.
                            console.log(`Error setting header on passthrough response: ${e.message}`);
                        }
                    });

                    clientRes.status(serverRes.statusCode!);
                    
                    serverRes.pipe(clientRes);
                    serverRes.on('end', resolve);
                    serverRes.on('error', reject);
                });
                
                clientReq.body.rawStream.pipe(serverReq);

                serverReq.on('error', (e: any) => {
                    e.statusCode = 502;
                    e.statusMessage = 'Error communicating with upstream server';
                    reject(e);
                });
            });
        }, { explain: () => 'pass the request through to the real server' });
    }
};
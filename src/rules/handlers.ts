/**
 * @module MockRuleData
 */

import _ = require('lodash');
import url = require('url');
import os = require('os');
import net = require('net');
import http = require('http');
import https = require('https');
import express = require("express");

import { waitForCompletedRequest } from '../util/request-utils';
import { CompletedRequest, OngoingRequest } from "../types";
import { RequestHandler } from "./mock-rule-types";
import { IncomingMessage } from 'http';

const IPv6_IPv4_PREFIX = '::ffff:';

export type HandlerData = (
    SimpleHandlerData |
    CallbackHandlerData |
    PassThroughHandlerData |
    CloseConnectionHandlerData |
    TimeoutHandlerData
);

export type HandlerType = HandlerData['type'];

export type HandlerDataLookup = {
    'simple': SimpleHandlerData,
    'callback': CallbackHandlerData,
    'passthrough': PassThroughHandlerData,
    'close-connection': CloseConnectionHandlerData,
    'timeout': TimeoutHandlerData
}

export class SimpleHandlerData {
    readonly type: 'simple' = 'simple';

    constructor(
        public status: number,
        public data?: string,
        public headers?: http.OutgoingHttpHeaders
    ) {}
}

export interface CallbackHandlerResult {
    status?: number;
    json?: any;
    body?: string;
    headers?: {
        [key: string]: string;
    };
}

export class CallbackHandlerData {
    readonly type: 'callback' = 'callback';

    constructor(
        public callback: (request: CompletedRequest) => CallbackHandlerResult
    ) {}
}

export class PassThroughHandlerData {
    readonly type: 'passthrough' = 'passthrough';
}

export class CloseConnectionHandlerData {
    readonly type: 'close-connection' = 'close-connection';
}

export class TimeoutHandlerData {
    readonly type: 'timeout' = 'timeout';
}

// Passthrough handlers need to spot loops - tracking ongoing request ports and the local machine's
// ip lets us get pretty close to doing that (for 1 step loops, at least):

// We don't think about interface address changes at all here. Very unlikely to be a problem, but
// we might want to listen for events/periodically update this list some time in future.
const localAddresses = _(os.networkInterfaces())
    .map((interfaceAddresses) => interfaceAddresses.map((addressDetails) => addressDetails.address))
    .flatten()
    .valueOf();

// Track currently live ports for forwarded connections, so we can spot requests from them later.
let currentlyForwardingPorts: Array<number> = [];

const isRequestLoop = (remoteAddress: string, remotePort: number) =>
    // If the request is local, and from a port we're sending a request on right now, we have a loop
    _.includes(localAddresses, remoteAddress) && _.includes(currentlyForwardingPorts, remotePort)

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
    simple: ({ data, status, headers }: SimpleHandlerData): RequestHandler => {
        let responder = _.assign(async function(request: OngoingRequest, response: express.Response) {
            response.writeHead(status, headers);
            response.end(data || "");
        }, { explain: () => `respond with status ${status}` + (headers ? `, headers ${JSON.stringify(headers)}` : "") + (data ? ` and body "${data}"` : "") });
        return responder;
    },
    callback: ({ callback }: CallbackHandlerData): RequestHandler => {
        let responder = _.assign(async function(request: OngoingRequest, response: express.Response) {
            let req = await waitForCompletedRequest(request);

            let outResponse: CallbackHandlerResult;
            try {
                outResponse = await callback(req);
            } catch (error) {
                response.writeHead(500, 'Callback handler threw an exception');
                response.end(error.toString());
                return;
            }

            if (outResponse.json !== undefined) {
                outResponse.headers = _.assign(outResponse.headers || {}, { 'Content-Type': 'application/json' });
                outResponse.body = JSON.stringify(outResponse.json);
                delete outResponse.json;
            }

            const defaultResponse = {
                status: 200,
                ...outResponse
            };
            response.writeHead(defaultResponse.status, defaultResponse.headers);
            response.end(defaultResponse.body || "");
        }, { explain: () => 'respond using provided callback' + (callback.name ? ` (${callback.name})` : '') });
        return responder;
    },
    passthrough: (): RequestHandler => {
        return _.assign(async function(clientReq: OngoingRequest, clientRes: express.Response) {
            const { method, originalUrl, headers } = clientReq;
            let { protocol, hostname, port, path } = url.parse(originalUrl);

            const socket: net.Socket = (<any> clientReq).socket;
            // If it's ipv4 masquerading as v6, strip back to ipv4
            const remoteAddress = socket.remoteAddress.replace(/^::ffff:/, '');

            if (isRequestLoop(remoteAddress, socket.remotePort)) {
                throw new Error(
`Passthrough loop detected. This probably means you're sending a request directly to a passthrough endpoint, \
which is forwarding it to the target URL, which is a passthrough endpoint, which is forwarding it to the target \
URL, which is a passthrough endpoint...

You should either explicitly mock a response for this URL (${originalUrl}), or use the server as a proxy, \
instead of making requests to it directly`);
            }

            const hostHeader = headers.host;

            if (!hostname) {
                [ hostname, port ] = hostHeader.split(':');
                protocol = clientReq.protocol + ':';
            }

            let makeRequest = protocol === 'https:' ? https.request : http.request;

            let outgoingPort: null | number = null;
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

                serverReq.on('socket', (socket: net.Socket) => {
                    // We want the local port - it's not available until we actually connect
                    socket.on('connect', () => {
                        // Add this port to our list of active ports
                        outgoingPort = socket.localPort;
                        currentlyForwardingPorts.push(outgoingPort);
                    });
                    socket.on('close', () => {
                        // Remove this port from our list of active ports
                        currentlyForwardingPorts = currentlyForwardingPorts.filter(
                            (port) => port !== outgoingPort
                        );
                        outgoingPort = null;
                    });
                });

                clientReq.body.rawStream.pipe(serverReq);

                serverReq.on('error', (e: any) => {
                    e.statusCode = 502;
                    e.statusMessage = 'Error communicating with upstream server';
                    reject(e);
                });
            });
        }, { explain: () => 'pass the request through to the real server' });
    },
    'close-connection': (): RequestHandler => {
        let responder = _.assign(async function(request: OngoingRequest, response: express.Response) {
            const socket: net.Socket = (<any> request).socket;
            socket.end();
        }, { explain: () => 'close the connection' });
        return responder;
    },
    'timeout': (): RequestHandler => {
        let responder = _.assign(async function(request: OngoingRequest, response: express.Response) {
            // Do nothing, leaving the socket open, but never sending a response.
            return;
        }, { explain: () => 'timeout (never respond)' });
        return responder;
    }
};
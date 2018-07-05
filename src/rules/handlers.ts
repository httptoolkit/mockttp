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
import uuid = require('uuid/v4');

import { IncomingMessage } from 'http';

import { waitForCompletedRequest } from '../util/request-utils';
import { Serializable, SerializationOptions } from "../util/serialization";

import { CompletedRequest, OngoingRequest } from "../types";
import { RequestHandler } from "./mock-rule-types";

export type SerializedBuffer = { type: 'Buffer', data: number[] };

function isSerializedBuffer(obj: any): obj is SerializedBuffer {
    return obj && obj.type === 'Buffer';
}

export class SimpleHandlerData extends Serializable {
    readonly type: 'simple' = 'simple';

    constructor(
        public status: number,
        public data?: string | Buffer | SerializedBuffer,
        public headers?: http.OutgoingHttpHeaders
    ) {
        super();
    }

    buildHandler() {
        return _.assign(async (request: OngoingRequest, response: express.Response) => {
            response.writeHead(this.status, this.headers);
            
            if (isSerializedBuffer(this.data)) {
                this.data = new Buffer(<any> this.data);
            }

            response.end(this.data || "");
        }, { explain: () =>
            `respond with status ${this.status}` +
            (this.headers ? `, headers ${JSON.stringify(this.headers)}` : "") + 
            (this.data ? ` and body "${this.data}"` : "")
        });
    }
}

export interface CallbackHandlerResult {
    status?: number;
    json?: any;
    body?: string;
    headers?: {
        [key: string]: string;
    };
}

export interface SerializedCallbackHandlerData {
    type: string;
    topicId: string
};

interface StreamMessage {
    topicId: string;
    requestId: string;
}

interface CallbackRequestMessage extends StreamMessage {
    args: [CompletedRequest];
}

interface CallbackResponseMessage extends StreamMessage {
    error?: Error;
    result?: CallbackHandlerResult;
}

export class CallbackHandlerData extends Serializable {
    readonly type: 'callback' = 'callback';

    constructor(
        public callback: (request: CompletedRequest) => CallbackHandlerResult | Promise<CallbackHandlerResult>
    ) {
        super();
    }

    serialize(options?: SerializationOptions): SerializedCallbackHandlerData {
        if (!options || !options.clientStream) {
            throw new Error('Callback handler transfer requires a streaming client connection.');
        }

        const { clientStream } = options;

        // The topic id is used to identify the client-side source rule, so when a message comes
        // across we know which callback needs to be run.
        const topicId = uuid();

        // When we receive a request from the server: check it's us, call the callback, stream back the result.
        clientStream.on('data', async (streamMsg) => {
            let serverRequest: CallbackRequestMessage = JSON.parse(streamMsg.toString());
            let { requestId, topicId: requestTopicId } = serverRequest;

            // This message isn't meant for us.
            if (topicId !== requestTopicId) return;

            try {
                let result: CallbackHandlerResult = await this.callback.apply(null, serverRequest.args);

                clientStream.write(JSON.stringify(<CallbackResponseMessage> {
                    topicId,
                    requestId,
                    result
                }));
            } catch (error) {
                clientStream.write(JSON.stringify(<CallbackResponseMessage> {
                    topicId,
                    requestId,
                    error
                }));
            }
        });

        return { type: this.type, topicId };
    }

    static deserialize({ topicId }: SerializedCallbackHandlerData, options?: SerializationOptions): CallbackHandlerData {
        if (!options || !options.clientStream) {
            throw new Error('Callback handler transfer requires a streaming client connection.');
        }

        const { clientStream } = options;

        let outstandingRequests: { [id: string]: (error?: Error, result?: CallbackHandlerResult) => void } = {};

        const responseListener = (streamMsg: string | Buffer) => {            
            let clientResponse: CallbackResponseMessage = JSON.parse(streamMsg.toString());
            let { requestId } = clientResponse;

            if (outstandingRequests[requestId]) {
                outstandingRequests[requestId](clientResponse.error, clientResponse.result);
                clientStream.removeListener('data', responseListener);
            }
        };

        // Listen to the client for responses to our callbacks
        clientStream.on('data', responseListener);

        // Call the client's callback (via stream), and save a handler on our end for
        // the response that comes back.
        return new CallbackHandlerData((request) => {
            return new Promise((resolve, reject) => {
                let requestId = uuid();
                outstandingRequests[requestId] = (error?: Error, result?: CallbackHandlerResult) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve(result);
                    }
                    delete outstandingRequests[requestId];
                };

                clientStream.write(JSON.stringify(<CallbackRequestMessage> {
                    topicId,
                    requestId,
                    args: [request]
                }));
            });
        });
    }

    buildHandler() {
        return _.assign(async (request: OngoingRequest, response: express.Response) => {
            let req = await waitForCompletedRequest(request);

            let outResponse: CallbackHandlerResult;
            try {
                outResponse = await this.callback(req);
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
        }, { explain: () => 
            'respond using provided callback' +
            (this.callback.name ? ` (${this.callback.name})` : '')
        });
    }
}

export class PassThroughHandlerData extends Serializable {
    readonly type: 'passthrough' = 'passthrough';

    buildHandler() {
        return _.assign(async (clientReq: OngoingRequest, clientRes: express.Response) => {
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
    }
}

export class CloseConnectionHandlerData extends Serializable {
    readonly type: 'close-connection' = 'close-connection';

    buildHandler() {
        return _.assign(async function(request: OngoingRequest, response: express.Response) {
            const socket: net.Socket = (<any> request).socket;
            socket.end();
        }, { explain: () => 'close the connection' });
    }
}

export class TimeoutHandlerData extends Serializable {
    readonly type: 'timeout' = 'timeout';

    buildHandler() {
        return _.assign(async function(request: OngoingRequest, response: express.Response) {
            // Do nothing, leaving the socket open, but never sending a response.
            return;
        }, { explain: () => 'timeout (never respond)' });
    }
}

export type HandlerData = (
    SimpleHandlerData |
    CallbackHandlerData |
    PassThroughHandlerData |
    CloseConnectionHandlerData |
    TimeoutHandlerData
);

export const HandlerDataLookup = {
    'simple': SimpleHandlerData,
    'callback': CallbackHandlerData,
    'passthrough': PassThroughHandlerData,
    'close-connection': CloseConnectionHandlerData,
    'timeout': TimeoutHandlerData
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

export function buildHandler(handlerData: HandlerData): RequestHandler {
    return handlerData.buildHandler();
}
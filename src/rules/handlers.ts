/**
 * @module MockRule
 */

import _ = require('lodash');
import url = require('url');
import net = require('net');
import http = require('http');
import https = require('https');
import express = require("express");
import { encode as encodeBase64, decode as decodeBase64 } from 'base64-arraybuffer';
import { Readable, Transform } from 'stream';
import { stripIndent, oneLine } from 'common-tags';

import {
    waitForCompletedRequest,
    setHeaders,
    buildBodyReader,
    streamToBuffer
} from '../server/request-utils';
import { isLocalPortActive, localAddresses } from '../util/socket-util';
import {
    Serializable,
    ClientServerChannel,
    withSerializedBody,
    withDeserializedBody
} from "../util/serialization";
import { MaybePromise, Replace } from '../util/type-utils';

import {
    Headers,
    RequestHeaders,
    OngoingRequest,
    CompletedRequest,
    OngoingResponse,
    CompletedBody
} from "../types";
import { RequestHandler } from "./mock-rule-types";

export type SerializedBuffer = { type: 'Buffer', data: number[] };

export interface CallbackRequestResult {
    method?: string;
    url?: string;
    headers?: RequestHeaders;

    json?: any;
    body?: string | Buffer;
}

export interface CallbackResponseResult {
    status?: number;
    headers?: Headers;

    json?: any;
    body?: string | Buffer;
}

function isSerializedBuffer(obj: any): obj is SerializedBuffer {
    return obj && obj.type === 'Buffer' && !!obj.data;
}

abstract class SerializableRequestHandler extends Serializable implements RequestHandler {
    abstract handle(request: OngoingRequest, response: OngoingResponse): Promise<void>;
    abstract explain(): string;
}

export class SimpleHandler extends SerializableRequestHandler {
    readonly type: 'simple' = 'simple';

    constructor(
        public status: number,
        public data?: string | Buffer | SerializedBuffer,
        public headers?: Headers
    ) {
        super();
    }

    explain() {
        return `respond with status ${this.status}` +
            (this.headers ? `, headers ${JSON.stringify(this.headers)}` : "") +
            (this.data ? ` and body "${this.data}"` : "");
    }

    async handle(_request: OngoingRequest, response: OngoingResponse) {
        if (this.headers) {
            setHeaders(response, this.headers);
        }
        response.writeHead(this.status);

        if (isSerializedBuffer(this.data)) {
            this.data = new Buffer(<any> this.data);
        }

        response.end(this.data || "");
    }
}

export interface SerializedCallbackHandlerData {
    type: string;
    name?: string;
}

interface CallbackRequestMessage {
    args: [CompletedRequest];
}

export class CallbackHandler extends SerializableRequestHandler {
    readonly type: 'callback' = 'callback';

    constructor(
        public callback: (request: CompletedRequest) => MaybePromise<CallbackResponseResult>
    ) {
        super();
    }

    explain() {
        return 'respond using provided callback' + (this.callback.name ? ` (${this.callback.name})` : '');
    }

    async handle(request: OngoingRequest, response: express.Response) {
        let req = await waitForCompletedRequest(request);

        let outResponse: CallbackResponseResult;
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

        if (outResponse.headers) {
            setHeaders(response, outResponse.headers);
        }

        response.writeHead(outResponse.status || 200);
        response.end(outResponse.body || "");
    }

    serialize(channel: ClientServerChannel): SerializedCallbackHandlerData {
        channel.onRequest<
            CallbackRequestMessage,
            CallbackResponseResult
        >((streamMsg) => {
            return this.callback.apply(null, streamMsg.args);
        });

        return { type: this.type, name: this.callback.name };
    }

    static deserialize({ name }: SerializedCallbackHandlerData, channel: ClientServerChannel): CallbackHandler {
        const rpcCallback = async (request: CompletedRequest) => {
            return await channel.request<
                CallbackRequestMessage,
                CallbackResponseResult
            >({ args: [request] });
        };
        // Pass across the name from the real callback, for explain()
        Object.defineProperty(rpcCallback, "name", { value: name });

        // Call the client's callback (via stream), and save a handler on our end for
        // the response that comes back.
        return new CallbackHandler(rpcCallback);
    }
}

export interface SerializedStreamHandlerData {
    type: string;
    status: number;
    headers?: Headers;
};

interface StreamHandlerMessage {
    event: 'data' | 'end' | 'close' | 'error';
    content: StreamHandlerEventMessage;
}

type StreamHandlerEventMessage =
    { type: 'string', value: string } |
    { type: 'buffer', value: string } |
    { type: 'arraybuffer', value: string } |
    { type: 'nil' };

export class StreamHandler extends SerializableRequestHandler {
    readonly type: 'stream' = 'stream';

    constructor(
        public status: number,
        public stream: Readable & { done?: true },
        public headers?: Headers
    ) {
        super();
    }

    explain() {
        return `respond with status ${this.status}` +
            (this.headers ? `, headers ${JSON.stringify(this.headers)},` : "") +
            ' and a stream of response data';
    }

    async handle(_request: OngoingRequest, response: express.Response) {
        if (!this.stream.done) {
            if (this.headers) {
                setHeaders(response, this.headers);
            }

            response.writeHead(this.status);
            this.stream.pipe(response);
            this.stream.done = true;
        } else {
            throw new Error(stripIndent`
                Stream request handler called more than once - this is not supported.

                Streams can typically only be read once, so all subsequent requests would be empty.
                To mock repeated stream requests, call 'thenStream' repeatedly with multiple streams.

                (Have a better way to handle this? Open an issue at ${require('../../package.json').bugs.url})
            `);
        }
    }

    serialize(channel: ClientServerChannel): SerializedStreamHandlerData {
        const serializationStream = new Transform({
            objectMode: true,
            transform: function (this: Transform, chunk, _encoding, callback) {
                let serializedEventData: StreamHandlerEventMessage | false =
                    _.isString(chunk) ? { type: 'string', value: chunk } :
                    _.isBuffer(chunk) ? { type: 'buffer', value: chunk.toString('base64') } :
                    (_.isArrayBuffer(chunk) || _.isTypedArray(chunk)) ? { type: 'arraybuffer', value: encodeBase64(<any> chunk) } :
                    _.isNil(chunk) && { type: 'nil' };

                if (!serializedEventData) {
                    callback(new Error(`Can't serialize streamed value: ${chunk.toString()}. Streaming must output strings, buffers or array buffers`));
                }

                callback(undefined, <StreamHandlerMessage> {
                    event: 'data',
                    content: serializedEventData
                });
            },

            flush: function(this: Transform, callback) {
                this.push(<StreamHandlerMessage> {
                    event: 'end'
                });
                callback();
            }
        });

        // When we get a ping from the server-side, pipe the real stream to serialize it and send the data across
        channel.once('data', () => {
            this.stream.pipe(serializationStream).pipe(channel, { end: false });
        });

        return { type: this.type, status: this.status, headers: this.headers };
    }

    static deserialize(handlerData: SerializedStreamHandlerData, channel: ClientServerChannel): StreamHandler {
        const handlerStream = new Transform({
            objectMode: true,
            transform: function (this: Transform, message, encoding, callback) {
                const { event, content } = message;

                let deserializedEventData = content && (
                    content.type === 'string' ? content.value :
                    content.type === 'buffer' ? Buffer.from(content.value, 'base64') :
                    content.type === 'arraybuffer' ? Buffer.from(decodeBase64(content.value)) :
                    content.type === 'nil' && undefined
                );

                if (event === 'data' && deserializedEventData) {
                    this.push(deserializedEventData);
                } else if (event === 'end') {
                    this.end();
                }

                callback();
            }
        });

        // When we get piped (i.e. to a live request), ping upstream to start streaming, and then
        // pipe the resulting data into our live stream (which is streamed to the request, like normal)
        handlerStream.once('resume', () => {
            channel.pipe(handlerStream);
            channel.write({});
        });

        return new StreamHandler(
            handlerData.status,
            handlerStream,
            handlerData.headers
        );
    }
}

interface PassThroughResponse {
    id: string;
    status: number;
    headers: Headers;
    body: CompletedBody;
}

export interface PassThroughHandlerOptions {
    ignoreHostCertificateErrors?: string[];
    beforeRequest?: (req: CompletedRequest) => MaybePromise<CallbackRequestResult>;
    beforeResponse?: (res: PassThroughResponse) => MaybePromise<CallbackResponseResult>;
}

interface SerializedPassThroughData {
    type: 'passthrough';
    forwardToLocation?: string;
    ignoreHostCertificateErrors?: string[];

    hasBeforeRequestCallback?: boolean;
    hasBeforeResponseCallback?: boolean;
}

interface BeforePassthroughRequestRequest {
    args: [Replace<CompletedRequest, 'body', string>];
}

interface BeforePassthroughResponseRequest {
    args: [Replace<PassThroughResponse, 'body', string>];
}

// Used to drop `undefined` headers, which cause problems
function dropUndefinedValues<D extends {}>(obj: D): D {
    return _.omitBy(obj, (v) => v === undefined) as D;
}

// Callback result bodies can take a few formats: tidy them up a little
function getCallbackResultBody(
    replacementBody: string | Buffer | CompletedBody | undefined
): string | Buffer | undefined {
    if (replacementBody === undefined) {
        return replacementBody;
    } else if (replacementBody.hasOwnProperty('decodedBuffer')) {
        // It's our own bodyReader instance. That's not supposed to happen, but
        // it's ok, we just need to use its buffer insteead of the whole object
        return (replacementBody as CompletedBody).buffer;
    } else if (replacementBody === '') {
        // For empty bodies, it's slightly more convenient if they're truthy
        return Buffer.alloc(0);
    } else {
        return replacementBody as string | Buffer;
    }
}

// Helper to autocorrect the host header, but only if you didn't explicitly
// override it yourself for some reason (e.g. testing bad behaviour).
function getCorrectHost(
    reqUrl: string,
    originalHeaders: Headers,
    replacementHeaders: Headers | undefined
): string {
    const correctHost = url.parse(reqUrl).host!;
    const replacementHost = !!replacementHeaders ? replacementHeaders['host'] : undefined;

    if (replacementHost !== undefined) {
        if (replacementHost !== correctHost && replacementHost === originalHeaders['host']) {
            // If you rewrite the host header wrongly, by explicitly setting it to the
            // existing value, we accept it, but print a warning. This would be easy to
            // do if you mutate the existing headers, for example, but not the host.
            console.warn(oneLine`
                Passthrough callback overrode the URL and the Host header
                with mismatched values, which may be a mistake. The URL is
                ${reqUrl} bytes, whilst the header was set to ${replacementHost}.
            `);
        }
        // Whatever happens, if you explicitly set a value, we use it.
        return replacementHost;
    }

    // If you didn't override the host at all, then we automatically ensure
    // the correct header is set automatically.
    return correctHost;
}

// Helper to handle content-length nicely for you when rewriting requests with callbacks
function getCorrectContentLength(
    body: string | Buffer,
    originalHeaders: Headers,
    replacementHeaders: Headers | undefined
): string | undefined {
    // If there was a content-length header, it might now be wrong, and it's annoying
    // to need to set your own content-length override when you just want to change
    // the body. To help out, if you override the body but don't explicitly override
    // the (now invalid) content-length, then we fix it for you.

    if (!_.has(originalHeaders, 'content-length')) {
        // Nothing to override - use the replacement value, or undefined
        return (replacementHeaders || {})['content-length'];
    }

    if (!replacementHeaders) {
        // There was a length set, and you've provided a body but not changed it.
        // You probably just want to send this body and have it work correctly,
        // so we should fix the content length for you automatically.
        return body.length.toString();
    }

    // There was a content length before, and you're replacing the headers entirely
    const lengthOverride = replacementHeaders['content-length'] === undefined
        ? undefined
        : replacementHeaders['content-length'].toString();

    // If you're setting the content-length to the same as the origin headers, even
    // though that's the wrong value, it *might* be that you're just extending the
    // existing headers, and you're doing this by accident (we can't tell for sure).
    // We use invalid content-length as instructed, but print a warning just in case.
    if (
        lengthOverride === originalHeaders['content-length'] &&
        lengthOverride !== body.length.toString()
    ) {
        console.warn(oneLine`
            Passthrough callback overrode the body and the content-length header
            with mismatched values, which may be a mistake. The body contains
            ${body.length} bytes, whilst the header was set to ${lengthOverride}.
        `);
    }

    return lengthOverride;
}

export class PassThroughHandler extends SerializableRequestHandler {
    readonly type: 'passthrough' = 'passthrough';

    private forwardToLocation?: string;
    private ignoreHostCertificateErrors: string[] = [];

    private beforeRequest?: (req: CompletedRequest) => MaybePromise<CallbackRequestResult>;
    private beforeResponse?: (res: PassThroughResponse) => MaybePromise<CallbackResponseResult>;

    constructor(options: PassThroughHandlerOptions = {}, forwardToLocation?: string) {
        super();

        this.forwardToLocation = forwardToLocation;
        this.ignoreHostCertificateErrors = options.ignoreHostCertificateErrors || [];

        this.beforeRequest = options.beforeRequest;
        this.beforeResponse = options.beforeResponse;
    }

    explain() {
        return this.forwardToLocation
            ? `forward the request to ${this.forwardToLocation}`
            : 'pass the request through to the target host';
    }

    async handle(clientReq: OngoingRequest, clientRes: express.Response) {
        // Capture raw request data:
        let { method, url: reqUrl, headers } = clientReq;
        let { protocol, hostname, port, path } = url.parse(reqUrl);

        if (this.forwardToLocation) {
            // Forward to location overrides the host only, not the path
            ({ protocol, hostname, port } = url.parse(this.forwardToLocation));
            headers['host'] = `${hostname}:${port}`;
        }

        // Check if this request is a request loop:
        const socket: net.Socket = (<any> clientReq).socket;
        // If it's ipv4 masquerading as v6, strip back to ipv4
        const remoteAddress = socket.remoteAddress!.replace(/^::ffff:/, '');
        const remotePort = port ? Number.parseInt(port) : socket.remotePort;

        if (isRequestLoop(remoteAddress, remotePort!)) {
            throw new Error(oneLine`
                Passthrough loop detected. This probably means you're sending a request directly
                to a passthrough endpoint, which is forwarding it to the target URL, which is a
                passthrough endpoint, which is forwarding it to the target URL, which is a
                passthrough endpoint...` +
                '\n\n' + oneLine`
                You should either explicitly mock a response for this URL (${reqUrl}), or use
                the server as a proxy, instead of making requests to it directly.
            `);
        }

        // Make sure the URL is absolute, if we're transparent proxying, or redirecting/proxying
        // to URLs on this mock server (instead of externally).
        if (!hostname) {
            const hostHeader = headers.host;
            [ hostname, port ] = hostHeader.split(':');
            protocol = clientReq.protocol + ':';
        }

        // Override the request details, if a callback is specified:
        let reqBodyOverride: string | Buffer | undefined;
        if (this.beforeRequest) {
            const modifiedReq = await this.beforeRequest(
                await waitForCompletedRequest(Object.assign({}, clientReq, {
                    url: new url.URL(reqUrl, `${protocol}//${hostname}${port ? `:${port}` : ''}`).toString()
                }))
            );

            method = modifiedReq.method || method;
            reqUrl = modifiedReq.url || reqUrl;
            headers = modifiedReq.headers || headers;

            headers['host'] = getCorrectHost(reqUrl, clientReq.headers, modifiedReq.headers);

            if (modifiedReq.json) {
                headers['content-type'] = 'application/json';
                reqBodyOverride = JSON.stringify(modifiedReq.json);
            } else {
                reqBodyOverride = getCallbackResultBody(modifiedReq.body);
            }

            if (reqBodyOverride !== undefined) {
                headers['content-length'] = getCorrectContentLength(
                    reqBodyOverride,
                    clientReq.headers,
                    modifiedReq.headers
                );
            }
            headers = dropUndefinedValues(headers);

            // Reparse the new URL, if necessary
            if (modifiedReq.url) {
                ({ protocol, hostname, port, path } = url.parse(reqUrl));
            }
        }

        const checkServerCertificate = !_.includes(this.ignoreHostCertificateErrors, hostname);

        let makeRequest = protocol === 'https:' ? https.request : http.request;

        let family: undefined | 4 | 6;
        if (hostname === 'localhost') {
            // Annoying special case: some localhost servers listen only on either ipv4 or ipv6.
            // Very specific situation, but a very common one for development use.
            // We need to work out which one family is, as Node sometimes makes bad choices.
            const portToTest = !!port
                ? parseInt(port, 10)
                : (protocol === 'https:' ? 443 : 80);

            if (await isLocalPortActive('::1', portToTest)) family = 6;
            else family = 4;
        }

        let outgoingPort: null | number = null;
        return new Promise<void>((resolve, reject) => {
            let serverReq = makeRequest({
                protocol,
                method,
                hostname,
                port,
                family,
                path,
                headers,
                rejectUnauthorized: checkServerCertificate
            }, async (serverRes) => {
                serverRes.once('error', reject);

                let serverStatus = serverRes.statusCode!;
                let serverHeaders = serverRes.headers;
                let resBodyOverride: string | Buffer | undefined;

                if (this.beforeResponse) {
                    const body = await streamToBuffer(serverRes);
                    const modifiedRes = await this.beforeResponse({
                        id: clientReq.id,
                        status: serverStatus,
                        headers: serverHeaders,
                        body: buildBodyReader(body, serverHeaders)
                    });

                    serverStatus = modifiedRes.status || serverStatus;
                    serverHeaders = modifiedRes.headers || serverHeaders;

                    if (modifiedRes.json) {
                        serverHeaders['content-type'] = 'application/json';
                        resBodyOverride = JSON.stringify(modifiedRes.json);
                    } else {
                        resBodyOverride = getCallbackResultBody(modifiedRes.body);
                    }

                    if (resBodyOverride !== undefined) {
                        serverHeaders['content-length'] = getCorrectContentLength(
                            resBodyOverride,
                            serverRes.headers,
                            modifiedRes.headers
                        );
                    }

                    serverHeaders = dropUndefinedValues(serverHeaders);
                }

                Object.keys(serverHeaders).forEach((header) => {
                    const headerValue = serverHeaders[header];
                    if (headerValue === undefined) return;

                    try {
                        clientRes.setHeader(header, headerValue);
                    } catch (e) {
                        // A surprising number of real sites have slightly invalid headers
                        // (e.g. extra spaces). If we hit any, we just drop that header
                        // and print a warning.
                        console.log(`Error setting header on passthrough response: ${e.message}`);
                    }
                });

                clientRes.status(serverStatus);

                if (resBodyOverride) {
                    clientRes.end(resBodyOverride);
                    resolve();
                } else {
                    serverRes.pipe(clientRes);
                    serverRes.once('end', resolve);
                }
            });

            serverReq.once('socket', (socket: net.Socket) => {
                // We want the local port - it's not available until we actually connect
                socket.once('connect', () => {
                    // Add this port to our list of active ports
                    outgoingPort = socket.localPort;
                    currentlyForwardingPorts.push(outgoingPort);
                });
                socket.once('close', () => {
                    // Remove this port from our list of active ports
                    currentlyForwardingPorts = currentlyForwardingPorts.filter(
                        (port) => port !== outgoingPort
                    );
                    outgoingPort = null;
                });
            });

            if (reqBodyOverride) {
                serverReq.end(reqBodyOverride);
            } else {
                // asStream includes all content, including the body before this call
                const reqBodyStream = clientReq.body.asStream();
                reqBodyStream.pipe(serverReq);
                reqBodyStream.once('error', () => serverReq.abort());
            }

            clientReq.once('abort', () => serverReq.abort());
            clientRes.once('close', () => serverReq.abort());

            serverReq.once('error', (e: any) => {
                if ((<any>serverReq).aborted) return;

                e.statusCode = 502;
                e.statusMessage = 'Error communicating with upstream server';
                reject(e);
            });
        });
    }

    serialize(channel: ClientServerChannel): SerializedPassThroughData {
        if (this.beforeRequest) {
            channel.onRequest<
                BeforePassthroughRequestRequest,
                CallbackRequestResult
            >('beforeRequest', (req) => {
                return this.beforeRequest!(withDeserializedBody(req.args[0]));
            });
        }

        if (this.beforeResponse) {
            channel.onRequest<
                BeforePassthroughResponseRequest,
                CallbackResponseResult
            >('beforeResponse', (req) => {
                return this.beforeResponse!(withDeserializedBody(req.args[0]));
            });
        }

        return {
            type: this.type,
            forwardToLocation: this.forwardToLocation,
            hasBeforeRequestCallback: !!this.beforeRequest,
            hasBeforeResponseCallback: !!this.beforeResponse
        };
    }

    static deserialize(data: SerializedPassThroughData, channel: ClientServerChannel): PassThroughHandler {
        let beforeRequest: ((req: CompletedRequest) => MaybePromise<CallbackRequestResult>) | undefined;
        let beforeResponse: ((res: PassThroughResponse) => MaybePromise<CallbackResponseResult>) | undefined;

        if (data.hasBeforeRequestCallback) {
            beforeRequest = (req: CompletedRequest) => {
                return channel.request<
                    BeforePassthroughRequestRequest,
                    CallbackRequestResult
                >('beforeRequest', {
                    args: [withSerializedBody(req)]
                });
            };
        }

        if (data.hasBeforeResponseCallback) {
            beforeResponse = (res: PassThroughResponse) => {
                return channel.request<
                    BeforePassthroughResponseRequest,
                    CallbackResponseResult
                >('beforeResponse', {
                    args: [withSerializedBody(res)]
                });
            };
        }

        return new PassThroughHandler({
            beforeRequest,
            beforeResponse,
            ignoreHostCertificateErrors: data.ignoreHostCertificateErrors
        }, data.forwardToLocation);
    }
}

export class CloseConnectionHandler extends SerializableRequestHandler {
    readonly type: 'close-connection' = 'close-connection';

    explain() {
        return 'close the connection';
    }

    async handle(request: OngoingRequest) {
        const socket: net.Socket = (<any> request).socket;
        socket.end();
    }
}

export class TimeoutHandler extends SerializableRequestHandler {
    readonly type: 'timeout' = 'timeout';

    explain() {
        return 'timeout (never respond)';
    }

    async handle() {
        // Do nothing, leaving the socket open, but never sending a response.
        return;
    }
}

export const HandlerLookup = {
    'simple': SimpleHandler,
    'callback': CallbackHandler,
    'stream': StreamHandler,
    'passthrough': PassThroughHandler,
    'close-connection': CloseConnectionHandler,
    'timeout': TimeoutHandler
}

// Passthrough handlers need to spot loops - tracking ongoing request ports and the local machine's
// ip lets us get pretty close to doing that (for 1 step loops, at least):

// Track currently live ports for forwarded connections, so we can spot requests from them later.
let currentlyForwardingPorts: Array<number> = [];

const isRequestLoop = (remoteAddress: string, remotePort: number) =>
    // If the request is local, and from a port we're sending a request on right now, we have a loop
    _.includes(localAddresses, remoteAddress) && _.includes(currentlyForwardingPorts, remotePort)
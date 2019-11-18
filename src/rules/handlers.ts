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
import { TypedError } from 'typed-error';

import {
    waitForCompletedRequest,
    setHeaders,
    buildBodyReader,
    streamToBuffer,
    shouldKeepAlive
} from '../util/request-utils';
import { isLocalPortActive } from '../util/socket-util';
import {
    Serializable,
    ClientServerChannel,
    withSerializedBodyReader,
    withDeserializedBodyReader,
    withSerializedBodyBuffer,
    withDeserializedBodyBuffer,
    WithSerializedBodyBuffer,
    serializeBuffer,
    deserializeBuffer
} from "../util/serialization";
import { MaybePromise, Replace } from '../util/type-utils';
import { readFile } from '../util/fs';

import {
    Headers,
    RequestHeaders,
    OngoingRequest,
    CompletedRequest,
    OngoingResponse,
    CompletedBody,
    Explainable
} from "../types";

// An error that indicates that the handler is aborting the request.
// This could be intentional, or an upstream server aborting the request.
export class AbortError extends TypedError { }

export type SerializedBuffer = { type: 'Buffer', data: number[] };

export interface CallbackRequestResult {
    method?: string;
    url?: string;
    headers?: RequestHeaders;

    json?: any;
    body?: string | Buffer;

    response?: CallbackResponseResult;
}

export interface CallbackResponseResult {
    statusCode?: number;
    status?: number; // exists for backwards compatibility only
    statusMessage?: string;
    headers?: Headers;

    json?: any;
    body?: string | Buffer;
}

function isSerializedBuffer(obj: any): obj is SerializedBuffer {
    return obj && obj.type === 'Buffer' && !!obj.data;
}

export interface RequestHandler extends Explainable, Serializable {
    type: keyof typeof HandlerLookup;
    handle(request: OngoingRequest, response: OngoingResponse): Promise<void>;
}

export class SimpleHandler extends Serializable implements RequestHandler {
    readonly type = 'simple';

    constructor(
        public status: number,
        public statusMessage?: string,
        public data?: string | Buffer | SerializedBuffer,
        public headers?: Headers
    ) {
        super();
    }

    explain() {
        return `respond with status ${this.status}` +
            (this.statusMessage ? ` (${this.statusMessage})`: "") +
            (this.headers ? `, headers ${JSON.stringify(this.headers)}` : "") +
            (this.data ? ` and body "${this.data}"` : "");
    }

    async handle(_request: OngoingRequest, response: OngoingResponse) {
        if (this.headers) {
            setHeaders(response, this.headers);
        }
        response.writeHead(this.status, this.statusMessage);

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

function writeResponseFromCallback(result: CallbackResponseResult, response: express.Response) {
    if (result.json !== undefined) {
        result.headers = _.assign(result.headers || {}, { 'Content-Type': 'application/json' });
        result.body = JSON.stringify(result.json);
        delete result.json;
    }

    if (result.headers) {
        setHeaders(response, result.headers);
    }

    response.writeHead(
        result.statusCode || result.status || 200,
        result.statusMessage
    );
    response.end(result.body || "");
}

export class CallbackHandler extends Serializable implements RequestHandler {
    readonly type = 'callback';

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

        writeResponseFromCallback(outResponse, response);
    }

    serialize(channel: ClientServerChannel): SerializedCallbackHandlerData {
        channel.onRequest<
            CallbackRequestMessage,
            CallbackResponseResult
        >(async (streamMsg) => {
            return withSerializedBodyBuffer(
                await this.callback.apply(null, streamMsg.args)
            );
        });

        return { type: this.type, name: this.callback.name };
    }

    static deserialize({ name }: SerializedCallbackHandlerData, channel: ClientServerChannel): CallbackHandler {
        const rpcCallback = async (request: CompletedRequest) => {
            return withDeserializedBodyBuffer(
                await channel.request<
                    CallbackRequestMessage,
                    WithSerializedBodyBuffer<CallbackResponseResult>
                >({ args: [request] })
            );
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

export class StreamHandler extends Serializable implements RequestHandler {
    readonly type = 'stream';

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

export class FileHandler extends Serializable implements RequestHandler {
    readonly type = 'file';

    constructor(
        public status: number,
        public statusMessage: string | undefined,
        public filePath: string,
        public headers?: Headers
    ) {
        super();
    }

    explain() {
        return `respond with status ${this.status}` +
            (this.statusMessage ? ` (${this.statusMessage})`: "") +
            (this.headers ? `, headers ${JSON.stringify(this.headers)}` : "") +
            (this.filePath ? ` and body from file ${this.filePath}` : "");
    }

    async handle(_request: OngoingRequest, response: OngoingResponse) {
        // Read the file first, to ensure we error cleanly if it's unavailable
        const fileContents = await readFile(this.filePath, null);

        if (this.headers) setHeaders(response, this.headers);
        response.writeHead(this.status, this.statusMessage);
        response.end(fileContents);
    }
}

export interface PassThroughResponse {
    id: string;
    statusCode: number;
    statusMessage?: string;
    headers: Headers;
    body: CompletedBody;
}

interface ForwardingOptions {
    targetHost: string,
    updateHostHeader?: true | false | string // Change automatically/ignore/change to custom value
}

export interface PassThroughHandlerOptions {
    forwarding?: ForwardingOptions,
    ignoreHostCertificateErrors?: string[];
    clientCertificateHostMap?: {
        [host: string]: { pfx: Buffer, passphrase?: string }
    };
    beforeRequest?: (req: CompletedRequest) => MaybePromise<CallbackRequestResult>;
    beforeResponse?: (res: PassThroughResponse) => MaybePromise<CallbackResponseResult>;
}

interface SerializedPassThroughData {
    type: 'passthrough';
    forwardToLocation?: string;
    forwarding?: ForwardingOptions;
    ignoreHostCertificateErrors?: string[];
    clientCertificateHostMap?: { [host: string]: { pfx: string, passphrase?: string } };

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
        // it's ok, we just need to use the buffer data instead of the whole object
        return Buffer.from((replacementBody as CompletedBody).buffer);
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
                ${reqUrl}, whilst the header was set to ${replacementHost}.
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
    replacementHeaders: Headers | undefined,
    mismatchAllowed: boolean = false
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
        lengthOverride !== body.length.toString() &&
        !mismatchAllowed // Set for HEAD responses
    ) {
        console.warn(oneLine`
            Passthrough callback overrode the body and the content-length header
            with mismatched values, which may be a mistake. The body contains
            ${body.length} bytes, whilst the header was set to ${lengthOverride}.
        `);
    }

    return lengthOverride;
}

const KeepAliveAgents = {
    'http:': new http.Agent({
        keepAlive: true
    }),
    'https:': new https.Agent({
        keepAlive: true
    })
};

export class PassThroughHandler extends Serializable implements RequestHandler {
    readonly type = 'passthrough';

    public readonly forwarding?: ForwardingOptions;

    public readonly ignoreHostCertificateErrors: string[] = [];
    public readonly clientCertificateHostMap: {
        [host: string]: { pfx: Buffer, passphrase?: string }
    };

    public readonly beforeRequest?: (req: CompletedRequest) => MaybePromise<CallbackRequestResult>;
    public readonly beforeResponse?: (res: PassThroughResponse) => MaybePromise<CallbackResponseResult>;

    constructor(options: PassThroughHandlerOptions = {}) {
        super();

        // If a location is provided, and it's not a bare hostname, it must be parseable
        const { forwarding } = options;
        if (forwarding && forwarding.targetHost.includes('/')) {
            const { protocol, hostname, port, path } = url.parse(forwarding.targetHost);
            if (path && path.trim() !== "/") {
                const suggestion = url.format({ protocol, hostname, port }) ||
                    forwarding.targetHost.slice(0, forwarding.targetHost.indexOf('/'));
                throw new Error(stripIndent`
                    URLs for forwarding cannot include a path, but "${forwarding.targetHost}" does. ${''
                    }Did you mean ${suggestion}?
                `);
            }
        }

        this.forwarding = forwarding;

        this.ignoreHostCertificateErrors = options.ignoreHostCertificateErrors || [];
        this.clientCertificateHostMap = options.clientCertificateHostMap || {};

        this.beforeRequest = options.beforeRequest;
        this.beforeResponse = options.beforeResponse;
    }

    explain() {
        return this.forwarding
            ? `forward the request to ${this.forwarding.targetHost}`
            : 'pass the request through to the target host';
    }

    async handle(clientReq: OngoingRequest, clientRes: OngoingResponse) {
        // Capture raw request data:
        let { method, url: reqUrl, headers } = clientReq;
        let { protocol, hostname, port, path } = url.parse(reqUrl);

        if (this.forwarding) {
            const { targetHost, updateHostHeader } = this.forwarding;
            if (!targetHost.includes('/')) {
                // We're forwarding to a bare hostname
                [hostname, port] = targetHost.split(':');
            } else {
                // We're forwarding to a fully specified URL; override the host etc, but never the path.
                ({ protocol, hostname, port } = url.parse(targetHost));
            }

            if (updateHostHeader === undefined || updateHostHeader === true) {
                // If updateHostHeader is true, or just not specified, match the new target
                headers['host'] = hostname + (port ? `:${port}` : '');
            } else if (updateHostHeader) {
                // If it's an explicit custom value, use that directly.
                headers['host'] = updateHostHeader;
            } // Otherwise: falsey means don't touch it.
        }

        // Check if this request is a request loop:
        if (isRequestLoop((<any> clientReq).socket)) {
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

            if (modifiedReq.response) {
                // The callback has provided a full response: don't passthrough at all, just use it.
                writeResponseFromCallback(modifiedReq.response, clientRes);
                return;
            }

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

        const hostWithPort = `${hostname}:${port}`

        // Ignore cert errors if the host+port or whole hostname is whitelisted
        const checkServerCertificate = !_.includes(this.ignoreHostCertificateErrors, hostname) &&
            !_.includes(this.ignoreHostCertificateErrors, hostWithPort);

        // Use a client cert if it's listed for the  host+port or whole hostname
        const clientCert =this.clientCertificateHostMap[hostWithPort] ||
            this.clientCertificateHostMap[hostname!] ||
            {};

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

        // Mirror the keep-alive-ness of the incoming request in our outgoing request
        const agent = shouldKeepAlive(clientReq)
            ? KeepAliveAgents[(protocol as 'http:' | 'https:') || 'http:']
            : undefined;

        return new Promise<void>((resolve, reject) => {
            let serverReq = makeRequest({
                protocol,
                method,
                hostname,
                port,
                family,
                path,
                headers,
                agent,
                rejectUnauthorized: checkServerCertificate,
                ...clientCert
            }, async (serverRes) => {
                serverRes.once('error', reject);

                let serverStatusCode = serverRes.statusCode!;
                let serverStatusMessage = serverRes.statusMessage
                let serverHeaders = serverRes.headers;
                let resBodyOverride: string | Buffer | undefined;

                if (this.beforeResponse) {
                    let modifiedRes: CallbackResponseResult;
                    let body: Buffer;
                    try {
                        body = await streamToBuffer(serverRes);
                        modifiedRes = await this.beforeResponse({
                            id: clientReq.id,
                            statusCode: serverStatusCode,
                            statusMessage: serverRes.statusMessage,
                            headers: serverHeaders,
                            body: buildBodyReader(body, serverHeaders)
                        });
                    } catch (e) {
                        serverReq.abort();
                        return reject(e);
                    }

                    serverStatusCode = modifiedRes.statusCode ||
                        modifiedRes.status ||
                        serverStatusCode;
                    serverStatusMessage = modifiedRes.statusMessage ||
                        serverStatusMessage;

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
                            modifiedRes.headers,
                            method === 'HEAD' // HEAD responses are allowed mismatched content-length
                        );
                    } else {
                        // If you don't specify a body override, we need to use the real
                        // body anyway, because as we've read it already streaming it to
                        // the response won't work
                        resBodyOverride = body;
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

                clientRes.statusMessage = serverStatusMessage || clientRes.statusMessage;
                clientRes.status(serverStatusCode);

                if (resBodyOverride) {
                    clientRes.end(resBodyOverride);
                    resolve();
                } else {
                    serverRes.pipe(clientRes);
                    serverRes.once('end', resolve);
                }
            });

            serverReq.once('socket', (socket: net.Socket) => {
                // This event can fire multiple times for keep-alive sockets, which are used to
                // make multiple requests. If/when that happens, we don't need more event listeners.
                if (currentlyForwardingSockets.has(socket)) return;

                // Add this port to our list of active ports, once it's connected (before then it has no port)
                socket.once('connect', () => currentlyForwardingSockets.add(socket));

                // Remove this port from our list of active ports when it's closed
                // This is called for both clean closes & errors.
                socket.once('close', () => currentlyForwardingSockets.delete(socket));
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

                // Tag responses, so programmatic examination can react to this
                // event, without having to parse response data or similar.
                const tlsAlertMatch = /SSL alert number (\d+)/.exec(e.message);
                if (tlsAlertMatch) {
                    clientRes.tags.push('passthrough-tls-error:ssl-alert-' + tlsAlertMatch[1]);
                }
                clientRes.tags.push('passthrough-error:' + e.code);

                if (e.code === 'ECONNRESET') {
                    // The upstream socket closed: forcibly close the downstream too, to match
                    (clientReq as any).socket.end();
                    reject(new AbortError('Upstream connection was reset'));
                } else {
                    e.statusCode = 502;
                    e.statusMessage = 'Error communicating with upstream server';
                    reject(e);
                }
            });
        });
    }

    serialize(channel: ClientServerChannel): SerializedPassThroughData {
        if (this.beforeRequest) {
            channel.onRequest<
                BeforePassthroughRequestRequest,
                CallbackRequestResult
            >('beforeRequest', async (req) => {
                const result = withSerializedBodyBuffer(
                    await this.beforeRequest!(
                        withDeserializedBodyReader(req.args[0])
                    )
                );
                if (result.response) {
                    result.response = withSerializedBodyBuffer(result.response);
                }
                return result;
            });
        }

        if (this.beforeResponse) {
            channel.onRequest<
                BeforePassthroughResponseRequest,
                CallbackResponseResult
            >('beforeResponse', async (req) => {
                return withSerializedBodyBuffer(
                    await this.beforeResponse!(
                        withDeserializedBodyReader(req.args[0])
                    )
                );
            });
        }

        return {
            type: this.type,
            ...this.forwarding ? {
                forwardToLocation: this.forwarding.targetHost,
                forwarding: this.forwarding
            } : {},
            ignoreHostCertificateErrors: this.ignoreHostCertificateErrors,
            clientCertificateHostMap: _.mapValues(this.clientCertificateHostMap,
                ({ pfx, passphrase }) => ({ pfx: serializeBuffer(pfx), passphrase })
            ),
            hasBeforeRequestCallback: !!this.beforeRequest,
            hasBeforeResponseCallback: !!this.beforeResponse
        };
    }

    static deserialize(data: SerializedPassThroughData, channel: ClientServerChannel): PassThroughHandler {
        let beforeRequest: ((req: CompletedRequest) => MaybePromise<CallbackRequestResult>) | undefined;
        let beforeResponse: ((res: PassThroughResponse) => MaybePromise<CallbackResponseResult>) | undefined;

        if (data.hasBeforeRequestCallback) {
            beforeRequest = async (req: CompletedRequest) => {
                const result = withDeserializedBodyBuffer(
                    await channel.request<
                        BeforePassthroughRequestRequest,
                        WithSerializedBodyBuffer<CallbackRequestResult>
                    >('beforeRequest', {
                        args: [withSerializedBodyReader(req)]
                    })
                );
                if (result.response) {
                    result.response = withDeserializedBodyBuffer(
                        result.response as WithSerializedBodyBuffer<CallbackResponseResult>
                    );
                }

                return result;
            };
        }

        if (data.hasBeforeResponseCallback) {
            beforeResponse = async (res: PassThroughResponse) => {
                return withDeserializedBodyBuffer(await channel.request<
                    BeforePassthroughResponseRequest,
                    WithSerializedBodyBuffer<CallbackResponseResult>
                >('beforeResponse', {
                    args: [withSerializedBodyReader(res)]
                }));
            };
        }

        return new PassThroughHandler({
            beforeRequest,
            beforeResponse,
            // Backward compat for old clients:
            ...data.forwardToLocation ? {
                forwarding: { targetHost: data.forwardToLocation }
            } : {},
            forwarding: data.forwarding,
            ignoreHostCertificateErrors: data.ignoreHostCertificateErrors,
            clientCertificateHostMap: _.mapValues(data.clientCertificateHostMap,
                ({ pfx, passphrase }) => ({ pfx: deserializeBuffer(pfx), passphrase })
            ),
        });
    }
}

export class CloseConnectionHandler extends Serializable implements RequestHandler {
    readonly type = 'close-connection';

    explain() {
        return 'close the connection';
    }

    async handle(request: OngoingRequest) {
        const socket: net.Socket = (<any> request).socket;
        socket.end();
        throw new AbortError('Connection closed (intentionally)');
    }
}

export class TimeoutHandler extends Serializable implements RequestHandler {
    readonly type = 'timeout';

    explain() {
        return 'time out (never respond)';
    }

    async handle() {
        // Do nothing, leaving the socket open but never sending a response.
        return new Promise<void>(() => {});
    }
}

export const HandlerLookup = {
    'simple': SimpleHandler,
    'callback': CallbackHandler,
    'stream': StreamHandler,
    'file': FileHandler,
    'passthrough': PassThroughHandler,
    'close-connection': CloseConnectionHandler,
    'timeout': TimeoutHandler
}

// Passthrough handlers need to spot loops - tracking ongoing sockets lets us get pretty
// close to doing that (for 1 step loops, at least):

// We keep a list of all currently active outgoing sockets.
const currentlyForwardingSockets = new Set<net.Socket>();

// We need to normalize ips for comparison, because the same ip may be reported as ::ffff:127.0.0.1
// and 127.0.0.1 on the two sides of the connection, for the same ip.
const normalizeIp = (ip: string | undefined) =>
    (ip && ip.startsWith('::ffff:'))
        ? ip.slice('::ffff:'.length)
        : ip;

// For incoming requests, compare the address & port: if they match, we've almost certainly got a loop.
// I don't think it's generally possible to see the same ip on different interfaces from one process (you need
// ip-netns network namespaces), but if it is, then there's a tiny chance of false positives here. If we have ip X,
// and on another interface somebody else has ip X, and the send a request with the same incoming port as an
// outgoing request we have on the other interface, we'll assume it's a loop. Extremely unlikely imo.
const isRequestLoop = (incomingSocket: net.Socket) =>
    _.some([...currentlyForwardingSockets], (outgoingSocket) =>
        normalizeIp(outgoingSocket.localAddress) === normalizeIp(incomingSocket.remoteAddress) &&
        outgoingSocket.remotePort === incomingSocket.localPort
    );
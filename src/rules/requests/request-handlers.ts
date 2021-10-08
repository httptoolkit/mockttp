import _ = require('lodash');
import url = require('url');
import net = require('net');
import tls = require('tls');
import http = require('http');
import http2 = require('http2');
import https = require('https');
import * as h2Client from 'http2-wrapper';
import CacheableLookup from 'cacheable-lookup';
import { encode as encodeBase64, decode as decodeBase64 } from 'base64-arraybuffer';
import { Readable, Transform } from 'stream';
import { stripIndent, oneLine } from 'common-tags';
import { TypedError } from 'typed-error';
import { encodeBuffer, SUPPORTED_ENCODING } from 'http-encoding';

import {
    Headers,
    OngoingRequest,
    CompletedRequest,
    OngoingResponse,
    CompletedBody,
    Explainable
} from "../../types";

import { byteLength } from '../../util/util';
import { MaybePromise, Replace } from '../../util/type-utils';
import { readFile } from '../../util/fs';
import {
    waitForCompletedRequest,
    setHeaders,
    buildBodyReader,
    shouldKeepAlive,
    dropDefaultHeaders,
    isHttp2,
    h1HeadersToH2,
    h2HeadersToH1,
    isAbsoluteUrl,
    cleanUpHeaders,
    isMockttpBody
} from '../../util/request-utils';
import { streamToBuffer, asBuffer } from '../../util/buffer-utils';
import { isLocalhostAddress, isLocalPortActive, isSocketLoop } from '../../util/socket-util';
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
} from "../../util/serialization";
import { getAgent, ProxyConfig } from '../../util/http-agents';
import { CachedDns } from '../../util/dns';

// An error that indicates that the handler is aborting the request.
// This could be intentional, or an upstream server aborting the request.
export class AbortError extends TypedError { }

export type SerializedBuffer = { type: 'Buffer', data: number[] };

export interface CallbackRequestResult {
    method?: string;
    url?: string;
    headers?: Headers;

    json?: any;
    body?: string | Buffer;

    response?: CallbackResponseResult;
}

export type CallbackResponseResult =
    | CallbackResponseMessageResult
    | 'close';

export interface CallbackResponseMessageResult {
    statusCode?: number;
    status?: number; // exists for backwards compatibility only
    statusMessage?: string;
    headers?: Headers;

    json?: any;
    body?: string | Buffer | Uint8Array;
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
        public data?: string | Uint8Array | Buffer | SerializedBuffer,
        public headers?: Headers
    ) {
        super();

        validateCustomHeaders({}, headers);
    }

    explain() {
        return `respond with status ${this.status}` +
            (this.statusMessage ? ` (${this.statusMessage})`: "") +
            (this.headers ? `, headers ${JSON.stringify(this.headers)}` : "") +
            (this.data ? ` and body "${this.data}"` : "");
    }

    async handle(_request: OngoingRequest, response: OngoingResponse) {
        if (this.headers) {
            dropDefaultHeaders(response);
            setHeaders(response, this.headers);
        }
        response.writeHead(this.status, this.statusMessage);

        if (isSerializedBuffer(this.data)) {
            this.data = Buffer.from(<any> this.data);
        }

        response.end(this.data || "");
    }
}

export interface SerializedCallbackHandlerData {
    type: string;
    name?: string;
    version?: number;
}

interface CallbackRequestMessage {
    args: [
        | Replace<CompletedRequest, 'body', string> // New format
        | CompletedRequest // Old format with directly serialized body
    ];
}

function writeResponseFromCallback(result: CallbackResponseMessageResult, response: OngoingResponse) {
    if (result.json !== undefined) {
        result.headers = _.assign(result.headers || {}, { 'Content-Type': 'application/json' });
        result.body = JSON.stringify(result.json);
        delete result.json;
    }

    if (result.headers) {
        dropDefaultHeaders(response);
        validateCustomHeaders({}, result.headers);
        setHeaders(response, dropUndefinedValues(result.headers));
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

    async handle(request: OngoingRequest, response: OngoingResponse) {
        let req = await waitForCompletedRequest(request);

        let outResponse: CallbackResponseResult;
        try {
            outResponse = await this.callback(req);
        } catch (error) {
            response.writeHead(500, 'Callback handler threw an exception');
            response.end(error.toString());
            return;
        }

        if (outResponse === 'close') {
            (request as any).socket.end();
            throw new AbortError('Connection closed (intentionally)');
        } else {
            writeResponseFromCallback(outResponse, response);
        }
    }

    /**
     * @internal
     */
    serialize(channel: ClientServerChannel): SerializedCallbackHandlerData {
        channel.onRequest<
            CallbackRequestMessage,
            CallbackResponseResult
        >(async (streamMsg) => {
            const request = _.isString(streamMsg.args[0].body)
                ? withDeserializedBodyReader( // New format: body serialized as base64
                    streamMsg.args[0] as Replace<CompletedRequest, 'body', string>
                )
                : { // Backward compat: old fully-serialized format
                    ...streamMsg.args[0],
                    body: buildBodyReader(streamMsg.args[0].body.buffer, streamMsg.args[0].headers)
                };

            const callbackResult = await this.callback.call(null, request);

            if (typeof callbackResult === 'string') {
                return callbackResult;
            } else {
                return withSerializedBodyBuffer(callbackResult);
            }
        });

        return { type: this.type, name: this.callback.name, version: 2 };
    }

    /**
     * @internal
     */
    static deserialize({ name, version }: SerializedCallbackHandlerData, channel: ClientServerChannel): CallbackHandler {
        const rpcCallback = async (request: CompletedRequest) => {
            const callbackResult = await channel.request<
                CallbackRequestMessage,
                WithSerializedBodyBuffer<CallbackResponseMessageResult> | 'close'
            >({ args: [
                (version || -1) >= 2
                    ? withSerializedBodyReader(request)
                    : request // Backward compat: old handlers
            ] });

            if (typeof callbackResult === 'string') {
                return callbackResult;
            } else {
                return withDeserializedBodyBuffer(callbackResult);
            }
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

        validateCustomHeaders({}, headers);
    }

    explain() {
        return `respond with status ${this.status}` +
            (this.headers ? `, headers ${JSON.stringify(this.headers)},` : "") +
            ' and a stream of response data';
    }

    async handle(_request: OngoingRequest, response: OngoingResponse) {
        if (!this.stream.done) {
            if (this.headers) {
                dropDefaultHeaders(response);
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

                (Have a better way to handle this? Open an issue at ${require('../../../package.json').bugs.url})
            `);
        }
    }

    /**
     * @internal
     */
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

    /**
     * @internal
     */
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

        validateCustomHeaders({}, headers);
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

        if (this.headers) {
            dropDefaultHeaders(response);
            setHeaders(response, this.headers);
        }

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

export interface ForwardingOptions {
    targetHost: string,
    // Should the host (H1) or :authority (H2) header be updated to match?
    updateHostHeader?: true | false | string // Change automatically/ignore/change to custom value
}

export interface PassThroughLookupOptions {
    /**
     * The maximum time to cache a DNS response. Up to this limit,
     * responses will be cached according to their own TTL. Defaults
     * to Infinity.
     */
    maxTtl?: number;
    /**
     * How long to cache a DNS ENODATA or ENOTFOUND response. Defaults
     * to 0.15.
     */
    errorTtl?: number;
    /**
     * The primary servers to use. DNS queries will be resolved against
     * these servers first. If no data is available, queries will fall
     * back to dns.lookup, and use the OS's default DNS servers.
     *
     * This defaults to dns.getServers().
     */
    servers?: string[];
}

export interface PassThroughHandlerOptions {
    /**
     * The forwarding configuration for the passthrough rule.
     * This generally shouldn't be used explicitly unless you're
     * building rule data by hand. Instead, call `thenPassThrough`
     * to send data directly or `thenForwardTo` with options to
     * configure traffic forwarding.
     */
    forwarding?: ForwardingOptions,

    /**
     * A list of hostnames for which server certificate and TLS version errors
     * should be ignored (none, by default).
     */
    ignoreHostHttpsErrors?: string[];

    /**
     * Deprecated alias for ignoreHostHttpsErrors.
     * @deprecated
     */
    ignoreHostCertificateErrors?: string[];

    /**
     * A mapping of hosts to client certificates to use, in the form of
     * `{ key, cert }` objects (none, by default)
     */
    clientCertificateHostMap?: {
        [host: string]: { pfx: Buffer, passphrase?: string }
    };

    /**
     * Upstream proxy configuration: pass through requests via this proxy
     */
    proxyConfig?: ProxyConfig;

    /**
     * Custom DNS options, to allow configuration of the resolver used
     * when forwarding requests upstream. Passing any option switches
     * from using node's default dns.lookup function to using the
     * cacheable-lookup module, which will cache responses.
     */
    lookupOptions?: PassThroughLookupOptions;

    /**
     * A set of data to automatically transform a request. This includes properties
     * to support many transformation common use cases.
     *
     * For advanced cases, a custom callback using beforeRequest can be used instead.
     * Using this field however where possible is typically simpler, more declarative,
     * and can be more performant. The two options are mutually exclusive: you cannot
     * use both transformRequest and a beforeRequest callback.
     *
     * Only one transformation for each target (method, headers & body) can be
     * specified. If more than one is specified then an error will be thrown when the
     * rule is registered.
     */
    transformRequest?: RequestTransform;

    /**
     * A set of data to automatically transform a response. This includes properties
     * to support many transformation common use cases.
     *
     * For advanced cases, a custom callback using beforeResponse can be used instead.
     * Using this field however where possible is typically simpler, more declarative,
     * and can be more performant. The two options are mutually exclusive: you cannot
     * use both transformResponse and a beforeResponse callback.
     *
     * Only one transformation for each target (status, headers & body) can be
     * specified. If more than one is specified then an error will be thrown when the
     * rule is registered.
     */
    transformResponse?: ResponseTransform;

    /**
     * A callback that will be passed the full request before it is passed through,
     * and which returns an object that defines how the the request content should
     * be transformed before it's passed to the upstream server.
     *
     * The callback can return an object to define how the request should be changed.
     * All fields on the object are optional, and returning undefined is equivalent
     * to returning an empty object (transforming nothing). The possible fields are:
     *
     * - `method` (a replacement HTTP verb, capitalized)
     * - `url` (a full URL to send the request to)
     * - `headers` (object with string keys & values, replaces all headers if set)
     * - `body` (string or buffer, replaces the body if set)
     * - `json` (object, to be sent as a JSON-encoded body, taking precedence
     *   over `body` if both are set)
     * - `response` (a response callback result, either a response object or 'close',
     *   if provided this will be used as an immediately response, the request will
     *   not be passed through at all, and any beforeResponse callback will never
     *   fire)
     */
    beforeRequest?: (req: CompletedRequest) => MaybePromise<CallbackRequestResult | void> | void;

    /**
     * A callback that will be passed the full response before it is passed through,
     * and which returns a value that defines how the the response content should
     * be transformed before it's returned to the client.
     *
     * The callback can either return an object to define how the response should be
     * changed, or the string 'close' to immediately close the underlying connection.
     *
     * All fields on the object are optional, and returning undefined is equivalent
     * to returning an empty object (transforming nothing). The possible fields are:
     *
     * - `status` (number, will replace the HTTP status code)
     * - `headers` (object with string keys & values, replaces all headers if set)
     * - `body` (string or buffer, replaces the body if set)
     * - `json` (object, to be sent as a JSON-encoded body, taking precedence
     *   over `body` if both are set)
     */
    beforeResponse?: (res: PassThroughResponse) => MaybePromise<CallbackResponseResult | void> | void;
}

export interface RequestTransform {

    /**
     * A replacement HTTP method. Case insensitive.
     */
    replaceMethod?: string;

    /**
     * A headers object which will be merged with the real request headers to add or
     * replace values. Headers with undefined values will be removed.
     */
    updateHeaders?: Headers;

    /**
     * A headers object which will completely replace the real request headers.
     */
    replaceHeaders?: Headers;

    /**
     * A string or buffer that replaces the request body entirely.
     *
     * If this is specified, the upstream request will not wait for the original request
     * body, so this may make responses faster than they would be otherwise given large
     * request bodies or slow/streaming clients.
     */
    replaceBody?: string | Uint8Array | Buffer;

    /**
     * The path to a file, which will be used to replace the request body entirely. The
     * file will be re-read for each request, so the body will always reflect the latest
     * file contents.
     *
     * If this is specified, the upstream request will not wait for the original request
     * body, so this may make responses faster than they would be otherwise given large
     * request bodies or slow/streaming clients.
     */
    replaceBodyFromFile?: string;

    /**
     * A JSON object which will be merged with the real request body. Undefined values
     * will be removed. Any requests which are received with an invalid JSON body that
     * match this rule will fail.
     */
    updateJsonBody?: {
        [key: string]: any;
    };
}

export interface ResponseTransform {

    /**
     * A replacement response status code.
     */
    replaceStatus?: number;

    /**
     * A headers object which will be merged with the real response headers to add or
     * replace values. Headers with undefined values will be removed.
     */
    updateHeaders?: Headers;

    /**
     * A headers object which will completely replace the real response headers.
     */
    replaceHeaders?: Headers;

    /**
     * A string or buffer that replaces the response body entirely.
     *
     * If this is specified, the downstream response will not wait for the original response
     * body, so this may make responses arrive faster than they would be otherwise given large
     * response bodies or slow/streaming servers.
     */
    replaceBody?: string | Uint8Array | Buffer;

    /**
     * The path to a file, which will be used to replace the response body entirely. The
     * file will be re-read for each response, so the body will always reflect the latest
     * file contents.
     *
     * If this is specified, the downstream response will not wait for the original response
     * body, so this may make responses arrive faster than they would be otherwise given large
     * response bodies or slow/streaming servers.
     */
    replaceBodyFromFile?: string;

    /**
     * A JSON object which will be merged with the real response body. Undefined values
     * will be removed. Any responses which are received with an invalid JSON body that
     * match this rule will fail.
     */
    updateJsonBody?: {
        [key: string]: any;
    };

}

interface SerializedPassThroughData {
    type: 'passthrough';
    forwardToLocation?: string;
    forwarding?: ForwardingOptions;
    proxyConfig?: ProxyConfig;
    ignoreHostCertificateErrors?: string[]; // Doesn't match option name, backward compat
    clientCertificateHostMap?: { [host: string]: { pfx: string, passphrase?: string } };
    lookupOptions?: PassThroughLookupOptions;

    transformRequest?: Replace<
        RequestTransform,
        | 'replaceBody' // Serialized as base64 buffer
        | 'updateHeaders' // // Serialized as a string to preserve undefined values
        | 'updateJsonBody', // Serialized as a string to preserve undefined values
        string | undefined
    >,
    transformResponse?: Replace<
        ResponseTransform,
        | 'replaceBody' // Serialized as base64 buffer
        | 'updateHeaders' // // Serialized as a string to preserve undefined values
        | 'updateJsonBody', // Serialized as a string to preserve undefined values
        string | undefined
    >,

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
    replacementBody: string | Uint8Array | Buffer | CompletedBody | undefined
): Buffer | undefined {
    if (replacementBody === undefined) {
        return replacementBody;
    } else if (isMockttpBody(replacementBody)) {
        // It's our own bodyReader instance. That's not supposed to happen, but
        // it's ok, we just need to use the buffer data instead of the whole object
        return Buffer.from((replacementBody as CompletedBody).buffer);
    } else if (replacementBody === '') {
        // For empty bodies, it's slightly more convenient if they're truthy
        return Buffer.alloc(0);
    } else {
        return asBuffer(replacementBody as Uint8Array | Buffer | string);
    }
}

function getOverrideUrlLinkedHeader(
    originalHeaders: Headers,
    replacementHeaders: Headers | undefined,
    headerName: 'host' | ':authority' | ':scheme',
    expectedValue: string
) {
    const replacementValue = !!replacementHeaders ? replacementHeaders[headerName] : undefined;

    if (replacementValue !== undefined) {
        if (replacementValue !== expectedValue && replacementValue === originalHeaders[headerName]) {
            // If you rewrite the URL-based header wrongly, by explicitly setting it to the
            // existing value, we accept it but print a warning. This would be easy to
            // do if you mutate the existing headers, for example, and ignore the host.
            console.warn(oneLine`
                Passthrough callback overrode the URL and the ${headerName} header
                with mismatched values, which may be a mistake. The URL implies
                ${expectedValue}, whilst the header was set to ${replacementValue}.
            `);
        }
        // Whatever happens, if you explicitly set a value, we use it.
        return replacementValue;
    }

    // If you didn't override the header at all, then we automatically ensure
    // the correct value is set automatically.
    return expectedValue;
}

// Helper to autocorrect the host header, but only if you didn't explicitly
// override it yourself for some reason (e.g. testing bad behaviour).
function getCorrectHost(
    reqUrl: string,
    originalHeaders: Headers,
    replacementHeaders: Headers | undefined
): string {
    return getOverrideUrlLinkedHeader(
        originalHeaders,
        replacementHeaders,
        'host',
        url.parse(reqUrl).host!
    );
}

const OVERRIDABLE_REQUEST_PSEUDOHEADERS = [
    ':authority',
    ':scheme'
] as const;

// We allow manually reconfiguring the :authority & :scheme headers, so that you can
// send a request to one server, and pretend it was sent to a different server, similar
// to setting a custom Host header value.
function getCorrectPseudoheaders(
    reqUrl: string,
    originalHeaders: Headers,
    replacementHeaders: Headers | undefined
): { [K in typeof OVERRIDABLE_REQUEST_PSEUDOHEADERS[number]]: string } {
    const parsedUrl = url.parse(reqUrl);

    return {
        ':scheme': getOverrideUrlLinkedHeader(
            originalHeaders,
            replacementHeaders,
            ':scheme',
            parsedUrl.protocol!.slice(0, -1)
        ),
        ':authority': getOverrideUrlLinkedHeader(
            originalHeaders,
            replacementHeaders,
            ':authority',
            parsedUrl.host!
        )
    };
}

// Helper to handle content-length nicely for you when rewriting requests with callbacks
function getCorrectContentLength(
    body: string | Uint8Array | Buffer,
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
        return byteLength(body).toString();
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
        lengthOverride !== byteLength(body).toString() &&
        !mismatchAllowed // Set for HEAD responses
    ) {
        console.warn(oneLine`
            Passthrough modifications overrode the body and the content-length header
            with mismatched values, which may be a mistake. The body contains
            ${byteLength(body)} bytes, whilst the header was set to ${lengthOverride}.
        `);
    }

    return lengthOverride;
}

function validateCustomHeaders(
    originalHeaders: Headers,
    modifiedHeaders: Headers | undefined,
    headerWhitelist: readonly string[] = []
) {
    if (!modifiedHeaders) return;

    // We ignore most returned pseudo headers, so we error if you try to manually set them
    const invalidHeaders = _(modifiedHeaders)
        .pickBy((value, name) =>
            name.toString().startsWith(':') &&
            // We allow returning a preexisting header value - that's ignored
            // silently, so that mutating & returning the provided headers is always safe.
            value !== originalHeaders[name] &&
            // In some cases, specific custom pseudoheaders may be allowed, e.g. requests
            // can have custom :scheme and :authority headers set.
            !headerWhitelist.includes(name)
        )
        .keys();

    if (invalidHeaders.size() > 0) {
        throw new Error(
            `Cannot set custom ${invalidHeaders.join(', ')} pseudoheader values`
        );
    }
}

// Used in merging as a marker for values to omit, because lodash ignores undefineds.
const OMIT_SYMBOL = Symbol('omit-value');
const SERIALIZED_OMIT = "__mockttp__transform__omit__";

// We play some games to preserve undefined values during serialization, because we differentiate them
// in some transforms from null/not-present keys.
const mapOmitToUndefined = <T extends { [key: string]: any }>(
    input: T
): { [K in keyof T]: T[K] | undefined } =>
    _.mapValues(input, (v) =>
        v === SERIALIZED_OMIT || v === OMIT_SYMBOL
            ? undefined // Replace our omit placeholders with actual undefineds
            : v
    );

export class PassThroughHandler extends Serializable implements RequestHandler {
    readonly type = 'passthrough';

    public readonly forwarding?: ForwardingOptions;

    public readonly ignoreHostHttpsErrors: string[] = [];
    public readonly clientCertificateHostMap: {
        [host: string]: { pfx: Buffer, passphrase?: string }
    };

    public readonly transformRequest?: RequestTransform;
    public readonly transformResponse?: ResponseTransform;

    public readonly beforeRequest?: (req: CompletedRequest) =>
        MaybePromise<CallbackRequestResult | void> | void;
    public readonly beforeResponse?: (res: PassThroughResponse) =>
        MaybePromise<CallbackResponseResult | void> | void;

    public readonly lookupOptions?: PassThroughLookupOptions;
    public readonly proxyConfig?: ProxyConfig;

    private _cacheableLookupInstance: CacheableLookup | CachedDns | undefined;
    private lookup() {
        if (!this.lookupOptions) {
            if (!this._cacheableLookupInstance) {
                // By default, use 10s caching of hostnames, just to reduce the delay from
                // endlessly 10ms query delay for 'localhost' with every request.
                this._cacheableLookupInstance = new CachedDns(10000);
            }
            return this._cacheableLookupInstance.lookup;
        } else {
            if (!this._cacheableLookupInstance) {
                this._cacheableLookupInstance = new CacheableLookup({
                    maxTtl: this.lookupOptions.maxTtl,
                    errorTtl: this.lookupOptions.errorTtl,
                    // As little caching of "use the fallback server" as possible:
                    fallbackDuration: 0
                });

                if (this.lookupOptions.servers) {
                    this._cacheableLookupInstance.servers = this.lookupOptions.servers;
                }
            }

            return this._cacheableLookupInstance.lookup;
        }
    }

    private outgoingSockets = new Set<net.Socket>();

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

        this.ignoreHostHttpsErrors = options.ignoreHostHttpsErrors ||
            options.ignoreHostCertificateErrors ||
            [];
        if (!Array.isArray(this.ignoreHostHttpsErrors)) {
            throw new Error("ignoreHostHttpsErrors must be an array");
        }

        this.lookupOptions = options.lookupOptions;
        this.clientCertificateHostMap = options.clientCertificateHostMap || {};
        this.proxyConfig = options.proxyConfig;

        if (options.beforeRequest && options.transformRequest && !_.isEmpty(options.transformRequest)) {
            throw new Error("BeforeRequest and transformRequest options are mutually exclusive");
        } else if (options.beforeRequest) {
            this.beforeRequest = options.beforeRequest;
        } else if (options.transformRequest) {
            if ([
                options.transformRequest.updateHeaders,
                options.transformRequest.replaceHeaders
            ].filter(o => !!o).length > 1) {
                throw new Error("Only one request header transform can be specified at a time");
            }
            if ([
                options.transformRequest.replaceBody,
                options.transformRequest.replaceBodyFromFile,
                options.transformRequest.updateJsonBody
            ].filter(o => !!o).length > 1) {
                throw new Error("Only one request body transform can be specified at a time");
            }

            this.transformRequest = options.transformRequest;
        }

        if (options.beforeResponse && options.transformResponse && !_.isEmpty(options.transformResponse)) {
            throw new Error("BeforeResponse and transformResponse options are mutually exclusive");
        } else if (options.beforeResponse) {
            this.beforeResponse = options.beforeResponse;
        } else if (options.transformResponse) {
            if ([
                options.transformResponse.updateHeaders,
                options.transformResponse.replaceHeaders
            ].filter(o => !!o).length > 1) {
                throw new Error("Only one response header transform can be specified at a time");
            }
            if ([
                options.transformResponse.replaceBody,
                options.transformResponse.replaceBodyFromFile,
                options.transformResponse.updateJsonBody
            ].filter(o => !!o).length > 1) {
                throw new Error("Only one response body transform can be specified at a time");
            }

            this.transformResponse = options.transformResponse;
        }
    }

    explain() {
        return this.forwarding
            ? `forward the request to ${this.forwarding.targetHost}`
            : 'pass the request through to the target host';
    }

    async handle(clientReq: OngoingRequest, clientRes: OngoingResponse) {
        // Don't let Node add any default standard headers - we want full control
        dropDefaultHeaders(clientRes);

        // Capture raw request data:
        let { method, url: reqUrl, headers } = clientReq;
        let { protocol, hostname, port, path } = url.parse(reqUrl);

        const isH2Downstream = isHttp2(clientReq);

        if (isLocalhostAddress(hostname) && clientReq.remoteAddress && !isLocalhostAddress(clientReq.remoteAddress)) {
            // If we're proxying localhost traffic from another remote machine, then we should really be proxying
            // back to that machine, not back to ourselves! Best example is docker containers: if we capture & inspect
            // their localhost traffic, it should still be sent back into that docker container.
            hostname = clientReq.remoteAddress;

            // We don't update the host header - from the POV of the target, it's still localhost traffic.
        }

        if (this.forwarding) {
            const { targetHost, updateHostHeader } = this.forwarding;
            if (!targetHost.includes('/')) {
                // We're forwarding to a bare hostname
                [hostname, port] = targetHost.split(':');
            } else {
                // We're forwarding to a fully specified URL; override the host etc, but never the path.
                ({ protocol, hostname, port } = url.parse(targetHost));
            }

            const hostHeaderName = isH2Downstream ? ':authority' : 'host';

            if (updateHostHeader === undefined || updateHostHeader === true) {
                // If updateHostHeader is true, or just not specified, match the new target
                headers[hostHeaderName] = hostname + (port ? `:${port}` : '');
            } else if (updateHostHeader) {
                // If it's an explicit custom value, use that directly.
                headers[hostHeaderName] = updateHostHeader;
            } // Otherwise: falsey means don't touch it.
        }

        // Check if this request is a request loop:
        if (isSocketLoop(this.outgoingSockets, (<any> clientReq).socket)) {
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

        // Override the request details, if a transform or callback is specified:
        let reqBodyOverride: Buffer | undefined;
        let headersManuallyModified = false;
        if (this.transformRequest) {
            const {
                replaceMethod,
                updateHeaders,
                replaceHeaders,
                replaceBody,
                replaceBodyFromFile,
                updateJsonBody
            } = this.transformRequest;

            if (replaceMethod) {
                method = replaceMethod;
            }

            if (updateHeaders) {
                headers = {
                    ...headers,
                    ...updateHeaders
                };
                headersManuallyModified = true;
            } else if (replaceHeaders) {
                headers = { ...replaceHeaders };
                headersManuallyModified = true;
            }

            if (replaceBody) {
                // Note that we're replacing the body without actually waiting for the real one, so
                // this can result in sending a request much more quickly!
                reqBodyOverride = asBuffer(replaceBody);
            } else if (replaceBodyFromFile) {
                reqBodyOverride = await readFile(replaceBodyFromFile, null);
            } else if (updateJsonBody) {
                const { body: realBody } = await waitForCompletedRequest(clientReq);
                if (await realBody.getJson() === undefined) {
                    throw new Error("Can't transform non-JSON request body");
                }

                const updatedBody = _.mergeWith(
                    await realBody.getJson(),
                    updateJsonBody,
                    (_oldValue, newValue) => {
                        // We want to remove values with undefines, but Lodash ignores
                        // undefined return values here. Fortunately, JSON.stringify
                        // ignores Symbols, omitting them from the result.
                        if (newValue === undefined) return OMIT_SYMBOL;
                    }
                );

                reqBodyOverride = asBuffer(JSON.stringify(updatedBody));
            }

            if (reqBodyOverride) {
                // We always re-encode the body to match the resulting content-encoding header:
                reqBodyOverride = await encodeBuffer(
                    reqBodyOverride,
                    (headers['content-encoding'] || '') as SUPPORTED_ENCODING,
                    { level: 1 }
                );

                headers['content-length'] = getCorrectContentLength(
                    reqBodyOverride,
                    clientReq.headers,
                    (updateHeaders && updateHeaders['content-length'] !== undefined)
                        ? headers // Iff you replaced the content length
                        : replaceHeaders,
                );
            }

            headers = dropUndefinedValues(headers);
        } else if (this.beforeRequest) {
            const completedRequest = await waitForCompletedRequest(clientReq);
            const modifiedReq = await this.beforeRequest({
                ...completedRequest,
                headers: _.clone(completedRequest.headers)
            });

            if (modifiedReq?.response) {
                if (modifiedReq.response === 'close') {
                    const socket: net.Socket = (<any> clientReq).socket;
                    socket.end();
                    throw new AbortError('Connection closed (intentionally)');
                } else {
                    // The callback has provided a full response: don't passthrough at all, just use it.
                    writeResponseFromCallback(modifiedReq.response, clientRes);
                    return;
                }
            }

            method = modifiedReq?.method || method;
            reqUrl = modifiedReq?.url || reqUrl;
            headers = modifiedReq?.headers || headers;

            Object.assign(headers,
                isH2Downstream
                    ? getCorrectPseudoheaders(reqUrl, clientReq.headers, modifiedReq?.headers)
                    : { 'host': getCorrectHost(reqUrl, clientReq.headers, modifiedReq?.headers) }
            );

            headersManuallyModified = !!modifiedReq?.headers;

            validateCustomHeaders(
                completedRequest.headers,
                modifiedReq?.headers,
                OVERRIDABLE_REQUEST_PSEUDOHEADERS // These are handled by getCorrectPseudoheaders above
            );

            if (modifiedReq?.json) {
                headers['content-type'] = 'application/json';
                reqBodyOverride = asBuffer(JSON.stringify(modifiedReq?.json));
            } else {
                reqBodyOverride = getCallbackResultBody(modifiedReq?.body);
            }

            if (reqBodyOverride !== undefined) {
                headers['content-length'] = getCorrectContentLength(
                    reqBodyOverride,
                    clientReq.headers,
                    modifiedReq?.headers
                );
            }
            headers = dropUndefinedValues(headers);

            // Reparse the new URL, if necessary
            if (modifiedReq?.url) {
                if (!isAbsoluteUrl(modifiedReq?.url)) throw new Error("Overridden request URLs must be absolute");
                ({ protocol, hostname, port, path } = url.parse(reqUrl));
            }
        }

        const hostWithPort = `${hostname}:${port}`

        // Ignore cert errors if the host+port or whole hostname is whitelisted
        const strictHttpsChecks = !_.includes(this.ignoreHostHttpsErrors, hostname) &&
            !_.includes(this.ignoreHostHttpsErrors, hostWithPort);

        // Use a client cert if it's listed for the host+port or whole hostname
        const clientCert = this.clientCertificateHostMap[hostWithPort] ||
            this.clientCertificateHostMap[hostname!] ||
            {};

        // We only do H2 upstream for HTTPS. Http2-wrapper doesn't support H2C, it's rarely used
        // and we can't use ALPN to detect HTTP/2 support cleanly.
        let shouldTryH2Upstream = isH2Downstream && protocol === 'https:';

        const effectivePort = !!port
            ? parseInt(port, 10)
            : (protocol === 'https:' ? 443 : 80);

        let family: undefined | 4 | 6;
        if (hostname === 'localhost') {
            // Annoying special case: some localhost servers listen only on either ipv4 or ipv6.
            // Very specific situation, but a very common one for development use.
            // We need to work out which one family is, as Node sometimes makes bad choices.

            if (await isLocalPortActive('::1', effectivePort)) family = 6;
            else family = 4;
        }

        // Mirror the keep-alive-ness of the incoming request in our outgoing request
        const agent = getAgent({
            protocol: (protocol || undefined) as 'http:' | 'https:' | undefined,
            hostname: hostname!,
            port: effectivePort,
            tryHttp2: shouldTryH2Upstream,
            keepAlive: shouldKeepAlive(clientReq),
            proxyConfig: this.proxyConfig
        });

        if (agent && !('http2' in agent)) {
            // I.e. only use HTTP/2 if we're using an HTTP/2-compatible agent
            shouldTryH2Upstream = false;
        }

        let makeRequest = (
            shouldTryH2Upstream
                ? h2Client.auto
            // HTTP/1 + TLS
            : protocol === 'https:'
                ? https.request
            // HTTP/1 plaintext:
                : http.request
        ) as typeof https.request;

        if (isH2Downstream && shouldTryH2Upstream) {
            // We drop all incoming pseudoheaders, and regenerate them (except legally modified ones)
            headers = _.pickBy(headers, (value, key) =>
                !key.toString().startsWith(':') ||
                (headersManuallyModified &&
                    OVERRIDABLE_REQUEST_PSEUDOHEADERS.includes(key as any)
                )
            );
        } else if (isH2Downstream && !shouldTryH2Upstream) {
            headers = h2HeadersToH1(headers);
        }

        let serverReq: http.ClientRequest;
        return new Promise<void>((resolve, reject) => (async () => { // Wrapped to easily catch (a)sync errors
            serverReq = await makeRequest({
                protocol,
                method,
                hostname,
                port,
                family,
                path,
                headers,
                lookup: this.lookup(),
                agent,
                minVersion: strictHttpsChecks ? tls.DEFAULT_MIN_VERSION : 'TLSv1', // Allow TLSv1, if !strict
                rejectUnauthorized: strictHttpsChecks,
                ...clientCert
            }, (serverRes) => (async () => {
                serverRes.on('error', reject);

                let serverStatusCode = serverRes.statusCode!;
                let serverStatusMessage = serverRes.statusMessage
                let serverHeaders = serverRes.headers;
                let resBodyOverride: Buffer | undefined;

                if (isH2Downstream) {
                    serverHeaders = h1HeadersToH2(serverHeaders);
                }

                if (this.transformResponse) {
                    const {
                        replaceStatus,
                        updateHeaders,
                        replaceHeaders,
                        replaceBody,
                        replaceBodyFromFile,
                        updateJsonBody
                    } = this.transformResponse;

                    if (replaceStatus) {
                        serverStatusCode = replaceStatus;
                        serverStatusMessage = undefined; // Reset to default
                    }

                    if (updateHeaders) {
                        serverHeaders = {
                            ...serverHeaders,
                            ...updateHeaders
                        };
                    } else if (replaceHeaders) {
                        serverHeaders = { ...replaceHeaders };
                    }

                    if (replaceBody) {
                        // Note that we're replacing the body without actually waiting for the real one, so
                        // this can result in sending a request much more quickly!
                        resBodyOverride = asBuffer(replaceBody);
                    } else if (replaceBodyFromFile) {
                        resBodyOverride = await readFile(replaceBodyFromFile, null);
                    } else if (updateJsonBody) {
                        const rawBody = await streamToBuffer(serverRes);
                        const realBody = buildBodyReader(rawBody, serverRes.headers);

                        if (await realBody.getJson() === undefined) {
                            throw new Error("Can't transform non-JSON response body");
                        }

                        const updatedBody = _.mergeWith(
                            await realBody.getJson(),
                            updateJsonBody,
                            (_oldValue, newValue) => {
                                // We want to remove values with undefines, but Lodash ignores
                                // undefined return values here. Fortunately, JSON.stringify
                                // ignores Symbols, omitting them from the result.
                                if (newValue === undefined) return OMIT_SYMBOL;
                            }
                        );

                        resBodyOverride = asBuffer(JSON.stringify(updatedBody));
                    }

                    if (resBodyOverride) {
                        // We always re-encode the body to match the resulting content-encoding header:
                        resBodyOverride = await encodeBuffer(
                            resBodyOverride,
                            (serverHeaders['content-encoding'] || '') as SUPPORTED_ENCODING
                        );

                        serverHeaders['content-length'] = getCorrectContentLength(
                            resBodyOverride,
                            serverRes.headers,
                            (updateHeaders && updateHeaders['content-length'] !== undefined)
                                ? serverHeaders // Iff you replaced the content length
                                : replaceHeaders,
                            method === 'HEAD' // HEAD responses are allowed mismatched content-length
                        );
                    }

                    serverHeaders = dropUndefinedValues(serverHeaders);
                } else if (this.beforeResponse) {
                    let modifiedRes: CallbackResponseResult | void;
                    let body: Buffer;

                    body = await streamToBuffer(serverRes);
                    const cleanHeaders = cleanUpHeaders(serverHeaders);

                    modifiedRes = await this.beforeResponse({
                        id: clientReq.id,
                        statusCode: serverStatusCode,
                        statusMessage: serverRes.statusMessage,
                        headers: _.clone(cleanHeaders),
                        body: buildBodyReader(body, serverHeaders)
                    });

                    if (modifiedRes === 'close') {
                        // Dump the real response data and kill the client socket:
                        serverRes.resume();
                        (clientRes as any).socket.end();
                        throw new AbortError('Connection closed (intentionally)');
                    }

                    validateCustomHeaders(cleanHeaders, modifiedRes?.headers);

                    serverStatusCode = modifiedRes?.statusCode ||
                        modifiedRes?.status ||
                        serverStatusCode;
                    serverStatusMessage = modifiedRes?.statusMessage ||
                        serverStatusMessage;

                    serverHeaders = modifiedRes?.headers || serverHeaders;

                    if (modifiedRes?.json) {
                        serverHeaders['content-type'] = 'application/json';
                        resBodyOverride = asBuffer(JSON.stringify(modifiedRes?.json));
                    } else {
                        resBodyOverride = getCallbackResultBody(modifiedRes?.body);
                    }

                    if (resBodyOverride !== undefined) {
                        serverHeaders['content-length'] = getCorrectContentLength(
                            resBodyOverride,
                            serverRes.headers,
                            modifiedRes?.headers,
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
                    if (
                        headerValue === undefined ||
                        (header as unknown) === http2.sensitiveHeaders ||
                        header === ':status' // H2 status gets set by writeHead below
                    ) return;

                    try {
                        clientRes.setHeader(header, headerValue);
                    } catch (e) {
                        // A surprising number of real sites have slightly invalid headers
                        // (e.g. extra spaces). If we hit any, we just drop that header
                        // and print a warning.
                        console.log(`Error setting header on passthrough response: ${e.message}`);
                    }
                });

                clientRes.writeHead(
                    serverStatusCode,
                    serverStatusMessage || clientRes.statusMessage
                );

                if (resBodyOverride) {
                    // Return the override data to the client:
                    clientRes.end(resBodyOverride);
                    // Dump the real response data:
                    serverRes.resume();

                    resolve();
                } else {
                    serverRes.pipe(clientRes);
                    serverRes.once('end', resolve);
                }
            })().catch(reject));

            serverReq.once('socket', (socket: net.Socket) => {
                // This event can fire multiple times for keep-alive sockets, which are used to
                // make multiple requests. If/when that happens, we don't need more event listeners.
                if (this.outgoingSockets.has(socket)) return;

                // Add this port to our list of active ports, once it's connected (before then it has no port)
                if (socket.connecting) {
                    socket.once('connect', () => {
                        this.outgoingSockets.add(socket)
                    });
                } else if (socket.localPort !== undefined) {
                    this.outgoingSockets.add(socket);
                }

                // Remove this port from our list of active ports when it's closed
                // This is called for both clean closes & errors.
                socket.once('close', () => this.outgoingSockets.delete(socket));
            });

            if (reqBodyOverride) {
                clientReq.body.asStream().resume(); // Dump any remaining real request body

                if (reqBodyOverride.length > 0) serverReq.end(reqBodyOverride);
                else serverReq.end(); // http2-wrapper fails given an empty buffer for methods that aren't allowed a body
            } else {
                // asStream includes all content, including the body before this call
                const reqBodyStream = clientReq.body.asStream();
                reqBodyStream.pipe(serverReq);
                reqBodyStream.on('error', () => serverReq.abort());
            }

            // If the downstream connection aborts, before the response has been completed,
            // we also abort the upstream connection. Important to avoid unnecessary connections,
            // and to correctly proxy client connection behaviour to the upstream server.
            function abortUpstream() {
                serverReq.abort();
            }
            clientReq.on('aborted', abortUpstream);
            clientRes.once('finish', () => clientReq.removeListener('aborted', abortUpstream));

            serverReq.on('error', (e: any) => {
                if ((<any>serverReq).aborted) return;

                // Tag responses, so programmatic examination can react to this
                // event, without having to parse response data or similar.
                const tlsAlertMatch = /SSL alert number (\d+)/.exec(e.message);
                if (tlsAlertMatch) {
                    clientRes.tags.push('passthrough-tls-error:ssl-alert-' + tlsAlertMatch[1]);
                }
                clientRes.tags.push('passthrough-error:' + e.code);

                if (e.code === 'ECONNRESET') {
                    // The upstream socket closed: forcibly close the downstream stream to match
                    const socket: net.Socket = (clientReq as any).socket;
                    socket.destroy();
                    reject(new AbortError('Upstream connection was reset'));
                } else {
                    e.statusCode = 502;
                    e.statusMessage = 'Error communicating with upstream server';
                    reject(e);
                }
            });

            // We always start upstream connections *immediately*. This might be less efficient, but it
            // ensures that we're accurately mirroring downstream, which has indeed already connected.
            serverReq.flushHeaders();

            // For similar reasons, we don't want any buffering on outgoing data at all if possible:
            serverReq.setNoDelay(true);
        })().catch((e) => {
            // Catch otherwise-unhandled sync or async errors in the above promise:
            if (serverReq) serverReq.destroy();
            clientRes.tags.push('passthrough-error:' + e.code);
            reject(e);
        }));
    }

    /**
     * @internal
     */
    serialize(channel: ClientServerChannel): SerializedPassThroughData {
        if (this.beforeRequest) {
            channel.onRequest<
                BeforePassthroughRequestRequest,
                CallbackRequestResult | undefined
            >('beforeRequest', async (req) => {
                const callbackResult = await this.beforeRequest!(
                    withDeserializedBodyReader(req.args[0])
                );

                const serializedResult = callbackResult
                    ? withSerializedBodyBuffer(callbackResult)
                    : undefined;

                if (serializedResult?.response && typeof serializedResult?.response !== 'string') {
                    serializedResult.response = withSerializedBodyBuffer(serializedResult.response);
                }

                return serializedResult;
            });
        }

        if (this.beforeResponse) {
            channel.onRequest<
                BeforePassthroughResponseRequest,
                CallbackResponseResult | undefined
            >('beforeResponse', async (req) => {
                const callbackResult = await this.beforeResponse!(
                    withDeserializedBodyReader(req.args[0])
                );

                if (typeof callbackResult === 'string') {
                    return callbackResult;
                } else if (callbackResult) {
                    return withSerializedBodyBuffer(callbackResult);
                } else {
                    return undefined;
                }
            });
        }

        return {
            type: this.type,
            ...this.forwarding ? {
                forwardToLocation: this.forwarding.targetHost,
                forwarding: this.forwarding
            } : {},
            proxyConfig: this.proxyConfig,
            lookupOptions: this.lookupOptions,
            ignoreHostCertificateErrors: this.ignoreHostHttpsErrors,
            clientCertificateHostMap: _.mapValues(this.clientCertificateHostMap,
                ({ pfx, passphrase }) => ({ pfx: serializeBuffer(pfx), passphrase })
            ),
            transformRequest: {
                ...this.transformRequest,
                // Body is always serialized as a base64 buffer:
                replaceBody: !!this.transformRequest?.replaceBody
                    ? serializeBuffer(asBuffer(this.transformRequest.replaceBody))
                    : undefined,
                // Update objects need to capture undefined & null as distict values:
                updateHeaders: !!this.transformRequest?.updateHeaders
                    ? JSON.stringify(
                        this.transformRequest.updateHeaders,
                        (k, v) => v === undefined ? SERIALIZED_OMIT : v
                    )
                    : undefined,
                updateJsonBody: !!this.transformRequest?.updateJsonBody
                    ? JSON.stringify(
                        this.transformRequest.updateJsonBody,
                        (k, v) => v === undefined ? SERIALIZED_OMIT : v
                    )
                    : undefined
            },
            transformResponse: {
                ...this.transformResponse,
                // Body is always serialized as a base64 buffer:
                replaceBody: !!this.transformResponse?.replaceBody
                    ? serializeBuffer(asBuffer(this.transformResponse.replaceBody))
                    : undefined,
                // Update objects need to capture undefined & null as distict values:
                updateHeaders: !!this.transformResponse?.updateHeaders
                    ? JSON.stringify(
                        this.transformResponse.updateHeaders,
                        (k, v) => v === undefined ? SERIALIZED_OMIT : v
                    )
                    : undefined,
                updateJsonBody: !!this.transformResponse?.updateJsonBody
                    ? JSON.stringify(
                        this.transformResponse.updateJsonBody,
                        (k, v) => v === undefined ? SERIALIZED_OMIT : v
                    )
                    : undefined
            },
            hasBeforeRequestCallback: !!this.beforeRequest,
            hasBeforeResponseCallback: !!this.beforeResponse
        };
    }

    /**
     * @internal
     */
    static deserialize(data: SerializedPassThroughData, channel: ClientServerChannel): PassThroughHandler {
        let beforeRequest: ((req: CompletedRequest) => MaybePromise<CallbackRequestResult | void>) | undefined;
        let beforeResponse: ((res: PassThroughResponse) => MaybePromise<CallbackResponseResult | void>) | undefined;

        if (data.hasBeforeRequestCallback) {
            beforeRequest = async (req: CompletedRequest) => {
                const result = withDeserializedBodyBuffer<WithSerializedBodyBuffer<CallbackRequestResult>>(
                    await channel.request<
                        BeforePassthroughRequestRequest,
                        WithSerializedBodyBuffer<CallbackRequestResult>
                    >('beforeRequest', {
                        args: [withSerializedBodyReader(req)]
                    })
                );

                if (result.response && typeof result.response !== 'string') {
                    result.response = withDeserializedBodyBuffer(
                        result.response as WithSerializedBodyBuffer<CallbackResponseMessageResult>
                    );
                }

                return result;
            };
        }

        if (data.hasBeforeResponseCallback) {
            beforeResponse = async (res: PassThroughResponse) => {
                const callbackResult = await channel.request<
                    BeforePassthroughResponseRequest,
                    WithSerializedBodyBuffer<CallbackResponseMessageResult> | 'close' | undefined
                >('beforeResponse', {
                    args: [withSerializedBodyReader(res)]
                })

                if (callbackResult && typeof callbackResult !== 'string') {
                    return withDeserializedBodyBuffer(callbackResult);
                } else {
                    return callbackResult;
                }
            };
        }

        return new PassThroughHandler({
            beforeRequest,
            beforeResponse,
            transformRequest: {
                ...data.transformRequest,
                ...(data.transformRequest?.replaceBody !== undefined ? {
                    replaceBody: deserializeBuffer(data.transformRequest.replaceBody)
                } : {}),
                ...(data.transformRequest?.updateHeaders !== undefined ? {
                    updateHeaders: mapOmitToUndefined(JSON.parse(data.transformRequest.updateHeaders))
                } : {}),
                ...(data.transformRequest?.updateJsonBody !== undefined ? {
                    updateJsonBody: mapOmitToUndefined(JSON.parse(data.transformRequest.updateJsonBody))
                } : {}),
            } as RequestTransform,
            transformResponse: {
                ...data.transformResponse,
                ...(data.transformResponse?.replaceBody !== undefined ? {
                    replaceBody: deserializeBuffer(data.transformResponse.replaceBody)
                } : {}),
                ...(data.transformResponse?.updateHeaders !== undefined ? {
                    updateHeaders: mapOmitToUndefined(JSON.parse(data.transformResponse.updateHeaders))
                } : {}),
                ...(data.transformResponse?.updateJsonBody !== undefined ? {
                    updateJsonBody: mapOmitToUndefined(JSON.parse(data.transformResponse.updateJsonBody))
                } : {})
            } as ResponseTransform,
            // Backward compat for old clients:
            ...data.forwardToLocation ? {
                forwarding: { targetHost: data.forwardToLocation }
            } : {},
            forwarding: data.forwarding,
            proxyConfig: data.proxyConfig,
            lookupOptions: data.lookupOptions,
            ignoreHostHttpsErrors: data.ignoreHostCertificateErrors,
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
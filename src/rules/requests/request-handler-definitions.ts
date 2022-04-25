import _ = require('lodash');
import url = require('url');
import type * as net from 'net';
import { encode as encodeBase64 } from 'base64-arraybuffer';
import { Readable, Transform } from 'stream';
import { stripIndent } from 'common-tags';

import {
    Headers,
    CompletedRequest,
    CompletedBody,
    Explainable
} from "../../types";

import { MaybePromise, Replace } from '../../util/type-utils';
import { buildBodyReader } from '../../util/request-utils';
import { asBuffer } from '../../util/buffer-utils';
import {
    Serializable,
    ClientServerChannel,
    serializeBuffer,
    SerializedProxyConfig,
    serializeProxyConfig
} from "../../serialization/serialization";
import {
    withDeserializedBodyReader,
    withSerializedBodyBuffer
} from '../../serialization/body-serialization';
import { ProxyConfig } from '../proxy-config';

/*
This file defines request handler *definitions*, which includes everything necessary to define
and serialize a request handler's behaviour, but doesn't include the actual handling logic (which
lives in ./request-handlers instead). This is intended to allow tree-shaking in browser usage
or remote clients to import only the necessary code, with no need to include all the real
request-processing and handling code that is only used at HTTP-runtime, so isn't relevant when
defining rules.

Every RequestHandler extends its definition, simply adding a handle() method, which handles
requests according to the configuration, and adding a deserialize static method that takes
the serialized output from the serialize() methods defined here and creates a working handler.
*/

export interface RequestHandlerDefinition extends Explainable, Serializable {
    type: keyof typeof HandlerDefinitionLookup;
}

export type SerializedBuffer = { type: 'Buffer', data: number[] };

/**
 * Can be returned from callbacks to override parts of a request.
 *
 * All fields are optional, and omitted values will default to the original
 * request value.
 */
export interface CallbackRequestResult {
    /**
     * A replacement HTTP method, capitalized.
     */
    method?: string;

    /**
     * The full URL to send the request to. If set, this will redirect
     * the request and automatically update the Host header accordingly,
     * unless you also provide a `headers` value that includes a Host
     * header, in which case that will take used as-is.
     */
    url?: string;

    /**
     * The replacement HTTP headers, as an object of string keys and either
     * single string or array of string values.
     */
    headers?: Headers;

    /**
     * A string or buffer, which replaces the request body if set. This will
     * be automatically content-encoded to match the Content-Encoding defined
     * in your request headers.
     *
     * If this is set, the Content-Length header will be automatically updated
     * accordingly to match, unless you also provide a `headers` value that
     * includes a Content-Length header, in which case that will take used
     * as-is.
     *
     * You should only return one body field: either `body` or `json`.
     */
    body?: string | Buffer | Uint8Array;

    /**
     * A JSON value, which will be stringified and send as a JSON-encoded
     * request body. This will be automatically content-encoded to match
     * the Content-Encoding defined in your request headers.
     *
     * If this is set, the Content-Length header will be automatically updated
     * accordingly to match, unless you also provide a `headers` value that
     * includes a Content-Length header, in which case that will take used
     * as-is.
     *
     * You should only return one body field: either `body` or `json`.
     */
    json?: any;

    /**
     * A response: either a response object defining the fields of a response
     * or the string 'close' to immediately close the connection.
     *
     * See {@link CallbackResponseMessageResult} for the possible fields that can
     * be set to define the response.
     *
     * If set, the request will not be forwarded at all, and this will be used
     * as the response to immediately return to the client (or for 'close', this
     * will immediately close the connection to the client).
     */
    response?: CallbackResponseResult;
}

export type CallbackResponseResult =
    | CallbackResponseMessageResult
    | 'close';

/**
 * Can be returned from callbacks to define parts of a response, or
 * override parts when given an existing repsonse.
 *
 * All fields are optional, and omitted values will default to the original
 * response value or a default value.
 */
export interface CallbackResponseMessageResult {
    /**
     * The response status code as a number.
     *
     * Defaults to 200 if not set.
     */
    statusCode?: number;

    /**
     * Supported only for backward compatibility.
     *
     * @deprecated Use statusCode instead.
     */
    status?: number;

    /**
     * The response status message, as a string. This is ignored for
     * HTTP/2 responses.
     *
     * Defaults to the default status message for the status code if not set.
     */
    statusMessage?: string;

    /**
     * The replacement HTTP headers, as an object of string keys and either
     * single string or array of string values.
     *
     * Defaults to a minimum set of standard required headers if not set.
     */
    headers?: Headers;

    /**
     * A string or buffer, which replaces the response body if set. This will
     * be automatically encoded to match the Content-Encoding defined in your
     * response headers.
     *
     * If this is set, the Content-Length header will be automatically updated
     * accordingly to match, unless you also provide a `headers` value that
     * includes a Content-Length header, in which case that will take used
     * as-is.
     *
     * Defaults to empty.
     *
     * You should only return one body field: either `body` or `json`.
     */
    body?: string | Buffer | Uint8Array;

    /**
     * A JSON value, which will be stringified and send as a JSON-encoded
     * request body. This will be automatically content-encoded to match the
     * Content-Encoding defined in your response headers.
     *
     * If this is set, the Content-Length header will be automatically updated
     * accordingly to match, unless you also provide a `headers` value that
     * includes a Content-Length header, in which case that will take used
     * as-is.
     *
     * You should only return one body field: either `body` or `json`.
     */
    json?: any;
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

export class SimpleHandlerDefinition extends Serializable implements RequestHandlerDefinition {
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
}

/**
 * @internal
 */
export interface SerializedCallbackHandlerData {
    type: string;
    name?: string;
    version?: number;
}

/**
 * @internal
 */
export interface CallbackRequestMessage {
    args: [
        | Replace<CompletedRequest, 'body', string> // New format
        | CompletedRequest // Old format with directly serialized body
    ];
}

export class CallbackHandlerDefinition extends Serializable implements RequestHandlerDefinition {
    readonly type = 'callback';

    constructor(
        public callback: (request: CompletedRequest) => MaybePromise<CallbackResponseResult>
    ) {
        super();
    }

    explain() {
        return 'respond using provided callback' + (this.callback.name ? ` (${this.callback.name})` : '');
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
}

/**
 * @internal
 */
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

export class StreamHandlerDefinition extends Serializable implements RequestHandlerDefinition {
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
}

export class FileHandlerDefinition extends Serializable implements RequestHandlerDefinition {
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
     * An array of additional certificates, which should be trusted as certificate
     * authorities for upstream hosts, in addition to Node.js's built-in certificate
     * authorities.
     *
     * Each certificate should be an object with either a `cert` key and a string
     * or buffer value containing the PEM certificate, or a `certPath` key and a
     * string value containing the local path to the PEM certificate.
     */
    trustAdditionalCAs?: Array<{ cert: string | Buffer } | { certPath: string }>;

    /**
     * A mapping of hosts to client certificates to use, in the form of
     * `{ key, cert }` objects (none, by default)
     */
    clientCertificateHostMap?: {
        [host: string]: { pfx: Buffer, passphrase?: string }
    };

    /**
     * Upstream proxy configuration: pass through requests via this proxy.
     *
     * If this is undefined, no proxy will be used. To configure a proxy
     * provide either:
     * - a ProxySettings object
     * - a callback which will be called with an object containing the
     *   hostname, and must return a ProxySettings object or undefined.
     * - an array of ProxySettings or callbacks. The array will be
     *   processed in order, and the first not-undefined ProxySettings
     *   found will be used.
     *
     * When using a remote client, this parameter or individual array
     * values may be passed by reference, using the name of a rule
     * parameter configured in the admin server.
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
     * to returning an empty object (transforming nothing).
     *
     * See {@link CallbackRequestResult} for the possible fields that can be set.
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
     * to returning an empty object (transforming nothing).
     *
     * See {@link CallbackResponseMessageResult} for the possible fields that can be set.
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

/**
 * @internal
 */
export interface SerializedPassThroughData {
    type: 'passthrough';
    forwardToLocation?: string;
    forwarding?: ForwardingOptions;
    proxyConfig?: SerializedProxyConfig;
    ignoreHostCertificateErrors?: string[]; // Doesn't match option name, backward compat
    extraCACertificates?: Array<{ cert: string } | { certPath: string }>;
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

/**
 * @internal
 */
export interface BeforePassthroughRequestRequest {
    args: [Replace<CompletedRequest, 'body', string>];
}

/**
 * @internal
 */
export interface BeforePassthroughResponseRequest {
    args: [Replace<PassThroughResponse, 'body', string>];
}

/**
 * Used in merging as a marker for values to omit, because lodash ignores undefineds.
 * @internal
 */
export const SERIALIZED_OMIT = "__mockttp__transform__omit__";

export class PassThroughHandlerDefinition extends Serializable implements RequestHandlerDefinition {
    readonly type = 'passthrough';

    public readonly forwarding?: ForwardingOptions;

    public readonly ignoreHostHttpsErrors: string[] = [];
    public readonly clientCertificateHostMap: {
        [host: string]: { pfx: Buffer, passphrase?: string }
    };

    public readonly extraCACertificates: Array<{ cert: string | Buffer } | { certPath: string }> = [];

    public readonly transformRequest?: RequestTransform;
    public readonly transformResponse?: ResponseTransform;

    public readonly beforeRequest?: (req: CompletedRequest) =>
        MaybePromise<CallbackRequestResult | void> | void;
    public readonly beforeResponse?: (res: PassThroughResponse) =>
        MaybePromise<CallbackResponseResult | void> | void;

    public readonly proxyConfig?: ProxyConfig;

    public readonly lookupOptions?: PassThroughLookupOptions;

    // Used in subclass - awkwardly needs to be initialized here to ensure that its set when using a
    // handler built from a definition. In future, we could improve this (compose instead of inheritance
    // to better control handler construction?) but this will do for now.
    protected outgoingSockets = new Set<net.Socket>();

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

        this.ignoreHostHttpsErrors = options.ignoreHostHttpsErrors || [];
        if (!Array.isArray(this.ignoreHostHttpsErrors)) {
            throw new Error("ignoreHostHttpsErrors must be an array");
        }

        this.lookupOptions = options.lookupOptions;
        this.proxyConfig = options.proxyConfig;

        this.clientCertificateHostMap = options.clientCertificateHostMap || {};
        this.extraCACertificates = options.trustAdditionalCAs || [];

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
            proxyConfig: serializeProxyConfig(this.proxyConfig, channel),
            lookupOptions: this.lookupOptions,
            ignoreHostCertificateErrors: this.ignoreHostHttpsErrors,
            extraCACertificates: this.extraCACertificates.map((certObject) => {
                // We use toString to make sure that buffers always end up as
                // as UTF-8 string, to avoid serialization issues. Strings are an
                // easy safe format here, since it's really all just plain-text PEM
                // under the hood.
                if ('cert' in certObject) {
                    return { cert: certObject.cert.toString('utf8') }
                } else {
                    return certObject;
                }
            }),
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
}

export class CloseConnectionHandlerDefinition extends Serializable implements RequestHandlerDefinition {
    readonly type = 'close-connection';

    explain() {
        return 'close the connection';
    }
}

export class TimeoutHandlerDefinition extends Serializable implements RequestHandlerDefinition {
    readonly type = 'timeout';

    explain() {
        return 'time out (never respond)';
    }
}

export const HandlerDefinitionLookup = {
    'simple': SimpleHandlerDefinition,
    'callback': CallbackHandlerDefinition,
    'stream': StreamHandlerDefinition,
    'file': FileHandlerDefinition,
    'passthrough': PassThroughHandlerDefinition,
    'close-connection': CloseConnectionHandlerDefinition,
    'timeout': TimeoutHandlerDefinition
}
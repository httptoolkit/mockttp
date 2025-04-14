import _ = require('lodash');
import url = require('url');
import type * as net from 'net';
import { encode as encodeBase64 } from 'base64-arraybuffer';
import { Readable, Transform } from 'stream';
import { stripIndent } from 'common-tags';
import {
    Operation as JsonPatchOperation,
    validate as validateJsonPatch
} from 'fast-json-patch';

import {
    Headers,
    Trailers,
    CompletedRequest,
    CompletedBody,
    Explainable,
    RawHeaders
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
    withSerializedCallbackBuffers
} from '../../serialization/body-serialization';
import { ProxyConfig } from '../proxy-config';
import {
    CADefinition,
    ForwardingOptions,
    PassThroughHandlerConnectionOptions,
    PassThroughLookupOptions
} from '../passthrough-handling-definitions';

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
     * You should only return one body field: either `body`, `rawBody` or
     * `json`.
     */
    body?: string | Buffer | Uint8Array;

    /**
     * A buffer, which replaces the request body if set, which is sent exactly
     * as is, and is not automatically encoded.
     *
     * If this is set, the Content-Length header will be automatically updated
     * accordingly to match, unless you also provide a `headers` value that
     * includes a Content-Length header, in which case that will take used
     * as-is.
     *
     * You should only return one body field: either `body`, `rawBody` or
     * `json`.
     */
    rawBody?: Buffer | Uint8Array;

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
     * You should only return one body field: either `body`, `rawBody` or
     * `json`.
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
    | 'close'
    | 'reset';

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
     * The replacement HTTP trailers, as an object of string keys and either
     * single string or array of string values. Note that there are not all
     * header fields are valid as trailers, and there are other requirements
     * such as chunked encoding that must be met for trailers to be sent
     * successfully.
     */
    trailers?: Trailers;

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
     * You should only return one body field: either `body`, `rawBody` or
     * `json`.
     */
    body?: string | Buffer | Uint8Array;

    /**
     * A buffer, which replaces the response body if set, which is sent exactly
     * as is, and is not automatically encoded.
     *
     * If this is set, the Content-Length header will be automatically updated
     * accordingly to match, unless you also provide a `headers` value that
     * includes a Content-Length header, in which case that will take used
     * as-is.
     *
     * You should only return one body field: either `body`, `rawBody` or
     * `json`.
     */
    rawBody?: Buffer | Uint8Array;

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
     * You should only return one body field: either `body`, `rawBody` or
     * `json`.
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
        public headers?: Headers,
        public trailers?: Trailers
    ) {
        super();

        validateCustomHeaders({}, headers);
        validateCustomHeaders({}, trailers);

        if (!_.isEmpty(trailers) && headers) {
            if (!Object.entries(headers!).some(([key, value]) =>
                key.toLowerCase() === 'transfer-encoding' && value === 'chunked'
            )) {
                throw new Error("Trailers can only be set when using chunked transfer encoding");
            }
        }
    }

    explain() {
        return `respond with status ${this.status}` +
            (this.statusMessage ? ` (${this.statusMessage})`: "") +
            (this.headers ? `, headers ${JSON.stringify(this.headers)}` : "") +
            (this.data ? ` and body "${this.data}"` : "") +
            (this.trailers ? `then trailers ${JSON.stringify(this.trailers)}` : "");
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
        | Replace<CompletedRequest, { body: string }> // New format
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
                    streamMsg.args[0] as Replace<CompletedRequest, { body: string }>
                )
                : { // Backward compat: old fully-serialized format
                    ...streamMsg.args[0],
                    body: buildBodyReader(streamMsg.args[0].body.buffer, streamMsg.args[0].headers)
                };

            const callbackResult = await this.callback.call(null, request);

            if (typeof callbackResult === 'string') {
                return callbackResult;
            } else {
                return withSerializedCallbackBuffers(callbackResult);
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
                    (_.isArrayBuffer(chunk) || _.isTypedArray(chunk))
                        ? { type: 'arraybuffer', value: encodeBase64(chunk) }
                        : _.isNil(chunk) && { type: 'nil' };

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

// This is different from CompletedResponse because CompletedResponse is a client request to Mockttp
// whereas this is a real response from an upstream server that we modify before forwarding.
// We aim for a similar shape, but they're not exactly the same.
export interface PassThroughResponse {
    id: string;
    statusCode: number;
    statusMessage?: string;
    headers: Headers;
    rawHeaders: RawHeaders;
    body: CompletedBody;
}

export interface PassThroughHandlerOptions extends PassThroughHandlerConnectionOptions {
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
     * be transformed before it's returned to the client. The callback is also passed
     * the request that was sent to the server (as a 2nd parameter) for reference.
     *
     * The callback can either return an object to define how the response should be
     * changed, or the strings 'close' or 'reset' to immediately close/reset the
     * underlying connection.
     *
     * All fields on the object are optional, and returning undefined is equivalent
     * to returning an empty object (transforming nothing).
     *
     * See {@link CallbackResponseMessageResult} for the possible fields that can be set.
     */
    beforeResponse?: (res: PassThroughResponse, req: CompletedRequest) => MaybePromise<CallbackResponseResult | void> | void;
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
     * will be removed, and other values will be merged directly with the target value
     * recursively.
     *
     * Any requests which are received with an invalid JSON body that match this rule
     * will fail.
     */
    updateJsonBody?: {
        [key: string]: any;
    };

    /**
     * A series of operations to apply to the request body in JSON Patch format (RFC
     * 6902).
     *
     * Any requests which are received with an invalid JSON body that match this rule
     * will fail.
     */
    patchJsonBody?: Array<JsonPatchOperation>;

    /**
     * Perform a series of string match & replace operations on the request body.
     *
     * This parameter should be an array of pairs, which will be applied to the body
     * decoded as a string like `body.replace(p1, p2)`, applied in the order provided.
     * The first parameter can be either a string or RegExp to match, and the second
     * must be a string to insert. The normal `str.replace` $ placeholders can be
     * used in the second argument, so that e.g. $1 will insert the 1st matched group.
     */
    matchReplaceBody?: Array<[string | RegExp, string]>;
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
     * will be removed, and other values will be merged directly with the target value
     * recursively.
     *
     * Any responses which are received with an invalid JSON body that match this rule
     * will fail.
     */
    updateJsonBody?: {
        [key: string]: any;
    };

    /**
     * A series of operations to apply to the response body in JSON Patch format (RFC
     * 6902).
     *
     * Any responses which are received with an invalid JSON body that match this rule
     * will fail.
     */
    patchJsonBody?: Array<JsonPatchOperation>;

    /**
     * Perform a series of string match & replace operations on the response body.
     *
     * This parameter should be an array of pairs, which will be applied to the body
     * decoded as a string like `body.replace(p1, p2)`, applied in the order provided.
     * The first parameter can be either a string or RegExp to match, and the second
     * must be a string to insert. The normal `str.replace` $ placeholders can be
     * used in the second argument, so that e.g. $1 will insert the 1st matched group.
     */
    matchReplaceBody?: Array<[string | RegExp, string]>;

}

/**
 * @internal
 */
export interface SerializedPassThroughData {
    type: 'passthrough';
    forwardToLocation?: string;
    forwarding?: ForwardingOptions;
    proxyConfig?: SerializedProxyConfig;
    ignoreHostCertificateErrors?: string[] | boolean; // Doesn't match option name, backward compat
    extraCACertificates?: Array<{ cert: string } | { certPath: string }>;
    clientCertificateHostMap?: { [host: string]: { pfx: string, passphrase?: string } };
    lookupOptions?: PassThroughLookupOptions;
    simulateConnectionErrors?: boolean;

    transformRequest?: Replace<RequestTransform, {
        'replaceBody'?: string, // Serialized as base64 buffer
        'updateHeaders'?: string, // // Serialized as a string to preserve undefined values
        'updateJsonBody'?: string, // Serialized as a string to preserve undefined values
        'matchReplaceBody'?: Array<[
            string | { regexSource: string, flags: string }, // Regexes serialized
            string
        ]>
    }>,
    transformResponse?: Replace<ResponseTransform, {
        'replaceBody'?: string, // Serialized as base64 buffer
        'updateHeaders'?: string, // // Serialized as a string to preserve undefined values
        'updateJsonBody'?: string, // Serialized as a string to preserve undefined values
        'matchReplaceBody'?: Array<[
            string | { regexSource: string, flags: string }, // Regexes serialized
            string
        ]>
    }>,

    hasBeforeRequestCallback?: boolean;
    hasBeforeResponseCallback?: boolean;
}

/**
 * @internal
 */
export interface BeforePassthroughRequestRequest {
    args: [Replace<CompletedRequest, { body: string }>];
}

/**
 * @internal
 */
export interface BeforePassthroughResponseRequest {
    args: [Replace<PassThroughResponse, { body: string }>, Replace<CompletedRequest, { body: string }>];
}

/**
 * Used in merging as a marker for values to omit, because lodash ignores undefineds.
 * @internal
 */
export const SERIALIZED_OMIT = "__mockttp__transform__omit__";

export class PassThroughHandlerDefinition extends Serializable implements RequestHandlerDefinition {
    readonly type = 'passthrough';

    public readonly forwarding?: ForwardingOptions;

    public readonly ignoreHostHttpsErrors: string[] | boolean = [];
    public readonly clientCertificateHostMap: {
        [host: string]: { pfx: Buffer, passphrase?: string }
    };

    public readonly extraCACertificates: Array<CADefinition> = [];

    public readonly transformRequest?: RequestTransform;
    public readonly transformResponse?: ResponseTransform;

    public readonly beforeRequest?: (req: CompletedRequest) =>
        MaybePromise<CallbackRequestResult | void> | void;
    public readonly beforeResponse?: (res: PassThroughResponse, req: CompletedRequest) =>
        MaybePromise<CallbackResponseResult | void> | void;

    public readonly proxyConfig?: ProxyConfig;

    public readonly lookupOptions?: PassThroughLookupOptions;

    public readonly simulateConnectionErrors: boolean;

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
        if (!Array.isArray(this.ignoreHostHttpsErrors) && typeof this.ignoreHostHttpsErrors !== 'boolean') {
            throw new Error("ignoreHostHttpsErrors must be an array or a boolean");
        }

        this.lookupOptions = options.lookupOptions;
        this.proxyConfig = options.proxyConfig;
        this.simulateConnectionErrors = !!options.simulateConnectionErrors;

        this.extraCACertificates =
            options.additionalTrustedCAs ||
            options.trustAdditionalCAs ||
            [];

        this.clientCertificateHostMap = options.clientCertificateHostMap || {};

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
                options.transformRequest.updateJsonBody,
                options.transformRequest.patchJsonBody,
                options.transformRequest.matchReplaceBody
            ].filter(o => !!o).length > 1) {
                throw new Error("Only one request body transform can be specified at a time");
            }

            if (options.transformRequest.patchJsonBody) {
                const validationError = validateJsonPatch(options.transformRequest.patchJsonBody);
                if (validationError) throw validationError;
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
                options.transformResponse.updateJsonBody,
                options.transformResponse.patchJsonBody,
                options.transformResponse.matchReplaceBody
            ].filter(o => !!o).length > 1) {
                throw new Error("Only one response body transform can be specified at a time");
            }

            if (options.transformResponse.patchJsonBody) {
                const validationError = validateJsonPatch(options.transformResponse.patchJsonBody);
                if (validationError) throw validationError;
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
                    ? withSerializedCallbackBuffers(callbackResult)
                    : undefined;

                if (serializedResult?.response && typeof serializedResult?.response !== 'string') {
                    serializedResult.response = withSerializedCallbackBuffers(serializedResult.response);
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
                    withDeserializedBodyReader(req.args[0]),
                    withDeserializedBodyReader(req.args[1]),
                );

                if (typeof callbackResult === 'string') {
                    return callbackResult;
                } else if (callbackResult) {
                    return withSerializedCallbackBuffers(callbackResult);
                } else {
                    return undefined;
                }
            });
        }

        return {
            type: this.type,
            ...this.forwarding ? {
                forwarding: this.forwarding,
                // Backward compat:
                forwardToLocation: this.forwarding.targetHost
            } : {},
            proxyConfig: serializeProxyConfig(this.proxyConfig, channel),
            lookupOptions: this.lookupOptions,
            simulateConnectionErrors: this.simulateConnectionErrors,
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
            transformRequest: this.transformRequest ? {
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
                    : undefined,
                matchReplaceBody: !!this.transformRequest?.matchReplaceBody
                    ? this.transformRequest.matchReplaceBody.map(([match, result]) =>
                        [
                            _.isRegExp(match)
                                ? { regexSource: match.source, flags: match.flags }
                                : match,
                            result
                        ]
                    )
                    : undefined,
            } : undefined,
            transformResponse: this.transformResponse ? {
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
                    : undefined,
                matchReplaceBody: !!this.transformResponse?.matchReplaceBody
                    ? this.transformResponse.matchReplaceBody.map(([match, result]) =>
                        [
                            _.isRegExp(match)
                                ? { regexSource: match.source, flags: match.flags }
                                : match,
                            result
                        ]
                    )
                    : undefined,
            } : undefined,
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

export class ResetConnectionHandlerDefinition extends Serializable implements RequestHandlerDefinition {
    readonly type = 'reset-connection';

    explain() {
        return 'reset the connection';
    }
}

export class TimeoutHandlerDefinition extends Serializable implements RequestHandlerDefinition {
    readonly type = 'timeout';

    explain() {
        return 'time out (never respond)';
    }
}

export class JsonRpcResponseHandlerDefinition extends Serializable implements RequestHandlerDefinition {
    readonly type = 'json-rpc-response';

    constructor(
        public readonly result:
            | { result: any, error?: undefined }
            | { error: any, result?: undefined }
    ) {
        super();

        if (!('result' in result) && !('error' in result)) {
            throw new Error('JSON-RPC response must be either a result or an error');
        }
    }

    explain() {
        const resultType = 'result' in this.result
            ? 'result'
            : 'error';

        return `send a fixed JSON-RPC ${resultType} of ${JSON.stringify(this.result[resultType])}`;
    }
}

export const HandlerDefinitionLookup = {
    'simple': SimpleHandlerDefinition,
    'callback': CallbackHandlerDefinition,
    'stream': StreamHandlerDefinition,
    'file': FileHandlerDefinition,
    'passthrough': PassThroughHandlerDefinition,
    'close-connection': CloseConnectionHandlerDefinition,
    'reset-connection': ResetConnectionHandlerDefinition,
    'timeout': TimeoutHandlerDefinition,
    'json-rpc-response': JsonRpcResponseHandlerDefinition
}

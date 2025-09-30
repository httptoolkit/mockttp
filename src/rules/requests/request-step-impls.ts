import { Buffer } from 'buffer';
import { Writable } from 'stream';
import * as url from 'url';
import type * as dns from 'dns';
import * as net from 'net';
import * as tls from 'tls';
import * as http from 'http';
import * as https from 'https';

import * as _ from 'lodash';
import * as fs from 'fs/promises';
import * as h2Client from 'http2-wrapper';
import { decode as decodeBase64 } from 'base64-arraybuffer';
import { Transform } from 'stream';
import { stripIndent, oneLine } from 'common-tags';
import { TypedError } from 'typed-error';
import { applyPatch as applyJsonPatch } from 'fast-json-patch';

import {
    Headers,
    OngoingRequest,
    CompletedRequest,
    OngoingResponse
} from "../../types";

import { MaybePromise, ErrorLike, isErrorLike, delay } from '@httptoolkit/util';
import { isAbsoluteUrl, getEffectivePort } from '../../util/url';
import {
    waitForCompletedRequest,
    buildBodyReader,
    shouldKeepAlive,
    isHttp2,
    writeHead,
    encodeBodyBuffer,
    waitForCompletedResponse
} from '../../util/request-utils';
import {
    h1HeadersToH2,
    h2HeadersToH1,
    objectHeadersToRaw,
    rawHeadersToObject,
    rawHeadersToObjectPreservingCase,
    flattenPairedRawHeaders,
    pairFlatRawHeaders,
    dropDefaultHeaders,
    validateHeader,
    updateRawHeaders,
    getHeaderValue
} from '../../util/header-utils';
import { streamToBuffer, asBuffer } from '../../util/buffer-utils';
import {
    isLocalPortActive,
    isSocketLoop,
    requireSocketResetSupport,
    resetOrDestroy
} from '../../util/socket-util';
import { applyMatchReplace, deserializeMatchReplaceConfiguration } from '../match-replace';
import {
    ClientServerChannel,
    deserializeBuffer,
    deserializeProxyConfig
} from '../../serialization/serialization';
import {
    withSerializedBodyReader,
    withDeserializedCallbackBuffers,
    WithSerializedCallbackBuffers
} from '../../serialization/body-serialization';
import { MockttpDeserializationOptions } from '../rule-deserialization'

import { assertParamDereferenced } from '../rule-parameters';

import { getAgent } from '../http-agents';
import { ProxySettingSource } from '../proxy-config';
import {
    ForwardingOptions,
    PassThroughLookupOptions,
} from '../passthrough-handling-definitions';
import {
    getRequestContentLengthAfterModification,
    getResponseContentLengthAfterModification,
    getHostAfterModification,
    getH2HeadersAfterModification,
    MODIFIABLE_PSEUDOHEADERS,
    buildOverriddenBody,
    getUpstreamTlsOptions,
    getClientRelativeHostname,
    getDnsLookupFunction,
    getTrustedCAs,
    buildUpstreamErrorTags,
    getEffectiveHostname,
    applyDestinationTransforms
} from '../passthrough-handling';

import {
    BeforePassthroughRequestRequest,
    BeforePassthroughResponseRequest,
    CallbackStep,
    CallbackRequestMessage,
    CallbackRequestResult,
    CallbackResponseMessageResult,
    CallbackResponseResult,
    CloseConnectionStep,
    FileStep,
    StepDefinitionLookup,
    JsonRpcResponseStep,
    PassThroughStep,
    PassThroughStepOptions,
    PassThroughResponse,
    RequestStepDefinition,
    RequestTransform,
    ResetConnectionStep,
    ResponseTransform,
    SerializedBuffer,
    SerializedCallbackStepData,
    SerializedPassThroughData,
    SerializedStreamStepData,
    SERIALIZED_OMIT,
    FixedResponseStep,
    StreamStep,
    TimeoutStep,
    DelayStep,
    WebhookStep,
    WaitForRequestBodyStep
} from './request-step-definitions';

// Re-export various type definitions. This is mostly for compatibility with external
// code that's manually building rule definitions.
export {
    CallbackRequestResult,
    CallbackResponseMessageResult,
    CallbackResponseResult,
    ForwardingOptions,
    PassThroughResponse,
    PassThroughStepOptions,
    PassThroughLookupOptions,
    RequestTransform,
    ResponseTransform
}

// An error that indicates that the step is aborting the request.
// This could be intentional, or an upstream server aborting the request.
export class AbortError extends TypedError {

    constructor(
        message: string,
        readonly code: string
    ) {
        super(message);
    }

}

function isSerializedBuffer(obj: any): obj is SerializedBuffer {
    return obj?.type === 'Buffer' && !!obj.data;
}

export interface RequestStepImpl extends RequestStepDefinition {
    handle(
        request: OngoingRequest,
        response: OngoingResponse,
        options: RequestStepOptions
    ): Promise<
        | undefined // Implicitly finished - equivalent to { continue: false }
        | { continue: boolean } // Should the request continue to later steps?
    >;
}

const copyDefinitionToImpl = (defn: RequestStepDefinition): RequestStepImpl =>
    Object.assign(Object.create(StepLookup[defn.type].prototype), defn);

export interface RequestStepOptions {
    emitEventCallback?: (type: string, event: unknown) => void;
    keyLogStream?: Writable;
    debug: boolean;
}

export class FixedResponseStepImpl extends FixedResponseStep {

    static readonly fromDefinition = copyDefinitionToImpl;

    async handle(_request: OngoingRequest, response: OngoingResponse) {
        if (this.headers) dropDefaultHeaders(response);
        writeHead(response, this.status, this.statusMessage, this.headers);

        if (isSerializedBuffer(this.data)) {
            this.data = Buffer.from(this.data as any);
        }

        if (this.trailers) {
            response.addTrailers(this.trailers);
        }

        response.end(this.data || "");
    }
}

async function writeResponseFromCallback(
    result: CallbackResponseMessageResult,
    response: OngoingResponse
) {
    if (result.json !== undefined) {
        result.headers = Object.assign(result.headers || {}, {
            'Content-Type': 'application/json'
        });
        result.body = JSON.stringify(result.json);
        delete result.json;
    }

    if (result.headers) {
        dropDefaultHeaders(response);
        validateCustomHeaders({}, result.headers);
    }

    if (result.body && !result.rawBody) {
        // RawBody takes priority if both are set (useful for backward compat) but if not then
        // the body is automatically encoded to match the content-encoding header.
        result.rawBody = await encodeBodyBuffer(
            // Separate string case mostly required due to TS type issues:
            typeof result.body === 'string'
                ? Buffer.from(result.body, "utf8")
                : Buffer.from(result.body),
            result.headers ?? {}
        );
    }

    writeHead(
        response,
        result.statusCode || 200,
        result.statusMessage,
        result.headers
    );

    if (result.trailers) response.addTrailers(result.trailers);

    response.end(result.rawBody || "");
}

export class CallbackStepImpl extends CallbackStep {

    static readonly fromDefinition = copyDefinitionToImpl;

    async handle(request: OngoingRequest, response: OngoingResponse) {
        let req = await waitForCompletedRequest(request);

        let outResponse: CallbackResponseResult;
        try {
            outResponse = await this.callback(req);
        } catch (error) {
            writeHead(response, 500, 'Callback step threw an exception');
            console.warn(`Callback step exception: ${(error as ErrorLike).message ?? error}`);
            response.end(isErrorLike(error) ? error.toString() : error);
            return;
        }

        if (outResponse === 'close') {
            (request as any).socket.end();
            throw new AbortError('Connection closed intentionally by rule', 'E_RULE_CB_CLOSE');
        } else if (outResponse === 'reset') {
            requireSocketResetSupport();
            resetOrDestroy(request);
            throw new AbortError('Connection reset intentionally by rule', 'E_RULE_CB_RESET');
        } else {
            await writeResponseFromCallback(outResponse, response);
        }
    }

    /**
     * @internal
     */
    static deserialize({ name }: SerializedCallbackStepData, channel: ClientServerChannel, options: MockttpDeserializationOptions): CallbackStep {
        const rpcCallback = async (request: CompletedRequest) => {
            const callbackResult = await channel.request<
                CallbackRequestMessage,
                | WithSerializedCallbackBuffers<CallbackResponseMessageResult>
                | 'close'
                | 'reset'
            >({ args: [await withSerializedBodyReader(request, options.bodySerializer)] });

            if (typeof callbackResult === 'string') {
                return callbackResult;
            } else {
                return withDeserializedCallbackBuffers(callbackResult);
            }
        };
        // Pass across the name from the real callback, for explain()
        Object.defineProperty(rpcCallback, "name", { value: name });

        // Call the client's callback (via stream), and save a step on our end for
        // the response that comes back.
        return new CallbackStep(rpcCallback);
    }
}

export class StreamStepImpl extends StreamStep {

    static readonly fromDefinition = copyDefinitionToImpl;

    async handle(request: OngoingRequest, response: OngoingResponse) {
        if (!this.stream.done) {
            if (this.headers) dropDefaultHeaders(response);

            writeHead(response, this.status, undefined, this.headers);
            response.flushHeaders();

            if (this.stream.readableEnded || this.stream.destroyed) {
                response.end();
            } else {
                this.stream.pipe(response);
            }
            this.stream.done = true;

            return new Promise<void>((resolve, reject) => {
                if (this.stream.readableEnded || this.stream.destroyed) {
                    resolve();
                } else {
                    this.stream.on('end', () => resolve());
                    this.stream.on('error', (e: ErrorLike) => {
                        reject(new AbortError(
                            `Stream rule error: ${e.message}`,
                            e.code ?? 'STREAM_RULE_ERROR'
                        ));
                    });
                }
            });
        } else {
            throw new Error(stripIndent`
                Stream request step called more than once - this is not supported.

                Streams can typically only be read once, so all subsequent requests would be empty.
                To mock repeated stream requests, call 'thenStream' repeatedly with multiple streams.

                (Have a better way to handle this? Open an issue at ${require('../../../package.json').bugs.url})
            `);
        }
    }

    /**
     * @internal
     */
    static deserialize(stepData: SerializedStreamStepData, channel: ClientServerChannel): StreamStep {
        const stepStream = new Transform({
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
        stepStream.once('resume', () => {
            channel.pipe(stepStream);
            channel.write({});
        });

        return new StreamStep(
            stepData.status,
            stepStream,
            stepData.headers
        );
    }
}

export class FileStepImpl extends FileStep {

    static readonly fromDefinition = copyDefinitionToImpl;

    async handle(_request: OngoingRequest, response: OngoingResponse) {
        // Read the file first, to ensure we error cleanly if it's unavailable
        const fileContents = await fs.readFile(this.filePath);

        if (this.headers) dropDefaultHeaders(response);

        writeHead(response, this.status, this.statusMessage, this.headers);
        response.end(fileContents);
    }
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

// Only used if key logging is enabled, meaning we need to hook into http2-wrapper's TLS setup:
const h2ProtocolQueue = new Map();

export class PassThroughStepImpl extends PassThroughStep {

    // In this case, we actually use the constructor, to ensure we initialize fields as normal:
    static readonly fromDefinition = (defn: PassThroughStep) => Object.assign(new PassThroughStepImpl(), defn);

    protected outgoingSockets = new Set<net.Socket>();

    private _trustedCACertificates: MaybePromise<Array<string> | undefined>;
    private async trustedCACertificates(): Promise<Array<string> | undefined> {
        if (!this.extraCACertificates.length) return undefined;

        if (!this._trustedCACertificates) {
            this._trustedCACertificates = getTrustedCAs(undefined, this.extraCACertificates)
                .then((certs) => {
                    this._trustedCACertificates = certs; // Unwrap the promise
                    return certs;
                });
        }

        return this._trustedCACertificates;
    }

    async handle(
        clientReq: OngoingRequest,
        clientRes: OngoingResponse,
        options: RequestStepOptions
    ) {
        // Don't let Node add any default standard headers - we want full control
        dropDefaultHeaders(clientRes);

        // Capture raw request data:
        let { method, url: reqUrl, rawHeaders, destination } = clientReq as OngoingRequest;
        let { protocol, pathname, search: query } = url.parse(reqUrl);
        const clientSocket = (clientReq as any).socket as net.Socket;

        // Actual IP address or hostname
        let hostAddress = destination.hostname;
        // Same as hostAddress, unless it's an IP, in which case it's our best guess of the
        // functional 'name' for the host (from Host header or SNI).
        let hostname: string = getEffectiveHostname(hostAddress, clientSocket, rawHeaders);
        let port: string | null | undefined = destination.port.toString();

        // Check if this request is a request loop:
        if (isSocketLoop(this.outgoingSockets, clientSocket)) {
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

        // We have to capture the request stream immediately, to make sure nothing is lost if it
        // goes past its max length (truncating the data) before we start sending upstream.
        const clientReqBody = clientReq.body.asStream();

        const isH2Downstream = isHttp2(clientReq);

        hostAddress = await getClientRelativeHostname(
            hostAddress,
            clientReq.remoteIpAddress,
            getDnsLookupFunction(this.lookupOptions)
        );

        // Override the request details, if a transform or callback is specified:
        let reqBodyOverride: Uint8Array | undefined;

        if (this.transformRequest) {
            const {
                replaceMethod,
                updateHeaders,
                replaceHeaders,

                replaceBody,
                replaceBodyFromFile,
                updateJsonBody,
                patchJsonBody,
                matchReplaceBody
            } = this.transformRequest;

            const originalHostname = hostname;

            ({
                reqUrl,
                protocol,
                hostname,
                port,
                pathname,
                query,
                rawHeaders
            } = applyDestinationTransforms(this.transformRequest, {
                 isH2Downstream,
                 rawHeaders,
                 port,
                 protocol,
                 hostname,
                 pathname,
                 query
            }));

            // If you modify the hostname, we also treat that as modifying the
            // resulting destination in turn:
            if (hostname !== originalHostname) {
                hostAddress = hostname;
            }

            if (replaceMethod) {
                method = replaceMethod;
            }

            if (updateHeaders) {
                rawHeaders = updateRawHeaders(rawHeaders, updateHeaders);
            } else if (replaceHeaders) {
                rawHeaders = objectHeadersToRaw(replaceHeaders);
            }

            if (replaceBody) {
                // Note that we're replacing the body without actually waiting for the real one, so
                // this can result in sending a request much more quickly!
                reqBodyOverride = asBuffer(replaceBody);
            } else if (replaceBodyFromFile) {
                reqBodyOverride = await fs.readFile(replaceBodyFromFile);
            } else if (updateJsonBody) {
                const { body: realBody } = await waitForCompletedRequest(clientReq);
                const jsonBody = await realBody.getJson();
                if (jsonBody === undefined) {
                    throw new Error("Can't update JSON in non-JSON request body");
                }

                const updatedBody = _.mergeWith(jsonBody, updateJsonBody, (_oldValue, newValue) => {
                    // We want to remove values with undefines, but Lodash ignores
                    // undefined return values here. Fortunately, JSON.stringify
                    // ignores Symbols, omitting them from the result.
                    if (newValue === undefined) return OMIT_SYMBOL;
                });

                reqBodyOverride = asBuffer(JSON.stringify(updatedBody));
            } else if (patchJsonBody) {
                const { body: realBody } = await waitForCompletedRequest(clientReq);
                const jsonBody = await realBody.getJson();
                if (jsonBody === undefined) {
                    throw new Error("Can't patch JSON in non-JSON request body");
                }

                applyJsonPatch(jsonBody, patchJsonBody, true); // Mutates the JSON body returned above
                reqBodyOverride = asBuffer(JSON.stringify(jsonBody));
            } else if (matchReplaceBody) {
                const { body: realBody } = await waitForCompletedRequest(clientReq);

                const originalBody = await realBody.getText();
                if (originalBody === undefined) {
                    throw new Error("Can't match & replace non-decodeable request body");
                }

                const replacedBody = applyMatchReplace(originalBody, matchReplaceBody);

                if (replacedBody !== originalBody) {
                    reqBodyOverride = asBuffer(replacedBody);
                }
            }

            if (reqBodyOverride) { // Can't check framing without body changes, since we won't have the body yet
                // We always re-encode the body to match the resulting content-encoding header:
                reqBodyOverride = await encodeBodyBuffer(
                    reqBodyOverride,
                    rawHeaders
                );

                const updatedCLHeader = getRequestContentLengthAfterModification(
                    reqBodyOverride,
                    clientReq.headers,
                    (updateHeaders && (
                        getHeaderValue(updateHeaders, 'content-length') !== undefined ||
                        getHeaderValue(updateHeaders, 'transfer-encoding')?.includes('chunked')
                    ))
                        ? rawHeaders // Iff you replaced the relevant headers
                        : replaceHeaders,
                    { httpVersion: isH2Downstream ? 2 : 1 }
                );

                if (updatedCLHeader !== undefined) {
                    rawHeaders = updateRawHeaders(rawHeaders, {
                        'content-length': updatedCLHeader
                    });
                }
            }
        } else if (this.beforeRequest) {
            const clientRawHeaders = rawHeaders;
            const clientHeaders = rawHeadersToObject(clientRawHeaders);

            const completedRequest = await waitForCompletedRequest(clientReq);

            const modifiedReq = await this.beforeRequest({
                ...completedRequest,
                url: reqUrl, // May have been overwritten by forwarding
                headers: _.cloneDeep(clientHeaders),
                rawHeaders: _.cloneDeep(clientRawHeaders)
            });

            if (modifiedReq?.response) {
                if (modifiedReq.response === 'close') {
                    clientSocket.end();
                    throw new AbortError('Connection closed intentionally by rule', 'E_RULE_BREQ_CLOSE');
                } else if (modifiedReq.response === 'reset') {
                    requireSocketResetSupport();
                    resetOrDestroy(clientReq);
                    throw new AbortError('Connection reset intentionally by rule', 'E_RULE_BREQ_RESET');
                } else {
                    // The callback has provided a full response: don't passthrough at all, just use it.
                    await writeResponseFromCallback(modifiedReq.response, clientRes);
                    return;
                }
            }

            method = modifiedReq?.method || method;

            // Reparse the new URL, if necessary
            if (modifiedReq?.url) {
                if (!isAbsoluteUrl(modifiedReq?.url)) throw new Error("Overridden request URLs must be absolute");

                reqUrl = modifiedReq.url;

                const parsedUrl = url.parse(reqUrl);
                ({ protocol, port, pathname, search: query } = parsedUrl);
                hostname = parsedUrl.hostname!;
                hostAddress = hostname;
            }

            let headers = modifiedReq?.headers || clientHeaders;

            // We need to make sure the Host/:authority header is updated correctly - following the user's returned value if
            // they provided one, but updating it if not to match the effective target URL of the request:
            Object.assign(headers,
                isH2Downstream
                    ? getH2HeadersAfterModification(reqUrl, clientHeaders, modifiedReq?.headers)
                    : { 'host': getHostAfterModification(reqUrl, clientHeaders, modifiedReq?.headers) }
            );

            validateCustomHeaders(
                clientHeaders,
                modifiedReq?.headers,
                MODIFIABLE_PSEUDOHEADERS // These are handled by getH2HeadersAfterModification above
            );

            reqBodyOverride = await buildOverriddenBody(modifiedReq, headers);

            if (reqBodyOverride || modifiedReq?.headers) {
                // Automatically match the content-length to the body:
                const updatedCLHeader = getRequestContentLengthAfterModification(
                    reqBodyOverride || completedRequest.body.buffer,
                    clientHeaders,
                    modifiedReq?.headers,
                    { httpVersion: isH2Downstream ? 2 : 1 }
                );

                if (updatedCLHeader !== undefined) {
                    headers['content-length'] = updatedCLHeader;
                }
            }

            rawHeaders = objectHeadersToRaw(headers);
        }

        const effectivePort = getEffectivePort({ protocol, port });
        const trustedCAs = await this.trustedCACertificates();

        // We only do H2 upstream for HTTPS. Http2-wrapper doesn't support H2C, it's rarely used
        // and we can't use ALPN to detect HTTP/2 support cleanly.
        let shouldTryH2Upstream = isH2Downstream && protocol === 'https:';

        let family: undefined | 4 | 6;
        if (hostname === 'localhost') {
            // Annoying special case: some localhost servers listen only on either ipv4 or ipv6.
            // Very specific situation, but a very common one for development use.
            // We need to work out which one family is, as Node sometimes makes bad choices.

            if (await isLocalPortActive('::1', effectivePort)) family = 6;
            else family = 4;
        }

        // Remote clients might configure a passthrough rule with a parameter reference for the proxy,
        // delegating proxy config to the admin server. That's fine initially, but you can't actually
        // handle a request in that case - make sure our proxyConfig is always dereferenced before use.
        const proxySettingSource = assertParamDereferenced(this.proxyConfig) as ProxySettingSource;

        // Mirror the keep-alive-ness of the incoming request in our outgoing request
        const agent = await getAgent({
            protocol: (protocol || undefined) as 'http:' | 'https:' | undefined,
            hostname: hostname!,
            port: effectivePort,
            tryHttp2: shouldTryH2Upstream,
            keepAlive: shouldKeepAlive(clientReq),
            proxySettingSource
        });

        if (agent && !('http2' in agent)) {
            // I.e. only use HTTP/2 if we're using an HTTP/2-compatible agent
            shouldTryH2Upstream = false;
        }

        let makeRequest = (
            shouldTryH2Upstream
                ? (reqOpts: any, cb: any) =>
                    h2Client.auto({
                        ...reqOpts,
                        resolveProtocol: options.keyLogStream
                            // Wrap TLS setup in key logging:
                            ? h2Client.auto.createResolveProtocol(
                                h2Client.auto.protocolCache as any,
                                h2ProtocolQueue,
                                function (...args) {
                                    const socket = tls.connect(...args);
                                    socket.on('keylog', (line) => options.keyLogStream!.write(line));
                                    return socket;
                                }
                            ) : undefined,
                    }, cb).catch((e) => {
                        // If an error occurs during auto detection via ALPN, that's an
                        // TypeError implies it's an invalid HTTP/2 request that was rejected.
                        // Anything else implies an upstream HTTP/2 issue.
                        e.causedByUpstreamError = !(e instanceof TypeError);
                        throw e;
                    })
            // HTTP/1 + TLS
            : protocol === 'https:'
                ? https.request
            // HTTP/1 plaintext:
                : http.request
        ) as typeof https.request;

        if (isH2Downstream && shouldTryH2Upstream) {
            // We drop all incoming pseudoheaders, and regenerate them (except legally modified ones)
            rawHeaders = rawHeaders.filter(([key]) =>
                !key.toString().startsWith(':') ||
                MODIFIABLE_PSEUDOHEADERS.includes(key.toLowerCase() as any)
            );
        } else if (isH2Downstream && !shouldTryH2Upstream) {
            rawHeaders = h2HeadersToH1(rawHeaders, method);
        }

        let serverReq: http.ClientRequest;
        return new Promise<void>((resolve, reject) => (async () => { // Wrapped to easily catch (a)sync errors
            serverReq = await makeRequest({
                protocol,
                method,
                hostname: hostAddress,
                port,
                family,
                path: `${pathname || '/'}${query || ''}`,
                headers: shouldTryH2Upstream
                    ? rawHeadersToObjectPreservingCase(rawHeaders)
                    : flattenPairedRawHeaders(rawHeaders) as any,
                setDefaultHeaders: shouldTryH2Upstream, // For now, we need this for unexpected H2->H1 header fallback
                lookup: getDnsLookupFunction(this.lookupOptions) as typeof dns.lookup,
                // ^ Cast required to handle __promisify__ type hack in the official Node types
                agent,

                // TLS options:
                ...getUpstreamTlsOptions({
                    hostname,
                    port: effectivePort,
                    ignoreHostHttpsErrors: this.ignoreHostHttpsErrors,
                    clientCertificateHostMap: this.clientCertificateHostMap,
                    trustedCAs
                })
            }, (serverRes) => (async () => {
                serverRes.on('error', (e: any) => {
                    reportUpstreamAbort(e)
                    reject(e);
                });

                // Forward server trailers, if we receive any:
                serverRes.on('end', () => {
                    if (!serverRes.rawTrailers?.length) return;

                    const trailersToForward = pairFlatRawHeaders(serverRes.rawTrailers)
                        .filter(([key, value]) => {
                            if (!validateHeader(key, value)) {
                                console.warn(`Not forwarding invalid trailer: "${key}: ${value}"`);
                                // Nothing else we can do in this case regardless - setHeaders will
                                // throw within Node if we try to set this value.
                                return false;
                            }
                            return true;
                        });

                    try {
                        clientRes.addTrailers(
                            isHttp2(clientReq)
                            // HTTP/2 compat doesn't support raw headers here (yet)
                            ? rawHeadersToObjectPreservingCase(trailersToForward)
                            : trailersToForward
                        );
                    } catch (e) {
                        console.warn(`Failed to forward response trailers: ${e}`);
                    }
                });

                let serverStatusCode = serverRes.statusCode!;
                let serverStatusMessage = serverRes.statusMessage
                let serverRawHeaders = pairFlatRawHeaders(serverRes.rawHeaders);

                // This is only set if we need to read the body here, for a callback or similar. If so,
                // we keep the buffer in case we need it afterwards (if the cb doesn't replace it).
                let originalBody: Buffer | undefined;

                // This is set when we override the body data. Note that this doesn't mean we actually
                // read & buffered the original data! With a fixed replacement body we can skip that.
                let resBodyOverride: Uint8Array | undefined;

                if (options.emitEventCallback) {
                    options.emitEventCallback('passthrough-response-head', {
                        statusCode: serverStatusCode,
                        statusMessage: serverStatusMessage,
                        httpVersion: serverRes.httpVersion,
                        rawHeaders: serverRawHeaders
                    });
                }

                if (isH2Downstream) {
                    serverRawHeaders = h1HeadersToH2(serverRawHeaders);
                }

                if (this.transformResponse) {
                    const {
                        replaceStatus,
                        updateHeaders,
                        replaceHeaders,
                        replaceBody,
                        replaceBodyFromFile,
                        updateJsonBody,
                        patchJsonBody,
                        matchReplaceBody
                    } = this.transformResponse;

                    if (replaceStatus) {
                        serverStatusCode = replaceStatus;
                        serverStatusMessage = undefined; // Reset to default
                    }

                    if (updateHeaders) {
                        serverRawHeaders = updateRawHeaders(serverRawHeaders, updateHeaders);
                    } else if (replaceHeaders) {
                        serverRawHeaders = objectHeadersToRaw(replaceHeaders);
                    }

                    if (replaceBody) {
                        // Note that we're replacing the body without actually waiting for the real one, so
                        // this can result in sending a request much more quickly!
                        resBodyOverride = asBuffer(replaceBody);
                    } else if (replaceBodyFromFile) {
                        resBodyOverride = await fs.readFile(replaceBodyFromFile);
                    } else if (updateJsonBody) {
                        originalBody = await streamToBuffer(serverRes);
                        const realBody = buildBodyReader(originalBody, serverRes.headers);
                        const jsonBody = await realBody.getJson();

                        if (jsonBody === undefined) {
                            throw new Error("Can't update JSON in non-JSON response body");
                        }

                        const updatedBody = _.mergeWith(jsonBody, updateJsonBody, (_oldValue, newValue) => {
                            // We want to remove values with undefines, but Lodash ignores
                            // undefined return values here. Fortunately, JSON.stringify
                            // ignores Symbols, omitting them from the result.
                            if (newValue === undefined) return OMIT_SYMBOL;
                        });

                        resBodyOverride = asBuffer(JSON.stringify(updatedBody));
                    } else if (patchJsonBody) {
                        originalBody = await streamToBuffer(serverRes);
                        const realBody = buildBodyReader(originalBody, serverRes.headers);
                        const jsonBody = await realBody.getJson();

                        if (jsonBody === undefined) {
                            throw new Error("Can't patch JSON in non-JSON response body");
                        }

                        applyJsonPatch(jsonBody, patchJsonBody, true); // Mutates the JSON body returned above
                        resBodyOverride = asBuffer(JSON.stringify(jsonBody));
                    } else if (matchReplaceBody) {
                        originalBody = await streamToBuffer(serverRes);
                        const realBody = buildBodyReader(originalBody, serverRes.headers);

                        const originalBodyText = await realBody.getText();
                        if (originalBodyText === undefined) {
                            throw new Error("Can't match & replace non-decodeable response body");
                        }

                        let replacedBody = originalBodyText;
                        for (let [match, result] of matchReplaceBody) {
                            replacedBody = replacedBody!.replace(match, result);
                        }

                        if (replacedBody !== originalBodyText) {
                            resBodyOverride = asBuffer(replacedBody);
                        }
                    }

                    if (resBodyOverride) { // Can't check framing without body changes, since we won't have the body yet
                        // In the above cases, the overriding data is assumed to always be in decoded form,
                        // so we re-encode the body to match the resulting content-encoding header:
                        resBodyOverride = await encodeBodyBuffer(
                            resBodyOverride,
                            serverRawHeaders
                        );

                        const updatedCLHeader = getResponseContentLengthAfterModification(
                            resBodyOverride,
                            serverRes.headers,
                            (updateHeaders && getHeaderValue(updateHeaders, 'content-length') !== undefined)
                                ? serverRawHeaders // Iff you replaced the content length
                                : replaceHeaders,
                            { httpMethod: method, httpVersion: serverRes.httpVersion.startsWith('1.') ? 1 : 2 }
                        );

                        if (updatedCLHeader !== undefined) {
                            serverRawHeaders = updateRawHeaders(serverRawHeaders, {
                                'content-length': updatedCLHeader
                            });
                        }
                    }
                } else if (this.beforeResponse) {
                    let modifiedRes: CallbackResponseResult | void;

                    originalBody = await streamToBuffer(serverRes);
                    let serverHeaders = rawHeadersToObject(serverRawHeaders);

                    let reqHeader = rawHeadersToObjectPreservingCase(rawHeaders);
                    modifiedRes = await this.beforeResponse({
                        id: clientReq.id,
                        statusCode: serverStatusCode,
                        statusMessage: serverRes.statusMessage,
                        headers: serverHeaders,
                        rawHeaders: _.cloneDeep(serverRawHeaders),
                        body: buildBodyReader(originalBody, serverHeaders)
                    }, {
                        id: clientReq.id,
                        protocol: protocol?.replace(':', '') ?? '',
                        method: method,
                        httpVersion: serverRes.httpVersion,
                        url: reqUrl,
                        destination: {
                            hostname: hostname || 'localhost',
                            port: effectivePort
                        },
                        path: `${pathname || '/'}${query || ''}`,
                        headers: reqHeader,
                        rawHeaders: rawHeaders,
                        timingEvents: clientReq.timingEvents,
                        tags: clientReq.tags,
                        body: buildBodyReader(reqBodyOverride ? Buffer.from(reqBodyOverride.buffer) : await clientReq.body.asDecodedBuffer(), reqHeader),
                        rawTrailers: clientReq.rawTrailers ?? [],
                        trailers: rawHeadersToObject(clientReq.rawTrailers ?? []),
                    });

                    if (modifiedRes === 'close' || modifiedRes === 'reset') {
                        // If you kill the connection, we need to fire an upstream event separately here, since
                        // this means the body won't be delivered in normal response events.
                        if (options.emitEventCallback) {
                            options.emitEventCallback!('passthrough-response-body', {
                                overridden: true,
                                rawBody: originalBody
                            });
                        }

                        if (modifiedRes === 'close') {
                            clientSocket.end();
                        } else if (modifiedRes === 'reset') {
                            requireSocketResetSupport();
                            resetOrDestroy(clientReq);
                        }

                        throw new AbortError(
                            `Connection ${modifiedRes === 'close' ? 'closed' : 'reset'} intentionally by rule`,
                            `E_RULE_BRES_${modifiedRes.toUpperCase()}`
                        );
                    }

                    validateCustomHeaders(serverHeaders, modifiedRes?.headers);

                    serverStatusCode = modifiedRes?.statusCode ||
                        serverStatusCode;
                    serverStatusMessage = modifiedRes?.statusMessage ||
                        serverStatusMessage;

                    serverHeaders = modifiedRes?.headers || serverHeaders;

                    resBodyOverride = await buildOverriddenBody(modifiedRes, serverHeaders);

                    if (resBodyOverride || modifiedRes?.headers) {
                        const updatedContentLength = getResponseContentLengthAfterModification(
                            resBodyOverride || originalBody,
                            serverRes.headers,
                            modifiedRes?.headers,
                            {
                                httpMethod: method,
                                httpVersion: serverRes.httpVersion.startsWith('1.') ? 1 : 2
                            }
                        );

                        if (updatedContentLength !== undefined) {
                            serverHeaders['content-length'] = updatedContentLength;
                        }
                    }

                    serverRawHeaders = objectHeadersToRaw(serverHeaders);
                }

                writeHead(
                    clientRes,
                    serverStatusCode,
                    serverStatusMessage,
                    serverRawHeaders
                        .filter(([key, value]) => {
                            if (key === ':status') return false;
                            if (!validateHeader(key, value)) {
                                console.warn(`Not forwarding invalid header: "${key}: ${value}"`);
                                // Nothing else we can do in this case regardless - setHeaders will
                                // throw within Node if we try to set this value.
                                return false;
                            }
                            return true;
                        })
                );

                if (resBodyOverride) {
                    // Return the override data to the client:
                    clientRes.end(resBodyOverride);

                    // Dump the real response data, in case that body wasn't read yet:
                    serverRes.resume();
                    resolve();
                } else if (originalBody) {
                    // If the original body was read, and not overridden, then send it
                    // onward directly:
                    clientRes.end(originalBody);
                    resolve();
                } else if (isH2Downstream && (
                    serverRes.statusCode === 204 ||
                    serverRes.statusCode === 205 ||
                    serverRes.statusCode === 304 ||
                    method === 'HEAD'
                )) {
                    // Here, Node's HTTP/2 implementation auto-ends the downstream request knowing
                    // that it can't have a body. We need to mirror this, or we end up with a confusing
                    // race condition where the client is done (and can even close the connection) while
                    // the server response is still technically pending.
                    // https://github.com/nodejs/node/blob/f6f8eb7c/lib/internal/http2/core.js#L2976-L2985
                    clientRes.end();
                    serverRes.destroy();
                    resolve();
                } else {
                    // Otherwise the body hasn't been read - stream it live:
                    serverRes.pipe(clientRes);
                    serverRes.once('end', resolve);
                }

                if (options.emitEventCallback) {
                    if (!!resBodyOverride) {
                        (originalBody
                            ? Promise.resolve(originalBody)
                            : streamToBuffer(serverRes)
                        ).then((upstreamBody) => {
                            options.emitEventCallback!('passthrough-response-body', {
                                overridden: true,
                                rawBody: upstreamBody
                            });
                        }).catch((e) => reportUpstreamAbort(e));
                    } else {
                        options.emitEventCallback('passthrough-response-body', {
                            overridden: false
                            // We don't bother buffering & re-sending the body if
                            // it's the same as the one being sent to the client.
                        });
                    }
                }
            })().catch(reject));

            serverReq.once('socket', (socket: net.Socket) => {
                // This event can fire multiple times for keep-alive sockets, which are used to
                // make multiple requests. If/when that happens, we don't need more event listeners.
                if (this.outgoingSockets.has(socket)) return;

                if (options.keyLogStream) {
                    socket.on('keylog', (line) => options.keyLogStream!.write(line));
                }

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

            // Forward any request trailers received from the client:
            const forwardTrailers = () => {
                if (clientReq.rawTrailers?.length) {
                    if (serverReq.addTrailers) {
                        serverReq.addTrailers(clientReq.rawTrailers);
                    } else {
                        // See https://github.com/szmarczak/http2-wrapper/issues/103
                        console.warn('Not forwarding request trailers - not yet supported for HTTP/2');
                    }
                }
            };
            // This has to be above the pipe setup below, or we end the stream before adding the
            // trailers, and they're lost.
            if (clientReqBody.readableEnded) {
                forwardTrailers();
            } else {
                clientReqBody.once('end', forwardTrailers);
            }

            // Forward the request body to the upstream server:
            if (reqBodyOverride) {
                clientReqBody.resume(); // Dump any remaining real request body

                if (reqBodyOverride.length > 0) serverReq.end(reqBodyOverride);
                else serverReq.end(); // http2-wrapper fails given an empty buffer for methods that aren't allowed a body
            } else {
                // asStream includes all content, including the body before this call
                clientReqBody.pipe(serverReq);
                clientReqBody.on('error', () => serverReq.abort());
            }

            // If the downstream connection aborts, before the response has been completed,
            // we also abort the upstream connection. Important to avoid unnecessary connections,
            // and to correctly proxy client connection behaviour to the upstream server.
            function abortUpstream() {
                serverReq.abort();
            }

            // If the upstream fails, for any reason, we need to fire an event to any rule
            // listeners who might be present (although only the first time)
            let reportedUpstreamError = false;
            function reportUpstreamAbort(e: ErrorLike & { causedByUpstreamError?: true }) {
                e.causedByUpstreamError = true;

                if (!options.emitEventCallback) return;

                if (reportedUpstreamError) return;
                reportedUpstreamError = true;

                options.emitEventCallback('passthrough-abort', {
                    downstreamAborted: !!(serverReq?.aborted),
                    tags: [
                        ...clientReq.tags,
                        buildUpstreamErrorTags(e)
                    ],
                    error: {
                        name: e.name,
                        code: e.code,
                        message: e.message,
                        stack: e.stack
                    }
                });
            }

            // Handle the case where the downstream connection is prematurely closed before
            // fully sending the request or receiving the response.
            clientReq.on('aborted', abortUpstream);
            clientRes.on('close', abortUpstream);

            // Disable the upstream request abort handlers once the response has been received.
            clientRes.once('finish', () => {
                clientReq.off('aborted', abortUpstream);
                clientRes.off('close', abortUpstream);
            });

            serverReq.on('error', (e: any) => {
                reportUpstreamAbort(e);
                reject(e);
            });

            // We always start upstream connections *immediately*. This might be less efficient, but it
            // ensures that we're accurately mirroring downstream, which has indeed already connected.
            serverReq.flushHeaders();

            // For similar reasons, we don't want any buffering on outgoing data at all if possible:
            serverReq.setNoDelay(true);

            // Fire rule events, to allow in-depth debugging of upstream traffic & modifications,
            // so anybody interested can see _exactly_ what we're sending upstream here:
            if (options.emitEventCallback) {
                options.emitEventCallback('passthrough-request-head', {
                    method,
                    protocol: protocol!.replace(/:$/, ''),
                    hostname,
                    port,
                    path: `${pathname || '/'}${query || ''}`,
                    rawHeaders
                });

                if (!!reqBodyOverride) {
                    options.emitEventCallback('passthrough-request-body', {
                        overridden: true,
                        rawBody: reqBodyOverride
                    });
                } else {
                    options.emitEventCallback!('passthrough-request-body', {
                        overridden: false
                    });
                }
            }
        })().catch(reject)
        ).catch((e: ErrorLike) => {
            clientRes.tags.push(...buildUpstreamErrorTags(e));

            if ((e as any).causedByUpstreamError && !serverReq?.aborted) {
                if (this.simulateConnectionErrors) {
                    // The upstream socket failed: forcibly break the downstream stream to match. This could
                    // happen due to a reset, TLS or DNS failures, or anything - but critically it's a
                    // connection-level issue, so we try to create connection issues downstream.
                    resetOrDestroy(clientReq);

                    // Aggregate errors can be thrown if multiple (IPv4/6) addresses were tested. Note that
                    // AggregateError only exists in Node 15+. If that happens, we need to combine errors:
                    const errorMessage = typeof AggregateError !== 'undefined' && (e instanceof AggregateError)
                        ? e.errors.map(e => e.message).join(', ')
                        : (e.message ?? e.code ?? e);

                    throw new AbortError(`Upstream connection error: ${errorMessage}`, e.code || 'E_MIRRORED_FAILURE');
                } else {
                    e.statusCode = 502;
                    e.statusMessage = 'Error communicating with upstream server';
                    throw e;
                }
            } else {
                throw e;
            }
        });
    }

    /**
     * @internal
     */
    static deserialize(
        data: SerializedPassThroughData,
        channel: ClientServerChannel,
        { ruleParams, bodySerializer }: MockttpDeserializationOptions
    ): PassThroughStep {
        let beforeRequest: ((req: CompletedRequest) => MaybePromise<CallbackRequestResult | void>) | undefined;
        if (data.hasBeforeRequestCallback) {
            beforeRequest = async (req: CompletedRequest) => {
                const result = withDeserializedCallbackBuffers<CallbackRequestResult>(
                    await channel.request<
                        BeforePassthroughRequestRequest,
                        WithSerializedCallbackBuffers<CallbackRequestResult>
                    >('beforeRequest', {
                        args: [await withSerializedBodyReader(req, bodySerializer)]
                    })
                );

                if (result.response && typeof result.response !== 'string') {
                    result.response = withDeserializedCallbackBuffers(
                        result.response as WithSerializedCallbackBuffers<CallbackResponseMessageResult>
                    );
                }

                return result;
            };
        }

        let beforeResponse: ((res: PassThroughResponse, req: CompletedRequest) => MaybePromise<CallbackResponseResult | void>) | undefined;
        if (data.hasBeforeResponseCallback) {
            beforeResponse = async (res: PassThroughResponse, req: CompletedRequest) => {
                const callbackResult = await channel.request<
                    BeforePassthroughResponseRequest,
                    | WithSerializedCallbackBuffers<CallbackResponseMessageResult>
                    | 'close'
                    | 'reset'
                    | undefined
                >('beforeResponse', {
                    args: [
                        await withSerializedBodyReader(res, bodySerializer),
                        await withSerializedBodyReader(req, bodySerializer)
                    ]
                })

                if (callbackResult && typeof callbackResult !== 'string') {
                    return withDeserializedCallbackBuffers(callbackResult);
                } else {
                    return callbackResult;
                }
            };
        }

        // Backward compat for old clients:
        if (data.forwarding && !data.transformRequest?.replaceHost) {
            const [targetHost, setProtocol] = data.forwarding.targetHost.split('://').reverse();
            data.transformRequest ??= {};
            data.transformRequest.replaceHost = {
                targetHost,
                updateHostHeader: data.forwarding.updateHostHeader ?? true
            };
            data.transformRequest.setProtocol = setProtocol as 'http' | 'https' | undefined;
        }

        return new PassThroughStep({
            beforeRequest,
            beforeResponse,
            proxyConfig: deserializeProxyConfig(data.proxyConfig, channel, ruleParams),
            transformRequest: data.transformRequest ? {
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
                ...(data.transformRequest?.matchReplaceHost !== undefined ? {
                    matchReplaceHost: {
                        ...data.transformRequest.matchReplaceHost,
                        replacements: deserializeMatchReplaceConfiguration(data.transformRequest.matchReplaceHost.replacements)
                    }
                } : {}),
                ...(data.transformRequest?.matchReplacePath !== undefined ? {
                    matchReplacePath: deserializeMatchReplaceConfiguration(data.transformRequest.matchReplacePath)
                } : {}),
                ...(data.transformRequest?.matchReplaceQuery !== undefined ? {
                    matchReplaceQuery: deserializeMatchReplaceConfiguration(data.transformRequest.matchReplaceQuery)
                } : {}),
                ...(data.transformRequest?.matchReplaceBody !== undefined ? {
                    matchReplaceBody: deserializeMatchReplaceConfiguration(data.transformRequest.matchReplaceBody)
                } : {})
            } as RequestTransform : undefined,
            transformResponse: data.transformResponse ? {
                ...data.transformResponse,
                ...(data.transformResponse?.replaceBody !== undefined ? {
                    replaceBody: deserializeBuffer(data.transformResponse.replaceBody)
                } : {}),
                ...(data.transformResponse?.updateHeaders !== undefined ? {
                    updateHeaders: mapOmitToUndefined(JSON.parse(data.transformResponse.updateHeaders))
                } : {}),
                ...(data.transformResponse?.updateJsonBody !== undefined ? {
                    updateJsonBody: mapOmitToUndefined(JSON.parse(data.transformResponse.updateJsonBody))
                } : {}),
                ...(data.transformResponse?.matchReplaceBody !== undefined ? {
                    matchReplaceBody: deserializeMatchReplaceConfiguration(data.transformResponse.matchReplaceBody)
                } : {})
            } as ResponseTransform : undefined,
            lookupOptions: data.lookupOptions,
            simulateConnectionErrors: !!data.simulateConnectionErrors,
            ignoreHostHttpsErrors: data.ignoreHostCertificateErrors,
            additionalTrustedCAs: data.extraCACertificates,
            clientCertificateHostMap: _.mapValues(data.clientCertificateHostMap,
                ({ pfx, passphrase }) => ({ pfx: deserializeBuffer(pfx), passphrase })
            ),
        });
    }
}

export class CloseConnectionStepImpl extends CloseConnectionStep {

    static readonly fromDefinition = () => new CloseConnectionStepImpl();

    async handle(request: OngoingRequest) {
        const socket: net.Socket = (request as any).socket;
        socket.end();
        throw new AbortError('Connection closed intentionally by rule', 'E_RULE_CLOSE');
    }
}

export class ResetConnectionStepImpl extends ResetConnectionStep {

    static readonly fromDefinition = () => new ResetConnectionStepImpl();

    constructor() {
        super();
        requireSocketResetSupport();
    }

    async handle(request: OngoingRequest) {
        requireSocketResetSupport();
        resetOrDestroy(request);
        throw new AbortError('Connection reset intentionally by rule', 'E_RULE_RESET');
    }

    /**
     * @internal
     */
    static deserialize() {
        requireSocketResetSupport();
        return new ResetConnectionStep();
    }
}

export class TimeoutStepImpl extends TimeoutStep {

    static readonly fromDefinition = () => new TimeoutStepImpl();

    async handle() {
        // Do nothing, leaving the socket open but never sending a response.
        return new Promise<void>(() => {});
    }
}

export class JsonRpcResponseStepImpl extends JsonRpcResponseStep {

    static readonly fromDefinition = copyDefinitionToImpl;

    async handle(request: OngoingRequest, response: OngoingResponse) {
        const data: any = await request.body.asJson()
            .catch(() => {}); // Handle parsing errors with the check below

        if (!data || data.jsonrpc !== '2.0' || !('id' in data)) { // N.B. id can be null
            throw new Error("Can't send a JSON-RPC response to an invalid JSON-RPC request");
        }

        response.writeHead(200, {
            'content-type': 'application/json'
        });

        response.end(JSON.stringify({
            jsonrpc: '2.0',
            id: data.id,
            ...this.result
        }));
    }
}

export class DelayStepImpl extends DelayStep {

    static readonly fromDefinition = copyDefinitionToImpl;

    async handle(): Promise<{ continue: true }> {
        await delay(this.delayMs);
        return { continue: true };
    }
}

export class WaitForRequestBodyStepImpl extends WaitForRequestBodyStep {

    static readonly fromDefinition = () => new WaitForRequestBodyStepImpl();

    async handle(request: OngoingRequest): Promise<{ continue: true }> {
        await request.body.asBuffer();
        return { continue: true };
    }
}

const encodeWebhookBody = (body: Buffer) => {
    return {
        format: 'base64',
        data: body.toString('base64')
    };
};

export class WebhookStepImpl extends WebhookStep {

   static readonly fromDefinition = copyDefinitionToImpl;

    private sendEvent(data: {
        eventType: string;
        eventData: {};
    }) {
        const content = JSON.stringify(data);
        const req = http.request(this.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(content)
            }
        }).end(content);

        req.on('error', (e) => {
            console.warn(`Error sending webhook to ${this.url}:`, e);
        });

        req.on('response', (res) => {
            if (res.statusCode !== 200) {
                console.warn(`Received unexpected ${res.statusCode} response from webhook ${this.url} for ${data.eventType}`);
            }

            res.on('error', () => {});
            res.resume();
        });
    }

    async handle(request: OngoingRequest, response: OngoingResponse) {
        if (this.events.includes('request')) {
            waitForCompletedRequest(request).then((completedReq) => {
                const eventData = {
                    ..._.pick(completedReq, [
                        'id',
                        'method',
                        'url',
                        'headers',
                        'trailers'
                    ]),
                    body: encodeWebhookBody(completedReq.body.buffer)
                }

                this.sendEvent({
                    eventType: 'request',
                    eventData: eventData
                });
            }).catch(() => {});
        }

        if (this.events.includes('response')) {
            waitForCompletedResponse(response).then((completedRes) => {
                const eventData = {
                    ..._.pick(completedRes, [
                        'id',
                        'statusCode',
                        'statusMessage',
                        'headers',
                        'trailers'
                    ]),
                    body: encodeWebhookBody(completedRes.body.buffer)
                }

                this.sendEvent({
                    eventType: 'response',
                    eventData: eventData
                });
            }).catch(() => {});
        }

        return { continue: true };
    }
}

export const StepLookup = {
    'simple': FixedResponseStepImpl,
    'callback': CallbackStepImpl,
    'stream': StreamStepImpl,
    'file': FileStepImpl,
    'passthrough': PassThroughStepImpl,
    'close-connection': CloseConnectionStepImpl,
    'reset-connection': ResetConnectionStepImpl,
    'timeout': TimeoutStepImpl,
    'json-rpc-response': JsonRpcResponseStepImpl,
    'delay': DelayStepImpl,
    'wait-for-request-body': WaitForRequestBodyStepImpl,
    'webhook': WebhookStepImpl
}

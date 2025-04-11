import _ = require('lodash');
import url = require('url');
import type dns = require('dns');
import net = require('net');
import tls = require('tls');
import http = require('http');
import https = require('https');
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

import { MaybePromise } from '../../util/type-utils';
import { isAbsoluteUrl, getEffectivePort } from '../../util/url';
import {
    waitForCompletedRequest,
    buildBodyReader,
    shouldKeepAlive,
    isHttp2,
    writeHead,
    encodeBodyBuffer
} from '../../util/request-utils';
import {
    h1HeadersToH2,
    h2HeadersToH1,
    objectHeadersToRaw,
    rawHeadersToObject,
    rawHeadersToObjectPreservingCase,
    flattenPairedRawHeaders,
    pairFlatRawHeaders,
    findRawHeaderIndex,
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
import { ErrorLike, isErrorLike } from '../../util/error';

import { assertParamDereferenced, RuleParameters } from '../rule-parameters';

import { getAgent } from '../http-agents';
import { ProxySettingSource } from '../proxy-config';
import {
    ForwardingOptions,
    PassThroughLookupOptions,
} from '../passthrough-handling-definitions';
import {
    getContentLengthAfterModification,
    getHostAfterModification,
    getH2HeadersAfterModification,
    OVERRIDABLE_REQUEST_PSEUDOHEADERS,
    buildOverriddenBody,
    getUpstreamTlsOptions,
    shouldUseStrictHttps,
    getClientRelativeHostname,
    getDnsLookupFunction,
    getTrustedCAs,
    buildUpstreamErrorTags
} from '../passthrough-handling';

import {
    BeforePassthroughRequestRequest,
    BeforePassthroughResponseRequest,
    CallbackHandlerDefinition,
    CallbackRequestMessage,
    CallbackRequestResult,
    CallbackResponseMessageResult,
    CallbackResponseResult,
    CloseConnectionHandlerDefinition,
    FileHandlerDefinition,
    HandlerDefinitionLookup,
    JsonRpcResponseHandlerDefinition,
    PassThroughHandlerDefinition,
    PassThroughHandlerOptions,
    PassThroughResponse,
    RequestHandlerDefinition,
    RequestTransform,
    ResetConnectionHandlerDefinition,
    ResponseTransform,
    SerializedBuffer,
    SerializedCallbackHandlerData,
    SerializedPassThroughData,
    SerializedStreamHandlerData,
    SERIALIZED_OMIT,
    SimpleHandlerDefinition,
    StreamHandlerDefinition,
    TimeoutHandlerDefinition
} from './request-handler-definitions';

// Re-export various type definitions. This is mostly for compatibility with external
// code that's manually building rule definitions.
export {
    CallbackRequestResult,
    CallbackResponseMessageResult,
    CallbackResponseResult,
    ForwardingOptions,
    PassThroughResponse,
    PassThroughHandlerOptions,
    PassThroughLookupOptions,
    RequestTransform,
    ResponseTransform
}

// An error that indicates that the handler is aborting the request.
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
    return obj && obj.type === 'Buffer' && !!obj.data;
}

export interface RequestHandler extends RequestHandlerDefinition {
    handle(
        request: OngoingRequest,
        response: OngoingResponse,
        options: RequestHandlerOptions
    ): Promise<void>;
}

export interface RequestHandlerOptions {
    emitEventCallback?: (type: string, event: unknown) => void;
}

export class SimpleHandler extends SimpleHandlerDefinition {
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
        result.statusCode || result.status || 200,
        result.statusMessage,
        result.headers
    );

    if (result.trailers) response.addTrailers(result.trailers);

    response.end(result.rawBody || "");
}

export class CallbackHandler extends CallbackHandlerDefinition {

    async handle(request: OngoingRequest, response: OngoingResponse) {
        let req = await waitForCompletedRequest(request);

        let outResponse: CallbackResponseResult;
        try {
            outResponse = await this.callback(req);
        } catch (error) {
            writeHead(response, 500, 'Callback handler threw an exception');
            console.warn(`Callback handler exception: ${(error as ErrorLike).message ?? error}`);
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
    static deserialize({ name, version }: SerializedCallbackHandlerData, channel: ClientServerChannel): CallbackHandler {
        const rpcCallback = async (request: CompletedRequest) => {
            const callbackResult = await channel.request<
                CallbackRequestMessage,
                | WithSerializedCallbackBuffers<CallbackResponseMessageResult>
                | 'close'
                | 'reset'
            >({ args: [
                (version || -1) >= 2
                    ? withSerializedBodyReader(request)
                    : request // Backward compat: old handlers
            ] });

            if (typeof callbackResult === 'string') {
                return callbackResult;
            } else {
                return withDeserializedCallbackBuffers(callbackResult);
            }
        };
        // Pass across the name from the real callback, for explain()
        Object.defineProperty(rpcCallback, "name", { value: name });

        // Call the client's callback (via stream), and save a handler on our end for
        // the response that comes back.
        return new CallbackHandler(rpcCallback);
    }
}

export class StreamHandler extends StreamHandlerDefinition {

    async handle(_request: OngoingRequest, response: OngoingResponse) {
        if (!this.stream.done) {
            if (this.headers) dropDefaultHeaders(response);

            writeHead(response, this.status, undefined, this.headers);
            response.flushHeaders();

            this.stream.pipe(response);
            this.stream.done = true;

            this.stream.on('error', (e) => response.destroy(e));
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

export class FileHandler extends FileHandlerDefinition {
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

export class PassThroughHandler extends PassThroughHandlerDefinition {

    private _trustedCACertificates: MaybePromise<Array<string> | undefined>;
    private async trustedCACertificates(): Promise<Array<string> | undefined> {
        if (!this.extraCACertificates.length) return undefined;

        if (!this._trustedCACertificates) {
            this._trustedCACertificates = getTrustedCAs(undefined, this.extraCACertificates);
        }

        return this._trustedCACertificates;
    }

    async handle(
        clientReq: OngoingRequest,
        clientRes: OngoingResponse,
        options: RequestHandlerOptions
    ) {
        // Don't let Node add any default standard headers - we want full control
        dropDefaultHeaders(clientRes);

        // Capture raw request data:
        let { method, url: reqUrl, rawHeaders } = clientReq as OngoingRequest;
        let { protocol, hostname, port, path } = url.parse(reqUrl);

        // Check if this request is a request loop:
        if (isSocketLoop(this.outgoingSockets, (clientReq as any).socket)) {
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

        hostname = await getClientRelativeHostname(
            hostname,
            clientReq.remoteIpAddress,
            getDnsLookupFunction(this.lookupOptions)
        );

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

            let hostHeaderIndex = findRawHeaderIndex(rawHeaders, hostHeaderName);
            let hostHeader: [string, string];

            if (hostHeaderIndex === -1) {
                // Should never happen really, but just in case:
                hostHeader = [hostHeaderName, hostname!];
                hostHeaderIndex = rawHeaders.length;
            } else {
                // Clone this - we don't want to modify the original headers, as they're used for events
                hostHeader = _.clone(rawHeaders[hostHeaderIndex]);
            }
            rawHeaders[hostHeaderIndex] = hostHeader;

            if (updateHostHeader === undefined || updateHostHeader === true) {
                // If updateHostHeader is true, or just not specified, match the new target
                hostHeader[1] = hostname + (port ? `:${port}` : '');
            } else if (updateHostHeader) {
                // If it's an explicit custom value, use that directly.
                hostHeader[1] = updateHostHeader;
            } // Otherwise: falsey means don't touch it.

            reqUrl = new URL(`${protocol}//${hostname}${(port ? `:${port}` : '')}${path}`).toString();
        }

        // Override the request details, if a transform or callback is specified:
        let reqBodyOverride: Uint8Array | undefined;

        // Set during modification here - if set, we allow overriding certain H2 headers so that manual
        // modification of the supported headers works as expected.
        let headersManuallyModified = false;

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

                let replacedBody = originalBody;
                for (let [match, result] of matchReplaceBody) {
                    replacedBody = replacedBody!.replace(match, result);
                }

                if (replacedBody !== originalBody) {
                    reqBodyOverride = asBuffer(replacedBody);
                }
            }

            if (reqBodyOverride) {
                // We always re-encode the body to match the resulting content-encoding header:
                reqBodyOverride = await encodeBodyBuffer(
                    reqBodyOverride,
                    rawHeaders
                );

                const updatedCLHeader = getContentLengthAfterModification(
                    reqBodyOverride,
                    clientReq.headers,
                    (updateHeaders && getHeaderValue(updateHeaders, 'content-length') !== undefined)
                        ? rawHeaders // Iff you replaced the content length
                        : replaceHeaders
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
                    const socket: net.Socket = (clientReq as any).socket;
                    socket.end();
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
            reqUrl = modifiedReq?.url || reqUrl;

            headersManuallyModified = !!modifiedReq?.headers;
            let headers = modifiedReq?.headers || clientHeaders;

            // We need to make sure the Host/:authority header is updated correctly - following the user's returned value if
            // they provided one, but updating it if not to match the effective target URL of the request:
            const expectedTargetUrl = modifiedReq?.url
                ?? (
                    // If not overridden, we fall back to the original value, but we need to handle changes that forwarding
                    // might have made as well, especially if it's intentionally left URL & headers out of sync:
                    this.forwarding?.updateHostHeader === false
                    ? clientReq.url
                    : reqUrl
                );

            Object.assign(headers,
                isH2Downstream
                    ? getH2HeadersAfterModification(expectedTargetUrl, clientHeaders, modifiedReq?.headers)
                    : { 'host': getHostAfterModification(expectedTargetUrl, clientHeaders, modifiedReq?.headers) }
            );

            validateCustomHeaders(
                clientHeaders,
                modifiedReq?.headers,
                OVERRIDABLE_REQUEST_PSEUDOHEADERS // These are handled by getCorrectPseudoheaders above
            );

            reqBodyOverride = await buildOverriddenBody(modifiedReq, headers);

            if (reqBodyOverride) {
                // Automatically match the content-length to the body, unless it was explicitly overriden.
                headers['content-length'] = getContentLengthAfterModification(
                    reqBodyOverride,
                    clientHeaders,
                    modifiedReq?.headers
                );
            }

            // Reparse the new URL, if necessary
            if (modifiedReq?.url) {
                if (!isAbsoluteUrl(modifiedReq?.url)) throw new Error("Overridden request URLs must be absolute");
                ({ protocol, hostname, port, path } = url.parse(reqUrl));
            }

            rawHeaders = objectHeadersToRaw(headers);
        }

        const effectivePort = getEffectivePort({ protocol, port });

        const strictHttpsChecks = shouldUseStrictHttps(
            hostname!,
            effectivePort,
            this.ignoreHostHttpsErrors
        );

        // Use a client cert if it's listed for the host+port or whole hostname
        const hostWithPort = `${hostname}:${effectivePort}`;
        const clientCert = this.clientCertificateHostMap[hostWithPort] ||
            this.clientCertificateHostMap[hostname!] ||
            {};

        const trustedCerts = await this.trustedCACertificates();
        const caConfig = trustedCerts
            ? { ca: trustedCerts }
            : {};

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
                ? (options: any, cb: any) =>
                    h2Client.auto(options, cb).catch((e) => {
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
                (headersManuallyModified &&
                    OVERRIDABLE_REQUEST_PSEUDOHEADERS.includes(key.toLowerCase() as any)
                )
            );
        } else if (isH2Downstream && !shouldTryH2Upstream) {
            rawHeaders = h2HeadersToH1(rawHeaders);
        }

        // Drop proxy-connection header. This is almost always intended for us, not for upstream servers,
        // and forwarding it causes problems (most notably, it triggers lots of weird-traffic blocks,
        // most notably by Cloudflare).
        rawHeaders = rawHeaders.filter(([key]) =>
            key.toLowerCase() !== 'proxy-connection'
        );

        let serverReq: http.ClientRequest;
        return new Promise<void>((resolve, reject) => (async () => { // Wrapped to easily catch (a)sync errors
            serverReq = await makeRequest({
                protocol,
                method,
                hostname,
                port,
                family,
                path,
                headers: shouldTryH2Upstream
                    ? rawHeadersToObjectPreservingCase(rawHeaders)
                    : flattenPairedRawHeaders(rawHeaders) as any,
                lookup: getDnsLookupFunction(this.lookupOptions) as typeof dns.lookup,
                // ^ Cast required to handle __promisify__ type hack in the official Node types
                agent,

                // TLS options:
                ...getUpstreamTlsOptions(strictHttpsChecks),
                ...clientCert,
                ...caConfig
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

                    if (resBodyOverride) {
                        // In the above cases, the overriding data is assumed to always be in decoded form,
                        // so we re-encode the body to match the resulting content-encoding header:
                        resBodyOverride = await encodeBodyBuffer(
                            resBodyOverride,
                            serverRawHeaders
                        );

                        const updatedCLHeader = getContentLengthAfterModification(
                            resBodyOverride,
                            serverRes.headers,
                            (updateHeaders && getHeaderValue(updateHeaders, 'content-length') !== undefined)
                                ? serverRawHeaders // Iff you replaced the content length
                                : replaceHeaders,
                            method === 'HEAD' // HEAD responses are allowed mismatched content-length
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
                        url: reqUrl,
                        path: path ?? '',
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
                            (clientReq as any).socket.end();
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
                        modifiedRes?.status ||
                        serverStatusCode;
                    serverStatusMessage = modifiedRes?.statusMessage ||
                        serverStatusMessage;

                    serverHeaders = modifiedRes?.headers || serverHeaders;

                    resBodyOverride = await buildOverriddenBody(modifiedRes, serverHeaders);

                    if (resBodyOverride) {
                        serverHeaders['content-length'] = getContentLengthAfterModification(
                            resBodyOverride,
                            serverRes.headers,
                            modifiedRes?.headers,
                            method === 'HEAD' // HEAD responses are allowed mismatched content-length
                        );
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
                    tags: buildUpstreamErrorTags(e),
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
                    path,
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
                if (e.code === 'ECONNRESET' || e.code === 'ECONNREFUSED' || this.simulateConnectionErrors) {
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
        ruleParams: RuleParameters
    ): PassThroughHandler {
        let beforeRequest: ((req: CompletedRequest) => MaybePromise<CallbackRequestResult | void>) | undefined;
        if (data.hasBeforeRequestCallback) {
            beforeRequest = async (req: CompletedRequest) => {
                const result = withDeserializedCallbackBuffers<CallbackRequestResult>(
                    await channel.request<
                        BeforePassthroughRequestRequest,
                        WithSerializedCallbackBuffers<CallbackRequestResult>
                    >('beforeRequest', {
                        args: [withSerializedBodyReader(req)]
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
                    args: [withSerializedBodyReader(res), withSerializedBodyReader(req)]
                })

                if (callbackResult && typeof callbackResult !== 'string') {
                    return withDeserializedCallbackBuffers(callbackResult);
                } else {
                    return callbackResult;
                }
            };
        }

        return new PassThroughHandler({
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
                ...(data.transformRequest?.matchReplaceBody !== undefined ? {
                    matchReplaceBody: data.transformRequest.matchReplaceBody.map(([match, result]) =>
                        [
                            !_.isString(match) && 'regexSource' in match
                                ? new RegExp(match.regexSource, match.flags)
                                : match,
                            result
                        ]
                    )
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
                    matchReplaceBody: data.transformResponse.matchReplaceBody.map(([match, result]) =>
                        [
                            !_.isString(match) && 'regexSource' in match
                                ? new RegExp(match.regexSource, match.flags)
                                : match,
                            result
                        ]
                    )
                } : {})
            } as ResponseTransform : undefined,
            // Backward compat for old clients:
            ...data.forwardToLocation ? {
                forwarding: { targetHost: data.forwardToLocation }
            } : {},
            forwarding: data.forwarding,
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

export class CloseConnectionHandler extends CloseConnectionHandlerDefinition {
    async handle(request: OngoingRequest) {
        const socket: net.Socket = (request as any).socket;
        socket.end();
        throw new AbortError('Connection closed intentionally by rule', 'E_RULE_CLOSE');
    }
}

export class ResetConnectionHandler extends ResetConnectionHandlerDefinition {
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
        return new ResetConnectionHandler();
    }
}

export class TimeoutHandler extends TimeoutHandlerDefinition {
    async handle() {
        // Do nothing, leaving the socket open but never sending a response.
        return new Promise<void>(() => {});
    }
}

export class JsonRpcResponseHandler extends JsonRpcResponseHandlerDefinition {
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

export const HandlerLookup: typeof HandlerDefinitionLookup = {
    'simple': SimpleHandler,
    'callback': CallbackHandler,
    'stream': StreamHandler,
    'file': FileHandler,
    'passthrough': PassThroughHandler,
    'close-connection': CloseConnectionHandler,
    'reset-connection': ResetConnectionHandler,
    'timeout': TimeoutHandler,
    'json-rpc-response': JsonRpcResponseHandler
}

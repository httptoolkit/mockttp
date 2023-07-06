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
import { Readable, Transform } from 'stream';
import { stripIndent, oneLine } from 'common-tags';
import { TypedError } from 'typed-error';

import {
    Headers,
    OngoingRequest,
    CompletedRequest,
    OngoingResponse
} from "../../types";

import { MaybePromise } from '../../util/type-utils';
import {
    waitForCompletedRequest,
    buildBodyReader,
    shouldKeepAlive,
    dropDefaultHeaders,
    isHttp2,
    isAbsoluteUrl,
    writeHead,
    encodeBodyBuffer,
    validateHeader
} from '../../util/request-utils';
import {
    h1HeadersToH2,
    h2HeadersToH1,
    objectHeadersToRaw,
    rawHeadersToObject,
    rawHeadersToObjectPreservingCase,
    flattenPairedRawHeaders,
    findRawHeader,
    pairFlatRawHeaders
} from '../../util/header-utils';
import { streamToBuffer, asBuffer } from '../../util/buffer-utils';
import {
    isLocalhostAddress,
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
    getContentLengthAfterModification,
    getHostAfterModification,
    getH2HeadersAfterModification,
    OVERRIDABLE_REQUEST_PSEUDOHEADERS,
    buildOverriddenBody,
    UPSTREAM_TLS_OPTIONS,
    shouldUseStrictHttps,
    getClientRelativeHostname,
    getDnsLookupFunction
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
    ForwardingOptions,
    HandlerDefinitionLookup,
    JsonRpcResponseHandlerDefinition,
    PassThroughHandlerDefinition,
    PassThroughHandlerOptions,
    PassThroughLookupOptions,
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
        readonly code?: string
    ) {
        super(message);
    }

}

function isSerializedBuffer(obj: any): obj is SerializedBuffer {
    return obj && obj.type === 'Buffer' && !!obj.data;
}

export interface RequestHandler extends RequestHandlerDefinition {
    handle(request: OngoingRequest, response: OngoingResponse): Promise<void>;
}

export class SimpleHandler extends SimpleHandlerDefinition {
    async handle(_request: OngoingRequest, response: OngoingResponse) {
        if (this.headers) dropDefaultHeaders(response);
        writeHead(response, this.status, this.statusMessage, this.headers);

        if (isSerializedBuffer(this.data)) {
            this.data = Buffer.from(<any> this.data);
        }

        response.end(this.data || "");
    }
}

async function writeResponseFromCallback(result: CallbackResponseMessageResult, response: OngoingResponse) {
    if (result.json !== undefined) {
        result.headers = _.assign(result.headers || {}, { 'Content-Type': 'application/json' });
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
            Buffer.from(result.body),
            result.headers ?? {}
        );
    }

    writeHead(
        response,
        result.statusCode || result.status || 200,
        result.statusMessage,
        result.headers
    );

    if (result.rawBody instanceof Readable) {
        (result.rawBody as Readable).pipe(response);
    } else {
        response.end(result.rawBody || "");
    }
}

export class CallbackHandler extends CallbackHandlerDefinition {

    async handle(request: OngoingRequest, response: OngoingResponse) {
        let req = await waitForCompletedRequest(request);

        let outResponse: CallbackResponseResult;
        try {
            outResponse = await this.callback(req);
        } catch (error) {
            writeHead(response, 500, 'Callback handler threw an exception');
            response.end(isErrorLike(error) ? error.toString() : error);
            return;
        }

        if (outResponse === 'close') {
            (request as any).socket.end();
            throw new AbortError('Connection closed intentionally by rule');
        } else if (outResponse === 'reset') {
            requireSocketResetSupport();
            resetOrDestroy(request);
            throw new AbortError('Connection reset intentionally by rule');
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
            this._trustedCACertificates = Promise.all(
                (tls.rootCertificates as Array<string | Promise<string>>)
                    .concat(this.extraCACertificates.map(certObject => {
                        if ('cert' in certObject) {
                            return certObject.cert.toString('utf8');
                        } else {
                            return fs.readFile(certObject.certPath, 'utf8');
                        }
                    }))
            );
        }

        return this._trustedCACertificates;
    }

    async handle(clientReq: OngoingRequest, clientRes: OngoingResponse) {
        // Don't let Node add any default standard headers - we want full control
        dropDefaultHeaders(clientRes);

        // Capture raw request data:
        let { method, url: reqUrl, rawHeaders } = clientReq as OngoingRequest;
        let { protocol, hostname, port, path } = url.parse(reqUrl);

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

            let hostHeader = findRawHeader(rawHeaders, hostHeaderName);
            if (!hostHeader) {
                // Should never happen really, but just in case:
                hostHeader = [hostHeaderName, hostname!];
                rawHeaders.unshift(hostHeader);
            };

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
            let headers = rawHeadersToObject(rawHeaders);

            const {
                replaceMethod,
                updateHeaders,
                replaceHeaders,
                replaceBody,
                replaceBodyFromFile,
                updateJsonBody,
                matchReplaceBody
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
                reqBodyOverride = await fs.readFile(replaceBodyFromFile);
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
                    headers
                );

                headers['content-length'] = getContentLengthAfterModification(
                    reqBodyOverride,
                    clientReq.headers,
                    (updateHeaders && updateHeaders['content-length'] !== undefined)
                        ? headers // Iff you replaced the content length
                        : replaceHeaders,
                );
            }

            if (headersManuallyModified || reqBodyOverride) {
                // If the headers have been updated (implicitly or explicitly) we need to regenerate them. We avoid
                // this if possible, because it normalizes headers, which is slightly lossy (e.g. they're lowercased).
                rawHeaders = objectHeadersToRaw(headers);
            }
        } else if (this.beforeRequest) {
            const completedRequest = await waitForCompletedRequest(clientReq);
            const clientRawHeaders = completedRequest.rawHeaders;
            const clientHeaders = rawHeadersToObject(clientRawHeaders);

            const modifiedReq = await this.beforeRequest({
                ...completedRequest,
                url: reqUrl, // May have been overwritten by forwarding
                headers: _.cloneDeep(clientHeaders),
                rawHeaders: _.cloneDeep(clientRawHeaders)
            });

            if (modifiedReq?.response) {
                if (modifiedReq.response === 'close') {
                    const socket: net.Socket = (<any> clientReq).socket;
                    socket.end();
                    throw new AbortError('Connection closed intentionally by rule');
                } else if (modifiedReq.response === 'reset') {
                    requireSocketResetSupport();
                    resetOrDestroy(clientReq);
                    throw new AbortError('Connection reset intentionally by rule');
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

        const strictHttpsChecks = shouldUseStrictHttps(hostname!, port!, this. ignoreHostHttpsErrors);

        // Use a client cert if it's listed for the host+port or whole hostname
        const hostWithPort = `${hostname}:${port}`;
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
                ...UPSTREAM_TLS_OPTIONS,
                minVersion: strictHttpsChecks ? tls.DEFAULT_MIN_VERSION : 'TLSv1', // Allow TLSv1, if !strict
                rejectUnauthorized: strictHttpsChecks,
                ...clientCert,
                ...caConfig
            }, (serverRes) => (async () => {
                serverRes.on('error', (e: any) => {
                    e.causedByUpstreamError = true;
                    reject(e);
                });

                let serverStatusCode = serverRes.statusCode!;
                let serverStatusMessage = serverRes.statusMessage
                let serverRawHeaders = pairFlatRawHeaders(serverRes.rawHeaders);
                let resBodyOverride: Uint8Array | undefined;

                if (isH2Downstream) {
                    serverRawHeaders = h1HeadersToH2(serverRawHeaders);
                }

                if (this.transformResponse) {
                    let serverHeaders = rawHeadersToObject(serverRawHeaders);

                    const {
                        replaceStatus,
                        updateHeaders,
                        replaceHeaders,
                        replaceBody,
                        replaceBodyFromFile,
                        updateJsonBody,
                        matchReplaceBody
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
                        resBodyOverride = await fs.readFile(replaceBodyFromFile);
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
                    } else if (matchReplaceBody) {
                        const rawBody = await streamToBuffer(serverRes);
                        const realBody = buildBodyReader(rawBody, serverRes.headers);

                        const originalBody = await realBody.getText();
                        if (originalBody === undefined) {
                            throw new Error("Can't match & replace non-decodeable response body");
                        }

                        let replacedBody = originalBody;
                        for (let [match, result] of matchReplaceBody) {
                            replacedBody = replacedBody!.replace(match, result);
                        }

                        if (replacedBody !== originalBody) {
                            resBodyOverride = asBuffer(replacedBody);
                        }
                    }

                    if (resBodyOverride) {
                        // We always re-encode the body to match the resulting content-encoding header:
                        resBodyOverride = await encodeBodyBuffer(
                            resBodyOverride,
                            serverHeaders
                        );

                        serverHeaders['content-length'] = getContentLengthAfterModification(
                            resBodyOverride,
                            serverRes.headers,
                            (updateHeaders && updateHeaders['content-length'] !== undefined)
                                ? serverHeaders // Iff you replaced the content length
                                : replaceHeaders,
                            method === 'HEAD' // HEAD responses are allowed mismatched content-length
                        );
                    }

                    serverRawHeaders = objectHeadersToRaw(serverHeaders);
                } else if (this.beforeResponse) {
                    let modifiedRes: CallbackResponseResult | void;
                    let body: Buffer;

                    body = await streamToBuffer(serverRes);
                    let serverHeaders = rawHeadersToObject(serverRawHeaders);

                    modifiedRes = await this.beforeResponse({
                        id: clientReq.id,
                        statusCode: serverStatusCode,
                        statusMessage: serverRes.statusMessage,
                        headers: serverHeaders,
                        rawHeaders: _.cloneDeep(serverRawHeaders),
                        body: buildBodyReader(body, serverHeaders)
                    });

                    if (modifiedRes === 'close') {
                        // Dump the real response data and kill the client socket:
                        serverRes.resume();
                        (clientReq as any).socket.end();
                        throw new AbortError('Connection closed intentionally by rule');
                    } else if (modifiedRes === 'reset') {
                        requireSocketResetSupport();

                        // Dump the real response data and kill the client socket:
                        serverRes.resume();
                        resetOrDestroy(clientReq);
                        throw new AbortError('Connection reset intentionally by rule');
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
                    } else {
                        // If you don't specify a body override, we need to use the real
                        // body anyway, because as we've read it already streaming it to
                        // the response won't work
                        resBodyOverride = body;
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
                e.causedByUpstreamError = true;
                reject(e);
            });

            // We always start upstream connections *immediately*. This might be less efficient, but it
            // ensures that we're accurately mirroring downstream, which has indeed already connected.
            serverReq.flushHeaders();

            // For similar reasons, we don't want any buffering on outgoing data at all if possible:
            serverReq.setNoDelay(true);
        })().catch(reject)
        ).catch((e: ErrorLike) => {
            // All errors anywhere above (thrown or from explicit reject()) should end up here.

            // We tag the response with the error code, for debugging from events:
            clientRes.tags.push('passthrough-error:' + e.code);

            // Tag responses, so programmatic examination can react to this
            // event, without having to parse response data or similar.
            const tlsAlertMatch = /SSL alert number (\d+)/.exec(e.message ?? '');
            if (tlsAlertMatch) {
                clientRes.tags.push('passthrough-tls-error:ssl-alert-' + tlsAlertMatch[1]);
            }

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

                    throw new AbortError(`Upstream connection error: ${errorMessage}`, e.code);
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

        let beforeResponse: ((res: PassThroughResponse) => MaybePromise<CallbackResponseResult | void>) | undefined;
        if (data.hasBeforeResponseCallback) {
            beforeResponse = async (res: PassThroughResponse) => {
                const callbackResult = await channel.request<
                    BeforePassthroughResponseRequest,
                    | WithSerializedCallbackBuffers<CallbackResponseMessageResult>
                    | 'close'
                    | 'reset'
                    | undefined
                >('beforeResponse', {
                    args: [withSerializedBodyReader(res)]
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
            trustAdditionalCAs: data.extraCACertificates,
            clientCertificateHostMap: _.mapValues(data.clientCertificateHostMap,
                ({ pfx, passphrase }) => ({ pfx: deserializeBuffer(pfx), passphrase })
            ),
        });
    }
}

export class CloseConnectionHandler extends CloseConnectionHandlerDefinition {
    async handle(request: OngoingRequest) {
        const socket: net.Socket = (<any> request).socket;
        socket.end();
        throw new AbortError('Connection closed intentionally by rule');
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
        throw new AbortError('Connection reset intentionally by rule');
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

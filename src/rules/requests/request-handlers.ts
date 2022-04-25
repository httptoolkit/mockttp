import _ = require('lodash');
import url = require('url');
import type dns = require('dns');
import net = require('net');
import tls = require('tls');
import http = require('http');
import http2 = require('http2');
import https = require('https');
import * as h2Client from 'http2-wrapper';
import CacheableLookup from 'cacheable-lookup';
import { decode as decodeBase64 } from 'base64-arraybuffer';
import { Transform } from 'stream';
import { stripIndent, oneLine } from 'common-tags';
import { TypedError } from 'typed-error';
import { encodeBuffer, SUPPORTED_ENCODING } from 'http-encoding';

import {
    Headers,
    OngoingRequest,
    CompletedRequest,
    OngoingResponse,
    CompletedBody
} from "../../types";

import { byteLength } from '../../util/util';
import { MaybePromise } from '../../util/type-utils';
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
    ClientServerChannel,
    deserializeBuffer,
    deserializeProxyConfig
} from '../../serialization/serialization';
import {
    withSerializedBodyReader,
    withDeserializedBodyBuffer,
    WithSerializedBodyBuffer
} from '../../serialization/body-serialization';
import { CachedDns, DnsLookupFunction } from '../../util/dns';
import { ErrorLike, isErrorLike } from '../../util/error';

import { assertParamDereferenced, RuleParameters } from '../rule-parameters';

import { getAgent } from '../http-agents';
import { ProxySettingSource } from '../proxy-config';
import { MOCKTTP_UPSTREAM_CIPHERS } from '../passthrough-handling';

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
    PassThroughHandlerDefinition,
    PassThroughHandlerOptions,
    PassThroughLookupOptions,
    PassThroughResponse,
    RequestHandlerDefinition,
    RequestTransform,
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
export class AbortError extends TypedError { }

function isSerializedBuffer(obj: any): obj is SerializedBuffer {
    return obj && obj.type === 'Buffer' && !!obj.data;
}

export interface RequestHandler extends RequestHandlerDefinition {
    handle(request: OngoingRequest, response: OngoingResponse): Promise<void>;
}

export class SimpleHandler extends SimpleHandlerDefinition {
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

export class CallbackHandler extends CallbackHandlerDefinition {

    async handle(request: OngoingRequest, response: OngoingResponse) {
        let req = await waitForCompletedRequest(request);

        let outResponse: CallbackResponseResult;
        try {
            outResponse = await this.callback(req);
        } catch (error) {
            response.writeHead(500, 'Callback handler threw an exception');
            response.end(isErrorLike(error) ? error.toString() : error);
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

export class StreamHandler extends StreamHandlerDefinition {

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
        const fileContents = await readFile(this.filePath, null);

        if (this.headers) {
            dropDefaultHeaders(response);
            setHeaders(response, this.headers);
        }

        response.writeHead(this.status, this.statusMessage);
        response.end(fileContents);
    }
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
                            return readFile(certObject.certPath, 'utf8');
                        }
                    }))
            );
        }

        return this._trustedCACertificates;
    }

    private _cacheableLookupInstance: CacheableLookup | CachedDns | undefined;
    private lookup(): DnsLookupFunction {
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

    async handle(clientReq: OngoingRequest, clientRes: OngoingResponse) {
        // Don't let Node add any default standard headers - we want full control
        dropDefaultHeaders(clientRes);

        // Capture raw request data:
        let { method, url: reqUrl, headers } = clientReq;
        let { protocol, hostname, port, path } = url.parse(reqUrl);

        const isH2Downstream = isHttp2(clientReq);

        if (isLocalhostAddress(hostname) && clientReq.remoteIpAddress && !isLocalhostAddress(clientReq.remoteIpAddress)) {
            // If we're proxying localhost traffic from another remote machine, then we should really be proxying
            // back to that machine, not back to ourselves! Best example is docker containers: if we capture & inspect
            // their localhost traffic, it should still be sent back into that docker container.
            hostname = clientReq.remoteIpAddress;

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
                // We always re-encode the body to match the resulting content-encoding header:
                reqBodyOverride = await encodeBuffer(
                    reqBodyOverride,
                    (headers['content-encoding'] || '') as SUPPORTED_ENCODING,
                    { level: 1 }
                );

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
                lookup: this.lookup() as typeof dns.lookup,
                // ^ Cast required to handle __promisify__ type hack in the official Node types
                agent,
                // TLS options:
                ciphers: MOCKTTP_UPSTREAM_CIPHERS,
                minVersion: strictHttpsChecks ? tls.DEFAULT_MIN_VERSION : 'TLSv1', // Allow TLSv1, if !strict
                rejectUnauthorized: strictHttpsChecks,
                ...clientCert,
                ...caConfig
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
                            (serverHeaders['content-encoding'] || '') as SUPPORTED_ENCODING,
                            { level: 1 }
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
                        // We always re-encode the body to match the resulting content-encoding header:
                        resBodyOverride = await encodeBuffer(
                            resBodyOverride,
                            (serverHeaders['content-encoding'] || '') as SUPPORTED_ENCODING,
                            { level: 1 }
                        );

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
                        console.log(`Error setting header on passthrough response: ${
                            (isErrorLike(e) && e.message) || e
                        }`);
                    }
                });

                clientRes.writeHead(serverStatusCode, serverStatusMessage);

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

            serverReq.on('error', (e: ErrorLike) => {
                if ((<any>serverReq).aborted) return;

                // Tag responses, so programmatic examination can react to this
                // event, without having to parse response data or similar.
                const tlsAlertMatch = /SSL alert number (\d+)/.exec(e.message ?? '');
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
    static deserialize(
        data: SerializedPassThroughData,
        channel: ClientServerChannel,
        ruleParams: RuleParameters
    ): PassThroughHandler {
        let beforeRequest: ((req: CompletedRequest) => MaybePromise<CallbackRequestResult | void>) | undefined;
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

        let beforeResponse: ((res: PassThroughResponse) => MaybePromise<CallbackResponseResult | void>) | undefined;
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
            proxyConfig: deserializeProxyConfig(data.proxyConfig, channel, ruleParams),
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
            lookupOptions: data.lookupOptions,
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
        throw new AbortError('Connection closed (intentionally)');
    }
}

export class TimeoutHandler extends TimeoutHandlerDefinition {
    async handle() {
        // Do nothing, leaving the socket open but never sending a response.
        return new Promise<void>(() => {});
    }
}

export const HandlerLookup: typeof HandlerDefinitionLookup = {
    'simple': SimpleHandler,
    'callback': CallbackHandler,
    'stream': StreamHandler,
    'file': FileHandler,
    'passthrough': PassThroughHandler,
    'close-connection': CloseConnectionHandler,
    'timeout': TimeoutHandler
}
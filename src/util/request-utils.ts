import { Buffer } from 'buffer';
import * as stream from 'stream';
import * as net from 'net';
import { TLSSocket } from 'tls';
import * as querystring from 'querystring';
import * as url from 'url';
import * as http from 'http';
import * as http2 from 'http2';

import * as _ from 'lodash';
import * as multipart from 'parse-multipart-data';
import now = require("performance-now");
import type { SUPPORTED_ENCODING } from 'http-encoding';
import { MaybePromise } from '@httptoolkit/util';

import {
    Headers,
    OngoingRequest,
    CompletedRequest,
    OngoingResponse,
    CompletedResponse,
    OngoingBody,
    CompletedBody,
    TimingEvents,
    InitiatedRequest,
    RawHeaders,
    Destination,
    InitiatedResponse,
    RawTrailers
} from "../types";

import { makePropertyWritable } from './util';
import { Mutable } from './type-utils';
import {
    bufferThenStream,
    bufferToStream,
    BufferInProgress,
    splitBuffer,
    streamToBuffer,
    asBuffer
} from './buffer-utils';
import {
    flattenPairedRawHeaders,
    getHeaderValue,
    objectHeadersToFlat,
    objectHeadersToRaw,
    pairFlatRawHeaders,
    rawHeadersToObject
} from './header-utils';
import { isIP } from './ip-utils';
import {
    getDestination,
    getHostFromAbsoluteUrl,
    getPathFromAbsoluteUrl,
    isAbsoluteUrl,
    normalizeHost
} from './url';
import {
    LastHopEncrypted,
    LastTunnelAddress,
    SocketMetadata,
    SocketTimingInfo,
    TlsMetadata
} from './socket-extensions';
import {
    getSocketMetadataFromProxyAuth,
    getSocketMetadataTags
} from './socket-metadata';

export const shouldKeepAlive = (req: OngoingRequest): boolean =>
    req.httpVersion !== '1.0' &&
    req.headers['connection'] !== 'close';

export const writeHead = (
    response: http.ServerResponse | http2.Http2ServerResponse,
    status: number,
    statusMessage?: string | undefined,
    headers?: Headers | RawHeaders | undefined
) => {
    const flatHeaders: http.OutgoingHttpHeaders | string[] =
        headers === undefined
            ? {}
        : isHttp2(response) && Array.isArray(headers)
            // H2 raw headers support is poor so we map to object here.
            // We should revert to flat headers once the below is resolved in LTS:
            // https://github.com/nodejs/node/issues/51402
            ? rawHeadersToObject(headers)
        : isHttp2(response)
            ? headers as Headers // H2 supports object headers just fine
        : !Array.isArray(headers)
            ? objectHeadersToFlat(headers)
        // RawHeaders for H1, must be flattened:
            : flattenPairedRawHeaders(headers);

    // We aim to always pass flat headers to writeHead instead of calling setHeader because
    // in most cases it's more flexible about supporting raw data, e.g. multiple headers with
    // different casing can't be represented with setHeader at all (the latter overwrites).

    if (statusMessage === undefined) {
        // Cast is required as Node H2 types don't know about raw headers:
        response.writeHead(status, flatHeaders as http.OutgoingHttpHeaders);
    } else {
        response.writeHead(status, statusMessage, flatHeaders as http.OutgoingHttpHeaders);
    }
};

export function isHttp2(
    message: | http.IncomingMessage
             | http.ServerResponse
             | http2.Http2ServerRequest
             | http2.Http2ServerResponse
             | OngoingRequest
             | OngoingResponse
): message is http2.Http2ServerRequest | http2.Http2ServerResponse {
    return ('httpVersion' in message && !!message.httpVersion?.startsWith('2')) || // H2 request
        ('stream' in message && 'createPushResponse' in message); // H2 response
}

export async function encodeBodyBuffer(buffer: Uint8Array, headers: Headers | RawHeaders) {
    const contentEncoding = getHeaderValue(headers, 'content-encoding');

    // We skip encodeBuffer entirely if possible - this isn't strictly necessary, but it's useful
    // so you can drop the http-encoding package in bundling downstream without issue in cases
    // where you don't actually use any encodings.
    if (!contentEncoding) return buffer;

    return await (await import('http-encoding')).encodeBuffer(
        buffer,
        contentEncoding as SUPPORTED_ENCODING,
        { level: 1 }
    );
}

export async function decodeBodyBuffer(buffer: Buffer, headers: Headers) {
    const contentEncoding = headers['content-encoding'];

    // We skip decodeBuffer entirely if possible - this isn't strictly necessary, but it's useful
    // so you can drop the http-encoding package in bundling downstream without issue in cases
    // where you don't actually use any encodings.
    if (!contentEncoding || contentEncoding === 'identity') return buffer;

    return await (await import('http-encoding')).decodeBuffer(
        buffer,
        contentEncoding as SUPPORTED_ENCODING
    )
}

// Parse an in-progress request or response stream, i.e. where the body or possibly even the headers have
// not been fully received/sent yet.
const parseBodyStream = (bodyStream: stream.Readable, maxSize: number, getHeaders: () => Headers): OngoingBody => {
    let bufferPromise: BufferInProgress | null = null;
    let completedBuffer: Buffer | null = null;

    let body = {
        // Returns a stream for the full body, not the live streaming body.
        // Each call creates a new stream, which starts with the already seen
        // and buffered data, and then continues with the live stream, if active.
        // Listeners to this stream *must* be attached synchronously after this call.
        asStream() {
            // If we've already buffered the whole body, just stream it out:
            if (completedBuffer) return bufferToStream(completedBuffer);

            // Otherwise, we want to start buffering now, and wrap that with
            // a stream that can live-stream the buffered data on demand:
            const buffer = body.asBuffer();
            buffer.catch(() => {}); // Errors will be handled via the stream, so silence unhandled rejections here.
            return bufferThenStream(buffer, bodyStream);
        },
        asBuffer() {
            if (!bufferPromise) {
                bufferPromise = streamToBuffer(bodyStream, maxSize);

                bufferPromise
                    .then((buffer) => completedBuffer = buffer)
                    .catch(() => {}); // If we get no body, completedBuffer stays null
            }
            return bufferPromise;
        },
        async asDecodedBuffer() {
            const buffer = await body.asBuffer();
            return decodeBodyBuffer(buffer, getHeaders());
        },
        asText(encoding: BufferEncoding = 'utf8') {
            return body.asDecodedBuffer().then((b) => b.toString(encoding));
        },
        asJson() {
            return body.asText().then((t) => JSON.parse(t));
        },
        asFormData() {
            return body.asText().then((t) => querystring.parse(t));
        },
    };

    return body;
}

async function runAsyncOrUndefined<R>(func: () => Promise<R>): Promise<R | undefined> {
    try {
        return await func();
    } catch {
        return undefined;
    }
}

const waitForBody = async (body: OngoingBody, headers: Headers): Promise<CompletedBody> => {
    const bufferBody = await body.asBuffer();
    return buildBodyReader(bufferBody, headers);
};

export const isMockttpBody = (body: any): body is CompletedBody => {
    return body.hasOwnProperty('getDecodedBuffer');
}

type BodyDecoder = (buffer: Buffer, headers: Headers) => MaybePromise<Buffer>;

export const buildBodyReader = (
    body: Buffer,
    headers: Headers,
    bufferDecoder: BodyDecoder = decodeBodyBuffer
): CompletedBody => {
    const completedBody = {
        buffer: body,

        async getDecodedBuffer() {
            return runAsyncOrUndefined(async () =>
                asBuffer(
                    await bufferDecoder(this.buffer, headers)
                )
            );
        },
        async getText() {
            return runAsyncOrUndefined(async () =>
                (await this.getDecodedBuffer())!.toString()
            );
        },
        async getJson() {
            return runAsyncOrUndefined(async () =>
                JSON.parse((await completedBody.getText())!)
            )
        },
        async getUrlEncodedFormData() {
            return runAsyncOrUndefined(async () => {
                const contentType = headers["content-type"];
                if (contentType?.includes("multipart/form-data")) return; // Actively ignore multipart data - won't work as expected

                const text = await completedBody.getText();
                return text ? querystring.parse(text) : undefined;
            });
        },
        async getMultipartFormData() {
            return runAsyncOrUndefined(async () => {
                const contentType = headers["content-type"];
                if (!contentType?.includes("multipart/form-data")) return;

                const boundary = contentType.match(/;\s*boundary=(\S+)/);

                // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Type#boundary
                // `boundary` is required for multipart entities.
                if (!boundary) return;

                const decoded = await this.getDecodedBuffer();
                if (!decoded) return;

                return multipart.parse(decoded, boundary[1]);
            });
        },
        async getFormData(): Promise<querystring.ParsedUrlQuery | undefined> {
            return runAsyncOrUndefined(async () => {
                // Return multi-part data if present, or fallback to default URL-encoded
                // parsing for all other cases. Data is returned in the same format regardless.
                const multiPartBody = await completedBody.getMultipartFormData();
                if (multiPartBody) {
                    const formData: querystring.ParsedUrlQuery = {};

                    multiPartBody.forEach((part) => {
                        const name = part.name;
                        if (name === undefined) {
                            // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Disposition#as_a_header_for_a_multipart_body,
                            // The header must include `name` property to identify the field name.
                            // So we ignore parts without a name, treating it as invalid multipart form data.
                        } else {
                            // We do not use `filename` or `type` here, because return value of `getFormData` must be string or string array.

                            const prevValue = formData[name];
                            if (prevValue === undefined) {
                                formData[name] = part.data.toString();
                            } else if (Array.isArray(prevValue)) {
                                prevValue.push(part.data.toString());
                            } else {
                                formData[name] = [prevValue, part.data.toString()];
                            }
                        }
                    });

                    return formData;
                } else {
                    return completedBody.getUrlEncodedFormData();
                }
            });
        }
    };

    return completedBody;
};

export const parseRequestBody = (
    req: http.IncomingMessage | http2.Http2ServerRequest,
    options: { maxSize: number }
) => {
    let transformedRequest = req as any as OngoingRequest;
    transformedRequest.body = parseBodyStream(req, options.maxSize, () => req.headers);
};

export type ExtendedRawRequest = (http.IncomingMessage | http2.Http2ServerRequest) & {
    protocol?: string;
    body?: OngoingBody;
    path?: string;
    destination?: Destination;
    [SocketMetadata]?: SocketMetadata;
};

/**
 * For both normal requests & websockets, we do some standard preprocessing to ensure we have the absolute
 * URL destination in place, and timing, tags & id metadata all ready for an OngoingRequest.
 */
export function preprocessRequest(req: ExtendedRawRequest, options: {
    type: 'request' | 'websocket',
    serverPort: number,
    maxBodySize: number,
    onBodyData?: (id: string, timestamp: number, content: Uint8Array, isEnded: boolean) => void
}): OngoingRequest | null {
    parseRequestBody(req, { maxSize: options.maxBodySize });

    let rawHeaders = pairFlatRawHeaders(req.rawHeaders);
    let socketMetadata: SocketMetadata | undefined = req.socket[SocketMetadata];

    // Make req.url always absolute, if it isn't already, using the host header.
    // It might not be if this is a direct request, or if it's being transparently proxied.
    if (!isAbsoluteUrl(req.url!)) {
        req.protocol = getHeaderValue(rawHeaders, ':scheme') ||
            (req.socket[LastHopEncrypted] ? 'https' : 'http');
        req.path = req.url;

        const tunnelDestination = req.socket[LastTunnelAddress]
            ? getDestination(req.protocol, req.socket[LastTunnelAddress])
            : undefined;

        const isTunnelToIp = !!tunnelDestination && isIP(tunnelDestination.hostname);

        const urlDestination = getDestination(req.protocol,
            (!isTunnelToIp
            ? (
                req.socket[LastTunnelAddress] ?? // Tunnel domain name is preferred if available
                getHeaderValue(rawHeaders, ':authority') ??
                getHeaderValue(rawHeaders, 'host') ??
                req.socket[TlsMetadata]?.sniHostname
            )
            : (
                getHeaderValue(rawHeaders, ':authority') ??
                getHeaderValue(rawHeaders, 'host') ??
                req.socket[TlsMetadata]?.sniHostname ??
                req.socket[LastTunnelAddress] // We use the IP iff we have no hostname available at all
            ))
            ?? `localhost:${options.serverPort}` // If you specify literally nothing, it's a direct request
        );

        // Actual destination always follows the tunnel - even if it's an IP
        req.destination = tunnelDestination
            ?? urlDestination;

        // URL port should always match the real port - even if (e.g) the Host header is lying.
        urlDestination.port = req.destination.port;

        const absoluteUrl = `${req.protocol}://${
            normalizeHost(req.protocol, `${urlDestination.hostname}:${urlDestination.port}`)
        }${req.path}`;

        let effectiveUrl: string;
        try {
            effectiveUrl = new URL(absoluteUrl).toString();
        } catch (e: any) {
            req.url = absoluteUrl;
            throw e;
        }

        if (!getHeaderValue(rawHeaders, ':path')) {
            (req as Mutable<ExtendedRawRequest>).url = effectiveUrl;
        } else {
            // Node's HTTP/2 compat logic maps .url to headers[':path']. We want them to
            // diverge: .url should always be absolute, while :path may stay relative,
            // so we override the built-in getter & setter:
            Object.defineProperty(req, 'url', {
                value: effectiveUrl
            });
        }
    } else {
        // We have an absolute request. This is effectively a combined tunnel + end-server request,
        // so we need to handle both of those, and hide the proxy-specific bits from later logic.
        req.protocol = req.url!.split('://', 1)[0];
        req.path = getPathFromAbsoluteUrl(req.url!);
        req.destination = getDestination(
            req.protocol,
            req.socket[LastTunnelAddress] ?? getHostFromAbsoluteUrl(req.url!)
        );

        const proxyAuthHeader = getHeaderValue(rawHeaders, 'proxy-authorization');
        if (proxyAuthHeader) {
            // Use this metadata for this request, but _only_ this request - it's not relevant
            // to other requests on the same socket so we don't add it to req.socket.
            socketMetadata = getSocketMetadataFromProxyAuth(req.socket, proxyAuthHeader);
        }

        rawHeaders = rawHeaders.filter(([key]) => {
            const lcKey = key.toLowerCase();
            return lcKey !== 'proxy-connection' &&
                lcKey !== 'proxy-authorization';
        })
    }

    if (options.type === 'websocket') {
        req.protocol = req.protocol === 'https'
            ? 'wss'
            : 'ws';

        // Transform the protocol in req.url too:
        Object.defineProperty(req, 'url', {
            value: req.url!.replace(/^http/, 'ws')
        });
    }

    const id = crypto.randomUUID();

    const tags: string[] = getSocketMetadataTags(socketMetadata);

    const timingEvents: TimingEvents = {
        startTime: Date.now(),
        startTimestamp: now()
    };

    // Set/update the last request time on the socket
    let socketTimingInfo = req.socket[SocketTimingInfo];
    if (socketTimingInfo) {
        socketTimingInfo.lastRequestTimestamp = timingEvents.startTimestamp;
    }

    req.on('end', () => {
        timingEvents.bodyReceivedTimestamp ||= now();
    });

    const headers = rawHeadersToObject(rawHeaders);

    // Not writable for HTTP/2:
    makePropertyWritable(req, 'headers');
    makePropertyWritable(req, 'rawHeaders');

    let rawTrailers: RawTrailers | undefined;
    Object.defineProperty(req, 'rawTrailers', {
        get: () => rawTrailers,
        set: (flatRawTrailers) => {
            rawTrailers = flatRawTrailers
                ? pairFlatRawHeaders(flatRawTrailers)
                : undefined;
        }
    });

    const ongoingReq = Object.assign(req, {
        id,
        headers,
        rawHeaders,
        rawTrailers, // Just makes the type happy - really managed by property above
        remoteIpAddress: req.socket.remoteAddress,
        remotePort: req.socket.remotePort,
        timingEvents,
        tags
    }) as OngoingRequest;

    if (options.onBodyData) {
        emitBodyDataEvents(ongoingReq, ongoingReq.body!.asStream(), options.onBodyData);
    }

    return ongoingReq;
}

/**
 * Build an initiated request: the external representation of a request
 * that's just started.
 */
export function buildInitiatedRequest(request: OngoingRequest): InitiatedRequest {
    return {
        ..._.pick(request,
            'id',
            'matchedRuleId',
            'protocol',
            'httpVersion',
            'method',
            'url',
            'path',
            'remoteIpAddress',
            'remotePort',
            'destination',
            'headers',
            'rawHeaders',
            'tags'
        ),
        timingEvents: request.timingEvents
    };
}

/**
 * Build a completed request: the external representation of a request
 * that's been completely received (but not necessarily replied to).
 */
export async function waitForCompletedRequest(request: OngoingRequest): Promise<CompletedRequest> {
    const body = await waitForBody(request.body, request.headers);
    const requestData = buildInitiatedRequest(request);
    return {
        ...requestData,
        body,
        rawTrailers: request.rawTrailers ?? [],
        trailers: rawHeadersToObject(request.rawTrailers ?? [])
    };
}

/**
 * Parse the accepted format of the headers argument for writeHead and addTrailers
 * into a single consistent paired-tuple format.
 */
const getHeaderPairsFromArgument = (headersArg: any) => {
    // Two legal formats of header args (flat & object), one unofficial (tuple array)
    if (Array.isArray(headersArg)) {
        if (!Array.isArray(headersArg[0])) {
            // Flat -> Raw tuples
            return pairFlatRawHeaders(headersArg);
        } else {
            // Already raw tuples, cheeky
            return headersArg;
        }
    } else {
        // Headers object -> raw tuples
        return objectHeadersToRaw(headersArg ?? {});
    }
};

export function trackResponse(
    response: http.ServerResponse,
    timingEvents: TimingEvents,
    tags: string[],
    options: {
        maxSize: number,
        onWriteHead: () => void,
        onBodyData?: (id: string, timestamp: number, content: Uint8Array, isEnded: boolean) => void
    }
): OngoingResponse {
    let trackedResponse = <OngoingResponse> response;

    trackedResponse.timingEvents = timingEvents;
    trackedResponse.tags = tags;

    const trackingStream = new stream.PassThrough();

    if (options.onBodyData) {
        emitBodyDataEvents(trackedResponse, trackingStream, options.onBodyData);
    }

    const originalWriteHeader = trackedResponse.writeHead;
    const originalWrite = trackedResponse.write;
    const originalEnd = trackedResponse.end;
    const originalAddTrailers = trackedResponse.addTrailers;
    const originalGetHeaders = trackedResponse.getHeaders;

    let writtenHeaders: RawHeaders | undefined;
    trackedResponse.getRawHeaders = () => writtenHeaders ?? [];
    trackedResponse.getHeaders = () => rawHeadersToObject(trackedResponse.getRawHeaders());

    trackedResponse.writeHead = function (this: typeof trackedResponse, ...args: any) {
        if (!timingEvents.headersSentTimestamp) {
            timingEvents.headersSentTimestamp = now();
            // Notify listeners that the head is being written:
            options.onWriteHead();
        }

        // HTTP/2 responses shouldn't have a status message:
        if (isHttp2(trackedResponse) && typeof args[1] === 'string') {
            args[1] = undefined;
        }

        let headersArg: any;
        if (args[2]) {
            headersArg = args[2];
        } else if (typeof args[1] !== 'string') {
            headersArg = args[1];
        }

        writtenHeaders = getHeaderPairsFromArgument(headersArg);

        if (isHttp2(trackedResponse)) {
            writtenHeaders.unshift([':status', args[0].toString()]);
        }

        // Headers might also have been set with setHeader before. They'll be combined, with headers
        // here taking precendence. We simulate this by pulling in all values from getHeaders() and
        // remembering any of those that we're not about to override.
        const storedHeaders = originalGetHeaders.apply(this);
        const writtenHeaderKeys = writtenHeaders.map(([key]) => key.toLowerCase());
        const storedHeaderKeys = Object.keys(storedHeaders);
        if (storedHeaderKeys.length) {
            storedHeaderKeys
                .filter((key) => !writtenHeaderKeys.includes(key))
                .reverse() // We're unshifting (these were set first) so we have to reverse to keep order.
                .forEach((key) => {
                    const value = storedHeaders[key];
                    if (Array.isArray(value)) {
                        value.reverse().forEach(v => writtenHeaders?.unshift([key, v]));
                    } else if (value !== undefined) {
                        writtenHeaders?.unshift([key, value]);
                    }
                });
        }

        return originalWriteHeader.apply(this, args);
    };

    let writtenTrailers: RawHeaders | undefined;
    trackedResponse.getRawTrailers = () => writtenTrailers ?? [];

    trackedResponse.addTrailers = function (this: typeof trackedResponse, ...args: any) {
        const trailersArg = args[0];
        writtenTrailers = getHeaderPairsFromArgument(trailersArg);
        return originalAddTrailers.apply(this, args);
    };

    const trackingWrite = function (this: typeof trackedResponse, ...args: any) {
        trackingStream.write.apply(trackingStream, args);
        return originalWrite.apply(this, args);
    };

    trackedResponse.write = trackingWrite;

    trackedResponse.end = function (...args: any) {
        // We temporarily disable write tracking here, as .end
        // can call this.write, but that write should not be
        // tracked, or we'll get duplicate writes when trackingStream
        // calls it on itself too.

        trackedResponse.write = originalWrite;

        trackingStream.end.apply(trackingStream, args);
        let result = originalEnd.apply(this, args);

        trackedResponse.write = trackingWrite;
        return result;
    };

    trackedResponse.body = parseBodyStream(
        trackingStream,
        options.maxSize,
        () => trackedResponse.getHeaders()
    );

    // Proxy errors (e.g. write-after-end) to the response, so they can be
    // handled elsewhere, rather than killing the process outright.
    trackingStream.on('error', (e) => trackedResponse.emit('error', e));

    return trackedResponse;
}

// We emit a body data events at most this often, to try to more efficiently
// batch up chunks while keeping things nice & responsive.
const CHUNK_BUFFER_INTERVAL_MS = 20;

function emitBodyDataEvents(
    message: OngoingRequest | OngoingResponse,
    bodyStream: stream.Readable,
    callback: (id: string, timestamp: number, content: Uint8Array, isEnded: boolean) => void
) {
    let timestamp: number | undefined = undefined;
    let pendingContent: Uint8Array | undefined = undefined;
    let pendingContentTimer: NodeJS.Timeout | undefined = undefined;
    let endEmitted = false;

    function flushPendingContent() {
        if (endEmitted) return; // Should never happen, but just in case

        endEmitted = 'writableEnded' in message
            ? message.writableEnded
            : message.readableEnded;

        callback(
            message.id,
            // We use the exact end timestamp where possible, but the first 'data'
            // event timestamp for every preceeding chunk.
            endEmitted
                ? now()
                : (timestamp || now()),
            pendingContent || Buffer.alloc(0),
            endEmitted
        );

        timestamp = undefined;
        pendingContent = undefined;

        if (pendingContentTimer) {
            clearTimeout(pendingContentTimer);
            pendingContentTimer = undefined;
        }
    }

    bodyStream.on('data', (d) => {
        if (pendingContent) {
            pendingContent = Buffer.concat([pendingContent, d]);
        } else {
            pendingContent = d;
        }

        // Don't emit immediately - queue up a flush, to batch & emit at intervals:
        if (!pendingContentTimer) {
            // We use the timing of the first chunk in the batch as the timestamp
            // (or the exact time of the last flush, for the final part).
            timestamp = now();
            pendingContentTimer = setTimeout(
                flushPendingContent,
                CHUNK_BUFFER_INTERVAL_MS
            );
        }
    });

    bodyStream.on('end', flushPendingContent);
}

/**
 * Build an initiated response: the external representation of a response
 * that's just started.
 */
export function buildInitiatedResponse(response: OngoingResponse): InitiatedResponse {
    const initiatedResponse: InitiatedResponse = _(response).pick([
        'id',
        'statusCode',
        'timingEvents',
        'tags'
    ]).assign({
        statusMessage: '',
        headers: response.getHeaders(),
        rawHeaders: response.getRawHeaders(),
    }).valueOf();

    if (!(response instanceof http2.Http2ServerResponse)) {
        // H2 has no status messages, and generates a warning if you look for one
        initiatedResponse.statusMessage = response.statusMessage;
    }

    return initiatedResponse;
}

/**
 * Build a completed response: the external representation of a response
 * that's been completely written out and sent back to the client.
 */
export async function waitForCompletedResponse(
    response: OngoingResponse | CompletedResponse
): Promise<CompletedResponse> {
    // Ongoing response has 'getHeaders' - completed has 'headers'.
    if ('headers' in response) return response;

    const body = await waitForBody(response.body, response.getHeaders());
    response.timingEvents.responseSentTimestamp = response.timingEvents.responseSentTimestamp || now();

    return Object.assign(buildInitiatedResponse(response), {
        body: body,
        rawTrailers: response.getRawTrailers(),
        trailers: rawHeadersToObject(response.getRawTrailers())
    });
}

// Take raw HTTP request bytes received, have a go at parsing something useful out of them.
// Very lax - this is a method to use when normal parsing has failed, not as standard
export function tryToParseHttpRequest(input: Buffer, socket: net.Socket): PartiallyParsedHttpRequest {
    const req: PartiallyParsedHttpRequest = {};
    try {
        req.protocol = socket[LastHopEncrypted] ? "https" : "http"; // Wild guess really

        const targetHost = socket[LastTunnelAddress] ?? (socket as TLSSocket).servername;
        req.destination = targetHost
            ? getDestination(req.protocol, targetHost)
            : undefined;

        const lines = splitBuffer(input, '\r\n');
        const requestLine = lines[0].subarray(0, lines[0].length).toString('ascii');
        const [method, rawUri, httpProtocol] = requestLine.split(" ");

        if (method) req.method = method.slice(0, 15); // With overflows this could be *anything*. Limit it slightly.

        // An empty line delineates the headers from the body
        const emptyLineIndex = _.findIndex(lines, (line) => line.length === 0);

        try {
            const headerLines = lines.slice(1, emptyLineIndex === -1 ? undefined : emptyLineIndex);
            const rawHeaders = headerLines
                .map((line) => splitBuffer(line, ':', 2))
                .filter((line) => line.length > 1)
                .map((headerParts) =>
                    headerParts.map(p => p.toString('utf8').trim()) as [string, string]
                );

            req.rawHeaders = rawHeaders;
            req.headers = rawHeadersToObject(rawHeaders);
        } catch (e) {}

        try {
            const parsedUrl = url.parse(rawUri);
            req.path = parsedUrl.path ?? undefined;

            const hostHeader = _.find(req.headers, (_value, key) =>
                key.toLowerCase() === 'host'
            ) as string | undefined;

            if (!req.destination) {
                if (hostHeader) {
                    req.destination = getDestination(req.protocol, hostHeader);
                } else if (parsedUrl.hostname) {
                    req.destination = getDestination(req.protocol, parsedUrl.hostname);
                }
            }

            if (rawUri.includes('://') || !req.destination) {
                // URI is absolute, or we have no way to guess the host at all
                req.url = rawUri;
            } else {
                const host = normalizeHost(req.protocol, `${req.destination.hostname}:${req.destination.port}`);

                // URI is relative (or invalid) and we have a host: use it
                req.url = `${req.protocol}://${host}${
                    rawUri.startsWith('/') ? '' : '/' // Add a slash if the URI is garbage
                }${rawUri}`;
            }
        } catch (e) {}

        try {
            const httpVersion = httpProtocol.split('/')[1];
            req.httpVersion = httpVersion;
        } catch (e) {}
    } catch (e) {}

    return req;
}

type PartiallyParsedHttpRequest = {
    protocol?: string;
    httpVersion?: string;
    method?: string;
    url?: string;
    headers?: Headers;
    rawHeaders?: RawHeaders;
    destination?: Destination;
    path?: string;
}

// Take raw HTTP response bytes received, parse something useful out of them. This is *not*
// very lax, and will throw errors due to unexpected response data, but it's used when we
// ourselves generate the data (for websocket responses that 'ws' writes directly to the
// socket invisibly). Fortunately all responses are very simple:
export function parseRawHttpResponse(input: Buffer, request: OngoingRequest): CompletedResponse {
    const { id, tags, timingEvents} = request;

    const lines = splitBuffer(input, '\r\n');
    const responseLine = lines[0].subarray(0, lines[0].length).toString('ascii');
    const [_httpVersion, rawStatusCode, ...restResponseLine] = responseLine.split(" ");

    const statusCode = parseInt(rawStatusCode, 10);
    const statusMessage = restResponseLine.join(' ');

    // An empty line delineates the headers from the body
    const emptyLineIndex = _.findIndex(lines, (line) => line.length === 0);

    const headerLines = lines.slice(1, emptyLineIndex === -1 ? undefined : emptyLineIndex);
    const rawHeaders = headerLines
        .map((line) => splitBuffer(line, ':', 2))
        .map((headerParts) =>
            headerParts.map(p => p.toString('utf8').trim()) as [string, string]
        );

    const headers = rawHeadersToObject(rawHeaders);
    const body = buildBodyReader(Buffer.from([]), {});

    return {
        id,
        tags,
        timingEvents,
        statusCode,
        statusMessage,
        rawHeaders,
        headers,
        body,
        rawTrailers: [],
        trailers: {}
    };
}
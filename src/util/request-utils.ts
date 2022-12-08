import * as _ from 'lodash';
import * as net from 'net';
import { TLSSocket } from 'tls';
import * as http from 'http';
import * as http2 from 'http2';
import * as stream from 'stream';
import * as querystring from 'querystring';
import now = require("performance-now");
import * as url from 'url';
import type { SUPPORTED_ENCODING } from 'http-encoding';

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
    RawHeaders
} from "../types";

import { nthIndexOf } from './util';
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
    objectHeadersToFlat,
    objectHeadersToRaw,
    pairFlatRawHeaders,
    rawHeadersToObject
} from './header-utils';

// Is this URL fully qualified?
// Note that this supports only HTTP - no websockets or anything else.
export const isAbsoluteUrl = (url: string) =>
    url.toLowerCase().startsWith('http://') ||
    url.toLowerCase().startsWith('https://');

export const isRelativeUrl = (url: string) =>
    url.startsWith('/');

export const isAbsoluteProtocollessUrl = (url: string) =>
    !isAbsoluteUrl(url) && !isRelativeUrl(url);

export const getUrlWithoutProtocol = (url: string): string => {
    return url.split('://', 2).slice(-1).join('');
}

export const getPathFromAbsoluteUrl = (url: string) => {
    const pathIndex = nthIndexOf(url, '/', 3);
    if (pathIndex !== -1) {
        return url.slice(pathIndex);
    } else {
        return '';
    }
}

export const shouldKeepAlive = (req: OngoingRequest): boolean =>
    req.httpVersion !== '1.0' &&
    req.headers['connection'] !== 'close' &&
    req.headers['proxy-connection'] !== 'close';

export const writeHead = (
    response: http.ServerResponse | http2.Http2ServerResponse,
    status: number,
    statusMessage?: string | undefined,
    headers?: Headers | RawHeaders | undefined
) => {
    const flatHeaders =
        headers === undefined
            ? {}
        : isHttp2(response)
            // Due to a Node.js bug, H2 never expects flat headers
            ? headers as {}
        : !Array.isArray(headers)
            ? objectHeadersToFlat(headers)
        // RawHeaders for H1, must be flattened:
            : flattenPairedRawHeaders(headers);

    // We aim to always pass flat headers to writeHead instead of calling setHeader because
    // in most cases it's more flexible about supporting raw data, e.g. multiple headers with
    // different casing can't be represented with setHeader at all (the latter overwrites).

    if (statusMessage === undefined) {
        response.writeHead(status, flatHeaders);
    } else {
        response.writeHead(status, statusMessage, flatHeaders);
    }
};

// If the user explicitly specifies headers, we tell Node not to handle them,
// so the user-defined headers are the full set.
export function dropDefaultHeaders(response: OngoingResponse) {
    // Drop the default headers, so only the headers we explicitly configure are included
    [
        'connection',
        'content-length',
        'transfer-encoding',
        'date'
    ].forEach((defaultHeader) =>
        response.removeHeader(defaultHeader)
    );
}

export function validateHeader(name: string, value: string | string[]): boolean {
    try {
        http.validateHeaderName(name);
        http.validateHeaderValue(name, value);
        return true;
    } catch (e) {
        return false;
    }
}

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

export async function encodeBodyBuffer(buffer: Uint8Array, headers: Headers) {
    const contentEncoding = headers['content-encoding'];

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
    if (!contentEncoding) return buffer;

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
            return completedBuffer
                ? bufferToStream(completedBuffer)
                : bufferThenStream(body.asBuffer(), bodyStream);
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

export const buildBodyReader = (body: Buffer, headers: Headers): CompletedBody => {
    const completedBody = {
        buffer: body,

        async getDecodedBuffer() {
            return runAsyncOrUndefined(async () =>
                asBuffer(
                    await decodeBodyBuffer(this.buffer, headers)
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
        async getFormData() {
            return runAsyncOrUndefined(async () => {
                const text = await completedBody.getText();
                return text ? querystring.parse(text) : undefined;
            });
        }
    };

    return completedBody;
};

export const parseRequestBody = (
    req: http.IncomingMessage | http2.Http2ServerRequest,
    options: { maxSize: number }
) => {
    let transformedRequest = <OngoingRequest> <any> req;
    transformedRequest.body = parseBodyStream(req, options.maxSize, () => req.headers);
};

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
            'hostname',
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
    request.timingEvents.bodyReceivedTimestamp = request.timingEvents.bodyReceivedTimestamp || now();

    const requestData = buildInitiatedRequest(request);
    return { ...requestData, body };
}

export function trackResponse(
    response: http.ServerResponse,
    timingEvents: TimingEvents,
    tags: string[],
    options: { maxSize: number }
): OngoingResponse {
    let trackedResponse = <OngoingResponse> response;

    trackedResponse.timingEvents = timingEvents;
    trackedResponse.tags = tags;

    // Headers are sent when .writeHead or .write() are first called

    const trackingStream = new stream.PassThrough();

    const originalWriteHeader = trackedResponse.writeHead;
    const originalWrite = trackedResponse.write;
    const originalEnd = trackedResponse.end;
    const originalGetHeaders = trackedResponse.getHeaders;

    let writtenHeaders: RawHeaders | undefined;
    trackedResponse.getRawHeaders = () => writtenHeaders ?? [];
    trackedResponse.getHeaders = () => rawHeadersToObject(trackedResponse.getRawHeaders());

    trackedResponse.writeHead = function (this: typeof trackedResponse, ...args: any) {
        if (!timingEvents.headersSentTimestamp) {
            timingEvents.headersSentTimestamp = now();
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

        // Two legal formats of header args (flat & object), one unofficial (tuple array)
        if (Array.isArray(headersArg)) {
            if (!Array.isArray(headersArg[0])) {
                // Flat -> Raw tuples
                writtenHeaders = pairFlatRawHeaders(headersArg);
            } else {
                // Already raw tuples, cheeky
                writtenHeaders = headersArg;
            }
        } else {
            // Headers object -> raw tuples
            writtenHeaders = objectHeadersToRaw(headersArg ?? {});
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
    }

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

    const completedResponse: CompletedResponse = _(response).pick([
        'id',
        'statusCode',
        'timingEvents',
        'tags'
    ]).assign({
        statusMessage: '',
        headers: response.getHeaders(),
        rawHeaders: response.getRawHeaders(),
        body: body
    }).valueOf();

    if (!(response instanceof http2.Http2ServerResponse)) {
        // H2 has no status messages, and generates a warning if you look for one
        completedResponse.statusMessage = response.statusMessage;
    }

    return completedResponse;
}

// Take raw HTTP request bytes received, have a go at parsing something useful out of them.
// Very lax - this is a method to use when normal parsing has failed, not as standard
export function tryToParseHttpRequest(input: Buffer, socket: net.Socket): PartiallyParsedHttpRequest {
    const req: PartiallyParsedHttpRequest = {};
    try {
        req.protocol = socket.__lastHopEncrypted ? "https" : "http"; // Wild guess really

        // For TLS sockets, we default the hostname to the name given by SNI. Might be overridden
        // by the URL or Host header later, if available.
        if (socket instanceof TLSSocket) req.hostname = socket.servername;

        const lines = splitBuffer(input, '\r\n');
        const requestLine = lines[0].slice(0, lines[0].length).toString('ascii');
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

            const hostHeader = _.find(req.headers, (_value, key) => key.toLowerCase() === 'host');

            if (hostHeader) {
                req.hostname = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
            } else if (parsedUrl.hostname) {
                req.hostname = parsedUrl.hostname;
            }

            if (rawUri.includes('://') || !req.hostname) {
                // URI is absolute, or we have no way to guess the host at all
                req.url = rawUri;
            } else {
                // URI is relative (or invalid) and we have a host: use it
                req.url = `${req.protocol}://${req.hostname}${
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
    hostname?: string;
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
        body
    };
}
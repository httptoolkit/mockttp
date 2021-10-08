import * as _ from 'lodash';
import * as net from 'net';
import { TLSSocket } from 'tls';
import * as http from 'http';
import * as http2 from 'http2';
import * as stream from 'stream';
import * as querystring from 'querystring';
import now = require("performance-now");
import * as url from 'url';
import { decodeBuffer, decodeBufferSync } from 'http-encoding';

import {
    Headers,
    OngoingRequest,
    CompletedRequest,
    OngoingResponse,
    CompletedResponse,
    OngoingBody,
    CompletedBody,
    TimingEvents,
    InitiatedRequest
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

export const setHeaders = (response: http.ServerResponse, headers: Headers) => {
    Object.keys(headers).forEach((header) => {
        let value = headers[header];
        if (!value) return;

        response.setHeader(header, value);
    });
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

export function isHttp2(
    message: | http.IncomingMessage
             | http2.Http2ServerRequest
             | http2.Http2ServerResponse
             | OngoingRequest
             | OngoingResponse
): message is http2.Http2ServerRequest | http2.Http2ServerResponse {
    return ('httpVersion' in message && !!message.httpVersion?.startsWith('2')) || // H2 request
        ('stream' in message && 'createPushResponse' in message); // H2 response
}

export function h2HeadersToH1(h2Headers: Headers): Headers {
    const h1Headers = _.omitBy(h2Headers, (_value, key: string | Symbol) => {
        return key === http2.sensitiveHeaders || key.toString().startsWith(':')
    });

    if (!h1Headers['host'] && h2Headers[':authority']) {
        h1Headers['host'] = h2Headers[':authority'];
    }

    if (_.isArray(h1Headers['cookie'])) {
        h1Headers['cookie'] = h1Headers['cookie'].join('; ');
    }

    return h1Headers;
}

// Take from http2/util.js in Node itself
const HTTP2_ILLEGAL_HEADERS = [
    'connection',
    'upgrade',
    'host',
    'http2-settings',
    'keep-alive',
    'proxy-connection',
    'transfer-encoding'
];

export function h1HeadersToH2(headers: Headers): Headers {
    return _.omitBy(headers, (_value, key) => {
        return HTTP2_ILLEGAL_HEADERS.includes(key);
    });
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
            return decodeBuffer(buffer, getHeaders()['content-encoding']);
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

function runOrUndefined<R>(func: () => R): R | undefined {
    try {
        return func();
    } catch {
        return undefined;
    }
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
                    await decodeBuffer(this.buffer, headers['content-encoding'])
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
        },

        // Deprecated sync properties, for backwards compat. Note that these do not
        // support new encodings, e.g. Brotli/Zstandard.
        get decodedBuffer() {
            return runOrUndefined(() =>
                decodeBufferSync(this.buffer, headers['content-encoding'])
            );
        },
        get text() {
            return runOrUndefined(() =>
                this.decodedBuffer!.toString('utf8')
            );
        },
        get json() {
            return runOrUndefined(() =>
                JSON.parse(completedBody.text!)
            )
        },
        get formData() {
            return runOrUndefined(() =>
                completedBody.text ? querystring.parse(completedBody.text) : undefined
            );
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
 * Translate from internal header representations (basically Node's header representations) to a
 * mildly more consistent & simplified model that we expose externally: numbers as strings, and
 * no sensitiveHeaders symbol for HTTP/2.
 */
export function cleanUpHeaders(headers: Headers) {
    return _.mapValues(
        _.omit(headers, ...(http2.sensitiveHeaders ? [http2.sensitiveHeaders as any] : [])),
        (headerValue: undefined | string | string[] | number) =>
            _.isNumber(headerValue) ? headerValue.toString() : headerValue
    );
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
            'remoteAddress',
            'hostname',
            'headers',
            'tags'
        ),
        headers: cleanUpHeaders(request.headers),
        timingEvents: request.timingEvents
    };
}

/**
 * Build an aborted request: the external representation of a request
 * that's been aborted.
 */
export function buildAbortedRequest(request: OngoingRequest): InitiatedRequest {
    const requestData = buildInitiatedRequest(request);
    return Object.assign(requestData, {
        headers: cleanUpHeaders(request.headers),
        // Exists for backward compat: really Abort events should have no body at all
        body: buildBodyReader(Buffer.alloc(0), {})
    });
}

/**
 * Build a completed request: the external representation of a request
 * that's been completely received (but not necessarily replied to).
 */
export async function waitForCompletedRequest(request: OngoingRequest): Promise<CompletedRequest> {
    const body = await waitForBody(request.body, request.headers);
    request.timingEvents.bodyReceivedTimestamp = request.timingEvents.bodyReceivedTimestamp || now();

    const requestData = buildInitiatedRequest(request);
    return Object.assign(requestData, { body, headers: cleanUpHeaders(request.headers) });
}

export function trackResponse(
    response: http.ServerResponse,
    timingEvents: TimingEvents,
    tags: string[],
    options: { maxSize: number }
): OngoingResponse {
    let trackedResponse = <OngoingResponse> response;
    if (!trackedResponse.getHeaders) {
        // getHeaders was added in 7.7. - if it's not available, polyfill it
        trackedResponse.getHeaders = function (this: any) { return this._headers; }
    }

    trackedResponse.timingEvents = timingEvents;
    trackedResponse.tags = tags;

    // Headers are sent when .writeHead or .write() are first called

    const trackingStream = new stream.PassThrough();

    const originalWriteHeader = trackedResponse.writeHead;
    const originalWrite = trackedResponse.write;
    const originalEnd = trackedResponse.end;

    trackedResponse.writeHead = function (this: typeof trackedResponse, ...args: any) {
        if (!timingEvents.headersSentTimestamp) {
            timingEvents.headersSentTimestamp = now();
        }

        // HTTP/2 responses shouldn't have a status message:
        if (isHttp2(trackedResponse) && typeof args[1] === 'string') {
            args[1] = undefined;
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
export async function waitForCompletedResponse(response: OngoingResponse): Promise<CompletedResponse> {
    const body = await waitForBody(response.body, response.getHeaders());
    response.timingEvents.responseSentTimestamp = response.timingEvents.responseSentTimestamp || now();

    return _(response).pick([
        'id',
        'statusCode',
        'statusMessage',
        'timingEvents',
        'tags'
    ]).assign({
        headers: cleanUpHeaders(response.getHeaders()),
        body: body
    }).valueOf();
}

// Take raw HTTP bytes recieved, have a go at parsing something useful out of them.
// Very lax - this is a method to use when normal parsing has failed, not as standard
export function tryToParseHttp(input: Buffer, socket: net.Socket): PartiallyParsedHttpRequest {
    const req: PartiallyParsedHttpRequest = {};
    try {
        req.protocol = socket.lastHopEncrypted ? "https" : "http"; // Wild guess really

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
            const headers = headerLines
                .map((line) => splitBuffer(line, ':', 2))
                .filter((line) => line.length > 1)
                .map((headerParts) =>
                    headerParts.map(p => p.toString('utf8')) as [string, string]
                )
                .reduce((headers: Headers, headerPair) => {
                    const headerName = headerPair[0];
                    const headerValue = headerPair[1].trim();
                    const existingKey = _.findKey(headers, (_v, key) => key.toLowerCase() === headerName);
                    if (existingKey) {
                        const existingValue = headers[existingKey]!;
                        if (Array.isArray(existingValue)) {
                            headers[existingKey] = existingValue.concat(headerValue);
                        } else {
                            headers[existingKey] = [existingValue, headerValue];
                        }
                    } else {
                        headers[headerName] = headerValue;
                    }
                    return headers;
                }, {});
            req.headers = headers;
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
    hostname?: string;
    path?: string;
}
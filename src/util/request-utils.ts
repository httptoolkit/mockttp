/**
 * @module Internal
 */

import * as _ from 'lodash';
import * as net from 'net';
import { TLSSocket } from 'tls';
import * as http from 'http';
import * as http2 from 'http2';
import * as stream from 'stream';
import * as querystring from 'querystring';
import * as zlib from 'zlib';
import * as brotliDecompress from 'brotli/decompress';
import now = require("performance-now");
import * as url from 'url';

import {
    Headers,
    OngoingRequest,
    CompletedRequest,
    OngoingResponse,
    CompletedResponse,
    ParsedBody,
    CompletedBody,
    TimingEvents,
    InitiatedRequest
} from "../types";
import { nthIndexOf } from '../util/util';

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
    const h1Headers = _.omitBy(h2Headers, (_value, key) => {
        return key.startsWith(':')
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

// Takes a buffer and a stream, returns a simple stream that outputs the buffer then the stream.
const bufferThenStream = (buffer: BufferInProgress, inputStream: stream.Readable): stream.Readable => {
    const outputStream = new stream.PassThrough();

    // Forward the buffered data so far
    outputStream.write(Buffer.concat(buffer.currentChunks));
    // After the data, forward errors from the buffer
    if (buffer.failedWith) {
        // Announce async, to ensure listeners have time to get set up
        setTimeout(() => outputStream.emit('error', buffer.failedWith));
    } else {
        // Forward future data as it arrives
        inputStream.pipe(outputStream);
        // Forward any future errors from the input stream
        inputStream.once('error', (e) => outputStream.emit('error', e));
        // Silence 'unhandled rejection' warnings here, since we'll handle them on the stream instead
        buffer.catch(() => {});
    }

    return outputStream;
};

const bufferToStream = (buffer: Buffer): stream.Readable => {
    const outputStream = new stream.PassThrough();
    outputStream.end(buffer);
    return outputStream;
};

type BufferInProgress = Promise<Buffer> & {
    currentChunks: Buffer[] // Stores the body chunks as they arrive
    failedWith?: Error // Stores the error that killed the stream, if one did
};

export const streamToBuffer = (input: stream.Readable) => {
    const chunks: Buffer[] = [];
    const bufferPromise = <BufferInProgress> new Promise(
        (resolve, reject) => {
            input.on('data', (d: Buffer) => chunks.push(d));
            input.once('end', () => resolve(Buffer.concat(chunks)));
            input.once('aborted', () => {
                bufferPromise.failedWith = new Error('Aborted');
                reject(bufferPromise.failedWith);
            });
            input.once('error', (e) => {
                bufferPromise.failedWith = e;
                reject(e);
            });
        }
    );
    bufferPromise.currentChunks = chunks;
    return bufferPromise;
};

const parseBodyStream = (bodyStream: stream.Readable): ParsedBody => {
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
                bufferPromise = streamToBuffer(bodyStream);

                bufferPromise
                    .then((buffer) => completedBuffer = buffer)
                    .catch(() => {}); // If we get no body, completedBuffer stays null
            }
            return bufferPromise;
        },
        asText(encoding = 'utf8') {
            return body.asBuffer().then((b) => b.toString(encoding));
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

const waitForBody = async (body: ParsedBody, headers: Headers): Promise<CompletedBody> => {
    const bufferBody = await body.asBuffer();
    return buildBodyReader(bufferBody, headers);
};

export const handleContentEncoding = (body: Buffer, encoding?: string | string[]): Buffer => {
    if (_.isArray(encoding) || (typeof encoding === 'string' && encoding.indexOf(', ') >= 0)) {
        const encodings = typeof encoding === 'string' ? encoding.split(', ').reverse() : encoding;
        return encodings.reduce((content, nextEncoding) => {
            return handleContentEncoding(content, nextEncoding);
        }, body);
    }

    if (encoding === 'gzip' || encoding === 'x-gzip') {
        return zlib.gunzipSync(body);
    } else if (encoding === 'deflate' || encoding === 'x-deflate') {
        // Deflate is ambiguous, and may or may not have a zlib wrapper.
        // This checks the buffer header directly, based on
        // https://stackoverflow.com/a/37528114/68051
        const lowNibble = body[0] & 0xF;
        if (lowNibble === 8) {
            return zlib.inflateSync(body);
        } else {
            return zlib.inflateRawSync(body);
        }
    } else if (encoding === 'br') {
        return Buffer.from(brotliDecompress(body));
    } else if (encoding === 'amz-1.0') {
        // Weird encoding used by some AWS requests, actually just unencoded JSON:
        // https://docs.aws.amazon.com/en_us/AmazonCloudWatch/latest/APIReference/making-api-requests.html
        return body;
    } else if (!encoding || encoding === 'identity') {
        return body;
    } else {
        throw new Error(`Unknown encoding: ${encoding}`);
    }
};

export const buildBodyReader = (body: Buffer, headers: Headers): CompletedBody => {
    const completedBody = {
        buffer: body,
        get decodedBuffer() {
            return runOrUndefined(() =>
                handleContentEncoding(this.buffer, headers['content-encoding'])
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

export const parseBody = (
    req: http.IncomingMessage,
    _res: http.ServerResponse,
    next: () => void
) => {
    let transformedRequest = <OngoingRequest> <any> req;
    transformedRequest.body = parseBodyStream(req);
    next();
};

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
            'hostname',
            'headers',
            'tags'
        ),
        timingEvents: request.timingEvents
    };
}

export function buildAbortedRequest(request: OngoingRequest): InitiatedRequest {
    const requestData = buildInitiatedRequest(request);
    return Object.assign(requestData, {
        // Exists for backward compat: really Abort events should have no body at all
        body: buildBodyReader(Buffer.alloc(0), {})
    });
}

export async function waitForCompletedRequest(request: OngoingRequest): Promise<CompletedRequest> {
    const body = await waitForBody(request.body, request.headers);
    request.timingEvents.bodyReceivedTimestamp = request.timingEvents.bodyReceivedTimestamp || now();

    const requestData = buildInitiatedRequest(request);
    return Object.assign(requestData, { body });
}

export function trackResponse(response: http.ServerResponse, timingEvents: TimingEvents, tags: string[]): OngoingResponse {
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

    trackedResponse.body = parseBodyStream(trackingStream);

    return trackedResponse;
}

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
        headers: _.mapValues(response.getHeaders(), (headerValue) => {
            return _.isNumber(headerValue)
                ? headerValue.toString() // HTTP :status sneaks in as a number
                : headerValue;
        }) as Headers,
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
            req.path = parsedUrl.path;

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

function splitBuffer(input: Buffer, splitter: string, maxParts = Infinity) {
    const parts: Buffer[] = [];

    let remainingBuffer = input;
    while (remainingBuffer.length) {
        let endOfPart = remainingBuffer.indexOf(splitter);
        if (endOfPart === -1) endOfPart = remainingBuffer.length;

        parts.push(remainingBuffer.slice(0, endOfPart));
        remainingBuffer = remainingBuffer.slice(endOfPart + splitter.length);

        if (parts.length === maxParts - 1) {
            parts.push(remainingBuffer);
            break;
        }
    }

    return parts;
}
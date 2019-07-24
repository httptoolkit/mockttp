/**
 * @module Internal
 */

import * as _ from 'lodash';
import * as stream from 'stream';
import * as querystring from 'querystring';
import * as express from 'express';
import * as zlib from 'zlib';
import * as brotliDecompress from 'brotli/decompress';
import now = require("performance-now");

import {
    Headers,
    OngoingRequest,
    CompletedRequest,
    OngoingResponse,
    CompletedResponse,
    ParsedBody,
    CompletedBody,
    TimingEvents
} from "../types";
import { localAddresses } from '../util/socket-util';

export const setHeaders = (response: express.Response, headers: Headers) => {
    Object.keys(headers).forEach((header) => {
        let value = headers[header];
        if (!value) return;

        response.setHeader(header, value);
    });
};

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
                bufferPromise.then((buffer) => completedBuffer = buffer);
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
        return new Buffer(brotliDecompress(body));
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
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
) => {
    let transformedRequest = <OngoingRequest> <any> req;

    let bodyStream = new stream.PassThrough();
    req.pipe(bodyStream);

    transformedRequest.body = parseBodyStream(bodyStream);

    next();
};

export async function waitForCompletedRequest(request: OngoingRequest): Promise<CompletedRequest> {
    const body = await waitForBody(request.body, request.headers);
    const bodyReceivedTimestamp = request.timingEvents.bodyReceivedTimestamp || now();

    return _(request).pick([
        'id',
        'protocol',
        'httpVersion',
        'method',
        'url',
        'path',
        'hostname',
        'headers'
    ]).assign({
        body: body,
        timingEvents: Object.assign(request.timingEvents, { bodyReceivedTimestamp })
    }).valueOf();
}

export function trackResponse(response: express.Response, timingEvents: TimingEvents): OngoingResponse {
    let trackedResponse = <OngoingResponse> response;
    if (!trackedResponse.getHeaders) {
        // getHeaders was added in 7.7. - if it's not available, polyfill it
        trackedResponse.getHeaders = function (this: any) { return this._headers; }
    }

    trackedResponse.timingEvents = timingEvents;

    // Headers are sent when .writeHead or .write() are first called

    const trackingStream = new stream.PassThrough();

    const originalWriteHeader = trackedResponse.writeHead;
    const originalWrite = trackedResponse.write;
    const originalEnd = trackedResponse.end;

    trackedResponse.writeHead = function (this: typeof trackedResponse, ...args: any) {
        if (!timingEvents.headersSentTimestamp) {
            timingEvents.headersSentTimestamp = now();
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
        'timingEvents'
    ]).assign({
        headers: response.getHeaders(),
        body: body
    }).valueOf();
}

/**
 * Is the request a non-absolute URL (/abc) intended for a different host?
 *
 * This will happen for transparently proxied requests, where the client
 * is unaware that it's talking to a proxy. We can detect that it's
 * happening by checking if the Host header is us, or somebody else.
 *
 * This is a strong guess - false positives & negatives are still possible,
 * but very unlikely (and hard to avoid).
 */
export function isIndirectPathRequest(serverPort: number, req: express.Request) {
    // Path (relative) URL requests must always start with a slash.
    // Clients must only send absolute URIs when explicitly talking to a proxy.
    if (req.url[0] !== '/') return false;

    // If they're talking to this machine, on this port, they're talking to us.
    // Only false negative would be transparently proxing localhost traffic to a
    // proxy on a different machine, on the same port. *Very* unlikely.
    const validHosts = localAddresses.concat('localhost').map(addr => `${addr}:${serverPort}`);

    if (
        (serverPort === 80 && req.protocol === 'http') ||
        (serverPort === 443 && req.protocol === 'https')
    ) {
        // On a default port, the port can be omitted entirely
        validHosts.push(...localAddresses);
    }

    // If the Host header is one of our hostnames, it's a direct request.
    // There can be false positives here if connections use unknown host names, but
    // to avoid that we'd need to resolve the hostname itself, which might not be
    // possible, and would be expensive.
    return !validHosts.includes(req.headers['host']!.toLowerCase());
}
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

export const setHeaders = (response: express.Response, headers: Headers) => {
    Object.keys(headers).forEach((header) => {
        let value = headers[header];
        if (!value) return;

        response.setHeader(header, value);
    });
};

const streamToBuffer = (input: stream.Readable): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
        let chunks: Buffer[] = [];
        input.on('data', (d: Buffer) => chunks.push(d));
        input.on('end', () => resolve(Buffer.concat(chunks)));
        input.on('error', reject);
    });
}

const parseBodyStream = (bodyStream: stream.Readable): ParsedBody => {
    let buffer: Promise<Buffer> | null = null;

    let body = {
        rawStream: bodyStream,

        asBuffer() {
            if (!buffer) {
                buffer = streamToBuffer(bodyStream);
            }
            return buffer;
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
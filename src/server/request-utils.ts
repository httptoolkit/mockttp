/**
 * @module Internal
 */

import * as _ from 'lodash';
import * as stream from 'stream';
import * as querystring from 'querystring';
import * as express from 'express';
import * as zlib from 'zlib';

import {
    Headers,
    OngoingRequest,
    CompletedRequest,
    OngoingResponse,
    CompletedResponse,
    ParsedBody,
    CompletedBody
} from "../types";

export const setHeaders = (response: express.Response, headers: Headers) => {
    Object.keys(headers).forEach((header) => {
        let value = headers[header];
        if (!value) return;

        response.setHeader(header, value.toString());
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

const handleContentEncoding = (body: Buffer, encoding?: string) => {
    if (encoding === 'gzip' || encoding === 'x-gzip') {
        return zlib.gunzipSync(body);
    } else if (encoding === 'deflate' || encoding === 'x-deflate') {
        return zlib.inflateSync(body);
    } else {
        return body;
    }
};

export const buildBodyReader = (body: Buffer, headers: Headers): CompletedBody => {
    const completedBody = {
        buffer: body,
        get text() {
            return handleContentEncoding(body, headers['content-encoding']).toString('utf8');
        },
        get json() {
            return runOrUndefined(() => JSON.parse(completedBody.text))
        },
        get formData() {
            return runOrUndefined(() => querystring.parse(completedBody.text));
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
    return _(request).pick([
        'id',
        'protocol',
        'method',
        'url',
        'path',
        'hostname',
        'headers'
    ]).assign({
        body: await waitForBody(request.body, request.headers)
    }).valueOf();
}

export function trackResponse(response: express.Response): OngoingResponse {
    let trackedResponse = <OngoingResponse> response;
    if (!trackedResponse.getHeaders) {
        // getHeaders was added in 7.7. - if it's not available, polyfill it
        trackedResponse.getHeaders = function (this: any) { return this._headers; }
    }

    const trackingStream = new stream.PassThrough();

    const originalWrite = trackedResponse.write;
    const originalEnd = trackedResponse.end;

    const trackingWrite = function (this: typeof trackedResponse, ...args: any[]) {
        trackingStream.write.apply(trackingStream, args);
        return originalWrite.apply(this, args);
    };

    trackedResponse.write = trackingWrite;

    trackedResponse.end = function (...args: any[]) {
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
    return _(response).pick([
        'id',
        'statusCode',
        'statusMessage'
    ]).assign({
        headers: response.getHeaders(),
        body: await waitForBody(response.body, response.getHeaders())
    }).valueOf();
}
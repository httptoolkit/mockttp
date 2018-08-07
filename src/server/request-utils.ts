/**
 * @module Internal
 */

import * as _ from 'lodash';
import * as stream from 'stream';
import * as querystring from 'querystring';
import * as express from 'express';

import { OngoingRequest, CompletedRequest, CompletedResponse, OngoingResponse, ParsedBody } from "../types";

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

const waitForBody = async (body: ParsedBody) => {
    return {
        buffer: await body.asBuffer(),
        text: await body.asText().catch(() => undefined),
        json: await body.asJson().catch(() => undefined),
        formData: await body.asFormData().catch(() => undefined)
    }
}

export const parseBody = (
    req: express.Request,
    res: express.Response,
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
        'protocol',
        'method',
        'url',
        'path',
        'hostname',
        'headers'
    ]).assign({
        body: await waitForBody(request.body)
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
        'statusCode',
        'statusMessage'
    ]).assign({
        headers: response.getHeaders(),
        body: await waitForBody(response.body)
    }).valueOf();
}
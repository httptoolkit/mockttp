/**
 * @module Internal
 */

import * as stream from 'stream';
import * as querystring from 'querystring';
import * as express from 'express';
import { OngoingRequest as MockttpRequest } from '../types';

export const parseBody = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    let transformedRequest = <MockttpRequest> <any> req;

    let bodyStream = new stream.PassThrough();
    req.pipe(bodyStream);

    let body = {
        rawStream: bodyStream,

        _buffer:  <Promise<Buffer> | null> null,
        asBuffer() {
            if (!body._buffer) {
                body._buffer = new Promise((resolve, reject) => {
                    let chunks: Buffer[] = [];
                    let stream = body.rawStream;
                    stream.on('data', (d: Buffer) => chunks.push(d));
                    stream.on('end', () => resolve(Buffer.concat(chunks)));
                    stream.on('error', reject);
                });
            }
            return <Promise<Buffer>> body._buffer;
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
    transformedRequest.body = body;

    next();
};
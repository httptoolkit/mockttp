import * as http2 from 'http2';
import type * as net from 'net';
import { PassThrough } from 'stream';
import { CustomError } from '@httptoolkit/util';

import {
    flattenPairedRawHeaders,
    objectHeadersToFlat,
    pairFlatRawHeaders
} from '../../util/header-utils';
import type {
    UpstreamExchange,
    UpstreamRequestHooks,
    UpstreamResponse
} from './upstream-exchange';

const withoutPseudoHeaders = (rawHeaders: string[]) => flattenPairedRawHeaders(
    pairFlatRawHeaders(rawHeaders).filter(([name]) => !name.startsWith(':'))
);

const incompleteStreamError = (stream: http2.ClientHttp2Stream) => new CustomError(
    `Upstream HTTP/2 stream closed before the response completed (code ${stream.rstCode})`,
    { code: 'ERR_HTTP2_STREAM_ERROR' }
);

/**
 * When a session closes mid-response, Node ends its streams as if they'd completed, setting
 * only an rstCode. We relay the body to fail that case, instead of silently truncating it.
 */
function relayResponseBody(stream: http2.ClientHttp2Stream) {
    const body = new PassThrough();
    stream.pipe(body, { end: false });

    stream.once('end', () => {
        if (stream.rstCode && stream.rstCode !== http2.constants.NGHTTP2_NO_ERROR) {
            body.destroy(incompleteStreamError(stream));
        } else {
            body.end();
        }
    });
    stream.on('error', (error) => body.destroy(error));

    body.once('close', () => {
        if (!body.readableEnded && !stream.closed) stream.close(http2.constants.NGHTTP2_CANCEL);
    });

    return body;
}

/**
 * Present an HTTP/2 request stream as an exchange. The stream is both the request body
 * and, once the response head arrives, the response body.
 */
export function startH2Exchange(
    stream: http2.ClientHttp2Stream,
    socket: net.Socket,
    hooks: UpstreamRequestHooks
): UpstreamExchange {
    hooks.onSocket(socket);

    stream.on('headers', (headers, _flags, rawHeaders) => {
        const statusCode = Number(headers[':status']);
        if (statusCode >= 100 && statusCode < 200) {
            hooks.onInformational(statusCode, withoutPseudoHeaders(rawHeaders));
        }
    });

    let rawTrailers: string[] = [];
    // Node passes the raw trailers as a third argument, but its typings don't declare it:
    stream.once('trailers', (trailers, _flags, raw?: string[]) => {
        rawTrailers = raw ?? objectHeadersToFlat(trailers);
    });

    const response = new Promise<UpstreamResponse>((resolve, reject) => {
        let responded = false;
        let failed = false;

        stream.once('response', (headers, _flags, rawHeaders) => {
            responded = true;
            resolve({
                statusCode: Number(headers[':status']),
                statusMessage: '',
                httpVersion: '2.0',
                headers,
                rawHeaders,
                body: relayResponseBody(stream),
                getRawTrailers: () => rawTrailers
            });
        });

        stream.on('error', (error) => {
            failed = true;
            if (!responded) reject(error);
        });

        // A session can go away without failing its streams individually. That still has
        // to fail the exchange, or it would wait forever for a response or body end.
        stream.once('close', () => {
            if (failed || stream.readableEnded) return;
            const error = incompleteStreamError(stream);
            if (responded) stream.emit('error', error);
            else reject(error);
        });
    });

    return {
        requestBody: stream,
        addTrailers: undefined,
        response
    };
}

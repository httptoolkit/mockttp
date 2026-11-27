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

// For a stream that stops before it's complete, without an error code. Node raises this
// itself from v27 when the server resets a stream, but otherwise closes it silently.
const abortedStreamError = (stream: http2.ClientHttp2Stream) => new CustomError(
    `Upstream HTTP/2 stream closed before the response completed (code ${stream.rstCode})`,
    { code: 'ERR_HTTP2_STREAM_ABORTED' }
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
            body.destroy(abortedStreamError(stream));
        } else {
            body.end();
        }
    });

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
        let body: PassThrough | undefined;

        stream.once('response', (headers, flags, rawHeaders) => {
            body = relayResponseBody(stream);
            resolve({
                statusCode: Number(headers[':status']),
                statusMessage: '',
                httpVersion: '2.0',
                headers,
                rawHeaders,
                endedWithHead: (flags & http2.constants.NGHTTP2_FLAG_END_STREAM) !== 0,
                body,
                getRawTrailers: () => rawTrailers
            });
        });

        // Until the response head arrives failures reject the exchange, then they fail its body:
        const fail = (error: Error) => {
            if (body) body.destroy(error);
            else reject(error);
        };
        stream.on('error', fail);

        // A stream can close without any error and without finishing, if the server resets
        // it cleanly or its session goes away. That still has to fail the exchange, or it
        // would wait forever for a response or body end.
        stream.once('close', () => {
            if (!body?.writableEnded) fail(abortedStreamError(stream));
        });
    });

    return {
        requestBody: stream,
        addTrailers: undefined,
        response
    };
}

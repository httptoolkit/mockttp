import type * as net from 'net';
import type * as tls from 'tls';
import type { Readable, Writable } from 'stream';

import type { Headers, RawHeaders } from '../../types';

export interface UpstreamRequestHead {
    method: string;
    path: string;
    rawHeaders: RawHeaders;
}

/**
 * A request ready to send upstream: every input that affects the connection or the
 * request, with headers already shaped for the route that will carry it.
 */
export interface UpstreamRequestSpec extends UpstreamRequestHead {
    protocol: 'http:' | 'https:';
    /** The address to connect to. The name we expect to find there is the TLS servername. */
    hostname: string;
    port: number;
    family: 4 | 6 | undefined;
    lookup: net.LookupFunction;
    tlsOptions: tls.ConnectionOptions;
    keyLogStream: Writable | undefined;
    /**
     * Whether the request ends with its headers, so no body can follow. HTTP/2 has to say
     * so as the request starts, while HTTP/1 shows it in the headers themselves.
     */
    endStream: boolean;
}

export interface UpstreamRequestHooks {
    /** Before the request is sent this cancels waiting for a connection, afterwards the request itself. */
    signal: AbortSignal;
    onSocket(socket: net.Socket): void;
    onInformational(statusCode: number, rawHeaders: string[]): void;
}

/**
 * One request/response exchange with an upstream server, in the same shape whichever
 * protocol carries it. The request head has already been sent when this is returned.
 */
export interface UpstreamExchange {
    /** The caller writes the request body here, and ends it. */
    requestBody: Writable;
    /** Absent when the protocol in use can't send request trailers. */
    addTrailers: ((rawTrailers: RawHeaders) => void) | undefined;
    /** Rejects if the exchange fails before a response head arrives. */
    response: Promise<UpstreamResponse>;
}

export interface UpstreamResponse {
    statusCode: number;
    statusMessage: string | undefined;
    httpVersion: string;
    headers: Headers;
    rawHeaders: string[];
    /** Ends normally, or emits an error if the exchange fails after the head. */
    body: Readable;
    /** Complete once the body has ended. */
    getRawTrailers(): string[];
}

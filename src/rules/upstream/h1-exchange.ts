import * as http from 'http';
import * as https from 'https';
import type * as net from 'net';
import type { Writable } from 'stream';

import { flattenPairedRawHeaders } from '../../util/header-utils';
import type {
    UpstreamExchange,
    UpstreamRequestHead,
    UpstreamRequestHooks,
    UpstreamRequestSpec,
    UpstreamResponse
} from './upstream-exchange';

/**
 * Send an HTTP/1 request, with headers exactly as given: Node adds nothing of its own,
 * except in old versions without setDefaultHeaders, which still add their usual defaults.
 * The connection is whatever the agent in `connectionOptions` provides.
 */
export function startH1Exchange(
    protocol: 'http:' | 'https:',
    connectionOptions: https.RequestOptions,
    head: UpstreamRequestHead,
    hooks: UpstreamRequestHooks
): UpstreamExchange {
    const options: https.RequestOptions = {
        ...connectionOptions,
        method: head.method,
        path: head.path,
        headers: flattenPairedRawHeaders(head.rawHeaders),
        setDefaultHeaders: false,
        signal: hooks.signal
    };
    const request = protocol === 'https:'
        ? https.request(options)
        : http.request(options);

    request.on('socket', hooks.onSocket);
    request.on('information', (info) => hooks.onInformational(info.statusCode, info.rawHeaders));

    const response = new Promise<UpstreamResponse>((resolve, reject) => {
        let incoming: http.IncomingMessage | undefined;
        request.once('response', (res) => {
            incoming = res;
            resolve({
                statusCode: res.statusCode!,
                statusMessage: res.statusMessage,
                httpVersion: res.httpVersion,
                headers: res.headers,
                rawHeaders: res.rawHeaders,
                body: res,
                getRawTrailers: () => res.rawTrailers
            });
        });
        request.on('error', (error) => {
            if (!incoming) reject(error);
            else if (!incoming.readableEnded) incoming.destroy(error);
        });
    });

    // We connect & send the head immediately, without buffering, to mirror the downstream
    // client as closely as possible: it has already connected and sent its own head.
    request.setNoDelay(true);
    request.flushHeaders();

    return {
        requestBody: request,
        addTrailers: (rawTrailers) => request.addTrailers(rawTrailers),
        response
    };
}

const keyLoggedSockets = new WeakSet<net.Socket>();

/**
 * Send a request through a Node agent, which owns connecting and pooling.
 */
export function sendViaAgent(
    agent: http.Agent | false,
    spec: UpstreamRequestSpec,
    hooks: UpstreamRequestHooks
): UpstreamExchange {
    const { keyLogStream } = spec;
    return startH1Exchange(spec.protocol, {
        protocol: spec.protocol,
        hostname: spec.hostname,
        port: spec.port,
        family: spec.family,
        lookup: spec.lookup,
        agent,
        ...spec.tlsOptions
    }, spec, keyLogStream
        ? { ...hooks, onSocket: (socket) => {
            logTlsKeys(socket, keyLogStream);
            hooks.onSocket(socket);
        } }
        : hooks
    );
}

// Pooled sockets are reported again for each request they carry:
function logTlsKeys(socket: net.Socket, keyLogStream: Writable) {
    if (keyLoggedSockets.has(socket)) return;
    keyLoggedSockets.add(socket);
    socket.on('keylog', (line) => keyLogStream.write(line));
}

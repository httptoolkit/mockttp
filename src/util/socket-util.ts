import * as _ from 'lodash';
import now = require("performance-now");
import * as os from 'os';
import * as net from 'net';
import * as tls from 'tls';
import * as http2 from 'http2';

import { isNode } from './util';
import { OngoingRequest, TlsConnectionEvent } from '../types';

// Test if a local port for a given interface (IPv4/6) is currently in use
export async function isLocalPortActive(interfaceIp: '::1' | '127.0.0.1', port: number) {
    if (interfaceIp === '::1' && !isLocalIPv6Available) return false;

    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen({
            host: interfaceIp,
            port,
            ipv6Only: interfaceIp === '::1'
        });
        server.once('listening', () => {
            resolve(false);
            server.close(() => {});
        });
        server.once('error', (e) => {
            resolve(true);
        });
    });
}

// This file imported in browsers etc as it's used in handlers, but none of these methods are used
// directly. It is useful though to guard sections that immediately perform actions:
export const isLocalIPv6Available = isNode
    ? _.some(os.networkInterfaces(),
        (addresses) => _.some(addresses, a => a.address === '::1')
    )
    : true;

// We need to normalize ips some cases (especially comparisons), because the same ip may be reported
// as ::ffff:127.0.0.1 and 127.0.0.1 on the two sides of the connection, for the same ip.
export const normalizeIP = (ip: string | null | undefined) =>
    (ip && ip.startsWith('::ffff:'))
        ? ip.slice('::ffff:'.length)
        : ip;

export const isLocalhostAddress = (host: string | null | undefined) =>
    !!host && ( // Null/undef are something else weird, but not localhost
        host === 'localhost' || // Most common
        host.endsWith('.localhost') ||
        host === '::1' || // IPv6
        normalizeIP(host)!.match(/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/) // 127.0.0.0/8 range
    );


// Check whether an incoming socket is the other end of one of our outgoing sockets:
export const isSocketLoop = (outgoingSockets: net.Socket[] | Set<net.Socket>, incomingSocket: net.Socket) =>
    // We effectively just compare the address & port: if they match, we've almost certainly got a loop.

    // I don't think it's generally possible to see the same ip on different interfaces from one process (you need
    // ip-netns network namespaces), but if it is, then there's a tiny chance of false positives here. If we have ip X,
    // and on another interface somebody else has ip X, and they send a request with the same incoming port as an
    // outgoing request we have on the other interface, we'll assume it's a loop. Extremely unlikely imo.

    _.some([...outgoingSockets], (outgoingSocket) => {
        if (!outgoingSocket.localAddress || !outgoingSocket.localPort) {
            // It's possible for sockets in outgoingSockets to be closed, in which case these properties
            // will be undefined. If so, we know they're not relevant to loops, so skip entirely.
            return false;
        } else {
            return normalizeIP(outgoingSocket.localAddress) === normalizeIP(incomingSocket.remoteAddress) &&
                outgoingSocket.localPort === incomingSocket.remotePort;
        }
    });

export function getParentSocket(socket: net.Socket) {
    return socket._parent || // TLS wrapper
        socket.stream || // SocketWrapper
        (socket as any)._handle?._parentWrap?.stream; // HTTP/2 CONNECT'd TLS wrapper
}

const isSocketResetSupported = isNode
    ? !!net.Socket.prototype.resetAndDestroy
    : false; // Avoid errors in browsers
export const requireSocketResetSupport = () => {
    if (!isSocketResetSupported) {
        throw new Error(
            'Connection reset is only supported in Node v16.17+, v18.3.0+, or later'
        );
    }
};

const isHttp2Stream = (maybeStream: any): maybeStream is http2.Http2ServerRequest =>
    'httpVersion' in maybeStream &&
    maybeStream.httpVersion?.startsWith('2');

/**
 * Reset the socket where possible, or at least destroy it where that's not possible.
 *
 * This has a few cases for different layers of socket & tunneling, designed to
 * simulate a real connection reset as closely as possible. That means, in general,
 * we unwrap the connection as far as possible whilst still only affecting a single
 * request.
 *
 * In practice, we unwrap HTTP/1 & TLS back as far as we can, until we hit either an
 * HTTP/2 stream or a raw TCP connection. We then either send a RST_FRAME or a TCP RST
 * to kill that connection.
 */
export function resetOrDestroy(requestOrSocket:
    | net.Socket
    | OngoingRequest & { socket?: net.Socket }
    | http2.Http2ServerRequest
) {
    let primarySocket: net.Socket | http2.Http2Stream =
        (isHttp2Stream(requestOrSocket) && requestOrSocket.stream)
            ? requestOrSocket.stream
        : ('socket' in requestOrSocket && requestOrSocket.socket)
            ? requestOrSocket.socket
        : requestOrSocket as net.Socket;

    let socket = primarySocket;

    while (socket instanceof tls.TLSSocket) {
        const parent = getParentSocket(socket);
        if (!parent) break; // Not clear why, but it seems in some cases we run out of parents here
        socket = parent;
    }

    if ('rstCode' in socket) {
        // It's an HTTP/2 stream instance - let's kill it here.

        // If it's the innermost stream, i.e. this is the stream of the request we're
        // resetting, then we want to send an internal error. If it's a tunneling
        // stream, then we want to send a CONNECT error:
        const isOuterSocket = socket === (requestOrSocket as any).stream;

        const errorCode = isOuterSocket
            ? http2.constants.NGHTTP2_INTERNAL_ERROR
            : http2.constants.NGHTTP2_CONNECT_ERROR;

        const h2Stream = socket as http2.ServerHttp2Stream;
        h2Stream.close(errorCode);
    } else {
        // Must be a net.Socket then, so we let's reset it for real:
        if (isSocketResetSupported) {
            try {
                socket.resetAndDestroy!();
            } catch (error) {
                // This could fail in funky ways if the socket is not just the right kind
                // of socket. We should still fail in that case, but it's useful to log
                // some extra data first beforehand, so we can fix this if it ever happens:
                console.warn(`Failed to reset on socket of type ${
                    socket.constructor.name
                } with parent of type ${getParentSocket(socket as any)?.constructor.name}`);
                throw error;
            }
        } else {
            socket.destroy();
        }
    }

    // Explicitly mark the top-level socket as destroyed too. This isn't always required, but
    // is good for backwards compat (<v20) as it fixes some issues where the 'destroyed'
    // states can end up out of sync in older Node versions.
    primarySocket.destroy();
};

export function buildSocketEventData(socket: net.Socket & Partial<tls.TLSSocket>): TlsConnectionEvent {
    const timingInfo = socket.__timingInfo ||
        socket._parent?.__timingInfo ||
        buildSocketTimingInfo();

    // Attached in passThroughMatchingTls TLS sniffing logic in http-combo-server:
    const tlsMetadata = socket.__tlsMetadata ||
        socket._parent?.__tlsMetadata ||
        {};

    return {
        hostname: socket.servername,
        // These only work because of oncertcb monkeypatch in http-combo-server:
        remoteIpAddress: socket.remoteAddress || // Normal case
            socket._parent?.remoteAddress || // Pre-certCB error, e.g. timeout
            socket.initialRemoteAddress!, // Recorded by certCB monkeypatch
        remotePort: socket.remotePort ||
            socket._parent?.remotePort ||
            socket.initialRemotePort!,
        tags: [],
        timingEvents: {
            startTime: timingInfo.initialSocket,
            connectTimestamp: timingInfo.initialSocketTimestamp,
            tunnelTimestamp: timingInfo.tunnelSetupTimestamp,
            handshakeTimestamp: timingInfo.tlsConnectedTimestamp
        },
        tlsMetadata
    };
}

export function buildSocketTimingInfo(): Required<net.Socket>['__timingInfo'] {
    return { initialSocket: Date.now(), initialSocketTimestamp: now() };
}
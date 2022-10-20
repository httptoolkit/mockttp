import * as _ from 'lodash';
import * as os from 'os';
import * as net from 'net';

import { isNode } from './util';

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

// We need to normalize ips for comparison, because the same ip may be reported as ::ffff:127.0.0.1
// and 127.0.0.1 on the two sides of the connection, for the same ip.
const normalizeIp = (ip: string | null | undefined) =>
    (ip && ip.startsWith('::ffff:'))
        ? ip.slice('::ffff:'.length)
        : ip;

export const isLocalhostAddress = (host: string | null | undefined) =>
    host === 'localhost' || // Most common
    host === '::1' || // IPv6
    normalizeIp(host)?.match(/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/); // 127.0.0.0/8 range


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
            return normalizeIp(outgoingSocket.localAddress) === normalizeIp(incomingSocket.remoteAddress) &&
                outgoingSocket.localPort === incomingSocket.remotePort;
        }
    });

export const resetSocket = (socket: net.Socket) => {
    if (!('resetAndDestroy' in socket)) {
        throw new Error(
            'Connection reset is only supported in Node v16.17+, v18.3.0+, or later'
        );
    }

    socket.resetAndDestroy();
};
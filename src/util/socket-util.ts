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
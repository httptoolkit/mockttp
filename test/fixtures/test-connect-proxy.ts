import * as net from 'net';
import * as http from 'http';

import { pairFlatRawHeaders } from '../../src/util/header-utils';
import { splitHostAndPortStrictly } from '../../src/util/url';

/**
 * How the proxy should respond to a CONNECT request, to simulate a broken proxy.
 */
export type ProxyConnectBehaviour =
    | 'tunnel' // Connect to the target & pipe traffic through
    | 'reject-502' // Refuse the tunnel with an error status
    | 'drop'; // Close the connection without answering at all

export interface TestProxyOptions {
    /**
     * If set, CONNECT requests must send matching 'user:password' credentials,
     * and are rejected with a 407 otherwise.
     */
    requireAuth?: string;

    behaviour?: ProxyConnectBehaviour;
}

export interface ConnectRequest {
    target: string;
    headers: Array<[string, string]>;
}

export interface TestProxy {
    port: number;
    url: string;
    /** Every CONNECT this proxy received, including its raw headers. */
    connectRequests: ConnectRequest[];
    openCount: () => number;
    totalCount: () => number;
    stop: () => Promise<void>;
}

/**
 * A raw CONNECT proxy, for the cases Mockttp itself can't cover: inspecting the CONNECT
 * request (Mockttp consumes & strips proxy credentials) and refusing the tunnel outright
 * (Mockttp always accepts a CONNECT before handling the traffic within it).
 */
export async function startTestProxy(options: TestProxyOptions = {}): Promise<TestProxy> {
    const behaviour = options.behaviour ?? 'tunnel';
    const connectRequests: ConnectRequest[] = [];
    const openSockets = new Set<net.Socket>();
    let totalConnections = 0;

    const server = http.createServer((_req, res) => {
        res.writeHead(400);
        res.end();
    });

    server.on('connect', (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
        connectRequests.push({ target: req.url!, headers: pairFlatRawHeaders(req.rawHeaders) });

        if (options.requireAuth) {
            const expected = `Basic ${Buffer.from(options.requireAuth).toString('base64')}`;
            if (req.headers['proxy-authorization'] !== expected) {
                clientSocket.end(
                    'HTTP/1.1 407 Proxy Authentication Required\r\n' +
                    'Proxy-Authenticate: Basic realm="test"\r\n\r\n'
                );
                return;
            }
        }

        if (behaviour === 'reject-502') {
            // The marker header lets tests prove this response came from the proxy itself,
            // rather than being synthesized after a failure:
            clientSocket.end(
                'HTTP/1.1 502 Bad Gateway\r\n' +
                'X-Test-Proxy: connect-rejected\r\n\r\n'
            );
            return;
        }
        if (behaviour === 'drop') {
            clientSocket.destroy();
            return;
        }

        const [host, port] = splitHostAndPortStrictly(req.url!);
        if (!port) {
            clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
            return;
        }

        const upstream = net.connect(parseInt(port, 10), host, () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head?.length) upstream.write(head);
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
        });
        upstream.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => upstream.destroy());
    });

    server.on('connection', (socket: net.Socket) => {
        totalConnections += 1;
        openSockets.add(socket);
        socket.once('close', () => openSockets.delete(socket));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    return {
        port: (server.address() as net.AddressInfo).port,
        url: `http://localhost:${(server.address() as net.AddressInfo).port}`,
        connectRequests,
        openCount: () => openSockets.size,
        totalCount: () => totalConnections,
        stop: async () => {
            for (const socket of openSockets) socket.destroy();
            openSockets.clear();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    };
}

import * as net from 'net';
import * as tls from 'tls';
import * as http from 'http';
import * as WebSocket from 'ws';

import * as url from 'url';

interface InterceptedWebSocket extends WebSocket {
    upstreamSocket: WebSocket;
}

// Pile of hacks to blindly forward all WS connections upstream untouched
export class WebSocketHandler {
    private wsServer = new WebSocket.Server({ noServer: true });

    constructor() {
        this.wsServer.on('connection', (ws: InterceptedWebSocket) => {
            ws.on('message', (msg) => (<any> ws).upstreamSocket.send(msg));
            ws.on('close', (num, reason) => ws.upstreamSocket.close(num, reason));

            ws.upstreamSocket.on('message', (msg) => ws.send(msg));
            ws.upstreamSocket.on('close', (num, reason) => ws.close(num, reason));
        });
    }

    handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
        // Protocol detection is hard. There's probably better solutions, but for now
        // we do the hackiest: try wss, if that fails, try ws.
        // This means we might upgrade/downgrade accidentally. For now, that's
        // just about acceptable, but this definitely needs improving.
        this.connectUpstream('wss', req, socket, head);
    }

    private connectUpstream(protocol: string, req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
        let { hostname, port, path } = url.parse(req.url!);
        if (!hostname) {
            // Transparent proxying:
            const hostHeader = req.headers.host;
            [ hostname, port ] = hostHeader!.split(':');
        }

        const upstreamSocket = new WebSocket(`${protocol}://${hostname}:${port}/${path}`);

        let success = false;
        upstreamSocket.once('open', () => {
            success = true;
            this.wsServer.handleUpgrade(req, socket, head, (ws) => {
                (<InterceptedWebSocket> ws).upstreamSocket = upstreamSocket;
                this.wsServer.emit('connection', ws);
            });
        });

        upstreamSocket.on('error', (e: any) => {
            if (e.code === 'ECONNRESET' && !success && protocol === 'wss') {
                // Our optimistic WSS failed - try downgrading.
                this.connectUpstream('ws', req, socket, head);
            }
        });
    }
}
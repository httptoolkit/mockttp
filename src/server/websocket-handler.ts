import * as net from 'net';
import * as http from 'http';
import * as WebSocket from 'ws';

import * as url from 'url';

interface InterceptedWebSocket extends WebSocket {
    upstreamSocket: WebSocket;
}

// Pile of hacks to blindly forward all WS connections upstream untouched
export class WebSocketHandler {
    private wsServer = new WebSocket.Server({ noServer: true });

    constructor(private debug: boolean) {
        this.wsServer.on('connection', (ws: InterceptedWebSocket) => {
            if (this.debug) console.log('Successfully proxying websocket streams');

            this.pipeWebSocket(ws, ws.upstreamSocket);
            this.pipeWebSocket(ws.upstreamSocket, ws);
        });
    }

    async handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
        let { protocol: requestedProtocol, hostname, port, path } = url.parse(req.url!);

        if (this.debug) console.log(`Handling upgrade for ${req.url}`);

        const transparentProxy = !hostname;

        if (transparentProxy) {
            const hostHeader = req.headers.host;
            [ hostname, port ] = hostHeader!.split(':');

            // upstreamEncryption is set in http-combo-server, for requests that have explicitly
            // CONNECTed upstream (which may then up/downgrade from the current encryption).
            let protocol: string;
            if (socket.upstreamEncryption !== undefined) {
                protocol = socket.upstreamEncryption ? 'wss' : 'ws';
            } else {
                protocol = req.connection.encrypted ? 'wss' : 'ws';
            }

            this.connectUpstream(`${protocol}://${hostname}${port ? ':' + port : ''}${path}`, req, socket, head);
        } else {
            // Connect directly according to the specified URL
            const protocol = requestedProtocol!.replace('http', 'ws');
            this.connectUpstream(`${protocol}//${hostname}${port ? ':' + port : ''}${path}`, req, socket, head);
        }
    }

    private connectUpstream(url: string, req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
        if (this.debug) console.log(`Connecting to upstream websocket at ${url}`);

        const upstreamSocket = new WebSocket(url);

        upstreamSocket.once('open', () => {
            this.wsServer.handleUpgrade(req, socket, head, (ws) => {
                (<InterceptedWebSocket> ws).upstreamSocket = upstreamSocket;
                this.wsServer.emit('connection', ws);
            });
        });

        upstreamSocket.once('error', (e) => console.warn(e));
    }

    private pipeWebSocket(inSocket: WebSocket, outSocket: WebSocket) {
        const onPipeFailed = (op: string) => (err?: Error) => {
            if (!err) return;

            inSocket.close();
            console.error(`Websocket ${op} failed`, err);
        };

        inSocket.on('message', (msg) => outSocket.send(msg, onPipeFailed('message')));
        inSocket.on('close', (num, reason) => {
            if (num >= 1000 && num <= 1004) {
                if (this.debug) console.log('Successfully proxying websocket streams');
                outSocket.close(num, reason);
            } else {
                // Unspecified or invalid error
                outSocket.close();
            }
        });

        inSocket.on('ping', (data) => outSocket.ping(data, undefined, onPipeFailed('ping')));
        inSocket.on('pong', (data) => outSocket.pong(data, undefined, onPipeFailed('pong')));
    }
}
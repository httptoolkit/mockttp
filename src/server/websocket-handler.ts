import * as _ from 'lodash';
import * as net from 'net';
import * as http from 'http';
import * as WebSocket from 'ws';

import * as url from 'url';
import { streamToBuffer } from '../util/request-utils';

interface InterceptedWebSocket extends WebSocket {
    upstreamSocket: WebSocket;
}

// Pile of hacks to blindly forward all WS connections upstream untouched
export class WebSocketHandler {
    private wsServer = new WebSocket.Server({ noServer: true });

    constructor(
        private debug: boolean,
        private ignoreHostCertificateErrors: string[]
    ) {
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

    private connectUpstream(wsUrl: string, req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
        if (this.debug) console.log(`Connecting to upstream websocket at ${url}`);

        // Skip cert checks if the host or host+port are whitelisted
        const parsedUrl = url.parse(wsUrl);
        const checkServerCertificate = !_.includes(this.ignoreHostCertificateErrors, parsedUrl.hostname) &&
            !_.includes(this.ignoreHostCertificateErrors, parsedUrl.host);

        const upstreamSocket = new WebSocket(wsUrl, {
            rejectUnauthorized: checkServerCertificate
        });

        upstreamSocket.once('open', () => {
            this.wsServer.handleUpgrade(req, socket, head, (ws) => {
                (<InterceptedWebSocket> ws).upstreamSocket = upstreamSocket;
                this.wsServer.emit('connection', ws);
            });
        });

        // If the upstream says no, we say no too.
        upstreamSocket.on('unexpected-response', (req, res) => {
            this.mirrorRejection(socket, res);
        });

        // If there's some other error, we just kill the socket:
        upstreamSocket.once('error', (e) => {
            console.warn(e);
            socket.end();
        });
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

    private async mirrorRejection(socket: net.Socket, rejectionResponse: http.IncomingMessage) {
        if (socket.writable) {
            const { statusCode, statusMessage, headers } = rejectionResponse;

            socket.write(
                `HTTP/1.1 ${statusCode} ${statusMessage}\r\n` +
                _.map(headers, (value, key) =>
                    `${key}: ${value}`
                ).join('\r\n') +
                '\r\n\r\n'
            );

            const body = await streamToBuffer(rejectionResponse);
            if (socket.writable) socket.write(body);
        }

        socket.destroy();
    }
}
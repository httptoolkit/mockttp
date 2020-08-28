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

    handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
        let { protocol: requestedProtocol, hostname, port, path } = url.parse(req.url!);

        if (this.debug) console.log(`Handling upgrade for ${req.url}`);

        const transparentProxy = !hostname;

        if (transparentProxy) {
            const hostHeader = req.headers.host;
            [ hostname, port ] = hostHeader!.split(':');

            // upstreamEncryption is set in http-combo-server, for requests that have explicitly
            // CONNECTed upstream (which may then up/downgrade from the current encryption).
            let protocol: string;
            if (socket.lastHopEncrypted !== undefined) {
                protocol = socket.lastHopEncrypted ? 'wss' : 'ws';
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

    private connectUpstream(wsUrl: string, req: http.IncomingMessage, incomingSocket: net.Socket, head: Buffer) {
        if (this.debug) console.log(`Connecting to upstream websocket at ${wsUrl}`);

        // Skip cert checks if the host or host+port are whitelisted
        const parsedUrl = url.parse(wsUrl);
        const checkServerCertificate = !_.includes(this.ignoreHostCertificateErrors, parsedUrl.hostname) &&
            !_.includes(this.ignoreHostCertificateErrors, parsedUrl.host);

        const upstreamSocket = new WebSocket(wsUrl, {
            rejectUnauthorized: checkServerCertificate,
            maxPayload: 0,
            headers: _.omitBy(req.headers, (_v, headerName) =>
                headerName.toLowerCase().startsWith('sec-websocket') ||
                headerName.toLowerCase() === 'connection'
            ) as { [key: string]: string } // Simplify to string - doesn't matter though, only used by http module anyway
        });

        upstreamSocket.once('open', () => {
            if (this.debug) console.log(`Websocket connected to ${wsUrl}`);
            // Presumably the below adds an error handler. But what about before we get here?
            this.wsServer.handleUpgrade(req, incomingSocket, head, (ws) => {
                (<InterceptedWebSocket> ws).upstreamSocket = upstreamSocket;
                this.wsServer.emit('connection', ws);
            });
        });

        // If the upstream says no, we say no too.
        upstreamSocket.on('unexpected-response', (req, res) => {
            console.log(`Unexpected websocket response from ${wsUrl}: ${res.statusCode}`);
            this.mirrorRejection(incomingSocket, res);
        });

        // If there's some other error, we just kill the socket:
        upstreamSocket.on('error', (e) => {
            console.warn(e);
            incomingSocket.end();
        });

        incomingSocket.on('error', () => upstreamSocket.close(1011)); // Internal error
    }

    private pipeWebSocket(inSocket: WebSocket, outSocket: WebSocket) {
        const onPipeFailed = (op: string) => (err?: Error) => {
            if (!err) return;

            inSocket.close();
            console.error(`Websocket ${op} failed`, err);
        };

        inSocket.on('message', (msg) => {
            if (isOpen(outSocket)) {
                outSocket.send(msg, onPipeFailed('message'))
            }
        });
        inSocket.on('close', (num, reason) => {
            if (num >= 1000 && num <= 1004) {
                if (this.debug) console.log('Cleanly closing websocket stream');
                outSocket.close(num, reason);
            } else {
                console.log(`Unhappily closing websocket ${num}: ${reason}`);
                // Unspecified or invalid error
                outSocket.close();
            }
        });

        inSocket.on('ping', (data) => {
            if (isOpen(outSocket)) outSocket.ping(data, undefined, onPipeFailed('ping'))
        });
        inSocket.on('pong', (data) => {
            if (isOpen(outSocket)) outSocket.pong(data, undefined, onPipeFailed('pong'))
        });
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

function isOpen(socket: WebSocket) {
    return socket.readyState === WebSocket.OPEN;
}
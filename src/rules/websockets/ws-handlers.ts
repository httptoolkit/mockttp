/**
 * @module MockWebsocketRule
 */

import * as _ from 'lodash';
import net = require('net');
import * as url from 'url';
import * as http from 'http';
import * as WebSocket from 'ws';
import { stripIndent } from 'common-tags';

import {
    Serializable
} from "../../util/serialization";

import {
    OngoingRequest,
    Explainable
} from "../../types";

import {
    CloseConnectionHandler,
    TimeoutHandler,
    ForwardingOptions
} from '../handlers';
import { streamToBuffer, isHttp2 } from '../../util/request-utils';

export interface WebSocketHandler extends Explainable, Serializable {
    type: keyof typeof WsHandlerLookup;
    handle(
        // The incoming upgrade request
        request: OngoingRequest,
        // The raw socket on which we'll be communicating
        socket: net.Socket,
        // Initial data received
        head: Buffer
    ): Promise<void>;
}

interface InterceptedWebSocket extends WebSocket {
    upstreamSocket: WebSocket;
}

function isOpen(socket: WebSocket) {
    return socket.readyState === WebSocket.OPEN;
}

function pipeWebSocket(inSocket: WebSocket, outSocket: WebSocket) {
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

async function mirrorRejection(socket: net.Socket, rejectionResponse: http.IncomingMessage) {
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

export interface PassThroughWebSocketHandlerOptions {
    forwarding?: ForwardingOptions;
    ignoreHostCertificateErrors?: string[];
}

export class PassThroughWebSocketHandler extends Serializable implements WebSocketHandler {
    readonly type = 'ws-passthrough';

    public readonly forwarding?: ForwardingOptions;
    public readonly ignoreHostCertificateErrors: string[] = [];

    private wsServer?: WebSocket.Server;

    constructor(options: PassThroughWebSocketHandlerOptions = {}) {
        super();

        this.ignoreHostCertificateErrors = options.ignoreHostCertificateErrors || [];
        if (!Array.isArray(this.ignoreHostCertificateErrors)) {
            throw new Error("ignoreHostCertificateErrors must be an array");
        }

        // If a location is provided, and it's not a bare hostname, it must be parseable
        const { forwarding } = options;
        if (forwarding && forwarding.targetHost.includes('/')) {
            const { protocol, hostname, port, path } = url.parse(forwarding.targetHost);
            if (path && path.trim() !== "/") {
                const suggestion = url.format({ protocol, hostname, port }) ||
                    forwarding.targetHost.slice(0, forwarding.targetHost.indexOf('/'));
                throw new Error(stripIndent`
                    URLs for forwarding cannot include a path, but "${forwarding.targetHost}" does. ${''
                    }Did you mean ${suggestion}?
                `);
            }
        }
        this.forwarding = options.forwarding;
    }

    explain() {
        return this.forwarding
            ? `forward the websocket to ${this.forwarding.targetHost}`
            : 'pass the request through to the target host';
    }

    private initializeWsServer() {
        if (this.wsServer) return;

        this.wsServer = new WebSocket.Server({ noServer: true });
        this.wsServer.on('connection', (ws: InterceptedWebSocket) => {
            pipeWebSocket(ws, ws.upstreamSocket);
            pipeWebSocket(ws.upstreamSocket, ws);
        });
    }

    async handle(req: OngoingRequest, socket: net.Socket, head: Buffer) {
        this.initializeWsServer();

        let { protocol, hostname, port, path } = url.parse(req.url!);
        const headers = req.headers;

        const reqMessage = req as unknown as http.IncomingMessage;
        const isH2Downstream = isHttp2(req);
        const hostHeaderName = isH2Downstream ? ':authority' : 'host';

        if (this.forwarding) {
            const { targetHost, updateHostHeader } = this.forwarding;

            let wsUrl: string;
            if (!targetHost.includes('/')) {
                // We're forwarding to a bare hostname, just overwrite that bit:
                [hostname, port] = targetHost.split(':');
            } else {
                // Forwarding to a full URL; override the host & protocol, but never the path.
                ({ protocol, hostname, port } = url.parse(targetHost));
            }

            // Connect directly to the forwarding target URL
            wsUrl = `${
                protocol!.replace('http', 'ws')
            }//${hostname}${port ? ':' + port : ''}${path}`;

            // Optionally update the host header too:
            if (updateHostHeader === undefined || updateHostHeader === true) {
                // If updateHostHeader is true, or just not specified, match the new target
                headers[hostHeaderName] = hostname + (port ? `:${port}` : '');
            } else if (updateHostHeader) {
                // If it's an explicit custom value, use that directly.
                headers[hostHeaderName] = updateHostHeader;
            } // Otherwise: falsey means don't touch it.

            this.connectUpstream(wsUrl, reqMessage, headers, socket, head);
        } else if (!hostname) { // No hostname in URL means transparent proxy, so use Host header
            const hostHeader = req.headers[hostHeaderName];
            [ hostname, port ] = hostHeader!.split(':');

            // lastHopEncrypted is set in http-combo-server, for requests that have explicitly
            // CONNECTed upstream (which may then up/downgrade from the current encryption).
            if (socket.lastHopEncrypted !== undefined) {
                protocol = socket.lastHopEncrypted ? 'wss' : 'ws';
            } else {
                protocol = reqMessage.connection.encrypted ? 'wss' : 'ws';
            }

            const wsUrl = `${protocol}://${hostname}${port ? ':' + port : ''}${path}`;
            this.connectUpstream(wsUrl, reqMessage, headers, socket, head);
        } else {
            // Connect directly according to the specified URL
            const wsUrl = `${
                protocol!.replace('http', 'ws')
            }//${hostname}${port ? ':' + port : ''}${path}`;

            this.connectUpstream(wsUrl, reqMessage, headers, socket, head);
        }
    }

    private connectUpstream(
        wsUrl: string,
        req: http.IncomingMessage,
        headers: http.IncomingHttpHeaders,
        incomingSocket: net.Socket,
        head: Buffer
    ) {
        // Initialize the server when we handle the first actual request. Mainly just so we
        // don't try to initialize it in a browser when buiding rules initially.
        if (!this.wsServer) this.wsServer = new WebSocket.Server({ noServer: true });

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
            // Presumably the below adds an error handler. But what about before we get here?
            this.wsServer!.handleUpgrade(req, incomingSocket, head, (ws) => {
                (<InterceptedWebSocket> ws).upstreamSocket = upstreamSocket;
                this.wsServer!.emit('connection', ws);
            });
        });

        // If the upstream says no, we say no too.
        upstreamSocket.on('unexpected-response', (req, res) => {
            console.log(`Unexpected websocket response from ${wsUrl}: ${res.statusCode}`);
            mirrorRejection(incomingSocket, res);
        });

        // If there's some other error, we just kill the socket:
        upstreamSocket.on('error', (e) => {
            console.warn(e);
            incomingSocket.end();
        });

        incomingSocket.on('error', () => upstreamSocket.close(1011)); // Internal error
    }
}

// These two work equally well for HTTP requests as websockets, but it's
// useful to reexport there here for consistency.
export { CloseConnectionHandler, TimeoutHandler };

export const WsHandlerLookup = {
    'ws-passthrough': PassThroughWebSocketHandler,
    'close-connection': CloseConnectionHandler,
    'timeout': TimeoutHandler
}
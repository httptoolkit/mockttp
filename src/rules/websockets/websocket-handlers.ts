/**
 * @module MockWebsocketRule
 */

import * as _ from 'lodash';
import net = require('net');
import * as url from 'url';
import * as http from 'http';
import * as WebSocket from 'ws';
import { stripIndent } from 'common-tags';
import CacheableLookup from 'cacheable-lookup';

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
    ForwardingOptions,
    PassThroughLookupOptions
} from '../requests/request-handlers';
import { isHttp2 } from '../../util/request-utils';
import { streamToBuffer } from '../../util/buffer-utils';

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
    upstreamWebSocket: WebSocket;
}

function isOpen(socket: WebSocket) {
    return socket.readyState === WebSocket.OPEN;
}

// Based on ws's validation.js
function isValidStatusCode(code: number) {
    return ( // Standard code:
        code >= 1000 &&
        code <= 1014 &&
        code !== 1004 &&
        code !== 1005 &&
        code !== 1006
    ) || ( // Application-specific code:
        code >= 3000 && code <= 4999
    );
}

const INVALID_STATUS_REGEX = /Invalid WebSocket frame: invalid status code (\d+)/;

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
        if (isValidStatusCode(num)) {
            try {
                outSocket.close(num, reason);
            } catch (e) {
                console.warn(e);
                outSocket.close();
            }
        } else {
            outSocket.close();
        }
    });

    inSocket.on('ping', (data) => {
        if (isOpen(outSocket)) outSocket.ping(data, undefined, onPipeFailed('ping'))
    });

    inSocket.on('pong', (data) => {
        if (isOpen(outSocket)) outSocket.pong(data, undefined, onPipeFailed('pong'))
    });

    // If either socket has an general error (connection failure, but also could be invalid WS
    // frames) then we kill the raw connection upstream to simulate a generic connection error:
    inSocket.on('error', (err) => {
        console.log(`Error in proxied WebSocket:`, err);
        const rawOutSocket = outSocket as any;

        if (err.message.match(INVALID_STATUS_REGEX)) {
            const status = parseInt(INVALID_STATUS_REGEX.exec(err.message)![1]);

            // Simulate errors elsewhere by messing with ws internals. This may break things,
            // that's effectively on purpose: we're simulating the client going wrong:
            const buf = Buffer.allocUnsafe(2);
            buf.writeUInt16BE(status); // status comes from readUInt16BE, so always fits
            rawOutSocket._sender.doClose(buf, true, () => {
                rawOutSocket._socket.destroy();
            });
        } else {
            // Unknown error, just kill the connection with no explanation
            rawOutSocket._socket.destroy();
        }
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
    /**
     * The forwarding configuration for the passthrough rule.
     * This generally shouldn't be used explicitly unless you're
     * building rule data by hand. Instead, call `thenPassThrough`
     * to send data directly or `thenForwardTo` with options to
     * configure traffic forwarding.
     */
    forwarding?: ForwardingOptions,

    /**
     * A list of hostnames for which server certificate and TLS version errors
     * should be ignored (none, by default).
     */
    ignoreHostHttpsErrors?: string[];

    /**
     * Deprecated alias for ignoreHostHttpsErrors.
     * @deprecated
     */
    ignoreHostCertificateErrors?: string[];

    /**
     * Custom DNS options, to allow configuration of the resolver used
     * when forwarding requests upstream. Passing any option switches
     * from using node's default dns.lookup function to using the
     * cacheable-lookup module, which will cache responses.
     */
    lookupOptions?: PassThroughLookupOptions;
}

interface SerializedPassThroughWebSocketData {
    type: 'ws-passthrough';
    forwarding?: ForwardingOptions;
    ignoreHostCertificateErrors?: string[]; // Doesn't match option name, backward compat
    lookupOptions?: PassThroughLookupOptions;
}

export class PassThroughWebSocketHandler extends Serializable implements WebSocketHandler {
    readonly type = 'ws-passthrough';

    public readonly forwarding?: ForwardingOptions;
    public readonly ignoreHostHttpsErrors: string[] = [];

    private wsServer?: WebSocket.Server;

    // Same lookup configuration as normal request PassThroughHandler:
    public readonly lookupOptions: PassThroughLookupOptions | undefined;

    private _cacheableLookupInstance: CacheableLookup | undefined;
    private lookup() {
        if (!this.lookupOptions) return undefined;

        if (!this._cacheableLookupInstance) {
            this._cacheableLookupInstance = new CacheableLookup({
                maxTtl: this.lookupOptions.maxTtl,
                errorTtl: this.lookupOptions.errorTtl,
                // As little caching of "use the fallback server" as possible:
                fallbackDuration: 0
            });

            if (this.lookupOptions.servers) {
                this._cacheableLookupInstance.servers = this.lookupOptions.servers;
            }
        }

        return this._cacheableLookupInstance.lookup;
    }

    constructor(options: PassThroughWebSocketHandlerOptions = {}) {
        super();

        this.ignoreHostHttpsErrors = options.ignoreHostHttpsErrors ||
            options.ignoreHostCertificateErrors ||
            [];
        if (!Array.isArray(this.ignoreHostHttpsErrors)) {
            throw new Error("ignoreHostHttpsErrors must be an array");
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

        this.lookupOptions = options.lookupOptions;
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
            pipeWebSocket(ws, ws.upstreamWebSocket);
            pipeWebSocket(ws.upstreamWebSocket, ws);
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
        // don't try to initialize it in a browser when building rules initially.
        if (!this.wsServer) this.wsServer = new WebSocket.Server({ noServer: true });

        // Skip cert checks if the host or host+port are whitelisted
        const parsedUrl = url.parse(wsUrl);
        const checkServerCertificate = !_.includes(this.ignoreHostHttpsErrors, parsedUrl.hostname) &&
            !_.includes(this.ignoreHostHttpsErrors, parsedUrl.host);

        const upstreamWebSocket = new WebSocket(wsUrl, {
            rejectUnauthorized: checkServerCertificate,
            maxPayload: 0,
            lookup: this.lookup(),
            headers: _.omitBy(headers, (_v, headerName) =>
                headerName.toLowerCase().startsWith('sec-websocket') ||
                headerName.toLowerCase() === 'connection'
            ) as { [key: string]: string } // Simplify to string - doesn't matter though, only used by http module anyway
        } as WebSocket.ClientOptions);

        upstreamWebSocket.once('open', () => {
            // Presumably the below adds an error handler. But what about before we get here?
            this.wsServer!.handleUpgrade(req, incomingSocket, head, (ws) => {
                (<InterceptedWebSocket> ws).upstreamWebSocket = upstreamWebSocket;
                this.wsServer!.emit('connection', ws);
            });
        });

        // If the upstream says no, we say no too.
        upstreamWebSocket.on('unexpected-response', (req, res) => {
            console.log(`Unexpected websocket response from ${wsUrl}: ${res.statusCode}`);
            mirrorRejection(incomingSocket, res);
        });

        // If there's some other error, we just kill the socket:
        upstreamWebSocket.on('error', (e) => {
            console.warn(e);
            incomingSocket.end();
        });

        incomingSocket.on('error', () => upstreamWebSocket.close(1011)); // Internal error
    }

    serialize(): SerializedPassThroughWebSocketData {
        // By default, we assume data is transferrable as-is
        return {
            type: this.type,
            forwarding: this.forwarding,
            ignoreHostCertificateErrors: this.ignoreHostHttpsErrors,
            lookupOptions: this.lookupOptions
        };
    }

    static deserialize(data: SerializedPassThroughWebSocketData): any {
        // By default, we assume we just need to assign the right prototype
        return _.create(this.prototype, {
            ...data,
            ignoreHostHttpsErrors: data.ignoreHostCertificateErrors
        });
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
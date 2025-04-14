import * as _ from 'lodash';
import net = require('net');
import * as url from 'url';
import * as http from 'http';
import * as WebSocket from 'ws';

import {
    ClientServerChannel,
    deserializeBuffer,
    deserializeProxyConfig
} from "../../serialization/serialization";

import { Headers, OngoingRequest, RawHeaders } from "../../types";

import {
    CloseConnectionHandler,
    RequestHandlerOptions,
    ResetConnectionHandler,
    TimeoutHandler
} from '../requests/request-handlers';
import { getEffectivePort } from '../../util/url';
import { isHttp2 } from '../../util/request-utils';
import {
    findRawHeader,
    findRawHeaders,
    objectHeadersToRaw,
    pairFlatRawHeaders,
    rawHeadersToObjectPreservingCase
} from '../../util/header-utils';
import { streamToBuffer } from '../../util/buffer-utils';
import { MaybePromise } from '../../util/type-utils';

import { getAgent } from '../http-agents';
import { ProxySettingSource } from '../proxy-config';
import { assertParamDereferenced, RuleParameters } from '../rule-parameters';
import {
    getUpstreamTlsOptions,
    getClientRelativeHostname,
    getDnsLookupFunction,
    shouldUseStrictHttps,
    getTrustedCAs
} from '../passthrough-handling';

import {
    EchoWebSocketHandlerDefinition,
    ListenWebSocketHandlerDefinition,
    PassThroughWebSocketHandlerDefinition,
    PassThroughWebSocketHandlerOptions,
    RejectWebSocketHandlerDefinition,
    SerializedPassThroughWebSocketData,
    WebSocketHandlerDefinition,
    WsHandlerDefinitionLookup,
} from './websocket-handler-definitions';
import { resetOrDestroy } from '../../util/socket-util';

export interface WebSocketHandler extends WebSocketHandlerDefinition {
    handle(
        // The incoming upgrade request
        request: OngoingRequest & http.IncomingMessage,
        // The raw socket on which we'll be communicating
        socket: net.Socket,
        // Initial data received
        head: Buffer,
        // Other general handler options
        options: RequestHandlerOptions
    ): Promise<void>;
}

interface InterceptedWebSocketRequest extends http.IncomingMessage {
    upstreamWebSocketProtocol?: string | false;
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

    inSocket.on('message', (msg, isBinary) => {
        if (isOpen(outSocket)) {
            outSocket.send(msg, { binary: isBinary }, onPipeFailed('message'))
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
            const sender = rawOutSocket._sender;
            sender.sendFrame(sender.constructor.frame(buf, {
                fin: true,
                rsv1: false,
                opcode: 0x08,
                mask: true,
                readOnly: false
            }), () => {
                rawOutSocket._socket.destroy();
            });
        } else {
            // Unknown error, just kill the connection with no explanation
            rawOutSocket._socket.destroy();
        }
    });
}

function mirrorRejection(
    downstreamSocket: net.Socket,
    upstreamRejectionResponse: http.IncomingMessage,
    simulateConnectionErrors: boolean
) {
    return new Promise<void>((resolve) => {
        if (downstreamSocket.writable) {
            const { statusCode, statusMessage, rawHeaders } = upstreamRejectionResponse;

            downstreamSocket.write(
                rawResponse(statusCode || 500, statusMessage || 'Unknown error', pairFlatRawHeaders(rawHeaders))
            );

            upstreamRejectionResponse.pipe(downstreamSocket);
            upstreamRejectionResponse.on('end', resolve);
            upstreamRejectionResponse.on('error', (error) => {
                console.warn('Error receiving WebSocket upstream rejection response:', error);
                if (simulateConnectionErrors) {
                    resetOrDestroy(downstreamSocket);
                } else {
                    downstreamSocket.destroy();
                }
                resolve();
            });

            // The socket is being optimistically written to and then killed - we don't care
            // about any more errors occuring here.
            downstreamSocket.on('error', () => {
                resolve();
            });
        }
    }).catch(() => {});
}

const rawResponse = (
    statusCode: number,
    statusMessage: string,
    headers: RawHeaders = []
) =>
    `HTTP/1.1 ${statusCode} ${statusMessage}\r\n` +
    _.map(headers, ([key, value]) =>
        `${key}: ${value}`
    ).join('\r\n') +
    '\r\n\r\n';

export { PassThroughWebSocketHandlerOptions };

export class PassThroughWebSocketHandler extends PassThroughWebSocketHandlerDefinition {

    private wsServer?: WebSocket.Server;

    private initializeWsServer() {
        if (this.wsServer) return;

        this.wsServer = new WebSocket.Server({
            noServer: true,
            // Mirror subprotocols back to the client:
            handleProtocols(protocols, request: InterceptedWebSocketRequest) {
                return request.upstreamWebSocketProtocol
                    // If there's no upstream socket, default to mirroring the first protocol. This matches
                    // WS's default behaviour - we could be stricter, but it'd be a breaking change.
                    ?? protocols.values().next().value
                    ?? false; // If there were no protocols specific and this is called for some reason
            },
        });
        this.wsServer.on('connection', (ws: InterceptedWebSocket) => {
            pipeWebSocket(ws, ws.upstreamWebSocket);
            pipeWebSocket(ws.upstreamWebSocket, ws);
        });
    }

    private _trustedCACertificates: MaybePromise<Array<string> | undefined>;
    private async trustedCACertificates(): Promise<Array<string> | undefined> {
        if (!this.extraCACertificates.length) return undefined;

        if (!this._trustedCACertificates) {
            this._trustedCACertificates = getTrustedCAs(undefined, this.extraCACertificates);
        }

        return this._trustedCACertificates;
    }

    async handle(req: OngoingRequest, socket: net.Socket, head: Buffer, options: RequestHandlerOptions) {
        this.initializeWsServer();

        let { protocol, hostname, port, path } = url.parse(req.url!);
        const rawHeaders = req.rawHeaders;

        const reqMessage = req as unknown as http.IncomingMessage;
        const isH2Downstream = isHttp2(req);
        const hostHeaderName = isH2Downstream ? ':authority' : 'host';

        hostname = await getClientRelativeHostname(
            hostname,
            req.remoteIpAddress,
            getDnsLookupFunction(this.lookupOptions)
        );

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
            wsUrl = `${protocol!}//${hostname}${port ? ':' + port : ''}${path}`;

            // Optionally update the host header too:
            let hostHeader = findRawHeader(rawHeaders, hostHeaderName);
            if (!hostHeader) {
                // Should never happen really, but just in case:
                hostHeader = [hostHeaderName, hostname!];
                rawHeaders.unshift(hostHeader);
            };

            if (updateHostHeader === undefined || updateHostHeader === true) {
                // If updateHostHeader is true, or just not specified, match the new target
                hostHeader[1] = hostname + (port ? `:${port}` : '');
            } else if (updateHostHeader) {
                // If it's an explicit custom value, use that directly.
                hostHeader[1] = updateHostHeader;
            } // Otherwise: falsey means don't touch it.

            await this.connectUpstream(wsUrl, reqMessage, rawHeaders, socket, head, options);
        } else if (!hostname) { // No hostname in URL means transparent proxy, so use Host header
            const hostHeader = req.headers[hostHeaderName];
            [ hostname, port ] = hostHeader!.split(':');

            // __lastHopEncrypted is set in http-combo-server, for requests that have explicitly
            // CONNECTed upstream (which may then up/downgrade from the current encryption).
            if (socket.__lastHopEncrypted !== undefined) {
                protocol = socket.__lastHopEncrypted ? 'wss' : 'ws';
            } else {
                protocol = reqMessage.connection.encrypted ? 'wss' : 'ws';
            }

            const wsUrl = `${protocol}://${hostname}${port ? ':' + port : ''}${path}`;
            await this.connectUpstream(wsUrl, reqMessage, rawHeaders, socket, head, options);
        } else {
            // Connect directly according to the specified URL
            const wsUrl = `${
                protocol!.replace('http', 'ws')
            }//${hostname}${port ? ':' + port : ''}${path}`;

            await this.connectUpstream(wsUrl, reqMessage, rawHeaders, socket, head, options);
        }
    }

    private async connectUpstream(
        wsUrl: string,
        req: http.IncomingMessage,
        rawHeaders: RawHeaders,
        incomingSocket: net.Socket,
        head: Buffer,
        options: RequestHandlerOptions
    ) {
        const parsedUrl = url.parse(wsUrl);

        const effectivePort = getEffectivePort(parsedUrl);

        const strictHttpsChecks = shouldUseStrictHttps(
            parsedUrl.hostname!,
            effectivePort,
            this.ignoreHostHttpsErrors
        );

        // Use a client cert if it's listed for the host+port or whole hostname
        const hostWithPort = `${parsedUrl.hostname}:${effectivePort}`;
        const clientCert = this.clientCertificateHostMap[hostWithPort] ||
            this.clientCertificateHostMap[parsedUrl.hostname!] ||
            {};

        const trustedCerts = await this.trustedCACertificates();
        const caConfig = trustedCerts
            ? { ca: trustedCerts }
            : {};

        const proxySettingSource = assertParamDereferenced(this.proxyConfig) as ProxySettingSource;

        const agent = await getAgent({
            protocol: parsedUrl.protocol as 'ws:' | 'wss:',
            hostname: parsedUrl.hostname!,
            port: effectivePort,
            proxySettingSource,
            tryHttp2: false, // We don't support websockets over H2 yet
            keepAlive: false // Not a thing for websockets: they take over the whole connection
        });

        // We have to flatten the headers, as WS doesn't support raw headers - it builds its own
        // header object internally.
        const headers = rawHeadersToObjectPreservingCase(rawHeaders);

        // Subprotocols have to be handled explicitly. WS takes control of the headers itself,
        // and checks the response, so we need to parse the client headers and use them manually:
        const originalSubprotocols = findRawHeaders(rawHeaders, 'sec-websocket-protocol')
            .flatMap(([_k, value]) => value.split(',').map(p => p.trim()));

        // Drop empty subprotocols, to better handle mildly badly behaved clients
        const filteredSubprotocols = originalSubprotocols.filter(p => !!p);

        // If the subprotocols are invalid (there are some empty strings, or an entirely empty value) then
        // WS will reject the upgrade. With this, we reset the header to the 'equivalent' valid version, to
        // avoid unnecessarily rejecting clients who send mildly wrong headers (empty protocol values).
        if (originalSubprotocols.length !== filteredSubprotocols.length) {
            if (filteredSubprotocols.length) {
                 // Note that req.headers is auto-lowercased by Node, so we can ignore case
                req.headers['sec-websocket-protocol'] = filteredSubprotocols.join(',')
            } else {
                delete req.headers['sec-websocket-protocol'];
            }
        }

        const upstreamWebSocket = new WebSocket(wsUrl, filteredSubprotocols, {
            maxPayload: 0,
            agent,
            lookup: getDnsLookupFunction(this.lookupOptions),
            headers: _.omitBy(headers, (_v, headerName) =>
                headerName.toLowerCase().startsWith('sec-websocket') ||
                headerName.toLowerCase() === 'connection' ||
                headerName.toLowerCase() === 'upgrade'
            ) as { [key: string]: string }, // Simplify to string - doesn't matter though, only used by http module anyway

            // TLS options:
            ...getUpstreamTlsOptions(strictHttpsChecks),
            ...clientCert,
            ...caConfig
        } as WebSocket.ClientOptions & { lookup: any, maxPayload: number });

        if (options.emitEventCallback) {
            const upstreamReq = (upstreamWebSocket as any as { _req: http.ClientRequest })._req;
            // This is slower than req.getHeaders(), but gives us (roughly) the correct casing
            // of the headers as sent. Still not perfect (loses dupe ordering) but at least it
            // generally matches what's actually sent on the wire.
            const rawHeaders = upstreamReq.getRawHeaderNames().map((headerName) => {
                const value = upstreamReq.getHeader(headerName);
                if (!value) return [];
                if (Array.isArray(value)) {
                    return value.map(v => [headerName, v]);
                } else {
                    return [[headerName, value.toString()]];
                }
            }).flat() as RawHeaders;

            options.emitEventCallback('passthrough-websocket-connect', {
                method: upstreamReq.method,
                protocol: upstreamReq.protocol
                    .replace(/:$/, '')
                    .replace(/^http/, 'ws'),
                hostname: upstreamReq.host,
                port: effectivePort.toString(),
                path: upstreamReq.path,
                rawHeaders: rawHeaders,
                subprotocols: filteredSubprotocols
            });
        }

        upstreamWebSocket.once('open', () => {
            // Used in the subprotocol selection handler during the upgrade:
            (req as InterceptedWebSocketRequest).upstreamWebSocketProtocol = upstreamWebSocket.protocol || false;

            this.wsServer!.handleUpgrade(req, incomingSocket, head, (ws) => {
                (<InterceptedWebSocket> ws).upstreamWebSocket = upstreamWebSocket;
                incomingSocket.emit('ws-upgrade', ws);
                this.wsServer!.emit('connection', ws); // This pipes the connections together
            });
        });

        // If the upstream says no, we say no too.
        let unexpectedResponse = false;
        upstreamWebSocket.on('unexpected-response', (req, res) => {
            console.log(`Unexpected websocket response from ${wsUrl}: ${res.statusCode}`);

            // Clean up the downstream connection
            mirrorRejection(incomingSocket, res, this.simulateConnectionErrors).then(() => {
                // Clean up the upstream connection (WS would do this automatically, but doesn't if you listen to this event)
                // See https://github.com/websockets/ws/blob/45e17acea791d865df6b255a55182e9c42e5877a/lib/websocket.js#L1050
                // We don't match that perfectly, but this should be effectively equivalent:
                req.destroy();
                if (res.socket?.destroyed === false) {
                    res.socket.destroy();
                }
                unexpectedResponse = true; // So that we ignore this in the error handler
                upstreamWebSocket.terminate();
            });
        });

        // If there's some other error, we just kill the socket:
        upstreamWebSocket.on('error', (e) => {
            if (unexpectedResponse) return; // Handled separately above

            console.warn(e);
            if (this.simulateConnectionErrors) {
                resetOrDestroy(incomingSocket);
            } else {
                incomingSocket.end();
            }
        });

        incomingSocket.on('error', () => upstreamWebSocket.close(1011)); // Internal error
    }

    /**
     * @internal
     */
    static deserialize(
        data: SerializedPassThroughWebSocketData,
        channel: ClientServerChannel,
        ruleParams: RuleParameters
    ): any {
        // By default, we assume we just need to assign the right prototype
        return _.create(this.prototype, {
            ...data,
            proxyConfig: deserializeProxyConfig(data.proxyConfig, channel, ruleParams),
            simulateConnectionErrors: data.simulateConnectionErrors ?? false,
            extraCACertificates: data.extraCACertificates || [],
            ignoreHostHttpsErrors: data.ignoreHostCertificateErrors,
            clientCertificateHostMap: _.mapValues(data.clientCertificateHostMap,
                ({ pfx, passphrase }) => ({ pfx: deserializeBuffer(pfx), passphrase })
            ),
        });
    }
}

export class EchoWebSocketHandler extends EchoWebSocketHandlerDefinition {

    private wsServer?: WebSocket.Server;

    private initializeWsServer() {
        if (this.wsServer) return;

        this.wsServer = new WebSocket.Server({ noServer: true });
        this.wsServer.on('connection', (ws: WebSocket) => {
            pipeWebSocket(ws, ws);
        });
    }

    async handle(req: OngoingRequest & http.IncomingMessage, socket: net.Socket, head: Buffer) {
        this.initializeWsServer();

        this.wsServer!.handleUpgrade(req, socket, head, (ws) => {
            socket.emit('ws-upgrade', ws);
            this.wsServer!.emit('connection', ws);
        });
    }
}

export class ListenWebSocketHandler extends ListenWebSocketHandlerDefinition {

    private wsServer?: WebSocket.Server;

    private initializeWsServer() {
        if (this.wsServer) return;

        this.wsServer = new WebSocket.Server({ noServer: true });
        this.wsServer.on('connection', (ws: WebSocket) => {
            // Accept but ignore the incoming websocket data
            ws.resume();
        });
    }

    async handle(req: OngoingRequest & http.IncomingMessage, socket: net.Socket, head: Buffer) {
        this.initializeWsServer();

        this.wsServer!.handleUpgrade(req, socket, head, (ws) => {
            socket.emit('ws-upgrade', ws);
            this.wsServer!.emit('connection', ws);
        });
    }
}

export class RejectWebSocketHandler extends RejectWebSocketHandlerDefinition {

    async handle(req: OngoingRequest, socket: net.Socket, head: Buffer) {
        socket.write(rawResponse(this.statusCode, this.statusMessage, objectHeadersToRaw(this.headers)));
        if (this.body) socket.write(this.body);
        socket.write('\r\n');
        socket.destroy();
    }

}

// These three work equally well for HTTP requests as websockets, but it's
// useful to reexport there here for consistency.
export {
    CloseConnectionHandler,
    ResetConnectionHandler,
    TimeoutHandler
};

export const WsHandlerLookup: typeof WsHandlerDefinitionLookup = {
    'ws-passthrough': PassThroughWebSocketHandler,
    'ws-echo': EchoWebSocketHandler,
    'ws-listen': ListenWebSocketHandler,
    'ws-reject': RejectWebSocketHandler,
    'close-connection': CloseConnectionHandler,
    'reset-connection': ResetConnectionHandler,
    'timeout': TimeoutHandler
};

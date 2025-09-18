import { Buffer } from 'buffer';
import * as net from 'net';
import * as url from 'url';
import * as http from 'http';

import * as _ from 'lodash';
import * as WebSocket from 'ws';

import {
    ClientServerChannel,
    deserializeBuffer,
    deserializeProxyConfig
} from '../../serialization/serialization';
import {
    MockttpDeserializationOptions
} from '../rule-deserialization'

import { Destination, OngoingRequest, RawHeaders } from "../../types";

import {
    RequestStepOptions,
    CloseConnectionStepImpl,
    DelayStepImpl,
    ResetConnectionStepImpl,
    TimeoutStepImpl
} from '../requests/request-step-impls';
import { getDefaultPort, getEffectivePort } from '../../util/url';
import { resetOrDestroy } from '../../util/socket-util';
import { isHttp2 } from '../../util/request-utils';
import {
    findRawHeaders,
    objectHeadersToRaw,
    pairFlatRawHeaders,
    rawHeadersToObjectPreservingCase
} from '../../util/header-utils';
import { MaybePromise } from '@httptoolkit/util';

import { getAgent } from '../http-agents';
import { ProxySettingSource } from '../proxy-config';
import { assertParamDereferenced } from '../rule-parameters';
import {
    getUpstreamTlsOptions,
    getClientRelativeHostname,
    getDnsLookupFunction,
    getTrustedCAs,
    getEffectiveHostname,
    applyDestinationTransforms
} from '../passthrough-handling';

import {
    EchoWebSocketStep,
    ListenWebSocketStep,
    PassThroughWebSocketStep,
    PassThroughWebSocketStepOptions,
    RejectWebSocketStep,
    SerializedPassThroughWebSocketData,
    WebSocketRequestTransform,
    WebSocketStepDefinition,
    WsStepDefinitionLookup,
} from './websocket-step-definitions';
import { deserializeMatchReplaceConfiguration } from '../match-replace';

export interface WebSocketStepImpl extends WebSocketStepDefinition {
    handle(
        // The incoming upgrade request
        request: OngoingRequest & http.IncomingMessage,
        // The raw socket on which we'll be communicating
        socket: net.Socket,
        // Initial data received
        head: Buffer,
        // Other general step options
        options: RequestStepOptions
    ): Promise<
        | undefined // Implicitly finished - equivalent to { continue: false }
        | { continue: boolean } // Should the request continue to later steps?
    >;
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

export { PassThroughWebSocketStepOptions };

export class PassThroughWebSocketStepImpl extends PassThroughWebSocketStep {

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

    async handle(req: OngoingRequest, socket: net.Socket, head: Buffer, options: RequestStepOptions) {
        this.initializeWsServer();

        let reqUrl = req.url!;
        let { protocol, pathname, search: query } = url.parse(reqUrl);
        let rawHeaders = req.rawHeaders;

        // Actual IP address or hostname
        let hostAddress = req.destination.hostname;
        // Same as hostAddress, unless it's an IP, in which case it's our best guess of the
        // functional 'name' for the host (from Host header or SNI).
        let hostname: string = getEffectiveHostname(hostAddress, socket, rawHeaders);
        let port: string | null = req.destination.port.toString();

        const reqMessage = req as unknown as http.IncomingMessage;
        const isH2Downstream = isHttp2(req);

        hostAddress = await getClientRelativeHostname(
            hostAddress,
            req.remoteIpAddress,
            getDnsLookupFunction(this.lookupOptions)
        );

        if (this.transformRequest) {
            const originalHostname = hostname;

            ({ protocol, hostname, port, reqUrl, rawHeaders } = applyDestinationTransforms(this.transformRequest, {
                 isH2Downstream,
                 rawHeaders,
                 port,
                 protocol,
                 hostname,
                 pathname,
                 query
            }));

            // If you modify the hostname, we also treat that as modifying the
            // resulting destination in turn:
            if (hostname !== originalHostname) {
                hostAddress = hostname;
            }
        }

        const destination = {
            hostname: hostAddress,
            port: port
                ? parseInt(port, 10)
                : getDefaultPort(protocol ?? 'http')
        };

        await this.connectUpstream(destination, reqUrl, reqMessage, rawHeaders, socket, head, options);
    }

    private async connectUpstream(
        destination: Destination,
        wsUrl: string,
        req: http.IncomingMessage,
        rawHeaders: RawHeaders,
        incomingSocket: net.Socket,
        head: Buffer,
        options: RequestStepOptions
    ) {
        const parsedUrl = url.parse(wsUrl);

        const effectiveHostname = parsedUrl.hostname!; // N.b. not necessarily the same as destination
        const effectivePort = getEffectivePort(parsedUrl);

        const trustedCAs = await this.trustedCACertificates();

        const proxySettingSource = assertParamDereferenced(this.proxyConfig) as ProxySettingSource;

        const agent = await getAgent({
            protocol: parsedUrl.protocol as 'ws:' | 'wss:',
            hostname: effectiveHostname,
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
            host: destination.hostname,
            port: destination.port,

            maxPayload: 0,
            agent,
            lookup: getDnsLookupFunction(this.lookupOptions),
            headers: _.omitBy(headers, (_v, headerName) =>
                headerName.toLowerCase().startsWith('sec-websocket') ||
                headerName.toLowerCase() === 'connection' ||
                headerName.toLowerCase() === 'upgrade'
            ) as { [key: string]: string }, // Simplify to string - doesn't matter though, only used by http module anyway

            // TLS options:
            ...getUpstreamTlsOptions({
                hostname: effectiveHostname,
                port: effectivePort,
                ignoreHostHttpsErrors: this.ignoreHostHttpsErrors,
                clientCertificateHostMap: this.clientCertificateHostMap,
                trustedCAs,
            })
        } as WebSocket.ClientOptions & { lookup: any, maxPayload: number });

        const upstreamReq = (upstreamWebSocket as any as { _req: http.ClientRequest })._req;

        if (options.emitEventCallback) {
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

            // This effectively matches the URL preprocessing logic in MockttpServer.preprocessRequest,
            // so that the resulting event matches the req.url property elsewhere.
            const urlHost = getEffectiveHostname(upstreamReq.host, req.socket, rawHeaders);

            options.emitEventCallback('passthrough-websocket-connect', {
                method: upstreamReq.method,
                protocol: upstreamReq.protocol
                    .replace(/:$/, '')
                    .replace(/^http/, 'ws'),
                hostname: urlHost,
                port: effectivePort.toString(),
                path: upstreamReq.path,
                rawHeaders: rawHeaders,
                subprotocols: filteredSubprotocols
            });
        }

        if (options.keyLogStream) {
            upstreamReq.on('socket', (socket) => {
                socket.on('keylog', (line) => options.keyLogStream!.write(line));
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
        { ruleParams }: MockttpDeserializationOptions
    ): any {
        // Backward compat for old clients:
        if (data.forwarding && !data.transformRequest?.replaceHost) {
            const [targetHost, setProtocol] = data.forwarding.targetHost.split('://').reverse();
            data.transformRequest ??= {};
            data.transformRequest.replaceHost = {
                targetHost,
                updateHostHeader: data.forwarding.updateHostHeader ?? true
            };
            data.transformRequest.setProtocol = setProtocol as 'ws' | 'wss' | undefined;
        }

        return _.create(this.prototype, {
            ...data,
            proxyConfig: deserializeProxyConfig(data.proxyConfig, channel, ruleParams),
            simulateConnectionErrors: data.simulateConnectionErrors ?? false,
            extraCACertificates: data.extraCACertificates || [],
            ignoreHostHttpsErrors: data.ignoreHostCertificateErrors,
            clientCertificateHostMap: _.mapValues(data.clientCertificateHostMap,
                ({ pfx, passphrase }) => ({ pfx: deserializeBuffer(pfx), passphrase })
            ),
            transformRequest: data.transformRequest ? {
                ...data.transformRequest,
                ...(data.transformRequest?.matchReplaceHost !== undefined ? {
                    matchReplaceHost: {
                        ...data.transformRequest.matchReplaceHost,
                        replacements: deserializeMatchReplaceConfiguration(data.transformRequest.matchReplaceHost.replacements)
                    }
                } : {}),
                ...(data.transformRequest?.matchReplacePath !== undefined ? {
                    matchReplacePath: deserializeMatchReplaceConfiguration(data.transformRequest.matchReplacePath)
                } : {}),
                ...(data.transformRequest?.matchReplaceQuery !== undefined ? {
                    matchReplaceQuery: deserializeMatchReplaceConfiguration(data.transformRequest.matchReplaceQuery)
                } : {}),
            } as WebSocketRequestTransform : undefined
        });
    }
}

export class EchoWebSocketStepImpl extends EchoWebSocketStep {

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

export class ListenWebSocketStepImpl extends ListenWebSocketStep {

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

export class RejectWebSocketStepImpl extends RejectWebSocketStep {

    async handle(req: OngoingRequest, socket: net.Socket) {
        socket.write(rawResponse(this.statusCode, this.statusMessage, objectHeadersToRaw(this.headers)));
        if (this.body) socket.end(this.body);
        socket.destroy();
    }

}

// These three work equally well for HTTP requests as websockets, but it's
// useful to reexport there here for consistency.
export {
    CloseConnectionStepImpl,
    ResetConnectionStepImpl,
    TimeoutStepImpl,
    DelayStepImpl
};

export const WsStepLookup: typeof WsStepDefinitionLookup = {
    'ws-passthrough': PassThroughWebSocketStepImpl,
    'ws-echo': EchoWebSocketStepImpl,
    'ws-listen': ListenWebSocketStepImpl,
    'ws-reject': RejectWebSocketStepImpl,
    'close-connection': CloseConnectionStepImpl,
    'reset-connection': ResetConnectionStepImpl,
    'timeout': TimeoutStepImpl,
    'delay': DelayStepImpl
};

import { Buffer } from 'buffer';
import * as net from 'net';
import * as url from 'url';
import * as http from 'http';
import * as https from 'https';
import { Duplex } from 'stream';

import * as _ from 'lodash';
import * as WebSocket from 'ws';

// These were internal ws modules before 8.20.0, now officially exported.
// @types/ws doesn't include types for these yet, so we type them manually:
const { PerMessageDeflate, extension: wsExtension } = WebSocket as any as {
    PerMessageDeflate: {
        extensionName: string;
        new(options?: object, isServer?: boolean, maxPayload?: number): {
            accept(offers: object[]): void;
            params: object | null;
        };
    };
    extension: {
        parse(header: string): Record<string, object[]>;
        format(extensions: Record<string, object[]>): string;
    };
};

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
    TimeoutStepImpl,
    WaitForRequestBodyStepImpl
} from '../requests/request-step-impls';
import { getDefaultPort, getEffectivePort } from '../../util/url';
import { resetOrDestroy } from '../../util/socket-util';
import { isHttp2 } from '../../util/request-utils';
import {
    findRawHeaders,
    flattenPairedRawHeaders,
    objectHeadersToRaw,
    pairFlatRawHeaders
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

/**
 * Create a client-mode WebSocket on an existing stream, bypassing the normal
 * HTTP handshake. This is used when we've already performed the upgrade
 * handshake ourselves via http.request. We do this with custom APIs so that
 * we can fully control the handshake and mirror exact configurations.
 */
function createWebSocketFromStream(
    socket: Duplex,
    head: Buffer,
    options: {
        maxPayload?: number;
        extensions?: Record<string, object>;
    } = {}
): WebSocket {
    const maxPayload = options.maxPayload ?? 0;

    const ws = new (WebSocket as any)(null, undefined, { maxPayload });
    ws._isServer = false; // Client mode: mask frames per RFC 6455

    if (options.extensions) {
        ws._extensions = options.extensions;
    }

    ws.setSocket(socket, head, {
        allowSynchronousEvents: true,
        maxPayload,
        skipUTF8Validation: true // Preserve even invalid weird stuff
    });

    return ws;
}

export { PassThroughWebSocketStepOptions };

export class PassThroughWebSocketStepImpl extends PassThroughWebSocketStep {

    private wsServer?: WebSocket.Server;

    private initializeWsServer() {
        if (this.wsServer) return;

        this.wsServer = new WebSocket.Server({
            noServer: true,
            perMessageDeflate: true,
            skipUTF8Validation: true // Preserve even invalid weird stuff
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

        // Strip any extension offers we can't handle (i.e. anything other than
        // permessage-deflate) to prevent the upstream from accepting them and causing trouble:
        const extensionHeaderValues = findRawHeaders(rawHeaders, 'sec-websocket-extensions');
        if (extensionHeaderValues.length > 0) {
            try {
                const parsed = wsExtension.parse(
                    extensionHeaderValues.map(([_k, v]) => v).join(', ')
                );

                // This is very unlikely - approximately zero other extensions exist in any form.
                const hasUnsupported = Object.keys(parsed)
                    .some(name => name !== PerMessageDeflate.extensionName);
                if (hasUnsupported) {
                    rawHeaders = rawHeaders.filter(([key]) =>
                        key.toLowerCase() !== 'sec-websocket-extensions'
                    );
                    if (parsed[PerMessageDeflate.extensionName]) {
                        rawHeaders.push(['Sec-WebSocket-Extensions', wsExtension.format({
                            [PerMessageDeflate.extensionName]: parsed[PerMessageDeflate.extensionName]
                        })]);
                    }
                }
            } catch {
                // If we can't parse the client's offer, forward it as-is and let
                // the upstream handle/reject it:
            }
        }

        // Build the upstream request manually, mirroring the input as closely as possible:
        const isSecure = parsedUrl.protocol === 'wss:';
        const httpModule = isSecure ? https : http;

        const upstreamReqOptions: http.RequestOptions & https.RequestOptions = {
            hostname: destination.hostname,
            port: destination.port,
            path: parsedUrl.path,
            headers: flattenPairedRawHeaders(rawHeaders),
            setDefaultHeaders: false, // No auto-headers - we exactly mirror the client
            method: req.method!,
            agent,
            lookup: getDnsLookupFunction(this.lookupOptions) as any,
            ...(isSecure ? getUpstreamTlsOptions({
                hostname: effectiveHostname,
                port: effectivePort,
                ignoreHostHttpsErrors: this.ignoreHostHttpsErrors,
                clientCertificateHostMap: this.clientCertificateHostMap,
                trustedCAs,
            }) : {})
        };

        const upstreamReq = httpModule.request(upstreamReqOptions);

        // Track the upstream WebSocket so the incomingSocket error handler can close it:
        let upstreamWebSocket: WebSocket | undefined;

        if (options.emitEventCallback) {
            // This effectively matches the URL preprocessing logic in MockttpServer.preprocessRequest,
            // so that the resulting event matches the req.url property elsewhere.
            const urlHost = getEffectiveHostname(effectiveHostname, req.socket, rawHeaders);

            const wsProtocol = parsedUrl.protocol!.replace(/^http/, 'ws').replace(/:$/, '');

            const subprotocols = findRawHeaders(rawHeaders, 'sec-websocket-protocol')
                .flatMap(([_k, v]) => v.split(',').map(s => s.trim()).filter(s => !!s));

            options.emitEventCallback('passthrough-websocket-connect', {
                method: req.method!,
                protocol: wsProtocol,
                hostname: urlHost,
                port: effectivePort.toString(),
                path: parsedUrl.path || '/',
                rawHeaders,
                subprotocols
            });
        }

        if (options.keyLogStream) {
            upstreamReq.on('socket', (socket) => {
                socket.on('keylog', (line: Buffer) => options.keyLogStream!.write(line));
            });
        }

        upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upgradeHead) => {
            // Handle permessage-deflate extension negotiation. If the upstream server
            // committed to extensions we can't set up, we must kill the connection rather
            // than silently mishandling compressed frames:
            const responseExtensionHeader = upstreamRes.headers['sec-websocket-extensions'];

            let extensions: Record<string, object> | undefined;
            try {
                if (responseExtensionHeader) {
                    const parsed = wsExtension.parse(responseExtensionHeader);
                    if (parsed[PerMessageDeflate.extensionName]) {
                        const pmd = new PerMessageDeflate({}, false); // false = client mode
                        pmd.accept(parsed[PerMessageDeflate.extensionName]);
                        extensions = { [PerMessageDeflate.extensionName]: pmd };
                    }
                }
            } catch (e) {
                console.warn('Failed to negotiate WebSocket extensions:', e);
                upstreamSocket.destroy();
                incomingSocket.end();
                return;
            }

            upstreamWebSocket = createWebSocketFromStream(upstreamSocket, upgradeHead, {
                maxPayload: 0,
                extensions
            });

            // Set req.headers to match exactly what the upstream confirmed, so ws's
            // handleUpgrade negotiates the same values downstream without any issues
            // from malformed original headers:
            if (!extensions) {
                delete req.headers['sec-websocket-extensions'];
            }

            // For WS's sake, we simplify the subprotocol header to only the upstream-selected value so
            // that it can just accept as is, and ignore any other badly behaved client's headers.
            const serverProtocol = upstreamRes.headers['sec-websocket-protocol'];
            if (serverProtocol?.trim()) {
                req.headers['sec-websocket-protocol'] = serverProtocol;
            } else {
                delete req.headers['sec-websocket-protocol'];
            }

            this.wsServer!.handleUpgrade(req, incomingSocket, head, (ws) => {
                (<InterceptedWebSocket> ws).upstreamWebSocket = upstreamWebSocket!;
                incomingSocket.emit('ws-upgrade', ws);
                this.wsServer!.emit('connection', ws);
            });
        });

        upstreamReq.on('response', (upstreamRes) => {
            console.log(`Unexpected websocket response from ${wsUrl}: ${upstreamRes.statusCode}`);
            mirrorRejection(incomingSocket, upstreamRes, this.simulateConnectionErrors);
        });

        upstreamReq.on('error', (e) => {
            console.warn(e);
            if (this.simulateConnectionErrors) {
                resetOrDestroy(incomingSocket);
            } else {
                incomingSocket.end();
            }
        });

        incomingSocket.on('error', () => {
            if (upstreamWebSocket) {
                upstreamWebSocket.close(1011);
            } else {
                upstreamReq.destroy();
            }
        });

        upstreamReq.end();
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

        this.wsServer = new WebSocket.Server({
            noServer: true,
            perMessageDeflate: true,
            skipUTF8Validation: true // Preserve even invalid weird stuff
        });
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

        this.wsServer = new WebSocket.Server({
            noServer: true,
            perMessageDeflate: true,
            skipUTF8Validation: true // Accept even invalid weird stuff
        });
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
    'delay': DelayStepImpl,
    'wait-for-request-body': WaitForRequestBodyStepImpl
};

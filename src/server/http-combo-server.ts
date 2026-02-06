import _ = require('lodash');
import now = require('performance-now');
import { Writable } from 'stream';
import * as net from 'net';
import * as tls from 'tls';
import * as http from 'http';
import * as http2 from 'http2';

import * as semver from 'semver';
import { makeDestroyable, DestroyableServer } from 'destroyable-server';
import * as httpolyglot from '@httptoolkit/httpolyglot';
import { CustomError, delay, unreachableCheck } from '@httptoolkit/util';
import {
    calculateJa3FromFingerprintData,
    calculateJa4FromHelloData,
    NonTlsError,
    readTlsClientHello
} from 'read-tls-client-hello';
import { URLPattern } from "urlpattern-polyfill";

import { Destination, TlsHandshakeFailure } from '../types';
import { getCA } from '../util/certificates';
import { shouldPassThrough } from '../util/server-utils';
import { getDestination } from '../util/url';
import {
    getParentSocket,
    buildSocketTimingInfo,
    buildTlsSocketEventData,
    resetOrDestroy
} from '../util/socket-util';
import {
    SocketIsh,
    InitialRemoteAddress,
    InitialRemotePort,
    SocketTimingInfo,
    LastTunnelAddress,
    LastHopEncrypted,
    TlsMetadata,
    TlsSetupCompleted,
    SocketMetadata,
} from '../util/socket-extensions';
import { MockttpHttpsOptions } from '../mockttp';
import { buildSocksServer, SocksServerOptions, SocksTcpAddress } from './socks-server';
import { getSocketMetadataFromProxyAuth } from '../util/socket-metadata';

// Hardcore monkey-patching: force TLSSocket to link servername & remoteAddress to
// sockets as soon as they're available, without waiting for the handshake to fully
// complete, so we can easily access them if the handshake fails.
const originalSocketInit = (<any>tls.TLSSocket.prototype)._init;
(<any>tls.TLSSocket.prototype)._init = function () {
    originalSocketInit.apply(this, arguments);

    const tlsSocket: tls.TLSSocket = this;
    const { _handle } = tlsSocket;
    if (!_handle) return;

    const loadSNI = _handle.oncertcb;
    _handle.oncertcb = function (info: any) {
        tlsSocket.servername = info.servername;
        tlsSocket[InitialRemoteAddress] = tlsSocket.remoteAddress || // Normal case
            tlsSocket._parent?.remoteAddress || // For early failing sockets
            tlsSocket._handle?._parentWrap?.stream?.remoteAddress; // For HTTP/2 CONNECT
        tlsSocket[InitialRemotePort] = tlsSocket.remotePort ||
            tlsSocket._parent?.remotePort ||
            tlsSocket._handle?._parentWrap?.stream?.remotePort;

        return loadSNI?.apply(this, arguments as any);
    };
};

// Takes an established TLS socket, calls the error listener if it's silently closed
function ifTlsDropped(socket: tls.TLSSocket, errorCallback: () => void) {
    new Promise((resolve, reject) => {
        // If you send data, you trust the TLS connection
        socket.once('data', resolve);

        // If you silently close it very quicky, you probably don't trust us
        socket.once('error', reject);
        socket.once('close', reject);
        socket.once('end', reject);

        // Some clients open later-unused TLS connections for connection pools, preconnect, etc.
        // Even if these are shut later on, that doesn't mean they're are rejected connections.
        // To differentiate the two cases, we consider connections OK after waiting 10x longer
        // than the initial TLS handshake for an unhappy disconnection.
        const timing = socket[SocketTimingInfo];
        const tlsSetupDuration = timing
            ? timing.tlsConnectedTimestamp! - (timing.tunnelSetupTimestamp! || timing.initialSocketTimestamp)
            : 0;
        const maxTlsRejectionTime = !Object.is(tlsSetupDuration, NaN)
            ? Math.max(tlsSetupDuration * 10, 100) // Ensure a sensible minimum
            : 2000;

        delay(maxTlsRejectionTime).then(resolve);
    })
    .then(() => {
        // Mark the socket as having completed TLS setup - this ensures that future
        // errors fire as client errors, not TLS setup errors.
        socket[TlsSetupCompleted] = true;
    })
    .catch(() => {
        // If TLS setup was confirmed in any way, we know we don't have a TLS error.
        if (socket[TlsSetupCompleted]) return;

        // To get here, the socket must have connected & done the TLS handshake, but then
        // closed/ended without ever sending any data. We can fairly confidently assume
        // in that case that it's rejected our certificate.
        errorCallback();
    });
}

function getCauseFromError(error: Error & { code?: string }) {
    const cause = (
        /alert certificate/.test(error.message) ||
        /alert bad certificate/.test(error.message) ||
        error.code === 'ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE' ||
        /alert unknown ca/.test(error.message)
    )
        // The client explicitly told us it doesn't like the certificate
        ? 'cert-rejected'
    : /no shared cipher/.test(error.message)
        // The client refused to negotiate a cipher. Probably means it didn't like the
        // cert so refused to continue, but it could genuinely not have a shared cipher.
        ? 'no-shared-cipher'
    : (/ECONNRESET/.test(error.message) || error.code === 'ECONNRESET')
        // The client sent no TLS alert, it just hard RST'd the connection
        ? 'reset'
    : error.code === 'ERR_TLS_HANDSHAKE_TIMEOUT'
        ? 'handshake-timeout'
    : 'unknown'; // Something else.

    if (cause === 'unknown') console.log('Unknown TLS error:', error);

    return cause;
}

function buildTlsError(
    socket: tls.TLSSocket,
    cause: TlsHandshakeFailure['failureCause']
): TlsHandshakeFailure {
    const eventData = buildTlsSocketEventData(socket) as TlsHandshakeFailure;

    eventData.failureCause = cause;
    eventData.timingEvents.failureTimestamp = now();

    return eventData;
}

export interface ComboServerOptions {
    debug: boolean;
    https: MockttpHttpsOptions | undefined;
    http2: boolean | 'fallback';
    socks: boolean | SocksServerOptions;
    passthroughUnknownProtocols: boolean;
    keyLogStream: Writable | undefined,

    requestListener: (req: http.IncomingMessage, res: http.ServerResponse) => void;
    tlsClientErrorListener: (socket: tls.TLSSocket, req: TlsHandshakeFailure) => void;
    tlsPassthroughListener: (socket: net.Socket, hostname: string, port?: number) => void;
    rawPassthroughListener: (socket: net.Socket, hostname: string, port?: number) => void;
};

// The low-level server that handles all the sockets & TLS. The server will correctly call the
// given handler for both HTTP & HTTPS direct connections, or connections when used as an
// either HTTP or HTTPS proxy, all on the same port.
export async function createComboServer(options: ComboServerOptions): Promise<DestroyableServer<net.Server>> {
    let server: net.Server;
    let tlsServer: tls.Server | undefined = undefined;
    let socksServer: net.Server | undefined = undefined;
    let unknownProtocolServer: net.Server | undefined = undefined;

    if (options.https) {
        const ca = await getCA(options.https);
        const defaultCert = await ca.generateCertificate(options.https.defaultDomain ?? 'localhost');

        const serverProtocolPreferences = options.http2 === true
            ? ['h2', 'http/1.1', 'http 1.1'] // 'http 1.1' is non-standard, but used by https-proxy-agent
                : options.http2 === 'fallback'
            ? ['http/1.1', 'http 1.1', 'h2']
                : options.http2 === false
            ? ['http/1.1', 'http 1.1']
                : unreachableCheck(options.http2);

        const ALPNOption: tls.TlsOptions = semver.satisfies(process.version, '>=20.4.0')
            ? {
                // In modern Node (20+), ALPNProtocols will reject unknown protocols. To allow those (so we can
                // at least read the request, and hopefully handle HTTP-like cases - not uncommon) we use the new
                // ALPNCallback feature instead, which lets us dynamically accept unrecognized protocols:
                ALPNCallback: ({ protocols: clientProtocols }) => {
                    const preferredProtocol = serverProtocolPreferences.find(p => clientProtocols.includes(p));

                    // Wherever possible, we tell the client to use our preferred protocol
                    if (preferredProtocol) return preferredProtocol;

                    // If the client only offers protocols that we don't understand, shrug and accept:
                    else return clientProtocols[0];
                }
            } : {
                // In Node versions without ALPNCallback, we just set preferences directly:
                ALPNProtocols: serverProtocolPreferences
            }

        // Cache secure contexts by domain with expiry tracking, with 1h buffer
        const EXPIRY_BUFFER_MS = 60 * 60 * 1000;
        const secureContextCache = new Map<string, { context: tls.SecureContext, expiresAt: Date }>();

        const getSecureContext = async (domain: string): Promise<tls.SecureContext> => {
            const cached = secureContextCache.get(domain);
            const now = Date.now();

            if (cached && cached.expiresAt.getTime() - now > EXPIRY_BUFFER_MS) {
                return cached.context;
            }

            // Generate new cert (either not cached or expiring soon)
            const generatedCert = await ca.generateCertificate(domain);
            const context = tls.createSecureContext({
                key: generatedCert.key,
                cert: generatedCert.cert,
                ca: generatedCert.ca
            });
            secureContextCache.set(domain, { context, expiresAt: generatedCert.expiresAt });
            return context;
        };

        tlsServer = tls.createServer({
            key: defaultCert.key,
            cert: defaultCert.cert,
            ca: [defaultCert.ca],
            ...ALPNOption,
            ...(options.https?.tlsServerOptions || {}),
            SNICallback: async (domain: string, cb: Function) => {
                if (options.debug) console.log(`Generating certificate for ${domain}`);

                try {
                    cb(null, await getSecureContext(domain));
                } catch (e) {
                    console.error('Cert generation error', e);
                    cb(e);
                }
            }
        });

        if (options.keyLogStream) {
            tlsServer.on('keylog', (line: string) => {
                options.keyLogStream?.write(line);
            });
        }

        analyzeAndMaybePassThroughTls(
            tlsServer,
            options.https.tlsPassthrough,
            options.https.tlsInterceptOnly,
            options.tlsPassthroughListener
        );
    }

    if (options.socks) {
        socksServer = buildSocksServer(options.socks === true ? {} : options.socks);
        socksServer.on('socks-tcp-connect', (socket: net.Socket, address: SocksTcpAddress) => {
            const addressString =
                address.type === 'ipv4'
                    ? `${address.ip}:${address.port}`
                : address.type === 'ipv6'
                    ? `[${address.ip}]:${address.port}`
                : address.type === 'hostname'
                    ? `${address.hostname}:${address.port}`
                : unreachableCheck(address)

            if (options.debug) console.log(`Proxying SOCKS TCP connection to ${addressString}`);

            socket[SocketTimingInfo]!.tunnelSetupTimestamp = now();
            socket[LastTunnelAddress] = addressString;

            // Put the socket back into the server, so we can handle the data within:
            server.emit('connection', socket);
        });
    }

    if (options.passthroughUnknownProtocols) {
        unknownProtocolServer = net.createServer((socket) => {
            const tunnelAddress = socket[LastTunnelAddress];

            try {
                let error: Error | undefined;
                if (!tunnelAddress) {
                    error = new CustomError('Unknown protocol without destination', {
                        code: 'UNKNOWN_PROTOCOL_NO_DESTINATION'
                    });
                } else if (!tunnelAddress.includes(':')) {
                    // Both CONNECT & SOCKS require a port, so this shouldn't happen
                    error = new CustomError('Unknown protocol without destination port', {
                        code: 'UNKNOWN_PROTOCOL_NO_DESTINATION_PORT'
                    });
                }

                if (error) {
                    // Attach what data we have for debugging later:
                    (error as any).rawPacket = socket.read();
                    server.emit('clientError', error, socket);
                    return;
                }

                const { hostname, port } = getDestination('unknown', tunnelAddress!); // Has port, so no protocol required
                options.rawPassthroughListener(socket, hostname, port);
            } catch (e) {
                console.error('Unknown protocol server error', e);
                resetOrDestroy(socket);
            }
        });
    }

    server = httpolyglot.createServer({
        tls: tlsServer,
        socks: socksServer,
        unknownProtocol: unknownProtocolServer
    }, options.requestListener);

    // In Node v20, this option was added, rejecting all requests with no host header. While that's good, in
    // our case, we want to handle the garbage requests too, so we disable it:
    (server as any)._httpServer.requireHostHeader = false;

    server.on('connection', (socket: net.Socket | http2.ServerHttp2Stream) => {
        socket[SocketTimingInfo] ||= buildSocketTimingInfo();

        // All sockets are initially marked as using unencrypted upstream connections,
        // if not set elsewhere (TLS) or downgraded by intended hop (CONNECT):
        socket[LastHopEncrypted] ||= false;

        // For actual sockets, set NODELAY to avoid any buffering whilst streaming. This is
        // off by default in Node HTTP, but likely to be enabled soon & is default in curl.
        if ('setNoDelay' in socket) socket.setNoDelay(true);
    });

    server.on('secureConnection', (socket: tls.TLSSocket) => {
        const parentSocket = getParentSocket(socket);
        if (parentSocket) {
            // Sometimes wrapper TLS sockets created by the HTTP/2 server don't include the
            // underlying socket details, so it's better to make sure we copy them up.
            inheritSocketDetails(parentSocket, socket);
            // With TLS metadata, we only propagate directly from parent sockets, not through
            // CONNECT etc - we only want it if the final hop is TLS, previous values don't matter.
            socket[TlsMetadata] ??= parentSocket[TlsMetadata];
        } else if (!socket[SocketTimingInfo]) {
            socket[SocketTimingInfo] = buildSocketTimingInfo();
        }

        socket[SocketTimingInfo]!.tlsConnectedTimestamp = now();

        socket[LastHopEncrypted] = true;
        ifTlsDropped(socket, () => {
            options.tlsClientErrorListener(socket, buildTlsError(socket, 'closed'));
        });
    });

    // Mark HTTP/2 sockets as set up once we receive a first settings frame. This always
    // happens immediately after the connection preface, as long as the connection is OK.
    server!.on('session', (session) => {
        session.once('remoteSettings', () => {
            (session.socket as tls.TLSSocket)[TlsSetupCompleted] = true;
        });
    });

    server.on('tlsClientError', (error: Error, socket: tls.TLSSocket) => {
        options.tlsClientErrorListener(socket, buildTlsError(socket, getCauseFromError(error)));
    });

    // If the server receives a HTTP/HTTPS CONNECT request, Pretend to tunnel, then just re-handle:
    server.addListener('connect', function (
        req: http.IncomingMessage | http2.Http2ServerRequest,
        resOrSocket: net.Socket | http2.Http2ServerResponse
    ) {
        if (resOrSocket instanceof net.Socket) {
            handleH1Connect(req as http.IncomingMessage, resOrSocket);
        } else {
            handleH2Connect(req as http2.Http2ServerRequest, resOrSocket);
        }
    });

    function handleH1Connect(req: http.IncomingMessage, socket: net.Socket) {
        // Clients may disconnect at this point (for all sorts of reasons), but here
        // nothing else is listening, so we need to catch errors on the socket:
        socket.once('error', (e) => {
            if (options.debug) {
                console.log('Error on client socket', e);
            }
        });

        const connectUrl = req.url || req.headers['host'];
        if (!connectUrl) {
            // If we can't work out where to go, send an error.
            socket.write('HTTP/' + req.httpVersion + ' 400 Bad Request\r\n\r\n', 'utf-8');
            return;
        }

        if (options.debug) console.log(`Proxying HTTP/1 CONNECT to ${connectUrl}`);

        socket.write('HTTP/' + req.httpVersion + ' 200 OK\r\n\r\n', 'utf-8', () => {
            socket[SocketTimingInfo]!.tunnelSetupTimestamp = now();
            socket[LastTunnelAddress] = connectUrl;
            socket[LastHopEncrypted] = false; // Will be updated if TLS is added later
            if (req.headers['proxy-authorization']) {
                socket[SocketMetadata] = getSocketMetadataFromProxyAuth(socket, req.headers['proxy-authorization']);
            }
            server.emit('connection', socket);
        });
    }

    function handleH2Connect(req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) {
        const connectUrl = req.headers[':authority'];

        if (!connectUrl) {
             // If we can't work out where to go, send an error.
             res.writeHead(400, {});
             res.end();
             return;
        }

        if (options.debug) console.log(`Proxying HTTP/2 CONNECT to ${connectUrl}`);

        // Send a 200 OK response, and start the tunnel:
        res.writeHead(200, {});

        inheritSocketDetails(res.socket, res.stream);

        res.stream[LastHopEncrypted] = false; // Will be updated if TLS is added later
        res.stream[LastTunnelAddress] = connectUrl;
        if (req.headers['proxy-authorization']) {
            res.stream[SocketMetadata] = getSocketMetadataFromProxyAuth(res.stream, req.headers['proxy-authorization']);
        }

        // When layering HTTP/2 on JS streams, we have to make sure the JS stream won't autoclose
        // when the other side does, because the upper HTTP/2 layers want to handle shutdown, so
        // they end up trying to write a GOAWAY at the same time as the lower stream shuts down,
        // and we get assertion errors in Node v16.7+.
        if (res.socket.constructor.name.includes('JSStreamSocket')) {
            res.socket.allowHalfOpen = true;
        }

        server.emit('connection', res.stream);
    }

    return makeDestroyable(server);
}


const SOCKET_METADATA = [
    'localAddress',
    'localPort',
    'remoteAddress',
    'remotePort',
    SocketTimingInfo,
    SocketMetadata,
    LastTunnelAddress
] as const;

function inheritSocketDetails(
    source: SocketIsh<typeof SOCKET_METADATA[number]>,
    target: SocketIsh<typeof SOCKET_METADATA[number]>
) {
    // Update the target socket(-ish) with the assorted metadata from the source socket,
    // iff the target has no details of its own.

    // Make sure all properties are writable - HTTP/2 streams notably try to block this.
    Object.defineProperties(target, _.zipObject(
        SOCKET_METADATA,
        _.range(SOCKET_METADATA.length).map(() => ({ writable: true }))
    ) as PropertyDescriptorMap);

    for (let fieldName of SOCKET_METADATA) {
        if (target[fieldName] === undefined) {
            if (typeof source[fieldName] === 'object') {
                (target as any)[fieldName] = _.cloneDeep(source[fieldName]);
            } else {
                (target as any)[fieldName] = source[fieldName];
            }
        }
    }
}

/**
 * Takes tls passthrough configuration (may be empty) and reconfigures a given TLS server so that all
 * client hellos are parsed, matching requests are passed to the given passthrough listener (without
 * continuing setup) and client hello metadata is attached to all sockets.
 */
function analyzeAndMaybePassThroughTls(
    server: tls.Server,
    passthroughList: Required<MockttpHttpsOptions>['tlsPassthrough'] | undefined,
    interceptOnlyList: Required<MockttpHttpsOptions>['tlsInterceptOnly'] | undefined,
    passthroughListener: (socket: net.Socket, hostname: string, port?: number) => void
) {
    if (passthroughList && interceptOnlyList){
        throw new Error('Cannot use both tlsPassthrough and tlsInterceptOnly options at the same time.');
    }
    const passThroughPatterns = passthroughList?.map(({ hostname }) => new URLPattern(`https://${hostname}`)) ?? [];
    const interceptOnlyPatterns = interceptOnlyList?.map(({ hostname }) => new URLPattern(`https://${hostname}`));

    const tlsConnectionListener = server.listeners('connection')[0] as (socket: net.Socket) => {};
    server.removeListener('connection', tlsConnectionListener);
    server.on('connection', async (socket: net.Socket) => {
        try {
            const helloData = await readTlsClientHello(socket);

            const sniHostname = helloData.serverName;

            // SNI is a good clue for where the request is headed, but an explicit proxy address (via
            // CONNECT or SOCKS) is even better. Note that this may be a hostname or IPv4/6 address:
            let upstreamDestination: Destination | undefined;
            if (socket[LastTunnelAddress]) {
                upstreamDestination = getDestination('https', socket[LastTunnelAddress]);
            }

            socket[TlsMetadata] = {
                sniHostname,
                clientAlpn: helloData.alpnProtocols,
                ja3Fingerprint: calculateJa3FromFingerprintData(helloData.fingerprintData),
                ja4Fingerprint: calculateJa4FromHelloData(helloData)
            };

            if (shouldPassThrough(upstreamDestination?.hostname, passThroughPatterns, interceptOnlyPatterns)) {
                passthroughListener(socket, upstreamDestination.hostname, upstreamDestination.port);
                return; // Do not continue with TLS
            } else if (shouldPassThrough(sniHostname, passThroughPatterns, interceptOnlyPatterns)) {
                passthroughListener(socket, sniHostname!); // Can't guess the port - not included in SNI
                return; // Do not continue with TLS
            }
        } catch (e) {
            if (!(e instanceof NonTlsError)) { // Don't even warn for non-TLS traffic
                console.warn(`TLS client hello data not available for TLS connection from ${
                    socket.remoteAddress ?? 'unknown address'
                }: ${(e as Error).message ?? e}`);
            }
        }

        // Didn't match a passthrough hostname - continue with TLS setup
        tlsConnectionListener.call(server, socket);
    });
}

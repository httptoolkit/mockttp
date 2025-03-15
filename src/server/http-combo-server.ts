import _ = require('lodash');
import now = require('performance-now');
import net = require('net');
import tls = require('tls');
import http = require('http');
import http2 = require('http2');
import * as streams from 'stream';

import * as semver from 'semver';
import { makeDestroyable, DestroyableServer } from 'destroyable-server';
import httpolyglot = require('@httptoolkit/httpolyglot');
import {
    calculateJa3FromFingerprintData,
    calculateJa4FromHelloData,
    NonTlsError,
    readTlsClientHello
} from 'read-tls-client-hello';
import { URLPattern } from "urlpattern-polyfill";

import { TlsHandshakeFailure } from '../types';
import { getCA } from '../util/tls';
import { delay } from '../util/util';
import { shouldPassThrough } from '../util/server-utils';
import {
    getParentSocket,
    buildSocketTimingInfo,
    buildSocketEventData
} from '../util/socket-util';
import { MockttpHttpsOptions } from '../mockttp';

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
        tlsSocket.initialRemoteAddress = tlsSocket.remoteAddress || // Normal case
            tlsSocket._parent?.remoteAddress || // For early failing sockets
            tlsSocket._handle?._parentWrap?.stream?.remoteAddress; // For HTTP/2 CONNECT
        tlsSocket.initialRemotePort = tlsSocket.remotePort ||
            tlsSocket._parent?.remotePort ||
            tlsSocket._handle?._parentWrap?.stream?.remotePort;

        return loadSNI?.apply(this, arguments as any);
    };
};

export type ComboServerOptions = {
    debug: boolean,
    https: MockttpHttpsOptions | undefined,
    http2: true | false | 'fallback'
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
        const timing = socket.__timingInfo;
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
        socket.tlsSetupCompleted = true;
    })
    .catch(() => {
        // If TLS setup was confirmed in any way, we know we don't have a TLS error.
        if (socket.tlsSetupCompleted) return;

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
    const eventData = buildSocketEventData(socket) as TlsHandshakeFailure;

    eventData.failureCause = cause;
    eventData.timingEvents.failureTimestamp = now();

    return eventData;
}

// The low-level server that handles all the sockets & TLS. The server will correctly call the
// given handler for both HTTP & HTTPS direct connections, or connections when used as an
// either HTTP or HTTPS proxy, all on the same port.
export async function createComboServer(
    options: ComboServerOptions,
    requestListener: (req: http.IncomingMessage, res: http.ServerResponse) => void,
    tlsClientErrorListener: (socket: tls.TLSSocket, req: TlsHandshakeFailure) => void,
    tlsPassthroughListener: (socket: net.Socket, address: string, port?: number) => void
): Promise<DestroyableServer<net.Server>> {
    let server: net.Server;
    if (!options.https) {
        server = httpolyglot.createServer(requestListener);
    } else {
        const ca = await getCA(options.https);
        const defaultCert = ca.generateCertificate(options.https.defaultDomain ?? 'localhost');

        const serverProtocolPreferences = options.http2 === true
            ? ['h2', 'http/1.1', 'http 1.1'] // 'http 1.1' is non-standard, but used by https-proxy-agent
                : options.http2 === 'fallback'
            ? ['http/1.1', 'http 1.1', 'h2']
                // options.http2 === false:
            : ['http/1.1', 'http 1.1'];

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
                    else return clientProtocols[1];
                }
            } : {
                // In Node versions without ALPNCallback, we just set preferences directly:
                ALPNProtocols: serverProtocolPreferences
            }

        const tlsServer = tls.createServer({
            key: defaultCert.key,
            cert: defaultCert.cert,
            ca: [defaultCert.ca],
            ...ALPNOption,
            ...(options.https?.tlsServerOptions || {}),
            SNICallback: (domain: string, cb: Function) => {
                if (options.debug) console.log(`Generating certificate for ${domain}`);

                try {
                    const generatedCert = ca.generateCertificate(domain);
                    cb(null, tls.createSecureContext({
                        key: generatedCert.key,
                        cert: generatedCert.cert,
                        ca: generatedCert.ca
                    }));
                } catch (e) {
                    console.error('Cert generation error', e);
                    cb(e);
                }
            }
        });

        analyzeAndMaybePassThroughTls(
            tlsServer,
            options.https.tlsPassthrough,
            options.https.tlsInterceptOnly,
            tlsPassthroughListener
        );

        server = httpolyglot.createServer(tlsServer, requestListener);
    }

    // In Node v20, this option was added, rejecting all requests with no host header. While that's good, in
    // our case, we want to handle the garbage requests too, so we disable it:
    (server as any)._httpServer.requireHostHeader = false;

    server.on('connection', (socket: net.Socket | http2.ServerHttp2Stream) => {
        socket.__timingInfo = socket.__timingInfo || buildSocketTimingInfo();

        // All sockets are initially marked as using unencrypted upstream connections.
        // If TLS is used, this is upgraded to 'true' by secureConnection below.
        socket.__lastHopEncrypted = false;

        // For actual sockets, set NODELAY to avoid any buffering whilst streaming. This is
        // off by default in Node HTTP, but likely to be enabled soon & is default in curl.
        if ('setNoDelay' in socket) socket.setNoDelay(true);
    });

    server.on('secureConnection', (socket: tls.TLSSocket) => {
        const parentSocket = getParentSocket(socket);
        if (parentSocket) {
            // Sometimes wrapper TLS sockets created by the HTTP/2 server don't include the
            // underlying socket details, so it's better to make sure we copy them up.
            copyAddressDetails(parentSocket, socket);
            copyTimingDetails(parentSocket, socket);
            // With TLS metadata, we only propagate directly from parent sockets, not through
            // CONNECT etc - we only want it if the final hop is TLS, previous values don't matter.
            socket.__tlsMetadata ??= parentSocket.__tlsMetadata;
        } else if (!socket.__timingInfo) {
            socket.__timingInfo = buildSocketTimingInfo();
        }

        socket.__timingInfo!.tlsConnectedTimestamp = now();

        socket.__lastHopEncrypted = true;
        ifTlsDropped(socket, () => {
            tlsClientErrorListener(socket, buildTlsError(socket, 'closed'));
        });
    });

    // Mark HTTP/2 sockets as set up once we receive a first settings frame. This always
    // happens immediately after the connection preface, as long as the connection is OK.
    server!.on('session', (session) => {
        session.once('remoteSettings', () => {
            session.socket.tlsSetupCompleted = true;
        });
    });

    server.on('tlsClientError', (error: Error, socket: tls.TLSSocket) => {
        tlsClientErrorListener(socket, buildTlsError(socket, getCauseFromError(error)));
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
            socket.__timingInfo!.tunnelSetupTimestamp = now();
            socket.__lastHopConnectAddress = connectUrl;
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
        copyAddressDetails(res.socket, res.stream);
        copyTimingDetails(res.socket, res.stream);
        res.stream.__lastHopConnectAddress = connectUrl;

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

type SocketIsh<MinProps extends keyof net.Socket> =
    streams.Duplex & Partial<Pick<net.Socket, MinProps>>;

const SOCKET_ADDRESS_METADATA_FIELDS = [
    'localAddress',
    'localPort',
    'remoteAddress',
    'remotePort',
    '__lastHopConnectAddress'
] as const;

// Update the target socket(-ish) with the address details from the source socket,
// iff the target has no details of its own.
function copyAddressDetails(
    source: SocketIsh<typeof SOCKET_ADDRESS_METADATA_FIELDS[number]>,
    target: SocketIsh<typeof SOCKET_ADDRESS_METADATA_FIELDS[number]>
) {
    Object.defineProperties(target, _.zipObject(
        SOCKET_ADDRESS_METADATA_FIELDS,
        _.range(SOCKET_ADDRESS_METADATA_FIELDS.length).map(() => ({ writable: true }))
    ) as PropertyDescriptorMap);

    SOCKET_ADDRESS_METADATA_FIELDS.forEach((fieldName) => {
        if (target[fieldName] === undefined) {
            (target as any)[fieldName] = source[fieldName];
        }
    });
}

function copyTimingDetails<T extends SocketIsh<'__timingInfo'>>(
    source: SocketIsh<'__timingInfo'>,
    target: T
): asserts target is T & { __timingInfo: Required<net.Socket>['__timingInfo'] } {
    if (!target.__timingInfo) {
        // Clone timing info, don't copy it - child sockets get their own independent timing stats
        target.__timingInfo = Object.assign({}, source.__timingInfo);
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
    passthroughListener: (socket: net.Socket, address: string, port?: number) => void
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

            const [connectHostname, connectPort] = socket.__lastHopConnectAddress?.split(':') ?? [];
            const sniHostname = helloData.serverName;

            socket.__tlsMetadata = {
                sniHostname,
                connectHostname,
                connectPort,
                clientAlpn: helloData.alpnProtocols,
                ja3Fingerprint: calculateJa3FromFingerprintData(helloData.fingerprintData),
                ja4Fingerprint: calculateJa4FromHelloData(helloData)
            };

            if (shouldPassThrough(connectHostname, passThroughPatterns, interceptOnlyPatterns)) {
                const upstreamPort = connectPort ? parseInt(connectPort, 10) : undefined;
                passthroughListener(socket, connectHostname, upstreamPort);
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

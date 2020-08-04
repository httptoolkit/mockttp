import _ = require('lodash');
import net = require('net');
import tls = require('tls');
import http = require('http');
import http2 = require('http2');
import * as streams from 'stream';
import SocketWrapper = require('_stream_wrap');
import httpolyglot = require('@httptoolkit/httpolyglot');

import { TlsRequest } from '../types';
import { destroyable, DestroyableServer } from '../util/destroyable-server';
import { getCA, CAOptions } from '../util/tls';
import { delay } from '../util/util';

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

        return loadSNI?.apply(this, arguments as any);
    };
};

export type ComboServerOptions = {
    debug: boolean,
    https: CAOptions | undefined,
    http2: true | false | 'fallback'
};

// Takes an established TLS socket, calls the error listener if it's silently closed
function ifTlsDropped(socket: tls.TLSSocket, errorCallback: () => void) {
    new Promise((resolve, reject) => {
        // If you send data, you trust the TLS connection
        socket.once('data', resolve);

        // If you silently close it very quicky, you probably don't trust us
        socket.once('close', reject);
        socket.once('end', reject);

        // Some clients open later-unused TLS connections for connection pools, preconnect, etc.
        // Even if these are shut later on, that doesn't mean they're are rejected connections.
        // To differentiate the two cases, we consider connections OK after waiting 10x longer
        // than the initial TLS handshake for an unhappy disconnection.
        const timing = socket.__timingInfo || {};
        const tlsSetupDuration = timing.tlsConnected! - (timing.tunnelSetup! || timing.initialSocket!);
        const maxTlsRejectionTime = (tlsSetupDuration !== NaN && tlsSetupDuration !== 0)
            ? tlsSetupDuration * 10
            : 5000;
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
    const cause = (/alert certificate/.test(error.message) || /alert unknown ca/.test(error.message))
        // The client explicitly told us it doesn't like the certificate
        ? 'cert-rejected'
    : /no shared cipher/.test(error.message)
        // The client refused to negotiate a cipher. Probably means it didn't like the
        // cert so refused to continue, but it could genuinely not have a shared cipher.
        ? 'no-shared-cipher'
    : (/ECONNRESET/.test(error.message) || error.code === 'ECONNRESET')
        // The client sent no TLS alert, it just hard RST'd the connection
        ? 'reset'
    : 'unknown'; // Something else.

    if (cause === 'unknown') console.log('Unknown TLS error:', error);

    return cause;
}

// The low-level server that handles all the sockets & TLS. The server will correctly call the
// given handler for both HTTP & HTTPS direct connections, or connections when used as an
// either HTTP or HTTPS proxy, all on the same port.
export async function createComboServer(
    options: ComboServerOptions,
    requestListener: (req: http.IncomingMessage, res: http.ServerResponse) => void,
    tlsClientErrorListener: (socket: tls.TLSSocket, req: TlsRequest) => void
): Promise<DestroyableServer> {
    let server: net.Server;
    if (!options.https) {
        server = httpolyglot.createServer(requestListener);
    } else {
        const ca = await getCA(options.https!);
        const defaultCert = ca.generateCertificate('localhost');

        server = httpolyglot.createServer({
            key: defaultCert.key,
            cert: defaultCert.cert,
            ca: [defaultCert.ca],
            ALPNProtocols: options.http2 === true
                ? ['h2', 'http/1.1']
                    : options.http2 === 'fallback'
                ? ['http/1.1', 'h2']
                    // false
                : ['http/1.1'],
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
        }, requestListener);
    }

    server.on('connection', (socket: net.Socket) => {
        socket.__timingInfo = socket.__timingInfo || { initialSocket: Date.now() };

        // All sockets are initially marked as using unencrypted upstream connections.
        // If TLS is used, this is upgraded to 'true' by secureConnection below.
        socket.lastHopEncrypted = false;
    });

    server.on('secureConnection', (socket: tls.TLSSocket) => {
        const parentSocket = getParentSocket(socket);
        if (parentSocket) {
            // Sometimes wrapper TLS sockets created by the HTTP/2 server don't include the
            // underlying socket details, so it's better to make sure we copy them up.
            copyAddressDetails(parentSocket, socket);
            copyTimingDetails(parentSocket, socket);
        } else if (!socket.__timingInfo) {
            socket.__timingInfo = { initialSocket: Date.now() };
        }

        socket.__timingInfo!.tlsConnected = Date.now();

        socket.lastHopEncrypted = true;
        ifTlsDropped(socket, () => {
            tlsClientErrorListener(socket, {
                failureCause: 'closed',
                hostname: socket.servername,
                remoteIpAddress: socket.remoteAddress || socket.initialRemoteAddress!,
                tags: []
            });
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
        // These only work because of oncertcb monkeypatch above
        tlsClientErrorListener(socket, {
            failureCause: getCauseFromError(error),
            hostname: socket.servername,
            remoteIpAddress: socket.remoteAddress || // Normal case
                socket._parent?.remoteAddress || // Pre-certCB error, e.g. timeout
                socket.initialRemoteAddress!, // Recorded by certCB monkeypatch
            tags: []
        });
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
        socket.once('error', (e) => console.log('Error on client socket', e));

        const connectUrl = req.url || req.headers['host'];
        if (!connectUrl) {
            // If we can't work out where to go, send an error.
            socket.write('HTTP/' + req.httpVersion + ' 400 Bad Request\r\n\r\n', 'utf-8');
            return;
        }

        if (options.debug) console.log(`Proxying HTTP/1 CONNECT to ${connectUrl}`);

        socket.write('HTTP/' + req.httpVersion + ' 200 OK\r\n\r\n', 'utf-8', () => {
            // Required here to avoid https://github.com/nodejs/node/issues/29902
            const socketWrapper = new SocketWrapper(socket);
            copyAddressDetails(socket, socketWrapper);
            copyTimingDetails(socket, socketWrapper);

            socketWrapper.__timingInfo.tunnelSetup = Date.now();
            server.emit('connection', socketWrapper);
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

        server.emit('connection', res.stream);
    }

    return destroyable(server);
}

function getParentSocket(socket: net.Socket) {
    if (socket._parent) return socket._parent; // TLS wrapper
    else return socket.stream; // SocketWrapper
}

type SocketIsh<MinProps extends keyof net.Socket> =
    streams.Duplex & Partial<Pick<net.Socket, MinProps>>;

// Update the target socket(-ish) with the address details from the source socket,
// iff the target has no details of its own.
function copyAddressDetails(
    source: SocketIsh<'localAddress' | 'localPort' | 'remoteAddress' | 'remotePort'>,
    target: SocketIsh<'localAddress' | 'localPort' | 'remoteAddress' | 'remotePort'>
) {
    const fields = ['localAddress', 'localPort', 'remoteAddress', 'remotePort'] as const;
    Object.defineProperties(target, _.zipObject(fields,
        _.range(fields.length).map(() => ({ writable: true }))
    ));
    fields.forEach((fieldName) => {
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
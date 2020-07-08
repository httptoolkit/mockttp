import _ = require('lodash');
import net = require('net');
import tls = require('tls');
import http = require('http');
import httpolyglot = require('@httptoolkit/httpolyglot');

import { TlsRequest } from '../types';
import { destroyable, DestroyableServer } from '../util/destroyable-server';
import { getCA, CAOptions } from '../util/tls';

// Hardcore monkey-patching: force TLSSocket to link servername & remoteAddress to
// sockets as soon as they're available, without waiting for the handshake to fully
// complete, so we can easily access them if the handshake fails.
const originalSocketInit = (<any>tls.TLSSocket.prototype)._init;
(<any>tls.TLSSocket.prototype)._init = function () {
    originalSocketInit.apply(this, arguments);

    const tlsSocket = this;
    const loadSNI = tlsSocket._handle.oncertcb;
    tlsSocket._handle.oncertcb = function (info: any) {
        tlsSocket.initialRemoteAddress = tlsSocket._parent.remoteAddress;
        tlsSocket.servername = info.servername;
        return loadSNI.apply(this, arguments);
    };
};

export type ComboServerOptions = { debug: boolean, https?: CAOptions };

// Takes an established TLS socket, calls the error listener if it's silently closed
function ifTlsDropped(socket: tls.TLSSocket, errorCallback: () => void) {
    new Promise((resolve, reject) => {
        socket.once('data', resolve);
        socket.once('close', reject);
        socket.once('end', reject);
    })
    .then(() => {
        // Mark the socket as having completed TLS setup - this ensures that future
        // errors fire as client errors, not TLS setup errors.
        socket.tlsSetupCompleted = true;
    })
    .catch(() => {
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
        // All sockets are initially marked for unencrypted upstream connections, this is
        // upgraded on secureConnection above.
        socket.upstreamEncryption = false;
    });

    server.on('secureConnection', (socket: tls.TLSSocket) => {
        socket.upstreamEncryption = true;
        ifTlsDropped(socket, () => {
            tlsClientErrorListener(socket, {
                failureCause: 'closed',
                hostname: socket.servername,
                remoteIpAddress: socket.remoteAddress!,
                tags: []
            });
        });
    });

    server.on('tlsClientError', (error: Error, socket: tls.TLSSocket) => {
        // These only work because of oncertcb monkeypatch above
        tlsClientErrorListener(socket, {
            failureCause: getCauseFromError(error),
            hostname: socket.servername,
            remoteIpAddress: socket.initialRemoteAddress!,
            tags: []
        });
    });

    // If the server receives a HTTP/HTTPS CONNECT request, Pretend to tunnel, then just re-handle:
    server.addListener('connect', function (req: http.IncomingMessage, socket: net.Socket) {
        // Clients may disconnect at this point (for all sorts of reasons), but here
        // nothing else is listening, so we need to catch errors on the socket:
        socket.once('error', (e) => console.log('Error on client socket', e));

        if (options.debug) console.log(`Proxying CONNECT to ${req.url!}`);

        socket.write('HTTP/' + req.httpVersion + ' 200 OK\r\n\r\n', 'utf-8', () => {
            server.emit('connection', socket);
        });
    });

    return destroyable(server);
}
import _ = require('lodash');
import net = require('net');
import tls = require('tls');
import http = require('http');
import httpolyglot = require('httpolyglot');
import destroyable, { DestroyableServer } from '../util/destroyable-server';
import { getCA, CAOptions } from '../util/tls';
import { peekFirstByte, mightBeTLSHandshake } from '../util/socket-util';

declare module "net" {
    interface Socket {
        // Have we CONNECT'd this socket to an upstream server? Defined if so.
        // Value tells you whether it started talking TLS or not afterwards.
        // If we somehow CONNECT repeatedly, this shows the state for the last time.
        upstreamEncryption?: boolean;

        // Normally only defined on TLSSocket, but useful to explicitly include here
        // Undefined on plain HTTP, 'true' on TLSSocket.
        encrypted?: boolean;
    }
}

export type ComboServerOptions = { debug: boolean, https?: CAOptions };

// The low-level server that handles all the sockets & TLS. The server will correctly call the
// given handler for both HTTP & HTTPS direct connections, or connections when used as an
// either HTTP or HTTPS proxy, all on the same port.
export async function createComboServer(
    options: ComboServerOptions,
    requestListener: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<DestroyableServer> {
    if (!options.https) {
        return destroyable(http.createServer(requestListener));
    }

    const ca = await getCA(options.https!);
    const defaultCert = ca.generateCertificate('localhost');

    const server = httpolyglot.createServer({
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

    // If the server receives a HTTP/HTTPS CONNECT request, do some magic to proxy & intercept it
    server.addListener('connect', (req: http.IncomingMessage, socket: net.Socket) => {
        const [ targetHost, port ] = req.url!.split(':');
        if (options.debug) console.log(`Proxying CONNECT to ${targetHost}`);

        socket.once('error', (e) => console.log('Error on client socket', e));

        socket.write('HTTP/' + req.httpVersion + ' 200 OK\r\n\r\n', 'utf-8', async () => {
            const firstByte = await peekFirstByte(socket);

            // Tell later handlers whether the socket wants an insecure upstream
            socket.upstreamEncryption = mightBeTLSHandshake(firstByte);

            if (socket.upstreamEncryption) {
                if (options.debug) console.log(`Unwrapping TLS connection to ${targetHost}`);
                unwrapTLS(targetHost, port, socket);
            } else {
                // Non-TLS CONNECT, probably a plain HTTP websocket. Pass it through untouched.
                if (options.debug) console.log(`Passing through connection to ${targetHost}`);
                server.emit('connection', socket);
                socket.resume();
            }
        });
    });

    function unwrapTLS(targetHost: string, port: string, socket: net.Socket) {
        const generatedCert = ca.generateCertificate(targetHost);

        let tlsSocket = new tls.TLSSocket(socket, {
            isServer: true,
            server: server,
            secureContext: tls.createSecureContext({
                key: generatedCert.key,
                cert: generatedCert.cert,
                ca: generatedCert.ca
            })
        });

        // This is a little crazy, but only a little. We create a one-off server to handle HTTP parsing, but
        // never listen on any ports or anything, we just hand it a live socket. Setup is pretty cheap here
        // (instantiate, sets up as event emitter, registers some events & properties, that's it), and
        // this is the easiest way I can see to put targetHost into the URL, without reimplementing HTTP.
        const innerServer = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
            req.url = `https://${targetHost}:${port}${req.url}`;
            return requestListener(req, res);
        });
        innerServer.addListener('upgrade', (req, socket, head) => {
            req.url = `https://${targetHost}:${port}${req.url}`;
            server.emit('upgrade', req, socket, head);
        });
        innerServer.addListener('connect', (req, res) => server.emit('connect', req, res));

        innerServer.emit('connection', tlsSocket);
    }

    return destroyable(server);
}
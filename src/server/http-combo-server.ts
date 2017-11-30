import _ = require('lodash');
import net = require('net');
import tls = require('tls');
import http = require('http');
import https = require('https');
import httpolyglot = require('httpolyglot');
import destroyable, { DestroyableServer } from '../util/destroyable-server';
import { getCA, HttpsOptions, CAOptions } from '../util/tls';

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

        socket.write('HTTP/' + req.httpVersion + ' 200 OK\r\n\r\n', 'UTF-8', () => {
            const generatedCert = ca.generateCertificate(targetHost);

            let tlsSocket = new tls.TLSSocket(socket, {
                isServer: true,
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
            http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
                req.url = `https://${targetHost}:${port}${req.url}`;
                return requestListener(req, res);
            }).emit('connection', tlsSocket);
        });
    });

    return destroyable(server);
}
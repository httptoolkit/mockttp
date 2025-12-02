import * as net from 'net';
import * as tls from 'tls';
import * as http2 from 'http2';
import { expect } from "chai";
import { TlsHelloData, trackClientHellos } from 'read-tls-client-hello';

import { getLocal } from "../../..";
import {
    sendRawRequest,
    openSocksSocket,
    makeDestroyable,
    nodeOnly,
    openRawSocket,
    getHttp2Response,
    cleanup,
    openRawTlsSocket,
    DestroyableServer
} from "../../test-utils";
import { getCA } from '../../../src/util/certificates';

nodeOnly(() => {
    describe("Unknown protocol handling", () => {

        describe("with SOCKS & unknown protocol passthrough enabled", () => {

            let server = getLocal({
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem',
                },
                socks: true,
                passthrough: ['unknown-protocol']
            });

            beforeEach(async () => {
                await server.start();

                // No unexpected errors here please:
                await server.on('tls-client-error', (e) => expect.fail(`TLS error: ${e.failureCause}`));
                await server.on('client-error', (e) => expect.fail(`Client error: ${e.errorCode}`));
            });

            afterEach(async () => {
                await server.stop();
            });

            describe("to a raw TCP server", () => {

                // Simple TCP echo server:
                let remoteServer = makeDestroyable(net.createServer((socket) => {
                    socket.on('data', (data) => {
                        socket.end(data);
                    });
                }));
                let remotePort!: number;

                beforeEach(async () => {
                    remoteServer.listen();
                    await new Promise((resolve, reject) => {
                        remoteServer.on('listening', resolve);
                        remoteServer.on('error', reject);
                    });
                    remotePort = (remoteServer.address() as net.AddressInfo).port;
                });

                afterEach(async () => {
                    await remoteServer.destroy();
                });

                it("can tunnel an unknown protocol over SOCKS, if enabled", async () => {
                    const socksSocket = await openSocksSocket(server, 'localhost', remotePort);
                    const response = await sendRawRequest(socksSocket, '123456789');
                    expect(response).to.equal('123456789');
                });

                it("can tunnel an unknown protocol over HTTP, if enabled", async () => {
                    const tunnel = await openRawSocket(server);

                    tunnel.write(`CONNECT localhost:${remotePort} HTTP/1.1\r\n\r\n`);
                    const connectResponse = await new Promise<Buffer>((resolve, reject) => {
                        tunnel.on('data', resolve);
                        tunnel.on('error', reject);
                    });

                    expect(connectResponse.toString()).to.equal('HTTP/1.1 200 OK\r\n\r\n');

                    tunnel.write('hello world');
                    const unknownProtocolResponse = await new Promise<Buffer>((resolve, reject) => {
                        tunnel.on('data', resolve);
                        tunnel.on('error', reject);
                    });

                    expect(unknownProtocolResponse.toString()).to.equal('hello world');
                    tunnel.end();
                });

                it("can tunnel an unknown protocol over HTTP/2, if enabled", async () => {
                    const proxyClient = http2.connect(server.url);

                    const tunnel = proxyClient.request({
                        ':method': 'CONNECT',
                        ':authority': `localhost:${remotePort}`
                    });
                    const proxyResponse = await getHttp2Response(tunnel);
                    expect(proxyResponse[':status']).to.equal(200);

                    tunnel.write('hello world');
                    const unknownProtocolResponse = await new Promise<Buffer>((resolve, reject) => {
                        tunnel.on('data', resolve);
                        tunnel.on('error', reject);
                    });

                    expect(unknownProtocolResponse.toString()).to.equal('hello world');
                    tunnel.end();

                    await cleanup(tunnel, proxyClient);
                });

            });

            describe("to a TLS-but-not-HTTP server", () => {

                // TLS echo server: unwraps TLS, then echos
                let remoteServer: DestroyableServer<tls.Server>;
                let remotePort!: number;

                // Track client hellos on connections
                before(async () => {
                    // Dynamically generate certs, just like Mockttp itself, but for raw 'echo' only. We use our
                    // test CA which should be trusted by Node due to NODE_EXTRA_CA_CERTS settings in package.json.
                    const ca = await getCA({
                        keyPath: './test/fixtures/test-ca.key',
                        certPath: './test/fixtures/test-ca.pem',
                    });
                    const defaultCert = await ca.generateCertificate('localhost.test');

                    remoteServer = makeDestroyable(tls.createServer({
                        key: defaultCert.key,
                        cert: defaultCert.cert,
                        ca: [defaultCert.ca],
                        SNICallback: async (domain: string, cb: Function) => {
                            const generatedCert = await ca.generateCertificate(domain);
                            cb(null, tls.createSecureContext({
                                key: generatedCert.key,
                                cert: generatedCert.cert,
                                ca: generatedCert.ca
                            }));
                        },
                        ALPNProtocols: ['echo']
                    }, (socket) => {
                        hellos.push(socket.tlsClientHello);
                        socket.on('data', (data) => {
                            socket.end(data);
                        });
                    }));

                    trackClientHellos(remoteServer);
                });

                // Store the client hellos for reference
                let hellos: Array<TlsHelloData | undefined> = [];

                beforeEach(async () => {
                    remoteServer.listen();
                    await new Promise((resolve, reject) => {
                        remoteServer.on('listening', resolve);
                        remoteServer.on('error', reject);
                    });
                    remotePort = (remoteServer.address() as net.AddressInfo).port;

                    hellos = [];
                });

                afterEach(async () => {
                    await remoteServer.destroy();
                });

                it("can tunnel an unknown protocol using TLS over SOCKS, if enabled", async () => {
                    const socksSocket = await openSocksSocket(server, 'localhost', remotePort);

                    const tlsSocket = await openRawTlsSocket(socksSocket, {
                        servername: 'server.test',
                        ALPNProtocols: ['echo']
                    });

                    const response = await sendRawRequest(tlsSocket, '123456789');
                    expect(response).to.equal('123456789');

                    // We're terminating TLS, so we can't perfectly forward everything (client certs, really)
                    // but we should be able to mirror all the common bits:
                    expect(hellos.length).to.equal(1);
                    const destinationTlsHello = hellos[0]!;

                    expect(destinationTlsHello.alpnProtocols).to.deep.equal(['echo']);
                    expect(destinationTlsHello.serverName).to.equal('server.test');
                });

            });

        });

        it("rejects unknown protocol direct requests", async () => {
            // Key difference with the above block is that we don't mind a client error
            const server = getLocal({
                socks: true,
                passthrough: ['unknown-protocol']
            });
            await server.start();
            await server.forAnyRequest().thenPassThrough();

            // Request sent without a proxy tunnel:
            const response = await sendRawRequest(server, '123456789');
            expect(response).to.match(/^HTTP\/1.1 400 Bad Request/);

            await server.stop();
        });

        it("rejects unknown protocol tunnels if disabled", async () => {
            const server = getLocal({
                socks: true
                // Passthrough not enabled
            });
            await server.start();
            await server.forAnyRequest().thenPassThrough();

            const socksSocket = await openSocksSocket(server, 'localhost', 1234);
            const response = await sendRawRequest(socksSocket, '123456789');
            expect(response).to.match(/^HTTP\/1.1 400 Bad Request/);

            await server.stop();
        });

    });
});
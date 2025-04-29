import * as net from 'net';
import * as http2 from 'http2';
import { expect } from "chai";

import { getLocal } from "../../..";
import {
    sendRawRequest,
    openSocksSocket,
    makeDestroyable,
    nodeOnly,
    openRawSocket,
    delay,
    getHttp2Response,
    cleanup
} from "../../test-utils";

nodeOnly(() => {
    describe("Unknown protocol handling", () => {

        describe("with SOCKS & unknown protocol passthrough enabled", () => {

            let server = getLocal({
                socks: true,
                passthrough: ['unknown-protocol']
            });

            // Simple TCP echo server:
            let remoteServer = makeDestroyable(net.createServer((socket) => {
                socket.on('data', (data) => {
                    socket.end(data);
                });
            }));
            let remotePort!: number;

            beforeEach(async () => {
                await server.start();

                remoteServer.listen();
                await new Promise((resolve, reject) => {
                    remoteServer.on('listening', resolve);
                    remoteServer.on('error', reject);
                });
                remotePort = (remoteServer.address() as net.AddressInfo).port;

                // No unexpected errors here please:
                await server.on('tls-client-error', (e) => expect.fail(`TLS error: ${e.failureCause}`));
                await server.on('client-error', (e) => expect.fail(`Client error: ${e.errorCode}`));
            });

            afterEach(async () => {
                await server.stop();
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
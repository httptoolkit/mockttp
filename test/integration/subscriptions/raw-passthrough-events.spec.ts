import * as net from 'net';
import { expect } from "chai";

import { getAdminServer, getLocal, getRemote } from "../../..";
import {
    sendRawRequest,
    openSocksSocket,
    makeDestroyable,
    nodeOnly,
    delay
} from "../../test-utils";

nodeOnly(() => {
    describe("Raw passthrough subscriptions", () => {

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

        it("should fire for raw sockets that are passed through SOCKS", async () => {
            const events: any[] = [];
            await server.on('raw-passthrough-opened', (e) => events.push(e));
            await server.on('raw-passthrough-closed', (e) => events.push(e));

            const socksSocket = await openSocksSocket(server, 'localhost', remotePort);
            const response = await sendRawRequest(socksSocket, '123456789');
            expect(response).to.equal('123456789');

            await delay(10);

            expect(events.length).to.equal(2);
            const [openEvent, closeEvent] = events;
            expect(openEvent.id).to.equal(closeEvent.id);

            expect(openEvent.upstreamHost).to.equal('localhost');
            expect(openEvent.upstreamPort).to.equal(remotePort);
        });

        describe("with a remote client", () => {
            const adminServer = getAdminServer();
            const remoteClient = getRemote({
                socks: true,
                passthrough: ['unknown-protocol']
            });

            beforeEach(async () => {
                await adminServer.start();
                await remoteClient.start()
            });
            afterEach(async () => {
                await remoteClient.stop();
                await adminServer.stop();
            });

            it("should fire for raw sockets that are passed through SOCKS", async () => {
                const events: any[] = [];
                await remoteClient.on('raw-passthrough-opened', (e) => events.push(e));
                await remoteClient.on('raw-passthrough-closed', (e) => events.push(e));

                const socksSocket = await openSocksSocket(remoteClient, 'localhost', remotePort);
                const response = await sendRawRequest(socksSocket, '123456789');
                expect(response).to.equal('123456789');

                await delay(10);

                expect(events.length).to.equal(2);
                const [openEvent, closeEvent] = events;
                expect(openEvent.id).to.equal(closeEvent.id);

                expect(openEvent.upstreamHost).to.equal('localhost');
                expect(openEvent.upstreamPort).to.equal(remotePort);
            });
        });

    });
});
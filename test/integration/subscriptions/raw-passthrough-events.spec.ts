import * as net from 'net';
import { expect } from "chai";

import { getAdminServer, getLocal, getRemote, RawPassthroughDataEvent, RawPassthroughEvent } from "../../..";
import {
    sendRawRequest,
    openSocksSocket,
    makeDestroyable,
    nodeOnly,
    delay,
    getDeferred
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
                socket.write(data);
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
            const events: Array<RawPassthroughEvent> = [];
            await server.on('raw-passthrough-opened', (e) => events.push(e));
            await server.on('raw-passthrough-closed', (e) => events.push(e));

            const socksSocket = await openSocksSocket(server, 'localhost', remotePort);
            const response = await sendRawRequest(socksSocket, '123456789');
            expect(response).to.equal('123456789');

            await delay(10);

            expect(events.length).to.equal(2);
            const [openEvent, closeEvent] = events;
            expect(openEvent.id).to.equal(closeEvent.id);

            expect(openEvent.destination.hostname).to.equal('localhost');
            expect(openEvent.destination.port).to.equal(remotePort);
        });

        it("should expose sent & received data", async () => {
            const openDeferred = getDeferred<RawPassthroughEvent>();
            let dataEvents = [] as RawPassthroughDataEvent[];

            await server.on('raw-passthrough-opened', (e) => openDeferred.resolve(e));
            await server.on('raw-passthrough-data', (e) => dataEvents.push(e));

            const socksSocket = await openSocksSocket(server, 'localhost', remotePort);

            socksSocket.write('hello');

            const openEvent = await openDeferred;
            await delay(10);

            expect(dataEvents.length).to.equal(2);
            const [firstDataEvent, secondDataEvent] = dataEvents;
            dataEvents = [];

            expect(firstDataEvent.id).to.equal(openEvent.id);
            expect(firstDataEvent.direction).to.equal('received');
            expect(firstDataEvent.content.toString()).to.equal('hello');

            expect(secondDataEvent.id).to.equal(openEvent.id);
            expect(secondDataEvent.direction).to.equal('sent');
            expect(secondDataEvent.content.toString()).to.equal('hello');
            expect(secondDataEvent.eventTimestamp).to.be.greaterThan(firstDataEvent.eventTimestamp);

            socksSocket.write('world');
            await delay(10);

            expect(dataEvents.length).to.equal(2);
            const [thirdDataEvent, fourthDataEvent] = dataEvents;

            expect(thirdDataEvent.id).to.equal(openEvent.id);
            expect(thirdDataEvent.direction).to.equal('received');
            expect(thirdDataEvent.content.toString()).to.equal('world');
            expect(thirdDataEvent.eventTimestamp).to.be.greaterThan(secondDataEvent.eventTimestamp);

            expect(fourthDataEvent.id).to.equal(openEvent.id);
            expect(fourthDataEvent.direction).to.equal('sent');
            expect(fourthDataEvent.content.toString()).to.equal('world');
            expect(fourthDataEvent.eventTimestamp).to.be.greaterThan(thirdDataEvent.eventTimestamp);
        });

        it("should expose large received data", async () => {
            const openDeferred = getDeferred<RawPassthroughEvent>();
            let receivedDataEvents = [] as RawPassthroughDataEvent[];

            await server.on('raw-passthrough-opened', (e) => openDeferred.resolve(e));
            await server.on('raw-passthrough-data', (e) => {
                if (e.direction === 'received') {
                    receivedDataEvents.push(e)
                }
            });

            const socksSocket = await openSocksSocket(server, 'localhost', remotePort);

            const message = 'hello'.repeat(20_000); // =100KB each

            // Write 500KB in 100KB chunks with a brief delay. Larger than one TCP packet (65K)
            // in all cases, should cause some weirdness.
            for (let i = 0; i < 5; i++) {
                socksSocket.write(message);
                await delay(0);
            }

            await openDeferred;
            await delay(10);

            const totalLength = receivedDataEvents.reduce((sum, e) => sum + e.content.toString().length, 0);
            expect(totalLength).to.equal(500_000);
            expect(receivedDataEvents[0].content.slice(0, 5).toString()).to.equal('hello');
            expect(receivedDataEvents[receivedDataEvents.length - 1].content.slice(-5).toString()).to.equal('hello');
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
                await remoteClient.on('raw-passthrough-data', (e) => events.push(e));
                await remoteClient.on('raw-passthrough-closed', (e) => events.push(e));

                const socksSocket = await openSocksSocket(remoteClient, 'localhost', remotePort);
                const response = await sendRawRequest(socksSocket, '123456789');
                expect(response).to.equal('123456789');

                await delay(10);

                expect(events.length).to.equal(4);
                const [openEvent, receivedEvent, sentEvent, closeEvent] = events;
                expect(receivedEvent.id).to.equal(openEvent.id);
                expect(sentEvent.id).to.equal(openEvent.id);
                expect(openEvent.id).to.equal(closeEvent.id);

                expect(openEvent.destination.hostname).to.equal('localhost');
                expect(openEvent.destination.port).to.equal(remotePort);

                expect(receivedEvent.content.toString()).to.equal('123456789');
                expect(receivedEvent.direction).to.equal('received');
                expect(receivedEvent.eventTimestamp).to.be.greaterThan(openEvent.timingEvents.connectTimestamp);
                expect(sentEvent.content.toString()).to.equal('123456789');
                expect(sentEvent.direction).to.equal('sent');
                expect(sentEvent.eventTimestamp).to.be.greaterThan(receivedEvent.eventTimestamp);
            });
        });

    });
});
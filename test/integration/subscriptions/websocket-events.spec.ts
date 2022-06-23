import * as WebSocket from 'isomorphic-ws';

import {
    getLocal,
    CompletedRequest,
    CompletedResponse,
    WebSocketMessage,
    WebSocketClose,
    InitiatedRequest,
    TimingEvents
} from "../../..";
import {
    expect,
    getDeferred,
    delay,
    nodeOnly
} from "../../test-utils";

describe("WebSocket subscriptions", () => {
    describe("with a local HTTP server", () => {

        let server = getLocal();

        beforeEach(() => server.start());
        afterEach(() => server.stop());

        describe("for connection setup", () => {

            it("should fire websocket-request when a websocket upgrade is attempted", async () => {
                await server.forAnyWebSocket().thenPassivelyListen();

                let eventPromise = getDeferred<CompletedRequest>();
                await server.on('websocket-request', (r) => eventPromise.resolve(r));

                new WebSocket(`ws://localhost:${server.port}/qwe`);

                const upgradeEvent = await eventPromise;

                expect(upgradeEvent.url).to.equal(`ws://localhost:${server.port}/qwe`);
                expect(upgradeEvent.headers['connection']).to.equal('Upgrade');
            });

            it("should fire websocket-accepted when a websocket upgrade is completed", async () => {
                await server.forAnyWebSocket().thenPassivelyListen();

                let requestPromise = getDeferred<CompletedRequest>();
                await server.on('websocket-request', (r) => requestPromise.resolve(r));

                let upgradePromise = getDeferred<CompletedResponse>();
                await server.on('websocket-accepted', (r) => upgradePromise.resolve(r));

                new WebSocket(`ws://localhost:${server.port}/qwe`);

                const requestEvent = await requestPromise;
                const upgradeEvent = await upgradePromise;

                expect(upgradeEvent.id).to.equal(requestEvent.id);
                expect(upgradeEvent.statusCode).to.equal(101);
                expect(upgradeEvent.headers['upgrade']).to.equal('websocket');
            });

        });

        describe("for message data", () => {

            it("should fire websocket-message-received events for received data", async () => {
                await server.forAnyWebSocket().thenPassivelyListen();

                let requestPromise = getDeferred<CompletedRequest>();
                await server.on('websocket-request', (r) => requestPromise.resolve(r));

                let eventPromise = getDeferred<WebSocketMessage>();
                await server.on('websocket-message-received', (d) => eventPromise.resolve(d));

                const ws = new WebSocket(`ws://localhost:${server.port}/qwe`);

                ws.addEventListener('open', () => {
                    ws.send('test message');
                });

                const requestEvent = await requestPromise;
                const messageEvent = await eventPromise;

                expect(requestEvent.id).to.equal(messageEvent.streamId);

                expect(messageEvent.direction).to.equal('received');
                expect(messageEvent.content.toString()).to.equal('test message');
                expect(messageEvent.isBinary).to.equal(false);

                expect(messageEvent.eventTimestamp).to.be.greaterThan(0);
                expect(messageEvent.timingEvents.startTime).to.be.greaterThan(0);
                expect(messageEvent.tags).to.deep.equal([]);
            });

            it("should fire websocket-message-sent events for received data", async () => {
                await server.forAnyWebSocket().thenEcho();

                let requestPromise = getDeferred<CompletedRequest>();
                await server.on('websocket-request', (r) => requestPromise.resolve(r));

                let eventPromise = getDeferred<WebSocketMessage>();
                await server.on('websocket-message-sent', (d) => eventPromise.resolve(d));

                const ws = new WebSocket(`ws://localhost:${server.port}/qwe`);

                ws.addEventListener('open', () => {
                    ws.send('test message');
                });

                const requestEvent = await requestPromise;
                const messageEvent = await eventPromise;

                expect(requestEvent.id).to.equal(messageEvent.streamId);

                expect(messageEvent.direction).to.equal('sent');
                expect(messageEvent.content.toString()).to.equal('test message');
                expect(messageEvent.isBinary).to.equal(false);

                expect(messageEvent.eventTimestamp).to.be.greaterThan(0);
                expect(messageEvent.timingEvents.startTime).to.be.greaterThan(0);
                expect(messageEvent.tags).to.deep.equal([]);
            });

        });

        describe("for connection shutdown", () => {

            it("should fire websocket-close events for cleanly closed connections", async () => {
                await server.forAnyWebSocket().thenPassivelyListen();

                let requestPromise = getDeferred<CompletedRequest>();
                await server.on('websocket-request', (r) => requestPromise.resolve(r));

                let closePromise = getDeferred<WebSocketClose>();
                await server.on('websocket-close', (r) => closePromise.resolve(r));

                let seenAbort = false;
                await server.on('abort', () => { seenAbort = true });

                const ws = new WebSocket(`ws://localhost:${server.port}/qwe`);
                ws.addEventListener('open', () => {
                    ws.close(3003, "Goodbye Mockttp");
                });

                const requestEvent = await requestPromise;
                const closeEvent = await closePromise;

                expect(closeEvent.streamId).to.equal(requestEvent.id);
                expect(closeEvent.closeCode).to.equal(3003);
                expect(closeEvent.closeReason).to.equal("Goodbye Mockttp");

                expect(closeEvent.timingEvents.startTime).to.be.greaterThan(0);
                expect(closeEvent.timingEvents.startTimestamp).to.be.greaterThan(0);
                expect(closeEvent.timingEvents.wsAcceptedTimestamp).to.be.greaterThan(0);
                expect(closeEvent.timingEvents.wsClosedTimestamp).to.be.greaterThan(0);

                await delay(100);
                expect(seenAbort).to.equal(false);
            });

            it("should fire websocket-close events with undefined codes, if no code was sent", async () => {
                await server.forAnyWebSocket().thenPassivelyListen();

                let requestPromise = getDeferred<CompletedRequest>();
                await server.on('websocket-request', (r) => requestPromise.resolve(r));

                let closePromise = getDeferred<WebSocketClose>();
                await server.on('websocket-close', (r) => closePromise.resolve(r));

                let seenAbort = false;
                await server.on('abort', () => { seenAbort = true });

                const ws = new WebSocket(`ws://localhost:${server.port}/qwe`);
                ws.addEventListener('open', () => {
                    ws.close(3003, "Goodbye Mockttp");
                });

                const requestEvent = await requestPromise;
                const closeEvent = await closePromise;

                expect(closeEvent.streamId).to.equal(requestEvent.id);
                expect(closeEvent.closeCode).to.equal(3003);
                expect(closeEvent.closeReason).to.equal("Goodbye Mockttp");

                expect(closeEvent.timingEvents.startTime).to.be.greaterThan(0);
                expect(closeEvent.timingEvents.startTimestamp).to.be.greaterThan(0);
                expect(closeEvent.timingEvents.wsAcceptedTimestamp).to.be.greaterThan(0);
                expect(closeEvent.timingEvents.wsClosedTimestamp).to.be.greaterThan(0);

                await delay(100);
                expect(seenAbort).to.equal(false);
            });

            it("should fire response events for refused upgrade attempts", async () => {
                await server.forAnyWebSocket().thenRejectConnection(403);

                let requestPromise = getDeferred<CompletedRequest>();
                await server.on('websocket-request', (r) => requestPromise.resolve(r));

                let responsePromise = getDeferred<CompletedResponse>();
                await server.on('response', (r) => responsePromise.resolve(r));

                let seenClose = false;
                await server.on('websocket-close', () => { seenClose = true });

                const ws = new WebSocket(`ws://localhost:${server.port}/qwe`);
                ws.addEventListener('error', () => {});

                const requestEvent = await requestPromise;
                const responseEvent = await responsePromise;

                expect(responseEvent.id).to.equal(requestEvent.id);

                const timingEvents = responseEvent.timingEvents as TimingEvents;
                expect(timingEvents.startTime).to.be.greaterThan(0);
                expect(timingEvents.startTimestamp).to.be.greaterThan(0);
                expect(timingEvents.responseSentTimestamp).to.be.greaterThan(0);

                expect(timingEvents.wsAcceptedTimestamp).to.equal(undefined);
                expect(timingEvents.wsClosedTimestamp).to.equal(undefined);

                await delay(100);
                expect(seenClose).to.equal(false);
            });

            nodeOnly(() => {
                it("should fire abort events for aborted upgrade attempts", async () => {
                    await server.forAnyWebSocket().thenTimeout();

                    let requestPromise = getDeferred<CompletedRequest>();
                    await server.on('websocket-request', (r) => requestPromise.resolve(r));

                    let abortPromise = getDeferred<InitiatedRequest>();
                    await server.on('abort', (r) => abortPromise.resolve(r));

                    let seenClose = false;
                    await server.on('websocket-close', () => { seenClose = true });

                    const ws = new WebSocket(`ws://localhost:${server.port}/qwe`);
                    ws.addEventListener('error', () => {});
                    setTimeout(() => {
                        // Forcibly kill the socket, before the upgrade completes (due to thenTimeout)
                        (ws as any)._req.socket.destroy();
                    }, 50);

                    const requestEvent = await requestPromise;
                    const abortEvent = await abortPromise;

                    expect(abortEvent.id).to.equal(requestEvent.id);

                    expect(abortEvent.timingEvents.startTime).to.be.greaterThan(0);
                    expect(abortEvent.timingEvents.startTimestamp).to.be.greaterThan(0);
                    expect(abortEvent.timingEvents.abortedTimestamp).to.be.greaterThan(0);

                    expect(abortEvent.timingEvents.wsAcceptedTimestamp).to.equal(undefined);
                    expect(abortEvent.timingEvents.wsClosedTimestamp).to.equal(undefined);

                    await delay(100);
                    expect(seenClose).to.equal(false);
                });
            });

            nodeOnly(() => {
                it("should fire abort events for uncleanly closed connections", async () => {
                    await server.forAnyWebSocket().thenPassivelyListen();

                    let requestPromise = getDeferred<CompletedRequest>();
                    await server.on('websocket-request', (r) => requestPromise.resolve(r));

                    let abortPromise = getDeferred<InitiatedRequest>();
                    await server.on('abort', (r) => abortPromise.resolve(r));

                    let seenClose = false;
                    await server.on('websocket-close', () => { seenClose = true });

                    const ws = new WebSocket(`ws://localhost:${server.port}/qwe`);
                    ws.addEventListener('open', () => {
                        // Forcibly kill the socket, after the connection has opened:
                        (ws as any)._socket.destroy();
                    });

                    const requestEvent = await requestPromise;
                    const abortEvent = await abortPromise;

                    expect(abortEvent.id).to.equal(requestEvent.id);

                    expect(abortEvent.timingEvents.startTime).to.be.greaterThan(0);
                    expect(abortEvent.timingEvents.startTimestamp).to.be.greaterThan(0);
                    expect(abortEvent.timingEvents.wsAcceptedTimestamp).to.be.greaterThan(0);
                    expect(abortEvent.timingEvents.abortedTimestamp).to.be.greaterThan(0);

                    expect(abortEvent.timingEvents.wsClosedTimestamp).to.equal(undefined);

                    await delay(100);
                    expect(seenClose).to.equal(false);
                });
            });

        });

    });

});
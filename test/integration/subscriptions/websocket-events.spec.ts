import * as WebSocket from 'isomorphic-ws';

import {
    CompletedRequest,
    CompletedResponse,
    WebSocketMessage,
    getLocal
} from "../../..";
import {
    expect, getDeferred
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
                expect(upgradeEvent.headers.upgrade).to.equal('websocket');
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

    });

});
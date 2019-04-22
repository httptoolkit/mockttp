import * as http from 'http';
import * as zlib from 'zlib';

import { getLocal, getStandalone, getRemote, CompletedRequest, Mockttp } from "../..";
import { expect, fetch, nodeOnly, getDeferred, delay, isNode } from "../test-utils";
import { CompletedResponse, TimingEvents } from "../../dist/types";

function makeAbortableRequest(server: Mockttp, path: string) {
    if (isNode()) {
        let req = http.get({ hostname: 'localhost', port: server.port, path });
        req.on('error', () => {});
        req.end();
        return req;
    } else {
        let abortController = new AbortController();
        fetch(server.urlFor(path), { signal: abortController.signal }).catch(() => {});
        return abortController;
    }
}

describe("Request subscriptions", () => {
    describe("with a local server", () => {
        let server = getLocal();

        beforeEach(() => server.start());
        afterEach(() => server.stop());

        it("should notify with request details & body when a request is ready", async () => {
            let seenRequestPromise = getDeferred<CompletedRequest>();
            await server.on('request', (r) => seenRequestPromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"), { method: 'POST', body: 'body-text' });

            let seenRequest = await seenRequestPromise;
            expect(seenRequest.method).to.equal('POST');
            expect(seenRequest.hostname).to.equal('localhost');
            expect(seenRequest.url).to.equal('/mocked-endpoint');
            expect(seenRequest.body.text).to.equal('body-text');
        });

        it("should include timing information", async () => {
            let seenRequestPromise = getDeferred<CompletedRequest>();
            await server.on('request', (r) => seenRequestPromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"), { method: 'POST', body: 'body-text' });

            let { timingEvents } = <{ timingEvents: TimingEvents }> await seenRequestPromise;
            expect(timingEvents.startTime).to.be.a('number');
            expect(timingEvents.startTimestamp).to.be.a('number');
            expect(timingEvents.bodyReceivedTimestamp).to.be.a('number');
            expect(timingEvents.startTime).not.to.equal(timingEvents.startTimestamp);

            expect(timingEvents.abortedTimestamp).to.equal(undefined);
        });
    });

    nodeOnly(() => {
        describe("with a remote client", () => {
            let standalone = getStandalone();
            let client = getRemote();

            before(() => standalone.start());
            after(() => standalone.stop());

            beforeEach(() => client.start());
            afterEach(() => client.stop());

            it("should notify with request details after a request is made", async () => {
                let seenRequestPromise = getDeferred<CompletedRequest>();
                await client.on('request', (r) => seenRequestPromise.resolve(r));

                fetch(client.urlFor("/mocked-endpoint"), { method: 'POST', body: 'body-text' });

                let seenRequest = await seenRequestPromise;
                expect(seenRequest.method).to.equal('POST');
                expect(seenRequest.url).to.equal('/mocked-endpoint');
                expect(seenRequest.body.text).to.equal('body-text');
            });
        });
    });
});

describe("Response subscriptions", () => {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should notify with response details & body when a response is completed", async () => {
        server.get('/mocked-endpoint').thenReply(200, 'Mock response', {
            'x-extra-header': 'present'
        });

        let seenResponsePromise = getDeferred<CompletedResponse>();
        await server.on('response', (r) => seenResponsePromise.resolve(r));

        fetch(server.urlFor("/mocked-endpoint"));

        let seenResponse = await seenResponsePromise;
        expect(seenResponse.statusCode).to.equal(200);
        expect(seenResponse.headers['x-extra-header']).to.equal('present');
        expect(seenResponse.body.text).to.equal('Mock response');
    });

    it("should expose ungzipped bodies as .text", async () => {
        const body = zlib.gzipSync('Mock response');

        server.get('/mocked-endpoint').thenReply(200, body, {
            'content-encoding': 'gzip'
        });

        let seenResponsePromise = getDeferred<CompletedResponse>();
        await server.on('response', (r) => seenResponsePromise.resolve(r));

        fetch(server.urlFor("/mocked-endpoint"));

        let seenResponse = await seenResponsePromise;
        expect(seenResponse.statusCode).to.equal(200);
        expect(seenResponse.body.text).to.equal('Mock response');
    });

    it("should expose un-deflated bodies as .text", async () => {
        const body = zlib.deflateSync('Mock response');

        server.get('/mocked-endpoint').thenReply(200, body, {
            'content-encoding': 'deflate'
        });

        let seenResponsePromise = getDeferred<CompletedResponse>();
        await server.on('response', (r) => seenResponsePromise.resolve(r));

        fetch(server.urlFor("/mocked-endpoint"));

        let seenResponse = await seenResponsePromise;
        expect(seenResponse.statusCode).to.equal(200);
        expect(seenResponse.body.text).to.equal('Mock response');
    });

    it("should expose un-raw-deflated bodies as .text", async () => {
        const body = zlib.deflateRawSync('Mock response');

        server.get('/mocked-endpoint').thenReply(200, body, {
            'content-encoding': 'deflate'
        });

        let seenResponsePromise = getDeferred<CompletedResponse>();
        await server.on('response', (r) => seenResponsePromise.resolve(r));

        fetch(server.urlFor("/mocked-endpoint"));

        let seenResponse = await seenResponsePromise;
        expect(seenResponse.statusCode).to.equal(200);
        expect(seenResponse.body.text).to.equal('Mock response');
    });

    it("should include an id that matches the request event", async () => {
        server.get('/mocked-endpoint').thenReply(200);

        let seenRequestPromise = getDeferred<CompletedRequest>();
        let seenResponsePromise = getDeferred<CompletedResponse>();

        await Promise.all([
            server.on('request', (r) => seenRequestPromise.resolve(r)),
            server.on('response', (r) => seenResponsePromise.resolve(r))
        ]);

        fetch(server.urlFor("/mocked-endpoint"));

        let seenResponse = await seenResponsePromise;
        let seenRequest = await seenRequestPromise;

        expect(seenRequest.id).to.be.a('string');
        expect(seenRequest.id).to.equal(seenResponse.id);
    });

    it("should include timing information", async () => {
        let seenResponsePromise = getDeferred<CompletedResponse>();
        await server.on('response', (r) => seenResponsePromise.resolve(r));

        fetch(server.urlFor("/mocked-endpoint"), { method: 'POST', body: 'body-text' });

        let { timingEvents } = <{ timingEvents: TimingEvents }> await seenResponsePromise;
        expect(timingEvents.startTimestamp).to.be.a('number');
        expect(timingEvents.bodyReceivedTimestamp).to.be.a('number');
        expect(timingEvents.headersSentTimestamp).to.be.a('number');
        expect(timingEvents.responseSentTimestamp).to.be.a('number');

        expect(timingEvents.bodyReceivedTimestamp).to.be.greaterThan(timingEvents.startTimestamp);
        expect(timingEvents.headersSentTimestamp).to.be.greaterThan(timingEvents.startTimestamp);
        expect(timingEvents.responseSentTimestamp).to.be.greaterThan(timingEvents.headersSentTimestamp!);

        expect(timingEvents.abortedTimestamp).to.equal(undefined);
    });
});


describe("Abort subscriptions", () => {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should not be sent for successful requests", async () => {
        let seenAbortPromise = getDeferred<{ id: string }>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));
        await server.get('/mocked-endpoint').thenReply(200);

        await fetch(server.urlFor("/mocked-endpoint"));

        await expect(Promise.race([
            seenAbortPromise,
            delay(100).then(() => { throw new Error('timeout') })
        ])).to.be.rejectedWith('timeout');
    });

    it("should be sent when a request is aborted whilst handling", async () => {
        let seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        let seenAbortPromise = getDeferred<{ id: string }>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.get('/mocked-endpoint').thenCallback(() => delay(500).then(() => ({})));

        let abortable = makeAbortableRequest(server, '/mocked-endpoint');
        let seenRequest = await seenRequestPromise;
        abortable.abort();

        let seenAbort = await seenAbortPromise;
        expect(seenRequest.id).to.equal(seenAbort.id);
    });


    it("should be sent in place of response notifications, not in addition", async () => {
        let seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        let seenResponsePromise = getDeferred<CompletedResponse>();
        await server.on('response', (r) => Promise.resolve(r));

        await server.get('/mocked-endpoint').thenCallback((req) => delay(500).then(() => ({})));

        let abortable = makeAbortableRequest(server, '/mocked-endpoint');
        await seenRequestPromise;
        abortable.abort();

        await expect(Promise.race([
            seenResponsePromise,
            delay(100).then(() => { throw new Error('timeout') })
        ])).to.be.rejectedWith('timeout');
    });

    it("should include timing information", async () => {
        let seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        let seenAbortPromise = getDeferred<CompletedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.get('/mocked-endpoint').thenCallback(() => delay(500).then(() => ({})));

        let abortable = makeAbortableRequest(server, '/mocked-endpoint');
        await seenRequestPromise;
        abortable.abort();

        let { timingEvents } = <{ timingEvents: TimingEvents }> await seenAbortPromise;
        expect(timingEvents.startTimestamp).to.be.a('number');
        expect(timingEvents.bodyReceivedTimestamp).to.be.a('number');
        expect(timingEvents.abortedTimestamp).to.be.a('number');

        expect(timingEvents.abortedTimestamp).to.be.greaterThan(timingEvents.startTimestamp);

        expect(timingEvents.headersSentTimestamp).to.equal(undefined);
        expect(timingEvents.responseSentTimestamp).to.equal(undefined);
    });
});
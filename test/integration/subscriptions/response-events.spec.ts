import * as _ from 'lodash';
import * as http from 'http';
import * as zlib from 'zlib';

import {
    getLocal,
    InitiatedRequest,
    CompletedRequest,
    CompletedResponse,
    Mockttp
} from "../../..";
import {
    expect,
    fetch,
    nodeOnly,
    isNode,
    getDeferred,
    delay
} from "../../test-utils";
import { TimingEvents } from "../../../dist/types";

function makeAbortableRequest(server: Mockttp, path: string) {
    if (isNode) {
        let req = http.request({
            method: 'POST',
            hostname: 'localhost',
            port: server.port,
            path
        });
        req.on('error', () => {});
        return req;
    } else {
        let abortController = new AbortController();
        fetch(server.urlFor(path), {
            method: 'POST',
            signal: abortController.signal
        }).catch(() => {});
        return abortController;
    }
}

describe("Response subscriptions", () => {

    describe("with an HTTP server", () => {

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
            expect(seenResponse.body.text).to.equal('Mock response');
            expect(seenResponse.tags).to.deep.equal([]);

            expect(seenResponse.headers).to.deep.equal(isNode
                ? {
                    'x-extra-header': 'present'
                }
                : {
                    'x-extra-header': 'present',
                    'access-control-allow-origin': '*'
                }
            );
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

    describe("with an HTTPS server", () => {

        let server = getLocal({
            https: {
                keyPath: './test/fixtures/test-ca.key',
                certPath: './test/fixtures/test-ca.pem'
            }
        });

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
            expect(seenResponse.body.text).to.equal('Mock response');
            expect(seenResponse.tags).to.deep.equal([]);

            const matchableHeaders = _.omit(seenResponse.headers);
            expect(matchableHeaders).to.deep.equal(isNode
                ? {
                    'x-extra-header': 'present'
                }
                : {
                    ':status': '200',
                    'x-extra-header': 'present',
                    'access-control-allow-origin': '*'
                }
            );
        });
    });
});

describe("Abort subscriptions", () => {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should not be sent for successful requests", async () => {
        let seenAbortPromise = getDeferred<InitiatedRequest>();
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

        let seenAbortPromise = getDeferred<InitiatedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.post('/mocked-endpoint').thenCallback(() => delay(500).then(() => ({})));

        let abortable = makeAbortableRequest(server, '/mocked-endpoint');
        nodeOnly(() => (abortable as http.ClientRequest).end('request body'));

        let seenRequest = await seenRequestPromise;
        abortable.abort();

        let seenAbort = await seenAbortPromise;
        expect(seenRequest.id).to.equal(seenAbort.id);
        expect(seenRequest.tags).to.deep.equal([]);
    });

    it("should be sent when a request is aborted during an intentional timeout", async () => {
        let seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        let seenAbortPromise = getDeferred<InitiatedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.post('/mocked-endpoint').thenTimeout();

        let abortable = makeAbortableRequest(server, '/mocked-endpoint');
        nodeOnly(() => (abortable as http.ClientRequest).end('request body'));

        let seenRequest = await seenRequestPromise;
        abortable.abort();

        let seenAbort = await seenAbortPromise;
        expect(seenRequest.id).to.equal(seenAbort.id);
    });

    it("should be sent when a request is intentionally reset by a handler", async () => {
        let seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        let seenAbortPromise = getDeferred<InitiatedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.post('/mocked-endpoint').thenCloseConnection();

        let abortable = makeAbortableRequest(server, '/mocked-endpoint');
        nodeOnly(() => (abortable as http.ClientRequest).end('request body'));

        let seenRequest = await seenRequestPromise;
        abortable.abort();

        let seenAbort = await seenAbortPromise;
        expect(seenRequest.id).to.equal(seenAbort.id);
    });

    nodeOnly(() => {
        it("should be sent when a request is aborted before completion", async () => {
            let wasRequestSeen = false;
            await server.on('request', (r) => { wasRequestSeen = true; });

            let seenAbortPromise = getDeferred<InitiatedRequest>();
            await server.on('abort', (r) => seenAbortPromise.resolve(r));

            let abortable = makeAbortableRequest(server, '/mocked-endpoint') as http.ClientRequest;
            // Start writing a body, but never .end(), so it never completes
            abortable.write('start request', () => abortable.abort());

            let seenAbort = await seenAbortPromise;
            expect(seenAbort.timingEvents.bodyReceivedTimestamp).to.equal(undefined);
            expect(wasRequestSeen).to.equal(false);
        });
    });

    it("should be sent in place of response notifications, not in addition", async () => {
        let seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        let seenResponsePromise = getDeferred<CompletedResponse>();
        await server.on('response', (r) => Promise.resolve(r));

        await server.post('/mocked-endpoint').thenCallback((req) => delay(500).then(() => ({})));

        let abortable = makeAbortableRequest(server, '/mocked-endpoint');
        nodeOnly(() => (abortable as http.ClientRequest).end('request body'));

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

        let seenAbortPromise = getDeferred<InitiatedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.post('/mocked-endpoint').thenCallback(() => delay(500).then(() => ({})));

        let abortable = makeAbortableRequest(server, '/mocked-endpoint');
        nodeOnly(() => (abortable as http.ClientRequest).end('request body'));

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
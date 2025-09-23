import * as _ from 'lodash';
import { PassThrough } from 'stream';
import * as http from 'http';
import * as zlib from 'zlib';

import {
    getLocal,
    CompletedRequest,
    CompletedResponse,
    TimingEvents,
    AbortedRequest,
    InitiatedResponse,
    BodyData
} from "../../..";
import {
    expect,
    fetch,
    nodeOnly,
    isNode,
    getDeferred,
    delay,
    makeAbortableRequest
} from "../../test-utils";

describe("Response initiated subscriptions", () => {
    describe("with a local HTTP server", () => {
        let server = getLocal();

        beforeEach(() => server.start());
        afterEach(() => server.stop());

        it("should notify with response details as soon as they're ready", async () => {
            let seenResponsePromise = getDeferred<InitiatedResponse>();
            await server.on('response-initiated', (r) => seenResponsePromise.resolve(r));

            const bodyStream = new PassThrough();
            await server.forAnyRequest().thenStream(400, bodyStream, {
                'a': 'b',
                'access-control-allow-origin': '*',
                'access-control-expose-headers': '*'
            });

            const realResponse = await fetch(server.urlFor("/mocked-endpoint"));
            const realResponseHeaders = Object.fromEntries(realResponse.headers as any);

            let seenResponse = await seenResponsePromise;
            expect(seenResponse.statusCode).to.equal(400);
            expect(seenResponse.statusMessage).to.equal('Bad Request');

            expect(seenResponse.headers).to.deep.equal(realResponseHeaders);
            expect(seenResponse.rawHeaders).to.deep.equal(Object.entries(realResponseHeaders));

            expect((seenResponse as any).body).to.equal(undefined); // No body included yet
            expect((seenResponse as any).trailers).to.equal(undefined); // No trailers yet
            expect((seenResponse as any).rawTrailers).to.equal(undefined);

            expect(seenResponse.id).to.be.a('string');
            expect(seenResponse.tags).to.deep.equal([]);

            const timingEvents = seenResponse.timingEvents;
            expect(timingEvents.startTimestamp).to.be.a('number');
            expect(timingEvents.headersSentTimestamp).to.be.a('number');

            expect(timingEvents.headersSentTimestamp).to.be.greaterThan(timingEvents.startTimestamp);

            expect(timingEvents.responseSentTimestamp).to.equal(undefined);
            expect(timingEvents.abortedTimestamp).to.equal(undefined);
        });
    });
});

describe("Response subscriptions", () => {

    describe("with an HTTP server", () => {

        let server = getLocal();

        beforeEach(() => server.start());
        afterEach(() => server.stop());

        it("should notify with response details & body when a response is completed", async () => {
            server.forGet('/mocked-endpoint').thenReply(200, 'Mock response', {
                'x-extra-header': 'present'
            });

            let seenResponsePromise = getDeferred<CompletedResponse>();
            await server.on('response', (r) => seenResponsePromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"));

            let seenResponse = await seenResponsePromise;
            expect(seenResponse.statusCode).to.equal(200);
            expect(await seenResponse.body.getText()).to.equal('Mock response');
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
            expect(seenResponse.trailers).to.deep.equal({});
            expect(seenResponse.rawTrailers).to.deep.equal([]);
        });

        it("should expose ungzipped bodies as .text", async () => {
            const body = zlib.gzipSync('Mock response');

            server.forGet('/mocked-endpoint').thenReply(200, body, {
                'content-encoding': 'gzip'
            });

            let seenResponsePromise = getDeferred<CompletedResponse>();
            await server.on('response', (r) => seenResponsePromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"));

            let seenResponse = await seenResponsePromise;
            expect(seenResponse.statusCode).to.equal(200);
            expect(await seenResponse.body.getText()).to.equal('Mock response');
        });

        it("should expose un-deflated bodies as .text", async () => {
            const body = zlib.deflateSync('Mock response');

            server.forGet('/mocked-endpoint').thenReply(200, body, {
                'content-encoding': 'deflate'
            });

            let seenResponsePromise = getDeferred<CompletedResponse>();
            await server.on('response', (r) => seenResponsePromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"));

            let seenResponse = await seenResponsePromise;
            expect(seenResponse.statusCode).to.equal(200);
            expect(await seenResponse.body.getText()).to.equal('Mock response');
        });

        it("should expose un-raw-deflated bodies as .text", async () => {
            const body = zlib.deflateRawSync('Mock response');

            server.forGet('/mocked-endpoint').thenReply(200, body, {
                'content-encoding': 'deflate'
            });

            let seenResponsePromise = getDeferred<CompletedResponse>();
            await server.on('response', (r) => seenResponsePromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"));

            let seenResponse = await seenResponsePromise;
            expect(seenResponse.statusCode).to.equal(200);
            expect(await seenResponse.body.getText()).to.equal('Mock response');
        });

        it("should include an id that matches the request event", async () => {
            server.forGet('/mocked-endpoint').thenReply(200);

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

        it("should include raw header data", async () => {
            await server.forGet('/mocked-endpoint').thenReply(200, undefined, {
                "first-header": "1",
                "UPPERCASE-header": "value",
                "last-header": "2",
            });

            let seenResponsePromise = getDeferred<CompletedResponse>();
            await server.on('response', (r) => seenResponsePromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"));

            let seenResponse = await seenResponsePromise;
            expect(seenResponse.rawHeaders).to.deep.equal([
                ...(isNode
                    ? []
                    : [['access-control-allow-origin', '*']]
                ),
                ["first-header", "1"],
                ["UPPERCASE-header", "value"],
                ["last-header", "2"]
            ]);
        });

        it("should include raw trailer data", async () => {
            await server.forGet('/mocked-endpoint').thenReply(200, undefined, undefined, {
                "custom-TRAILER": "TRAILER-value"
            });

            let seenResponsePromise = getDeferred<CompletedResponse>();
            await server.on('response', (r) => seenResponsePromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"));

            let seenResponse = await seenResponsePromise;
            expect(seenResponse.trailers).to.deep.equal({
                "custom-trailer": "TRAILER-value"
            });
            expect(seenResponse.rawTrailers).to.deep.equal([
                ["custom-TRAILER", "TRAILER-value"]
            ]);
        });
    });

    describe("with an HTTP server allowing only tiny bodies", () => {

        let server = getLocal({
            maxBodySize: 10 // 10 bytes max
        });

        beforeEach(() => server.start());
        afterEach(() => server.stop());

        it("should include tiny bodies in response events", async () => {
            server.forGet('/mocked-endpoint').thenReply(200, 'TinyResp', {
                'x-extra-header': 'present'
            });

            let seenResponsePromise = getDeferred<CompletedResponse>();
            await server.on('response', (r) => seenResponsePromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"));

            let seenResponse = await seenResponsePromise;
            expect(seenResponse.statusCode).to.equal(200);
            expect(await seenResponse.body.getText()).to.equal('TinyResp');
        });

        it("should not include the body in the response event", async () => {
            server.forGet('/mocked-endpoint').thenReply(200, 'Large response body', {
                'x-extra-header': 'present'
            });

            let seenResponsePromise = getDeferred<CompletedResponse>();
            await server.on('response', (r) => seenResponsePromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"));

            let seenResponse = await seenResponsePromise;
            expect(seenResponse.statusCode).to.equal(200);
            expect(await seenResponse.body.getText()).to.equal(''); // Body omitted
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
            server.forGet('/mocked-endpoint').thenReply(200, 'Mock response', {
                'x-extra-header': 'present'
            });

            let seenResponsePromise = getDeferred<CompletedResponse>();
            await server.on('response', (r) => seenResponsePromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"));

            let seenResponse = await seenResponsePromise;
            expect(seenResponse.statusCode).to.equal(200);
            expect(await seenResponse.body.getText()).to.equal('Mock response');
            expect(seenResponse.tags).to.deep.equal([]);

            const matchableHeaders = _.omit(seenResponse.headers);
            expect(matchableHeaders).to.deep.equal(isNode
                ? {
                    'x-extra-header': 'present'
                }
                : {
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
        let seenAbortPromise = getDeferred<AbortedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));
        await server.forGet('/mocked-endpoint').thenReply(200);

        await fetch(server.urlFor("/mocked-endpoint"));

        await expect(Promise.race([
            seenAbortPromise,
            delay(100).then(() => { throw new Error('timeout') })
        ])).to.be.rejectedWith('timeout');
    });

    it("should be sent when a request is aborted whilst handling", async () => {
        let seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        let seenAbortPromise = getDeferred<AbortedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.forPost('/mocked-endpoint').thenCallback(() => delay(500).then(() => ({})));

        let abortable = makeAbortableRequest(server, '/mocked-endpoint');
        nodeOnly(() => (abortable as http.ClientRequest).end('request body'));

        let seenRequest = await seenRequestPromise;
        abortable.abort();

        let seenAbort = await seenAbortPromise;
        expect(seenRequest.id).to.equal(seenAbort.id);
        expect(seenRequest.tags).to.deep.equal([]);
        expect(seenRequest.headers['host']).to.deep.equal(`localhost:${server.port}`);
        expect(seenRequest.destination).to.deep.equal({
            hostname: 'localhost',
            port: server.port
        });
        expect(
            seenRequest.rawHeaders.find(([key]) => key === 'Host')
        ).to.deep.equal(['Host', `localhost:${server.port}`]); // Uppercase header name!
        expect(seenAbort.error).to.equal(undefined); // Client abort, not an error
    });

    it("should be sent when a request is aborted during an intentional timeout", async () => {
        let seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        let seenAbortPromise = getDeferred<AbortedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.forPost('/mocked-endpoint').thenTimeout();

        let abortable = makeAbortableRequest(server, '/mocked-endpoint');
        nodeOnly(() => (abortable as http.ClientRequest).end('request body'));

        let seenRequest = await seenRequestPromise;
        abortable.abort();

        let seenAbort = await seenAbortPromise;
        expect(seenRequest.id).to.equal(seenAbort.id);
        expect(seenAbort.error).to.equal(undefined); // Client abort, not an error
    });

    it("should be sent when a request is intentionally closed by a close handler", async () => {
        let seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        let seenAbortPromise = getDeferred<AbortedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.forGet('/mocked-endpoint').thenCloseConnection();

        fetch(server.urlFor('/mocked-endpoint')).catch(() => {});

        let seenRequest = await seenRequestPromise;
        let seenAbort = await seenAbortPromise;
        expect(seenRequest.id).to.equal(seenAbort.id);

        expect(seenAbort.error!.message).to.equal('Connection closed intentionally by rule');
    });

    it("should be sent when a request is intentionally closed by a callback handler", async () => {
        let seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        let seenAbortPromise = getDeferred<AbortedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.forGet('/mocked-endpoint').thenCallback(() => 'close');

        fetch(server.urlFor('/mocked-endpoint')).catch(() => {});

        let seenRequest = await seenRequestPromise;
        let seenAbort = await seenAbortPromise;
        expect(seenRequest.id).to.equal(seenAbort.id);
        expect(seenAbort.error!.message).to.equal('Connection closed intentionally by rule');
    });

    it("should be sent when a request is intentionally closed by beforeRequest", async () => {
        let seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        let seenAbortPromise = getDeferred<AbortedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.forGet('/mocked-endpoint').thenPassThrough({
            beforeRequest: () => ({
                response: 'close'
            })
        });

        fetch(server.urlFor('/mocked-endpoint')).catch(() => {});

        let seenRequest = await seenRequestPromise;
        let seenAbort = await seenAbortPromise;
        expect(seenRequest.id).to.equal(seenAbort.id);
        expect(seenAbort.error!.message).to.equal('Connection closed intentionally by rule');
    });

    it("should be sent when a forwarded request is intentionally closed by beforeResponse", async () => {
        let seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        let seenAbortPromise = getDeferred<AbortedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.forGet('/mocked-endpoint').thenPassThrough({
            transformRequest: { replaceHost: { targetHost: 'example.testserver.host' } },
            beforeResponse: () => 'close'
        });

        fetch(server.urlFor('/mocked-endpoint')).catch(() => {});

        let seenRequest = await seenRequestPromise;
        let seenAbort = await seenAbortPromise;
        expect(seenRequest.id).to.equal(seenAbort.id);
        expect(seenAbort.error!.message).to.equal('Connection closed intentionally by rule');
    });

    nodeOnly(() => {
        it("should be sent when a request is aborted before completion", async () => {
            let wasRequestSeen = false;
            await server.on('request', (r) => { wasRequestSeen = true; });

            let seenAbortPromise = getDeferred<AbortedRequest>();
            await server.on('abort', (r) => seenAbortPromise.resolve(r));

            let abortable = makeAbortableRequest(server, '/mocked-endpoint') as http.ClientRequest;
            // Start writing a body, but never .end(), so it never completes
            abortable.write('start request', () => abortable.abort());

            let seenAbort = await seenAbortPromise;
            expect(seenAbort.timingEvents.bodyReceivedTimestamp).to.equal(undefined);
            expect(seenAbort.error).to.equal(undefined); // Client abort, not an error
            expect(wasRequestSeen).to.equal(false);
        });

        describe("given a server that closes connections", () => {

            const badServer = new http.Server((req, res) => {
                // Forcefully close the socket with no response
                req.socket!.destroy();
            });

            beforeEach(async () => {
                await new Promise((resolve, reject) => {
                    badServer.listen(8901);
                    badServer.on('listening', resolve);
                    badServer.on('error', reject);
                });
            });

            afterEach(() => {
                badServer.close();
            });

            it("should be sent when simulating errors if the remote server aborts the response", async () => {
                let seenAbortPromise = getDeferred<AbortedRequest>();
                await server.on('abort', (r) => seenAbortPromise.resolve(r));

                let seenResponsePromise = getDeferred<CompletedResponse>();
                await server.on('response', (r) => seenResponsePromise.resolve(r));

                await server.forAnyRequest().thenForwardTo(`http://localhost:8901`, {
                    simulateConnectionErrors: true
                });

                fetch(server.urlFor("/mocked-endpoint")).catch(() => {});

                const seenAbort = await Promise.race([
                    seenAbortPromise,
                    seenResponsePromise.then(() => {
                        throw new Error('Should not fire a response event');
                    })
                ]);

                expect(seenAbort.error!.message).to.equal('Upstream connection error: socket hang up');
                expect(seenAbort.error!.code).to.equal('ECONNRESET');
            });

            it("should be sent when simulating errors if the remote proxy aborts the response", async () => {
                let seenAbortPromise = getDeferred<AbortedRequest>();
                await server.on('abort', (r) => seenAbortPromise.resolve(r));

                let seenResponsePromise = getDeferred<CompletedResponse>();
                await server.on('response', (r) => seenResponsePromise.resolve(r));

                await server.forAnyRequest().thenPassThrough({
                    // Wrong port: this connection will fail
                    proxyConfig: { proxyUrl: `http://localhost:8999` },
                    simulateConnectionErrors: true
                });

                fetch(server.urlFor("/mocked-endpoint")).catch(() => {});

                const seenAbort = await Promise.race([
                    seenAbortPromise,
                    seenResponsePromise.then(() => {
                        throw new Error('Should not fire a response event');
                    })
                ]);

                expect(seenAbort.error!.message).to.be.oneOf([
                    'Upstream connection error: connect ECONNREFUSED 127.0.0.1:8999',
                    'Upstream connection error: connect ECONNREFUSED ::1:8999',
                    'Upstream connection error: connect ECONNREFUSED ::1:8999, connect ECONNREFUSED 127.0.0.1:8999'
                ]);
                expect(seenAbort.error!.code).to.equal('ECONNREFUSED');
            });
        });
    });

    it("should be sent in place of response notifications, not in addition", async () => {
        let seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        let seenResponseInitiatedPromise = getDeferred<InitiatedResponse>();
        await server.on('response-initiated', (r) => seenResponseInitiatedPromise.resolve(r));

        let seenResponsePromise = getDeferred<CompletedResponse>();
        await server.on('response', (r) => seenResponsePromise.resolve(r));

        await server.forPost('/mocked-endpoint').thenCallback((req) => delay(500).then(() => ({})));

        let abortable = makeAbortableRequest(server, '/mocked-endpoint');
        nodeOnly(() => (abortable as http.ClientRequest).end('request body'));

        await seenRequestPromise;
        abortable.abort();

        await expect(Promise.race([
            seenResponseInitiatedPromise,
            seenResponsePromise,
            delay(100).then(() => { throw new Error('timeout') })
        ])).to.be.rejectedWith('timeout');
    });

    it("should not trigger an ended response body event", async () => {
        let seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        let seenResponseDataPromise = getDeferred<BodyData>();
        await server.on('response-body-data', (r) => seenResponseDataPromise.resolve(r));

        await server.forPost('/mocked-endpoint').thenCallback((req) => delay(500).then(() => ({})));

        let abortable = makeAbortableRequest(server, '/mocked-endpoint');
        nodeOnly(() => (abortable as http.ClientRequest).end('request body'));

        await seenRequestPromise;
        abortable.abort();

        await expect(Promise.race([
            seenResponseDataPromise,
            delay(100).then(() => { throw new Error('timeout') })
        ])).to.be.rejectedWith('timeout');
    });

    it("should include timing information", async () => {
        let seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        let seenAbortPromise = getDeferred<AbortedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.forPost('/mocked-endpoint').thenCallback(() => delay(500).then(() => ({})));

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

describe("Response body chunk subscriptions", () => {

    const server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should fire a single ended chunk for small non-streamed bodies", async () => {
        const dataEvents: BodyData[] = [];
        await server.on('response-body-data', (event) => dataEvents.push(event));

        await server.forGet('/mocked-endpoint').thenReply(200, "A small non-streamed body");

        await fetch(server.urlFor("/mocked-endpoint"));
        await delay(5); // Delay for events to be received

        expect(dataEvents).to.have.length(1);
        expect(dataEvents[0].content.toString()).to.equal(
            "A small non-streamed body"
        );
        expect(dataEvents[0].isEnded).to.equal(true);
        expect(dataEvents[0].eventTimestamp).to.be.a('number');
        expect(dataEvents[0].id).to.be.a('string');
    });

    it("should fire immediate-empty ended chunks for empty bodies", async () => {
        const dataEvents: BodyData[] = [];
        await server.on('response-body-data', (event) => dataEvents.push(event));

        await server.forGet('/mocked-endpoint').thenReply(204);

        fetch(server.urlFor("/mocked-endpoint"));
        await delay(5); // Delay for events to be received

        expect(dataEvents).to.have.length(1);
        expect(dataEvents[0].content.byteLength).to.equal(0);
        expect(dataEvents[0].isEnded).to.equal(true);
        expect(dataEvents[0].eventTimestamp).to.be.a('number');
        expect(dataEvents[0].id).to.be.a('string');
    });

    nodeOnly(() => {

        // Mildly difficult to do streaming well in browsers, and the above covers the basic
        // functionality, so we just test this node only:

        it("should stream body chunks as they are received", async () => {
            const dataEvents: BodyData[] = [];
            await server.on('response-body-data', (event) => dataEvents.push(event));

            const stream = new PassThrough();
            await server.forGet('/mocked-endpoint').thenStream(200, stream);

            fetch(server.urlFor("/mocked-endpoint"));

            await delay(25);
            expect(dataEvents).to.deep.equal([]);

            stream.write('hello');
            await delay(25);
            expect(dataEvents).to.have.length(1);
            expect(dataEvents[0].content).to.deep.equal(Buffer.from('hello'));
            expect(dataEvents[0].isEnded).to.equal(false);
            expect(dataEvents[0].eventTimestamp).to.be.a('number');
            expect(dataEvents[0].id).to.be.a('string');

            stream.write('world');
            await delay(25);
            expect(dataEvents).to.have.length(2);
            expect(dataEvents[1].content).to.deep.equal(Buffer.from('world'));
            expect(dataEvents[1].isEnded).to.equal(false);
            expect(dataEvents[1].eventTimestamp).to.be.greaterThan(dataEvents[0].eventTimestamp);
            expect(dataEvents[1].id).to.equal(dataEvents[0].id);

            stream.end();
            await delay(25);
            expect(dataEvents).to.have.length(3);
            expect(dataEvents[2].content.byteLength).to.equal(0);
            expect(dataEvents[2].isEnded).to.equal(true);
            expect(dataEvents[2].eventTimestamp).to.be.greaterThan(dataEvents[1].eventTimestamp);
            expect(dataEvents[2].id).to.equal(dataEvents[0].id);
        });

        it("should batch streamed body chunks", async () => {
            const dataEvents: BodyData[] = [];
            await server.on('response-body-data', (event) => dataEvents.push(event));

            const stream = new PassThrough();
            await server.forGet('/mocked-endpoint').thenStream(200, stream);

            fetch(server.urlFor("/mocked-endpoint")).catch(() => {});

            await delay(25);
            expect(dataEvents).to.deep.equal([]);

            stream.write('hello');
            await delay(5);
            stream.write('world');
            await delay(25);

            expect(dataEvents).to.have.length(1);
            expect(dataEvents[0].content).to.deep.equal(Buffer.from('helloworld'));
            expect(dataEvents[0].isEnded).to.equal(false);
            expect(dataEvents[0].eventTimestamp).to.be.a('number');
            expect(dataEvents[0].id).to.be.a('string');

            stream.end();
            await delay(25);
            expect(dataEvents).to.have.length(2);
            expect(dataEvents[1].content.byteLength).to.equal(0);
            expect(dataEvents[1].isEnded).to.equal(true);
            expect(dataEvents[1].eventTimestamp).to.be.greaterThan(dataEvents[0].eventTimestamp);
            expect(dataEvents[1].id).to.equal(dataEvents[0].id);
        });

        it("should batch streamed body chunks but emit immediately on end", async () => {
            const dataEvents: BodyData[] = [];
            await server.on('response-body-data', (event) => dataEvents.push(event));

            const stream = new PassThrough();
            await server.forGet('/mocked-endpoint').thenStream(200, stream);

            fetch(server.urlFor("/mocked-endpoint")).catch(() => {});

            await delay(25);
            expect(dataEvents).to.deep.equal([]);

            stream.write('hello');
            await delay(5);
            expect(dataEvents).to.have.length(0);
            stream.end('world');
            await delay(5);

            expect(dataEvents).to.have.length(1);
            expect(dataEvents[0].content).to.deep.equal(Buffer.from('helloworld'));
            expect(dataEvents[0].isEnded).to.equal(true);
            expect(dataEvents[0].eventTimestamp).to.be.a('number');
            expect(dataEvents[0].id).to.be.a('string');
        });

        it("should just stop (without ended) if aborted server-side mid-stream", async () => {
            const dataEvents: BodyData[] = [];
            await server.on('response-body-data', (event) => dataEvents.push(event));

            let responseEvent: CompletedResponse | undefined;
            await server.on('response', (r) => { responseEvent = r });

            const abortEvent = getDeferred<AbortedRequest>();
            await server.on('abort', (r) => abortEvent.resolve(r));

            const stream = new PassThrough();
            await server.forAnyRequest().thenStream(200, stream);

            fetch(server.urlFor("/mocked-endpoint")).catch(() => {});

            await delay(25);
            expect(dataEvents).to.deep.equal([]);

            stream.write('hello');
            await delay(1);
            stream.destroy(new Error('OH NO'));

            const abort = await abortEvent;
            expect(abort.error?.code).to.equal('STREAM_RULE_ERROR');

            await delay(25);
            expect(dataEvents).to.have.length(1);
            expect(dataEvents[0].content.toString()).to.deep.equal('hello');
            expect(dataEvents[0].isEnded).to.equal(false); // Not ended
            expect(dataEvents[0].eventTimestamp).to.be.a('number');
            expect(dataEvents[0].id).to.be.a('string');

            expect(responseEvent).to.equal(undefined); // No response event fired
        });

        it("should just stop (without ended) if aborted client-side mid-stream", async () => {
            const dataEvents: BodyData[] = [];
            await server.on('response-body-data', (event) => dataEvents.push(event));

            let responseEvent: CompletedResponse | undefined;
            await server.on('response', (r) => { responseEvent = r });

            const abortEvent = getDeferred<AbortedRequest>();
            await server.on('abort', (r) => abortEvent.resolve(r));

            const stream = new PassThrough();
            await server.forAnyRequest().thenStream(200, stream);

            let abortable = makeAbortableRequest(server, '/mocked-endpoint');
            nodeOnly(() => {
                (abortable as http.ClientRequest)
                    .end('request body')
                    // .on('error', () => {});
            });

            await delay(25);
            expect(dataEvents).to.deep.equal([]);

            stream.write('hello');
            await delay(5);
            abortable.abort();
            await delay(25);

            expect(dataEvents).to.have.length(1);
            expect(dataEvents[0].content.toString()).to.equal('hello');
            expect(dataEvents[0].isEnded).to.equal(false);
            expect(dataEvents[0].eventTimestamp).to.be.a('number');
            expect(dataEvents[0].id).to.be.a('string');

            await delay(25);
            expect(dataEvents).to.have.length(1); // No end event
            expect(responseEvent).to.equal(undefined); // No response event

            const abort = await abortEvent; // Abort even _is_ fired however.
            expect(abort.error).to.equal(undefined); // Client close - not server error
        });

    });

});
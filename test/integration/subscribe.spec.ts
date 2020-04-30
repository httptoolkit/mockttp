import * as _ from 'lodash';
import * as http from 'http';
import HttpsProxyAgent = require('https-proxy-agent');
import * as zlib from 'zlib';
import * as semver from 'semver';

import {
    getLocal,
    getStandalone,
    getRemote,
    InitiatedRequest,
    CompletedRequest,
    CompletedResponse,
    Mockttp
} from "../..";
import {
    expect,
    fetch,
    nodeOnly,
    isNode,
    getDeferred,
    delay,
    sendRawRequest,
    openRawSocket,
    openRawTlsSocket,
    writeAndReset,
    watchForEvent,
    TOO_LONG_HEADER_SIZE
} from "../test-utils";
import { TimingEvents, TlsRequest, ClientError } from "../../dist/types";

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

describe("Request initiated subscriptions", () => {
    describe("with a local server", () => {
        let server = getLocal();

        beforeEach(() => server.start());
        afterEach(() => server.stop());

        it("should notify with request details as soon as they're ready", async () => {
            let seenRequestPromise = getDeferred<InitiatedRequest>();
            await server.on('request-initiated', (r) => seenRequestPromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"), { method: 'POST', body: 'body-text' });

            let seenRequest = await seenRequestPromise;
            expect(seenRequest.method).to.equal('POST');
            expect(seenRequest.protocol).to.equal('http');
            expect(seenRequest.httpVersion).to.equal('1.1');
            expect(seenRequest.url).to.equal(server.urlFor("/mocked-endpoint"));
            expect((seenRequest as any).body).to.equal(undefined); // No body included yet
        });

        nodeOnly(() => {
            it("should notify with request details before the body is received", async () => {
                let seenInitialRequestPromise = getDeferred<InitiatedRequest>();
                await server.on('request-initiated', (r) => seenInitialRequestPromise.resolve(r));
                let seenCompletedRequestPromise = getDeferred<CompletedRequest>();
                await server.on('request', (r) => seenCompletedRequestPromise.resolve(r));

                let req = http.request({
                    method: 'POST',
                    hostname: 'localhost',
                    port: server.port
                });

                req.write('start body\n');
                // Note: we haven't called .end() yet, the request is still going

                let seenInitialRequest = await seenInitialRequestPromise;
                expect(seenInitialRequest.method).to.equal('POST');
                expect(seenInitialRequest.protocol).to.equal('http');
                expect(seenInitialRequest.httpVersion).to.equal('1.1');
                expect(seenInitialRequest.url).to.equal(server.urlFor('/'));
                expect((seenInitialRequest as any).body).to.equal(undefined);

                req.end('end body');
                let seenCompletedRequest = await seenCompletedRequestPromise;
                expect(seenCompletedRequest.body.text).to.equal('start body\nend body');
            });
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

            it("should notify with request details as soon as they're ready", async () => {
                let seenRequestPromise = getDeferred<InitiatedRequest>();
                await client.on('request-initiated', (r) => seenRequestPromise.resolve(r));

                fetch(client.urlFor("/mocked-endpoint"), { method: 'POST', body: 'body-text' });

                let seenRequest = await seenRequestPromise;
                expect(seenRequest.method).to.equal('POST');
                expect(seenRequest.httpVersion).to.equal('1.1');
                expect(seenRequest.url).to.equal(client.urlFor("/mocked-endpoint"));
                expect((seenRequest as any).body).to.equal(undefined); // No body included yet
            });
        });
    });
});

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
            expect(seenRequest.protocol).to.equal('http');
            expect(seenRequest.httpVersion).to.equal('1.1');
            expect(seenRequest.url).to.equal(server.urlFor("/mocked-endpoint"));
            expect(seenRequest.body.text).to.equal('body-text');
            expect(seenRequest.tags).to.deep.equal([]);
        });

        it("should include the matched rule id", async () => {
            let seenRequestPromise = getDeferred<CompletedRequest>();
            await server.on('request', (r) => seenRequestPromise.resolve(r));
            let endpoint = await server.get('/').thenReply(200);

            fetch(server.urlFor("/"));

            let { matchedRuleId } = await seenRequestPromise;
            expect(matchedRuleId).to.equal(endpoint.id);
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

        nodeOnly(() => {
            it("should report unnormalized URLs", async () => {
                let seenRequestPromise = getDeferred<CompletedRequest>();
                await server.on('request', (r) => seenRequestPromise.resolve(r));

                sendRawRequest(server, 'GET http://example.com HTTP/1.1\n\n');

                let seenRequest = await seenRequestPromise;
                expect(seenRequest.url).to.equal('http://example.com');
            });
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
                expect(seenRequest.url).to.equal(
                    `http://localhost:${client.port}/mocked-endpoint`
                );
                expect(seenRequest.body.text).to.equal('body-text');
                expect(seenRequest.tags).to.deep.equal([]);
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
        expect(seenResponse.tags).to.deep.equal([]);
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

describe("TLS error subscriptions", () => {
    let goodServer = getLocal({
        https: {
            keyPath: './test/fixtures/test-ca.key',
            certPath: './test/fixtures/test-ca.pem'
        }
    });

    let badServer = getLocal({
        https: {
            keyPath: './test/fixtures/untrusted-ca.key',
            certPath: './test/fixtures/untrusted-ca.pem'
        }
    });

    beforeEach(async () => {
        await badServer.start(),
        await goodServer.start()
    });

    const expectNoClientErrors = watchForEvent('client-error', goodServer, badServer);

    afterEach(() => Promise.all([
        badServer.stop(),
        goodServer.stop()
    ]));

    it("should not be sent for successful requests", async () => {
        let seenTlsErrorPromise = getDeferred<TlsRequest>();
        await goodServer.on('tls-client-error', (r) => seenTlsErrorPromise.resolve(r));

        await fetch(goodServer.urlFor("/").replace('http:', 'https:'));

        await expect(Promise.race([
            seenTlsErrorPromise,
            delay(100).then(() => { throw new Error('timeout') })
        ])).to.be.rejectedWith('timeout');

        await expectNoClientErrors();
    });

    it("should be sent for requests from clients that reject the certificate initially", async () => {
        let seenTlsErrorPromise = getDeferred<TlsRequest>();
        await badServer.on('tls-client-error', (r) => seenTlsErrorPromise.resolve(r));

        await expect(
            fetch(badServer.urlFor("/"))
        ).to.be.rejectedWith(
            // Broken by bad TS handling of overrides, see
            // https://github.com/DefinitelyTyped/DefinitelyTyped/pull/37292
            (isNode ? /certificate/ : 'Failed to fetch') as any
        );

        const tlsError = await seenTlsErrorPromise;

        expect(tlsError.failureCause).to.be.oneOf([
            // Depends on specific client behaviour:
            'reset', // Node 12
            'closed', // Node 10
            'cert-rejected' // Chrome
        ]);
        expect(tlsError.hostname).to.equal('localhost');
        expect(tlsError.remoteIpAddress).to.be.oneOf([
            '::ffff:127.0.0.1', // IPv4 localhost
            '::1' // IPv6 localhost
        ]);
        expect(tlsError.tags).to.deep.equal([]);

        await expectNoClientErrors();
    });

    it("should be sent for requests that reject the cert, using the deprecated alias", async () => {
        let seenTlsErrorPromise = getDeferred<TlsRequest>();
        await badServer.on('tlsClientError', (r) => seenTlsErrorPromise.resolve(r));

        await expect(
            fetch(badServer.urlFor("/"))
        ).to.be.rejectedWith(
            // Broken by bad TS handling of overrides, see
            // https://github.com/DefinitelyTyped/DefinitelyTyped/pull/37292
            (isNode ? /certificate/ : 'Failed to fetch') as any
        );

        const tlsError = await seenTlsErrorPromise;

        expect(tlsError.failureCause).to.be.oneOf([
            // Depends on specific client behaviour:
            'reset', // Node 12
            'closed', // Node 10
            'cert-rejected' // Chrome
        ]);

        await expectNoClientErrors();
    });

    nodeOnly(() => {
        it("should be sent for requests from clients that reject the certificate for the upstream server", async () => {
            let seenTlsErrorPromise = getDeferred<TlsRequest>();
            await badServer.on('tls-client-error', (r) => seenTlsErrorPromise.resolve(r));
            await badServer.anyRequest().thenPassThrough();

            await expect(
                fetch(goodServer.urlFor("/"), <any> {
                    // Ignores proxy cert issues by using the proxy via plain HTTP
                    agent: new HttpsProxyAgent({
                        protocol: 'http',
                        host: 'localhost',
                        port: badServer.port
                    })
                })
            ).to.be.rejectedWith(/certificate/);

            const tlsError = await seenTlsErrorPromise;
            expect(tlsError.failureCause).to.equal('closed');
            expect(tlsError.hostname).to.equal('localhost');
            expect(tlsError.remoteIpAddress).to.equal('::ffff:127.0.0.1');

            await expectNoClientErrors();
        });

        it("should not be sent for requests from TLS clients that reset later in the connection", async () => {
            let seenTlsErrorPromise = getDeferred<TlsRequest>();
            await goodServer.on('tls-client-error', (r) => seenTlsErrorPromise.resolve(r));

            let seenClientErrorPromise = getDeferred<ClientError>();
            await goodServer.on('client-error', (e) => seenClientErrorPromise.resolve(e));

            const tlsSocket = await openRawTlsSocket(goodServer);
            writeAndReset(tlsSocket, "GET / HTTP/1.1\r\n\r\n");

            const seenTlsError = await Promise.race([
                delay(100).then(() => false),
                seenTlsErrorPromise
            ]);
            expect(seenTlsError).to.equal(false);

            // No TLS error, but we do expect a client reset error:
            expect((await seenClientErrorPromise).errorCode).to.equal('ECONNRESET');
        });

        it("should not be sent for requests from non-TLS clients that reset before sending anything", async () => {
            let seenTlsErrorPromise = getDeferred<TlsRequest>();
            await goodServer.on('tls-client-error', (r) => seenTlsErrorPromise.resolve(r));

            const tlsSocket = await openRawSocket(goodServer);
            writeAndReset(tlsSocket, ""); // Send nothing, just connect & RESET

            const seenTlsError = await Promise.race([
                delay(100).then(() => false),
                seenTlsErrorPromise
            ]);
            expect(seenTlsError).to.equal(false);

            await expectNoClientErrors();
        });
    });
});

describe("Client error subscription", () => {
    describe("with a local HTTP server", () => {
        let server = getLocal();

        beforeEach(() => server.start());

        const expectNoTlsErrors = watchForEvent('tls-client-error', server);

        afterEach(async () => {
            await expectNoTlsErrors();
            await server.stop();
        });

        it("should report error responses from header overflows", async () => {
            let errorPromise = getDeferred<ClientError>();
            await server.on('client-error', (e) => errorPromise.resolve(e));

            fetch(server.urlFor("/mocked-endpoint"), {
                headers: {
                    "long-value": _.range(TOO_LONG_HEADER_SIZE).map(() => "X").join("")
                }
            }).catch(() => {});

            let clientError = await errorPromise;

            expect(clientError.errorCode).to.equal("HPE_HEADER_OVERFLOW");
            expect(clientError.request.method).to.equal("GET");
            expect(clientError.request.url).to.equal(server.urlFor("/mocked-endpoint"));
            expect(clientError.request.headers['Host']).to.equal(`localhost:${server.port}`);

            const response = clientError.response as CompletedResponse;
            expect(response.statusCode).to.equal(431);
            expect(response.statusMessage).to.equal("Request Header Fields Too Large");
            expect(response.tags).to.deep.equal([
                'client-error:HPE_HEADER_OVERFLOW',
                'header-overflow'
            ]);
        });

        nodeOnly(() => {
            it("should report error responses from invalid HTTP versions", async () => {
                let errorPromise = getDeferred<ClientError>();
                await server.on('client-error', (e) => errorPromise.resolve(e));

                sendRawRequest(server, 'GET https://example.com HTTP/0\r\n\r\n');

                let clientError = await errorPromise;

                expect(clientError.errorCode).to.equal("HPE_INVALID_VERSION");
                expect(clientError.request.method).to.equal("GET");
                expect(clientError.request.httpVersion).to.equal("0");
                expect(clientError.request.url).to.equal("https://example.com");

                const response = clientError.response as CompletedResponse;
                expect(response.statusCode).to.equal(400);
                expect(response.statusMessage).to.equal("Bad Request");
                expect(response.body.text).to.equal("");
                expect(response.tags).to.deep.equal(['client-error:HPE_INVALID_VERSION']);
            });

            it("should report error responses from unparseable requests", async () => {
                let errorPromise = getDeferred<ClientError>();
                await server.on('client-error', (e) => errorPromise.resolve(e));

                sendRawRequest(server, '?? ??\r\n\r\n');

                let clientError = await errorPromise;

                expect(clientError.errorCode).to.equal("HPE_INVALID_METHOD");
                expect(clientError.request.method).to.equal("??");
                expect(clientError.request.url).to.equal("??");

                const response = clientError.response as CompletedResponse;
                expect(response.statusCode).to.equal(400);
                expect(response.statusMessage).to.equal("Bad Request");
                expect(response.tags).to.deep.equal(['client-error:HPE_INVALID_METHOD']);
            });

            it("should report error responses from unexpected HTTP/2 requests", async () => {
                let errorPromise = getDeferred<ClientError>();
                await server.on('client-error', (e) => errorPromise.resolve(e));

                const client = (await import('http2')).connect(server.url);
                const req = client.request({ ':path': '/' });
                req.end();

                // This will fail, but that's ok for now:
                client.on('error', _.noop);
                req.on('error', _.noop);

                let clientError = await errorPromise;

                expect(clientError.errorCode).to.equal("HPE_INVALID_METHOD");
                expect(clientError.request.method).to.equal("PRI");
                expect(clientError.request.url).to.equal("*");
                expect(clientError.request.httpVersion).to.equal("2.0");

                const response = clientError.response as CompletedResponse;
                expect(response.statusCode).to.equal(505);
                expect(response.statusMessage).to.equal("HTTP Version Not Supported");
                expect(response.tags).to.deep.equal(['client-error:HPE_INVALID_METHOD', 'http-2']);
            });

            it("should notify for incomplete requests", async () => {
                let errorPromise = getDeferred<ClientError>();
                await server.on('client-error', (e) => errorPromise.resolve(e));

                await sendRawRequest(server, 'GET /');

                let clientError = await errorPromise;

                expect(clientError.errorCode).to.equal("HPE_INVALID_EOF_STATE");

                expect(clientError.request.method).to.equal(undefined);
                expect(clientError.request.url).to.equal(undefined);

                const response = clientError.response as CompletedResponse;

                expect(response.statusCode).to.equal(400);
                expect(response.statusMessage).to.equal("Bad Request");
                expect(response.tags).to.deep.equal(['client-error:HPE_INVALID_EOF_STATE']);
            });
        });
    });

    describe("with a local HTTPS server", () => {
        let server = getLocal({
            https: {
                keyPath: './test/fixtures/test-ca.key',
                certPath: './test/fixtures/test-ca.pem'
            }
        });

        beforeEach(() => server.start());
        afterEach(() => server.stop());

        const expectNoTlsErrors = watchForEvent('tls-client-error', server);

        it("should report error responses from header overflows", async () => {
            let errorPromise = getDeferred<ClientError>();
            await server.on('client-error', (e) => errorPromise.resolve(e));

            fetch(server.urlFor("/mocked-endpoint"), {
                headers: {
                    // Order here matters - if the host header appears after long-value, then we miss it
                    // in the packet buffer, and request.url is relative, not absolute
                    'host': `localhost:${server.port}`,
                    'long-value': _.range(TOO_LONG_HEADER_SIZE).map(() => "X").join("")
                }
            }).catch(() => {});

            let clientError = await errorPromise;

            expect(clientError.errorCode).to.equal("HPE_HEADER_OVERFLOW");

            if (semver.satisfies(process.version, '>=13')) {
                // Buffer overflows completely here, so parsing sees overwritten data as the start:
                expect(clientError.request.method?.slice(0, 10)).to.equal('XXXXXXXXXX');
                expect(clientError.request.url).to.equal(undefined);
            } else {
                expect(clientError.request.method).to.equal("GET");
                expect(clientError.request.url).to.equal(server.urlFor("/mocked-endpoint"));
                expect(_.find(clientError.request.headers,
                    (_v, key) => key.toLowerCase() === 'host')
                ).to.equal(`localhost:${server.port}`);
            }

            const response = clientError.response as CompletedResponse;
            expect(response.statusCode).to.equal(431);
            expect(response.statusMessage).to.equal("Request Header Fields Too Large");
            expect(response.tags).to.deep.equal([
                'client-error:HPE_HEADER_OVERFLOW',
                'header-overflow'
            ]);

            await expectNoTlsErrors();
        });

        it("should report error responses from header overflows with plain HTTP", async () => {
            let errorPromise = getDeferred<ClientError>();
            await server.on('client-error', (e) => errorPromise.resolve(e));

            const plainHttpUrl = server.urlFor("/mocked-endpoint").replace(/^https/, 'http');
            await fetch(plainHttpUrl, {
                headers: {
                    // 10KB of 'X':
                    "long-value": _.range(TOO_LONG_HEADER_SIZE).map(() => "X").join("")
                }
            }).catch(() => {});

            let clientError = await errorPromise;

            expect(clientError.errorCode).to.equal("HPE_HEADER_OVERFLOW");
            expect(clientError.request.method).to.equal("GET");
            expect(clientError.request.url).to.equal(plainHttpUrl);

            expect(clientError.request.headers['Host']).to.equal(`localhost:${server.port}`);
            expect(clientError.request.headers['long-value']?.slice(0, 10)).to.equal('XXXXXXXXXX');

            const response = clientError.response as CompletedResponse;
            expect(response.statusCode).to.equal(431);
            expect(response.statusMessage).to.equal("Request Header Fields Too Large");
            expect(response.tags).to.deep.equal([
                'client-error:HPE_HEADER_OVERFLOW',
                'header-overflow'
            ]);

            await expectNoTlsErrors();
        });

        nodeOnly(() => {
            it("should report error responses from unexpected HTTP/2 requests", async () => {
                let errorPromise = getDeferred<ClientError>();
                await server.on('client-error', (e) => errorPromise.resolve(e));

                const client = (await import('http2')).connect(server.url);
                const req = client.request({ ':path': '/' });
                req.end();

                // The above will fail, but that's ok for now:
                client.on('error', _.noop);
                req.on('error', _.noop);

                let clientError = await errorPromise;

                expect(clientError.errorCode).to.equal("HPE_INVALID_METHOD");
                expect(clientError.request.method).to.equal("PRI");
                expect(clientError.request.url).to.equal("*");
                expect(clientError.request.httpVersion).to.equal("2.0");

                const response = clientError.response as CompletedResponse;
                expect(response.statusCode).to.equal(505);
                expect(response.statusMessage).to.equal("HTTP Version Not Supported");
                expect(response.tags).to.deep.equal([
                    'client-error:HPE_INVALID_METHOD',
                    'http-2'
                ]);

                await expectNoTlsErrors();
            });

            describe("when proxying", () => {
                const INITIAL_ENV = _.cloneDeep(process.env);

                beforeEach(async () => {
                    process.env = _.merge({}, process.env, server.proxyEnv);
                });

                afterEach(async () => {
                    await expectNoTlsErrors();
                    process.env = INITIAL_ENV;
                });

                it("should report error responses from HTTP-proxied header overflows", async () => {
                    let errorPromise = getDeferred<ClientError>();
                    await server.on('client-error', (e) => errorPromise.resolve(e));
                    await server.get("http://example.com/endpoint").thenReply(200, "Mock data");

                    const response = await fetch("http://example.com/endpoint", <any> {
                        agent: new HttpsProxyAgent({
                            protocol: 'http',
                            host: 'localhost',
                            port: server.port
                        }),
                        headers: {
                            "long-value": _.range(TOO_LONG_HEADER_SIZE).map(() => "X").join("")
                        }
                    });

                    expect(response.status).to.equal(431);

                    let clientError = await errorPromise;

                    expect(clientError.errorCode).to.equal("HPE_HEADER_OVERFLOW");
                    expect(clientError.request.method).to.equal("GET");
                    expect(clientError.request.url).to.equal("http://example.com/endpoint");
                    expect(clientError.request.headers['Host']).to.equal('example.com');

                    const reportedResponse = clientError.response as CompletedResponse;
                    expect(reportedResponse.statusCode).to.equal(431);
                    expect(reportedResponse.statusMessage).to.equal("Request Header Fields Too Large");
                    expect(reportedResponse.tags).to.deep.equal([
                        'client-error:HPE_HEADER_OVERFLOW',
                        'header-overflow'
                    ]);
                });

                it("should report error responses from HTTPS-proxied header overflows", async () => {
                    let errorPromise = getDeferred<ClientError>();
                    await server.on('client-error', (e) => errorPromise.resolve(e));
                    await server.get("https://example.com/endpoint").thenReply(200, "Mock data");

                    const response = await fetch("https://example.com/endpoint", <any> {
                        agent: new HttpsProxyAgent({
                            protocol: 'https',
                            host: 'localhost',
                            port: server.port
                        }),
                        headers: {
                            // Order here matters - if the host header appears after long-value, then we miss it
                            // in the packet buffer, and request.url is relative, not absolute
                            'host': 'example.com',
                            "long-value": _.range(TOO_LONG_HEADER_SIZE).map(() => "X").join("")
                        }
                    });

                    expect(response.status).to.equal(431);

                    let clientError = await errorPromise;

                    expect(clientError.errorCode).to.equal("HPE_HEADER_OVERFLOW");

                    if (semver.satisfies(process.version, '>=13')) {
                        // Buffer overflows completely here, so parsing sees overwritten data as the start:
                        expect(clientError.request.method?.slice(0, 10)).to.equal('XXXXXXXXXX');
                        expect(clientError.request.url).to.equal(undefined);
                    } else {
                        expect(clientError.request.method).to.equal("GET");
                        expect(clientError.request.url).to.equal("https://example.com/endpoint");
                        expect(_.find(clientError.request.headers,
                            (_v, key) => key.toLowerCase() === 'host')
                        ).to.equal('example.com');
                        expect(clientError.request.headers['long-value']?.slice(0, 10)).to.equal('XXXXXXXXXX');
                    }

                    const reportResponse = clientError.response as CompletedResponse;
                    expect(reportResponse.statusCode).to.equal(431);
                    expect(reportResponse.statusMessage).to.equal("Request Header Fields Too Large");
                    expect(reportResponse.tags).to.deep.equal([
                        'client-error:HPE_HEADER_OVERFLOW',
                        'header-overflow'
                    ]);

                    await expectNoTlsErrors();
                });
            });
        });
    });

});
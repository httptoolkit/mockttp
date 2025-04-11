import * as _ from 'lodash';
import * as http from 'http';

import {
    getLocal,
    getAdminServer,
    getRemote,
    InitiatedRequest,
    CompletedRequest
} from "../../..";
import {
    expect,
    fetch,
    nodeOnly,
    getDeferred,
    sendRawRequest,
    isNode,
    defaultNodeConnectionHeader
} from "../../test-utils";
import { TimingEvents } from "../../../dist/types";

// Headers we ignore when checking the received values, because they can vary depending
// on details of the local environment (to pass in Wallaby & fail in GHA, for example)
const INCONSISTENT_HEADERS = [
    // Varies on testing ports & hostnames:
    'origin',
    'referer',

    // Varies on browser vs various Node versions:
    'connection',

    // Varies on OS config:
    'accept-language',

    // Depends on browser version:
    'user-agent',
    'accept-encoding',

    // Security headers only available in new Chrome versions:
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
];

describe("Request initiated subscriptions", () => {
    describe("with a local HTTP server", () => {
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
            expect(seenRequest.remoteIpAddress).to.be.oneOf([
                '::ffff:127.0.0.1', // IPv4 localhost
                '::1' // IPv6 localhost
            ]);
            expect(seenRequest.remotePort).to.be.greaterThanOrEqual(32768);

            expect((seenRequest as any).body).to.equal(undefined); // No body included yet
            expect((seenRequest as any).trailers).to.equal(undefined); // No trailers yet
            expect((seenRequest as any).rawTrailers).to.equal(undefined);

            const matchableHeaders = _.omit(seenRequest.headers, INCONSISTENT_HEADERS);
            expect(matchableHeaders).to.deep.equal({
                'accept': '*/*',
                'content-length': '9',
                'content-type': 'text/plain;charset=UTF-8',
                'host': `localhost:${server.port}`
            });
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
                expect((seenInitialRequest as any).trailers).to.equal(undefined);
                expect((seenInitialRequest as any).rawTrailers).to.equal(undefined);

                req.addTrailers({ 'test-trailer': 'hello' });
                req.end('end body');

                let seenCompletedRequest = await seenCompletedRequestPromise;
                expect(await seenCompletedRequest.body.getText()).to.equal('start body\nend body');
                expect(seenCompletedRequest.trailers).to.deep.equal({ 'test-trailer': 'hello' });
                expect(seenCompletedRequest.rawTrailers).to.deep.equal([['test-trailer', 'hello']]);
            });

            it("should include the raw request headers", async () => {
                let seenRequestPromise = getDeferred<InitiatedRequest>();
                await server.on('request-initiated', (r) => seenRequestPromise.resolve(r));

                http.request({
                    method: 'GET',
                    hostname: 'localhost',
                    port: server.port,
                    headers: [
                        ['UPPERCASEHEADER', 'VALUE'],
                        ['Dupe-Header', 'A'],
                        ['Dupe-Header', 'B']
                    ] as any
                }).end();

                let seenRequest = await seenRequestPromise;

                // Raw format:
                expect(seenRequest.rawHeaders).to.deep.equal([
                    ['UPPERCASEHEADER', 'VALUE'],
                    ['Dupe-Header', 'A'],
                    ['Dupe-Header', 'B'],
                    ['Connection', defaultNodeConnectionHeader]
                ]);

                // Parsed format:
                expect(seenRequest.headers).to.deep.equal({
                    connection: defaultNodeConnectionHeader,
                    uppercaseheader: 'VALUE',
                    'dupe-header': ['A', 'B']
                });
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

        it("should notify with request details as soon as they're ready", async () => {
            let seenRequestPromise = getDeferred<InitiatedRequest>();
            await server.on('request-initiated', (r) => seenRequestPromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"), { method: 'POST', body: 'body-text' });

            let seenRequest = await seenRequestPromise;
            expect(seenRequest.method).to.equal('POST');
            expect(seenRequest.protocol).to.equal('https');
            expect(seenRequest.httpVersion).to.equal('1.1');
            expect(seenRequest.url).to.equal(server.urlFor("/mocked-endpoint"));
            expect((seenRequest as any).body).to.equal(undefined); // No body included yet
            expect((seenRequest as any).trailers).to.equal(undefined); // No trailers yet
            expect((seenRequest as any).rawTrailers).to.equal(undefined);

            const matchableHeaders = _.omit(seenRequest.headers, INCONSISTENT_HEADERS);
            expect(matchableHeaders).to.deep.equal({
                'accept': '*/*',
                'content-length': '9',
                'content-type': 'text/plain;charset=UTF-8',
                'host': `localhost:${server.port}`
            });
        });
    });

    nodeOnly(() => {
        describe("with a remote client", () => {
            let adminServer = getAdminServer();
            let client = getRemote();

            before(() => adminServer.start());
            after(() => adminServer.stop());

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
                expect((seenRequest as any).trailers).to.equal(undefined); // No trailers yet
                expect((seenRequest as any).rawTrailers).to.equal(undefined);
            });

            it("should include the raw request headers", async () => {
                let seenRequestPromise = getDeferred<InitiatedRequest>();
                await client.on('request-initiated', (r) => seenRequestPromise.resolve(r));

                http.request({
                    method: 'GET',
                    hostname: 'localhost',
                    port: client.port,
                    headers: [
                        ['UPPERCASEHEADER', 'VALUE'],
                        ['Dupe-Header', 'A'],
                        ['Dupe-Header', 'B']
                    ] as any
                }).end();

                let seenRequest = await seenRequestPromise;

                // Raw format:
                expect(seenRequest.rawHeaders).to.deep.equal([
                    ['UPPERCASEHEADER', 'VALUE'],
                    ['Dupe-Header', 'A'],
                    ['Dupe-Header', 'B'],
                    ['Connection', defaultNodeConnectionHeader]
                ]);

                // Parsed format:
                expect(seenRequest.headers).to.deep.equal({
                    connection: defaultNodeConnectionHeader,
                    uppercaseheader: 'VALUE',
                    'dupe-header': ['A', 'B']
                });
            });
        });
    });
});

describe("Request subscriptions", () => {
    describe("with a local server", () => {
        let server = getLocal({
            // Disabling this exposes some possible bugs, notably that the body may not
            // be captured if the response finishes the request immediately.
            recordTraffic: false
        });

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
            expect(seenRequest.remoteIpAddress).to.be.oneOf([
                '::ffff:127.0.0.1', // IPv4 localhost
                '::1' // IPv6 localhost
            ]);
            expect(seenRequest.remotePort).to.be.greaterThanOrEqual(32768);
            expect(await seenRequest.body.getText()).to.equal('body-text');
            expect(seenRequest.rawTrailers).to.deep.equal([]);
            expect(seenRequest.trailers).to.deep.equal({});
            expect(seenRequest.tags).to.deep.equal([]);
        });

        it("should notify with the body even if the response does not wait for it", async () => {
            // The only rule here does not process the request body at all, so it's not explicitly
            // being read anywhere (except by our async event subscription)
            await server.forAnyRequest().thenReply(200);

            let seenRequestPromise = getDeferred<CompletedRequest>();
            await server.on('request', (r) => seenRequestPromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"), { method: 'POST', body: 'body-text' });

            let seenRequest = await seenRequestPromise;
            expect(await seenRequest.body.getText()).to.equal('body-text');
        });

        it("should include the matched rule id", async () => {
            let seenRequestPromise = getDeferred<CompletedRequest>();
            await server.on('request', (r) => seenRequestPromise.resolve(r));
            let endpoint = await server.forGet('/').thenReply(200);

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

                sendRawRequest(server, 'GET http://example.com HTTP/1.1\r\n\r\n');

                let seenRequest = await seenRequestPromise;
                expect(seenRequest.url).to.equal('http://example.com');
            });
        });
    });

    describe("with a local HTTP server allowing only tiny bodies", () => {

        let server = getLocal({
            maxBodySize: 10 // 10 bytes max
        });

        beforeEach(() => server.start());
        afterEach(() => server.stop());

        it("should include tiny bodies in request events", async () => {
            let seenRequestPromise = getDeferred<CompletedRequest>();
            await server.on('request', (r) => seenRequestPromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"), { method: 'POST', body: 'TinyReq' });

            let seenRequest = await seenRequestPromise;
            expect(await seenRequest.body.getText()).to.equal('TinyReq');
        });

        it("should not include larger bodies in request event", async () => {
            let seenRequestPromise = getDeferred<CompletedRequest>();
            await server.on('request', (r) => seenRequestPromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"), { method: 'POST', body: 'Larger request' });

            let seenRequest = await seenRequestPromise;
            expect(await seenRequest.body.getText()).to.equal(''); // Omitted
        });

    });

    nodeOnly(() => {
        describe("with a remote client", () => {
            let adminServer = getAdminServer();
            let client = getRemote();

            before(() => adminServer.start());
            after(() => adminServer.stop());

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
                expect(await seenRequest.body.getText()).to.equal('body-text');
                expect(seenRequest.rawTrailers).to.deep.equal([]);
                expect(seenRequest.trailers).to.deep.equal({});
                expect(seenRequest.tags).to.deep.equal([]);
            });

            it("should include request trailer details", async () => {
                let seenRequestPromise = getDeferred<CompletedRequest>();
                await client.on('request', (r) => seenRequestPromise.resolve(r));

                const req = http.request({
                    method: 'POST',
                    hostname: 'localhost',
                    port: client.port
                });

                req.write('hello');
                req.addTrailers([
                    ['test-TRAILER', 'goodbye']
                ])
                req.end();

                let seenRequest = await seenRequestPromise;
                expect(seenRequest.rawTrailers).to.deep.equal([
                    ['test-TRAILER', 'goodbye']
                ]);
                expect(seenRequest.trailers).to.deep.equal({
                    'test-trailer': 'goodbye'
                });
            });
        });
    });
});

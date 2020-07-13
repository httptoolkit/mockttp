import * as _ from 'lodash';
import * as http from 'http';

import {
    getLocal,
    getStandalone,
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
    isNode
} from "../../test-utils";
import { TimingEvents } from "../../../dist/types";

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
            expect((seenRequest as any).body).to.equal(undefined); // No body included yet

            const matchableHeaders = _.omit(seenRequest.headers, [
                'user-agent',
                'origin',
                'referer',
                'accept-language'
            ]);
            expect(matchableHeaders).to.deep.equal(isNode
                ? {
                    'accept-encoding': 'gzip,deflate',
                    'connection': 'close',
                    'accept': '*/*',
                    'content-length': '9',
                    'host': `localhost:${server.port}`
                }
                : {
                    'accept': '*/*',
                    'accept-encoding': 'gzip, deflate, br',
                    'connection': 'keep-alive',
                    'content-length': '9',
                    'content-type': 'text/plain;charset=UTF-8',
                    'host': `localhost:${server.port}`,
                    'sec-fetch-dest': 'empty',
                    'sec-fetch-mode': 'cors',
                    'sec-fetch-site': 'same-site'
                }
            );
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
            expect(seenRequest.httpVersion).to.equal(isNode
                ? '1.1'
                : '2.0'
            );
            expect(seenRequest.url).to.equal(server.urlFor("/mocked-endpoint"));
            expect((seenRequest as any).body).to.equal(undefined); // No body included yet

            const matchableHeaders = _.omit(seenRequest.headers, [
                'user-agent',
                'origin',
                'referer',
                'accept-language'
            ]);
            expect(matchableHeaders).to.deep.equal(isNode
                ? {
                    'accept-encoding': 'gzip,deflate',
                    'connection': 'close',
                    'accept': '*/*',
                    'content-length': '9',
                    'host': `localhost:${server.port}`
                }
                : { // Browsers uses HTTP/2 with HTTPS, so we get the pseudo-headers too:
                    ':authority': 'localhost:8000',
                    ':method': 'POST',
                    ':path': server.urlFor('/mocked-endpoint'),
                    ':scheme': 'https',
                    'accept': '*/*',
                    'accept-encoding': 'gzip, deflate, br',
                    'content-length': '9',
                    'content-type': 'text/plain;charset=UTF-8',
                    'sec-fetch-dest': 'empty',
                    'sec-fetch-mode': 'cors',
                    'sec-fetch-site': 'cross-site'
                }
            );
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

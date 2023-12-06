import * as _ from 'lodash';
import HttpsProxyAgent = require('https-proxy-agent');
import * as semver from 'semver';

import { getLocal, CompletedResponse } from "../../..";
import {
    expect,
    fetch,
    nodeOnly,
    getDeferred,
    delay,
    sendRawRequest,
    watchForEvent,
    TOO_LONG_HEADER_VALUE,
    isNode,
    openRawTlsSocket
} from "../../test-utils";
import { ClientError } from "../../../dist/types";

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
                    "long-value": TOO_LONG_HEADER_VALUE
                }
            }).catch(() => {});

            let clientError = await errorPromise;

            expect(clientError.errorCode).to.equal("HPE_HEADER_OVERFLOW");
            expect(clientError.request.method).to.equal("GET");
            expect(clientError.request.url).to.equal(server.urlFor("/mocked-endpoint"));

            expect(clientError.request.headers['host']).to.equal(`localhost:${server.port}`);

            const rawHeaders = clientError.request.rawHeaders;
            expect(rawHeaders.find(([key]) => key === 'Host')).to.deep.equal(
                ['Host', `localhost:${server.port}`] // Uppercase name!
            );

            // We match the long-value slightly flexibly - this can be flaky in browser tests due to flaky send
            // order (I think?) and so sometimes it's cut off.
            expect(rawHeaders.find(([key]) => key === 'long-value')![1]).to.match(/XXXXX+/);

            expect(clientError.request.remoteIpAddress).to.be.oneOf([
                '::ffff:127.0.0.1', // IPv4 localhost
                '::1' // IPv6 localhost
            ]);
            expect(clientError.request.remotePort).to.be.greaterThanOrEqual(32768);

            const response = clientError.response as CompletedResponse;
            expect(response.statusCode).to.equal(431);
            expect(response.statusMessage).to.equal("Request Header Fields Too Large");
            expect(response.headers).to.deep.equal({ 'connection': 'close' });
            expect(response.rawHeaders).to.deep.equal([['Connection', 'close']]);
            expect(response.tags).to.deep.equal([
                'client-error:HPE_HEADER_OVERFLOW',
                'header-overflow'
            ]);
        });

        nodeOnly(() => {
            it("should report error responses from invalid HTTP versions", async () => {
                let errorPromise = getDeferred<ClientError>();
                await server.on('client-error', (e) => errorPromise.resolve(e));

                sendRawRequest(server, 'POST https://example.com HTTP/0\r\n\r\n');

                let clientError = await errorPromise;

                expect(clientError.errorCode).to.equal("HPE_INVALID_VERSION");
                expect(clientError.request.method).to.equal("POST");
                expect(clientError.request.httpVersion).to.equal("0");
                expect(clientError.request.url).to.equal("https://example.com");

                const response = clientError.response as CompletedResponse;
                expect(response.statusCode).to.equal(400);
                expect(response.statusMessage).to.equal("Bad Request");
                expect(await response.body.getText()).to.equal("");
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

            it("should notify for incomplete requests", async () => {
                let errorPromise = getDeferred<ClientError>();
                await server.on('client-error', (e) => errorPromise.resolve(e));

                sendRawRequest(server, 'GET /');

                let clientError = await errorPromise;

                expect(clientError.errorCode).to.equal("HPE_INVALID_EOF_STATE");

                expect(clientError.request.method).to.equal(undefined);
                expect(clientError.request.url).to.equal(undefined);
                expect(clientError.request.tags).to.deep.equal(['client-error:HPE_INVALID_EOF_STATE']);

                const response = clientError.response as CompletedResponse;

                expect(response.statusCode).to.equal(undefined);
                expect(response.statusMessage).to.equal(undefined);
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

        it("should report error responses from header overflows with plain HTTP", async () => {
            let errorPromise = getDeferred<ClientError>();
            await server.on('client-error', (e) => errorPromise.resolve(e));

            const plainHttpUrl = server.urlFor("/mocked-endpoint").replace(/^https/, 'http');
            await fetch(plainHttpUrl, {
                headers: {
                    // 10KB of 'X':
                    "long-value": TOO_LONG_HEADER_VALUE
                }
            }).catch(() => {});

            let clientError = await errorPromise;

            expect(clientError.errorCode).to.equal("HPE_HEADER_OVERFLOW");
            expect(clientError.request.method).to.equal("GET");
            expect(clientError.request.url).to.equal(plainHttpUrl);

            expect(clientError.request.headers['host']).to.equal(`localhost:${server.port}`);
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
            it("should report error responses from header overflows", async () => {
                // Skipped in browsers, as they upgrade to HTTP/2, and header overflows seems unsupported
                let errorPromise = getDeferred<ClientError>();
                await server.on('client-error', (e) => errorPromise.resolve(e));

                fetch(server.urlFor("/mocked-endpoint"), {
                    headers: {
                        // Order here matters - if the host header appears after long-value, then we miss it
                        // in the packet buffer, and request.url is relative, not absolute
                        'host': `localhost:${server.port}`,
                        'long-value': TOO_LONG_HEADER_VALUE
                    }
                }).catch(() => {});

                let clientError = await errorPromise;

                expect(clientError.errorCode).to.equal("HPE_HEADER_OVERFLOW");
                expect(clientError.request.protocol).to.equal('https');

                // What the parser exposes when it fails is different depending on the Node version:
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

            it("should report error responses from unparseable requests only once", async () => {
                const clientErrors: ClientError[] = [];
                await server.on('client-error', (e) => clientErrors.push(e));

                sendRawRequest(server, '?? ??\r\n\r\n');
                await delay(500);

                // Because of httpolyglot first-byte peeking, parser errors can fire twice, for a
                // first invalid byte, and for the whole packet. We want the latter error only:
                expect(clientErrors.length).to.equal(1);
                expect(clientErrors[0].request.method).to.equal("??");
                expect(clientErrors[0].request.url).to.equal("??");
            });

            it("should report error responses from invalid HTTP methods", async () => {
                let errorPromise = getDeferred<ClientError>();
                await server.on('client-error', (e) => errorPromise.resolve(e));

                sendRawRequest(server, 'AABB https://example.com HTTP/1.1\r\n\r\n');

                let clientError = await errorPromise;

                expect(clientError.errorCode).to.equal("HPE_INVALID_METHOD");
                expect(clientError.request.method).to.equal("AABB");
                expect(clientError.request.httpVersion).to.equal("1.1");
                expect(clientError.request.url).to.equal("https://example.com");

                const response = clientError.response as CompletedResponse;
                expect(response.statusCode).to.equal(400);
                expect(response.statusMessage).to.equal("Bad Request");
                expect(await response.body.getText()).to.equal("");
                expect(response.tags).to.deep.equal(['client-error:HPE_INVALID_METHOD']);
            });

            it("should report HTTP/2 requests that start with a broken preface", async () => {
                await server.forGet('/').thenReply(200, "HTTP2 response!");

                const errorPromise = getDeferred<ClientError>();
                await server.on('client-error', (e) => errorPromise.resolve(e));

                const socket = await openRawTlsSocket(server, {
                    servername: `localhost:${server.port}`,
                    ALPNProtocols: ['h2']
                });

                socket.write("GET / HTTP/1.1\r\n\r\n"); // Send H1 on H2 connection
                const error = await errorPromise;
                socket.end();

                expect(error.errorCode).to.equal("ERR_HTTP2_ERROR");
                expect(error.request.tags).to.deep.equal([
                    'client-error:ERR_HTTP2_ERROR',
                    'client-error:bad-preface'
                ]);
                expect(error.request.url).to.equal(server.url + '/');
                expect(error.response).to.equal('aborted');
            });

            it("should report HTTP/2 requests that fail after the preface", async () => {
                await server.forGet('/').thenReply(200, "HTTP2 response!");

                const errorPromise = getDeferred<ClientError>();
                await server.on('client-error', (e) => errorPromise.resolve(e));

                const socket = await openRawTlsSocket(server, {
                    servername: `localhost:${server.port}`,
                    ALPNProtocols: ['h2']
                });

                socket.write("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"); // Send the HTTP/2 preface
                socket.write("GET / HTTP/1.1\r\n\r\n"); // Send raw H1 afterwards
                const error = await errorPromise;
                socket.end();

                expect(error.errorCode).to.equal("ERR_HTTP2_ERROR");
                expect(error.request.tags).to.deep.equal([
                    'client-error:ERR_HTTP2_ERROR'
                ]);
                expect(error.request.url).to.equal(server.url + '/');
                expect(error.response).to.equal('aborted');
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
                    await server.forGet("http://example.com/endpoint").thenReply(200, "Mock data");

                    const response = await fetch("http://example.com/endpoint", <any> {
                        agent: new HttpsProxyAgent({
                            protocol: 'http',
                            host: 'localhost',
                            port: server.port
                        }),
                        headers: {
                            "long-value": TOO_LONG_HEADER_VALUE
                        }
                    });

                    expect(response.status).to.equal(431);

                    let clientError = await errorPromise;

                    expect(clientError.errorCode).to.equal("HPE_HEADER_OVERFLOW");
                    expect(clientError.request.method).to.equal("GET");
                    expect(clientError.request.url).to.equal("http://example.com/endpoint");
                    expect(clientError.request.headers['host']).to.equal('example.com');

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
                    await server.forGet("https://example.com/endpoint").thenReply(200, "Mock data");

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
                            "long-value": TOO_LONG_HEADER_VALUE
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
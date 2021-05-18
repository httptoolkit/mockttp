import { PassThrough } from "stream";
import * as net from 'net';
import * as portfinder from 'portfinder';
import request = require("request-promise-native");
import * as WebSocket from 'universal-websocket-client';

import { getLocal, getRemote, getStandalone, Mockttp } from "../..";
import { expect, fetch, nodeOnly, browserOnly } from "../test-utils";

browserOnly(() => {
    describe("Remote browser client with a standalone server", function () {

        describe("with a default configuration", () => {
            let client = getLocal();

            beforeEach(() => client.start());
            afterEach(() => client.stop());

            it("should find the standalone server and successfully mock a request", async () => {
                await client.get("/mocked-endpoint").thenReply(200, "mocked data");

                const response = fetch(client.urlFor("/mocked-endpoint"));

                await expect(response).to.have.responseText("mocked data");
            });
        });
    });
});

nodeOnly(() => {
    describe("Remote node client with a standalone server", function () {

        describe("with no configuration", () => {
            let server = getStandalone();
            let client = getRemote();

            before(() => server.start());
            after(() => server.stop());

            beforeEach(() => client.start());
            afterEach(() => client.stop());

            it("should successfully mock a request as normal", async () => {
                await client.get("/mocked-endpoint").thenReply(200, "mocked data");

                const response = await request.get(client.urlFor("/mocked-endpoint"));

                expect(response).to.equal("mocked data");
            });

            it("should successfully mock requests with live callbacks", async () => {
                let count = 0;
                await client.get("/mocked-endpoint").thenCallback((req) => {
                    return { statusCode: 200, body: `calls: ${++count}` }
                });

                const response1 = await request.get(client.urlFor("/mocked-endpoint"));
                expect(response1).to.equal("calls: 1");
                const response2 = await request.get(client.urlFor("/mocked-endpoint"));
                expect(response2).to.equal("calls: 2");
            });

            describe("proxying to a remote server", () => {
                const targetServer = getLocal();

                beforeEach(() => targetServer.start());
                afterEach(() => targetServer.stop());

                it("should successfully rewrite requests with live callbacks", async () => {
                    targetServer.post('/different-endpoint').thenCallback(async (req) => ({
                        statusCode: 200,
                        body: `response, body: ${await req.body.getText()}`,
                        headers: { 'my-header': 'real value' }
                    }));

                    await client.get(targetServer.url).thenPassThrough({
                        beforeRequest: (req) => ({
                            method: 'POST',
                            url: req.url.replace(/\/$/, '/different-endpoint'),
                            body: 'injected'
                        }),
                        beforeResponse: async (res) => ({
                            statusCode: 201,
                            headers: Object.assign(res.headers, {
                                'intercepted-response': 'true'
                            }),
                            body: Buffer.from(await res.body.getText() + ' (intercepted response)')
                        })
                    });

                    const response = await request.get(targetServer.url, {
                        proxy: client.urlFor("/"),
                        resolveWithFullResponse: true
                    });

                    expect(response.statusCode).to.equal(201);
                    expect(response.headers).to.include({
                        'my-header': 'real value',
                        'intercepted-response': 'true'
                    });
                    expect(response.body).to.equal(
                        'response, body: injected (intercepted response)'
                    );
                });

                it("should successfully inject responses with a beforeRequest callback", async () => {
                    const targetEndpoint = await targetServer.post('/').thenReply(404);
                    await client.get(targetServer.url).thenPassThrough({
                        beforeRequest: (() => ({
                            response: {
                                statusCode: 200,
                                headers: { 'intercepted-response': 'true' },
                                body: Buffer.from('injected response body')
                            }
                        }))
                    });

                    const response = await request.get(targetServer.url, {
                        proxy: client.urlFor("/"),
                        resolveWithFullResponse: true
                    });

                    expect(response.statusCode).to.equal(200);
                    expect(response.headers).to.include({
                        'intercepted-response': 'true'
                    });
                    expect(response.body).to.equal(
                        'injected response body'
                    );

                    expect(await targetEndpoint.getSeenRequests()).to.deep.equal([]);
                });
            });

            it("should successfully mock requests with live streams", async () => {
                let stream1 = new PassThrough();
                await client.get('/stream').thenStream(200, stream1);
                let stream2 = new PassThrough();
                await client.get('/stream').thenStream(200, stream2);

                stream1.end('Hello');
                stream2.end('World');

                let response1 = await fetch(client.urlFor('/stream'));
                let response2 = await fetch(client.urlFor('/stream'));

                await expect(response1).to.have.status(200);
                await expect(response1).to.have.responseText('Hello');
                await expect(response2).to.have.status(200);
                await expect(response2).to.have.responseText('World');
            });

            it("should let you verify requests as normal", async () => {
                const endpointMock = await client.get("/mocked-endpoint").thenReply(200, "mocked data");
                await request.get(client.urlFor("/mocked-endpoint"));

                const seenRequests = await endpointMock.getSeenRequests();
                expect(seenRequests.length).to.equal(1);

                expect(seenRequests[0].protocol).to.equal('http');
                expect(seenRequests[0].method).to.equal('GET');
                expect(seenRequests[0].httpVersion).to.equal('1.1');
                expect(seenRequests[0].url).to.equal(
                    client.urlFor("/mocked-endpoint")
                );
            });

            it("should allow resetting the mock server configured responses", async () => {
                await client.get("/mocked-endpoint").thenReply(200, "mocked data");

                await client.reset();
                const result = await request.get(client.urlFor("/mocked-endpoint")).catch((e) => e);

                expect(result).to.be.instanceof(Error);
                expect(result.statusCode).to.equal(503);
                expect(result.message).to.include("No rules were found matching this request");
            });

            it("should allow resetting the mock server recorded requests", async () => {
                const endpointMock = await client.get("/mocked-endpoint").thenReply(200, "mocked data");
                await request.get(client.urlFor("/mocked-endpoint"));

                await client.reset();
                const result = await endpointMock.getSeenRequests().catch((e) => e);

                expect(result).to.be.instanceof(Error);
                expect(result.message).to.include("Can't get seen requests for unknown mocked endpoint");
            });

            it("should reset the server if a client leaves and rejoins", async () => {
                await client.get("/mocked-endpoint").thenReply(200, "mocked data");

                const port = client.port!;
                await client.stop();
                await client.start(port);
                const result = await request.get(client.urlFor("/mocked-endpoint")).catch((e) => e);

                expect(result).to.be.instanceof(Error);
                expect(result.statusCode).to.equal(503);
                expect(result.message).to.include("No rules were found matching this request");
            });

            it("should reject multiple clients trying to control the same port", async () => {
                const port = client.port!;

                await expect(getRemote().start(port))
                    .to.eventually.be.rejectedWith(`Cannot start: mock server is already running on port ${port}`);
            });

            describe("given another service using a port", () => {
                let port: number;
                let server: net.Server;

                beforeEach(async () => {
                    server = net.createServer(() => {});
                    port = await portfinder.getPortPromise();
                    return new Promise(resolve => server.listen(port, resolve));
                });

                afterEach(() => {
                    return new Promise(resolve => server.close(resolve));
                });

                it("should reject Mockttp clients trying to use that port", async () => {
                    await expect(getRemote().start(port))
                        .to.eventually.be.rejectedWith(/Failed to start server: listen EADDRINUSE/);
                });
            });
        });

        describe("with a provided default configuration", () => {
            let server = getStandalone({
                serverDefaults: {
                    https: {
                        keyPath: './test/fixtures/test-ca.key',
                        certPath: './test/fixtures/test-ca.pem'
                    }
                }
            });
            let client = getRemote();

            before(() => server.start());
            after(() => server.stop());

            beforeEach(() => client.start());
            afterEach(() => client.stop());

            it("should use the provided configuration by default", async () => {
                expect(client.url.split('://')[0]).to.equal('https');
            });
        });


        describe("with strict CORS configured", () => {
            let server = getStandalone({
                corsOptions: {
                    origin: 'https://example.com',
                    strict: true
                }
            });

            let client: Mockttp;

            before(() => server.start());
            after(() => server.stop());

            afterEach(() => client.stop());

            it("rejects clients with no origin", async () => {
                client = getRemote();

                await expect(client.start()).to.be.rejectedWith('403');
            });

            it("rejects clients with the wrong origin", async () => {
                client = getRemote({
                    client: {
                        headers: {
                            origin: 'https://twitter.com'
                        }
                    }
                });

                await expect(client.start()).to.be.rejectedWith('403');
            });

            it("rejects clients with the wrong origin protocol", async () => {
                client = getRemote({
                    client: {
                        headers: {
                            origin: 'http://example.com'
                        }
                    }
                });

                await expect(client.start()).to.be.rejectedWith('403');
            });

            it("allows clients that specify the correct origin", async () => {
                client = getRemote({
                    client: {
                        headers: {
                            origin: 'https://example.com'
                        }
                    }
                });

                await expect(client.start()).to.eventually.equal(undefined);
            });

            it("rejects subscriptions for clients that specify no origin", async () => {
                client = getRemote({
                    client: {
                        headers: {
                            origin: 'https://example.com'
                        }
                    }
                });

                await client.start();

                // Manually send a subscription socket with no Origin (can't start an invalid client
                // and test, because the client fails to start given a bad origin)
                const ws = new WebSocket(`http://localhost:45454/server/${client.port}/subscription`);

                await expect(new Promise((resolve, reject) => {
                    ws.addEventListener('open', resolve);
                    ws.addEventListener('error', reject);
                })).to.eventually.be.rejectedWith("socket hang up");
            });

            it("rejects subscriptions for clients that specify the wrong origin", async () => {
                client = getRemote({
                    client: {
                        headers: {
                            origin: 'https://example.com'
                        }
                    }
                });

                await client.start();

                // Manually send a subscription socket with the wrong Origin (can't start an invalid client
                // and test, because the client fails to start given a bad origin)
                const ws = new WebSocket(`http://localhost:45454/server/${client.port}/subscription`, {
                    headers: {
                        origin: 'https://twitter.com'
                    }
                } as any);

                await expect(new Promise((resolve, reject) => {
                    ws.addEventListener('open', resolve);
                    ws.addEventListener('error', reject);
                })).to.eventually.be.rejectedWith("socket hang up");
            });

            it("allows subscriptions for clients that specify the correct origin", async () => {
                client = getRemote({
                    client: {
                        headers: {
                            origin: 'https://example.com'
                        }
                    }
                });

                await client.start();

                // Manually send a subscription socket with the right Origin for consistency with above
                const ws = new WebSocket(`http://localhost:45454/server/${client.port}/subscription`, {
                    headers: {
                        origin: 'https://example.com'
                    }
                } as any);

                await expect(new Promise((resolve, reject) => {
                    ws.addEventListener('open', resolve);
                    ws.addEventListener('error', reject);
                })).to.eventually.not.equal(undefined);

                // Check the standard on() subscriptions work OK too:
                await expect(client.on('response', () => {})).to.eventually.equal(undefined);
            });
        });

        describe("with no server available", () => {
            it("fails to mock responses", async () => {
                let client = getRemote();

                await expect(client.start())
                    .to.eventually.be.rejectedWith('Failed to connect to standalone server at http://localhost:45454');
            });
        });

    });
});
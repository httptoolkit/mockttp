import { PassThrough } from "stream";
import * as net from 'net';
import * as portfinder from 'portfinder';
import request = require("request-promise-native");

import * as WebSocket from 'isomorphic-ws';
import type * as Ws from 'ws';

import { getLocal, getRemote, getStandalone, resetStandalone, Mockttp, CompletedRequest } from "../..";
import { expect, fetch, nodeOnly, browserOnly, delay, getDeferred } from "../test-utils";

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

            const server = getStandalone();
            const client = getRemote();

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

                it("should successfully replace request & response bodies", async () => {
                    // Echo the incoming request
                    await targetServer.anyRequest().thenCallback(async (req) => ({
                        status: 200,
                        json: {
                            url: req.url,
                            method: req.method,
                            headers: req.headers,
                            body: await req.body.getText(),
                        }
                    }));

                    await client.post(targetServer.urlFor('/req')).thenPassThrough({
                        transformRequest: {
                            replaceBody: 'request-body'
                        }
                    });

                    expect(await request.post(targetServer.urlFor('/req'), {
                        proxy: client.urlFor("/"),
                        json: true
                    })).to.deep.equal({
                        url: `http://localhost:${targetServer.port}/req`,
                        method: 'POST',
                        headers: {
                            host: `localhost:${targetServer.port}`,
                            accept: 'application/json',
                            'content-length': '12',
                            connection: 'close'
                        },
                        body: 'request-body'
                    });

                    await client.post(targetServer.urlFor('/res')).thenPassThrough({
                        transformResponse: {
                            replaceBody: 'replaced-response-body'
                        }
                    });

                    expect(await request.post(targetServer.urlFor('/res'), {
                        proxy: client.urlFor("/"),
                        json: true
                    })).to.equal(
                        'replaced-response-body'
                    );
                });

                it("should successfully update request & response body JSON", async () => {
                    // Echo the incoming request
                    await targetServer.anyRequest().thenCallback(async (req) => ({
                        status: 200,
                        json: {
                            url: req.url,
                            method: req.method,
                            headers: req.headers,
                            body: await req.body.getText(),
                        }
                    }));

                    await client.post(targetServer.urlFor('/req')).thenPassThrough({
                        transformRequest: {
                            updateHeaders: {
                                'custom-header': undefined, // Remove
                                'injected-header': 'injected-value' // Add
                            },
                            updateJsonBody: {
                                initialValue: undefined, // Remove
                                replacementValue: true // Add
                            }
                        }
                    });

                    expect(await request.post(targetServer.urlFor('/req'), {
                        proxy: client.urlFor("/"),
                        json: true,
                        headers: {
                            'custom-header': 'a custom value'
                        },
                        body: {
                            initialValue: true
                        }
                    })).to.deep.equal({
                        url: `http://localhost:${targetServer.port}/req`,
                        method: 'POST',
                        headers: {
                            host: `localhost:${targetServer.port}`,
                            accept: 'application/json',
                            'content-type': 'application/json',
                            'content-length': '25',
                            connection: 'close',
                            'injected-header': 'injected-value' // Only injected header remains
                        },
                        body: JSON.stringify({
                            // Initial value is removed, only replacement remains:
                            replacementValue: true
                        })
                    });

                    await client.post(targetServer.urlFor('/res')).thenPassThrough({
                        transformResponse: {
                            updateHeaders: {
                                'custom-header': undefined, // Remove
                                'injected-header': 'injected-value' // Add
                            },
                            updateJsonBody: {
                                method: 'REPLACEMENT METHOD',
                                headers: undefined
                            }
                        }
                    });

                    const response = await request.post(targetServer.urlFor('/res'), {
                        proxy: client.urlFor("/"),
                        json: true,
                        resolveWithFullResponse: true
                    });

                    expect(response.headers).to.deep.equal({
                        'access-control-allow-origin': '*',
                        'content-type': 'application/json',
                        'injected-header': 'injected-value'
                    });

                    expect(response.body).to.deep.equal({
                        url: `http://localhost:${targetServer.port}/res`,
                        // Method field replaced, headers field removed:
                        method: 'REPLACEMENT METHOD',
                        body: ''
                    });
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

            it("should support explicitly resetting all servers", async () => {
                await client.get("/mocked-endpoint").thenReply(200, "mocked data");

                await resetStandalone();

                const result = await request.get(client.urlFor("/mocked-endpoint")).catch((e) => e);

                expect(result).to.be.instanceof(Error);
                expect(result.cause.code).to.equal('ECONNREFUSED');
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
                    return new Promise<void>(resolve => server.listen(port, resolve));
                });

                afterEach(() => {
                    return new Promise<unknown>(resolve => server.close(resolve));
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

        describe("before the mock server is running", () => {

            const standaloneServer = getStandalone();

            const client1 = getRemote();
            const client2 = getRemote();

            afterEach(() => Promise.all([
                client1.stop(),
                client2.stop()
            ]));

            beforeEach(() => standaloneServer.start());
            afterEach(() => standaloneServer.stop());

            it("should expose events for mock server start & stop", async () => {
                let startedServers: number[] = [];
                let stoppedServers: number[] = [];

                standaloneServer.on('mock-server-started', (server) => startedServers.push(server.port));
                standaloneServer.on('mock-server-stopping', (server) => stoppedServers.push(server.port));

                expect(startedServers).to.deep.equal([]);
                expect(stoppedServers).to.deep.equal([]);

                await client1.start();
                const port1 = client1.port;
                expect(startedServers).to.deep.equal([port1]);
                expect(stoppedServers).to.deep.equal([]);

                await client2.start();
                const port2 = client2.port;
                expect(startedServers).to.deep.equal([port1, port2]);
                expect(stoppedServers).to.deep.equal([]);

                await client1.stop();
                expect(startedServers).to.deep.equal([port1, port2]);
                expect(stoppedServers).to.deep.equal([port1]);

                await client2.stop();
                expect(startedServers).to.deep.equal([port1, port2]);
                expect(stoppedServers).to.deep.equal([port1, port2]);
            });

            it("can handle unexpected subscription disconnections", async () => {
                await client1.start();

                let seenRequestPromise = getDeferred<CompletedRequest>();
                await client1.on('request', (r) => seenRequestPromise.resolve(r));

                // Forcefully kill the /subscription websocket connection, so that all
                // active subscriptions are disconnected:
                const subWsServer: Ws.Server = (standaloneServer as any)
                    .servers[client1.port].subscriptionServer.wsServer;
                subWsServer.clients.forEach((socket: Ws) => socket.terminate());
                await delay(500); // Wait for the disconnect & subsequent reconnect to complete

                await fetch(client1.urlFor("/mocked-endpoint"));

                // Did the subscription still work?
                const seenRequest = await seenRequestPromise;
                expect(seenRequest.url).to.equal(client1.urlFor("/mocked-endpoint"));
            });

            it("can handle unexpected stream disconnections", async () => {
                await client1.start();

                await client1.get("/mocked-endpoint").thenCallback(() => {
                    return { statusCode: 200, body: 'Mock response' }
                });

                // Forcefully kill the /stream websocket connection, so that dynamic
                // handlers & matchers are disconnected:
                const streamWsServer: Ws.Server = (standaloneServer as any)
                    .servers[client1.port].streamServer;
                streamWsServer.clients.forEach((socket: Ws) => socket.terminate());
                await delay(200); // Wait for the disconnect & subsequent reconnect to complete

                const response = await request.get(client1.urlFor("/mocked-endpoint"));
                expect(response).to.equal("Mock response");
            });

            it("doesn't reconnect after an intentional reset", async () => {
                await client1.start();
                const clientPort = client1.port;

                await resetStandalone();
                await client2.start(clientPort);

                // Client 1 should be broken now, because it was reset. It should _not_ try to
                // reconnect and end up taking over client 2's server.
                await expect(() =>
                    client1.port
                ).to.throw('Cannot get port before server is started');
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
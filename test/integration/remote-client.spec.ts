import { PassThrough } from "stream";
import * as net from 'net';
import * as portfinder from 'portfinder';
import request = require("request-promise-native");

import * as WebSocket from 'isomorphic-ws';
import type * as Ws from 'ws';

import {
    getLocal,
    getRemote,
    getAdminServer,
    resetAdminServer,
    Mockttp,
    CompletedRequest,
    MOCKTTP_PARAM_REF
} from "../..";
import { expect, fetch, nodeOnly, browserOnly, delay, getDeferred } from "../test-utils";
import type { MockttpClient } from "../../dist/client/mockttp-client";

browserOnly(() => {
    describe("Remote browser client with an admin server", function () {

        describe("with a default configuration", () => {
            let mockServer = getLocal();

            beforeEach(() => mockServer.start());
            afterEach(() => mockServer.stop());

            it("should find the admin server and successfully mock a request", async () => {
                await mockServer.forGet("/mocked-endpoint").thenReply(200, "mocked data");

                const response = fetch(mockServer.urlFor("/mocked-endpoint"));

                await expect(response).to.have.responseText("mocked data");
            });
        });
    });
});

nodeOnly(() => {
    describe("Remote node client with an admin server", function () {

        describe("with no configuration", () => {

            const server = getAdminServer();
            const remoteServer = getRemote();

            before(() => server.start());
            after(() => server.stop());

            beforeEach(() => remoteServer.start());
            afterEach(() => remoteServer.stop());

            it("should successfully mock a request as normal", async () => {
                await remoteServer.forGet("/mocked-endpoint").thenReply(200, "mocked data");

                const response = await request.get(remoteServer.urlFor("/mocked-endpoint"));

                expect(response).to.equal("mocked data");
            });

            it("should successfully mock requests with live callbacks", async () => {
                let count = 0;
                await remoteServer.forGet("/mocked-endpoint").thenCallback((req) => {
                    return { statusCode: 200, body: `calls: ${++count}` }
                });

                const response1 = await request.get(remoteServer.urlFor("/mocked-endpoint"));
                expect(response1).to.equal("calls: 1");
                const response2 = await request.get(remoteServer.urlFor("/mocked-endpoint"));
                expect(response2).to.equal("calls: 2");
            });

            describe("proxying to a remote server", () => {
                const targetServer = getLocal();

                beforeEach(() => targetServer.start());
                afterEach(() => targetServer.stop());

                it("should successfully rewrite requests with live callbacks", async () => {
                    targetServer.forPost('/different-endpoint').thenCallback(async (req) => ({
                        statusCode: 200,
                        body: `response, body: ${await req.body.getText()}`,
                        headers: { 'my-header': 'real value' }
                    }));

                    await remoteServer.forGet(targetServer.url).thenPassThrough({
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
                        proxy: remoteServer.urlFor("/"),
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
                    const targetEndpoint = await targetServer.forPost('/').thenReply(404);
                    await remoteServer.forGet(targetServer.url).thenPassThrough({
                        beforeRequest: (() => ({
                            response: {
                                statusCode: 200,
                                headers: { 'intercepted-response': 'true' },
                                body: Buffer.from('injected response body')
                            }
                        }))
                    });

                    const response = await request.get(targetServer.url, {
                        proxy: remoteServer.url,
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
                    await targetServer.forAnyRequest().thenCallback(async (req) => ({
                        status: 200,
                        json: {
                            url: req.url,
                            method: req.method,
                            headers: req.headers,
                            body: await req.body.getText(),
                        }
                    }));

                    await remoteServer.forPost(targetServer.urlFor('/req')).thenPassThrough({
                        transformRequest: {
                            replaceBody: 'request-body'
                        }
                    });

                    expect(await request.post(targetServer.urlFor('/req'), {
                        proxy: remoteServer.urlFor("/"),
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

                    await remoteServer.forPost(targetServer.urlFor('/res')).thenPassThrough({
                        transformResponse: {
                            replaceBody: 'replaced-response-body'
                        }
                    });

                    expect(await request.post(targetServer.urlFor('/res'), {
                        proxy: remoteServer.urlFor("/"),
                        json: true
                    })).to.equal(
                        'replaced-response-body'
                    );
                });

                it("should successfully update request & response body JSON", async () => {
                    // Echo the incoming request
                    await targetServer.forAnyRequest().thenCallback(async (req) => ({
                        status: 200,
                        json: {
                            url: req.url,
                            method: req.method,
                            headers: req.headers,
                            body: await req.body.getText(),
                        }
                    }));

                    await remoteServer.forPost(targetServer.urlFor('/req')).thenPassThrough({
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
                        proxy: remoteServer.urlFor("/"),
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

                    await remoteServer.forPost(targetServer.urlFor('/res')).thenPassThrough({
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
                        proxy: remoteServer.urlFor("/"),
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

                it("should successfully update request & response body via pattern", async () => {
                    // Echo the incoming request
                    await targetServer.forAnyRequest().thenCallback(async (req) => ({
                        status: 200,
                        json: {
                            url: req.url,
                            method: req.method,
                            headers: req.headers,
                            body: await req.body.getText(),
                        }
                    }));

                    await remoteServer.forPost(targetServer.urlFor('/req')).thenPassThrough({
                        transformRequest: {
                            matchReplaceBody: [
                                [/i/gi, '1'] // Should be applied and preserve flags
                            ]
                        },
                        transformResponse: {
                            matchReplaceBody: [
                                // Both should be applied in series, with the same semantics as
                                // string.replace (i.e. first match only)
                                ['localhost', 'onceUpdatedHost'],
                                ['onceUpdatedHost', 'twiceUpdatedHost']
                            ]
                        },
                    });

                    expect(await request.post(targetServer.urlFor('/req'), {
                        proxy: remoteServer.urlFor("/"),
                        json: true,
                        body: {
                            InitialValue: true
                        }
                    })).to.deep.equal({
                        url: `http://twiceUpdatedHost:${targetServer.port}/req`, // Two-step replace
                        method: 'POST',
                        headers: {
                            host: `localhost:${targetServer.port}`, // Each replace applies only once
                            accept: 'application/json',
                            'content-type': 'application/json',
                            'content-length': '21',
                            connection: 'close'
                        },
                        body: JSON.stringify({
                            // Request body was separately transformed:
                            '1n1t1alValue': true
                        })
                    });
                });

                it("should support proxy configuration specified by a callback", async () => {
                    // Remote server sends fixed response:
                    const targetEndpoint = await targetServer.forAnyRequest().thenReply(200, "Remote server says hi!");

                    // Mockttp forwards requests via our intermediate proxy (configured with a remote client + callback)
                    await remoteServer.forAnyRequest().thenPassThrough({
                        proxyConfig: ({ hostname }) => {
                            expect(hostname).to.equal('localhost');
                            return { proxyUrl: targetServer.url }
                        }
                    });

                    const response = await request.get(remoteServer.urlFor("/test-url"), {
                        proxy: remoteServer.url
                    });

                    // We get a successful response
                    expect(response).to.equal("Remote server says hi!");
                    // And it went via the intermediate proxy
                    expect((await targetEndpoint.getSeenRequests()).length).to.equal(1);
                });

                it("should support proxy configuration specified by a proxy config array", async () => {
                    // Remote server sends fixed response:
                    const targetEndpoint = await targetServer.forAnyRequest().thenReply(200, "Remote server says hi!");

                    let firstCallbackCalled = false;
                    let secondCallbackCalled = false;

                    // Mockttp forwards requests via our intermediate proxy (configured with a remote client + callback)
                    await remoteServer.forAnyRequest().thenPassThrough({
                        proxyConfig: [
                            ({ hostname }) => {
                                expect(hostname).to.equal('localhost');
                                firstCallbackCalled = true;
                                return undefined;
                            },
                            ({ hostname }) => {
                                expect(hostname).to.equal('localhost');
                                secondCallbackCalled = true;
                                return { proxyUrl: targetServer.url }
                            },
                            () => {
                                expect.fail("Third callback should not be called");
                                return undefined;
                            }
                        ]
                    });

                    const response = await request.get(remoteServer.urlFor("/test-url"), {
                        proxy: remoteServer.url
                    });

                    // We get a successful response
                    expect(response).to.equal("Remote server says hi!");
                    // And it went via the intermediate proxy
                    expect((await targetEndpoint.getSeenRequests()).length).to.equal(1);
                });
            });

            it("should successfully mock requests with live streams", async () => {
                let stream1 = new PassThrough();
                await remoteServer.forGet('/stream').thenStream(200, stream1);
                let stream2 = new PassThrough();
                await remoteServer.forGet('/stream').thenStream(200, stream2);

                stream1.end('Hello');
                stream2.end('World');

                let response1 = await fetch(remoteServer.urlFor('/stream'));
                let response2 = await fetch(remoteServer.urlFor('/stream'));

                await expect(response1).to.have.status(200);
                await expect(response1).to.have.responseText('Hello');
                await expect(response2).to.have.status(200);
                await expect(response2).to.have.responseText('World');
            });

            it("should let you verify requests as normal", async () => {
                const endpointMock = await remoteServer.forGet("/mocked-endpoint").thenReply(200, "mocked data");
                await request.get(remoteServer.urlFor("/mocked-endpoint"));

                const seenRequests = await endpointMock.getSeenRequests();
                expect(seenRequests.length).to.equal(1);

                expect(seenRequests[0].protocol).to.equal('http');
                expect(seenRequests[0].method).to.equal('GET');
                expect(seenRequests[0].httpVersion).to.equal('1.1');
                expect(seenRequests[0].url).to.equal(
                    remoteServer.urlFor("/mocked-endpoint")
                );
            });

            it("should allow resetting the mock server configured responses", async () => {
                await remoteServer.forGet("/mocked-endpoint").thenReply(200, "mocked data");

                await remoteServer.reset();
                const result = await request.get(remoteServer.urlFor("/mocked-endpoint")).catch((e) => e);

                expect(result).to.be.instanceof(Error);
                expect(result.statusCode).to.equal(503);
                expect(result.message).to.include("No rules were found matching this request");
            });

            it("should allow resetting the mock server recorded requests", async () => {
                const endpointMock = await remoteServer.forGet("/mocked-endpoint").thenReply(200, "mocked data");
                await request.get(remoteServer.urlFor("/mocked-endpoint"));

                await remoteServer.reset();
                const result = await endpointMock.getSeenRequests().catch((e) => e);

                expect(result).to.be.instanceof(Error);
                expect(result.message).to.include("Can't get seen requests for unknown mocked endpoint");
            });

            it("should reset the server if a client leaves and rejoins", async () => {
                await remoteServer.forGet("/mocked-endpoint").thenReply(200, "mocked data");

                const port = remoteServer.port!;
                await remoteServer.stop();
                await remoteServer.start(port);
                const result = await request.get(remoteServer.urlFor("/mocked-endpoint")).catch((e) => e);

                expect(result).to.be.instanceof(Error);
                expect(result.statusCode).to.equal(503);
                expect(result.message).to.include("No rules were found matching this request");
            });

            it("should support explicitly resetting all servers", async () => {
                await remoteServer.forGet("/mocked-endpoint").thenReply(200, "mocked data");

                await resetAdminServer();

                const result = await request.get(remoteServer.urlFor("/mocked-endpoint")).catch((e) => e);

                expect(result).to.be.instanceof(Error);
                expect(result.cause.code).to.equal('ECONNREFUSED');
            });

            it("should reject multiple clients trying to control the same port", async () => {
                const port = remoteServer.port!;

                await expect(getRemote().start(port))
                    .to.eventually.be.rejectedWith(`Failed to start mock session: listen EADDRINUSE`);
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
                        .to.eventually.be.rejectedWith(/Failed to start mock session: listen EADDRINUSE/);
                });
            });

            it("should allow subscription to admin-client events", async () => {
                // Two arbitrary easy to trigger admin client lifecycle events:
                const stoppingEventPromise = getDeferred<void>();
                await (remoteServer as MockttpClient).on('admin-client:stopping', () => stoppingEventPromise.resolve());
                const stoppedEventPromise = getDeferred<void>();
                await (remoteServer as MockttpClient).on('admin-client:stopped', () => stoppedEventPromise.resolve());

                await remoteServer.stop();

                // Make sure the events fired:
                await stoppingEventPromise;
                await stoppedEventPromise;
            });
        });

        describe("with a provided default configuration", () => {
            let server = getAdminServer({
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

        describe("with a referenceable admin server parameters", () => {

            // A function called by the parameter, which we can use to stub out the
            // parameter itself dynamically.
            let proxyCallbackCallback: (...args: any) => void;

            let server = getAdminServer({
                serverDefaults: {
                    https: {
                        keyPath: './test/fixtures/test-ca.key',
                        certPath: './test/fixtures/test-ca.pem'
                    }
                },
                ruleParameters: {
                    // A parameter, which can be referenced later in rule config
                    proxyCallback: (...args: any) => proxyCallbackCallback(...args)
                }
            });

            let client = getRemote();

            before(() => server.start());
            after(() => server.stop());

            beforeEach(() => client.start());
            afterEach(() => client.stop());

            it("should use be able to reference proxy callback parameters", async function () {
                const callbackArgsDeferred = getDeferred<any>();
                proxyCallbackCallback = (...args: any) => callbackArgsDeferred.resolve(args);

                client.forAnyRequest().thenPassThrough({
                    // A reference to the proxyCallback parameter.
                    proxyConfig: { [MOCKTTP_PARAM_REF]: 'proxyCallback' }
                });

                await fetch(client.urlFor("/mocked-endpoint"));

                // Check the proxy callback is called with the hostname:
                const callbackArguments = await callbackArgsDeferred;
                expect(callbackArguments).to.deep.equal([
                    { hostname: 'localhost' }
                ]);
            });

            it("should use be able to reference proxy callback parameters in an array", async function () {
                let callbackCount = 0;
                proxyCallbackCallback = (...args: any) => {
                    expect(args).to.deep.equal([{ hostname: 'localhost' }]);

                    callbackCount += 1;
                    if (callbackCount === 1) {
                        return undefined;
                    } else if (callbackCount === 2) {
                        return { proxyUrl: 'http://invalid-url.test' }
                    } else if (callbackCount === 3) {
                        expect.fail("Callback should only be called twice");
                    }
                };

                client.forAnyRequest().thenPassThrough({
                    // A reference to the proxyCallback parameter.
                    proxyConfig: [
                        { [MOCKTTP_PARAM_REF]: 'proxyCallback' }, // => undef
                        { [MOCKTTP_PARAM_REF]: 'proxyCallback' }, // => setting
                        { [MOCKTTP_PARAM_REF]: 'proxyCallback' }  // never called, because of previous results
                    ]
                });

                await fetch(client.urlFor("/mocked-endpoint"));

                // Check the proxy callback is called with the hostname:
                expect(callbackCount).to.equal(2);
            });

            it("should be able to query the available rule parameters", async function () {
                const ruleParams = await client.getRuleParameterKeys();

                expect(ruleParams).to.deep.equal([
                    'proxyCallback'
                ]);
            });
        });

        function getClientSessionId(client: Mockttp) {
            return (client as any).adminClient.adminSessionBaseUrl.split('/').slice(-1)[0];
        }

        describe("with keep alive configured", () => {
            let adminServer = getAdminServer({
                webSocketKeepAlive: 50
            });
            let client = getRemote();

            before(() => adminServer.start());
            after(() => adminServer.stop());

            beforeEach(() => client.start());
            afterEach(() => client.stop());

            it("should keep the websocket stream alive", async () => {
                const id = getClientSessionId(client);
                const streamWsServer: Ws.Server = (adminServer as any)
                    .sessions[id].streamServer;

                expect(streamWsServer.clients.size).to.equal(1);
                const streamSocket = [...streamWsServer.clients][0];

                // Make sure that we're hearing frequent pongs from server KA pings:
                await new Promise((resolve) => streamSocket.on('pong', resolve));
            });

            it("should keep the websocket subscription stream alive", async () => {
                // We have to subscribe to something to create the websocket:
                await client.on('request', () => {});

                const id = getClientSessionId(client);
                const subWsServer: Ws.Server = (adminServer as any)
                    .sessions[id].subscriptionServer.server;

                expect(subWsServer.clients.size).to.equal(1);
                const subscriptionSocket = [...subWsServer.clients][0];

                // Make sure that we're hearing frequent pongs from server KA pings:
                await new Promise((resolve) => subscriptionSocket.on('pong', resolve));
            });
        });

        describe("with strict CORS configured", () => {
            let server = getAdminServer({
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
                const ws = new WebSocket(`ws://localhost:45454/session/${client.port}/subscription`);

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
                const ws = new WebSocket(`ws://localhost:45454/session/${client.port}/subscription`, {
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
                const id = getClientSessionId(client);
                const ws = new WebSocket(`ws://localhost:45454/session/${id}/subscription`, {
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

            const adminServer = getAdminServer();

            const client1 = getRemote();
            const client2 = getRemote();

            afterEach(() => Promise.all([
                client1.stop(),
                client2.stop()
            ]));

            beforeEach(() => adminServer.start());
            afterEach(() => adminServer.stop());

            it("should expose events for mock server start & stop", async () => {
                let startedServers: number[] = [];
                let stoppedServers: number[] = [];

                adminServer.on('mock-session-started', (session) => {
                    startedServers.push(session.http.getMockServer().port)
                });
                adminServer.on('mock-session-stopping', (session) => {
                    stoppedServers.push(session.http.getMockServer().port)
                });

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
                const id = getClientSessionId(client1);
                const subWsServer: Ws.Server = (adminServer as any)
                    .sessions[id].subscriptionServer.server;
                subWsServer.clients.forEach((socket: Ws) => socket.terminate());
                await delay(500); // Wait for the disconnect & subsequent reconnect to complete

                await fetch(client1.urlFor("/mocked-endpoint"));

                // Did the subscription still work?
                const seenRequest = await seenRequestPromise;
                expect(seenRequest.url).to.equal(client1.urlFor("/mocked-endpoint"));
            });

            it("can handle unexpected stream disconnections", async () => {
                await client1.start();

                await client1.forGet("/mocked-endpoint").thenCallback(() => {
                    return { statusCode: 200, body: 'Mock response' }
                });

                // Forcefully kill the /stream websocket connection, so that dynamic
                // handlers & matchers are disconnected:
                const id = getClientSessionId(client1);
                const streamWsServer: Ws.Server = (adminServer as any)
                    .sessions[id].streamServer;
                streamWsServer.clients.forEach((socket: Ws) => socket.terminate());
                await delay(200); // Wait for the disconnect & subsequent reconnect to complete

                const response = await request.get(client1.urlFor("/mocked-endpoint"));
                expect(response).to.equal("Mock response");
            });

            it("doesn't reconnect after an intentional reset", async () => {
                await client1.start();
                const clientPort = client1.port;

                await resetAdminServer();
                await client2.start(clientPort);

                // Client 1 should be broken now, because it was reset. It should _not_ try to
                // reconnect and end up taking over client 2's server.
                await expect(() =>
                    client1.port
                ).to.throw('Metadata is not available until the mock server is started');
            });
        });

        describe("with no server available", () => {
            it("fails to mock responses", async () => {
                let client = getRemote();

                await expect(client.start())
                    .to.eventually.be.rejectedWith('Failed to connect to admin server at http://localhost:45454');
            });
        });

    });
});
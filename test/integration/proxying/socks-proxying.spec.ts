import { Buffer } from 'buffer';
import * as net from 'net';
import * as tls from 'tls';
import * as http from 'http';
import * as https from 'https';
import { readTlsClientHello, TlsHelloData } from 'read-tls-client-hello';

import {
    CompletedResponse,
    Mockttp,
    RawPassthroughEvent,
    Request,
    getLocal
} from "../../..";
import {
    DEFAULT_REQ_HEADERS_DISABLED,
    Deferred,
    delay,
    DestroyableServer,
    expect,
    getDeferred,
    makeDestroyable,
    nodeOnly,
    nodeSatisfies,
    openRawSocket,
    openSocksSocket,
    sendRawRequest
} from "../../test-utils";
import { streamToBuffer } from '../../../src/util/buffer-utils';

function h1RequestOverSocket(
    socket: net.Socket,
    url: string,
    options: http.RequestOptions & { noSNI?: boolean } = {}) {
    const parsedURL = new URL(url);

    const request = (parsedURL.protocol === 'https:' ? https : http).request(url, {
        ...options,
        createConnection: () => parsedURL.protocol === 'https:'
            ? tls.connect({
                socket,
                servername: options.noSNI
                    ? undefined
                    : parsedURL.hostname
            })
            : socket
    });
    request.end();

    return new Promise<http.IncomingMessage>((resolve, reject) => {
        request.on('response', resolve);
        request.on('error', reject);
    });
}

nodeOnly(() => {
    describe("Mockttp when used as a SOCKS proxy", () => {

        let remoteServer = getLocal();

        beforeEach(async () => {
            await remoteServer.start();
        });
        afterEach(async () => {
            await remoteServer.stop();
        });

        describe("with default settings", () => {

            let server: Mockttp;

            beforeEach(async () => {
                server = getLocal({
                    socks: true,
                    https: {
                        keyPath: './test/fixtures/test-ca.key',
                        certPath: './test/fixtures/test-ca.pem'
                    }
                });
                await server.start();
                await remoteServer.forGet("/").thenReply(200, "Hello world!");
                await server.forUnmatchedRequest().thenPassThrough();
            });

            afterEach(async () => {
                await server.stop();
            });

            it("should be able to proxy an HTTP request over SOCKSv4", async () => {
                const socksSocket = await openSocksSocket(server, '127.0.0.1', remoteServer.port, { type: 4 });
                const response = await h1RequestOverSocket(socksSocket, remoteServer.url);
                expect(response.statusCode).to.equal(200);
                const body = await streamToBuffer(response);
                expect(body.toString()).to.equal("Hello world!");
            });

            it("should be able to proxy an HTTP request over SOCKSv4a", async () => {
                const socksSocket = await openSocksSocket(server, 'localhost', remoteServer.port, { type: 4 });
                const response = await h1RequestOverSocket(socksSocket, remoteServer.url);
                expect(response.statusCode).to.equal(200);
                const body = await streamToBuffer(response);
                expect(body.toString()).to.equal("Hello world!");
            });

            it("should be able to proxy an HTTP request over SOCKSv5", async () => {
                const socksSocket = await openSocksSocket(server, '127.0.0.1', remoteServer.port, { type: 5 });
                const response = await h1RequestOverSocket(socksSocket, remoteServer.url);
                expect(response.statusCode).to.equal(200);
                const body = await streamToBuffer(response);
                expect(body.toString()).to.equal("Hello world!");
            });

            it("should be able to proxy an HTTP request over SOCKSv5h", async () => {
                const socksSocket = await openSocksSocket(server, 'localhost', remoteServer.port, { type: 5 });
                const response = await h1RequestOverSocket(socksSocket, remoteServer.url);
                expect(response.statusCode).to.equal(200);
                const body = await streamToBuffer(response);
                expect(body.toString()).to.equal("Hello world!");
            });

            it("should use the SOCKS destination hostname over the Host header, including the URL", async () => {
                const seenRequest = getDeferred<Request>();
                await server.on('request', (req) => seenRequest.resolve(req));

                const socksSocket = await openSocksSocket(server, 'localhost', remoteServer.port, { type: 5 });
                const response = await h1RequestOverSocket(socksSocket, remoteServer.url, {
                    headers: {
                        Host: "invalid.example" // This should be ignored - tunnel sets destination
                    }
                });
                expect(response.statusCode).to.equal(200);
                const body = await streamToBuffer(response);
                expect(body.toString()).to.equal("Hello world!");

                expect((await seenRequest).url).to.equal(`http://localhost:${remoteServer.port}/`);
                expect((await seenRequest).destination).to.deep.equal({
                    hostname: 'localhost',
                    port: remoteServer.port
                });
            });

            it("should use the SOCKS destination IP over the Host header, but not in the URL or passthrough events", async () => {
                const seenFinalRequest = getDeferred<Request>();
                await remoteServer.on('request', (req) => seenFinalRequest.resolve(req));

                const seenProxyRequest = getDeferred<Request>();
                await server.on('request', (req) => seenProxyRequest.resolve(req));

                const passthroughEvent = getDeferred<any>();
                await server.on('rule-event', (event) => {
                    if (event.eventType === 'passthrough-request-head') passthroughEvent.resolve(event.eventData);
                });

                const socksSocket = await openSocksSocket(server, '127.0.0.1', remoteServer.port, { type: 5 });
                const response = await h1RequestOverSocket(socksSocket, "http://unused.invalid", {
                    headers: {
                        Host: "invalid.example:1234" // This should be ignored - tunnel sets destination
                    }
                });

                expect(response.statusCode).to.equal(200);
                const body = await streamToBuffer(response);
                expect(body.toString()).to.equal("Hello world!");

                // The URL should show the conceptual target hostname - not the hostname's IP. If you
                // specify only an IP when tunneling, we assume that the Host header is the real hostname.
                expect((await seenProxyRequest).url).to.equal(`http://invalid.example:${remoteServer.port}/`);
                expect((await seenFinalRequest).url).to.equal(`http://invalid.example:1234/`);
                expect((await seenProxyRequest).destination).to.deep.equal({
                    hostname: '127.0.0.1',
                    port: remoteServer.port
                });
                expect((await passthroughEvent).hostname).to.equal('invalid.example');
                expect((await passthroughEvent).port).to.equal(remoteServer.port.toString());
            });

            it("should hide & override a SOCKS destination IP given a request transform on the hostname", async () => {
                const seenFinalRequest = getDeferred<Request>();
                await remoteServer.on('request', (req) => seenFinalRequest.resolve(req));

                server.forAnyRequest().thenPassThrough({
                    transformRequest: {
                        matchReplaceHost: {
                            replacements: [['invalid.example', 'fixed.localhost']],
                            updateHostHeader: true
                        }
                    }
                });

                const seenProxyRequest = getDeferred<Request>();
                await server.on('request', (req) => seenProxyRequest.resolve(req));

                const passthroughEvent = getDeferred<any>();
                await server.on('rule-event', (event) => {
                    if (event.eventType === 'passthrough-request-head') passthroughEvent.resolve(event.eventData);
                });

                // Send to 0.0.0.0 - this IP will never be reachable, but transform will fix it
                const socksSocket = await openSocksSocket(server, '0.0.0.0', remoteServer.port, { type: 5 });
                const response = await h1RequestOverSocket(socksSocket, "http://unused.invalid", {
                    headers: {
                        Host: "invalid.example:1234" // This is the 'effective hostname' - best guess of IP identity
                    }
                });

                expect(response.statusCode).to.equal(200);
                const body = await streamToBuffer(response);
                expect(body.toString()).to.equal("Hello world!");

                expect((await seenProxyRequest).url).to.equal(`http://invalid.example:${remoteServer.port}/`);
                expect((await seenProxyRequest).destination).to.deep.equal({
                    hostname: '0.0.0.0',
                    port: remoteServer.port
                });

                expect((await seenFinalRequest).url).to.equal(`http://fixed.localhost:8000/`); // Host header updated
                expect((await passthroughEvent).hostname).to.equal('fixed.localhost');
                expect((await passthroughEvent).port).to.equal(remoteServer.port.toString());
            });

            it("should hide & override a SOCKS destination IP given a beforeRequest callback", async () => {
                const seenFinalRequest = getDeferred<Request>();
                await remoteServer.on('request', (req) => seenFinalRequest.resolve(req));

                server.forAnyRequest().thenPassThrough({
                    beforeRequest: (req) => {
                        req.url = req.url.replace('invalid.example', 'fixed.localhost');
                        return {
                            url: req.url, // Redirect the request
                            headers: { host: 'another.invalid:4321' } // Set another host header, should be ignored
                        };
                    }
                });

                const seenProxyRequest = getDeferred<Request>();
                await server.on('request', (req) => seenProxyRequest.resolve(req));

                const passthroughEvent = getDeferred<any>();
                await server.on('rule-event', (event) => {
                    if (event.eventType === 'passthrough-request-head') passthroughEvent.resolve(event.eventData);
                });

                // Send to 0.0.0.0 - this IP will never be reachable
                const socksSocket = await openSocksSocket(server, '0.0.0.0', remoteServer.port, { type: 5 });
                const response = await h1RequestOverSocket(socksSocket, "http://unused.invalid", {
                    headers: {
                        Host: "invalid.example:1234" // This is the 'effective hostname' - best guess of IP identity
                    }
                });

                expect(response.statusCode).to.equal(200);
                const body = await streamToBuffer(response);
                expect(body.toString()).to.equal("Hello world!");

                // The URL should show the conceptual target hostname - not the hostname's IP. If you
                // specify only an IP when tunneling, we assume that the (original) Host header is the hostname.
                expect((await seenProxyRequest).url).to.equal(`http://invalid.example:${remoteServer.port}/`);
                expect((await seenProxyRequest).destination).to.deep.equal({
                    hostname: '0.0.0.0',
                    port: remoteServer.port
                });

                // Host header & destination changed independently:
                expect((await seenFinalRequest).url).to.equal(`http://another.invalid:4321/`);
                expect((await passthroughEvent).hostname).to.equal('fixed.localhost');
                expect((await passthroughEvent).port).to.equal(remoteServer.port.toString());
            });

            describe("given a target TLS server", () => {

                let netServer!: DestroyableServer<net.Server>;
                let clientHelloDeferred!: Deferred<TlsHelloData>;

                beforeEach(async () => {
                    netServer = makeDestroyable(net.createServer());
                    netServer.listen();
                    await new Promise((resolve) => netServer.once('listening', resolve));

                    clientHelloDeferred = getDeferred();

                    netServer.on('connection', async (socket) => {
                        clientHelloDeferred.resolve(await readTlsClientHello(socket));
                        socket.end();
                    })
                });

                afterEach(() => netServer.destroy());

                it("should use the SOCKS destination IP but not for SNI", async () => {
                    const tlsServerPort = (netServer.address() as net.AddressInfo).port;

                    const socksSocket = await openSocksSocket(server, '127.0.0.1', tlsServerPort, { type: 5 });
                    h1RequestOverSocket(socksSocket, `https://sni-hostname.test`, {
                        headers: {
                            Host: "invalid.example:1234" // This should be used for SNI only
                        }
                    }).catch(() => {});

                    const clientHello = await clientHelloDeferred;
                    expect(clientHello.serverName).to.equal('invalid.example'); // SNI should be set to the hostname
                });

                it("should use the SOCKS destination IP, but fall back to SNI in URL & passthrough events", async function () {
                    if (!nodeSatisfies(DEFAULT_REQ_HEADERS_DISABLED)) this.skip();

                    const tlsServerPort = (netServer.address() as net.AddressInfo).port;

                    const seenProxyRequest = getDeferred<Request>();
                    await server.on('request', (req) => seenProxyRequest.resolve(req));

                    const passthroughEvent = getDeferred<any>();
                    await server.on('rule-event', (event) => {
                        if (event.eventType === 'passthrough-request-head') passthroughEvent.resolve(event.eventData);
                    });

                    const socksSocket = await openSocksSocket(server, '127.0.0.1', tlsServerPort, { type: 5 });
                    await h1RequestOverSocket(socksSocket, "https://sni-hostname.localhost", {
                        headers: {
                            // No host header! Only 'name' is in the SNI from the HTTPS URL
                        },
                        setDefaultHeaders: false
                    }).catch(() => {});

                    expect((await seenProxyRequest).destination).to.deep.equal({
                        hostname: '127.0.0.1',
                        port: tlsServerPort
                    });

                    // The URL should show the conceptual target hostname - not the hostname's IP. If you
                    // specify only an IP when tunneling, we fall back to SNI as the real hostname.
                    expect((await seenProxyRequest).url).to.equal(`https://sni-hostname.localhost:${tlsServerPort}/`);

                    expect((await passthroughEvent).hostname).to.equal('sni-hostname.localhost');
                    expect((await passthroughEvent).port).to.equal(tlsServerPort.toString());

                    const clientHello = await clientHelloDeferred;
                    expect(clientHello.serverName).to.equal('sni-hostname.localhost'); // SNI should be proxied through
                });

                it("should use the SOCKS destination IP if that's all we have", async function () {
                    if (!nodeSatisfies(DEFAULT_REQ_HEADERS_DISABLED)) this.skip();

                    const tlsServerPort = (netServer.address() as net.AddressInfo).port;

                    const seenProxyRequest = getDeferred<Request>();
                    await server.on('request', (req) => seenProxyRequest.resolve(req));

                    const passthroughEvent = getDeferred<any>();
                    await server.on('rule-event', (event) => {
                        if (event.eventType === 'passthrough-request-head') passthroughEvent.resolve(event.eventData);
                    });

                    const socksSocket = await openSocksSocket(server, '127.0.0.1', tlsServerPort, { type: 5 });
                    await h1RequestOverSocket(socksSocket, "https://127.0.0.1", {
                        noSNI: true,
                        headers: {
                            // No host header *AND* no SNI
                        },
                        setDefaultHeaders: false
                    }).catch(() => {});

                    expect((await seenProxyRequest).destination).to.deep.equal({
                        hostname: '127.0.0.1',
                        port: tlsServerPort
                    });

                    // No SNI or Host or anything - we just use the IP as-is:
                    expect((await seenProxyRequest).url).to.equal(`https://127.0.0.1:${tlsServerPort}/`);
                    expect((await passthroughEvent).hostname).to.equal('127.0.0.1');
                    expect((await passthroughEvent).port).to.equal(tlsServerPort.toString());

                    const clientHello = await clientHelloDeferred;
                    expect(clientHello.serverName).to.equal(undefined); // Can't send IP in SNI
                });

            });

            it("should not crash given a failed SOCKS handshake", async () => {
                const events = [];
                await server.on('request-initiated', (req) => events.push(req));
                await server.on('client-error', (err) => events.push(err));
                await server.on('tls-client-error', (err) => events.push(err));
                await server.on('raw-passthrough-opened', (err) => events.push(err));

                const socket = await openRawSocket(server);
                socket.write(Buffer.from([0x05, 0x01, 0x00])); // Version 5, 1 method, no auth

                const result = await new Promise((resolve, reject) => {
                    socket.once('data', resolve);
                    socket.on('error', reject);
                })
                expect(result).to.deep.equal(Buffer.from([0x05, 0x0])); // Server accepts no auth

                // Server is now waiting for destination - we reset the connection instead
                socket.resetAndDestroy();

                // No crash! And no events.
                await delay(10);
                expect(events.length).to.equal(0);
            });

        });

        describe("with only custom metadata auth supported", () => {

            let server: Mockttp;

            beforeEach(async () => {
                server = getLocal({
                    socks: {
                        authMethods: ["custom-metadata"]
                    }
                });
                await server.start();
                await remoteServer.forGet("/").thenReply(200, "Hello world!");
                await server.forAnyRequest().thenPassThrough();
            });

            afterEach(async () => {
                await server.stop();
            });

            it("should reject SOCKSv4 connections", async () => {
                try {
                    await openSocksSocket(server, '127.0.0.1', remoteServer.port, { type: 4 });
                    expect.fail("Should have failed");
                } catch (err) {
                    expect(err).to.be.instanceOf(Error);
                    expect((err as Error).message).to.match(/Socks4 Proxy rejected connection/);
                }
            });

            it("should reject no-auth SOCKSv5 connections", async () => {
                try {
                    await openSocksSocket(server, '127.0.0.1', remoteServer.port, { type: 5 });
                    expect.fail("Should have failed");
                } catch (err) {
                    expect(err).to.be.instanceOf(Error);
                    expect((err as Error).message).to.match(/no accepted authentication type/);
                }
            });

            it("should reject username/password metadata SOCKSv5 connections", async () => {
                try {
                    await openSocksSocket(server, '127.0.0.1', remoteServer.port, {
                        type: 5,
                        userId: "metadata",
                        password: "{}"
                    });
                    expect.fail("Should have failed");
                } catch (err) {
                    expect(err).to.be.instanceOf(Error);
                    expect((err as Error).message).to.match(/no accepted authentication type/);
                }
            });

            it("should accept and use metadata from custom-metadata SOCKSv5 connections", async () => {
                const requestEventDeferred = getDeferred<Request>();
                await server.on('request', (req) => requestEventDeferred.resolve(req));

                const socksSocket = await openSocksSocket(server, '127.0.0.1', remoteServer.port, {
                    type: 5,
                    custom_auth_method: 0xDA,
                    custom_auth_request_handler: async () => {
                        const message = Buffer.from(JSON.stringify({ tags: ['test-socks-tag'] }));
                        const request = Buffer.alloc(message.byteLength + 2);
                        request.writeUint16BE(message.byteLength, 0);
                        message.copy(request, 2);
                        return request;
                    },
                    custom_auth_response_size: 2,
                    custom_auth_response_handler: async (data: Buffer) => {
                        expect(data).to.deep.equal(Buffer.from([0x05, 0x00]));
                        return true;
                    }
                });

                const response = await h1RequestOverSocket(socksSocket, remoteServer.url);
                expect(response.statusCode).to.equal(200);

                const requestData = await requestEventDeferred;
                expect(requestData.tags).to.deep.equal(['socket-metadata:test-socks-tag']);
            });

            it("to reject unparseable JSON metadata", async () => {
                try {
                    await openSocksSocket(server, '127.0.0.1', remoteServer.port, {
                        type: 5,
                        custom_auth_method: 0xDA,
                        custom_auth_request_handler: async () => {
                            const message = Buffer.from('}}}}}}}}!!!!{{{{{{{'); // Very invalid JSON
                            const request = Buffer.alloc(message.byteLength + 2);
                            request.writeUint16BE(message.byteLength, 0);
                            message.copy(request, 2);
                            return request;
                        },
                        custom_auth_response_size: 30,
                        custom_auth_response_handler: async (data: Buffer) => {
                            expect(data.readUInt8(0)).to.equal(0x05); // Version
                            expect(data.readUInt8(1)).to.equal(0xDA); // JSON error
                            const length = data.readUInt16BE(2);
                            expect(length).to.equal(26);
                            const message = data.subarray(4, length + 4);
                            expect(message.toString()).to.equal('{"message":"Invalid JSON"}');
                            return false;
                        }
                    });
                    expect.fail("Should have failed");
                } catch (err) {
                    expect(err).to.be.instanceOf(Error);
                    expect((err as Error).message).to.match(/Socks5 Authentication failed/);
                }
            });

        });

        describe("with only no-auth, user/password & custom metadata auth all supported", () => {

            let server: Mockttp;

            beforeEach(async () => {
                server = getLocal({
                    socks: {
                        authMethods: ["custom-metadata", "user-password-metadata", "no-auth"]
                    },
                    passthrough: ['unknown-protocol']
                });
                await server.start();
                await remoteServer.forGet("/").thenReply(200, "Hello world!");
                await server.forAnyRequest().thenPassThrough();
            });

            afterEach(async () => {
                await server.stop();
            });

            it("should accept a no-auth HTTP request over SOCKSv4", async () => {
                const socksSocket = await openSocksSocket(server, '127.0.0.1', remoteServer.port, { type: 4 });
                const response = await h1RequestOverSocket(socksSocket, remoteServer.url);
                expect(response.statusCode).to.equal(200);
                const body = await streamToBuffer(response);
                expect(body.toString()).to.equal("Hello world!");
            });

            it("should accept a no-auth HTTP request over SOCKSv5", async () => {
                const socksSocket = await openSocksSocket(server, '127.0.0.1', remoteServer.port, { type: 5 });
                const response = await h1RequestOverSocket(socksSocket, remoteServer.url);
                expect(response.statusCode).to.equal(200);
                const body = await streamToBuffer(response);
                expect(body.toString()).to.equal("Hello world!");
            });

            it("should accept and use username/password metadata SOCKSv5 connections", async () => {
                const responseEventDeferred = getDeferred<CompletedResponse>();
                await server.on('response', (res) => responseEventDeferred.resolve(res));

                const socksSocket = await openSocksSocket(server, '127.0.0.1', remoteServer.port, {
                    type: 5,
                    userId: "metadata",
                    password: JSON.stringify({ tags: ['response-test-tag'] })
                });

                const response = await h1RequestOverSocket(socksSocket, remoteServer.url);
                expect(response.statusCode).to.equal(200);

                const responseData = await responseEventDeferred;
                expect(responseData.tags).to.deep.equal(['socket-metadata:response-test-tag']);
            });

            it("should accept and use username/password base64 metadata SOCKSv5 connections", async () => {
                const responseEventDeferred = getDeferred<CompletedResponse>();
                await server.on('response', (res) => responseEventDeferred.resolve(res));

                const socksSocket = await openSocksSocket(server, '127.0.0.1', remoteServer.port, {
                    type: 5,
                    userId: "metadata",
                    password: Buffer.from(
                        JSON.stringify({ tags: ['base64d-test-tag'] })
                    ).toString('base64url')
                });

                const response = await h1RequestOverSocket(socksSocket, remoteServer.url);
                expect(response.statusCode).to.equal(200);

                const responseData = await responseEventDeferred;
                expect(responseData.tags).to.deep.equal(['socket-metadata:base64d-test-tag']);
            });

            it("to reject username/password auth with unparseable JSON metadata", async () => {
                try {
                    await openSocksSocket(server, '127.0.0.1', remoteServer.port, {
                        type: 5,
                        userId: "metadata",
                        password: "}}}{{{{{{{{{{{{{{{{{" // Very invalid JSON
                    });
                    expect.fail("Should have failed");
                } catch (err) {
                    expect(err).to.be.instanceOf(Error);
                    expect((err as Error).message).to.match(/Socks5 Authentication failed/);
                }
            });

            it("to reject username/password auth with the wrong username", async () => {
                try {
                    await openSocksSocket(server, '127.0.0.1', remoteServer.port, {
                        type: 5,
                        userId: "another-username",
                        password: "{}"
                    });
                    expect.fail("Should have failed");
                } catch (err) {
                    expect(err).to.be.instanceOf(Error);
                    expect((err as Error).message).to.match(/Socks5 Authentication failed/);
                }
            });

            it("should accept and use metadata from custom-metadata SOCKSv5 connections", async () => {
                const rawTunnelEventDeferred = getDeferred<RawPassthroughEvent>();
                await server.on('raw-passthrough-opened', (tunnel) => rawTunnelEventDeferred.resolve(tunnel));

                const socksSocket = await openSocksSocket(server, '127.0.0.1', remoteServer.port, {
                    type: 5,
                    custom_auth_method: 0xDA,
                    custom_auth_request_handler: async () => {
                        const message = Buffer.from(JSON.stringify({ tags: ['raw-tunnel-test-tag'] }));
                        const request = Buffer.alloc(message.byteLength + 2);
                        request.writeUint16BE(message.byteLength, 0);
                        message.copy(request, 2);
                        return request;
                    },
                    custom_auth_response_size: 2,
                    custom_auth_response_handler: async (data: Buffer) => {
                        expect(data).to.deep.equal(Buffer.from([0x05, 0x00]));
                        return true;
                    }
                });

                await sendRawRequest(socksSocket, 'UH OH').catch(() => {});

                const tunnelEvent = await rawTunnelEventDeferred;
                expect(tunnelEvent.tags).to.deep.equal(['socket-metadata:raw-tunnel-test-tag']);
            });

        });

    });
});
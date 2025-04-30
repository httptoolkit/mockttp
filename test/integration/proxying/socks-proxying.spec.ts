import * as net from 'net';
import * as http from 'http';

import {
    CompletedResponse,
    Mockttp,
    RawPassthroughEvent,
    Request,
    getLocal
} from "../../..";
import {
    expect,
    getDeferred,
    nodeOnly,
    openSocksSocket,
    sendRawRequest
} from "../../test-utils";
import { streamToBuffer } from '../../../src/util/buffer-utils';

function h1RequestOverSocket(socket: net.Socket, url: string, options: http.RequestOptions = {}) {
    const request = http.request(url, {
        ...options,
        createConnection: () => socket
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
                server = getLocal({ socks: true });
                await server.start();
                await remoteServer.forGet("/").thenReply(200, "Hello world!");
                await server.forAnyRequest().thenPassThrough();
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

            it("should use the SOCKS destination over the Host header", async () => {
                const socksSocket = await openSocksSocket(server, 'localhost', remoteServer.port, { type: 5 });
                const response = await h1RequestOverSocket(socksSocket, remoteServer.url, {
                    headers: {
                        Host: "invalid.example" // This should be ignored - tunnel sets destination
                    }
                });
                expect(response.statusCode).to.equal(200);
                const body = await streamToBuffer(response);
                expect(body.toString()).to.equal("Hello world!");
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
                        userId: "mockttp-metadata",
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
                    userId: "mockttp-metadata",
                    password: JSON.stringify({ tags: ['response-test-tag'] })
                });

                const response = await h1RequestOverSocket(socksSocket, remoteServer.url);
                expect(response.statusCode).to.equal(200);

                const responseData = await responseEventDeferred;
                expect(responseData.tags).to.deep.equal(['socket-metadata:response-test-tag']);
            });

            it("to reject username/password auth with unparseable JSON metadata", async () => {
                try {
                    await openSocksSocket(server, '127.0.0.1', remoteServer.port, {
                        type: 5,
                        userId: "mockttp-metadata",
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
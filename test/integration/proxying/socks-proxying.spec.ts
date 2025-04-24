import * as net from 'net';
import * as http from 'http';
import { SocksClient } from 'socks';

import {
    Mockttp,
    getLocal
} from "../../..";
import {
    expect,
    nodeOnly
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

        let server: Mockttp;
        let remoteServer = getLocal();

        beforeEach(async () => {
            server = getLocal({ socks: true });
            await server.start();
            await remoteServer.start();
        });

        afterEach(async () => {
            await server.stop();
            await remoteServer.stop();
        });

        it("should be able to proxy an HTTP request over SOCKSv4", async () => {
            await remoteServer.forGet("/").thenReply(200, "Hello world!");
            await server.forAnyRequest().thenPassThrough();

            const socksConn = await SocksClient.createConnection({
                proxy: {
                    host: '127.0.0.1',
                    port: server.port,
                    type: 4
                },
                command: 'connect',
                destination: {
                    host: '127.0.0.1',
                    port: remoteServer.port
                }
            });

            const response = await h1RequestOverSocket(socksConn.socket, remoteServer.url);
            expect(response.statusCode).to.equal(200);
            const body = await streamToBuffer(response);
            expect(body.toString()).to.equal("Hello world!");
        });

        it("should be able to proxy an HTTP request over SOCKSv4a", async () => {
            await remoteServer.forGet("/").thenReply(200, "Hello world!");
            await server.forAnyRequest().thenPassThrough();

            const socksConn = await SocksClient.createConnection({
                proxy: {
                    host: '127.0.0.1',
                    port: server.port,
                    type: 4
                },
                command: 'connect',
                destination: {
                    host: 'localhost',
                    port: remoteServer.port
                }
            });

            const response = await h1RequestOverSocket(socksConn.socket, remoteServer.url);
            expect(response.statusCode).to.equal(200);
            const body = await streamToBuffer(response);
            expect(body.toString()).to.equal("Hello world!");
        });

        it("should be able to proxy an HTTP request over SOCKSv5", async () => {
            await remoteServer.forGet("/").thenReply(200, "Hello world!");
            await server.forAnyRequest().thenPassThrough();

            const socksConn = await SocksClient.createConnection({
                proxy: {
                    host: '127.0.0.1',
                    port: server.port,
                    type: 5
                },
                command: 'connect',
                destination: {
                    host: '127.0.0.1',
                    port: remoteServer.port
                }
            });

            const response = await h1RequestOverSocket(socksConn.socket, remoteServer.url);
            expect(response.statusCode).to.equal(200);
            const body = await streamToBuffer(response);
            expect(body.toString()).to.equal("Hello world!");
        });

        it("should be able to proxy an HTTP request over SOCKSv5h", async () => {
            await remoteServer.forGet("/").thenReply(200, "Hello world!");
            await server.forAnyRequest().thenPassThrough();

            const socksConn = await SocksClient.createConnection({
                proxy: {
                    host: '127.0.0.1',
                    port: server.port,
                    type: 5
                },
                command: 'connect',
                destination: {
                    host: 'localhost',
                    port: remoteServer.port
                }
            });

            const response = await h1RequestOverSocket(socksConn.socket, remoteServer.url);
            expect(response.statusCode).to.equal(200);
            const body = await streamToBuffer(response);
            expect(body.toString()).to.equal("Hello world!");
        });

    });
});
import { Buffer } from 'buffer';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as tls from 'tls';
import * as stream from 'stream';
import * as http from 'http';
import * as https from 'https';
import * as http2 from 'http2';

import { getLocal, Mockttp } from "../../..";
import { startTestProxy, TestProxy } from "../../fixtures/test-connect-proxy";
import {
    expect,
    nodeOnly,
    delay,
    pollUntil,
    getHttp2Response,
    cleanup,
    nodeSatisfies,
    openSocksSocket,
    openRawTlsSocket,
    makeDestroyable,
    sendRawRequest,
    BROKEN_H2_OVER_H2_TUNNELLING
} from "../../test-utils";

// These tests assert the upstream connection management contract:
//
//   * Requests sharing a single downstream connection (or tunnel) reuse a single
//     upstream connection.
//   * Requests on separate downstream connections (or separate tunnels) NEVER
//     share an upstream connection.
//
// We verify this entirely black-box: each target server tags every incoming
// connection with a unique id and echoes it back as the response body, so the
// id we receive tells us exactly which upstream socket served each request.

const CONN_ID = Symbol('upstream-connection-id');
type Tagged<T> = T & { [CONN_ID]?: number };

interface CountingTarget {
    port: number;
    openCount: () => number;
    totalCount?: () => number;
    destroy: () => Promise<void>;
}

// Track open/total connection counts for a server. track() tags each connection with a
// unique 1-based id (returned so callers can echo it back to identify the connection).
function trackConnections() {
    let open = 0;
    let total = 0;
    return {
        track(socket: net.Socket): number {
            total += 1;
            open += 1;
            socket.once('close', () => { open -= 1; });
            return total;
        },
        openCount: () => open,
        totalCount: () => total
    };
}

async function makeTarget(caKey: Buffer, caCert: Buffer): Promise<CountingTarget> {
    // Node-only so imported dynamically
    const httpolyglot = await import('@httptoolkit/httpolyglot');

    const connections = trackConnections();

    const tag = (socket: Tagged<net.Socket>) => {
        socket[CONN_ID] = connections.track(socket);
    };

    const tlsServer = tls.createServer({
        key: caKey,
        cert: caCert,
        ALPNProtocols: ['h2', 'http/1.1']
    });
    tlsServer.on('secureConnection', tag);

    const server = makeDestroyable(httpolyglot.createServer({
        tls: tlsServer,
        http2: {}
    }, (req, res) => {
        const socket = req.socket as Tagged<net.Socket>;
        if (socket[CONN_ID] === undefined) tag(socket); // Plaintext (TLS is tagged above)
        res.end(String(socket[CONN_ID]));
    }));

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

    return {
        port: (server.address() as net.AddressInfo).port,
        openCount: connections.openCount,
        totalCount: connections.totalCount,
        destroy: () => server.destroy()
    };
}

// A minimal CONNECT proxy that tunnels to the requested host:port and counts the
// connections it receives (i.e. the upstream connections Mockttp opens *to the proxy*).
// Mockttp always CONNECT-tunnels its upstream proxying, so this counts one connection
// per distinct upstream proxy connection.
// A minimal HTTP/1 keep-alive client over an arbitrary duplex (raw socket, TLS
// socket, or tunnelled H2 stream). Sends sequential GETs and returns each
// response body (the upstream connection id). Used to drive every H1-inside case
// with one primitive.
function makeH1Client(socket: stream.Duplex, host: string) {
    let buffer = Buffer.alloc(0);
    const pending: Array<(body: string) => void> = [];

    socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);

        let madeProgress = true;
        while (madeProgress) {
            madeProgress = false;

            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) break;

            const header = buffer.subarray(0, headerEnd).toString();
            const lengthMatch = /content-length:\s*(\d+)/i.exec(header);
            const bodyLength = lengthMatch ? parseInt(lengthMatch[1], 10) : 0;
            const responseEnd = headerEnd + 4 + bodyLength;
            if (buffer.length < responseEnd) break;

            const body = buffer.subarray(headerEnd + 4, responseEnd).toString();
            buffer = buffer.subarray(responseEnd);

            const resolve = pending.shift();
            if (resolve) resolve(body);
            madeProgress = true;
        }
    });
    socket.on('error', () => {});

    return {
        get(): Promise<string> {
            return new Promise<string>((resolve) => {
                pending.push(resolve);
                socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\n\r\n`);
            });
        }
    };
}

// A single request/response over an existing agent (controls downstream reuse).
function nodeGet(
    requestModule: typeof http | typeof https,
    options: http.RequestOptions
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const req = requestModule.request(options, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { body += d; });
            res.on('end', () => resolve(body));
        });
        req.on('error', reject);
        req.end();
    });
}

function h2Get(
    client: http2.ClientHttp2Session,
    pathOrHeaders: string | http2.OutgoingHttpHeaders = '/'
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const req = client.request(
            typeof pathOrHeaders === 'string'
                ? { ':path': pathOrHeaders }
                : pathOrHeaders
        );
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (d) => { body += d; });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

nodeOnly(() => {
    describe("Upstream connection isolation", function () {
        this.timeout(5000);

        let caKey: Buffer;
        let caCert: Buffer;

        let server: Mockttp;
        let target: CountingTarget; // Serves http:// and https:// (H1 + H2) on one port.

        before(async () => {
            caKey = await fs.readFile('./test/fixtures/test-ca.key');
            caCert = await fs.readFile('./test/fixtures/test-ca.pem');
        });

        beforeEach(async () => {
            target = await makeTarget(caKey, caCert);
            server = getLocal({
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem'
                },
                http2: true,
                socks: true
            });
            await server.start();
        });

        afterEach(async () => {
            await server.stop();
            await target.destroy();
        });

        const forwardToPlaintext = () =>
            server.forAnyRequest().thenForwardTo(`http://127.0.0.1:${target.port}`);

        const plaintextHost = () => `127.0.0.1:${target.port}`;

        describe("with direct HTTP/1 connections", () => {
            it("reuses one upstream connection across requests on a single connection", async () => {
                await forwardToPlaintext();
                const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

                const id1 = await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent });
                const id2 = await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent });

                expect(id1).to.equal(id2);
                agent.destroy();
            });

            it("uses separate upstream connections for separate downstream connections", async () => {
                await forwardToPlaintext();
                const agent1 = new http.Agent({ keepAlive: true });
                const agent2 = new http.Agent({ keepAlive: true });

                const id1 = await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent: agent1 });
                const id2 = await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent: agent2 });

                expect(id1).to.not.equal(id2);
                agent1.destroy();
                agent2.destroy();
            });
        });

        describe("with direct HTTPS/1 connections", () => {
            it("reuses one upstream connection across requests on a single connection", async () => {
                await forwardToPlaintext();
                const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
                const opts = { host: 'localhost', port: server.port, path: '/', agent, ca: caCert, servername: 'localhost' };

                const id1 = await nodeGet(https, opts);
                const id2 = await nodeGet(https, opts);

                expect(id1).to.equal(id2);
                agent.destroy();
            });

            it("uses separate upstream connections for separate downstream connections", async () => {
                await forwardToPlaintext();
                const agent1 = new https.Agent({ keepAlive: true });
                const agent2 = new https.Agent({ keepAlive: true });
                const base = { host: 'localhost', port: server.port, path: '/', ca: caCert, servername: 'localhost' };

                const id1 = await nodeGet(https, { ...base, agent: agent1 });
                const id2 = await nodeGet(https, { ...base, agent: agent2 });

                expect(id1).to.not.equal(id2);
                agent1.destroy();
                agent2.destroy();
            });
        });

        describe("with direct HTTP/2 connections", () => {
            it("reuses one upstream connection across streams on a single connection", async () => {
                await forwardToPlaintext();
                const client = http2.connect(server.url, { ca: caCert });

                const id1 = await h2Get(client);
                const id2 = await h2Get(client);

                expect(id1).to.equal(id2);
                await cleanup(client);
            });

            it("uses separate upstream connections for separate downstream connections", async () => {
                await forwardToPlaintext();
                const client1 = http2.connect(server.url, { ca: caCert });
                const client2 = http2.connect(server.url, { ca: caCert });

                const id1 = await h2Get(client1);
                const id2 = await h2Get(client2);

                expect(id1).to.not.equal(id2);
                await cleanup(client1, client2);
            });

            it("can still open new upstream connections after the request that opened one is cancelled", async () => {
                const remoteServer = getLocal();
                await remoteServer.start();

                const client = http2.connect(server.url, { ca: caCert });
                try {
                    await remoteServer.forGet('/slow').thenTimeout();
                    await remoteServer.forGet('/quick').thenReply(200, 'quick');
                    await server.forAnyRequest().thenForwardTo(remoteServer.url);

                    // The first request opens the upstream connection, and holds it:
                    const first = client.request({ ':path': '/slow' });
                    first.end();
                    await delay(100);

                    // A second, so the first's connection stays busy after it goes away, and
                    // anything later is forced to open a connection of its own:
                    const second = client.request({ ':path': '/slow' });
                    second.end();
                    await delay(100);

                    // Cancelling the request that opened the connection must not poison the
                    // ability to open further connections for anyone else:
                    first.close(http2.constants.NGHTTP2_CANCEL);
                    await delay(100);

                    const req = client.request({ ':path': '/quick' });
                    req.end();
                    const response = await getHttp2Response(req);
                    expect(response[':status']).to.equal(200);

                    second.close(http2.constants.NGHTTP2_CANCEL);
                } finally {
                    client.destroy();
                    await remoteServer.stop();
                }
            });
        });

        describe("when used as a plain HTTP proxy (no CONNECT)", () => {
            const proxyOpts = (agent: http.Agent) => ({
                host: '127.0.0.1',
                port: server.port,
                // Absolute-form request line => proxy request:
                path: `http://${plaintextHost()}/`,
                headers: { host: plaintextHost() },
                agent
            });

            it("reuses one upstream connection across requests on a single connection", async () => {
                await forwardToPlaintext();
                const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

                const id1 = await nodeGet(http, proxyOpts(agent));
                const id2 = await nodeGet(http, proxyOpts(agent));

                expect(id1).to.equal(id2);
                agent.destroy();
            });

            it("uses separate upstream connections for separate downstream connections", async () => {
                await forwardToPlaintext();
                const agent1 = new http.Agent({ keepAlive: true });
                const agent2 = new http.Agent({ keepAlive: true });

                const id1 = await nodeGet(http, proxyOpts(agent1));
                const id2 = await nodeGet(http, proxyOpts(agent2));

                expect(id1).to.not.equal(id2);
                agent1.destroy();
                agent2.destroy();
            });
        });

        // Establishes an HTTP/1 CONNECT tunnel and resolves the raw tunnel socket.
        async function openH1ConnectTunnel(): Promise<net.Socket> {
            const socket = net.connect(server.port, '127.0.0.1');
            await new Promise<void>((resolve, reject) => {
                socket.once('connect', () => resolve());
                socket.once('error', reject);
            });
            socket.write(`CONNECT ${plaintextHost()} HTTP/1.1\r\nHost: ${plaintextHost()}\r\n\r\n`);
            await new Promise<void>((resolve, reject) => {
                socket.once('data', (data: Buffer) => {
                    if (/^HTTP\/1\.\d 200/.test(data.toString())) resolve();
                    else reject(new Error('CONNECT failed: ' + data.toString().split('\r\n')[0]));
                });
            });
            return socket;
        }

        // TLS over an existing tunnel (a raw socket or a tunnelled H2 stream), via the shared
        // test-utils helper (which handles both socket & ClientHttp2Stream targets):
        const tlsWithin = (tunnel: stream.Duplex) =>
            openRawTlsSocket(tunnel as net.Socket, {
                servername: 'localhost',
                ca: caCert,
                ALPNProtocols: ['http/1.1']
            });

        describe("with HTTP/1 CONNECT tunnels", () => {
            it("reuses one upstream connection across requests within a tunnel", async () => {
                await forwardToPlaintext();
                const tunnel = await openH1ConnectTunnel();
                const tlsSocket = await tlsWithin(tunnel);
                const conn = makeH1Client(tlsSocket, plaintextHost());

                const id1 = await conn.get();
                const id2 = await conn.get();

                expect(id1).to.equal(id2);
                tlsSocket.destroy();
            });

            it("uses separate upstream connections for separate tunnels", async () => {
                await forwardToPlaintext();
                const tls1 = await tlsWithin(await openH1ConnectTunnel());
                const tls2 = await tlsWithin(await openH1ConnectTunnel());

                const id1 = await makeH1Client(tls1, plaintextHost()).get();
                const id2 = await makeH1Client(tls2, plaintextHost()).get();

                expect(id1).to.not.equal(id2);
                tls1.destroy();
                tls2.destroy();
            });
        });

        describe("with HTTP/2 CONNECT tunnels", () => {
            async function openH2ConnectTunnel(
                client: http2.ClientHttp2Session
            ): Promise<http2.ClientHttp2Stream> {
                const req = client.request({
                    ':method': 'CONNECT',
                    ':authority': plaintextHost()
                });
                const response = await getHttp2Response(req);
                expect(response[':status']).to.equal(200);
                return req;
            }

            it("reuses one upstream connection across requests within a single tunnel", async () => {
                await forwardToPlaintext();
                const client = http2.connect(server.url, { ca: caCert });
                const tunnel = await openH2ConnectTunnel(client);
                const tlsSocket = await tlsWithin(tunnel);
                const conn = makeH1Client(tlsSocket, plaintextHost());

                const id1 = await conn.get();
                const id2 = await conn.get();

                expect(id1).to.equal(id2);
                tlsSocket.destroy();
                client.destroy();
            });

            it("uses separate upstream connections for separate tunnels on one proxy connection", async () => {
                await forwardToPlaintext();
                const client = http2.connect(server.url, { ca: caCert });

                // Two independent tunnels multiplexed over the *same* outer H2 socket:
                const tls1 = await tlsWithin(await openH2ConnectTunnel(client));
                const tls2 = await tlsWithin(await openH2ConnectTunnel(client));

                const id1 = await makeH1Client(tls1, plaintextHost()).get();
                const id2 = await makeH1Client(tls2, plaintextHost()).get();

                expect(id1).to.not.equal(id2);
                tls1.destroy();
                tls2.destroy();
                client.destroy();
            });

            it("reuses one upstream connection across streams within an HTTP/2-in-HTTP/2 tunnel", async function () {
                if (nodeSatisfies(BROKEN_H2_OVER_H2_TUNNELLING)) this.skip();

                await forwardToPlaintext();
                const client = http2.connect(server.url, { ca: caCert });
                const tunnel = await openH2ConnectTunnel(client);

                const innerClient = http2.connect(`https://${plaintextHost()}`, {
                    ca: caCert,
                    createConnection: () => tls.connect({
                        socket: tunnel as unknown as net.Socket,
                        servername: 'localhost',
                        ca: caCert,
                        ALPNProtocols: ['h2']
                    })
                });

                const id1 = await h2Get(innerClient);
                const id2 = await h2Get(innerClient);

                expect(id1).to.equal(id2);
                await cleanup(innerClient, client);
            });
        });

        describe("with SOCKS tunnels", () => {
            it("reuses one upstream connection across requests within a tunnel", async () => {
                await forwardToPlaintext();
                const tunnel = await openSocksSocket(server, '127.0.0.1', target.port);
                const conn = makeH1Client(tunnel, plaintextHost());

                const id1 = await conn.get();
                const id2 = await conn.get();

                expect(id1).to.equal(id2);
                tunnel.destroy();
            });

            it("uses separate upstream connections for separate tunnels", async () => {
                await forwardToPlaintext();
                const tunnel1 = await openSocksSocket(server, '127.0.0.1', target.port);
                const tunnel2 = await openSocksSocket(server, '127.0.0.1', target.port);

                const id1 = await makeH1Client(tunnel1, plaintextHost()).get();
                const id2 = await makeH1Client(tunnel2, plaintextHost()).get();

                expect(id1).to.not.equal(id2);
                tunnel1.destroy();
                tunnel2.destroy();
            });
        });

        describe("with varying upstream protocols", () => {
            // The same target also serves TLS (H1 + H2), so we just forward to it over https:
            const forwardToTls = () =>
                server.forAnyRequest().thenForwardTo(`https://127.0.0.1:${target.port}`, {
                    ignoreHostHttpsErrors: ['localhost', '127.0.0.1']
                });

            it("isolates HTTPS upstream connections between downstream connections", async () => {
                await forwardToTls();
                const agent1 = new http.Agent({ keepAlive: true });
                const agent2 = new http.Agent({ keepAlive: true });

                const id1 = await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent: agent1 });
                const id2 = await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent: agent2 });

                expect(id1).to.not.equal(id2);
                agent1.destroy();
                agent2.destroy();
            });

            it("reuses HTTPS upstream connections within one downstream connection", async () => {
                await forwardToTls();
                const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

                const id1 = await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent });
                const id2 = await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent });

                expect(id1).to.equal(id2);
                agent.destroy();
            });

            it("isolates HTTP/2 upstream connections between downstream connections", async () => {
                await forwardToTls();
                const client1 = http2.connect(server.url, { ca: caCert });
                const client2 = http2.connect(server.url, { ca: caCert });

                const id1 = await h2Get(client1);
                const id2 = await h2Get(client2);

                expect(id1).to.not.equal(id2);
                await cleanup(client1, client2);
            });

            // Known gap: HTTP/2 *upstream* connections are correctly isolated between
            // downstream connections (above), but are not currently reused between
            // requests within a single downstream connection. This is a limitation of
            // http2-wrapper's `auto`: its ALPN-probe path feeds the probe socket back in
            // via `_reuseSocket`, which pollutes the session's cache name so the agent
            // never reuses the existing session (reproducible with http2-wrapper alone,
            // independent of Mockttp). Fixing it requires an http2-wrapper change, so for
            // now each upstream H2 request opens its own connection.
            it.skip("reuses HTTP/2 upstream connections across streams within one downstream connection", async () => {
                await forwardToTls();
                const client = http2.connect(server.url, { ca: caCert });

                const id1 = await h2Get(client);
                const id2 = await h2Get(client);

                expect(id1).to.equal(id2);
                await cleanup(client);
            });

            it("rejects rather than hanging when an upstream session closes without a stream error", async () => {
                const brokenTarget = makeDestroyable(http2.createSecureServer({
                    key: caKey,
                    cert: caCert
                }));
                brokenTarget.on('stream', (stream) => {
                    stream.on('error', () => {});
                    stream.session?.destroy();
                });
                await new Promise<void>((resolve) => brokenTarget.listen(0, '127.0.0.1', resolve));
                const brokenPort = (brokenTarget.address() as net.AddressInfo).port;

                try {
                    await server.forAnyRequest().thenForwardTo(
                        `https://127.0.0.1:${brokenPort}`,
                        { ignoreHostHttpsErrors: ['127.0.0.1'] }
                    );
                    const client = http2.connect(server.url, { ca: caCert });
                    const request = client.request({ ':path': '/' });
                    request.end();

                    const response = await getHttp2Response(request);
                    expect(response[':status']).to.equal(502);
                    request.resume();
                    await cleanup(request, client);
                } finally {
                    await brokenTarget.destroy();
                }
            });

            it("bounds retries when every negotiated session immediately sends GOAWAY", async () => {
                let sessionCount = 0;
                const rejectingTarget = makeDestroyable(http2.createSecureServer({
                    key: caKey,
                    cert: caCert
                }));
                rejectingTarget.on('session', (session) => {
                    sessionCount += 1;
                    session.goaway();
                });
                await new Promise<void>((resolve) => rejectingTarget.listen(0, '127.0.0.1', resolve));
                const rejectingPort = (rejectingTarget.address() as net.AddressInfo).port;

                try {
                    await server.forAnyRequest().thenForwardTo(
                        `https://127.0.0.1:${rejectingPort}`,
                        { ignoreHostHttpsErrors: ['127.0.0.1'] }
                    );
                    const client = http2.connect(server.url, { ca: caCert });
                    const request = client.request({ ':path': '/' });
                    request.end();
                    const response = await getHttp2Response(request);
                    expect(response[':status']).to.equal(502);
                    request.resume();

                    await delay(25);
                    expect(sessionCount).to.be.within(1, 2);
                    client.destroy();
                    await cleanup(client);
                } finally {
                    await rejectingTarget.destroy();
                }
            });

            it("reuses one H1 upstream connection after H2-to-H1 negotiation", async () => {
                let connectionCount = 0;
                const h1Target = makeDestroyable(https.createServer({
                    key: caKey,
                    cert: caCert,
                    ALPNProtocols: ['http/1.1']
                }, (_req, res) => res.end('h1')));
                h1Target.on('secureConnection', () => { connectionCount += 1; });
                await new Promise<void>((resolve) => h1Target.listen(0, '127.0.0.1', resolve));
                const h1Port = (h1Target.address() as net.AddressInfo).port;

                const listenerWarnings: string[] = [];
                const recordWarning = (warning: Error) => {
                    if (warning.name === 'MaxListenersExceededWarning' &&
                        warning.message.includes('TLSSocket')) {
                        listenerWarnings.push(warning.message);
                    }
                };
                process.on('warning', recordWarning);

                try {
                    await server.forAnyRequest().thenForwardTo(`https://127.0.0.1:${h1Port}`, {
                        ignoreHostHttpsErrors: ['127.0.0.1']
                    });
                    const client = http2.connect(server.url, { ca: caCert });

                    for (let i = 0; i < 15; i++) {
                        expect(await h2Get(client, `/${i}`)).to.equal('h1');
                    }
                    await new Promise<void>((resolve) => setImmediate(resolve));

                    expect(connectionCount).to.equal(1);
                    expect(listenerWarnings).to.deep.equal([]);
                    await cleanup(client);
                } finally {
                    process.off('warning', recordWarning);
                    await h1Target.destroy();
                }
            });

            it("handles more than 64 concurrent H2-to-H1 requests without stalling", async function () {
                this.timeout(10_000);

                const responseWaiters: http.ServerResponse[] = [];
                const h1Target = makeDestroyable(https.createServer({
                    key: caKey,
                    cert: caCert,
                    ALPNProtocols: ['http/1.1']
                }, (_req, res) => {
                    responseWaiters.push(res);
                    if (responseWaiters.length === 66) {
                        for (const waitingResponse of responseWaiters) waitingResponse.end('h1');
                    }
                }));
                await new Promise<void>((resolve) => h1Target.listen(0, '127.0.0.1', resolve));
                const h1Port = (h1Target.address() as net.AddressInfo).port;

                try {
                    await server.forAnyRequest().thenForwardTo(
                        `https://127.0.0.1:${h1Port}`,
                        { ignoreHostHttpsErrors: ['127.0.0.1'] }
                    );
                    const client = http2.connect(server.url, { ca: caCert });
                    const responses = await Promise.all(
                        Array.from({ length: 66 }, (_, index) =>
                            h2Get(client, `/${index}`)
                        )
                    );
                    expect(responses).to.deep.equal(Array(66).fill('h1'));
                    await cleanup(client);
                } finally {
                    await h1Target.destroy();
                }
            });

            it("fails promptly when a fresh HTTP/2 session has zero capacity", async () => {
                let connectionCount = 0;
                let streamCount = 0;
                const blockedTarget = makeDestroyable(http2.createSecureServer({
                    key: caKey,
                    cert: caCert,
                    settings: { maxConcurrentStreams: 0 }
                }));
                blockedTarget.on('session', () => { connectionCount += 1; });
                blockedTarget.on('stream', () => { streamCount += 1; });
                await new Promise<void>((resolve) => blockedTarget.listen(0, '127.0.0.1', resolve));
                const blockedPort = (blockedTarget.address() as net.AddressInfo).port;

                try {
                    await server.forAnyRequest().thenForwardTo(
                        `https://127.0.0.1:${blockedPort}`,
                        { ignoreHostHttpsErrors: ['127.0.0.1'] }
                    );
                    const client = http2.connect(server.url, { ca: caCert });
                    const request = client.request({ ':path': '/' });
                    request.end();

                    const response = await getHttp2Response(request);
                    expect(response[':status']).to.equal(502);
                    expect(connectionCount).to.equal(1);
                    expect(streamCount).to.equal(0);
                    request.resume();
                    await cleanup(request, client);
                } finally {
                    await blockedTarget.destroy();
                }
            });

            it("closes every upstream HTTP/2 session for a destination when the downstream closes", async () => {
                const sessions = new Set<http2.ServerHttp2Session>();
                const limitedTarget = makeDestroyable(http2.createSecureServer({
                    key: caKey,
                    cert: caCert,
                    settings: { maxConcurrentStreams: 1 }
                }));
                limitedTarget.on('session', (session) => {
                    sessions.add(session);
                    session.once('close', () => sessions.delete(session));
                });
                // Hold every stream until all three sessions exist, then complete them all, so the
                // sessions are idle (not just aborted) when the downstream closes:
                const heldResponses: http2.Http2ServerResponse[] = [];
                limitedTarget.on('request', (_req, res) => {
                    heldResponses.push(res);
                    if (heldResponses.length === 3) heldResponses.forEach((r) => r.end());
                });
                await new Promise<void>((resolve) => limitedTarget.listen(0, '127.0.0.1', resolve));
                const limitedPort = (limitedTarget.address() as net.AddressInfo).port;

                try {
                    await server.forAnyRequest().thenForwardTo(`https://127.0.0.1:${limitedPort}`, {
                        ignoreHostHttpsErrors: ['127.0.0.1']
                    });
                    const client = http2.connect(server.url, { ca: caCert });
                    const responses = await Promise.all(['/1', '/2', '/3'].map((path) => {
                        const request = client.request({ ':path': path });
                        request.end();
                        request.resume();
                        return getHttp2Response(request);
                    }));
                    expect(responses.map((r) => r[':status'])).to.deep.equal([200, 200, 200]);
                    expect(sessions.size).to.equal(3);

                    client.destroy();
                    await new Promise<void>((resolve) => client.once('close', resolve));
                    await pollUntil(() => sessions.size === 0);
                } finally {
                    await limitedTarget.destroy();
                }
            });
        });

        describe("when forwarding through an upstream proxy", () => {
            let proxy: TestProxy;

            beforeEach(async () => {
                proxy = await startTestProxy();
            });

            afterEach(async () => {
                await proxy.stop();
            });

            const forwardViaProxy = () =>
                server.forAnyRequest().thenForwardTo(`http://127.0.0.1:${target.port}`, {
                    proxyConfig: { proxyUrl: `http://127.0.0.1:${proxy.port}` }
                });

            it("reuses one proxied upstream connection across requests on a single connection", async () => {
                await forwardViaProxy();
                const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

                const id1 = await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent });
                const id2 = await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent });

                expect(id1).to.equal(id2);
                agent.destroy();
            });

            it("uses separate proxied upstream connections for separate downstream connections", async () => {
                await forwardViaProxy();
                const agent1 = new http.Agent({ keepAlive: true });
                const agent2 = new http.Agent({ keepAlive: true });

                const id1 = await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent: agent1 });
                const id2 = await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent: agent2 });

                // Separate target connections, and the proxy saw two distinct connections
                // (a shared proxy agent would have reused a single tunnel for both):
                expect(id1).to.not.equal(id2);
                expect(proxy.totalCount()).to.be.at.least(2);
                agent1.destroy();
                agent2.destroy();
            });

            it("closes the proxied upstream connection when the downstream connection closes", async () => {
                await forwardViaProxy();
                const agent = new http.Agent({ keepAlive: true });

                await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent });
                expect(proxy.openCount()).to.equal(1);

                agent.destroy();

                await pollUntil(() => proxy.openCount() === 0, { timeout: 2000 });
                expect(proxy.openCount()).to.equal(0);
            });
        });

        describe("when the downstream connection closes", () => {
            it("closes the associated upstream connection", async () => {
                await forwardToPlaintext();
                const agent = new http.Agent({ keepAlive: true });

                await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent });
                expect(target.openCount()).to.equal(1);

                // Closing the downstream connection should tear down its upstream:
                agent.destroy();

                await pollUntil(() => target.openCount() === 0, { timeout: 2000 });
                expect(target.openCount()).to.equal(0);
            });
        });

        // We always use a keep-alive upstream agent now, and rely on the forwarded
        // `Connection` header to decide whether a given upstream socket is actually reused
        // or closed after the response (Node honours a request's `Connection: close` over the
        // agent's keep-alive). These tests confirm that mirroring works end-to-end.
        describe("mirroring the request's keep-alive behaviour", () => {
            it("reuses the upstream connection for keep-alive requests", async () => {
                await forwardToPlaintext();
                const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

                const id1 = await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent });
                const id2 = await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent });

                expect(id1).to.equal(id2);
                agent.destroy();
            });

            it("does not reuse the upstream connection when the request forwards Connection: close", async () => {
                // Inject Connection: close onto the *upstream* request only, so the downstream
                // connection stays open and we can observe two upstream requests on it:
                await server.forAnyRequest().thenForwardTo(`http://127.0.0.1:${target.port}`, {
                    transformRequest: { updateHeaders: { 'connection': 'close' } }
                });
                const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

                const id1 = await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent });
                const id2 = await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent });

                // Each request gets a fresh upstream socket - the close was honoured despite
                // the keep-alive agent:
                expect(id1).to.not.equal(id2);
                agent.destroy();
            });

            it("opens a fresh proxy tunnel per request when forwarding Connection: close", async () => {
                const proxy = await startTestProxy();
                await server.forAnyRequest().thenForwardTo(`http://127.0.0.1:${target.port}`, {
                    proxyConfig: { proxyUrl: `http://127.0.0.1:${proxy.port}` },
                    transformRequest: { updateHeaders: { 'connection': 'close' } }
                });
                const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

                await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent });
                await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent });

                // Two requests => two tunnels, since each upstream request closes its tunnel:
                expect(proxy.totalCount()).to.equal(2);
                agent.destroy();
                await proxy.stop();
            });

            it("still forwards HTTP/1.0 requests (which have no keep-alive)", async () => {
                await forwardToPlaintext();

                const response = await sendRawRequest(server,
                    `GET / HTTP/1.0\r\nHost: 127.0.0.1:${target.port}\r\n\r\n`
                );

                // Forwarded successfully and got the upstream's response (its socket id):
                expect(response).to.include('200');
                expect(response).to.match(/\r\n\r\n\d+$/);
            });
        });
    });
});

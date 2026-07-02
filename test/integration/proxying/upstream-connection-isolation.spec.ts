import { Buffer } from 'buffer';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as tls from 'tls';
import * as stream from 'stream';
import * as http from 'http';
import * as https from 'https';
import * as http2 from 'http2';

import { getLocal, Mockttp } from "../../..";
import {
    expect,
    nodeOnly,
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

async function makeTarget(caKey: Buffer, caCert: Buffer): Promise<CountingTarget> {
    // Node-only so imported dynamically
    const httpolyglot = await import('@httptoolkit/httpolyglot');

    let nextId = 0;
    let open = 0;
    let total = 0;

    const tag = (socket: Tagged<net.Socket>) => {
        socket[CONN_ID] = ++nextId;
        total += 1;
        open += 1;
        socket.once('close', () => { open -= 1; });
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
        openCount: () => open,
        totalCount: () => total,
        destroy: () => server.destroy()
    };
}

// A minimal CONNECT proxy that tunnels to the requested host:port and counts the
// connections it receives (i.e. the upstream connections Mockttp opens *to the proxy*).
// Mockttp always CONNECT-tunnels its upstream proxying, so this counts one connection
// per distinct upstream proxy connection.
async function makeCountingConnectProxy(): Promise<CountingTarget> {
    let total = 0;
    let open = 0;

    const server = makeDestroyable(http.createServer((_req, res) => {
        res.writeHead(400);
        res.end();
    }));

    server.on('connection', (socket: net.Socket) => {
        total += 1;
        open += 1;
        socket.once('close', () => { open -= 1; });
    });

    server.on('connect', (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
        const [host, port] = (req.url || '').split(':');
        const upstream = net.connect(parseInt(port, 10), host, () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head && head.length) upstream.write(head);
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
        });
        upstream.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => upstream.destroy());
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

    return {
        port: (server.address() as net.AddressInfo).port,
        openCount: () => open,
        totalCount: () => total,
        destroy: () => server.destroy()
    };
}

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

function h2Get(client: http2.ClientHttp2Session): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const req = client.request({ ':path': '/' });
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
        });

        describe("when forwarding through an upstream proxy", () => {
            let proxy: CountingTarget;

            beforeEach(async () => {
                proxy = await makeCountingConnectProxy();
            });

            afterEach(async () => {
                await proxy.destroy();
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
                expect(proxy.totalCount!()).to.be.at.least(2);
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
                const proxy = await makeCountingConnectProxy();
                await server.forAnyRequest().thenForwardTo(`http://127.0.0.1:${target.port}`, {
                    proxyConfig: { proxyUrl: `http://127.0.0.1:${proxy.port}` },
                    transformRequest: { updateHeaders: { 'connection': 'close' } }
                });
                const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

                await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent });
                await nodeGet(http, { host: '127.0.0.1', port: server.port, path: '/', agent });

                // Two requests => two tunnels, since each upstream request closes its tunnel:
                expect(proxy.totalCount!()).to.equal(2);
                agent.destroy();
                await proxy.destroy();
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

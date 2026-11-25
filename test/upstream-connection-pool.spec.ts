import * as fs from 'fs/promises';
import * as dns from 'dns';
import * as net from 'net';
import * as tls from 'tls';
import * as http from 'http';
import * as https from 'https';
import * as http2 from 'http2';

import {
    expect,
    nodeOnly,
    makeDestroyable,
    DestroyableServer,
    pollUntil,
    delay,
    readStreamToString,
    getRejection
} from './test-utils';
import type { AutoProtocolPool } from '../src/rules/upstream/auto-protocol-pool';
import type { H1Connection } from '../src/rules/upstream/h1-connection';
import type {
    UpstreamExchange,
    UpstreamRequestSpec
} from '../src/rules/upstream/upstream-exchange';

const completeExchange = async (exchangePromise: Promise<UpstreamExchange>) => {
    const exchange = await exchangePromise;
    exchange.requestBody.end();
    const response = await exchange.response;
    return { statusCode: response.statusCode, body: await readStreamToString(response.body) };
};

nodeOnly(() => {
    describe("Upstream connection pool", () => {

        let key: Buffer;
        let cert: Buffer;

        let server: DestroyableServer<net.Server> | undefined;
        let pool: AutoProtocolPool;
        let openConnections: Set<net.Socket>;
        let totalConnections: number;

        let AutoProtocolPoolClass: typeof AutoProtocolPool;
        let H1ConnectionClass: typeof H1Connection;

        before(async () => {
            key = await fs.readFile('./test/fixtures/test-ca.key');
            cert = await fs.readFile('./test/fixtures/test-ca.pem');
            // Import inline, to avoid importing in browser test runs:
            AutoProtocolPoolClass = (await import('../src/rules/upstream/auto-protocol-pool')).AutoProtocolPool;
            H1ConnectionClass = (await import('../src/rules/upstream/h1-connection')).H1Connection;
        });

        // TLS handshakes that the server is holding up, until each is called. This only
        // affects new TLS sessions: resumed sessions skip the SNI callback.
        let heldHandshakes: Array<() => void>;
        let handshakesToHold: number;

        const holdHandshakes: tls.TlsOptions['SNICallback'] = (_servername, callback) => {
            if (handshakesToHold === 0) return callback(null);
            handshakesToHold -= 1;
            heldHandshakes.push(() => callback(null));
        };

        beforeEach(() => {
            pool = new AutoProtocolPoolClass();
            openConnections = new Set();
            totalConnections = 0;
            heldHandshakes = [];
            handshakesToHold = 0;
        });

        const useConnectionWaitLimit = (ms: number) => {
            pool.destroy();
            pool = new AutoProtocolPoolClass(ms);
        };

        afterEach(async () => {
            pool.destroy();
            await server?.destroy();
            server = undefined;
        });

        const listen = async (tlsServer: net.Server, port = 0) => {
            tlsServer.on('secureConnection', (socket: net.Socket) => {
                totalConnections += 1;
                openConnections.add(socket);
                socket.once('close', () => openConnections.delete(socket));
            });
            server = makeDestroyable(tlsServer);
            await new Promise<void>((resolve) => tlsServer.listen(port, '127.0.0.1', resolve));
            return (tlsServer.address() as net.AddressInfo).port;
        };

        const startH2Server = (
            handler: (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => void,
            settings: http2.Settings = {},
            port?: number
        ) => listen(http2.createSecureServer({ key, cert, settings, SNICallback: holdHandshakes }, handler), port);

        const startH1Server = (
            handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
        ) => listen(https.createServer({ key, cert, ALPNProtocols: ['http/1.1'] }, handler));

        const makeRequestSpec = (
            port: number,
            options: {
                servername?: string,
                lookup?: net.LookupFunction,
                rawHeaders?: [string, string][],
                method?: string,
                endStream?: boolean
            } = {}
        ): UpstreamRequestSpec => ({
            protocol: 'https:',
            hostname: '127.0.0.1',
            port,
            family: undefined,
            lookup: options.lookup ?? dns.lookup,
            tlsOptions: {
                rejectUnauthorized: false,
                servername: options.servername ?? 'localhost'
            },
            keyLogStream: undefined,
            method: options.method ?? 'GET',
            path: '/path',
            endStream: options.endStream ?? true,
            rawHeaders: options.rawHeaders ?? [
                [':authority', `localhost:${port}`],
                [':scheme', 'https']
            ]
        });

        const makeHooks = (signal = new AbortController().signal, clientSockets: net.Socket[] = []) => ({
            signal,
            onSocket: (socket: net.Socket) => { clientSockets.push(socket); },
            onInformational: () => {}
        });

        describe("given an HTTP/2 server", () => {

            it("shares one connection between concurrent requests", async () => {
                const port = await startH2Server((_req, res) => res.end('h2'));

                const results = await Promise.all([1, 2, 3].map(() =>
                    completeExchange(pool.send(makeRequestSpec(port), makeHooks()))
                ));

                expect(results).to.deep.equal(Array(3).fill({ statusCode: 200, body: 'h2' }));
                expect(totalConnections).to.equal(1);
            });

            it("advertises 4MB stream and 32MB connection flow-control windows", async () => {
                let serverSession: http2.Http2Session | undefined;
                const port = await startH2Server((req, res) => {
                    serverSession = req.stream.session;
                    res.end();
                });

                await completeExchange(pool.send(makeRequestSpec(port), makeHooks()));

                expect(serverSession!.remoteSettings.initialWindowSize).to.equal(4 * 1024 * 1024);
                expect(serverSession!.state.remoteWindowSize).to.equal(32 * 1024 * 1024);
            });

            it("forwards HTTP/2 request headers as given", async () => {
                let seenHeaders: string[] = [];
                const port = await startH2Server((req, res) => {
                    seenHeaders = req.rawHeaders;
                    res.end();
                });

                await completeExchange(pool.send(makeRequestSpec(port, {
                    rawHeaders: [
                        [':authority', `localhost:${port}`],
                        [':scheme', 'https'],
                        ['x-custom', 'value'],
                        ['host', `localhost:${port}`]
                    ]
                }), makeHooks()));

                expect(seenHeaders).to.deep.equal([
                    ':method', 'GET',
                    ':path', '/path',
                    ':authority', `localhost:${port}`,
                    ':scheme', 'https',
                    'x-custom', 'value',
                    'host', `localhost:${port}`
                ]);
            });

            it("ends the stream with the request's headers only when told to, whatever the method", async () => {
                const seenRequests: Array<[string, boolean, string]> = [];
                const port = await startH2Server(async (req, res) => {
                    seenRequests.push([req.method, req.stream.endAfterHeaders, await readStreamToString(req)]);
                    res.end();
                });

                await completeExchange(pool.send(
                    makeRequestSpec(port, { method: 'POST', endStream: true }),
                    makeHooks()
                ));

                const openExchange = await pool.send(
                    makeRequestSpec(port, { method: 'DELETE', endStream: false }),
                    makeHooks()
                );
                openExchange.requestBody.end('request body');
                await openExchange.response;

                expect(seenRequests).to.deep.equal([
                    ['POST', true, ''],
                    ['DELETE', false, 'request body']
                ]);
            });

            it("opens more connections once existing ones are full, sharing each between waiting requests", async () => {
                const heldResponses: http2.Http2ServerResponse[] = [];
                const port = await startH2Server((_req, res) => {
                    heldResponses.push(res);
                    if (heldResponses.length === 6) heldResponses.forEach((r) => r.end('h2'));
                }, { maxConcurrentStreams: 2 });

                const results = await Promise.all([1, 2, 3, 4, 5, 6].map(() =>
                    completeExchange(pool.send(makeRequestSpec(port), makeHooks()))
                ));

                expect(results).to.deep.equal(Array(6).fill({ statusCode: 200, body: 'h2' }));
                expect(totalConnections).to.equal(3);
            });

            it("fails if a new connection can't take any requests", async () => {
                const port = await startH2Server(() => {}, { maxConcurrentStreams: 0 });

                const error = await getRejection(pool.send(makeRequestSpec(port), makeHooks()));
                expect(error).to.have.property('code', 'ERR_HTTP2_OUT_OF_STREAMS');
            });

            it("closes the connection if a session can't be created on it", async () => {
                const port = await startH2Server((_req, res) => res.end());
                const serverSockets: net.Socket[] = [];
                server!.on('connection', (socket: net.Socket) => serverSockets.push(socket));

                // Sessions are created from a URL, which can't contain this name:
                const error = await getRejection(
                    pool.send(makeRequestSpec(port, { servername: 'not a hostname' }), makeHooks())
                );
                expect(error).to.have.property('code', 'ERR_INVALID_URL');
                await pollUntil(() => serverSockets.length === 1 && serverSockets[0].destroyed);
            });

        });

        describe("given an HTTP/1-only server", () => {

            it("reuses an idle connection, converting the request to HTTP/1", async () => {
                const seenHosts: Array<string | undefined> = [];
                const port = await startH1Server((req, res) => {
                    seenHosts.push(req.headers.host);
                    res.end('h1');
                });

                const first = await completeExchange(pool.send(makeRequestSpec(port), makeHooks()));
                const second = await completeExchange(pool.send(makeRequestSpec(port), makeHooks()));

                expect([first, second]).to.deep.equal(Array(2).fill({ statusCode: 200, body: 'h1' }));
                expect(seenHosts).to.deep.equal(Array(2).fill(`localhost:${port}`));
                expect(totalConnections).to.equal(1);
            });

            it("opens a connection per concurrent request", async () => {
                const heldResponses: http.ServerResponse[] = [];
                const port = await startH1Server((_req, res) => {
                    heldResponses.push(res);
                    if (heldResponses.length === 2) heldResponses.forEach((r) => r.end('h1'));
                });

                const results = await Promise.all([1, 2].map(() =>
                    completeExchange(pool.send(makeRequestSpec(port), makeHooks()))
                ));

                expect(results).to.deep.equal(Array(2).fill({ statusCode: 200, body: 'h1' }));
                expect(totalConnections).to.equal(2);
            });

            it("treats a connection as closed as soon as the server closes it", async () => {
                const port = await startH1Server(() => {});
                server!.on('secureConnection', (serverSocket: tls.TLSSocket) => serverSocket.end());

                const socket = tls.connect({
                    host: '127.0.0.1',
                    port,
                    servername: 'localhost',
                    rejectUnauthorized: false,
                    ALPNProtocols: ['http/1.1']
                });
                await new Promise<void>((resolve) => socket.once('secureConnect', () => resolve()));
                const connection = new H1ConnectionClass(socket);

                // As the server's close arrives, before the socket is destroyed:
                const idleAtEnd = await new Promise<boolean>((resolve) =>
                    socket.once('end', () => resolve(connection.isIdle))
                );
                expect(idleAtEnd).to.equal(false);
                connection.destroy();
            });

            it("doesn't reuse an unused connection once the server has given up on it", async () => {
                const port = await startH1Server((_req, res) => res.end('h1'));

                // The connection is still set up and kept, but nothing has used it:
                const abortController = new AbortController();
                const abortedSend = pool.send(makeRequestSpec(port), makeHooks(abortController.signal));
                abortController.abort(new Error('Aborted'));
                await getRejection(abortedSend);
                await pollUntil(() => openConnections.size === 1);

                // The server gives up on it as Node's HTTP server does, with a 408 for a
                // request that never came, and then we close our side too:
                openConnections.forEach((serverSocket) => serverSocket.end(
                    'HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n'
                ));
                await pollUntil(() => openConnections.size === 0);

                const result = await completeExchange(pool.send(makeRequestSpec(port), makeHooks()));
                expect(result).to.deep.equal({ statusCode: 200, body: 'h1' });
                expect(totalConnections).to.equal(2);
            });

        });

        it("expects the protocol that a server last negotiated, when deciding whether to wait", async () => {
            const clientSockets: net.Socket[] = [];
            const send = (port: number) =>
                completeExchange(pool.send(makeRequestSpec(port), makeHooks(undefined, clientSockets)));

            // Replaces the server with an HTTP/2 server on the same port, once the pool has
            // seen all of its connections close.
            const restartAsH2 = async (port: number) => {
                await server!.destroy();
                await pollUntil(() => clientSockets.every((socket) => socket.destroyed));
                await startH2Server((_req, res) => res.end('h2'), {}, port);
            };

            const port = await startH1Server((_req, res) => res.end('h1'));
            expect(await send(port)).to.deep.equal({ statusCode: 200, body: 'h1' });

            // HTTP/1 is still expected, so every request connects for itself, just this once:
            await restartAsH2(port);
            const firstBurst = await Promise.all([1, 2, 3].map(() => send(port)));
            expect(firstBurst).to.deep.equal(Array(3).fill({ statusCode: 200, body: 'h2' }));
            expect(totalConnections).to.equal(1 + 3);

            // Now HTTP/2 is expected, so requests wait to share a connection again:
            await restartAsH2(port);
            const secondBurst = await Promise.all([1, 2, 3].map(() => send(port)));
            expect(secondBurst).to.deep.equal(Array(3).fill({ statusCode: 200, body: 'h2' }));
            expect(totalConnections).to.equal(1 + 3 + 1);
        });

        describe("given a connection that stalls", () => {

            let serverSockets: net.Socket[];

            // The first connection's TLS handshake hangs, until it's released
            const startStallingServer = async () => {
                handshakesToHold = 1;
                const port = await startH2Server((_req, res) => res.end('h2'));
                serverSockets = [];
                server!.on('connection', (socket: net.Socket) => serverSockets.push(socket));
                return port;
            };

            it("stops waiting for it at the wait limit, and abandons it once its own request goes", async () => {
                useConnectionWaitLimit(100);
                const port = await startStallingServer();

                const abortController = new AbortController();
                const stalledSend = pool.send(makeRequestSpec(port), makeHooks(abortController.signal));
                await pollUntil(() => heldHandshakes.length === 1);

                const startTime = Date.now();
                const result = await completeExchange(pool.send(makeRequestSpec(port), makeHooks()));
                expect(result).to.deep.equal({ statusCode: 200, body: 'h2' });
                expect(Date.now() - startTime).to.be.greaterThanOrEqual(90);

                // The stalled connection carries on for as long as its own request wants it:
                expect(serverSockets[0].destroyed).to.equal(false);
                abortController.abort(new Error('Aborted'));
                await getRejection(stalledSend);
                await pollUntil(() => serverSockets[0].destroyed);
            });

            it("abandons it at the wait limit, if its own request has already gone", async () => {
                useConnectionWaitLimit(100);
                const port = await startStallingServer();

                const abortController = new AbortController();
                const abortedSend = pool.send(makeRequestSpec(port), makeHooks(abortController.signal));
                await pollUntil(() => heldHandshakes.length === 1);
                abortController.abort(new Error('Aborted'));
                await getRejection(abortedSend);

                // Anybody who's waiting for that connection carries on without it:
                const waitingRequest = completeExchange(pool.send(makeRequestSpec(port), makeHooks()));

                await pollUntil(() => serverSockets[0].destroyed);
                expect(await waitingRequest).to.deep.equal({ statusCode: 200, body: 'h2' });
            });

            it("aborts it when the pool is destroyed", async () => {
                const port = await startStallingServer();

                const send = pool.send(makeRequestSpec(port), makeHooks());
                await pollUntil(() => heldHandshakes.length === 1);
                pool.destroy();

                expect(await getRejection(send)).to.have.property('code', 'E_DOWNSTREAM_ABORT');
                await pollUntil(() => serverSockets[0].destroyed);
            });

        });

        it("never shares connections between destinations", async () => {
            const port = await startH2Server((_req, res) => res.end());

            await completeExchange(pool.send(makeRequestSpec(port, { servername: 'a.localhost' }), makeHooks()));
            await completeExchange(pool.send(makeRequestSpec(port, { servername: 'b.localhost' }), makeHooks()));

            expect(totalConnections).to.equal(2);
        });

        it("never shares connections between requests with different DNS lookups", async () => {
            const port = await startH2Server((_req, res) => res.end());
            const lookupA: net.LookupFunction = (hostname, options, callback) =>
                dns.lookup(hostname, options, callback);
            const lookupB: net.LookupFunction = (hostname, options, callback) =>
                dns.lookup(hostname, options, callback);

            await completeExchange(pool.send(makeRequestSpec(port, { lookup: lookupA }), makeHooks()));
            await completeExchange(pool.send(makeRequestSpec(port, { lookup: lookupB }), makeHooks()));

            expect(totalConnections).to.equal(2);
        });

        it("rejects requests that are already aborted, with the abort reason and no new connection", async () => {
            const port = await startH2Server((_req, res) => res.end());
            const abortController = new AbortController();
            abortController.abort(new Error('Already aborted'));

            const errorWithNoConnection = await getRejection(
                pool.send(makeRequestSpec(port), makeHooks(abortController.signal))
            );
            expect(errorWithNoConnection.message).to.equal('Already aborted');
            await delay(50);
            expect(totalConnections).to.equal(0);

            await completeExchange(pool.send(makeRequestSpec(port), makeHooks()));
            const errorWithConnection = await getRejection(
                pool.send(makeRequestSpec(port), makeHooks(abortController.signal))
            );
            expect(errorWithConnection.message).to.equal('Already aborted');
        });

        it("keeps a connection whose first request was aborted, for later requests", async () => {
            const port = await startH2Server((_req, res) => res.end('h2'));

            const abortController = new AbortController();
            const abortedSend = pool.send(makeRequestSpec(port), makeHooks(abortController.signal));
            abortController.abort(new Error('Aborted'));
            expect((await getRejection(abortedSend)).message).to.equal('Aborted');

            const result = await completeExchange(pool.send(makeRequestSpec(port), makeHooks()));
            expect(result).to.deep.equal({ statusCode: 200, body: 'h2' });
            expect(totalConnections).to.equal(1);
        });

        it("closes every connection, and fails pending requests, when destroyed", async () => {
            const port = await startH1Server(() => {}); // Never responds

            const exchanges = await Promise.all([1, 2].map(() => pool.send(makeRequestSpec(port), makeHooks())));
            exchanges.forEach((exchange) => exchange.requestBody.end());
            await pollUntil(() => openConnections.size === 2);

            pool.destroy();

            await Promise.all(exchanges.map((exchange) => getRejection(exchange.response)));
            await pollUntil(() => openConnections.size === 0);
            await getRejection(pool.send(makeRequestSpec(port), makeHooks()));
        });

        it("cancels HTTP/2 requests in progress when destroyed, failing a response that's still arriving", async () => {
            const serverStreams: http2.ServerHttp2Stream[] = [];
            const port = await startH2Server((req, res) => {
                serverStreams.push(req.stream);
                req.stream.on('error', () => {});
                if (serverStreams.length === 2) {
                    res.writeHead(200);
                    res.write('partial');
                }
            });

            const unanswered = await pool.send(makeRequestSpec(port), makeHooks());
            const responding = await pool.send(makeRequestSpec(port), makeHooks());
            const response = await responding.response;
            const body = readStreamToString(response.body);
            await new Promise((resolve) => response.body.once('data', resolve));

            const failures = Promise.all([getRejection(unanswered.response), getRejection(body)]);
            pool.destroy();

            for (const error of await failures) {
                expect(error).to.have.property('code', 'ERR_HTTP2_STREAM_ABORTED');
            }
            await pollUntil(() => serverStreams.every((stream) => stream.closed));
            expect(serverStreams.map((stream) => stream.rstCode)).to.deep.equal([
                http2.constants.NGHTTP2_CANCEL,
                http2.constants.NGHTTP2_CANCEL
            ]);
        });

    });
});

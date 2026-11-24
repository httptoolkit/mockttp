import * as fs from 'fs/promises';
import * as dns from 'dns';
import * as net from 'net';
import * as tls from 'tls';
import * as http from 'http';
import * as https from 'https';
import * as http2 from 'http2';
import type { Readable } from 'stream';

import { expect, nodeOnly, makeDestroyable, DestroyableServer, pollUntil, delay } from './test-utils';
import type { AutoProtocolPool } from '../src/rules/upstream/auto-protocol-pool';
import type { H1Connection } from '../src/rules/upstream/h1-connection';
import type {
    UpstreamExchange,
    UpstreamRequestSpec
} from '../src/rules/upstream/upstream-exchange';

const readBody = (body: Readable) => new Promise<string>((resolve, reject) => {
    let data = '';
    body.setEncoding('utf8');
    body.on('data', (chunk: string) => { data += chunk; });
    body.on('end', () => resolve(data));
    body.on('error', reject);
});

const getRejection = async (promise: Promise<unknown>): Promise<Error> => {
    try {
        await promise;
    } catch (error) {
        if (error instanceof Error) return error;
        throw new Error(`Rejected with a non-error: ${error}`);
    }
    throw new Error('Expected a rejection, but the promise resolved');
};

const completeExchange = async (exchangePromise: Promise<UpstreamExchange>) => {
    const exchange = await exchangePromise;
    exchange.requestBody.end();
    const response = await exchange.response;
    return { statusCode: response.statusCode, body: await readBody(response.body) };
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

        beforeEach(() => {
            pool = new AutoProtocolPoolClass();
            openConnections = new Set();
            totalConnections = 0;
        });

        afterEach(async () => {
            pool.destroy();
            await server?.destroy();
            server = undefined;
        });

        const listen = async (tlsServer: net.Server) => {
            tlsServer.on('secureConnection', (socket: net.Socket) => {
                totalConnections += 1;
                openConnections.add(socket);
                socket.once('close', () => openConnections.delete(socket));
            });
            server = makeDestroyable(tlsServer);
            await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
            return (tlsServer.address() as net.AddressInfo).port;
        };

        const startH2Server = (
            handler: (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => void,
            settings: http2.Settings = {}
        ) => listen(http2.createSecureServer({ key, cert, settings }, handler));

        const startH1Server = (handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) =>
            listen(https.createServer({ key, cert, ALPNProtocols: ['http/1.1'] }, handler));

        const makeRequestSpec = (
            port: number,
            options: {
                servername?: string,
                lookup?: net.LookupFunction,
                rawHeaders?: [string, string][]
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
            method: 'GET',
            path: '/path',
            rawHeaders: options.rawHeaders ?? [
                [':authority', `localhost:${port}`],
                [':scheme', 'https']
            ]
        });

        const makeHooks = (signal = new AbortController().signal) => ({
            signal,
            onSocket: () => {},
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

            it("opens another connection when existing ones are full", async () => {
                const heldResponses: http2.Http2ServerResponse[] = [];
                const port = await startH2Server((_req, res) => {
                    heldResponses.push(res);
                    if (heldResponses.length === 2) heldResponses.forEach((r) => r.end('h2'));
                }, { maxConcurrentStreams: 1 });

                const results = await Promise.all([1, 2].map(() =>
                    completeExchange(pool.send(makeRequestSpec(port), makeHooks()))
                ));

                expect(results).to.deep.equal(Array(2).fill({ statusCode: 200, body: 'h2' }));
                expect(totalConnections).to.equal(2);
            });

            it("shares each new connection between waiting requests, as far as it has capacity", async () => {
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

    });
});

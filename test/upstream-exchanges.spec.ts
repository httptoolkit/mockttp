import * as net from 'net';
import * as http2 from 'http2';
import type { Readable } from 'stream';

import {
    expect,
    nodeOnly,
    nodeSatisfies,
    makeDestroyable,
    DestroyableServer,
    DEFAULT_REQ_HEADERS_DISABLED
} from './test-utils';
import { startH1Exchange } from '../src/rules/upstream/h1-exchange';
import { startH2Exchange } from '../src/rules/upstream/h2-exchange';
import type { UpstreamRequestHooks } from '../src/rules/upstream/upstream-exchange';

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

const makeHooks = (signal = new AbortController().signal) => {
    const sockets: net.Socket[] = [];
    const informational: Array<[number, string[]]> = [];
    const hooks: UpstreamRequestHooks = {
        signal,
        onSocket: (socket) => sockets.push(socket),
        onInformational: (statusCode, rawHeaders) => informational.push([statusCode, rawHeaders])
    };
    return { hooks, sockets, informational };
};

nodeOnly(() => {
    describe("Upstream exchanges", () => {

        describe("over HTTP/1", () => {

            let server: DestroyableServer<net.Server> | undefined;
            let requestHeads: string[];

            // A raw server, so we can see the exact bytes sent, and send exactly what we like back
            const startServer = async (respond: (socket: net.Socket) => void) => {
                requestHeads = [];
                server = makeDestroyable(net.createServer((socket) => {
                    let buffer = '';
                    socket.on('data', (data) => {
                        buffer += data.toString('latin1');
                        const headEnd = buffer.indexOf('\r\n\r\n');
                        if (headEnd === -1 || requestHeads.length) return;
                        requestHeads.push(buffer.slice(0, headEnd));
                        respond(socket);
                    });
                    socket.on('error', () => {});
                }));
                await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
                return (server.address() as net.AddressInfo).port;
            };

            afterEach(async () => {
                await server?.destroy();
                server = undefined;
            });

            it("sends the head exactly as given, and exposes the response, body & trailers", async () => {
                const port = await startServer((socket) => socket.end(
                    'HTTP/1.1 200 OK\r\n' +
                    'X-Response: value\r\n' +
                    'Transfer-Encoding: chunked\r\n' +
                    'Trailer: X-Trailer\r\n' +
                    '\r\n' +
                    '4\r\nbody\r\n' +
                    '0\r\nX-Trailer: trailer-value\r\n\r\n'
                ));

                const { hooks, sockets } = makeHooks();
                const exchange = startH1Exchange('http:', {
                    hostname: '127.0.0.1',
                    port,
                    agent: false
                }, {
                    method: 'GET',
                    path: '/path?query',
                    rawHeaders: [['host', 'example.com'], ['X-MiXeD', 'a'], ['X-MiXeD', 'b']]
                }, hooks);
                exchange.requestBody.end();

                const response = await exchange.response;
                expect(response.statusCode).to.equal(200);
                expect(response.statusMessage).to.equal('OK');
                expect(response.httpVersion).to.equal('1.1');
                expect(response.rawHeaders).to.deep.equal([
                    'X-Response', 'value',
                    'Transfer-Encoding', 'chunked',
                    'Trailer', 'X-Trailer'
                ]);
                expect(await readBody(response.body)).to.equal('body');
                expect(response.getRawTrailers()).to.deep.equal(['X-Trailer', 'trailer-value']);

                // Nothing added: no Connection, framing or other default headers. Older Node
                // versions can't disable theirs though, so they still add a Connection header:
                expect(requestHeads[0].split('\r\n')).to.deep.equal([
                    'GET /path?query HTTP/1.1',
                    'host: example.com',
                    'X-MiXeD: a',
                    'X-MiXeD: b',
                    ...(nodeSatisfies(DEFAULT_REQ_HEADERS_DISABLED) ? [] : ['Connection: close'])
                ]);
                expect(sockets.length).to.equal(1);
            });

            it("reports informational responses", async () => {
                const port = await startServer((socket) => socket.end(
                    'HTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\n' +
                    'HTTP/1.1 204 No Content\r\n\r\n'
                ));

                const { hooks, informational } = makeHooks();
                const exchange = startH1Exchange('http:', { hostname: '127.0.0.1', port, agent: false }, {
                    method: 'GET',
                    path: '/',
                    rawHeaders: [['host', 'example.com']]
                }, hooks);
                exchange.requestBody.end();

                expect((await exchange.response).statusCode).to.equal(204);
                expect(informational).to.deep.equal([[103, ['Link', '</a>']]]);
            });

            it("rejects the response if the request fails before a response arrives", async () => {
                const port = await startServer((socket) => socket.destroy());

                const { hooks } = makeHooks();
                const exchange = startH1Exchange('http:', { hostname: '127.0.0.1', port, agent: false }, {
                    method: 'GET',
                    path: '/',
                    rawHeaders: [['host', 'example.com']]
                }, hooks);
                exchange.requestBody.end();

                const error = await getRejection(exchange.response);
                expect(error).to.have.property('code', 'ECONNRESET');
            });

            it("errors the body if the connection fails mid-response", async () => {
                const port = await startServer((socket) => {
                    socket.write('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nab');
                    setTimeout(() => socket.destroy(), 10);
                });

                const { hooks } = makeHooks();
                const exchange = startH1Exchange('http:', { hostname: '127.0.0.1', port, agent: false }, {
                    method: 'GET',
                    path: '/',
                    rawHeaders: [['host', 'example.com']]
                }, hooks);
                exchange.requestBody.end();

                const response = await exchange.response;
                await getRejection(readBody(response.body));
            });

            it("rejects the response when aborted before a response arrives", async () => {
                const port = await startServer(() => {}); // Never responds

                const abortController = new AbortController();
                const { hooks } = makeHooks(abortController.signal);
                const exchange = startH1Exchange('http:', { hostname: '127.0.0.1', port, agent: false }, {
                    method: 'GET',
                    path: '/',
                    rawHeaders: [['host', 'example.com']]
                }, hooks);
                exchange.requestBody.end();

                await new Promise((resolve) => setTimeout(resolve, 20));
                abortController.abort();

                const error = await getRejection(exchange.response);
                expect(error.name).to.equal('AbortError');
            });

        });

        describe("over HTTP/2", () => {

            let server: DestroyableServer<http2.Http2Server> | undefined;
            let client: http2.ClientHttp2Session | undefined;

            const startServer = async (onStream: (stream: http2.ServerHttp2Stream) => void) => {
                server = makeDestroyable(http2.createServer());
                server.on('stream', onStream);
                await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
                const port = (server.address() as net.AddressInfo).port;

                client = http2.connect(`http://127.0.0.1:${port}`);
                await new Promise<void>((resolve) => client!.once('connect', () => resolve()));
                return client;
            };

            const startExchange = (session: http2.ClientHttp2Session, hooks: UpstreamRequestHooks) => {
                const stream = session.request({ ':path': '/' });
                stream.end();
                return startH2Exchange(stream, session.socket as net.Socket, hooks);
            };

            afterEach(async () => {
                client?.destroy();
                client = undefined;
                await server?.destroy();
                server = undefined;
            });

            it("exposes the response, body & raw trailers, and reports the socket", async () => {
                const session = await startServer((stream) => {
                    stream.respond({ ':status': 200, 'x-response': 'value' }, { waitForTrailers: true });
                    stream.on('wantTrailers', () => stream.sendTrailers({ 'x-trailer': 'trailer-value' }));
                    stream.end('body');
                });

                const { hooks, sockets } = makeHooks();
                const exchange = startExchange(session, hooks);

                const response = await exchange.response;
                expect(response.statusCode).to.equal(200);
                expect(response.httpVersion).to.equal('2.0');
                expect(response.headers['x-response']).to.equal('value');
                expect(await readBody(response.body)).to.equal('body');
                expect(response.getRawTrailers()).to.deep.equal(['x-trailer', 'trailer-value']);

                // Request trailers can't be sent over HTTP/2:
                expect(exchange.addTrailers).to.equal(undefined);
                expect(sockets).to.deep.equal([session.socket]);
            });

            it("reports informational responses, without their pseudo-headers", async () => {
                const session = await startServer((stream) => {
                    stream.additionalHeaders({ ':status': 103, 'link': '</a>' });
                    stream.respond({ ':status': 204 }, { endStream: true });
                });

                const { hooks, informational } = makeHooks();
                const exchange = startExchange(session, hooks);

                expect((await exchange.response).statusCode).to.equal(204);
                expect(informational).to.deep.equal([[103, ['link', '</a>']]]);
            });

            it("rejects the response if the stream is reset before a response arrives", async () => {
                const session = await startServer((stream) => {
                    stream.on('error', () => {});
                    stream.destroy(new Error('Reset')); // Sends RST_STREAM with INTERNAL_ERROR
                });

                const { hooks } = makeHooks();
                const exchange = startExchange(session, hooks);

                const error = await getRejection(exchange.response);
                expect(error).to.have.property('code', 'ERR_HTTP2_STREAM_ERROR');
            });

            it("rejects the response if the stream closes cleanly before a response arrives", async () => {
                const session = await startServer((stream) => stream.close());

                const { hooks } = makeHooks();
                const exchange = startExchange(session, hooks);

                const error = await getRejection(exchange.response);
                expect(error).to.have.property('code', 'ERR_HTTP2_STREAM_ABORTED');
            });

            it("rejects the response if the session closes before a response arrives", async () => {
                const session = await startServer((stream) => {
                    stream.on('error', () => {});
                    stream.session?.destroy();
                });

                const { hooks } = makeHooks();
                const exchange = startExchange(session, hooks);

                await getRejection(exchange.response);
            });

            it("errors the body if the session closes mid-response", async () => {
                const session = await startServer((stream) => {
                    stream.on('error', () => {});
                    stream.respond({ ':status': 200 });
                    stream.write('partial', () => setTimeout(() => stream.session?.destroy(), 10));
                });

                const { hooks } = makeHooks();
                const exchange = startExchange(session, hooks);

                const response = await exchange.response;
                const error = await getRejection(readBody(response.body));
                expect(error).to.have.property('code', 'ERR_HTTP2_STREAM_ABORTED');
            });

            it("cancels the upstream stream if the body is abandoned", async () => {
                let serverStream: http2.ServerHttp2Stream | undefined;
                const session = await startServer((stream) => {
                    serverStream = stream;
                    stream.on('error', () => {});
                    stream.respond({ ':status': 200 });
                    stream.write('partial');
                });

                const { hooks } = makeHooks();
                const exchange = startExchange(session, hooks);

                const response = await exchange.response;
                response.body.destroy();

                await new Promise<void>((resolve) => serverStream!.once('close', () => resolve()));
                expect(serverStream!.rstCode).to.equal(http2.constants.NGHTTP2_CANCEL);
            });

        });

    });
});

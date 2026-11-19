import { Buffer } from 'buffer';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as tls from 'tls';
import * as http2 from 'http2';

import { getLocal, Mockttp } from "../../..";
import {
    expect,
    nodeOnly,
    getHttp2Response,
    makeDestroyable,
    nodeSatisfies,
    sendRawRequest
} from "../../test-utils";

// These tests assert the exact bytes we put on the wire upstream. Everything the client
// sends that we don't have to change must arrive unchanged - raw casing, ordering,
// duplicates and all - and where a protocol conversion forces a change, that change must
// be exactly the minimum required.
//
// We assert against a raw socket rather than a parsed request, because parsing is
// precisely what would hide the differences we care about here.

interface RawTarget {
    port: number;
    requests: () => string[];
    destroy: () => Promise<void>;
}

const HTTP_1_1_RESPONSE =
    'HTTP/1.1 200 OK\r\n' +
    'Content-Length: 2\r\n' +
    'Connection: close\r\n' +
    '\r\n' +
    'ok';

/**
 * Accumulate raw bytes until the end of the header block, then reply with a fixed
 * minimal response, so tests can assert on the literal request head we sent.
 */
function collectRequestHead(socket: net.Socket, record: (head: string) => void) {
    let buffer = '';
    socket.on('data', (data: Buffer) => {
        buffer += data.toString('utf8');
        const headEnd = buffer.indexOf('\r\n\r\n');
        if (headEnd === -1) return;

        record(buffer.slice(0, headEnd + 4));
        buffer = buffer.slice(headEnd + 4);
        socket.end(HTTP_1_1_RESPONSE);
    });
    socket.on('error', () => {});
}

async function makeRawTarget(): Promise<RawTarget> {
    const heads: string[] = [];
    const server = makeDestroyable(net.createServer((socket) =>
        collectRequestHead(socket, (head) => heads.push(head))
    ));

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    return {
        port: (server.address() as net.AddressInfo).port,
        requests: () => heads,
        destroy: () => server.destroy()
    };
}

/**
 * A TLS target that offers only HTTP/1.1 via ALPN, so an H2-capable upstream request
 * is downgraded, and we can see exactly what H1 request that produces.
 */
async function makeH1OnlyTlsTarget(key: Buffer, cert: Buffer): Promise<RawTarget> {
    const heads: string[] = [];
    const server = makeDestroyable(tls.createServer({
        key,
        cert,
        ALPNProtocols: ['http/1.1']
    }, (socket) => collectRequestHead(socket, (head) => heads.push(head))));

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    return {
        port: (server.address() as net.AddressInfo).port,
        requests: () => heads,
        destroy: () => server.destroy()
    };
}

const headerLines = (head: string) => head.split('\r\n').slice(1).filter(l => l !== '');
const requestLine = (head: string) => head.split('\r\n')[0];

nodeOnly(() => {
    describe("Upstream wire fidelity", function () {
        this.timeout(10000);

        let server: Mockttp;
        let caKey: Buffer;
        let caCert: Buffer;

        before(async () => {
            caKey = await fs.readFile('./test/fixtures/test-ca.key');
            caCert = await fs.readFile('./test/fixtures/test-ca.pem');
        });

        afterEach(() => server?.stop());

        describe("for an HTTP/1.1 client and an HTTP/1.1 upstream", () => {

            it("forwards the request head byte-for-byte", async () => {
                const target = await makeRawTarget();
                server = getLocal();
                await server.start();
                await server.forAnyRequest().thenPassThrough();

                try {
                    // Sent as literal bytes, so no client library can normalise anything
                    // on the way in, and any difference upstream is ours:
                    await sendRawRequest(server,
                        'POST /some/path?query=a%20value&other=1 HTTP/1.1\r\n' +
                        `Host: 127.0.0.1:${target.port}\r\n` +
                        'X-MiXeD-CaSe: PreservedValue\r\n' +
                        'X-Duplicate: first\r\n' +
                        'x-empty: \r\n' +
                        'X-Duplicate: second\r\n' +
                        'Content-Length: 4\r\n' +
                        '\r\n' +
                        'body'
                    );

                    const head = target.requests()[0];

                    // The request line must carry the path exactly as received, with no
                    // re-encoding or normalisation of the query:
                    expect(requestLine(head)).to.equal(
                        'POST /some/path?query=a%20value&other=1 HTTP/1.1'
                    );

                    // Every header, in order, with original casing and duplicates intact,
                    // and critically nothing added that the client didn't send:
                    expect(headerLines(head)).to.deep.equal([
                        `Host: 127.0.0.1:${target.port}`,
                        'X-MiXeD-CaSe: PreservedValue',
                        'X-Duplicate: first',
                        'x-empty: ',
                        'X-Duplicate: second',
                        'Content-Length: 4'
                    ]);
                } finally {
                    await target.destroy();
                }
            });

            it("does not add framing headers to a bodyless request", async () => {
                const target = await makeRawTarget();
                server = getLocal();
                await server.start();
                await server.forAnyRequest().thenPassThrough();

                try {
                    await sendRawRequest(server,
                        'GET / HTTP/1.1\r\n' +
                        `Host: 127.0.0.1:${target.port}\r\n` +
                        '\r\n'
                    );

                    // A bare GET with only a Host header must stay exactly that upstream -
                    // notably with no Connection or framing headers invented for it:
                    expect(headerLines(target.requests()[0])).to.deep.equal([
                        `Host: 127.0.0.1:${target.port}`
                    ]);
                } finally {
                    await target.destroy();
                }
            });

        });

        describe("for an HTTP/2 client downgraded to an HTTP/1.1 upstream", () => {

            // Known gap: http2-wrapper's H1 fallback rebuilds the headers as an object, so
            // duplicates are grouped, Host is appended last and Connection: keep-alive is added.
            it.skip("forwards every header in order, with only the changes H1 requires", async function () {
                if (!nodeSatisfies('>=22.17.0')) this.skip();

                const target = await makeH1OnlyTlsTarget(caKey, caCert);
                server = getLocal({ http2: true });
                await server.start();
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['127.0.0.1']
                });

                try {
                    const client = http2.connect(server.url, { ca: caCert });
                    const request = client.request([
                        ':method', 'POST',
                        ':path', '/some/path?query=a%20value&other=1&tilde=%7e',
                        ':scheme', 'https',
                        ':authority', `127.0.0.1:${target.port}`,
                        'x-first', '1',
                        'x-dup', 'first',
                        'cookie', 'a=b',
                        'x-empty', '',
                        'x-dup', 'second',
                        'cookie', 'c=d',
                        'content-length', '4',
                        'x-list', 'a, b;q="c"',
                        'user-agent', 'test-agent',
                        'sec-ch-ua-mobile', '?0',
                        'x-last', 'z'
                    ]);
                    request.end('body');
                    await getHttp2Response(request);
                    request.resume();
                    await new Promise<void>((resolve, reject) => {
                        request.once('end', resolve);
                        request.once('error', reject);
                    });
                    client.close();

                    const head = target.requests()[0];

                    expect(requestLine(head)).to.equal(
                        'POST /some/path?query=a%20value&other=1&tilde=%7e HTTP/1.1'
                    );

                    // :authority becomes a leading Host header, and H1 only allows a single
                    // cookie header, so they're joined where the first one was. Known headers
                    // take the casing browsers use over H1 (Title-Case, except lowercase client
                    // hints), while unknown headers stay as received. Everything else (order,
                    // interleaved duplicates, empty & list values, the client's own framing)
                    // is untouched, and nothing is added:
                    expect(headerLines(head)).to.deep.equal([
                        `Host: 127.0.0.1:${target.port}`,
                        'x-first: 1',
                        'x-dup: first',
                        'Cookie: a=b; c=d',
                        'x-empty: ',
                        'x-dup: second',
                        'Content-Length: 4',
                        'x-list: a, b;q="c"',
                        'User-Agent: test-agent',
                        'sec-ch-ua-mobile: ?0',
                        'x-last: z'
                    ]);
                } finally {
                    await target.destroy();
                }
            });

            it("adds chunked framing for bodied methods with no framing headers", async function () {
                if (!nodeSatisfies('>=22.17.0')) this.skip();

                const target = await makeH1OnlyTlsTarget(caKey, caCert);
                server = getLocal({ http2: true });
                await server.start();
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['127.0.0.1']
                });

                try {
                    const client = http2.connect(server.url, { ca: caCert });
                    const request = client.request([
                        ':method', 'POST',
                        ':path', '/',
                        ':scheme', 'https',
                        ':authority', `127.0.0.1:${target.port}`
                    ]);
                    request.end('body');
                    await getHttp2Response(request);
                    request.resume();
                    await new Promise<void>((resolve, reject) => {
                        request.once('end', resolve);
                        request.once('error', reject);
                    });
                    client.close();

                    expect(headerLines(target.requests()[0]))
                        .to.include('Transfer-Encoding: chunked');
                } finally {
                    await target.destroy();
                }
            });

        });

    });
});

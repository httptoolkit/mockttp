import * as http from 'http';
import * as http2 from 'http2';
import * as tls from 'tls';
import * as url from 'url';

import { getLocal, Mockttp, matchers, requestSteps } from "../../..";
const { InformationalResponseStep } = requestSteps;
import {
    expect,
    nodeOnly,
    cleanup,
    BROKEN_H2_OVER_H2_TUNNELLING,
    nodeSatisfies,
    openRawSocket,
    getHttp2Response
} from "../../test-utils";

// Read raw bytes from an HTTP/1.1 connection until the server closes it,
// so we can observe 1xx responses that fetch/undici would otherwise hide.
async function rawHttp1Request(server: Mockttp, path: string): Promise<string> {
    const sock = await openRawSocket(server);
    return new Promise((resolve, reject) => {
        let buf = '';
        sock.on('data', d => { buf += d.toString('utf8'); });
        sock.on('end', () => resolve(buf));
        sock.on('error', reject);
        sock.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
}

// Collect every set of headers (including 1xx) and the final response/body
// from an HTTP/2 stream.
function collectHttp2(req: http2.ClientHttp2Stream) {
    return new Promise<{
        informational: http2.IncomingHttpHeaders[],
        response: http2.IncomingHttpHeaders,
        body: Buffer
    }>((resolve, reject) => {
        const informational: http2.IncomingHttpHeaders[] = [];
        let response: http2.IncomingHttpHeaders | undefined;
        const chunks: Buffer[] = [];
        req.on('headers', (h) => informational.push(h));
        req.on('response', (h) => { response = h; });
        req.on('data', (d) => chunks.push(Buffer.from(d as Buffer)));
        req.on('end', () => {
            resolve({
                informational,
                response: response!,
                body: Buffer.concat(chunks)
            });
        });
        req.on('error', reject);
    });
}

describe("Informational response steps", () => {

    describe("construction validation", () => {

        it("rejects status below 100", () => {
            expect(() => new InformationalResponseStep(99)).to.throw(/100.*199/);
        });

        it("rejects status of 200 or above", () => {
            expect(() => new InformationalResponseStep(200)).to.throw(/100.*199/);
            expect(() => new InformationalResponseStep(404)).to.throw(/100.*199/);
        });

        it("rejects status 101 (Switching Protocols)", () => {
            expect(() => new InformationalResponseStep(101)).to.throw(/101/);
        });

        it("accepts standard 1xx codes", () => {
            expect(() => new InformationalResponseStep(100)).not.to.throw();
            expect(() => new InformationalResponseStep(102)).not.to.throw();
            expect(() => new InformationalResponseStep(103)).not.to.throw();
        });

        it("accepts non-standard 1xx codes", () => {
            expect(() => new InformationalResponseStep(150)).not.to.throw();
            expect(() => new InformationalResponseStep(199)).not.to.throw();
        });

        it("accepts headers", () => {
            expect(() => new InformationalResponseStep(103, {
                'link': '</style.css>; rel=preload'
            })).not.to.throw();
        });

        it("rejects header names containing a colon", () => {
            expect(() => new InformationalResponseStep(103, { 'bad:name': 'v' })).to.throw(/header/i);
        });

        it("rejects header names containing CR or LF", () => {
            expect(() => new InformationalResponseStep(103, { 'bad\r\nname': 'v' })).to.throw(/header/i);
            expect(() => new InformationalResponseStep(103, { 'bad\nname': 'v' })).to.throw(/header/i);
        });

        it("rejects header values containing CR or LF", () => {
            expect(() => new InformationalResponseStep(103, { 'x': 'a\r\nInjected: yes' })).to.throw(/header/i);
            expect(() => new InformationalResponseStep(103, { 'x': 'a\nb' })).to.throw(/header/i);
        });

        it("rejects invalid headers passed as raw header pairs", () => {
            expect(() => new InformationalResponseStep(103, [['x', 'a\r\nb']])).to.throw(/header/i);
            expect(() => new InformationalResponseStep(103, [['bad:name', 'v']])).to.throw(/header/i);
        });

        it("explains itself", () => {
            const step = new InformationalResponseStep(103, { 'link': '</a>' });
            expect(step.explain()).to.contain('103');
        });
    });

    nodeOnly(() => {

        describe("over HTTP/1.1", () => {

            const server = getLocal();

            beforeEach(() => server.start());
            afterEach(() => server.stop());

            it("sends a 103 Early Hints response with headers before the final response", async () => {
                await server.forGet('/x')
                    .sendInfoResponse(103, { 'link': '</style.css>; rel=preload' })
                    .thenReply(200, 'final body');

                const raw = await rawHttp1Request(server, '/x');
                const idx103 = raw.indexOf('HTTP/1.1 103');
                const idx200 = raw.indexOf('HTTP/1.1 200');

                expect(idx103).to.be.greaterThanOrEqual(0);
                expect(idx200).to.be.greaterThan(idx103);
                expect(raw.slice(idx103, idx200)).to.match(/link: <\/style\.css>; rel=preload/i);
                expect(raw).to.contain('final body');
            });

            it("sends a 100 Continue response with no headers", async () => {
                await server.forGet('/x')
                    .sendInfoResponse(100)
                    .thenReply(200, 'ok');

                const raw = await rawHttp1Request(server, '/x');
                expect(raw).to.match(/HTTP\/1\.1 100[^\r\n]*\r\n\r\n/);
                expect(raw).to.contain('HTTP/1.1 200');
                expect(raw).to.contain('ok');
            });

            it("sends a non-standard 1xx response (199) with custom headers", async () => {
                await server.forGet('/x')
                    .sendInfoResponse(199, { 'x-custom': 'hi' })
                    .thenReply(200, 'ok');

                const raw = await rawHttp1Request(server, '/x');
                const idx199 = raw.indexOf('HTTP/1.1 199');
                const idx200 = raw.indexOf('HTTP/1.1 200');
                expect(idx199).to.be.greaterThanOrEqual(0);
                expect(idx200).to.be.greaterThan(idx199);
                expect(raw.slice(idx199, idx200)).to.match(/x-custom: hi/i);
            });

            it("supports multiple informational responses before the final response", async () => {
                await server.forGet('/x')
                    .sendInfoResponse(102)
                    .sendInfoResponse(103, { 'link': '</a>' })
                    .sendInfoResponse(103, { 'link': '</b>' })
                    .thenReply(200, 'ok');

                const raw = await rawHttp1Request(server, '/x');
                const idx102 = raw.indexOf('HTTP/1.1 102');
                const idx103a = raw.indexOf('HTTP/1.1 103');
                const idx103b = raw.indexOf('HTTP/1.1 103', idx103a + 1);
                const idx200 = raw.indexOf('HTTP/1.1 200');

                expect(idx102).to.be.greaterThanOrEqual(0);
                expect(idx103a).to.be.greaterThan(idx102);
                expect(idx103b).to.be.greaterThan(idx103a);
                expect(idx200).to.be.greaterThan(idx103b);
                expect(raw.slice(idx103a, idx103b)).to.match(/link: <\/a>/i);
                expect(raw.slice(idx103b, idx200)).to.match(/link: <\/b>/i);
            });

            it("composes with delay() before the informational response", async () => {
                await server.forGet('/x')
                    .delay(50)
                    .sendInfoResponse(103, { 'link': '</a>' })
                    .thenReply(200, 'ok');

                const start = Date.now();
                const raw = await rawHttp1Request(server, '/x');
                expect(Date.now() - start).to.be.greaterThanOrEqual(49);
                expect(raw).to.contain('HTTP/1.1 103');
                expect(raw).to.contain('HTTP/1.1 200');
            });

            it("does not leak informational headers into the final response headers", async () => {
                await server.forGet('/x')
                    .sendInfoResponse(103, { 'x-hint-only': 'yes' })
                    .thenReply(200, 'ok', { 'x-final': 'true' });

                const raw = await rawHttp1Request(server, '/x');
                const idx200 = raw.indexOf('HTTP/1.1 200');
                const finalSection = raw.slice(idx200);
                expect(finalSection).to.match(/x-final: true/i);
                expect(finalSection).not.to.match(/x-hint-only/i);
            });

            it("can be chained: builder method returns this", async () => {
                const builder = server.forGet('/x').sendInfoResponse(103, { 'link': '</a>' });
                expect(typeof builder.thenReply).to.equal('function');
            });

            it("emits a Node-parseable information with status and headers", async () => {
                await server.forGet('/x')
                    .sendInfoResponse(199, { 'x-hint': 'value', 'link': '</a>' })
                    .thenReply(200, 'ok');

                const infoEvents: Array<{ statusCode: number, statusMessage: string, headers: http.IncomingHttpHeaders }> = [];
                const finalStatus = await new Promise<number>((resolve, reject) => {
                    const req = http.get(url.parse(server.urlFor('/x')));
                    req.on('information', (info) => {
                        infoEvents.push({
                            statusCode: info.statusCode,
                            statusMessage: info.statusMessage,
                            headers: info.headers
                        });
                    });
                    req.on('response', (res) => {
                        res.on('data', () => {});
                        res.on('end', () => resolve(res.statusCode!));
                    });
                    req.on('error', reject);
                });

                expect(infoEvents.length).to.equal(1);
                expect(infoEvents[0].statusCode).to.equal(199);
                expect(infoEvents[0].statusMessage).to.equal('Information');
                expect(infoEvents[0].headers['x-hint']).to.equal('value');
                expect(infoEvents[0].headers['link']).to.equal('</a>');
                expect(finalStatus).to.equal(200);
            });

            it("is non-final: allows a terminal step to follow it", async () => {
                // Manually build a rule to confirm the engine accepts the step
                // before a final step (and would reject it after one).
                await server.addRequestRules({
                    matchers: [new matchers.FlexiblePathMatcher('/x')],
                    steps: [
                        new InformationalResponseStep(103, { 'link': '</a>' }),
                        new requestSteps.FixedResponseStep(200, 'ok')
                    ]
                });

                const raw = await rawHttp1Request(server, '/x');
                expect(raw).to.contain('HTTP/1.1 103');
                expect(raw).to.contain('HTTP/1.1 200');
            });
        });

        describe("with non-standard Expect headers", () => {

            const server = getLocal();

            beforeEach(() => server.start());
            afterEach(() => server.stop());

            it("routes a non-standard Expect through to the matching rule", async () => {
                const endpoint = await server.forGet('/x').thenReply(200, 'rule ran');

                const sock = await openRawSocket(server);
                const raw = await new Promise<string>((resolve, reject) => {
                    let buf = '';
                    sock.on('data', d => { buf += d.toString('utf8'); });
                    sock.on('end', () => resolve(buf));
                    sock.on('error', reject);
                    sock.write(
                        `GET /x HTTP/1.1\r\nHost: localhost\r\n` +
                        `Expect: x-weird-thing\r\nConnection: close\r\n\r\n`
                    );
                });

                expect(raw).to.contain('HTTP/1.1 200');
                expect(raw).to.contain('rule ran');
                expect(raw).not.to.contain('417');

                const seen = await endpoint.getSeenRequests();
                expect(seen.length).to.equal(1);
                expect(seen[0].headers['expect']).to.equal('x-weird-thing');
            });
        });

        describe("forwarded from upstream via passthrough", () => {

            const upstream = getLocal();
            const proxy = getLocal();

            beforeEach(async () => {
                await upstream.start();
                await proxy.start();
            });
            afterEach(async () => {
                await proxy.stop();
                await upstream.stop();
            });

            function getWithInfo(target: Mockttp, path: string) {
                return new Promise<{
                    info: Array<{ statusCode: number, headers: http.IncomingHttpHeaders }>,
                    finalStatus: number,
                    body: string
                }>((resolve, reject) => {
                    const info: Array<{ statusCode: number, headers: http.IncomingHttpHeaders }> = [];
                    const req = http.get(url.parse(target.urlFor(path)));
                    req.on('information', (i) => info.push({ statusCode: i.statusCode, headers: i.headers }));
                    req.on('response', (res) => {
                        let body = '';
                        res.on('data', (d) => { body += d.toString('utf8'); });
                        res.on('end', () => resolve({ info, finalStatus: res.statusCode!, body }));
                    });
                    req.on('error', reject);
                });
            }

            it("forwards a 103 Early Hints response from the upstream server to the client", async () => {
                await upstream.forGet('/x')
                    .sendInfoResponse(103, { 'link': '</style.css>; rel=preload' })
                    .thenReply(200, 'final body');
                await proxy.forGet('/x').thenForwardTo(`http://localhost:${upstream.port}`);

                const result = await getWithInfo(proxy, '/x');

                expect(result.info.length).to.equal(1);
                expect(result.info[0].statusCode).to.equal(103);
                expect(result.info[0].headers['link']).to.equal('</style.css>; rel=preload');
                expect(result.finalStatus).to.equal(200);
                expect(result.body).to.equal('final body');
            });

            it("forwards multiple 1xx responses preserving order", async () => {
                await upstream.forGet('/x')
                    .sendInfoResponse(102)
                    .sendInfoResponse(103, { 'link': '</a>' })
                    .thenReply(200, 'ok');
                await proxy.forGet('/x').thenForwardTo(`http://localhost:${upstream.port}`);

                const result = await getWithInfo(proxy, '/x');

                expect(result.info.map(i => i.statusCode)).to.deep.equal([102, 103]);
                expect(result.info[1].headers['link']).to.equal('</a>');
                expect(result.finalStatus).to.equal(200);
            });

            it("does not forward upstream 100 Continue (could duplicate auto-100)", async () => {
                await upstream.forGet('/x')
                    .sendInfoResponse(100)
                    .thenReply(200, 'ok');
                await proxy.forGet('/x').thenForwardTo(`http://localhost:${upstream.port}`);

                const result = await getWithInfo(proxy, '/x');

                expect(result.info.map(i => i.statusCode)).not.to.include(100);
                expect(result.finalStatus).to.equal(200);
            });
        });

        describe("over HTTP/2", () => {

            if (nodeSatisfies(BROKEN_H2_OVER_H2_TUNNELLING)) return;

            const server = getLocal();

            beforeEach(() => server.start());
            afterEach(() => server.stop());

            it("sends a 103 Early Hints response with headers before the final response", async () => {
                await server.forGet('/x')
                    .sendInfoResponse(103, { 'link': '</style.css>; rel=preload' })
                    .thenReply(200, 'final body');

                const client = http2.connect(server.url);
                const req = client.request({ ':path': '/x' });
                const result = await collectHttp2(req);

                expect(result.informational.length).to.equal(1);
                expect(result.informational[0][':status']).to.equal(103);
                expect(result.informational[0]['link']).to.equal('</style.css>; rel=preload');
                expect(result.response[':status']).to.equal(200);
                expect(result.body.toString('utf8')).to.equal('final body');

                await cleanup(client);
            });

            it("sends a 100 Continue response with no headers", async () => {
                await server.forGet('/x')
                    .sendInfoResponse(100)
                    .thenReply(200, 'ok');

                const client = http2.connect(server.url);
                const req = client.request({ ':path': '/x' });
                const result = await collectHttp2(req);

                expect(result.informational.length).to.equal(1);
                expect(result.informational[0][':status']).to.equal(100);
                expect(result.response[':status']).to.equal(200);

                await cleanup(client);
            });

            it("sends a 102 Processing response", async () => {
                await server.forGet('/x')
                    .sendInfoResponse(102)
                    .thenReply(200, 'ok');

                const client = http2.connect(server.url);
                const req = client.request({ ':path': '/x' });
                const result = await collectHttp2(req);

                expect(result.informational.length).to.equal(1);
                expect(result.informational[0][':status']).to.equal(102);
                expect(result.response[':status']).to.equal(200);

                await cleanup(client);
            });

            it("sends a non-standard 1xx response (199) with custom headers", async () => {
                await server.forGet('/x')
                    .sendInfoResponse(199, { 'x-custom': 'hi' })
                    .thenReply(200, 'ok');

                const client = http2.connect(server.url);
                const req = client.request({ ':path': '/x' });
                const result = await collectHttp2(req);

                expect(result.informational.length).to.equal(1);
                expect(result.informational[0][':status']).to.equal(199);
                expect(result.informational[0]['x-custom']).to.equal('hi');
                expect(result.response[':status']).to.equal(200);

                await cleanup(client);
            });

            it("supports multiple informational responses before the final response", async () => {
                await server.forGet('/x')
                    .sendInfoResponse(102)
                    .sendInfoResponse(103, { 'link': '</a>' })
                    .sendInfoResponse(103, { 'link': '</b>' })
                    .thenReply(200, 'ok');

                const client = http2.connect(server.url);
                const req = client.request({ ':path': '/x' });
                const result = await collectHttp2(req);

                expect(result.informational.length).to.equal(3);
                expect(result.informational[0][':status']).to.equal(102);
                expect(result.informational[1][':status']).to.equal(103);
                expect(result.informational[1]['link']).to.equal('</a>');
                expect(result.informational[2][':status']).to.equal(103);
                expect(result.informational[2]['link']).to.equal('</b>');
                expect(result.response[':status']).to.equal(200);

                await cleanup(client);
            });
        });

        describe("forwarded from H1 upstream to H2 client via passthrough", () => {

            // H2 downstream + H1 upstream — exercises cross-protocol relay
            // (the proxy receives the upstream 1xx as an H1 'information' event
            // and re-emits it via H2 additionalHeaders).
            const upstream = getLocal();
            const proxy = getLocal();

            beforeEach(async () => {
                await upstream.start();
                await proxy.start();
            });
            afterEach(async () => {
                await proxy.stop();
                await upstream.stop();
            });

            it("forwards a 103 Early Hints response and rewrites it for HTTP/2", async () => {
                await upstream.forGet('/x')
                    .sendInfoResponse(103, { 'link': '</style.css>; rel=preload' })
                    .thenReply(200, 'final body');
                await proxy.forGet('/x').thenForwardTo(`http://localhost:${upstream.port}`);

                const client = http2.connect(proxy.url);
                const req = client.request({ ':path': '/x' });
                const result = await collectHttp2(req);

                expect(result.informational.length).to.equal(1);
                expect(result.informational[0][':status']).to.equal(103);
                expect(result.informational[0]['link']).to.equal('</style.css>; rel=preload');
                expect(result.response[':status']).to.equal(200);
                expect(result.body.toString('utf8')).to.equal('final body');

                await cleanup(client);
            });
        });

        describe("forwarded from H2 upstream to H2 client via passthrough", () => {

            if (nodeSatisfies(BROKEN_H2_OVER_H2_TUNNELLING)) return;

            const upstream = getLocal({
                http2: true, // Prefer H2 in ALPN, so the proxy negotiates H2 upstream.
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem'
                }
            });
            const proxy = getLocal({
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem'
                }
            });

            beforeEach(async () => {
                await upstream.start();
                await proxy.start();
            });
            afterEach(async () => {
                await proxy.stop();
                await upstream.stop();
            });

            it("forwards a 103 Early Hints response end-to-end over HTTP/2", async () => {
                const upstreamEndpoint = await upstream.forGet('/x')
                    .sendInfoResponse(103, { 'link': '</style.css>; rel=preload' })
                    .thenReply(200, 'final body');
                await proxy.forGet(upstream.urlFor('/x')).thenPassThrough();

                const proxyClient = http2.connect(proxy.url);
                const tunnelReq = proxyClient.request({
                    ':method': 'CONNECT',
                    ':authority': `localhost:${upstream.port}`
                });
                expect((await getHttp2Response(tunnelReq))[':status']).to.equal(200);

                const tunnelledClient = http2.connect(upstream.url, {
                    createConnection: () => tls.connect({
                        host: 'localhost',
                        servername: 'localhost',
                        socket: tunnelReq as any,
                        ALPNProtocols: ['h2']
                    })
                });

                const req = tunnelledClient.request({ ':path': '/x' });
                const result = await collectHttp2(req);

                expect(result.informational.length).to.equal(1);
                expect(result.informational[0][':status']).to.equal(103);
                expect(result.informational[0]['link']).to.equal('</style.css>; rel=preload');
                expect(result.response[':status']).to.equal(200);
                expect(result.body.toString('utf8')).to.equal('final body');

                const seen = await upstreamEndpoint.getSeenRequests();
                expect(seen.length).to.equal(1);
                expect(seen[0].httpVersion, 'proxy should have used H2 to upstream')
                    .to.match(/^2/);

                await cleanup(tunnelledClient, proxyClient);
            });
        });
    });
});

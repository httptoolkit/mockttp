import * as http2 from 'http2';

import { getLocal, Mockttp, matchers, requestSteps } from "../../..";
const { InformationalResponseStep } = requestSteps;
import {
    expect,
    nodeOnly,
    cleanup,
    BROKEN_H2_OVER_H2_TUNNELLING,
    nodeSatisfies,
    openRawSocket
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
    });
});

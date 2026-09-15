import { Buffer } from 'buffer';
import * as http from 'http';
import * as http2 from 'http2';

import { getLocal, Mockttp, MockttpOptions, CompletedRequest, BodyData } from '../../..';
import { expect, nodeOnly, getDeferred, Deferred, makeDestroyable, DestroyableServer } from '../../test-utils';
import type { BufferInProgress } from '../../../src/util/buffer-utils';

nodeOnly(() => {
    // Package-root imports run the built server, so instrument its body reader.
    const bufferUtils: typeof import('../../../src/util/buffer-utils') = require('../../../dist/util/buffer-utils');
    describe("Passthrough request buffering", () => {
        let proxy: Mockttp | undefined;
        let target: DestroyableServer<http.Server>;
        let targetUrl: string;
        let received: Deferred<{ body: Buffer, trailers: http.IncomingHttpHeaders }>;
        let releaseResponse: Deferred<void>;
        let firstChunk: Deferred<void>;
        let upstreamAborted: Deferred<void>;
        let captures: BufferInProgress[];
        let bufferDescriptor: PropertyDescriptor;

        beforeEach(async () => {
            received = getDeferred();
            releaseResponse = getDeferred();
            firstChunk = getDeferred();
            upstreamAborted = getDeferred();
            captures = [];
            bufferDescriptor = Object.getOwnPropertyDescriptor(bufferUtils, 'streamToBuffer')!;
            const original = bufferUtils.streamToBuffer;
            Object.defineProperty(bufferUtils, 'streamToBuffer', {
                ...bufferDescriptor,
                value: (...args: Parameters<typeof original>) => {
                    const result = original(...args);
                    if ((args[0] as http.IncomingMessage).method === 'POST') captures.push(result);
                    return result;
                }
            });
            target = makeDestroyable(http.createServer((request, response) => {
                const chunks: Buffer[] = [];
                request.on('data', chunk => {
                    chunks.push(chunk);
                    firstChunk.resolve();
                });
                request.on('aborted', () => upstreamAborted.resolve());
                request.on('end', () => {
                    received.resolve({ body: Buffer.concat(chunks), trailers: request.trailers });
                    releaseResponse.then(() => response.end('ok'));
                });
            }));
            await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
            targetUrl = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
        });

        afterEach(async () => {
            releaseResponse.resolve();
            await proxy?.stop();
            proxy = undefined;
            await target.destroy();
            Object.defineProperty(bufferUtils, 'streamToBuffer', bufferDescriptor);
        });

        async function start(options: MockttpOptions = { recordTraffic: false }) {
            proxy = getLocal(options);
            await proxy.start();
            return proxy;
        }

        function upload(body: Buffer | string, trailers?: Record<string, string>) {
            const finished = getDeferred<void>();
            const request = http.request(proxy!.urlFor('/upload'), {
                method: 'POST',
                path: `${targetUrl}/upload`,
                headers: {
                    Host: new URL(targetUrl).host,
                    ...(trailers ? { Trailer: Object.keys(trailers).join(', ') } : {})
                }
            }, response => {
                response.resume();
                response.on('end', () => finished.resolve());
                response.on('error', finished.reject);
            });
            request.on('error', finished.reject);
            request.write(body);
            if (trailers) request.addTrailers(trailers);
            request.end();
            // A failed assertion can close the proxy before this request finishes.
            finished.catch(() => {});
            return finished;
        }

        const retainedBytes = () => captures.reduce((total, buffer) => total +
            buffer.currentChunks.reduce((size, chunk) => size + chunk.length, 0), 0);

        it("forwards an unobserved upload without retaining its body", async () => {
            const server = await start();
            const endpoint = await server.forAnyRequest().thenForwardTo(targetUrl);
            const body = Buffer.alloc(1024 * 1024, 'a');
            const finished = upload(body, { 'X-Upload-End': 'complete' });
            const actual = await received;

            expect(actual.body).to.deep.equal(body);
            expect(actual.trailers).to.deep.equal({ 'x-upload-end': 'complete' });
            expect(retainedBytes()).to.equal(0);
            releaseResponse.resolve();
            await finished;
            expect(await endpoint.getSeenRequests()).to.deep.equal([]);
        });

        it("preserves bodies for traffic recording", async () => {
            const server = await start({ recordTraffic: true });
            const endpoint = await server.forAnyRequest().thenForwardTo(targetUrl);
            const finished = upload('recorded upload');
            expect((await received).body.toString()).to.equal('recorded upload');
            releaseResponse.resolve();
            await finished;
            const requests = await endpoint.getSeenRequests();
            expect(await requests[0].body.getText()).to.equal('recorded upload');
        });

        it("streams HTTP/2 uploads without retaining a replay buffer", async () => {
            const server = await start({
                recordTraffic: false,
                http2: true,
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem'
                }
            });
            await server.forAnyRequest().thenForwardTo(targetUrl);
            const client = http2.connect(server.url);
            try {
                const request = client.request({ ':method': 'POST', ':path': '/upload' });
                const finished = getDeferred<void>();
                request.on('error', finished.reject);
                request.on('end', () => finished.resolve());
                finished.catch(() => {});
                request.resume();
                const body = Buffer.alloc(256 * 1024, 'h');
                request.end(body);
                expect((await received).body).to.deep.equal(body);
                expect(retainedBytes()).to.equal(0);
                releaseResponse.resolve();
                await finished;
            } finally {
                client.destroy();
            }
        });

        it("cancels an unbuffered upstream upload when the client disconnects", async () => {
            const server = await start();
            await server.forAnyRequest().thenForwardTo(targetUrl);
            const request = http.request(server.urlFor('/upload'), { method: 'POST' });
            request.on('error', () => {});
            request.write(Buffer.alloc(64 * 1024, 'a'));
            await firstChunk;
            request.destroy();
            await upstreamAborted;
        });

        it("preserves bodies for complete request subscriptions", async () => {
            const server = await start();
            const observed = getDeferred<CompletedRequest>();
            await server.on('request', request => observed.resolve(request));
            await server.forAnyRequest().thenForwardTo(targetUrl);
            const finished = upload('observed upload');
            expect((await received).body.toString()).to.equal('observed upload');
            expect(await (await observed).body.getText()).to.equal('observed upload');
            releaseResponse.resolve();
            await finished;
        });

        it("preserves streaming request data subscriptions", async () => {
            const server = await start();
            const events: BodyData[] = [];
            const ended = getDeferred<void>();
            await server.on('request-body-data', event => {
                events.push(event);
                if (event.isEnded) ended.resolve();
            });
            await server.forAnyRequest().thenForwardTo(targetUrl);
            const body = Buffer.alloc(256 * 1024, 'b');
            const finished = upload(body);
            expect((await received).body).to.deep.equal(body);
            await ended;
            expect(Buffer.concat(events.map(event => Buffer.from(event.content)))).to.deep.equal(body);
            releaseResponse.resolve();
            await finished;
        });

        it("replays bodies already read by a matcher", async () => {
            const server = await start();
            await server.forAnyRequest().withBody('matched upload').thenForwardTo(targetUrl);
            const finished = upload('matched upload');
            expect((await received).body.toString()).to.equal('matched upload');
            releaseResponse.resolve();
            await finished;
        });

        for (const callback of ['beforeRequest', 'beforeResponse'] as const) {
            it(`preserves bodies needed by ${callback}`, async () => {
                const server = await start();
                let observed: string | undefined;
                await server.forAnyRequest().thenPassThrough(callback === 'beforeRequest' ? {
                    beforeRequest: async request => { observed = await request.body.getText(); }
                } : {
                    beforeResponse: async (_response, request) => { observed = await request.body.getText(); }
                });
                const finished = upload('callback upload');
                expect((await received).body.toString()).to.equal('callback upload');
                releaseResponse.resolve();
                await finished;
                expect(observed).to.equal('callback upload');
            });
        }

        it("preserves request body transforms", async () => {
            const server = await start();
            await server.forAnyRequest().thenForwardTo(targetUrl, {
                transformRequest: { updateJsonBody: { extra: true } }
            });
            const finished = upload(JSON.stringify({ original: true }));
            expect(JSON.parse((await received).body.toString())).to.deep.equal({ original: true, extra: true });
            releaseResponse.resolve();
            await finished;
        });

        it("forwards oversized observed uploads without losing their prefix", async () => {
            const server = await start({ recordTraffic: false, maxBodySize: 4 });
            const observed = getDeferred<CompletedRequest>();
            await server.on('request', request => observed.resolve(request));
            await server.forAnyRequest().thenForwardTo(targetUrl);
            const body = Buffer.alloc(256 * 1024, 'c');
            const finished = upload(body);
            expect((await received).body).to.deep.equal(body);
            expect((await observed).body.buffer.length).to.equal(0);
            releaseResponse.resolve();
            await finished;
        });
    });
});

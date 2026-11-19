import { Buffer } from 'buffer';
import * as zlib from 'zlib';
import * as stream from 'stream';

import { expect, nodeOnly, delay } from './test-utils';
import {
    buildBodyReader,
    preprocessRequest,
    ExtendedRawRequest
} from '../src/util/request-utils';
import { streamToBuffer } from '../src/util/buffer-utils';
import { LastHopEncrypted } from '../src/util/socket-extensions';

nodeOnly(() => {
    describe("buildBodyReader", () => {

        describe(".text", () => {
            it('returns the raw text for unspecified requests', async () => {
                const body = buildBodyReader(Buffer.from('hello world'), {});
                expect(await body.getText()).to.equal('hello world');
            });

            it('returns the raw text for identity requests', async () => {
                const body = buildBodyReader(Buffer.from('hello world'), {
                    'content-encoding': 'identity'
                });
                expect(await body.getText()).to.equal('hello world');
            });

            it('is undefined for unknown encodings', async () => {
                const body = buildBodyReader(Buffer.from('hello world'), {
                    'content-encoding': 'randomized'
                });
                expect(await body.getText()).to.equal(undefined);
            });

            it('can decode gzip bodies', async () => {
                const content = zlib.gzipSync('Gzip response');
                const body = buildBodyReader(content, {
                    'content-encoding': 'gzip'
                });
                expect(await body.getText()).to.equal('Gzip response');
            });

            it('can decode zlib deflate bodies', async () => {
                const content = zlib.deflateSync('Deflate response');
                const body = buildBodyReader(content, {
                    'content-encoding': 'deflate'
                });
                expect(await body.getText()).to.equal('Deflate response');
            });

            it('can decode raw deflate bodies', async () => {
                const content = zlib.deflateRawSync('Raw deflate response');
                const body = buildBodyReader(content, {
                    'content-encoding': 'deflate'
                });
                expect(await body.getText()).to.equal('Raw deflate response');
            });

            it('can decode brotli bodies', async function () {
                if (!zlib.brotliCompressSync) this.skip();

                const content = zlib.brotliCompressSync('Brotli brotli brotli brotli brotli');
                const body = buildBodyReader(content, {
                    'content-encoding': 'br'
                });
                expect(await body.getText()).to.equal('Brotli brotli brotli brotli brotli');
            });

            it('can decode zstandard bodies', async function () {
                if (!zlib.zstdCompressSync) this.skip();

                const content = zlib.zstdCompressSync('hello zstd zstd zstd world');
                const body = buildBodyReader(content, {
                    'content-encoding': 'zstd'
                });
                expect(await body.getText()).to.equal('hello zstd zstd zstd world');
            });

            it('can decode bodies with multiple encodings', async function () {
                if (!zlib.brotliCompressSync) this.skip();

                const content = zlib.gzipSync(
                    zlib.brotliCompressSync(
                        'First brotli, then gzip, now this'
                    )
                );
                const body = buildBodyReader(content, {
                    'content-encoding': 'br, identity, gzip, identity'
                });

                expect(await body.getText()).to.equal('First brotli, then gzip, now this');
            });
        });

        describe(".json", () => {
            it('parses JSON objects', async () => {
                const body = buildBodyReader(Buffer.from('{"a":1}'), {});
                expect(await body.getJson()).to.deep.equal({ a: 1 });
            });

            it('parses JSON arrays', async () => {
                const body = buildBodyReader(Buffer.from('[1,2]'), {});
                expect(await body.getJson()).to.deep.equal([1, 2]);
            });

            it('parses JSON primitives', async () => {
                const numberBody = buildBodyReader(Buffer.from('42'), {});
                expect(await numberBody.getJson()).to.equal(42);

                const nullBody = buildBodyReader(Buffer.from('null'), {});
                expect(await nullBody.getJson()).to.equal(null);
            });

            it('can return an explicitly typed result', async () => {
                const body = buildBodyReader(Buffer.from('{"a":1}'), {});
                const json = await body.getJson<{ a: number }>();
                expect(json?.a).to.equal(1);
            });

            it('is undefined for invalid JSON', async () => {
                const body = buildBodyReader(Buffer.from('{oops'), {});
                expect(await body.getJson()).to.equal(undefined);
            });

            it('is undefined for unknown encodings', async () => {
                const body = buildBodyReader(Buffer.from('{"a":1}'), {
                    'content-encoding': 'randomized'
                });
                expect(await body.getJson()).to.equal(undefined);
            });
        });

    });

    describe("preprocessRequest", () => {
        it('reconstructs valid absolute URLs from bracketed IPv6 host headers', () => {
            const req = Object.assign(new stream.PassThrough(), {
                method: 'GET',
                url: '/api',
                headers: {
                    host: '[::1]:8000'
                },
                rawHeaders: ['Host', '[::1]:8000'],
                httpVersion: '1.1',
                socket: {
                    [LastHopEncrypted]: false
                }
            }) as any;

            const result = preprocessRequest(req, {
                type: 'request',
                serverPort: 45454,
                maxBodySize: 1024
            });

            expect(result).to.not.equal(null);
            expect(req.url).to.equal('http://[::1]:8000/api');
            expect(req.destination).to.deep.equal({
                hostname: '::1',
                port: 8000
            });
        });

        describe("body handling", () => {
            const MAX_SIZE = 1024;

            const buildRequest = () => Object.assign(new stream.PassThrough(), {
                method: 'POST',
                url: '/api',
                headers: { host: 'localhost' },
                rawHeaders: ['Host', 'localhost'],
                httpVersion: '1.1',
                socket: {
                    [LastHopEncrypted]: false
                }
            }) as unknown as stream.PassThrough & ExtendedRawRequest;

            const setup = (
                onBodyData?: (id: string, timestamp: number, content: Uint8Array, isEnded: boolean) => void
            ) => {
                const req = buildRequest();
                const { body } = preprocessRequest(req, {
                    type: 'request',
                    serverPort: 45454,
                    maxBodySize: MAX_SIZE,
                    onBodyData
                })!;
                return { req, body };
            };

            // Data sent by the client that the body hasn't read yet:
            const unreadData = (req: stream.PassThrough) => req.writableLength + req.readableLength;

            // Large enough to fill every stream buffer, and patterned so lost or reordered data shows up:
            const LARGE_BODY = Buffer.alloc(1024 * 1024);
            for (let i = 0; i < LARGE_BODY.length; i++) LARGE_BODY[i] = 65 + (i % 26);
            const OVERSIZE_BODY = LARGE_BODY.subarray(0, MAX_SIZE * 2);

            // Sent in many chunks, so that the body can be partly read:
            const sendInChunks = (req: stream.PassThrough, data: Buffer) => {
                for (let i = 0; i < data.length; i += 16 * 1024) req.write(data.subarray(i, i + 16 * 1024));
                req.end();
            };

            it("doesn't read the body until something needs it", async () => {
                const observed: Uint8Array[] = [];
                const { req, body } = setup((_id, _timestamp, content) => observed.push(content));

                req.write('hello');
                await delay(30);

                // Body data events don't count: they only see the body as it's used.
                expect(unreadData(req)).to.equal(5);

                const result = streamToBuffer(body.asStream());
                req.end(' world');
                expect((await result).toString()).to.equal('hello world');

                await delay(30);
                expect(Buffer.concat(observed).toString()).to.equal('hello world');
            });

            describe("as content", () => {

                it("buffers the whole body, up to the max size", async () => {
                    const { req, body } = setup();
                    const content = LARGE_BODY.subarray(0, MAX_SIZE);

                    req.end(content);
                    await delay(0);

                    expect((await body.asBuffer()).equals(content)).to.equal(true);
                    expect(body.isTruncated()).to.equal(false);
                });

                it("buffers an empty body", async () => {
                    const { req, body } = setup();
                    req.end();

                    expect((await body.asBuffer()).length).to.equal(0);
                });
            });

            describe("as a stream", () => {

                it("streams the whole body, including anything sent beforehand", async () => {
                    const { req, body } = setup();

                    req.write('hello ');
                    await delay(0);

                    const result = streamToBuffer(body.asStream());
                    req.end('world');
                    expect((await result).toString()).to.equal('hello world');
                });

                it("replays buffered content, then continues live", async () => {
                    const { req, body } = setup();

                    const content = body.asBuffer();
                    req.write('hello ');
                    await delay(0);

                    const result = streamToBuffer(body.asStream());
                    req.end('world');

                    expect((await result).toString()).to.equal('hello world');
                    expect((await content).toString()).to.equal('hello world');
                });

                it("streams a completely buffered body, once", async () => {
                    const { req, body } = setup();

                    req.end('hello world');
                    await body.asBuffer();

                    expect((await streamToBuffer(body.asStream())).toString()).to.equal('hello world');
                    expect(() => body.asStream()).to.throw(/already been taken/);
                });

                it("reads the body only as fast as the stream is read", async () => {
                    const { req, body } = setup();
                    const bodyStream = body.asStream();

                    sendInChunks(req, LARGE_BODY);
                    await delay(10);
                    expect(unreadData(req)).to.be.greaterThan(LARGE_BODY.length / 2);

                    expect((await streamToBuffer(bodyStream)).equals(LARGE_BODY)).to.equal(true);
                });

                it("reads the body only as fast as the slowest observer", async () => {
                    const { req, body } = setup();
                    const observer = body.observe();
                    const consumed = streamToBuffer(body.asStream());

                    sendInChunks(req, LARGE_BODY);
                    await delay(10);
                    expect(unreadData(req)).to.be.greaterThan(LARGE_BODY.length / 2);

                    expect((await streamToBuffer(observer)).equals(LARGE_BODY)).to.equal(true);
                    expect((await consumed).equals(LARGE_BODY)).to.equal(true);
                });

                it("isn't held up by an observer that's closed early", async () => {
                    const { req, body } = setup();
                    body.observe().destroy();

                    const consumed = streamToBuffer(body.asStream());
                    sendInChunks(req, LARGE_BODY);

                    expect((await consumed).equals(LARGE_BODY)).to.equal(true);
                });
            });

            describe("once streamed", () => {

                it("refuses to buffer, observe or stream it again", async () => {
                    const { body } = setup();
                    body.asStream();

                    // This fails regardless of whether any data has arrived yet:
                    await expect(body.asBuffer()).to.be.rejectedWith(/already been taken/);
                    expect(() => body.observe()).to.throw(/already been taken/);
                    expect(() => body.asStream()).to.throw(/already been taken/);
                });

                it("still serves content captured beforehand", async () => {
                    const { req, body } = setup();
                    body.startCapture();
                    const streamed = streamToBuffer(body.asStream());

                    req.end('hello world');

                    expect((await streamed).toString()).to.equal('hello world');
                    expect((await body.asBuffer()).toString()).to.equal('hello world');
                });
            });

            describe("once dumped", () => {

                it("refuses to buffer, observe or stream it", async () => {
                    const { body } = setup();
                    body.dump();

                    expect(() => body.startCapture()).to.throw(/was dumped/);
                    await expect(body.asBuffer()).to.be.rejectedWith(/was dumped/);
                    expect(() => body.observe()).to.throw(/was dumped/);
                    expect(() => body.asStream()).to.throw(/was dumped/);
                });

                it("reads and discards the body", async () => {
                    const { req, body } = setup();

                    req.write('some data');
                    body.dump();
                    await delay(0);

                    expect(unreadData(req)).to.equal(0);
                });

                it("keeps collecting content captured beforehand", async () => {
                    const { req, body } = setup();

                    const content = body.asBuffer();
                    req.write('hello ');
                    body.dump();
                    req.end('world');

                    expect((await content).toString()).to.equal('hello world');
                });
            });

            describe("waiting for the end", () => {

                it("reads the whole body, keeping its content to stream afterwards", async () => {
                    const { req, body } = setup();

                    const ended = body.waitForEnd();
                    req.end('hello world');
                    await ended;

                    expect((await body.asBuffer()).toString()).to.equal('hello world');
                    expect((await streamToBuffer(body.asStream())).toString()).to.equal('hello world');
                });

                it("reads the whole of a body too large to keep, but then refuses to stream it", async () => {
                    const { req, body } = setup();

                    const ended = body.waitForEnd();
                    sendInChunks(req, LARGE_BODY);
                    await ended;

                    expect(body.isTruncated()).to.equal(true);
                    expect(() => body.asStream()).to.throw(/exceeded the maximum size/);
                });

                it("refuses to stream the body until the end, regardless of the size so far", async () => {
                    const { req, body } = setup();

                    body.waitForEnd();
                    req.write('some data');
                    await delay(0);

                    expect(() => body.asStream()).to.throw(/being read to its end/);
                    expect(() => body.observe()).to.throw(/being read to its end/);
                });

                it("just waits for the end of a body that's already streaming", async () => {
                    const { req, body } = setup();

                    const streamed = streamToBuffer(body.asStream());
                    const ended = body.waitForEnd();
                    sendInChunks(req, LARGE_BODY);

                    await ended;
                    expect((await streamed).equals(LARGE_BODY)).to.equal(true);
                });
            });

            describe("over the max size", () => {

                it("resolves the content empty, and pauses until it's streamed in full", async () => {
                    const { req, body } = setup();

                    const content = body.asBuffer();
                    req.write(OVERSIZE_BODY.subarray(0, 1500));
                    await delay(0);

                    expect((await content).length).to.equal(0);
                    expect(body.isTruncated()).to.equal(true);
                    expect(req.isPaused()).to.equal(true);

                    const result = streamToBuffer(body.asStream());
                    req.end(OVERSIZE_BODY.subarray(1500));
                    expect((await result).equals(OVERSIZE_BODY)).to.equal(true);
                });

                it("streams in full when streamed slowly, beyond the stream's high water mark", async () => {
                    const { req, body } = setup();
                    const largeBody = LARGE_BODY.subarray(0, 256 * 1024);

                    body.startCapture();
                    req.write(largeBody.subarray(0, 200 * 1024));
                    await delay(0);
                    expect(req.isPaused()).to.equal(true);

                    // Consume slowly, as a real upstream socket would, rather than in one go:
                    const bodyStream = body.asStream();
                    const chunks: Buffer[] = [];
                    const result = new Promise<Buffer>((resolve, reject) => {
                        bodyStream.on('readable', () => {
                            let chunk: Buffer | null;
                            while ((chunk = bodyStream.read(4096)) !== null) chunks.push(chunk);
                        });
                        bodyStream.on('end', () => resolve(Buffer.concat(chunks)));
                        bodyStream.on('error', reject);
                    });

                    req.end(largeBody.subarray(200 * 1024));
                    expect((await result).equals(largeBody)).to.equal(true);
                });

                it("streams in full when streamed before the max size is reached", async () => {
                    const { req, body } = setup();

                    const content = body.asBuffer();
                    const result = streamToBuffer(body.asStream());

                    req.write(OVERSIZE_BODY.subarray(0, 1500));
                    await delay(0);
                    req.end(OVERSIZE_BODY.subarray(1500));

                    expect((await result).equals(OVERSIZE_BODY)).to.equal(true);
                    expect((await content).length).to.equal(0);
                });

                it("drains the body once dumped", async () => {
                    const { req, body } = setup();

                    body.startCapture();
                    req.write(OVERSIZE_BODY.subarray(0, 1500));
                    await delay(0);
                    expect(req.isPaused()).to.equal(true);

                    body.dump();
                    expect(req.isPaused()).to.equal(false);

                    const ended = new Promise((resolve) => req.on('end', resolve));
                    req.end(OVERSIZE_BODY.subarray(1500));
                    await ended;
                });

                it("lets body data observers see everything", async () => {
                    const observed: Uint8Array[] = [];
                    const { req, body } = setup((_id, _timestamp, content) => observed.push(content));

                    body.startCapture();
                    req.write(OVERSIZE_BODY.subarray(0, 1500));
                    await delay(30);
                    expect(req.isPaused()).to.equal(true);

                    const result = streamToBuffer(body.asStream());
                    req.end(OVERSIZE_BODY.subarray(1500));
                    expect((await result).equals(OVERSIZE_BODY)).to.equal(true);

                    await delay(30);
                    expect(Buffer.concat(observed).equals(OVERSIZE_BODY)).to.equal(true);
                });

                it("loses nothing if something else resumes the paused body", async () => {
                    const { req, body } = setup();
                    body.startCapture();
                    const observed = streamToBuffer(body.observe());

                    req.write(OVERSIZE_BODY.subarray(0, 1500));
                    await delay(0);
                    expect(req.isPaused()).to.equal(true);

                    req.resume();
                    req.write(OVERSIZE_BODY.subarray(1500, 1800));
                    await delay(0);

                    const consumed = streamToBuffer(body.asStream());
                    req.end(OVERSIZE_BODY.subarray(1800));

                    expect((await consumed).equals(OVERSIZE_BODY)).to.equal(true);
                    expect((await observed).equals(OVERSIZE_BODY)).to.equal(true);
                });

                it("truncates content captured after too much had already arrived", async () => {
                    const { req, body } = setup();

                    // Something else resumes the body before anything needs it, so it all arrives:
                    req.resume();
                    req.end(OVERSIZE_BODY);
                    await delay(0);

                    expect((await body.asBuffer()).length).to.equal(0);
                    expect(body.isTruncated()).to.equal(true);
                });
            });

            describe("when the body fails", () => {

                it("fails streams, whether they're being read or not", async () => {
                    const { req, body } = setup();
                    const observed = streamToBuffer(body.observe());
                    const taken = body.asStream(); // Not read yet

                    req.write('partial body');
                    await delay(0);
                    req.destroy(new Error('Body failed'));

                    // Failures must never look like a clean but short body:
                    await expect(observed).to.be.rejectedWith('Body failed');
                    await expect(streamToBuffer(taken)).to.be.rejectedWith('Body failed');
                    expect(taken.destroyed).to.equal(true);
                });

                it("fails content, streams and the end requested afterwards", async () => {
                    const { req, body } = setup();

                    req.destroy(new Error('Body failed'));
                    await delay(0);

                    await expect(body.asBuffer()).to.be.rejectedWith('Body failed');
                    await expect(streamToBuffer(body.observe())).to.be.rejectedWith('Body failed');
                    await expect(streamToBuffer(body.asStream())).to.be.rejectedWith('Body failed');
                    await expect(body.waitForEnd()).to.be.rejectedWith('Body failed');
                });

                it("doesn't report failures that nothing asked about as unhandled", async () => {
                    // Body data events observe the body without reading its content, so a failure there
                    // has no other handler. If it isn't handled, the resulting unhandled rejection fails
                    // this test (and would take a real process down).
                    const { req } = setup(() => {});

                    req.write('partial body');
                    await delay(0);
                    req.destroy(new Error('Body failed'));
                    await delay(50);
                });

                it("fails if something else reads the body to its end", async () => {
                    const { req, body } = setup();

                    // Node's HTTP server does exactly this to request bodies that nothing has read:
                    req.removeAllListeners('data');
                    req.resume();
                    req.end('unseen data');
                    await delay(0);

                    await expect(body.asBuffer()).to.be.rejectedWith(/read elsewhere/);
                    await expect(streamToBuffer(body.asStream())).to.be.rejectedWith(/read elsewhere/);
                });
            });
        });
    });
});

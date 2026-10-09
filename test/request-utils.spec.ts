import { Buffer } from 'buffer';
import * as zlib from 'zlib';
import * as stream from 'stream';

import { expect, nodeOnly } from './test-utils';
import { buildBodyReader, preprocessRequest } from '../src/util/request-utils';
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
    });
});

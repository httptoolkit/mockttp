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

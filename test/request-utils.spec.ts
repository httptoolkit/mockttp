import * as zlib from 'zlib';
import * as brotliPromise from 'brotli-wasm';
import { ZstdCodec, ZstdStreaming } from 'zstd-codec';

import { expect } from './test-utils';
import { buildBodyReader } from '../src/util/request-utils';

const zstd: Promise<ZstdStreaming> = new Promise((resolve) =>
    ZstdCodec.run((binding) => {
        resolve(new binding.Streaming())
    })
);

describe("buildBodyReader", () => {

    let brotli: typeof import('brotli-wasm');
    beforeEach(async () => {
        brotli = await brotliPromise;
    });

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
            const content = Buffer.from(zlib.gzipSync('Gzip response'));
            const body = buildBodyReader(content, {
                'content-encoding': 'gzip'
            });
            expect(await body.getText()).to.equal('Gzip response');
        });

        it('can decode zlib deflate bodies', async () => {
            const content = Buffer.from(zlib.deflateSync('Deflate response'));
            const body = buildBodyReader(content, {
                'content-encoding': 'deflate'
            });
            expect(await body.getText()).to.equal('Deflate response');
        });

        it('can decode raw deflate bodies', async () => {
            const content = Buffer.from(zlib.deflateRawSync('Raw deflate response'));
            const body = buildBodyReader(content, {
                'content-encoding': 'deflate'
            });
            expect(await body.getText()).to.equal('Raw deflate response');
        });

        it('can decode brotli bodies', async () => {
            const content = Buffer.from(
                await brotli.compress(Buffer.from('Brotli brotli brotli brotli brotli', 'utf8'))
            );
            const body = buildBodyReader(content, {
                'content-encoding': 'br'
            });
            expect(await body.getText()).to.equal('Brotli brotli brotli brotli brotli');
        });

        it('can decode brotli bodies again', async () => {
            const content = Buffer.from(
                await brotli.compress(Buffer.from('Brotli brotli brotli brotli brotli', 'utf8'))
            );
            const body = buildBodyReader(content, {
                'content-encoding': 'br'
            });
            expect(await body.getText()).to.equal('Brotli brotli brotli brotli brotli');
        });

        it('can decode zstandard bodies', async () => {
            const content = Buffer.from((await zstd).compress(Buffer.from('hello zstd zstd zstd world')));
            const body = buildBodyReader(content, {
                'content-encoding': 'zstd'
            });
            expect(await body.getText()).to.equal('hello zstd zstd zstd world');
        });

        it('can decode bodies with multiple encodings', async () => {
            const content = zlib.gzipSync(
                Buffer.from(await brotli.compress(
                    Buffer.from('First brotli, then gzip, now this', 'utf8')
                ))
            );
            const body = buildBodyReader(content, {
                'content-encoding': 'br, identity, gzip, identity'
            });

            expect(await body.getText()).to.equal('First brotli, then gzip, now this');
        });
    });
});
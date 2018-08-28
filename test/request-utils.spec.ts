import * as zlib from 'zlib';

import { expect } from './test-utils';
import { buildBodyReader } from '../src/server/request-utils';

describe("buildBodyReader", () => {
    describe(".text", () => {
        it('returns the raw text for unspecified requests', () => {
            const body = buildBodyReader(Buffer.from('hello world'), {});
            expect(body.text).to.equal('hello world');
        });

        it('returns the raw text for identity requests', () => {
            const body = buildBodyReader(Buffer.from('hello world'), {
                'content-encoding': 'identity'
            });
            expect(body.text).to.equal('hello world');
        });

        it('is undefined for unknown encodings', () => {
            const body = buildBodyReader(Buffer.from('hello world'), {
                'content-encoding': 'randomized'
            });
            expect(body.text).to.equal(undefined);
        });

        it('can decode gzip bodies', () => {
            const content = Buffer.from(zlib.gzipSync('Gzip response'));
            const body = buildBodyReader(content, {
                'content-encoding': 'gzip'
            });
            expect(body.text).to.equal('Gzip response');
        });

        it('can decode zlib deflate bodies', () => {
            const content = Buffer.from(zlib.deflateSync('Deflate response'));
            const body = buildBodyReader(content, {
                'content-encoding': 'deflate'
            });
            expect(body.text).to.equal('Deflate response');
        });

        it('can decode raw deflate bodies', () => {
            const content = Buffer.from(zlib.deflateRawSync('Raw deflate response'));
            const body = buildBodyReader(content, {
                'content-encoding': 'deflate'
            });
            expect(body.text).to.equal('Raw deflate response');
        });

        it('can decode brotli bodies', () => {
            // We use a pre-compressed input, because the compressor won't run in a browser.
            const brotliCompressedMessage = Buffer.from('GxoAABypU587dC0k9ianQOgqjS32iUTcCA==', 'base64');
            const body = buildBodyReader(brotliCompressedMessage, {
                'content-encoding': 'br'
            });
            expect(body.text).to.equal('Brotli brotli brotli brotli');
        });
    });
});
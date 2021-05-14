/**
 * @module Internal
 */

import * as _ from 'lodash';
import * as zlib from 'zlib';

// Use Node's new built-in Brotli compression, if available, or
// use the wasm-brotli package if not.
const brotliDecompress = zlib.brotliDecompressSync
    ?? require('wasm-brotli').decompress;

// Decodes a buffer, using the encodings as specified in a content-encoding header
export const decodeBuffer = (body: Buffer, encoding?: string | string[]): Buffer => {
    if (_.isArray(encoding) || (typeof encoding === 'string' && encoding.indexOf(', ') >= 0)) {
        const encodings = typeof encoding === 'string' ? encoding.split(', ').reverse() : encoding;
        return encodings.reduce((content, nextEncoding) => {
            return decodeBuffer(content, nextEncoding);
        }, body);
    }

    if (encoding === 'gzip' || encoding === 'x-gzip') {
        return zlib.gunzipSync(body);
    } else if (encoding === 'deflate' || encoding === 'x-deflate') {
        // Deflate is ambiguous, and may or may not have a zlib wrapper.
        // This checks the buffer header directly, based on
        // https://stackoverflow.com/a/37528114/68051
        const lowNibble = body[0] & 0xF;
        if (lowNibble === 8) {
            return zlib.inflateSync(body);
        } else {
            return zlib.inflateRawSync(body);
        }
    } else if (encoding === 'br') {
        return Buffer.from(brotliDecompress(body));
    } else if (encoding === 'amz-1.0') {
        // Weird encoding used by some AWS requests, actually just unencoded JSON:
        // https://docs.aws.amazon.com/en_us/AmazonCloudWatch/latest/APIReference/making-api-requests.html
        return body;
    } else if (!encoding || encoding === 'identity') {
        return body;
    } else {
        throw new Error(`Unknown encoding: ${encoding}`);
    }
};
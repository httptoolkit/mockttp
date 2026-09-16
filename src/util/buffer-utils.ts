import { Buffer } from 'buffer';
import * as stream from 'stream';

export const asBuffer = (input: Buffer | Uint8Array | string) =>
    Buffer.isBuffer(input)
        ? input
    : typeof input === "string"
        ? Buffer.from(input, 'utf8')
    // Is Array:
        : Buffer.from(input);

export const bufferToStream = (buffer: Buffer): stream.Readable => {
    const outputStream = new stream.PassThrough();
    outputStream.end(buffer);
    return outputStream;
};

/**
 * Reads a stream to completion, returning all its data as a single buffer. Rejects if the
 * stream errors or is aborted.
 */
export const streamToBuffer = (input: stream.Readable) => new Promise<Buffer>((resolve, reject) => {
    const failWithAbortError = () => reject(new Error('Aborted'));

    // If the stream has already finished/aborted, resolve accordingly immediately:
    if (input.readableEnded) return resolve(Buffer.from([]));
    if (input.readableAborted) return setImmediate(failWithAbortError);

    const chunks: Buffer[] = [];
    input.on('data', (d: Buffer) => chunks.push(d));
    input.once('end', () => resolve(Buffer.concat(chunks)));
    input.once('aborted', failWithAbortError);
    input.on('error', reject);
});

export function splitBuffer(input: Buffer, splitter: string, maxParts = Infinity) {
    const parts: Buffer[] = [];

    let remainingBuffer = input;
    while (remainingBuffer.length) {
        let endOfPart = remainingBuffer.indexOf(splitter);
        if (endOfPart === -1) endOfPart = remainingBuffer.length;

        parts.push(remainingBuffer.subarray(0, endOfPart));
        remainingBuffer = remainingBuffer.subarray(endOfPart + splitter.length);

        if (parts.length === maxParts - 1) {
            parts.push(remainingBuffer);
            break;
        }
    }

    return parts;
}
/**
 * @module Internal
 */

 import * as _ from 'lodash';
 import * as stream from 'stream';

 import { isNode } from './util';

const MAX_BUFFER_SIZE = isNode
    ? require('buffer').constants.MAX_LENGTH
    : Infinity;

export type BufferInProgress = Promise<Buffer> & {
    currentChunks: Buffer[] // Stores the body chunks as they arrive
    failedWith?: Error // Stores the error that killed the stream, if one did
};

// Takes a buffer and a stream, returns a simple stream that outputs the buffer then the stream.
export const bufferThenStream = (buffer: BufferInProgress, inputStream: stream.Readable): stream.Readable => {
    const outputStream = new stream.PassThrough();

    // Forward the buffered data so far
    outputStream.write(Buffer.concat(buffer.currentChunks));
    // After the data, forward errors from the buffer
    if (buffer.failedWith) {
        // Announce async, to ensure listeners have time to get set up
        setTimeout(() => outputStream.emit('error', buffer.failedWith));
    } else {
        // Forward future data as it arrives
        inputStream.pipe(outputStream);
        // Forward any future errors from the input stream
        inputStream.on('error', (e) => outputStream.emit('error', e));
        // Silence 'unhandled rejection' warnings here, since we'll handle them on the stream instead
        buffer.catch(() => {});
    }

    return outputStream;
};

export const bufferToStream = (buffer: Buffer): stream.Readable => {
    const outputStream = new stream.PassThrough();
    outputStream.end(buffer);
    return outputStream;
};

export const streamToBuffer = (input: stream.Readable, maxSize = MAX_BUFFER_SIZE) => {
    let chunks: Buffer[] = [];

    const bufferPromise = <BufferInProgress> new Promise(
        (resolve, reject) => {
            let currentSize = 0;
            input.on('data', (d: Buffer) => {
                currentSize += d.length;

                // If we go over maxSize, drop the whole stream, so the buffer
                // resolves empty. MaxSize should be large, so this is rare,
                // and only happens as an alternative to crashing the process.
                if (currentSize > maxSize) {
                    chunks = []; // Drop all the data so far
                    return; // Don't save any more data
                }

                chunks.push(d);
            });
            input.once('end', () => resolve(Buffer.concat(chunks)));
            input.once('aborted', () => {
                bufferPromise.failedWith = new Error('Aborted');
                reject(bufferPromise.failedWith);
            });
            input.on('error', (e) => {
                bufferPromise.failedWith = bufferPromise.failedWith || e;
                reject(e);
            });
        }
    );
    bufferPromise.currentChunks = chunks;
    return bufferPromise;
};

export function splitBuffer(input: Buffer, splitter: string, maxParts = Infinity) {
    const parts: Buffer[] = [];

    let remainingBuffer = input;
    while (remainingBuffer.length) {
        let endOfPart = remainingBuffer.indexOf(splitter);
        if (endOfPart === -1) endOfPart = remainingBuffer.length;

        parts.push(remainingBuffer.slice(0, endOfPart));
        remainingBuffer = remainingBuffer.slice(endOfPart + splitter.length);

        if (parts.length === maxParts - 1) {
            parts.push(remainingBuffer);
            break;
        }
    }

    return parts;
}
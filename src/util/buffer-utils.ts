import * as _ from 'lodash';
import { EventEmitter } from 'events';
import * as stream from 'stream';

import { isNode } from './util';

const MAX_BUFFER_SIZE = isNode
    ? require('buffer').constants.MAX_LENGTH
    : Infinity;

export const asBuffer = (input: Buffer | Uint8Array | string) =>
    Buffer.isBuffer(input)
        ? input
    : typeof input === "string"
        ? Buffer.from(input, 'utf8')
    // Is Array:
        : Buffer.from(input);

export type BufferInProgress = Promise<Buffer> & {
    currentChunks: Buffer[]; // Stores the body chunks as they arrive
    failedWith?: Error; // Stores the error that killed the stream, if one did
    events: EventEmitter; // Emits events - notably 'truncate' if data is truncated
};

// Takes a buffer and a stream, returns a simple stream that outputs the buffer then the stream. The stream
// is lazy, so doesn't read data in from the buffer or input until something here starts reading.
export const bufferThenStream = (buffer: BufferInProgress, inputStream: stream.Readable): stream.Readable => {
    let active = false;

    const outputStream = new stream.PassThrough({
        // Note we use the default highWaterMark, which means this applies backpressure, pushing buffering
        // onto the OS & backpressure on network instead of accepting data before we're ready to stream it.

        // Without changing behaviour, we listen for read() events, and don't start streaming until we get one.
        read(size) {
            // On the first actual read of this stream, we pull from the buffer
            // and then hook it up to the input.
            if (!active) {
                if (buffer.failedWith) {
                    outputStream.destroy(buffer.failedWith);
                } else {
                    // First stream everything that's been buffered so far:
                    outputStream.write(Buffer.concat(buffer.currentChunks));

                    // Then start streaming all future incoming data:
                    inputStream.pipe(outputStream);

                    if (inputStream.readableEnded) outputStream.end();
                    if (inputStream.readableAborted) outputStream.destroy();

                    // Forward any future errors from the input stream:
                    inputStream.on('error', (e) => {
                        outputStream.emit('error', e)
                    });

                    // Silence 'unhandled rejection' warnings here, since we'll handle
                    // them on the stream instead
                    buffer.catch(() => {});
                }
                active = true;
            }

            // Except for the first activation logic (above) do the default transform read() steps just
            // like a normal PassThrough stream.
            return stream.Transform.prototype._read.call(this, size);
        }
    });

    buffer.events.on('truncate', (chunks) => {
        // If the stream hasn't started yet, start it now, so it grabs the buffer
        // data before it gets truncated:
        if (!active) outputStream.read(0);
    });

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
            function failWithAbortError() {
                bufferPromise.failedWith = new Error('Aborted');
                reject(bufferPromise.failedWith);
            }

            // If stream has already finished/aborted, resolve accordingly immediately:
            if (input.readableEnded) return resolve(Buffer.from([]));
            if (input.readableAborted) return failWithAbortError();

            let currentSize = 0;
            const onData = (d: Buffer) => {
                currentSize += d.length;
                chunks.push(d);

                // If we go over maxSize, drop the whole stream, so the buffer
                // resolves empty. MaxSize should be large, so this is rare,
                // and only happens as an alternative to crashing the process.
                if (currentSize > maxSize) {
                    // Announce truncation, so that other mechanisms (asStream) can
                    // capture this data if they're interested in it.
                    bufferPromise.events.emit('truncate', chunks);

                    // Drop all the data so far & stop reading
                    bufferPromise.currentChunks = chunks = [];
                    input.removeListener('data', onData);

                    // We then resolve immediately - the buffer is done, even if the body
                    // might still be streaming in we're not listening to it. This means
                    // that requests can 'complete' for event/callback purposes while
                    // they're actually still streaming, but only in this scenario where
                    // the data is too large to really be used by the events/callbacks.

                    // If we don't resolve, then cases which intentionally don't consume
                    // the raw stream but do consume the buffer (beforeRequest) would
                    // deadlock: beforeRequest must complete to begin streaming the
                    // full body to the target clients.

                    resolve(Buffer.from([]));
                }
            };
            input.on('data', onData);

            input.once('end', () => {
                resolve(Buffer.concat(chunks));
            });
            input.once('aborted', failWithAbortError);
            input.on('error', (e) => {
                bufferPromise.failedWith = bufferPromise.failedWith || e;
                reject(e);
            });
        }
    );
    bufferPromise.currentChunks = chunks;
    bufferPromise.events = new EventEmitter();
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
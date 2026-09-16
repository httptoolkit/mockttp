import { Buffer } from 'buffer';
import * as stream from 'stream';

import { getDeferred } from '@httptoolkit/util';

import { bufferToStream } from './buffer-utils';

/**
 * Captures the data passing through a stream, so that it can be read as a complete buffer, and/or
 * streamed out again later from the very beginning, regardless of how much has already arrived.
 *
 * Data is retained until it goes past maxSize. We can't buffer everything beyond that point, so the
 * capture stops there: the buffer completes empty, whatever was retained goes to any stream that's
 * already reading, and from then on only a live stream can see the data.
 */
export class StreamCapture {

    constructor(
        private input: stream.Readable,
        private maxSize: number
    ) {
        // Listening to these is optional, so we treat errors as default-handled:
        this.buffer.catch(() => {});
        this.completed.catch(() => {});

        // If the input has already finished, there's nothing left to capture:
        if (input.readableEnded) {
            this.completedBuffer = Buffer.from([]);
            this.captured.resolve(this.completedBuffer);
            this.endOfInput.resolve();
            return;
        }
        if (input.readableAborted) {
            setImmediate(() => this.fail(new Error('Aborted')));
            return;
        }

        input.on('data', this.onData);
        input.once('end', this.onEnd);
        input.once('aborted', () => this.fail(new Error('Aborted')));
        input.on('error', (error) => this.fail(error));
    }

    private captured = getDeferred<Buffer>();
    private endOfInput = getDeferred<void>();

    /**
     * The complete captured data, once the input ends. This resolves empty if the data went past
     * maxSize, and rejects if the input errors or is aborted.
     */
    readonly buffer = this.captured.promise;

    /**
     * Resolves when the input itself ends, whether or not we kept any of its data. Rejects if the
     * input fails before that. Unlike `buffer`, this always means the body really has finished.
     */
    readonly completed = this.endOfInput.promise;

    // What's happening to the data captured so far:
    // - retaining: we're keeping it, and still reading more.
    // - dropped: too much arrived, and we've let it go. Only a live stream can see it now.
    private retention: 'retaining' | 'dropped' = 'retaining';

    private chunks: Buffer[] = [];
    private capturedSize = 0;
    private completedBuffer: Buffer | undefined;
    private failure: Error | undefined;

    private onData = (data: Buffer) => {
        if (this.retention !== 'retaining') return;

        this.capturedSize += data.length;
        this.chunks.push(data);
        if (this.capturedSize > this.maxSize) this.handleOverflow();
    };

    private onEnd = () => {
        if (this.retention === 'retaining') {
            this.completedBuffer = Buffer.concat(this.chunks);
            this.captured.resolve(this.completedBuffer);
        }
        this.endOfInput.resolve();
    };

    private fail(error: Error) {
        this.failure ??= error;
        this.captured.reject(error);
        this.endOfInput.reject(error);
    }

    private handleOverflow() {
        // If we hit the data limit, we start streaming to anybody who's already attached, and
        // drop all buffering (resolve to empty, drop held data, drop future data as it comes).
        this.captured.resolve(Buffer.from([]));

        this.activatePendingOutputs();

        this.retention = 'dropped';
        this.chunks = [];
        this.input.removeListener('data', this.onData);
    }

    // When you take a stream, it stays here until it actually starts reading, and only then starts
    // piping. This helps us preserve backpressure in the OS/network until data actually starts
    // moving, which helps avoid buffering data unnecessarily on our side.
    private pendingOutputs = new Set<() => void>();

    /**
     * Returns a stream of the complete data, from the beginning: the data captured so far, and
     * then the rest of the input as it arrives.
     *
     * This throws if the data has already been dropped, since the full stream can't be provided.
     */
    takeStream(): stream.Readable {
        if (this.completedBuffer) return bufferToStream(this.completedBuffer);

        if (this.retention === 'dropped') {
            throw new Error('Stream data exceeded the maximum size and was dropped, so it cannot be streamed');
        }

        let activated = false;
        const activate = () => {
            if (activated) return;
            activated = true;
            this.pendingOutputs.delete(activate);

            if (this.failure) {
                output.destroy(this.failure);
                return;
            }

            // Replay buffered chunks, then stream:
            this.chunks.forEach((chunk) => output.write(chunk));
            this.input.pipe(output);

            if (this.input.readableEnded) output.end();
            if (this.input.readableAborted) output.destroy(new Error('Aborted'));
            this.input.on('error', (e) => output.destroy(e));
        };

        const output = new stream.PassThrough({
            read(size) {
                activate();
                return stream.Transform.prototype._read.call(this, size);
            }
        });

        this.pendingOutputs.add(activate);

        return output;
    }

    /**
     * Actively push data into all streams and start them, to ensure any open but not
     * yet active streams have a chance to start processing data before we drop it if
     * we hit the buffering limit.
     */
    private activatePendingOutputs() {
        const pending = [...this.pendingOutputs];
        this.pendingOutputs.clear();
        pending.forEach((activate) => activate());
    }
}

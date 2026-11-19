import { Buffer, kMaxLength } from 'buffer';
import * as stream from 'stream';

import { getDeferred } from '@httptoolkit/util';

const DISCARDED = Symbol('discarded');

/**
 * Captures the data of a stream, so that it can be safely accessed later by:
 *
 * - a single consumer, via takeStream() - owning the data from then on
 * - any number of observers, via observeStream() - seeing the data without consuming it
 * - a buffered reader, as complete content via readContent(), if no larger than maxContentSize
 * - an end listener, waiting for waitForEnd() - starting the read, with minimal interference.
 *
 * The input is only read when somebody needs its data, and only as fast as every output stream
 * can take it, so that slow readers backpressure the source rather than buffering data in memory.
 * Notably, data isn't read until a consumer arrives, or until dump() says nobody's coming.
 *
 * The stream is settled once the consumer takes it, or once dump() says it never will. Observers
 * and content must be requested before then: afterwards, those requests always fail, regardless
 * of how much data has arrived, so that they can't succeed or fail depending on timing.
 *
 * Data is all or nothing: content over maxContentSize resolves empty instead (see isTruncated),
 * and nothing ever receives the data from part way through.
 */
export class StreamCapture {

    // The data from the start of the input, while somebody still needs all of it: the expected
    // consumer, or the content. Set to 'discarded' once it's dropped.
    private contentBuffer: Buffer[] | typeof DISCARDED = [];
    private heldSize = 0;

    // The consumer is expected until it takes the stream, or until dump() says it never will.
    private consumer: 'expected' | 'taken' | 'not-coming' = 'expected';

    // Set by waitForEnd(): the input is read to its end without holding data for the expected
    // consumer, which can then only take the stream if all the data was kept as content.
    private readingToEnd = false;

    private readonly maxContentSize: number;
    private contentRequested = false;
    private truncated = false;
    private readonly contentPromise = getDeferred<Buffer>();

    // Every stream receiving live data, and those of them that are blocked (applying backpressure,
    // which pauses the input until they drain):
    private readonly outputs = new Set<stream.Writable>();
    private readonly blockedOutputs = new Set<stream.Writable>();

    private ended = false;
    private failure: Error | undefined;
    private readonly inputEnd = getDeferred<void>();

    constructor(
        private readonly input: stream.Readable,
        maxContentSize: number
    ) {
        // Content is collected into a single buffer, so it can't be larger than a buffer can be:
        this.maxContentSize = Math.min(maxContentSize, kMaxLength);

        // Reading the content or waiting for the end are optional, so failures are always
        // considered handled, rather than becoming unhandled rejections when nobody asks:
        this.contentPromise.promise.catch(() => {});
        this.inputEnd.promise.catch(() => {});

        if (input.readableEnded) {
            this.ended = true;
            this.inputEnd.resolve();
            return;
        }
        if (input.readableAborted) {
            setImmediate(() => this.fail(new Error('Aborted')));
            return;
        }

        // Adding a data listener starts the data flowing, unless the input has been paused, so
        // we pause first if nothing needs the data yet:
        this.updateFlow();
        input.on('data', this.onData);
        input.once('end', this.onEnd);
        input.once('aborted', () => this.fail(new Error('Aborted')));
        input.on('error', (error) => this.fail(error));
    }

    /**
     * Collects the data as content, to be read later with readContent(). This must be called
     * before the stream is settled.
     */
    keepContent() {
        if (this.contentRequested) return;
        this.requireUnsettled('read as content');

        this.contentRequested = true;
        if (this.ended && this.wantsContent) this.completeContent();

        this.updateFlow();
    }

    /**
     * The complete content, once the input ends, or an empty buffer if it's truncated.
     */
    async readContent(): Promise<Buffer> {
        this.keepContent();
        return this.contentPromise.promise;
    }

    /**
     * Whether the data went past maxContentSize, so the content resolves empty.
     */
    get isTruncated() {
        return this.truncated;
    }

    /**
     * Returns a stream of the data, from the start, without consuming it. This must be called
     * before the stream is settled.
     */
    observeStream(): stream.Readable {
        this.requireUnsettled('observed');
        return this.createOutput();
    }

    /**
     * Returns the one consumer stream of the data, from the start, settling the stream. The input
     * is read from then on as fast as this stream (and any observers) can take it, and data isn't
     * held for anybody else unless the content was requested beforehand.
     *
     * After waitForEnd(), this is only possible once the input has ended within maxContentSize.
     */
    takeStream(): stream.Readable {
        const canTake = this.consumer === 'expected' &&
            (!this.readingToEnd || (this.ended && !this.truncated));
        if (!canTake) throw this.unavailableError('streamed');

        this.consumer = 'taken';
        const output = this.createOutput();
        this.discardUnneededData();
        this.updateFlow();
        return output;
    }

    /**
     * Declares that no consumer will take the stream, settling it, so the input is read without
     * waiting for one. Content that was requested is still collected.
     */
    dump() {
        if (this.consumer !== 'expected') return;

        this.consumer = 'not-coming';
        this.discardUnneededData();
        this.updateFlow();
    }

    /**
     * Resolves once the input has ended. If the stream isn't settled yet, this reads it all now,
     * keeping it as content: the expected consumer can still take the stream afterwards, but only
     * if all of the data fit within maxContentSize.
     */
    waitForEnd(): Promise<void> {
        if (this.consumer === 'expected' && !this.readingToEnd) {
            this.keepContent();
            this.readingToEnd = true;
            this.discardUnneededData();
            this.updateFlow();
        }

        return this.inputEnd.promise;
    }

    private onData = (chunk: Buffer) => {
        if (this.contentBuffer !== DISCARDED) {
            this.contentBuffer.push(chunk);
            this.heldSize += chunk.length;

            if (!this.truncated && this.heldSize > this.maxContentSize) this.truncate();
            this.discardUnneededData();
        }

        this.outputs.forEach((output) => this.writeTo(output, chunk));
        this.updateFlow();
    };

    private onEnd = () => {
        // Node's HTTP server dumps the body of a request that nothing has read once its response
        // completes, removing our listener first, so then we haven't seen all the data:
        if (!this.input.listeners('data').includes(this.onData)) {
            this.fail(new Error('Stream data was read elsewhere, so it was not all captured'));
            return;
        }

        this.ended = true;
        if (this.wantsContent) this.completeContent();

        this.outputs.forEach((output) => output.end());
        this.outputs.clear();
        this.blockedOutputs.clear();

        this.inputEnd.resolve();
    };

    private fail(error: Error) {
        if (this.failure) return;
        this.failure = error;

        this.contentPromise.reject(error);
        this.inputEnd.reject(error);

        this.outputs.forEach((output) => failOutput(output, error));
        this.outputs.clear();
        this.blockedOutputs.clear();
    }

    private get wantsContent() {
        return this.contentRequested && !this.truncated;
    }

    private get holdingForConsumer() {
        return this.consumer === 'expected' && !this.readingToEnd;
    }

    private completeContent() {
        if (this.contentBuffer === DISCARDED) throw new Error('Stream content was unexpectedly discarded');

        const content = Buffer.concat(this.contentBuffer);
        this.contentBuffer = [content];
        this.contentPromise.resolve(content);
    }

    private truncate() {
        this.truncated = true;
        this.contentPromise.resolve(Buffer.alloc(0));
        this.discardUnneededData();
    }

    private discardUnneededData() {
        if (this.holdingForConsumer || this.wantsContent) return;

        this.contentBuffer = DISCARDED;
        this.heldSize = 0;
    }

    // The input is paused while any output is blocked, or while data would need to be held for
    // a consumer that hasn't arrived yet. Pausing is only a request though: data that arrives
    // while paused is still handled as normal.
    private updateFlow() {
        if (this.ended || this.failure) return;

        const shouldPause = this.blockedOutputs.size > 0 ||
            (this.holdingForConsumer && !this.wantsContent);

        if (shouldPause) this.input.pause();
        else this.input.resume();
    }

    private createOutput(): stream.PassThrough {
        // The settling rules should make this impossible, but just in case:
        if (this.contentBuffer === DISCARDED) throw new Error('Stream data was unexpectedly discarded');

        const output = new stream.PassThrough();

        if (this.failure) {
            failOutput(output, this.failure);
            return output;
        }

        this.contentBuffer.forEach((chunk) => this.writeTo(output, chunk));

        if (this.ended) {
            output.end();
        } else {
            this.outputs.add(output);
            output.once('close', () => {
                this.outputs.delete(output);
                this.blockedOutputs.delete(output);
                this.updateFlow();
            });
        }

        return output;
    }

    private writeTo(output: stream.Writable, chunk: Buffer) {
        if (output.write(chunk) || this.blockedOutputs.has(output)) return;

        this.blockedOutputs.add(output);
        output.once('drain', () => {
            this.blockedOutputs.delete(output);
            this.updateFlow();
        });
    }

    private requireUnsettled(purpose: string) {
        if (this.consumer !== 'expected' || this.readingToEnd) throw this.unavailableError(purpose);
    }

    private unavailableError(purpose: string) {
        const reason = this.consumer === 'taken'
            ? 'has already been taken by its consumer'
            : this.consumer === 'not-coming'
                ? 'was dumped'
                : this.truncated
                    ? 'exceeded the maximum size'
                    : 'was already being read to its end';

        return new Error(`Stream ${reason}, so it can't now be ${purpose}`);
    }
}

// Destroying a stream with an error emits it, which crashes the process if nothing is listening.
// Outputs may legitimately have no listeners for a while (e.g. a consumer that takes the stream
// and then connects to its destination asynchronously), so we fail them once somebody listens.
function failOutput(output: stream.Writable, error: Error) {
    if (output.listenerCount('error') > 0) {
        output.destroy(error);
        return;
    }

    const onNewListener = (event: string | symbol) => {
        if (event !== 'error') return;
        output.off('newListener', onNewListener);
        // This fires just before the listener is added, so we wait for that first:
        queueMicrotask(() => output.destroy(error));
    };
    output.on('newListener', onNewListener);
}

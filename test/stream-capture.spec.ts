import { Buffer } from 'buffer';
import * as stream from 'stream';

import { expect, nodeOnly, delay } from './test-utils';
import { StreamCapture } from '../src/util/stream-capture';

nodeOnly(() => {
    describe("StreamCapture", () => {

        // Reports how a stream finished, so a clean end and a failure can't be confused.
        const readToEnd = (input: stream.Readable) => new Promise<
            { ended: string } | { error: string }
        >((resolve) => {
            const chunks: Buffer[] = [];
            input.on('data', (d) => chunks.push(d));
            input.on('end', () => resolve({ ended: Buffer.concat(chunks).toString() }));
            input.on('error', (e: Error) => resolve({ error: e.message }));
        });

        describe("capturing a body", () => {

            it("buffers the whole input", async () => {
                const input = new stream.PassThrough();
                const capture = new StreamCapture(input, 1024);

                input.write('hello ');
                input.end('world');

                expect((await capture.buffer).toString()).to.equal('hello world');
                await capture.completed;
            });

            it("buffers an empty input", async () => {
                const input = new stream.PassThrough();
                const capture = new StreamCapture(input, 1024);
                input.end();

                expect((await capture.buffer).length).to.equal(0);
                await capture.completed;
            });

            it("consumes the input as it arrives", async () => {
                // This behaviour guarantees that the input can't be stolen away somewhere else, and
                // avoids any accidental reads of the input elsewhere (generally won't work)

                const input = new stream.PassThrough();
                new StreamCapture(input, 1024);

                input.write('hello');
                await delay(0);

                expect(input.readableLength).to.equal(0); // Input has been consumed
            });
        });

        describe("streaming a body", () => {

            it("replays what's arrived so far, then continues live", async () => {
                const input = new stream.PassThrough();
                const capture = new StreamCapture(input, 1024);

                input.write('first ');
                await delay(0);

                const taken = capture.takeStream();
                const result = readToEnd(taken);

                input.end('second');

                expect(await result).to.deep.equal({ ended: 'first second' });
            });

            it("streams the whole body to a stream taken before any data arrives", async () => {
                const input = new stream.PassThrough();
                const capture = new StreamCapture(input, 1024);

                const result = readToEnd(capture.takeStream());

                input.write('first ');
                input.end('second');

                expect(await result).to.deep.equal({ ended: 'first second' });
            });

            it("gives every stream the whole body, however many are taken", async () => {
                const input = new stream.PassThrough();
                const capture = new StreamCapture(input, 1024);

                const first = readToEnd(capture.takeStream());

                input.write('first ');
                await delay(0);

                const second = readToEnd(capture.takeStream());

                input.end('second');

                expect(await first).to.deep.equal({ ended: 'first second' });
                expect(await second).to.deep.equal({ ended: 'first second' });
            });

            it("replays a completed body to streams taken afterwards", async () => {
                const input = new stream.PassThrough();
                const capture = new StreamCapture(input, 1024);

                input.end('all done');
                await capture.buffer;

                expect(await readToEnd(capture.takeStream())).to.deep.equal({ ended: 'all done' });
                expect(await readToEnd(capture.takeStream())).to.deep.equal({ ended: 'all done' });
            });

            it("doesn't start reading the input until the stream is read", async () => {
                const input = new stream.PassThrough();
                const capture = new StreamCapture(input, 1024);

                const taken = capture.takeStream();
                input.write('data');
                await delay(0);

                // Nothing has read the stream, so it hasn't pulled anything through yet. This is
                // what keeps backpressure on the network, instead of buffering ahead of the reader:
                expect((taken as stream.PassThrough).readableLength).to.equal(0);

                // ...but it's all still there once it is read:
                const result = readToEnd(taken);
                input.end('!');
                expect(await result).to.deep.equal({ ended: 'data!' });
            });
        });

        describe("when the body goes past the maximum size", () => {

            it("completes the buffer empty, without waiting for the end", async () => {
                const input = new stream.PassThrough();
                const capture = new StreamCapture(input, 4);

                input.write('much longer than the maximum');

                expect((await capture.buffer).length).to.equal(0);
            });

            it("still reports the end of the input separately", async () => {
                const input = new stream.PassThrough();
                const capture = new StreamCapture(input, 4);

                input.write('much longer than the maximum');
                await delay(0);
                expect((await capture.buffer).length).to.equal(0);

                let completed = false;
                capture.completed.then(() => { completed = true; });
                await delay(0);
                expect(completed).to.equal(false); // Not finished arriving yet

                input.end('and the rest');
                await delay(0);
                expect(completed).to.equal(true);
            });

            it("still gives the whole body to a stream taken before the overflow", async () => {
                const input = new stream.PassThrough();
                const capture = new StreamCapture(input, 4);

                const result = readToEnd(capture.takeStream());
                await delay(0);

                input.write('much longer than the maximum');
                input.end(' - and the rest');

                expect(await result).to.deep.equal({
                    ended: 'much longer than the maximum - and the rest'
                });
            });

            it("refuses to stream a body whose data has already been dropped", async () => {
                const input = new stream.PassThrough();
                const capture = new StreamCapture(input, 4);

                input.write('much longer than the maximum');
                await delay(0);

                // The data is gone, so we can't honestly provide the body - better to say so than
                // to hand back a stream that silently starts from the middle:
                expect(() => capture.takeStream()).to.throw(/exceeded the maximum size/);
            });
        });

        describe("when the input fails", () => {

            it("fails a stream that was taken but not yet read", async () => {
                const input = new stream.PassThrough();
                const capture = new StreamCapture(input, 1024);

                input.write('partial body');
                await delay(0);

                // Taken, but nothing has read from it yet, so it hasn't started streaming:
                const taken = capture.takeStream();
                input.destroy(new Error('input failed'));
                await delay(0);

                // It must not look like a clean body that happens to be short:
                expect(await readToEnd(taken)).to.deep.equal({ error: 'input failed' });
            });

            it("fails a stream that's already being read", async () => {
                const input = new stream.PassThrough();
                const capture = new StreamCapture(input, 1024);

                input.write('partial body');
                await delay(0);

                const taken = capture.takeStream();
                const result = readToEnd(taken);
                await delay(0);

                input.destroy(new Error('input failed later'));

                expect(await result).to.deep.equal({ error: 'input failed later' });
            });

            it("destroys the stream it fails, rather than leaving it open", async () => {
                const input = new stream.PassThrough();
                const capture = new StreamCapture(input, 1024);

                const taken = capture.takeStream();
                const result = readToEnd(taken);
                await delay(0);

                input.destroy(new Error('input failed'));
                await result;
                await delay(0);

                expect(taken.destroyed).to.equal(true);
            });

            it("rejects both the buffer and the completion", async () => {
                const input = new stream.PassThrough();
                const capture = new StreamCapture(input, 1024);

                input.destroy(new Error('input failed'));

                await expect(capture.buffer).to.be.rejectedWith('input failed');
                await expect(capture.completed).to.be.rejectedWith('input failed');
            });

            it("doesn't report a failure nobody asked about as unhandled", async () => {
                const input = new stream.PassThrough();
                new StreamCapture(input, 1024);

                // Nothing here reads the buffer or the completion. If the capture didn't handle
                // its own results, this rejection would be unhandled & would fail this test.
                input.destroy(new Error('input failed'));
                await delay(10);
            });
        });
    });
});

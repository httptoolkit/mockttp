import { Buffer } from 'buffer';
import * as http from 'http';
import * as stream from 'stream';

import { trackResponse } from '../src/util/request-utils';
import { expect, nodeOnly, getDeferred } from './test-utils';

nodeOnly(() => {
    describe("Response body buffering", () => {
        let trackingStreams: stream.PassThrough[];
        let responses: stream.Writable[];

        beforeEach(() => {
            trackingStreams = [];
            responses = [];
        });
        afterEach(() => {
            responses.forEach(response => response.destroy());
            trackingStreams.forEach(tracking => tracking.destroy());
        });

        function createResponse(
            captureBody: boolean,
            maxSize = 1024,
            onBodyData?: Parameters<typeof trackResponse>[3]['onBodyData']
        ) {
            let writtenBytes = 0;
            const sink = Object.assign(new stream.Writable({
                write(chunk, _encoding, callback) {
                    writtenBytes += chunk.length;
                    callback();
                }
            }), {
                getHeaders: () => ({}),
                writeHead() {},
                addTrailers() {}
            });
            responses.push(sink);

            // Capture the side stream only while constructing the response tracker.
            // Queue lengths give a deterministic bound without relying on GC or RSS.
            const descriptor = Object.getOwnPropertyDescriptor(stream, 'PassThrough')!;
            const OriginalPassThrough = stream.PassThrough;
            Object.defineProperty(stream, 'PassThrough', {
                ...descriptor,
                value: class extends OriginalPassThrough {
                    constructor() {
                        super();
                        trackingStreams.push(this);
                    }
                }
            });
            const options = {
                captureBody,
                maxSize,
                onBodyData,
                onWriteHead() {},
                onInformationalResponse() {}
            };
            try {
                const response = trackResponse(
                    sink as unknown as http.ServerResponse,
                    { startTime: Date.now(), startTimestamp: performance.now() },
                    [],
                    options
                );
                return { response, tracking: trackingStreams[trackingStreams.length - 1], bytes: () => writtenBytes };
            } finally {
                Object.defineProperty(stream, 'PassThrough', descriptor);
            }
        }

        it("does not queue unobserved streaming responses beyond maxBodySize", async () => {
            const { response, tracking, bytes } = createResponse(false);
            for (let i = 0; i < 64; i++) response.write(Buffer.alloc(32 * 1024));
            await new Promise<void>(resolve => setImmediate(resolve));

            expect(bytes()).to.equal(2 * 1024 * 1024);
            expect(tracking.readableLength).to.equal(0);
            expect(tracking.writableLength).to.equal(0);
        });

        it("preserves complete bodies when capture is requested", async () => {
            const { response } = createResponse(true);
            const body = response.body.asBuffer();
            response.write('first ');
            response.end('second');
            expect((await body).toString()).to.equal('first second');
        });

        it("still drops oversized captured bodies without queuing later chunks", async () => {
            const { response, tracking } = createResponse(true, 4);
            const body = response.body.asBuffer();
            response.write('too large');
            for (let i = 0; i < 64; i++) response.write(Buffer.alloc(32 * 1024));
            response.end();
            expect((await body).length).to.equal(0);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(tracking.readableLength).to.equal(0);
            expect(tracking.writableLength).to.equal(0);
        });

        it("emits body data without retaining a complete response", async () => {
            const finished = getDeferred<void>();
            const chunks: Buffer[] = [];
            const { response, tracking } = createResponse(false, 4, (_id, _time, content, ended) => {
                chunks.push(Buffer.from(content));
                if (ended) finished.resolve();
            });
            response.write('first ');
            response.end('second');
            await finished;
            expect(Buffer.concat(chunks).toString()).to.equal('first second');
            expect(tracking.readableLength).to.equal(0);
            expect(tracking.writableLength).to.equal(0);
        });
    });
});

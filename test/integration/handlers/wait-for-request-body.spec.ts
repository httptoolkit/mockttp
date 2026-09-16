import { Buffer } from 'buffer';
import * as http from 'http';

import { getLocal, Mockttp } from "../../..";
import { expect, nodeOnly, getDeferred, Deferred } from "../../test-utils";

nodeOnly(() => {
    describe("The waitForRequestBody step", () => {

        // Two halves, both over the small maxBodySize used below:
        const FIRST_HALF = Buffer.alloc(2048, 'a');
        const SECOND_HALF = Buffer.alloc(2048, 'b');
        const BODY_SIZE = FIRST_HALF.length + SECOND_HALF.length;

        let server: Mockttp;
        let firstHalfReceived: Deferred<void>;

        beforeEach(() => {
            firstHalfReceived = getDeferred<void>();
        });

        afterEach(() => server.stop());

        const startServer = async (options: { maxBodySize?: number } = {}) => {
            server = getLocal(options);
            await server.start();

            await server.on('request-body-data', (data) => {
                if (data.content.length > 0) firstHalfReceived.resolve();
            });

            await server.forPost('/probe').thenReply(200);
        };

        // Start an upload, but don't finish until finish() is called.
        const startUpload = () => {
            const responded = getDeferred<void>();
            let hasResponded = false;

            const request = http.request({
                host: 'localhost',
                port: server.port,
                method: 'POST',
                path: '/upload',
                headers: { 'content-length': BODY_SIZE }
            }, (response) => {
                response.resume();
                response.on('end', () => {
                    hasResponded = true;
                    responded.resolve();
                });
            });
            request.on('error', (e) => responded.reject(e));
            request.setTimeout(5000, () => request.destroy(new Error('Timed out')));

            request.write(FIRST_HALF);

            return {
                hasResponded: () => hasResponded,
                finish: () => request.end(SECOND_HALF),
                responded
            };
        };

        // A complete round trip, as a race against the response delivery to confirm that the
        // server is not responding (correctly waiting for the request body)
        const serverRoundTrip = async () => {
            const response = await fetch(server.urlFor('/probe'), { method: 'POST' });
            expect(response.status).to.equal(200);
        };

        it("waits for the whole body before continuing", async () => {
            await startServer();
            await server.forAnyRequest().waitForRequestBody().thenReply(200);

            const upload = startUpload();

            await firstHalfReceived;
            await serverRoundTrip();
            expect(upload.hasResponded()).to.equal(false); // Still waiting for the rest

            upload.finish();
            await upload.responded;
        });

        it("waits for the whole body even when the content is dropped for exceeding maxBodySize", async () => {
            await startServer({ maxBodySize: 1024 });
            const endpoint = await server.forAnyRequest().waitForRequestBody().thenReply(200);

            const upload = startUpload();

            await firstHalfReceived;
            await serverRoundTrip();
            expect(upload.hasResponded()).to.equal(false);

            upload.finish();
            await upload.responded;

            // The content itself is dropped, as it's too large to keep:
            const seenRequests = await endpoint.getSeenRequests();
            expect(seenRequests).to.have.length(1);
            expect(await seenRequests[0].body.getText()).to.equal('');
        });
    });
});

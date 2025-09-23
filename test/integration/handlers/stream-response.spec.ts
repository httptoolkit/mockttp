import { Buffer } from 'buffer';
import { PassThrough, Readable } from 'stream';
import { delay, getDeferred, ErrorLike } from '@httptoolkit/util';

import { getLocal } from "../../..";
import { expect, fetch, isNode, nodeOnly } from "../../test-utils";

describe("Streaming response handler", function () {

    let server = getLocal({
        cors: isNode
            ? false
            : { exposedHeaders: '*' }
    });

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should allow streaming a response", async () => {
        let stream = new PassThrough();
        await server.forGet('/stream').thenStream(200, stream);

        stream.write('Hello\n');

        let responsePromise = fetch(server.urlFor('/stream'));

        await delay(100);
        stream.write(Buffer.from('world'));

        let arrayBuffer = new Uint8Array(1);
        arrayBuffer[0] = '!'.charCodeAt(0);
        stream.end(arrayBuffer);

        await expect(responsePromise).to.have.status(200);
        await expect(responsePromise).to.have.responseText('Hello\nworld!');
    });

    it("should not allow setting pseudoheaders when streaming a response", async () => {
        let stream = new PassThrough();
        expect(() =>
            server.forGet('/stream').thenStream(200, stream, {
                ':status': '200'
            })
        ).to.throw("Cannot set custom :status pseudoheader values");
    });

    it("should fail clearly when trying to repeat a single stream response", async () => {
        let stream = new PassThrough();
        await server.forGet('/stream').thenStream(200, stream);

        stream.end('Hello world');

        await fetch(server.urlFor('/stream'));
        let responsePromise = await fetch(server.urlFor('/stream'));

        await expect(responsePromise).to.have.status(500);
        expect(await responsePromise.text()).to.include('Stream request step called more than once');
    });

    it("should allow multiple streaming responses", async () => {
        let stream1 = new PassThrough();
        await server.forGet('/stream').thenStream(200, stream1);
        let stream2 = new PassThrough();
        await server.forGet('/stream').thenStream(200, stream2);

        stream1.end('Hello');
        stream2.end('World');

        let response1 = await fetch(server.urlFor('/stream'));
        let response2 = await fetch(server.urlFor('/stream'));

        await expect(response1).to.have.status(200);
        await expect(response1).to.have.responseText('Hello');
        await expect(response2).to.have.status(200);
        await expect(response2).to.have.responseText('World');
    });

    nodeOnly(() => {
        it("should abort the response if the stream throws an error", async () => {
            const serverResponseStream = new PassThrough();
            await server.forGet('/stream').thenStream(200, serverResponseStream);

            serverResponseStream.write('Hello\n');

            const response = await fetch(server.urlFor('/stream'));

            expect(response.status).to.equal(200);

            const clientResponseStream = response.body as any as Readable;
            expect(clientResponseStream.read().toString()).to.equal('Hello\n');

            const errorPromise = getDeferred<Error>();
            clientResponseStream.on('error', (err) => errorPromise.resolve(err));

            serverResponseStream.destroy(new Error("Stream error"));
            const error: ErrorLike = await errorPromise;
            expect(error.code).to.equal('ERR_STREAM_PREMATURE_CLOSE');
        });
    });

});
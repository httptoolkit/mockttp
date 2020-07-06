import * as http2 from 'http2';

import { getLocal } from "../..";
import { expect } from "../test-utils";

type Http2ResponseHeaders = http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader;

function getResponse(req: http2.ClientHttp2Stream) {
    return new Promise<Http2ResponseHeaders>((resolve, reject) => {
        req.on('response', resolve);
        req.on('error', reject);
    });
}

function getBody(req: http2.ClientHttp2Stream) {
    return new Promise<Buffer>((resolve, reject) => {
        const body: Buffer[] = [];
        req.on('data', (d: Buffer | string) => {
            body.push(Buffer.from(d));
        });
        req.on('end', () => resolve(Buffer.concat(body)));
        req.on('error', reject);
    });
}

describe.skip("Using Mockttp with HTTP/2", () => {

    const server = getLocal({ debug: true });

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    describe("without TLS", () => {

        it("can respond to direct HTTP/2 requests", async () => {
            server.get('/').thenReply(200, "HTTP2 response!");

            const client = http2.connect(server.url);

            const req = client.request();

            const responseHeaders = await getResponse(req);
            expect(responseHeaders[':status']).to.equal(200);

            const responseBody = await getBody(req);
            expect(responseBody.toString('utf8')).to.equal("HTTP2 response!");
            client.close();
        });

    });
});
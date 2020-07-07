import * as http2 from 'http2';

import { getLocal } from "../..";
import { expect, nodeOnly } from "../test-utils";

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

nodeOnly(() => {
    describe("Using Mockttp with HTTP/2", function () {

        describe("without TLS", () => {

            const server = getLocal();

            beforeEach(() => server.start());
            afterEach(() => server.stop());

            it("can respond to direct HTTP/2 requests", async () => {
                server.get('/').thenReply(200, "HTTP2 response!");

                const client = http2.connect(server.url);

                const req = client.request();

                const responseHeaders = await getResponse(req);
                expect(responseHeaders[':status']).to.equal(200);

                expect(client.alpnProtocol).to.equal('h2c'); // Plaintext HTTP/2

                const responseBody = await getBody(req);
                expect(responseBody.toString('utf8')).to.equal("HTTP2 response!");
                client.close();
            });

        });

        describe("with TLS", () => {

            const server = getLocal({
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem'
                }
            });

            beforeEach(() => server.start());
            afterEach(() => server.stop());

            it.skip("can respond to direct HTTP/2 requests", async () => {
                server.get('/').thenReply(200, "HTTP2 response!");

                const client = http2.connect(server.url);

                const req = client.request();

                const responseHeaders = await getResponse(req);
                expect(responseHeaders[':status']).to.equal(200);

                expect(client.alpnProtocol).to.equal('h2'); // HTTP/2 over TLS

                const responseBody = await getBody(req);
                expect(responseBody.toString('utf8')).to.equal("HTTP2 response!");
                client.close();
            });

        });

    });
});
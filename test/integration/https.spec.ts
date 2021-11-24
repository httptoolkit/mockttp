import { getLocal } from "../..";
import { expect, fetch } from "../test-utils";

describe("An HTTPS server", () => {
    describe("passed key & cert paths", () => {
        let server = getLocal({
            https: {
                keyPath: './test/fixtures/test-ca.key',
                certPath: './test/fixtures/test-ca.pem'
            }
        });

        beforeEach(() => server.start());
        afterEach(() => server.stop());

        it("returns a HTTPS serverUrl", () => {
            expect(server.url.split('://')[0]).to.equal('https');
        });

        it("can handle HTTPS requests", async () => {
            await server.forGet('/').thenReply(200, "Super secure response");
            return expect(fetch(server.url)).to.have.responseText("Super secure response");
        });

        it("can handle HTTP requests", async () => {
            await server.forGet('/').thenReply(200, "Super secure response");
            return expect(fetch(server.url.replace('https', 'http'))).to.have.responseText("Super secure response");
        });

        it("matches HTTPS requests against protocol-less URL matchers", async () => {
            await server.forGet(`localhost:${server.port}/file.txt`).thenReply(200, 'Fake file');

            let result = await fetch(server.urlFor('/file.txt'));

            await expect(result).to.have.responseText('Fake file');
        });
    });
});
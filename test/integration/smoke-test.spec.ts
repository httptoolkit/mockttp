import HttpProxyAgent = require('http-proxy-agent');
import { getLocal } from "../..";
import { expect, fetch, nodeOnly } from "../test-utils";

describe("Basic HTTP mocking", function () {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should mock simple matching GETs", async () => {
        await server.forGet("/mocked-endpoint").thenReply(200, "mocked data");

        await expect(
            fetch(server.urlFor("/mocked-endpoint"))
        ).to.have.responseText("mocked data");
    });

    it("should mock request via callback", async () => {
        await server.forPost("/callback-endpoint").thenCallback(async (req) => {
            return { statusCode: 200, body: await req.body.getText() };
        });

        await expect(
            fetch(server.urlFor("/callback-endpoint"), {
                method: 'post',
                body: 'test-body'
            })
        ).to.have.responseText("test-body");
    });

    it("should reject non-matching requests", async () => {
        await server.forGet("/other-endpoint").thenReply(200, "mocked data");

        let result = fetch(server.urlFor("/not-mocked-endpoint"));

        await expect(result).to.have.status(503);
        await expect(result).to.have.responseText(/No rules were found matching this request/);
    });

    nodeOnly(() => {
        it("can proxy requests to made to any other hosts", async () => {
            await server.forGet("http://google.com").thenReply(200, "Not really google");

            let response = fetch("http://google.com", <{}> {
                agent: new HttpProxyAgent(server.url)
            });

            await expect(response).to.have.responseText("Not really google");
        });
    });
});

import HttpProxyAgent = require('http-proxy-agent');
import { getLocal } from "../..";
import { expect, fetch, nodeOnly } from "../test-utils";

describe("Basic HTTP mocking", function () {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should mock simple matching GETs", async () => {
        await server.get("/mocked-endpoint").thenReply(200, "mocked data",
            {"Access-Control-Expose-Headers": "Content-Type, myHeader", "myHeader": "foo"});

        let response = await fetch(server.urlFor("/mocked-endpoint"));
        
        expect(await response.headers.get("myHeader")).to.equal("foo");
        expect(await response.text()).to.equal("mocked data");
    });

    it("should reject non-matching requests", async () => {
        await server.get("/other-endpoint").thenReply(200, "mocked data");

        let result = await fetch(server.urlFor("/not-mocked-endpoint"));

        expect(result.status).to.equal(503);
        expect(await result.text()).to.include("No rules were found matching this request");
    });

    nodeOnly(() => {
        it("can proxy requests to made to any other hosts", async () => {
            await server.get("http://google.com").thenReply(200, "Not really google");

            let response = await fetch("http://google.com", <{}> {
                agent: new HttpProxyAgent(server.url)
            });

            expect(await response.text()).to.equal("Not really google");
        });
    });
});

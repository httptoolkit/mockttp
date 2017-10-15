import HttpProxyAgent = require('http-proxy-agent');
import { getLocal } from "../..";
import { expect, fetch, nodeOnly } from "../test-utils";

describe("Basic HTTP mocking", function () {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should mock simple matching GETs", async () => {
        await server.get("/mocked-endpoint").thenReply(200, "mocked data");

        let response = await fetch(server.urlFor("/mocked-endpoint"));
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

    it("should explain itself", async () => {
        await server.get("/endpointA").once().thenReply(200, "nice request!");
        await server.post("/endpointB").withHeaders({ 'h': 'v' }).withForm({ key: 'value' }).thenReply(500);
        await server.put("/endpointC").always().thenReply(200, "good headers");

        await fetch(server.urlFor("/endpointA"));
        let response = await fetch(server.urlFor("/non-existent-endpoint"));

        let text = await response.text();

        expect(text).to.include(`No rules were found matching this request.
This request was: GET request to /non-existent-endpoint `);
        expect(text).to.include(`The configured rules are:
Match requests making GETs for /endpointA, and then respond with status 200 and body "nice request!", once (done).
Match requests making POSTs for /endpointB, with headers including {"h":"v"}, and with form data including {"key":"value"}, and then respond with status 500.
Match requests making PUTs for /endpointC, and then respond with status 200 and body "good headers", always (seen 0).
`);
    });
});

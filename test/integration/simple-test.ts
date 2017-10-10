import { getLocal } from "../..";
import request = require("request-promise-native");
import expect from "../expect";

describe("Basic HTTP mocking", function () {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should mock simple matching GETs", async () => {
        server.get("/mocked-endpoint").thenReply(200, "mocked data");

        let response = await request.get(server.urlFor("/mocked-endpoint"));
        expect(response).to.equal("mocked data");
    });

    it("should reject non-matching requests", async () => {
        server.get("/other-endpoint").thenReply(200, "mocked data");

        let result = await request.get(server.urlFor("/not-mocked-endpoint")).catch((e) => e);

        expect(result).to.be.instanceof(Error);
        expect(result.statusCode).to.equal(503);
        expect(result.message).to.include("No rules were found matching this request");
    });

    it("can proxy requests to made to any other hosts", async () => {
        await server.get("http://google.com").thenReply(200, "Not really google");

        let proxiedRequest = request.defaults({ proxy: server.url });
        let response = await proxiedRequest.get("http://google.com");

        expect(response).to.equal("Not really google");
    });

    it("should explain itself", async () => {
        server.get("/endpointA").once().thenReply(200, "nice request!");
        server.post("/endpointB").withHeaders({ 'h': 'v' }).withForm({ key: 'value' }).thenReply(500);
        server.put("/endpointC").always().thenReply(200, "good headers");

        await request.get(server.urlFor("/endpointA"));
        let error = await request.get(server.urlFor("/non-existent-endpoint")).catch(e => e);

        expect(error.response.body).to.equal(`No rules were found matching this request.
This request was: GET request to /non-existent-endpoint

The configured rules are:
Match requests making GETs for /endpointA, and then respond with status 200 and body "nice request!", once (done).
Match requests making POSTs for /endpointB, with headers including {"h":"v"}, and with form data including {"key":"value"}, and then respond with status 500.
Match requests making PUTs for /endpointC, and then respond with status 200 and body "good headers", always (seen 0).
`);
    });
});

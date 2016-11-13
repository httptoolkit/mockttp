import HttpServerMock = require("../../src/main");
import request = require("request-promise-native");
import expect from "../expect";

describe("Basic HTTP mocking", function () {
    let server = new HttpServerMock();

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
});

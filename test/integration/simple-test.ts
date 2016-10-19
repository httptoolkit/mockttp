import HttpServerMock = require("../../src/main");
import request = require("request-promise-native");
import expect from "../expect";

describe("HTTP Server Mock", function () {
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

    describe("form matching", () => {
        beforeEach(() => {
            server.post("/")
                  .withForm({ shouldMatch: "yes" })
                  .thenReply(200, "matched");
        });

        it("should match requests by form data", async () => {
            let response = await request.post(server.url, {
                form: { shouldMatch: "yes" }
            });
            expect(response).to.equal("matched");
        });

        it("shouldn't match requests without form data", async () => {
            await expect(request.post(server.url)).to.eventually.be.rejected;
        });

        it("shouldn't match requests with the wrong form data", async () => {
            await expect(request.post(server.url, {
                form: { shouldMatch: "no" }
            })).to.eventually.be.rejected;
        });
    });
});

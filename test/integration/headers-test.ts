import HttpServerMock = require("../../src/main");
import request = require("request-promise-native");
import expect from "../expect";

describe("Header matching", function () {
    let server = new HttpServerMock();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    beforeEach(() => {
        server.get("/")
              .withHeaders({ "X-Should-Match": "yes" })
              .thenReply(200, "matched header");
    });

    it("should match requests with the matching header", async () => {
        let response = await request.get(server.url, {
            headers: { "X-Should-Match": "yes" }
        });
        expect(response).to.equal("matched header");
    });

    it("should not match requests with no (extra) headers", async () => {
        await expect(request.get(server.url)).to.eventually.be.rejected;

    });

    it("should not match requests with the wrong header value", async () => {
        await expect(request.get(server.url, {
            headers: { "X-Should-Match": "no" }
        })).to.eventually.be.rejected;
    });
});

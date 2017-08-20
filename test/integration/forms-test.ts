import { getLocal } from "../..";
import request = require("request-promise-native");
import expect from "../expect";

describe("Form data matching", function () {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

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

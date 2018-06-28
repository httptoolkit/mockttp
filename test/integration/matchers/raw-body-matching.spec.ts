import { getLocal } from "../../..";
import { expect, fetch, Headers } from "../../test-utils";

describe("Raw body matching", function () {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    beforeEach(async () => {
        await server.post("/")
              .withBody('should-match')
              .thenReply(200, 'matched');
    });

    it("should match requests by body", async () => {
        return expect(fetch(server.url, {
            method: 'POST',
            body: 'should-match'
        })).to.have.responseText('matched');
    });
    
    it("shouldn't match requests with the wrong body", async () => {
        return expect(fetch(server.url, {
            method: 'POST',
            body: 'should-not-match'
        })).not.to.have.responseText('matched');
    });

    it("should match requests ignoring content types", async () => {
        return expect(fetch(server.url, {
            method: 'POST',
            body: 'should-match',
            headers: new Headers({
              'Content-Type': 'application/json'
            }),
        })).to.have.responseText('matched');
    });

    it("should not match requests with no body", async () => {
        return expect(fetch(server.url, {
            method: 'POST'
        })).not.to.have.responseText("matched");
    });
});

import { getLocal } from "../../..";
import { expect, fetch, Headers } from "../../test-utils";

describe("Regular expression raw body matching", function () {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    beforeEach(async () => {
        await server.post("/")
              .withRegexBody(/"username": "test"/gi)
              .thenReply(200, 'matched');
    });

    it('should match requests by regular expressions', async () => {
        return expect(fetch(server.url, {
            method: 'POST',
            body: '{"username": "test", passwd: "test"}'
        })).to.have.responseText('matched');
    });

    it('should match requests by regular expressions', async () => {
        return expect(fetch(server.url, {
            method: 'POST',
            body: '{"user": "test", passwd: "test"}'
        })).not.to.have.responseText('matched');
    });
});

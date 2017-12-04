import { getLocal } from "../..";
import { expect, fetch, Headers } from "../test-utils";

describe("Header matching", function () {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    beforeEach(() => {
        server.get("/")
              .withHeaders({ "X-Should-Match": "yes" })
              .thenReply(200, "matched header");
    });

    it("should match requests with the matching header", async () => {
        let response = await fetch(server.url, {
            mode: 'cors', // In a browser, you can only send custom headers with CORS enabled
            headers: new Headers({ "X-Should-Match": "yes" })
        });
        expect(await response.text()).to.equal("matched header");
    });

    it("should not match requests with no (extra) headers", async () => {
        let response = await fetch(server.url, {
            mode: 'cors'
        })

        expect(response.status).to.equal(503);
    });

    it("should not match requests with the wrong header value", async () => {
        let response = await fetch(server.url, {
            mode: 'cors',
            headers: new Headers({ "X-Should-Match": "no" })
        });
        expect(response.status).to.equal(503);
    });
});

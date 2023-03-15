import { getLocal } from "../../..";
import { expect, fetch, Headers, URLSearchParams } from "../../test-utils";

describe("Form data matching", function () {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    beforeEach(async () => {
        await server.forPost("/")
              .withForm({ shouldMatch: "yes" })
              .thenReply(200, "matched");
    });

    it("should match requests by form data", async () => {
        let form = new URLSearchParams();
        form.set('shouldMatch', 'yes');

        return expect(fetch(server.url, {
            method: 'POST',
            headers: new Headers({
              'Content-Type': 'application/x-www-form-urlencoded'
            }),
            body: form
        })).to.have.responseText("matched");
    });

    it("should match requests by form data flexibly, ignoring additional data", async () => {
        let form = new URLSearchParams();

        form.set('firstFields', 'hello');
        form.set('shouldMatch', 'yes');
        form.set('otherFields', 'goodbye');

        return expect(fetch(server.url, {
            method: 'POST',
            headers: new Headers({
              'Content-Type': 'application/x-www-form-urlencoded'
            }),
            body: form
        })).to.have.responseText("matched");
    });

    it("shouldn't match requests with the wrong form data", async () => {
        let form = new URLSearchParams();
        form.set('shouldMatch', 'no');

        return expect(fetch(server.url, {
            method: 'POST',
            headers: new Headers({
              'Content-Type': 'application/x-www-form-urlencoded'
            }),
            body: form
        })).not.to.have.responseText("matched");
    });

    it("shouldn't match requests without form data", async () => {
        return expect(fetch(server.url, {
            method: 'POST',
            headers: new Headers({
              'Content-Type': 'application/x-www-form-urlencoded'
            }),
        })).not.to.have.responseText("matched");
    });
});

import { CompletedRequest, getLocal } from "../../..";
import { expect, fetch } from "../../test-utils";

describe("Request callback matching", function () {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should match requests with the callback reports true", async () => {
        let callbackRequest: CompletedRequest | undefined;
        await server.forPost('/abc').matching((request) => {
            callbackRequest = request;
            return true;
        }).thenReply(200, 'Mocked response');

        let result = await fetch(server.urlFor('/abc'), {
            method: 'POST',
            body: '{"username": "test", "passwd": "test"}'
        });

        await expect(result).to.have.responseText('Mocked response');
        expect(callbackRequest).to.haveOwnProperty('protocol', 'http');
        expect(callbackRequest).to.haveOwnProperty('path', '/abc');
        expect(await callbackRequest?.body?.getJson()).to.deep.equal({ username: "test", passwd: "test" });
    });

    it("should match requests with an async callback", async () => {
        await server.forPost('/abc').matching(async (request) => {
            const body = await request?.body?.getJson() as any;
            return body?.username === 'test';
        }).thenReply(200, 'Mocked response');

        let result = await fetch(server.urlFor('/abc'), {
            method: 'POST',
            body: '{"username": "test", "passwd": "test"}'
        });

        await expect(result).to.have.responseText('Mocked response');
    });

    it("should not match requests with the callback reports false", async () => {
        await server.forGet('/abc').matching(() => {
            return false;
        }).thenReply(200, 'Mocked response');

        let result = await fetch(server.urlFor('/abc'));

        await expect(result).to.have.status(503);
    });

    it("should throw a Matcher exception if the callback throws an error", async () => {
        await server.forGet('/abc').matching(() => {
            throw new Error("Matcher exception");
        }).thenReply(200, 'Mocked response');

        const result = await fetch(server.urlFor('/abc'));

        await expect(result).to.have.status(500);
    });
});

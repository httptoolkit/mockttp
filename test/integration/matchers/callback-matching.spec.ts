import { getLocal, OngoingRequest } from "../../../dist/main";
import { expect, fetch } from "../../test-utils";

describe("Request callback matching", function () {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should match requests with the callback reports true", async () => {
        let callbackRequest: OngoingRequest | undefined;
        await server.post('/abc').withCallback((request) => {
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
        expect(await callbackRequest?.body?.asJson()).to.deep.equal({ username: "test", passwd: "test" });
    });

    it("should match requests with an async callback", async () => {
        await server.post('/abc').withCallback(async (request) => {
            const body = await request?.body?.asJson() as any;
            return body?.username === 'test';
        }).thenReply(200, 'Mocked response');

        let result = await fetch(server.urlFor('/abc'), {
            method: 'POST',
            body: '{"username": "test", "passwd": "test"}'
        });

        await expect(result).to.have.responseText('Mocked response');
    });

    it("should not match requests with the callback reports false", async () => {
        await server.get('/abc').withCallback(() => {
            return false;
        }).thenReply(200, 'Mocked response');

        let result = await fetch(server.urlFor('/abc'));

        await expect(result).to.have.status(503);
    });
});

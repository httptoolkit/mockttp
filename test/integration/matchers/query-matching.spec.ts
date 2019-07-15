import { getLocal } from "../../..";
import { expect, fetch } from "../../test-utils";

describe("Request query matching", function () {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should match requests by path regardless of the query string in the request", async () => {
        await server.get('/abc').thenReply(200, 'Mocked response');

        let result = await fetch(server.urlFor('/abc?a=b'));

        await expect(result).to.have.responseText('Mocked response');
    });

    it("should match if a specific query, if present", async () => {
        await server.get('/').withQuery({ a: 1 }).thenReply(200);

        let result = await fetch(server.urlFor('/?a=1'));

        await expect(result).to.have.status(200);
    });

    it("should match if a specific query, even if extra parameters are present", async () => {
        await server.get('/').withQuery({ a: 'hello' }).thenReply(200);

        let result = await fetch(server.urlFor('/?b=10&a=hello'));

        await expect(result).to.have.status(200);
    });

    it("should fail to match if a specific query is not present", async () => {
        await server.get('/').withQuery({ a: 1 }).thenReply(200);

        let result = await fetch(server.urlFor('/?a=2'));

        await expect(result).to.have.status(503);
    });

    it("should match with mixed-case query parameters", async () => {
        await server.get('/').withQuery({ c: "hello" }).thenReply(200);

        let result = await fetch(server.urlFor('/?aB=&c=hello'));

        await expect(result).to.have.status(200);
    });

    it("should match array query parameters", async () => {
        await server.get('/').withQuery({ c: ["hello", "world"] }).thenReply(200);

        let result = await fetch(server.urlFor('/?c=hello&c=world'));

        await expect(result).to.have.status(200);
    });

    it("should not match array query parameters if an array element is missing", async () => {
        await server.get('/').withQuery({ c: ["hello", "world"] }).thenReply(200);

        let result = await fetch(server.urlFor('/?c=hello'));

        await expect(result).to.have.status(503);
    });

    it("should match array query parameters for a subset of the values", async () => {
        await server.get('/').withQuery({ c: ["hello", "world"] }).thenReply(200);

        let result = await fetch(server.urlFor('/?c=hello&c=world&c=again'));

        await expect(result).to.have.status(200);
    });
});

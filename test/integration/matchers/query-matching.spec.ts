import { getLocal } from "../../..";
import { expect, isNode, httpGet } from "../../test-utils";

describe("Request query matching", function () {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should match requests by path regardless of the query string in the request", async () => {
        await server.forGet('/abc').thenReply(200, 'Mocked response');

        let result = await fetch(server.urlFor('/abc?a=b'));

        await expect(result).to.have.responseText('Mocked response');
    });

    describe("when fuzzy matching", () => {
        it("should match with a specific query, if present", async () => {
            await server.forGet('/').withQuery({ a: 1 }).thenReply(200);

            let result = await fetch(server.urlFor('/?a=1'));

            await expect(result).to.have.status(200);
        });

        it("should match with a specific query, even if extra parameters are present", async () => {
            await server.forGet('/').withQuery({ a: 'hello' }).thenReply(200);

            let result = await fetch(server.urlFor('/?b=10&a=hello'));

            await expect(result).to.have.status(200);
        });

        it("should fail to match if a specific query is not present", async () => {
            await server.forGet('/').withQuery({ a: 1 }).thenReply(200);

            let result = await fetch(server.urlFor('/?a=2'));

            await expect(result).to.have.status(503);
        });

        it("should match with mixed-case query parameters", async () => {
            await server.forGet('/').withQuery({ c: "hello" }).thenReply(200);

            let result = await fetch(server.urlFor('/?aB=&c=hello'));

            await expect(result).to.have.status(200);
        });

        it("should match array query parameters", async () => {
            await server.forGet('/').withQuery({ c: ["hello", "world"] }).thenReply(200);

            let result = await fetch(server.urlFor('/?c=hello&c=world'));

            await expect(result).to.have.status(200);
        });

        it("should not match array query parameters if an array element is missing", async () => {
            await server.forGet('/').withQuery({ c: ["hello", "world"] }).thenReply(200);

            let result = await fetch(server.urlFor('/?c=hello'));

            await expect(result).to.have.status(503);
        });

        it("should match array query parameters for a subset of the values", async () => {
            await server.forGet('/').withQuery({ c: ["hello", "world"] }).thenReply(200);

            let result = await fetch(server.urlFor('/?c=hello&c=world&c=again'));

            await expect(result).to.have.status(200);
        });
    });

    describe("when exact string matching", () => {
        it("should match with a specific query, if present", async () => {
            await server.forGet('/').withExactQuery('?a=1').thenReply(200);

            let result = await fetch(server.urlFor('/?a=1'));

            await expect(result).to.have.status(200);
        });

        it("should fail to match a query if extra parameters are present", async () => {
            await server.forGet('/').withExactQuery('?a=1').thenReply(200);

            let result = await fetch(server.urlFor('/?a=1&b=2'));

            await expect(result).to.have.status(503);
        });

        it("should fail to match if no query is present", async () => {
            await server.forGet('/').withExactQuery('?a=1').thenReply(200);

            let result = await fetch(server.urlFor('/'));

            await expect(result).to.have.status(503);
        });

        it("should fail to match if only an empty query is present", async () => {
            await server.forGet('/').withExactQuery('?a=1').thenReply(200);

            let result = await fetch(server.urlFor('/?'));

            await expect(result).to.have.status(503);
        });

        it("should be able to explicitly match an empty query", async () => {
            await server.forGet('/').withExactQuery('?').thenReply(200);

            // Native fetch normalizes '/?' to '/', stripping the empty query.
            // Use httpGet to preserve the exact URL on the wire.
            let result = await (isNode
                ? httpGet(server.urlFor('/?'))
                : fetch(server.urlFor('/?'))
            );

            await expect(result).to.have.status(200);
        });

        it("should be able to explicitly match an no query", async () => {
            await server.forGet('/').withExactQuery('').thenReply(200);

            let result = await fetch(server.urlFor('/'));

            await expect(result).to.have.status(200);
        });

        it("should disallow matching query params without a ?", async () => {
            expect(
                () => server.forGet('/').withExactQuery('a=b').thenReply(200)
            ).to.be.throw('must start with ?');
        });
    });
});

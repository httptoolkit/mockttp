import { stripIndent } from "common-tags";

import { getLocal } from "../../..";
import { expect, fetch, browserOnly } from "../../test-utils";

describe("Method & path request matching", function () {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    type Method = 'get' | 'post' | 'put' | 'delete' | 'patch' | 'head' | 'options';
    let methods: Method[] = [ 'get', 'post', 'put', 'delete', 'patch', 'head', 'options' ];

    browserOnly(() => {
        methods = methods.filter((m) => m !== 'options');

        it('should not allow registering matches for OPTIONS requests by default', () => {
            let error: Error | null = null;
            try {
                server.options('/');
            } catch (e) {
                error = e;
            }

            expect(error).to.be.instanceof(Error);
            expect(error!.message).to.include(`Cannot mock OPTIONS requests with CORS enabled.\n
You can disable CORS by passing { cors: false } to getLocal/getRemote, but this may cause issues \
connecting to your mock server from browsers, unless you mock all required OPTIONS preflight \
responses by hand.`);
        });
    });

    methods.forEach((methodName: Method) => {
        it(`should match ${methodName.toUpperCase()} requests`, async () => {
            await server[methodName]('/').thenReply(200, methodName);

            let result = await fetch(server.url, {
                method: methodName.toUpperCase(),
            });

            await expect(result).to.have.status(200);
            if (methodName !== 'head') {
                await expect(result).to.have.responseText(methodName);
            } else {
                await expect(result).to.have.responseText('');
            }
        });
    });

    it("should match requests for a matching relative path", async () => {
        await server.get('/').thenReply(200, 'Fake file');

        let result = await fetch(server.urlFor('/'));

        await expect(result).to.have.responseText('Fake file');
    });

    it("should refuse to create a matcher for requests for an empty path", async () => {
        await expect(
            // Wrap, so that both sync/async errors become rejections
            Promise.resolve().then(() => server.get('').thenReply(200, 'Fake file'))
        ).to.be.rejectedWith('Invalid URL');
    });

    it("should match requests for a matching absolute url", async () => {
        await server.get(`http://localhost:${server.port}/file.txt`).thenReply(200, 'Fake file');

        let result = await fetch(server.urlFor('/file.txt'));

        await expect(result).to.have.responseText('Fake file');
    });

    it("should match requests for a matching absolute protocol-independent url", async () => {
        await server.get(`localhost:${server.port}/file.txt`).thenReply(200, 'Fake file');

        let result = await fetch(server.urlFor('/file.txt'));

        await expect(result).to.have.responseText('Fake file');
    });

    it("should match requests for a matching absolute URL regardless of a missing trailing slash", async () => {
        await server.get(`http://localhost:${server.port}`).thenReply(200, 'Root response');

        let result = await fetch(server.urlFor('/'));

        await expect(result).to.have.responseText('Root response');
    });

    it("should regex match requests for a matching path", async () => {
        await server.get(/^\/matching-\w+.txt/).thenReply(200, 'Fake file');

        let result = await fetch(server.urlFor('/matching-file.txt'));

        await expect(result).to.have.responseText('Fake file');
    });

    it("should regex match requests for a URL with trailing slashes included", async () => {
        await server.get(/localhost:\d+\/$/).thenReply(200, 'Root response');

        let result = await fetch(server.urlFor('/'));

        await expect(result).to.have.responseText('Root response');
    });

    it("should regex match requests for a matching full URL", async () => {
        await server.get(/localhost:\d+\/[\w\-]+.txt/).thenReply(200, 'Fake file');

        let result = await fetch(server.urlFor('/matching-file.txt'));

        await expect(result).to.have.responseText('Fake file');
    });

    it("should reject requests for the wrong path", async () => {
        await server.get("/specific-endpoint").thenReply(200, "mocked data");

        let result = await fetch(server.url);

        expect(result.status).to.equal(503);
    });

    it("should reject requests that don't match a regex path", async () => {
        await server.get(/.*.txt/).thenReply(200, 'Fake file');

        let result = await fetch(server.urlFor('/non-matching-file.css'));

        expect(result.status).to.equal(503);
    });

    it("should match requests ignoring the query string", async () => {
        await server.get('/path').thenReply(200, 'Matched path');

        let result = await fetch(server.urlFor('/path?a=b'));

        await expect(result).to.have.responseText('Matched path');
    });

    it("should fail if you pass a query string in the path", async () => {
        await expect(
            () => server.get('/?a=b').thenReply(200, 'Mocked response')
        ).to.throw(stripIndent`
            Tried to match a path that contained a query (?a=b). ${''
            }To match query parameters, add .withQuery({"a":"b"}) instead.
        `);
    });

    it("should allowing matching all requests, with a wildcard", async () => {
        await server.anyRequest().thenReply(200, "wildcard response");

        await expect(fetch(server.urlFor('/any-old-endpoint'))).to.have.responseText('wildcard response');
    });
});

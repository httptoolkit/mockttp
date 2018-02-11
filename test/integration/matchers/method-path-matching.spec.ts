import { getLocal } from "../../..";
import { expect, fetch, browserOnly } from "../../test-utils";

describe("Method & path request matching", function () {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    type Method = 'get' | 'post' | 'put' | 'delete' | 'patch' | 'options';
    let methods: Method[] = [ 'get', 'post', 'put', 'delete', 'patch', 'options' ];

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
        it(`should match requests by ${methodName}`, async () => {
            await server[methodName]('/').thenReply(200, methodName);
            
            return expect(fetch(server.url, {
                method: methodName.toUpperCase(),
            })).to.have.responseText(methodName);
        });
    });

    it("should reject requests for the wrong path", async () => {
        await server.get("/specific-endpoint").thenReply(200, "mocked data");

        let result = await fetch(server.url);

        expect(result.status).to.equal(503);
    });

    it("should allowing matching all requests, with a wildcard", async () => {
        await server.anyRequest().thenReply(200, "wildcard response");

        await expect(fetch(server.urlFor('/any-old-endpoint'))).to.have.responseText('wildcard response');
    });
});

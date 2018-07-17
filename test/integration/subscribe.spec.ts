import { getLocal, getStandalone, getRemote, CompletedRequest } from "../..";
import { expect, fetch, nodeOnly, delay, getDeferred } from "../test-utils";

describe("Request subscriptions", () => {
    describe("with a local server", () => {
        let server = getLocal();

        beforeEach(() => server.start());
        afterEach(() => server.stop());

        it("should notify with request details & body when a request is ready", async () => {
            let seenRequestPromise = getDeferred<CompletedRequest>();
            await server.on('request', (r) => seenRequestPromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"), { method: 'POST', body: 'body-text' });

            let seenRequest = await seenRequestPromise;
            expect(seenRequest.method).to.equal('POST');
            expect(seenRequest.hostname).to.equal('localhost');
            expect(seenRequest.url).to.equal('/mocked-endpoint');
            expect(seenRequest.body.text).to.equal('body-text');
        });
    });

    nodeOnly(() => {
        describe("with a remote client", () => {
            let standalone = getStandalone();
            let client = getRemote();

            before(() => standalone.start());
            after(() => standalone.stop());

            beforeEach(() => client.start());
            afterEach(() => client.stop());

            it("should notify with request details after a request is made", async () => {
                let seenRequestPromise = getDeferred<CompletedRequest>();
                await client.on('request', (r) => seenRequestPromise.resolve(r));

                fetch(client.urlFor("/mocked-endpoint"), { method: 'POST', body: 'body-text' });

                let seenRequest = await seenRequestPromise;
                expect(seenRequest.method).to.equal('POST');
                expect(seenRequest.url).to.equal('/mocked-endpoint');
                expect(seenRequest.body.text).to.equal('body-text');
            });

        });
    });
});
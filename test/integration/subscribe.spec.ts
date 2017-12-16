import { getLocal, getStandalone, getRemote, OngoingRequest } from "../..";
import { expect, fetch, nodeOnly, delay, getDeferred } from "../test-utils";

describe("Request subscriptions", () => {
    describe("with a local server", () => {
        let server = getLocal();

        beforeEach(() => server.start());
        afterEach(() => server.stop());

        it("should notify with request details after a request is made", async () => {
            let seenRequestPromise = getDeferred<OngoingRequest>();
            await server.on('request', (r) => seenRequestPromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"));

            let seenRequest = await seenRequestPromise;
            expect(seenRequest.method).to.equal('GET');
            expect(seenRequest.url).to.equal('/mocked-endpoint');
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
                let seenRequestPromise = getDeferred<OngoingRequest>();
                await client.on('request', (r) => seenRequestPromise.resolve(r));

                fetch(client.urlFor("/mocked-endpoint"));

                let seenRequest = await seenRequestPromise;
                expect(seenRequest.method).to.equal('GET');
                expect(seenRequest.url).to.equal('/mocked-endpoint');
            });
        });
    });
});
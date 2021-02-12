import { PassThrough } from 'stream';

import { getLocal } from "../../..";
import { expect, fetch, Headers, delay, nodeOnly } from "../../test-utils";

describe("Body matching", function () {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    describe("for exact strings", () => {

        beforeEach(async () => {
            await server.post("/")
                .withBody('should-match')
                .thenReply(200, 'matched');
        });

        it("should match requests by body", async () => {
            return expect(fetch(server.url, {
                method: 'POST',
                body: 'should-match'
            })).to.have.responseText('matched');
        });

        it("shouldn't match requests with the wrong body", async () => {
            return expect(fetch(server.url, {
                method: 'POST',
                body: 'should-not-match'
            })).not.to.have.responseText('matched');
        });

        it("should match requests ignoring content types", async () => {
            return expect(fetch(server.url, {
                method: 'POST',
                body: 'should-match',
                headers: new Headers({
                'Content-Type': 'application/json'
                }),
            })).to.have.responseText('matched');
        });

        it("should not match requests with no body", async () => {
            return expect(fetch(server.url, {
                method: 'POST'
            })).not.to.have.responseText("matched");
        });
    });

    describe("for regexes", () => {

        beforeEach(async () => {
            await server.post("/")
                .withBody(/"username": "test"/gi)
                .thenReply(200, 'matched');
        });

        it('should match requests by regular expressions', async () => {
            return expect(fetch(server.url, {
                method: 'POST',
                body: '{"username": "test", "passwd": "test"}'
            })).to.have.responseText('matched');
        });

        it('should not match requests with non-matching regular expressions', async () => {
            return expect(fetch(server.url, {
                method: 'POST',
                body: '{"user": "test", "passwd": "test"}'
            })).not.to.have.responseText('matched');
        });

        it("should not match requests with no body", async () => {
            return expect(fetch(server.url, {
                method: 'POST'
            })).not.to.have.responseText("matched");
        });
    });

    describe("for exact JSON", () => {

        beforeEach(async () => {
            await server.post("/")
                .withJsonBody({ "username": "test" })
                .thenReply(200, 'matched');
        });

        it("should match requests with the expected body", () => {
            return expect(fetch(server.url, {
                method: 'POST',
                body: '{"username": "test"}'
            })).to.have.responseText('matched');
        });

        it("should not match requests with no body", () => {
            return expect(fetch(server.url, {
                method: 'POST'
            })).not.to.have.responseText("matched");
        });

        it("should not match requests with non-parseable bodies", () => {
            return expect(fetch(server.url, {
                method: 'POST',
                body: '???{"username": "test"}',
            })).not.to.have.responseText("matched");
        });

        it("should not match requests with extra fields", () => {
            return expect(fetch(server.url, {
                method: 'POST',
                body: '{"username": "test", "passwd": "test"}'
            })).not.to.have.responseText('matched');
        });

    });

    describe("for fuzzy JSON", () => {

        beforeEach(async () => {
            await server.post("/")
                .withJsonBodyIncluding({ "username": "test", "values": [1] })
                .thenReply(200, 'matched');
        });

        it("should match requests with the exact expected body", () => {
            return expect(fetch(server.url, {
                method: 'POST',
                body: '{ "username": "test", "values": [1] }'
            })).to.have.responseText('matched');
        });

        it("should not match requests with no body", () => {
            return expect(fetch(server.url, {
                method: 'POST'
            })).not.to.have.responseText("matched");
        });

        it("should not match requests with non-parseable bodies", () => {
            return expect(fetch(server.url, {
                method: 'POST',
                body: '???{ "username": "test", "values": [1] }',
            })).not.to.have.responseText("matched");
        });

        it("should match requests with extra fields", () => {
            return expect(fetch(server.url, {
                method: 'POST',
                body: '{"username": "test", "values": [1], "passwd": "test"}'
            })).to.have.responseText('matched');
        });

        it("should match requests with extra array values", () => {
            return expect(fetch(server.url, {
                method: 'POST',
                body: '{"username": "test", "values": [1, 2, 3]}'
            })).to.have.responseText('matched');
        });

    });

    nodeOnly(() => { // TODO: This could be tested in a browser, but it's just a bit fiddly
        describe("when waiting for a body", function () {
            this.timeout(500);

            beforeEach(async () => {
                await server.put('/')
                    .thenReply(201, "Created");

                await server.post("/")
                    .withBody('should-match')
                    .thenReply(200, 'Body matched');

                await server.post("/")
                    .thenReply(404, 'No POST body matched');
            });

            it("should short-circuit, not waiting, if another matcher fails", async () => {
                const neverEndingStream = new PassThrough();
                neverEndingStream.write('some data\n');

                const neverEndingFetch = fetch(server.url, {
                    method: 'PUT', // Matches the PUT rule, not the POST
                    body: neverEndingStream as any
                });

                const fetchResult = await neverEndingFetch;

                // Should return immediately, regardless of the request body not completing:
                expect (fetchResult.status).to.equal(201);
            });

            it("should wait, if it really might match", async () => {
                const neverEndingStream = new PassThrough();
                neverEndingStream.write('some data\n');

                const neverEndingFetch = fetch(server.url, {
                    method: 'POST',
                    body: neverEndingStream as any
                });

                const result = await Promise.race([
                    neverEndingFetch,
                    delay(200).then(() => 'timeout')
                ]);

                // Should return immediately, regardless of the request body not completing:
                expect (result).to.equal('timeout');
                neverEndingStream.end(); // Clean up
            });

        });
    });
});

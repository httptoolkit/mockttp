import { getLocal, getRemote, getStandalone } from "../..";
import request = require("request-promise-native");
import { expect, fetch, nodeOnly, browserOnly } from "../test-utils";
import { PassThrough } from "stream";

browserOnly(() => {
    describe("Remote browser client with a standalone server", function () {

        describe("with a default configuration", () => {
            let client = getLocal();

            beforeEach(() => client.start());
            afterEach(() => client.stop());

            it("should find the standalone server and successfully mock a request", async () => {
                await client.get("/mocked-endpoint").thenReply(200, "mocked data");

                const response = fetch(client.urlFor("/mocked-endpoint"));

                await expect(response).to.have.responseText("mocked data");
            });
        });
    });
});

nodeOnly(() => {
    describe("Remote node client with a standalone server", function () {

        describe("with a default configuration", () => {
            let server = getStandalone();
            let client = getRemote();

            before(() => server.start());
            after(() => server.stop());

            beforeEach(() => client.start());
            afterEach(() => client.stop());

            it("should successfully mock a request as normal", async () => {
                await client.get("/mocked-endpoint").thenReply(200, "mocked data");

                const response = await request.get(client.urlFor("/mocked-endpoint"));

                expect(response).to.equal("mocked data");
            });

            it("should successfully mock requests with live callbacks", async () => {
                let count = 0;
                await client.get("/mocked-endpoint").thenCallback((req) => {
                    return { status: 200, body: `calls: ${++count}` }
                });

                const response1 = await request.get(client.urlFor("/mocked-endpoint"));
                expect(response1).to.equal("calls: 1");
                const response2 = await request.get(client.urlFor("/mocked-endpoint"));
                expect(response2).to.equal("calls: 2");
            });

            it("should successfully mock requests with live streams", async () => {
                let stream1 = new PassThrough();
                await client.get('/stream').thenStream(200, stream1);
                let stream2 = new PassThrough();
                await client.get('/stream').thenStream(200, stream2);

                stream1.end('Hello');
                stream2.end('World');

                let response1 = await fetch(client.urlFor('/stream'));
                let response2 = await fetch(client.urlFor('/stream'));

                await expect(response1).to.have.status(200);
                await expect(response1).to.have.responseText('Hello');
                await expect(response2).to.have.status(200);
                await expect(response2).to.have.responseText('World');
            });

            it("should let you verify requests as normal", async () => {
                const endpointMock = await client.get("/mocked-endpoint").thenReply(200, "mocked data");
                await request.get(client.urlFor("/mocked-endpoint"));

                const seenRequests = await endpointMock.getSeenRequests();
                expect(seenRequests.length).to.equal(1);

                expect(seenRequests[0].protocol).to.equal('http');
                expect(seenRequests[0].method).to.equal('GET');
                expect(seenRequests[0].url).to.equal('/mocked-endpoint');
            });

            it("should allow resetting the mock server configured responses", async () => {
                await client.get("/mocked-endpoint").thenReply(200, "mocked data");

                await client.reset();
                const result = await request.get(client.urlFor("/mocked-endpoint")).catch((e) => e);

                expect(result).to.be.instanceof(Error);
                expect(result.statusCode).to.equal(503);
                expect(result.message).to.include("No rules were found matching this request");
            });

            it("should allow resetting the mock server recorded requests", async () => {
                const endpointMock = await client.get("/mocked-endpoint").thenReply(200, "mocked data");
                await request.get(client.urlFor("/mocked-endpoint"));

                await client.reset();
                const result = await endpointMock.getSeenRequests().catch((e) => e);

                expect(result).to.be.instanceof(Error);
                expect(result.message).to.include("Can't get seen requests for unknown mocked endpoint");
            });

            it("should reset the server if a client leaves and rejoins", async () => {
                await client.get("/mocked-endpoint").thenReply(200, "mocked data");

                const port = client.port!;
                await client.stop();
                await client.start(port);
                const result = await request.get(client.urlFor("/mocked-endpoint")).catch((e) => e);

                expect(result).to.be.instanceof(Error);
                expect(result.statusCode).to.equal(503);
                expect(result.message).to.include("No rules were found matching this request");
            });

            it("should reject multiple clients trying to control the same port", async () => {
                const port = client.port!;

                await expect(getRemote().start(port))
                    .to.eventually.be.rejectedWith(`Cannot start: mock server is already running on port ${port}`);
            });
        });

        describe("with no server available", () => {
            it("fails to mock responses", async () => {
                let client = getRemote();

                await expect(client.start())
                    .to.eventually.be.rejectedWith('Failed to connect to standalone server at http://localhost:45456');
            });
        });

    });
});
import { getLocal, getRemote, getStandalone, Request } from "../..";
import request = require("request-promise-native");
import { expect, fetch, nodeOnly, browserOnly } from "../test-utils";

browserOnly(() => {
    describe("Remote browser client with a standalone server", function () {

        describe("with a default configuration", () => {
            let client = getLocal();

            beforeEach(() => client.start());
            afterEach(() => client.stop());

            it("should find the standalone server and successfully mock a request", async () => {
                const endpointMock = await client.get("/mocked-endpoint").thenReply(200, "mocked data");

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
                const endpointMock = await client.get("/mocked-endpoint").thenReply(200, "mocked data");

                const response = await request.get(client.urlFor("/mocked-endpoint"));

                expect(response).to.equal("mocked data");
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
                const endpointMock = await client.get("/mocked-endpoint").thenReply(200, "mocked data");

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
                const endpointMock = await client.get("/mocked-endpoint").thenReply(200, "mocked data");

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

            it("should get true when all requests for all routes were seen", async () => {
                client.get("/mocked-endpoint-1?foo=bar_1").thenReply(200, "mocked data 1");
                client.get("/mocked-endpoint-1?foo=bar_2").thenReply(200, "mocked data 2");
                client.get("/mocked-endpoint-2?foo=bar_3").thenReply(200, "mocked data 3");
                
                await request.get(client.urlFor("/mocked-endpoint-1?foo=bar_1"));
                await request.get(client.urlFor("/mocked-endpoint-1?foo=bar_2"));
                await request.get(client.urlFor("/mocked-endpoint-2?foo=bar_3"));

                var checkSeenRequestsAllRoutes = await client.checkSeenRequestsAllRoutes();
                expect(checkSeenRequestsAllRoutes).to.be.true;
            });

            it("should throw error when not all requests for all routes were seen", async () => {
                client.get("/mocked-endpoint-1?foo=bar_1").thenReply(200, "mocked data 1");
                client.get("/mocked-endpoint-1?foo=bar_2").thenReply(200, "mocked data 2");
                client.get("/mocked-endpoint-2?foo=bar_3").thenReply(200, "mocked data 3");
                
                await request.get(client.urlFor("/mocked-endpoint-1?foo=bar_1"));
                await request.get(client.urlFor("/mocked-endpoint-1?foo=bar_2"));

                try {
                    await client.checkSeenRequestsAllRoutes();
                } catch (error) {
                    expect(error.message).to.equal(`Request to http://localhost:45456/server/8000/checkSeenRequestsAllRoutes failed, with status 500 with message "no requests for mocked endpoint: /mocked-endpoint-2"`);
                }
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
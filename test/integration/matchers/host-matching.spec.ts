import { getLocal } from "../../..";
import { expect, nodeOnly, undiciFetch, ProxyAgent } from "../../test-utils";

describe("Hostname matching", function () {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    describe("with forHost", () => {

        it("should match requests for exact hostname+port matches", async () => {
            await server.forGet()
                .forHost(`test.localhost:${server.port}`)
                .thenReply(200, "matched");

            await expect(
                fetch(`http://test.localhost:${server.port}`)
            ).to.have.responseText("matched");
        });

        it("should not match requests for different hostnames", async () => {
            await server.forGet()
                .forHost(`test.localhost:${server.port}`)
                .thenReply(200, "matched");

            await expect(
                fetch(`http://another-subdomain.localhost:${server.port}`)
            ).to.not.have.responseText("matched");
        });

        it("should not match requests for different ports", async () => {
            await server.forGet()
                .forHost(`test.localhost:${server.port + 1}`)
                .thenReply(200, "matched");

            await expect(
                fetch(`http://test.localhost:${server.port}`)
            ).to.not.have.responseText("matched");
        });

        it("should not match requests for different ports if match port is omitted", async () => {
            await server.forGet()
                .forHost(`test.localhost`)
                .thenReply(200, "matched");

            await expect(
                fetch(`http://test.localhost:${server.port}`)
            ).to.not.have.responseText("matched");
        });

        nodeOnly(() => {
            // Theses tests pass, but mostly for backward compatibility - this isn't a great design.
            // It would be better to not normalize the URL so completely that the port is lost, and to
            // instead preserve it and have forHost be an _exact_ host header/absolute URL host match.

            it("should match requests with an implicit port if the match port was omitted", async () => {
                await server.forGet()
                    .forHost('localhost')
                    .thenReply(200, "matched");

                await expect(
                    undiciFetch(`http://localhost`, { dispatcher: new ProxyAgent(server.url) })
                ).to.have.responseText("matched");
            });

            it("should match requests with an explicit port if the match port was omitted", async () => {
                await server.forGet()
                    .forHost('localhost')
                    .thenReply(200, "matched");

                await expect(
                    undiciFetch(`http://localhost:80`, { dispatcher: new ProxyAgent(server.url) })
                ).to.have.responseText("matched");
            });

            it("should match requests with an explicit port if the match port was omitted", async () => {
                await server.forGet()
                    .forHost('localhost:80')
                    .thenReply(200, "matched");

                await expect(
                    undiciFetch(`http://localhost`, { dispatcher: new ProxyAgent(server.url) })
                ).to.have.responseText("matched");
            });

            it("should match requests with explicit default port if match port is explicit", async () => {
                await server.forGet()
                    .forHost('localhost:80')
                    .thenReply(200, "matched");

                await expect(
                    undiciFetch(`http://localhost:80`, { dispatcher: new ProxyAgent(server.url) })
                ).to.have.responseText("matched");
            });
        });

    });

    describe("with forHostname", () => {

        it("should match requests for exact hostname matches", async () => {
            await server.forGet()
                .forHostname('test.localhost')
                .thenReply(200, "matched");

            await expect(
                fetch(`http://test.localhost:${server.port}`)
            ).to.have.responseText("matched");
        });

        it("should not match requests for different hostnames", async () => {
            await server.forGet()
                .forHostname('test.localhost')
                .thenReply(200, "matched");

            await expect(
                fetch(`http://another-subdomain.localhost:${server.port}`)
            ).to.not.have.responseText("matched");
        });

    });

    describe("with forPost", () => {

        it("should match requests for exact port matches", async () => {
            await server.forGet()
                .forPort(server.port)
                .thenReply(200, "matched");

            await expect(
                fetch(`http://localhost:${server.port}`)
            ).to.have.responseText("matched");
        });

        it("should not match requests for different ports", async () => {
            await server.forGet()
                .forPort(server.port + 1)
                .thenReply(200, "matched");

            await expect(
                fetch(`http://localhost:${server.port}`)
            ).to.not.have.responseText("matched");
        });

        nodeOnly(() => {
            it("should match port 80 requests by explicit port", async () => {
                await server.forGet()
                    .forPort(80)
                    .thenReply(200, "matched");

                await expect(
                    undiciFetch(`http://localhost:80`, { dispatcher: new ProxyAgent(server.url) })
                ).to.have.responseText("matched");
            });

            it("should match requests with implicit ports", async () => {
                await server.forGet()
                    .forPort(80)
                    .thenReply(200, "matched");

                await expect(
                    undiciFetch(`http://localhost`, { dispatcher: new ProxyAgent(server.url) })
                ).to.have.responseText("matched");
            });
        });

    });
});

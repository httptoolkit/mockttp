import { getLocal } from "../..";
import { nodeOnly } from "../test-utils";
import {
    runPerformanceTest,
    printResults,
    assertPerformance
} from "./performance-test-helpers";

nodeOnly(() => {
    describe("Performance tests", function() {
        this.timeout(120000);

        describe("Static HTTP mocking", () => {
            const server = getLocal();

            before(async () => {
                await server.start();
            });

            after(async () => {
                await server.stop();
            });

            it("for non-pipelined throughput", async () => {
                await server.forGet("/test").thenReply(200, "OK");

                const result = await runPerformanceTest({
                    url: server.urlFor("/test"),
                    duration: 10,
                    connections: 10,
                    pipelining: 1
                });

                printResults("Non-pipelined GET requests", result);

                // Seeing >10k req/sec locally with no pipelining
                assertPerformance(result, {
                    minThroughput: 3000,
                    maxP99Latency: 50,
                    maxErrors: 0
                });
            });

            it("for pipelined throughput", async () => {
                await server.forGet("/pipelined").thenReply(200, "OK");

                const result = await runPerformanceTest({
                    url: server.urlFor("/pipelined"),
                    duration: 10,
                    connections: 10,
                    pipelining: 10
                });

                printResults("Pipelined GET requests (10 per connection)", result);

                // Seeing 15-20k req/sec locally with pipelining
                assertPerformance(result, {
                    minThroughput: 5000,
                    maxP99Latency: 50,
                    maxErrors: 0
                });
            });

            it("for requests with bodies", async () => {
                const messageBody = "x".repeat(100 * 1024); // 100KB

                await server.forPost("/body").waitForRequestBody().thenReply(200, messageBody);

                const result = await runPerformanceTest({
                    url: server.urlFor("/body"),
                    duration: 10,
                    connections: 25,
                    pipelining: 1,
                    method: 'POST',
                    body: messageBody,
                    headers: { 'content-type': 'text/plain' }
                });

                printResults("POST with body (100KB response, 100KB request)", result);

                // Seeing ~2k req/sec locally with 2x 100KB bodies
                assertPerformance(result, {
                    minThroughput: 500,
                    maxP99Latency: 500,
                    maxErrors: 0
                });
            });
        });

        describe("HTTPS traffic", () => {

            const server = getLocal({
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem'
                }
            });

            before(async () => {
                await server.start();
            });

            after(async () => {
                await server.stop();
            });

            it("for static HTTPS responses", async () => {
                await server.forGet("/secure").thenReply(200, "Secure response");

                const result = await runPerformanceTest({
                    url: server.urlFor("/secure"),
                    duration: 10,
                    connections: 10
                });

                printResults("HTTPS requests", result);

                // Seeing ~8k req/sec locally for HTTPS
                assertPerformance(result, {
                    minThroughput: 3000,
                    maxP99Latency: 50,
                    maxErrors: 0
                });
            });
        });

        describe("HTTP proxying", () => {
            const proxyServer = getLocal();
            const targetServer = getLocal();

            before(async () => {
                await targetServer.start();
                await proxyServer.start();
            });

            after(async () => {
                await proxyServer.stop();
                await targetServer.stop();
            });

            it("for Mockttp proxy to Mockttp static server", async () => {
                await targetServer.forGet("/target").thenReply(200, "Target response");
                await proxyServer.forGet("/proxy").thenForwardTo(targetServer.url);

                const result = await runPerformanceTest({
                    url: proxyServer.urlFor("/proxy"),
                    duration: 10,
                    connections: 10
                });

                printResults("HTTP proxy passthrough", result);

                // Seeing ~2500k req/sec locally for proxy + static server
                assertPerformance(result, {
                    minThroughput: 500,
                    maxP99Latency: 50,
                    maxErrors: 0
                });
            });

            it("for Mockttp proxy + beforeRequest transform to Mockttp callback server", async () => {
                await targetServer.forPost("/transform").thenCallback(async (req) => ({
                    statusCode: 200,
                    body: await req.body.getText()
                }));

                await proxyServer.forPost("/proxy").thenPassThrough({
                    beforeRequest: async (req) => {
                        const body = await req.body.getText();
                        return {
                            url: targetServer.urlFor("/transform"),
                            body: `Modified: ${body}`
                        };
                    }
                });

                const result = await runPerformanceTest({
                    url: proxyServer.urlFor("/proxy"),
                    duration: 10,
                    connections: 10,
                    method: 'POST',
                    body: "test data"
                });

                printResults("Proxy with request transformation", result);

                // Seeing ~8k req/sec locally with transformations
                assertPerformance(result, {
                    minThroughput: 500,
                    maxP99Latency: 50,
                    maxErrors: 0
                });
            });
        });

        describe("HTTPS proxying", () => {

            const proxyServer = getLocal({
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem'
                }
            });

            const targetServer = getLocal({
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem'
                }
            });

            before(async () => {
                await targetServer.start();
                await proxyServer.start();
            });

            after(async () => {
                await proxyServer.stop();
                await targetServer.stop();
            });

            it("for HTTPS proxy + HTTPS static server", async () => {
                await targetServer.forGet("/target").thenReply(200, "Target response");
                await proxyServer.forGet("/proxy").thenForwardTo(targetServer.url);

                const result = await runPerformanceTest({
                    url: proxyServer.urlFor("/proxy"),
                    duration: 10,
                    connections: 10
                });

                printResults("HTTPS proxy passthrough", result);

                // Seeing ~2k req/sec locally for HTTPS proxy + HTTPS static server
                assertPerformance(result, {
                    minThroughput: 500,
                    maxP99Latency: 50,
                    maxErrors: 0
                });
            });
        });

    });
});

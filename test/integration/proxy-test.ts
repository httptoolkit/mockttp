import _ = require("lodash");
import { getLocal, Mockttp } from "../..";
import request = require("request-promise-native");
import { expect, nodeOnly } from "../test-utils";

const INITIAL_ENV = _.cloneDeep(process.env);

nodeOnly(() => {
    describe("Mockttp when used as a proxy with `request`", function () {
        this.timeout(5000);

        let server: Mockttp;

        afterEach(async () => {
            await server.stop();
            process.env = INITIAL_ENV;
        });

        describe("with a default config", () => {

            beforeEach(async () => {
                server = getLocal();
                await server.start();
                process.env = _.merge({}, process.env, server.proxyEnv);
            });

            it("should mock proxied HTTP with request + process.env", async () => {
                await server.get("http://example.com/endpoint").thenReply(200, "mocked data");

                let response = await request.get("http://example.com/endpoint");
                expect(response).to.equal("mocked data");
            });

            it("should be able to pass through requests", async () => {
                await server.get("http://example.com/").thenPassThrough();

                let response = await request.get("http://example.com/");
                expect(response).to.include(
                    "This domain is established to be used for illustrative examples in documents."
                );
            });
        });

        describe("with an HTTPS config", () => {
            beforeEach(async () => {
                server = getLocal({
                    https: {
                        keyPath: './test/fixtures/test-ca.key',
                        certPath: './test/fixtures/test-ca.pem'
                    }
                });

                await server.start();
                process.env = _.merge({}, process.env, server.proxyEnv);
            });

            describe("using request + process.env", () => {
                it("should mock proxied HTTP", async () => {
                    await server.get("http://example.com/endpoint").thenReply(200, "mocked data");

                    let response = await request.get("http://example.com/endpoint");
                    expect(response).to.equal("mocked data");
                });
                
                it("should mock proxied HTTPS", async () => {
                    await server.get("https://example.com/endpoint").thenReply(200, "mocked data");

                    let response = await request.get("https://example.com/endpoint");
                    expect(response).to.equal("mocked data");
                });

                it("should mock proxied HTTPS with a specific port", async () => {
                    await server.get("https://example.com:1234/endpoint").thenReply(200, "mocked data");

                    let response = await request.get("https://example.com:1234/endpoint");
                    expect(response).to.equal("mocked data");
                });
                
                it("should be able to pass through requests with a body", async () => {
                    await server.post("https://httpbin.org/post").thenPassThrough();
                    
                    let response = await request.post({
                        url: "https://httpbin.org/post",
                        json: { "test": true }
                    });

                    expect(response.data).to.equal('{"test":true}');
                });
                
                it("should be able to verify requests passed through with a body", async () => {
                    const endpointMock = await server.post("https://httpbin.org/post").thenPassThrough();
                    
                    let response = await request.post({
                        url: "https://httpbin.org/post",
                        json: { "test": true }
                    });

                    const seenRequests = await endpointMock.getSeenRequests();
                    expect(seenRequests.length).to.equal(1);
                    expect(await seenRequests[0].body.text).to.equal('{"test":true}');
                });
            });
        });
    });
});
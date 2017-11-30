import _ = require("lodash");
import { getLocal, Mockttp } from "../..";
import request = require("request-promise-native");
import { expect, nodeOnly } from "../test-utils";

const INITIAL_ENV = _.cloneDeep(process.env);

nodeOnly(() => {
    describe("Mockttp when used as a proxy with `request`", function () {

        let server: Mockttp;

        afterEach(async () => {
            await server.stop();
            process.env = INITIAL_ENV;
        });

        describe("with a default config", () => {

            beforeEach(() => {
                server = getLocal();
                return server.start();
            });

            it("should mock proxied HTTP with request + process.env", async () => {
                process.env = _.merge({}, process.env, server.proxyEnv);

                server.get("http://example.com/endpoint").thenReply(200, "mocked data");

                let response = await request.get("http://example.com/endpoint");
                expect(response).to.equal("mocked data");
            });
        });

        describe("with an HTTPS config", () => {
            beforeEach(() => {
                server = getLocal({
                    https: {
                        keyPath: './test/fixtures/test-ca.key',
                        certPath: './test/fixtures/test-ca.pem'
                    }
                });
                return server.start();
            });

            describe("using request + process.env", () => {
                it("should mock proxied HTTP", async () => {
                    process.env = _.merge({}, process.env, server.proxyEnv);

                    server.get("http://example.com/endpoint").thenReply(200, "mocked data");

                    let response = await request.get("http://example.com/endpoint");
                    expect(response).to.equal("mocked data");
                });
                
                it("should mock proxied HTTPS", async () => {
                    process.env = _.merge({}, process.env, server.proxyEnv);

                    server.get("https://example.com/endpoint").thenReply(200, "mocked data");

                    let response = await request.get("https://example.com/endpoint");
                    expect(response).to.equal("mocked data");
                });

                it("should mock proxied HTTPS with a specific port", async () => {
                    process.env = _.merge({}, process.env, server.proxyEnv);

                    server.get("https://example.com:1234/endpoint").thenReply(200, "mocked data");

                    let response = await request.get("https://example.com:1234/endpoint");
                    expect(response).to.equal("mocked data");
                });
            });
        });
    });
});
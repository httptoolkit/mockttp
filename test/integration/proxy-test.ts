import _ = require("lodash");
import HttpServerMock = require("../../src/main");
import request = require("request-promise-native");
import expect from "../expect";

const INITIAL_ENV = _.cloneDeep(process.env);

describe("HTTP Server Mock when used as a proxy", function () {
    let server = new HttpServerMock();

    beforeEach(() => server.start());
    afterEach(async () => {
        await server.stop();
        process.env = INITIAL_ENV;
    });

    it("should mock proxied HTTP GETs", async () => {
        process.env = _.merge({}, process.env, server.proxyEnv);

        server.get("http://example.com/endpoint").thenReply(200, "mocked data");

        let response = await request.get("http://example.com/endpoint");
        expect(response).to.equal("mocked data");
    });
});

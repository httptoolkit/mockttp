import _ = require("lodash");
import { getLocal } from "../..";
import request = require("request-promise-native");
import { expect, nodeOnly } from "../test-utils";

const INITIAL_ENV = _.cloneDeep(process.env);

nodeOnly(() => {
    describe("HTTP Server Mock when used as a proxy with `request`", function () {
        let server = getLocal();

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
});
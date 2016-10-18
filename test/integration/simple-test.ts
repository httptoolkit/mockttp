import HttpServerMock = require("../../src/main");
import request = require("request-promise-native");
import expect from "../expect";

describe("HTTP Server Mock", function () {
    it("can mock a server", async () => {
        let server = new HttpServerMock();
        await server.start();

        server.get("/mocked-endpoint").thenReply(200, "mocked data");

        let response = await request.get(server.urlFor("/mocked-endpoint"));
        expect(response).to.equal("mocked data");

        await server.stop();
    });
});

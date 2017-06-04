import HttpServerMock = require("../../src/main");
import { Request } from "../../src/types";
import request = require("request-promise-native");
import expect from "../expect";

describe("HTTP request spying", function () {
    let server = new HttpServerMock();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should show no request details initially", async () => {
        const endpointMock = server.get("/mocked-endpoint").thenReply(200, "mocked data");

        expect(endpointMock.requestCount).to.equal(0);
        expect(endpointMock.requests).to.deep.equal([]);
    });

    it("should let you spy on the urls of requests that happened", async () => {
        const endpointMock = server.get("/mocked-endpoint").thenReply(200, "mocked data");

        await request.get(server.urlFor("/mocked-endpoint"));

        expect(endpointMock.requestCount).to.equal(1);
        expect(endpointMock.requests[0].url).to.equal("/mocked-endpoint");
    });
});

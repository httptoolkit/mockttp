import HttpServerMock = require("../../src/main");
import request = require("request-promise-native");
import expect from "../expect";

describe("HTTP mock rule completion", function () {
    let server = new HttpServerMock();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should trigger each rule once, in order, by default", async () => {
        server.get("/endpoint").thenReply(200, "first response");
        server.get("/endpoint").thenReply(200, "second response");

        let firstResponse = await request.get(server.urlFor("/endpoint"));
        expect(firstResponse).to.equal("first response");

        let secondResponse = await request.get(server.urlFor("/endpoint"));
        expect(secondResponse).to.equal("second response");
    });

    it("should continue triggering the last rule given indefinitely", async () => {
        server.get("/endpoint").thenReply(200, "first response");
        server.get("/endpoint").thenReply(200, "second response");

        await request.get(server.urlFor("/endpoint"));
        await request.get(server.urlFor("/endpoint"));
        let thirdResponse = await request.get(server.urlFor("/endpoint"));
        expect(thirdResponse).to.equal("second response");
    });
});

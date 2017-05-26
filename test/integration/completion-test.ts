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

        expect(await request.get(server.urlFor("/endpoint"))).to.equal("first response");
        expect(await request.get(server.urlFor("/endpoint"))).to.equal("second response");
    });

    it("should continue triggering the last provided rule indefinitely", async () => {
        server.get("/endpoint").thenReply(200, "first response");
        server.get("/endpoint").thenReply(200, "second response");

        await request.get(server.urlFor("/endpoint"));
        await request.get(server.urlFor("/endpoint"));
        let thirdResponse = await request.get(server.urlFor("/endpoint"));
        expect(thirdResponse).to.equal("second response");
    });

    it("should run explicitly always() rules indefinitely", async () => {
        server.get("/endpoint").always().thenReply(200, "endless response");
        server.get("/endpoint").thenReply(200, "should never be reached");

        await request.get(server.urlFor("/endpoint"));
        let secondResponse = await request.get(server.urlFor("/endpoint"));
        expect(secondResponse).to.equal("endless response");
    });

    it("should run explicitly once() rules only every once", async () => {
        server.get("/endpoint").once().thenReply(200, "first");
        server.get("/endpoint").once().thenReply(200, "second");

        let firstResult = await request.get(server.urlFor("/endpoint"));
        expect(firstResult).to.equal("first");

        let secondResult = await request.get(server.urlFor("/endpoint"));
        expect(secondResult).to.equal("second");

        let thirdResult = await request.get(server.urlFor("/endpoint")).catch((e) => e);
        expect(thirdResult).to.be.instanceof(Error);
        expect(thirdResult.statusCode).to.equal(503);
        expect(thirdResult.message).to.include("No rules were found matching this request");
    });

    it("should run times(n) requests the given number of times", async () => {
        server.get("/endpoint").times(1).thenReply(200, "first");
        server.get("/endpoint").times(2).thenReply(200, "second/third");

        expect(await request.get(server.urlFor("/endpoint"))).to.equal("first");
        expect(await request.get(server.urlFor("/endpoint"))).to.equal("second/third");
        expect(await request.get(server.urlFor("/endpoint"))).to.equal("second/third");

        let fourthResult = await request.get(server.urlFor("/endpoint")).catch((e) => e);

        // TODO: Build a chai helper that matches this automatically
        expect(fourthResult).to.be.instanceof(Error);
        expect(fourthResult.statusCode).to.equal(503);
        expect(fourthResult.message).to.include("No rules were found matching this request");
    });
});

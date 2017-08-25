import { getLocal } from "../..";
import request = require("request-promise-native");
import expect from "../expect";
import * as _ from "lodash";

describe("HTTP mock rule completion", function () {
    let server = getLocal();

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

    it("should run explicitly once() rules only once", async () => {
        server.get("/endpoint").once().thenReply(200, "first");
        server.get("/endpoint").once().thenReply(200, "second");

        let firstResult = await request.get(server.urlFor("/endpoint"));
        expect(firstResult).to.equal("first");

        let secondResult = await request.get(server.urlFor("/endpoint"));
        expect(secondResult).to.equal("second");

        let thirdResult = await request.get(server.urlFor("/endpoint")).catch(e => e);
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

        let fourthResult = await request.get(server.urlFor("/endpoint")).catch(e => e);

        expect(fourthResult).to.be.instanceof(Error);
        expect(fourthResult.statusCode).to.equal(503);
        expect(fourthResult.message).to.include("No rules were found matching this request");
    });

    it("should explain itself", async () => {
        server.get("/endpoint").once().thenReply(200, "1");
        server.get("/endpoint").twice().thenReply(200, "2/3");
        server.get("/endpoint").thrice().thenReply(200, "4/5/6");
        server.get("/endpoint").times(4).thenReply(200, "7/8/9/10");
        server.get("/endpoint").always().thenReply(200, "forever");

        let error = await request.get(server.urlFor("/non-existent-endpoint")).catch(e => e);

        expect(error.response.body).to.equal(`No rules were found matching this request.
This request was: GET request to /non-existent-endpoint

The configured rules are:
Match requests making GETs for /endpoint, and then respond with status 200 and body "1", once (seen 0).
Match requests making GETs for /endpoint, and then respond with status 200 and body "2/3", twice (seen 0).
Match requests making GETs for /endpoint, and then respond with status 200 and body "4/5/6", thrice (seen 0).
Match requests making GETs for /endpoint, and then respond with status 200 and body "7/8/9/10", 4 times (seen 0).
Match requests making GETs for /endpoint, and then respond with status 200 and body "forever", always (seen 0).
`);
    });

    it("should explain whether it's completed", async () => {
        server.get("/endpoint").once().thenReply(200, "1");
        server.get("/endpoint").twice().thenReply(200, "2/3");
        server.get("/endpoint").thrice().thenReply(200, "4/5/6");
        server.get("/endpoint").times(4).thenReply(200, "7/8/9/10");
        server.get("/endpoint").always().thenReply(200, "forever");

        await Promise.all(
            _.range(8).map(() => request.get(server.urlFor("/endpoint")))
        );

        let error = await request.get(server.urlFor("/non-existent-endpoint")).catch(e => e);

        expect(error.response.body).to.equal(`No rules were found matching this request.
This request was: GET request to /non-existent-endpoint

The configured rules are:
Match requests making GETs for /endpoint, and then respond with status 200 and body "1", once (done).
Match requests making GETs for /endpoint, and then respond with status 200 and body "2/3", twice (done).
Match requests making GETs for /endpoint, and then respond with status 200 and body "4/5/6", thrice (done).
Match requests making GETs for /endpoint, and then respond with status 200 and body "7/8/9/10", 4 times (seen 2).
Match requests making GETs for /endpoint, and then respond with status 200 and body "forever", always (seen 0).
`);
    });
});

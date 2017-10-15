import { getLocal } from "../..";
import { expect, fetch } from "../test-utils";
import * as _ from "lodash";

describe("HTTP mock rule completion", function () {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should trigger each rule once, in order, by default", async () => {
        await server.get("/endpoint").thenReply(200, "first response");
        await server.get("/endpoint").thenReply(200, "second response");

        await expect(fetch(server.urlFor("/endpoint"))).to.have.responseText("first response");
        await expect(fetch(server.urlFor("/endpoint"))).to.have.responseText("second response");
    });

    it("should continue triggering the last provided rule indefinitely", async () => {
        await server.get("/endpoint").thenReply(200, "first response");
        await server.get("/endpoint").thenReply(200, "second response");

        await fetch(server.urlFor("/endpoint"));
        await fetch(server.urlFor("/endpoint"));
        let thirdResponse = await fetch(server.urlFor("/endpoint"));
        await expect(thirdResponse).to.have.responseText("second response");
    });

    it("should run explicitly always() rules indefinitely", async () => {
        await server.get("/endpoint").always().thenReply(200, "endless response");
        await server.get("/endpoint").thenReply(200, "should never be reached");

        await fetch(server.urlFor("/endpoint"));
        let secondResponse = await fetch(server.urlFor("/endpoint"));
        await expect(secondResponse).to.have.responseText("endless response");
    });

    it("should run explicitly once() rules only once", async () => {
        await server.get("/endpoint").once().thenReply(200, "first");
        await server.get("/endpoint").once().thenReply(200, "second");

        await expect(fetch(server.urlFor("/endpoint"))).to.have.responseText("first");
        await expect(fetch(server.urlFor("/endpoint"))).to.have.responseText("second");

        let thirdResult = await fetch(server.urlFor("/endpoint"));

        await expect(thirdResult.status).to.equal(503);
        await expect(thirdResult).to.have.responseText(/No rules were found matching this request/);
    });

    it("should run times(n) requests the given number of times", async () => {
        server.get("/endpoint").times(1).thenReply(200, "first");
        server.get("/endpoint").times(2).thenReply(200, "second/third");

        await expect(fetch(server.urlFor("/endpoint"))).to.have.responseText("first");
        await expect(fetch(server.urlFor("/endpoint"))).to.have.responseText("second/third");
        await expect(fetch(server.urlFor("/endpoint"))).to.have.responseText("second/third");

        let fourthResult = await fetch(server.urlFor("/endpoint"));

        await expect(fourthResult.status).to.equal(503);
        await expect(fourthResult).to.have.responseText(/No rules were found matching this request/);
    });

    it("should explain itself", async () => {
        await server.get("/endpoint").once().thenReply(200, "1");
        await server.get("/endpoint").twice().thenReply(200, "2/3");
        await server.get("/endpoint").thrice().thenReply(200, "4/5/6");
        await server.get("/endpoint").times(4).thenReply(200, "7/8/9/10");
        await server.get("/endpoint").always().thenReply(200, "forever");

        let response = await fetch(server.urlFor("/non-existent-endpoint"));
        let responseText = await response.text();

        expect(responseText).to.include(`No rules were found matching this request.
This request was: GET request to /non-existent-endpoint`)

        expect(responseText).to.include(`The configured rules are:
Match requests making GETs for /endpoint, and then respond with status 200 and body "1", once (seen 0).
Match requests making GETs for /endpoint, and then respond with status 200 and body "2/3", twice (seen 0).
Match requests making GETs for /endpoint, and then respond with status 200 and body "4/5/6", thrice (seen 0).
Match requests making GETs for /endpoint, and then respond with status 200 and body "7/8/9/10", 4 times (seen 0).
Match requests making GETs for /endpoint, and then respond with status 200 and body "forever", always (seen 0).
`);
    });

    it("should explain whether it's completed", async () => {
        await server.get("/endpoint").once().thenReply(200, "1");
        await server.get("/endpoint").twice().thenReply(200, "2/3");
        await server.get("/endpoint").thrice().thenReply(200, "4/5/6");
        await server.get("/endpoint").times(4).thenReply(200, "7/8/9/10");
        await server.get("/endpoint").always().thenReply(200, "forever");

        await Promise.all(
            _.range(8).map(() => fetch(server.urlFor("/endpoint")))
        );

        let response = await fetch(server.urlFor("/non-existent-endpoint"));
        let responseText = await response.text();

        expect(responseText).to.include(`No rules were found matching this request.
This request was: GET request to /non-existent-endpoint`)
        
        expect(responseText).to.include(`The configured rules are:
Match requests making GETs for /endpoint, and then respond with status 200 and body "1", once (done).
Match requests making GETs for /endpoint, and then respond with status 200 and body "2/3", twice (done).
Match requests making GETs for /endpoint, and then respond with status 200 and body "4/5/6", thrice (done).
Match requests making GETs for /endpoint, and then respond with status 200 and body "7/8/9/10", 4 times (seen 2).
Match requests making GETs for /endpoint, and then respond with status 200 and body "forever", always (seen 0).
`);
    });
});

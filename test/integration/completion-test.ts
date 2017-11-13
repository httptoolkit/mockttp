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

});

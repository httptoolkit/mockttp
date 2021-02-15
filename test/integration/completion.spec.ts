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

    it("should continue triggering the last matching rule indefinitely", async () => {
        await server.get("/endpoint").thenReply(200, "first response");
        await server.get("/endpoint").thenReply(200, "second response");
        await server.get("/other-endpoint").thenReply(200, "unrelated response");

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

    it("should show endpoints as pending initially", async () => {
        const endpointMock = await server.get("/mocked-endpoint").thenReply(200, "mocked data");

        const isPending = await endpointMock.isPending();
        expect(isPending).to.equal(true);
    });

    it("should show endpoints with no completion specified as not pending after the first request", async () => {
        const endpointMock = await server.get("/mocked-endpoint").thenReply(200, "mocked data");

        await fetch(server.urlFor("/mocked-endpoint"));

        const isPending = await endpointMock.isPending();
        expect(isPending).to.equal(false);
    });

    it("should show twice() endpoints as pending after the first request", async () => {
        const endpointMock = await server.get("/mocked-endpoint").twice().thenReply(200, "mocked data");

        await fetch(server.urlFor("/mocked-endpoint"));

        const isPending = await endpointMock.isPending();
        expect(isPending).to.equal(true);
    });

    it("should show twice() endpoints as not pending after the second request", async () => {
        const endpointMock = await server.get("/mocked-endpoint").twice().thenReply(200, "mocked data");

        await fetch(server.urlFor("/mocked-endpoint"));
        await fetch(server.urlFor("/mocked-endpoint"));

        const isPending = await endpointMock.isPending();
        expect(isPending).to.equal(false);
    });

    it("should be used to populate pendingEndpoints", async () => {
        const firstRule = await server.get("/endpoint").thenReply(200, "first response");
        const secondRule = await server.get("/endpoint").thenReply(200, "second response");

        await fetch(server.urlFor("/endpoint"));

        const allEndpoints = await server.getMockedEndpoints();
        const pending = await server.getPendingEndpoints();

        expect(pending.length).to.equal(1);
        expect(pending[0].id).to.equal(secondRule.id);
        expect(await pending[0].isPending()).to.equal(true);

        expect(allEndpoints.length).to.equal(2);
        expect(allEndpoints[0].id).to.equal(firstRule.id);
        expect(allEndpoints[1].id).to.equal(secondRule.id);

        expect(await allEndpoints[0].isPending()).to.equal(false);
        expect(await allEndpoints[1].isPending()).to.equal(true);
        expect(await firstRule.isPending()).to.equal(false);
    });

});

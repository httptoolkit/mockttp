import * as _ from "lodash";

import { getLocal } from "../../..";
import { expect, fetch } from "../../test-utils";

describe("Fallback rules", () => {
    const server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should return an explanation if no fallback rule is specifically configured", async () => {
        await server.forGet('/specific-endpoint').thenReply(404, "Mock error response");

        let response = await fetch(server.urlFor("/unmocked-endpoint"));

        let text = await response.text();
        expect(text).to.include(`No rules were found matching this request.`);
    });

    it("should match any unmatched requests", async () => {
        await server.forGet('/specific-endpoint').thenReply(404, "Mock error response");
        await server.forUnmatchedRequest().thenReply(200, "Fallback response");

        let response = await fetch(server.urlFor("/unmocked-endpoint"));

        let text = await response.text();
        expect(text).to.equal('Fallback response');
    });

    it("should defer to non-fallback rules if present", async () => {
        await server.forGet('/specific-endpoint').thenReply(404, "Mock error response");
        await server.forUnmatchedRequest().thenReply(200, "Fallback response");

        let response = await fetch(server.urlFor("/specific-endpoint"));

        let text = await response.text();
        expect(text).to.equal('Mock error response');
    });

    it("should always defer to non-fallback rules, even if they're already matched", async () => {
        await server.forGet('/specific-endpoint').thenReply(404, "Mock error response");
        await server.forUnmatchedRequest().thenReply(200, "Fallback response");

        await fetch(server.urlFor("/specific-endpoint"));
        let response = await fetch(server.urlFor("/specific-endpoint"));

        // The first rule was matched before, but is still valid because it's not explicitly once() or similar.
        let text = await response.text();
        expect(text).to.equal('Mock error response');
    });

    it("should not defer to non-fallback rules that are explicitly limited", async () => {
        await server.forGet('/specific-endpoint').once().thenReply(404, "Mock error response");
        await server.forUnmatchedRequest().thenReply(200, "Fallback response");

        let response1 = await fetch(server.urlFor("/specific-endpoint"));
        let response2 = await fetch(server.urlFor("/specific-endpoint"));

        let text1 = await response1.text();
        expect(text1).to.equal('Mock error response');

        // Initial rule is once(), so its fully completed here, and no longer reacts:
        let text2 = await response2.text();
        expect(text2).to.equal('Fallback response');
    });

    it("should run indefinitely", async () => {
        await server.forGet('/specific-endpoint').thenReply(404, "Mock error response");
        await server.forUnmatchedRequest().thenReply(200, "Fallback response");

        await fetch(server.urlFor("/unmocked-endpoint"));
        await fetch(server.urlFor("/unmocked-endpoint"));
        await fetch(server.urlFor("/unmocked-endpoint"));
        await fetch(server.urlFor("/unmocked-endpoint"));
        let response = await fetch(server.urlFor("/unmocked-endpoint"));

        let text = await response.text();
        expect(text).to.equal('Fallback response');
    });

    it("should fail to register if another fallback rule is already in place", async () => {
        await server.forUnmatchedRequest().thenReply(200, "Fallback response");

        await expect(
            server.forUnmatchedRequest().thenReply(200, "Fallback response")
        ).to.be.rejectedWith('Only one fallback request rule can be registered at any time');
    });

    it("should fail to register if a matcher is used", async () => {
        await expect(
            server.forUnmatchedRequest().withJsonBody({ 'a': 'b' }).thenReply(200, "Fallback response")
        ).to.be.rejectedWith('Fallback request rules cannot include specific matching configuration');
    });
});
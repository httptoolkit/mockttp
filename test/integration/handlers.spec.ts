import HttpProxyAgent = require('http-proxy-agent');
import { getLocal } from "../..";
import { expect, fetch, nodeOnly } from "../test-utils";

describe("HTTP mock rule handling", function () {
    let server = getLocal({debug:true});

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should allow mocking the status code alone", async () => {
        await server.get("/mocked-endpoint").thenReply(204);

        let response = await fetch(server.urlFor("/mocked-endpoint"));
        
        expect(await response.status).to.equal(204);
        expect(await response.text()).to.equal("");
    });
    
    it("should allow mocking the status code & body", async () => {
        await server.get("/mocked-endpoint").thenReply(200, "mocked data");

        let response = await fetch(server.urlFor("/mocked-endpoint"));
        
        expect(await response.text()).to.equal("mocked data");
    });

    it("should allow mocking the status code alone", async () => {
        await server.get("/mocked-endpoint").thenReply(200, "mocked data", {
            "Content-Type": "text/mocked"
        });

        let response = await fetch(server.urlFor("/mocked-endpoint"));
        
        expect(await response.headers.get("Content-Type")).to.equal("text/mocked");
    });

    nodeOnly(() => {
        it("should allow mocking body as json with callback", async () => {
            await server.get("/mocked-endpoint").thenCallback(req => {
                return {status: 200, json: {myVar: "foo"}}
            });

            let response = await fetch(server.urlFor("/mocked-endpoint"));

            expect(await response.status).to.equal(200);
            expect(await response.json()).to.deep.equal({myVar: "foo"});
        });
    });
});

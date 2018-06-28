import HttpProxyAgent = require('http-proxy-agent');
import { getLocal } from "../..";
import { expect, fetch, nodeOnly, isNode, delay } from "../test-utils";

describe("HTTP mock rule handling", function () {
    let server = getLocal();

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

    it("should reply with JSON when using the JSON helper", async () => {
        await server.get('/mocked-endpoint').thenJSON(200, {myVar: 'foo'},
            { 'other-header': 'header-data' });

        let response = await fetch(server.urlFor('/mocked-endpoint'));

        expect(await response.status).to.equal(200);
        expect(await response.json()).to.deep.equal({myVar: 'foo'});
    });

    it("should allow forcibly closing the connection", async () => {
        await server.get('/mocked-endpoint').thenCloseConnection();

        let result = await fetch(server.urlFor('/mocked-endpoint')).catch(e => e);

        expect(result).to.be.instanceof(Error);
        expect(result.message).to.contain(isNode() ? 'socket hang up' : 'Network request failed');
    });

    it("should allow leaving connections to time out", async () => {
        await server.get('/mocked-endpoint').thenTimeout();

        let result = await Promise.race<any>([
            fetch(server.urlFor('/mocked-endpoint')),
            delay(500).then(() => 'timed out')
        ])

        expect(result).to.equal('timed out');
    });

    nodeOnly(() => {
        it("should allow mocking body as json with callback", async () => {
            await server.get("/mocked-endpoint").thenCallback((req) => {
                return { status: 200, json: { myVar: "foo" } }
            });

            let response = await fetch(server.urlFor("/mocked-endpoint"));

            expect(await response.status).to.equal(200);
            expect(await response.json()).to.deep.equal({myVar: "foo"});
        });

        it("should return a 500 if a callback handler throws an exception", async () => {
            await server.get("/mocked-endpoint").thenCallback((req) => {
                throw new Error('Oh no!');
            });

            let response = await fetch(server.urlFor("/mocked-endpoint"));

            expect(await response.status).to.equal(500);
        });
    });
});

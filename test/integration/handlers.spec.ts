import * as semver from 'semver';
import { PassThrough } from 'stream';
import { getLocal } from "../..";
import { expect, fetch, isNode, delay } from "../test-utils";

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

    it("should allow mocking the status code, body & headers", async () => {
        await server.get("/mocked-endpoint").thenReply(200, "mocked data", {
            "Content-Type": "text/mocked"
        });

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(await response.headers.get("Content-Type")).to.equal("text/mocked");
    });

    it("should allow mocking a binary body with a buffer", async () => {
        await server.get("/mocked-endpoint").thenReply(200, new Buffer([72, 105]));

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(await response.text()).to.equal('Hi');
    });


    it("should reply with JSON when using the JSON helper", async () => {
        await server.get('/mocked-endpoint').thenJson(200, {myVar: 'foo'},
            { 'other-header': 'header-data' });

        let response = await fetch(server.urlFor('/mocked-endpoint'));

        expect(await response.status).to.equal(200);
        expect(await response.json()).to.deep.equal({myVar: 'foo'});
    });

    it("should reply with JSON when using the deprecated JSON helper alias", async () => {
        await server.get('/mocked-endpoint').thenJSON(200, {myVar: 'foo'},
            { 'other-header': 'header-data' });

        let response = await fetch(server.urlFor('/mocked-endpoint'));

        expect(await response.status).to.equal(200);
        expect(await response.json()).to.deep.equal({myVar: 'foo'});
    });

    it("should allow streaming a response", async () => {
        let stream = new PassThrough();
        await server.get('/stream').thenStream(200, stream);

        stream.write('Hello\n');

        let responsePromise = fetch(server.urlFor('/stream'));

        await delay(100);
        stream.write(Buffer.from('world'));

        if (!process.version || semver.major(process.version) >= 8) {
            let arrayBuffer = new Uint8Array(1);
            arrayBuffer[0] = '!'.charCodeAt(0);
            stream.write(arrayBuffer);
        } else {
            // Node < 8 doesn't support streaming array buffers
            stream.write('!');
        }
        stream.end();

        await expect(responsePromise).to.have.status(200);
        await expect(responsePromise).to.have.responseText('Hello\nworld!');
    });

    it("should fail clearly when trying to repeat a single stream response", async () => {
        let stream = new PassThrough();
        await server.get('/stream').thenStream(200, stream);

        stream.end('Hello world');

        await fetch(server.urlFor('/stream'));
        let responsePromise = await fetch(server.urlFor('/stream'));

        await expect(responsePromise).to.have.status(500);
        expect(await responsePromise.text()).to.include('Stream request handler called more than once');
    });

    it("should allow multiple streaming responses", async () => {
        let stream1 = new PassThrough();
        await server.get('/stream').thenStream(200, stream1);
        let stream2 = new PassThrough();
        await server.get('/stream').thenStream(200, stream2);

        stream1.end('Hello');
        stream2.end('World');

        let response1 = await fetch(server.urlFor('/stream'));
        let response2 = await fetch(server.urlFor('/stream'));

        await expect(response1).to.have.status(200);
        await expect(response1).to.have.responseText('Hello');
        await expect(response2).to.have.status(200);
        await expect(response2).to.have.responseText('World');
    });

    it("should allow forcibly closing the connection", async () => {
        await server.get('/mocked-endpoint').thenCloseConnection();

        let result = await fetch(server.urlFor('/mocked-endpoint')).catch(e => e);

        expect(result).to.be.instanceof(Error);
        expect(result.message).to.contain(isNode() ? 'socket hang up' : 'Failed to fetch');
    });

    it("should allow leaving connections to time out", async () => {
        await server.get('/mocked-endpoint').thenTimeout();

        let result = await Promise.race<any>([
            fetch(server.urlFor('/mocked-endpoint')),
            delay(500).then(() => 'timed out')
        ])

        expect(result).to.equal('timed out');
    });

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

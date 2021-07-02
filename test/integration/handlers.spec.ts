import * as semver from 'semver';
import * as path from 'path';
import { PassThrough } from 'stream';
import { getLocal } from "../..";
import { expect, fetch, isNode, isWeb, delay, headersToObject } from "../test-utils";

describe("HTTP mock rule handling", function () {
    let server = getLocal({
        cors: isNode
            ? false
            : { exposedHeaders: '*' }
    });

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

    it("should set default headers when none are provided", async () => {
        await server.get("/mocked-endpoint").thenReply(200, "mocked data");

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(await response.text()).to.equal("mocked data");
        expect(response.headers.get('Date')).to.match(/^\w+, \d+ \w+ \d+ \d\d:\d\d:\d\d \w+$/);
        expect(response.headers.get('Transfer-Encoding')).to.equal('chunked');
    });

    it("should allow mocking the status code, body & headers", async () => {
        await server.get("/mocked-endpoint").thenReply(200, "mock body", {
            "Content-Type": "text/mocked"
        });

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(response.status).to.equal(200);
        expect(response.statusText).to.equal('OK');
        expect(await response.text()).to.equal('mock body');
        expect(response.headers.get("Content-Type")).to.equal("text/mocked");

        // Defaults are not set when headers are explicitly provided:
        expect(response.headers.get("Date")).to.equal(null);
        expect(response.headers.get("Content-Length")).to.equal(null);
    });

    it("should allow mocking the status code, status message, body & headers", async () => {
        await server.get("/mocked-endpoint").thenReply(200, "mock status", "mock body", {
            "Content-Type": "text/mocked"
        });

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(response.status).to.equal(200);
        expect(response.statusText).to.equal('mock status');
        expect(await response.text()).to.equal('mock body');
        expect(response.headers.get("Content-Type")).to.equal("text/mocked");

        // Defaults are not set when headers are explicitly provided:
        expect(response.headers.get("Date")).to.equal(null);
        expect(response.headers.get('Content-Length')).to.equal(null);
        expect(response.headers.get('Transfer-Encoding')).to.equal(null);
    });

    it("should not allow mocking HTTP/2 pseudoheaders", async function () {
        await expect(() =>
            server.get("/mocked-endpoint")
            .thenReply(200, "mock status", "mock body", {
                ":status": '200'
            })
        ).to.throw("Cannot set custom :status pseudoheader values");
    });

    it("should allow mocking a binary body with a buffer", async () => {
        await server.get("/mocked-endpoint").thenReply(200, Buffer.from([72, 105]));

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(await response.text()).to.equal('Hi');
    });

    it("should allow mocking a very large body", async function () {
        this.timeout(10000); // In a browser, this can be slowwww

        const bodyBuffer = Buffer.alloc(1024 * 1024 * 10, 'A'.charCodeAt(0));
        await server.get("/mocked-endpoint").thenReply(200, bodyBuffer);

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        const responseText = await response.text();
        expect(responseText.length).to.equal(1024 * 1024 * 10);
        expect(responseText.startsWith('AAAAAAAAAAAA')).to.equal(true);
        expect(responseText.endsWith('AAAAAAAAAAAA')).to.equal(true);
    });

    it("should reply with JSON when using the JSON helper", async () => {
        await server.get('/mocked-endpoint').thenJson(200, { myVar: 'foo' });

        let response = await fetch(server.urlFor('/mocked-endpoint'));

        expect(response.status).to.equal(200);
        expect(response.statusText).to.equal('OK');
        expect(response.headers.get('Content-Type')).to.equal('application/json');
        expect(response.headers.get('Content-Length')).to.equal('15');
        expect(await response.json()).to.deep.equal({"myVar":"foo"});
    });

    it("should successfully reply with JSON using the JSON helper with unicode content", async () => {
        await server.get('/mocked-endpoint').thenJson(200, { myVar: '🐶' });

        let response = await fetch(server.urlFor('/mocked-endpoint'));

        expect(response.status).to.equal(200);
        expect(response.statusText).to.equal('OK');
        expect(response.headers.get('Content-Type')).to.equal('application/json');
        expect(response.headers.get('Content-Length')).to.equal('16');
        expect(await response.json()).to.deep.equal({"myVar":"🐶"});
    });

    it("should reply with JSON and merge in extra headers when using the JSON helper", async () => {
        await server.get('/mocked-endpoint').thenJson(200, { myVar: 'foo' },
            { 'other-header': 'header-data' }
        );

        let response = await fetch(server.urlFor('/mocked-endpoint'));

        expect(response.status).to.equal(200);
        expect(response.statusText).to.equal('OK');
        expect(response.headers.get('Other-Header')).to.equal('header-data');
        expect(response.headers.get('Content-Type')).to.equal('application/json');
        expect(response.headers.get('Content-Length')).to.equal('15');
        expect(await response.json()).to.deep.equal({"myVar":"foo"});
    });

    it("should reply with JSON when using the deprecated JSON helper alias", async () => {
        await server.get('/mocked-endpoint').thenJSON(200, { myVar: 'foo' },
            { 'other-header': 'header-data' });

        let response = await fetch(server.urlFor('/mocked-endpoint'));

        expect(response.status).to.equal(200);
        expect(response.statusText).to.equal('OK');
        expect(response.headers.get('Content-Type')).to.equal('application/json');
        expect(response.headers.get('Content-Length')).to.equal('15');
        expect(await response.json()).to.deep.equal({"myVar":"foo"});
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

    it("should not allow setting pseudoheaders when streaming a response", async () => {
        let stream = new PassThrough();
        expect(() =>
            server.get('/stream').thenStream(200, stream, {
                ':status': '200'
            })
        ).to.throw("Cannot set custom :status pseudoheader values");
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
        expect(result.message).to.contain(isNode ? 'socket hang up' : 'Failed to fetch');
    });

    it("should allow leaving connections to time out", async () => {
        await server.get('/mocked-endpoint').thenTimeout();

        let result = await Promise.race<any>([
            fetch(server.urlFor('/mocked-endpoint')),
            delay(500).then(() => 'timed out')
        ])

        expect(result).to.equal('timed out');
    });

    it("should allow mocking the status with a callback", async () => {
        await server.get("/mocked-endpoint").thenCallback(() => {
            return { statusCode: 204, statusMessage: 'all good' }
        });

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(response.status).to.equal(204);
        expect(response.statusText).to.equal('all good');
        expect(await response.text()).to.equal("");

        // No headers => defaults set:
        expect(response.headers.get('Date')).to.match(/^\w+, \d+ \w+ \d+ \d\d:\d\d:\d\d \w+$/);
    });

    it("should allow mocking the response body with a callback", async () => {
        await server.get("/mocked-endpoint").thenCallback(() => {
            return { statusCode: 200, body: 'response body' }
        });

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(response.status).to.equal(200);
        expect(await response.text()).to.equal("response body");

        // No headers => defaults set:
        expect(response.headers.get('Date')).to.match(/^\w+, \d+ \w+ \d+ \d\d:\d\d:\d\d \w+$/);
    });

    it("should allow mocking response headers with a callback", async () => {
        await server.get("/mocked-endpoint").thenCallback(() => {
            return { statusCode: 200, headers: { 'mock-header': 'set' } }
        });

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(response.status).to.equal(200);
        expect(headersToObject(response.headers)).to.deep.equal({
            'mock-header': 'set',
            ...(isWeb ? {
                'access-control-allow-origin': '*',
                'access-control-expose-headers': '*'
            } : {})
            // No Date header, because we're manually managing the headers
        });
    });

    it("should not allow mocking response pseudoheaders with a callback", async () => {
        await server.get("/mocked-endpoint").thenCallback(() => {
            return { statusCode: 200, headers: { ':status': '200' } }
        })

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(response.status).to.equal(500);
        expect(await response.text()).to.equal("Error: Cannot set custom :status pseudoheader values");
    });

    it("should allow mocking body as json with callback", async () => {
        await server.get("/mocked-endpoint").thenCallback(() => {
            return { statusCode: 201, statusMessage: 'all good', json: { myVar: "foo" } }
        });

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(response.status).to.equal(201);
        expect(response.statusText).to.equal('all good');
        expect(response.headers.get('Date')).to.equal(null); // JSON headers => no defaults
        expect(await response.json()).to.deep.equal({myVar: "foo"});
    });

    it("should allow closing connections with a callback", async () => {
        await server.get("/mocked-endpoint").thenCallback(() => {
            return 'close';
        });

        let response: Response | Error = await fetch(server.urlFor('/mocked-endpoint'))
            .catch((e) => e);

        expect(response).to.be.instanceOf(Error);
        if (isNode) {
            expect((response as any).code).to.equal('ECONNRESET');
        } else {
            expect((response as Error).message).to.include('Failed to fetch');
        }
    });

    it("should return a 500 if a callback handler throws an exception", async () => {
        await server.get("/mocked-endpoint").thenCallback(() => {
            throw new Error('Oh no!');
        });

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(response.status).to.equal(500);
    });

    it("should allow mocking the body with contents from a file", async () => {
        await server.get('/mocked-endpoint').thenFromFile(200,
            path.join(__dirname, '..', 'fixtures', 'response-file.txt')
        );

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(response.status).to.equal(200);
        expect(response.headers.get('Transfer-Encoding')).to.equal('chunked');
        expect(response.headers.get('Date')).to.match(/^\w+, \d+ \w+ \d+ \d\d:\d\d:\d\d \w+$/);
        expect(await response.text()).to.equal('Response from text file');
    });

    it("should allow mocking the body with contents from a file, with headers & status message", async () => {
        await server.get('/mocked-endpoint').thenFromFile(200, "mock status",
            path.join(__dirname, '..', 'fixtures', 'response-file.txt'),
            { "Content-Type": "text/mocked" }
        );

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(response.status).to.equal(200);
        expect(response.statusText).to.equal("mock status");
        expect(response.headers.get('Content-Type')).to.equal('text/mocked');
        expect(await response.text()).to.equal('Response from text file');

        // Default headers aren't set if you pass explicit headers:
        expect(response.headers.get('Date')).to.equal(null);
        expect(response.headers.get('Transfer-Encoding')).to.equal(null);
        expect(response.headers.get('Content-Length')).to.equal(null);
    });

    it("should not allow setting pseudoheaders when mocking the body from a file", async () => {
        expect(() =>
            server.get('/mocked-endpoint').thenFromFile(200, "mock status",
                path.join(__dirname, '..', 'fixtures', 'response-file.txt'),
                { ':status': '200' }
            )
        ).to.throw("Cannot set custom :status pseudoheader values");
    });

    it("should return a clear error when mocking the body with contents from a non-existent file", async () => {
        await server.get('/mocked-endpoint').thenFromFile(200,
            path.join(__dirname, '..', 'fixtures', 'non-existent-file.txt')
        );

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(response.status).to.equal(500);
        expect(await response.text()).to.include('no such file or directory');
    });
});

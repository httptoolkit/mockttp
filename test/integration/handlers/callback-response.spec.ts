import * as zlib from 'zlib';
import { getLocal } from "../../..";
import { expect, fetch, isNode, isWeb, headersToObject } from "../../test-utils";

describe("Callback response handlers", function () {

    let server = getLocal({
        cors: isNode
            ? false
            : { exposedHeaders: '*' }
    });

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should allow mocking the status with a callback", async () => {
        await server.forGet("/mocked-endpoint").thenCallback(() => {
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
        await server.forGet("/mocked-endpoint").thenCallback(() => {
            return { statusCode: 200, body: 'response body' }
        });

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(response.status).to.equal(200);
        expect(await response.text()).to.equal("response body");

        // No headers => defaults set:
        expect(response.headers.get('Date')).to.match(/^\w+, \d+ \w+ \d+ \d\d:\d\d:\d\d \w+$/);
    });

    it("should allow mocking response headers with a callback", async () => {
        await server.forGet("/mocked-endpoint").thenCallback(() => {
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
        await server.forGet("/mocked-endpoint").thenCallback(() => {
            return { statusCode: 200, headers: { ':status': '200' } }
        })

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(response.status).to.equal(500);
        expect(await response.text()).to.equal("Error: Cannot set custom :status pseudoheader values");
    });

    it("should allow mocking body as json with callback", async () => {
        await server.forGet("/mocked-endpoint").thenCallback(() => ({
            statusCode: 201,
            statusMessage: 'all good',
            json: { myVar: "foo" }
        }));

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(response.status).to.equal(201);
        expect(response.statusText).to.equal('all good');
        expect(response.headers.get('Date')).to.equal(null); // JSON headers => no defaults
        expect(await response.json()).to.deep.equal({myVar: "foo"});
    });

    it("should automatically encode response body data from a callback", async () => {
        await server.forGet("/mocked-endpoint").thenCallback(() => ({
            statusCode: 200,
            headers: { 'content-encoding': 'gzip' },
            body: 'response body'
        }));

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(response.status).to.equal(200);
        expect(Object.fromEntries([...response.headers as any])).to.include({
            'content-encoding': 'gzip'
        });
        expect(await response.text()).to.equal("response body");
    });

    it("should allow returning raw encoded response body data from a callback", async () => {
        await server.forGet("/mocked-endpoint").thenCallback(() => {
            return {
                statusCode: 200,
                headers: { 'content-encoding': 'gzip' },
                rawBody: zlib.gzipSync('response body')
            }
        });

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(response.status).to.equal(200);
        expect(Object.fromEntries([...response.headers as any])).to.include({
            'content-encoding': 'gzip'
        });
        expect(await response.text()).to.equal("response body");
    });

    it("should allow closing connections with a callback", async () => {
        await server.forGet("/mocked-endpoint").thenCallback(() => {
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
        await server.forGet("/mocked-endpoint").thenCallback(() => {
            throw new Error('Oh no!');
        });

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(response.status).to.equal(500);
    });

});
import * as http from 'http';

import { getLocal } from "../../..";
import { expect, fetch, isNode, nodeOnly } from "../../test-utils";

describe("Simple fixed response handler", function () {

    let server = getLocal({
        cors: isNode
            ? false
            : { exposedHeaders: '*' }
    });

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should allow mocking the status code alone", async () => {
        await server.forGet("/mocked-endpoint").thenReply(204);

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(await response.status).to.equal(204);
        expect(await response.text()).to.equal("");
    });

    it("should allow mocking the status code & body", async () => {
        await server.forGet("/mocked-endpoint").thenReply(200, "mocked data");

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(await response.text()).to.equal("mocked data");
    });

    it("should set default headers when none are provided", async () => {
        await server.forGet("/mocked-endpoint").thenReply(200, "mocked data");

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(await response.text()).to.equal("mocked data");
        expect(response.headers.get('Date')).to.match(/^\w+, \d+ \w+ \d+ \d\d:\d\d:\d\d \w+$/);
        expect(response.headers.get('Transfer-Encoding')).to.equal('chunked');
    });

    it("should allow mocking the status code, body & headers", async () => {
        await server.forGet("/mocked-endpoint").thenReply(200, "mock body", {
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
        await server.forGet("/mocked-endpoint").thenReply(200, "mock status", "mock body", {
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

    nodeOnly(() => { // Browsers can't read trailers
        it("should allow mocking everything with trailers too", async () => {
            await server.forGet("/mocked-endpoint").thenReply(200, "status message", "body", {
                "header": "hello",
                "Transfer-Encoding": "chunked" // Required to send trailers
            }, {
                "trailer": "goodbye"
            });

            const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
                const req = http.request(server.urlFor("/mocked-endpoint")).end();
                req.on('response', (res) => {
                    // Wait until everything is 100% done, so we definitely have trailers
                    res.resume();
                    res.on('end', () => resolve(res));
                });
                req.on('error', reject);
            });

            expect(response.statusCode).to.equal(200);
            expect(response.statusMessage).to.equal('status message');
            expect(response.headers).to.deep.equal({
                'header': 'hello',
                'transfer-encoding': 'chunked'
            });
            expect(response.trailers).to.deep.equal({
                'trailer': 'goodbye'
            });
        });
    });

    it("should not allow mocking HTTP/2 pseudoheaders", async function () {
        await expect(() =>
            server.forGet("/mocked-endpoint")
            .thenReply(200, "mock status", "mock body", {
                ":status": '200'
            })
        ).to.throw("Cannot set custom :status pseudoheader values");
    });

    it("should allow mocking a binary body with a buffer", async () => {
        await server.forGet("/mocked-endpoint").thenReply(200, Buffer.from([72, 105]));

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(await response.text()).to.equal('Hi');
    });

    it("should allow mocking a very large body", async function () {
        this.timeout(10000); // In a browser, this can be slowwww

        const bodyBuffer = Buffer.alloc(1024 * 1024 * 10, 'A'.charCodeAt(0));
        await server.forGet("/mocked-endpoint").thenReply(200, bodyBuffer);

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        const responseText = await response.text();
        expect(responseText.length).to.equal(1024 * 1024 * 10);
        expect(responseText.startsWith('AAAAAAAAAAAA')).to.equal(true);
        expect(responseText.endsWith('AAAAAAAAAAAA')).to.equal(true);
    });

});
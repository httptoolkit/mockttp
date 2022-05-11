import * as path from 'path';
import { getLocal } from "../../..";
import { expect, fetch, isNode } from "../../test-utils";

describe("HTTP mock rule handling", function () {

    let server = getLocal({
        cors: isNode
            ? false
            : { exposedHeaders: '*' }
    });

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should allow mocking the body with contents from a file", async () => {
        await server.forGet('/mocked-endpoint').thenFromFile(200,
            path.join(__dirname, '..', '..', 'fixtures', 'response-file.txt')
        );

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(response.status).to.equal(200);
        expect(response.headers.get('Transfer-Encoding')).to.equal('chunked');
        expect(response.headers.get('Date')).to.match(/^\w+, \d+ \w+ \d+ \d\d:\d\d:\d\d \w+$/);
        expect(await response.text()).to.equal('Response from text file');
    });

    it("should allow mocking the body with contents from a file, with headers & status message", async () => {
        await server.forGet('/mocked-endpoint').thenFromFile(200, "mock status",
            path.join(__dirname, '..', '..', 'fixtures', 'response-file.txt'),
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
            server.forGet('/mocked-endpoint').thenFromFile(200, "mock status",
                path.join(__dirname, '..', '..', 'fixtures', 'response-file.txt'),
                { ':status': '200' }
            )
        ).to.throw("Cannot set custom :status pseudoheader values");
    });

    it("should return a clear error when mocking the body with contents from a non-existent file", async () => {
        await server.forGet('/mocked-endpoint').thenFromFile(200,
            path.join(__dirname, 'non-existent-file.txt')
        );

        let response = await fetch(server.urlFor("/mocked-endpoint"));

        expect(response.status).to.equal(500);
        expect(await response.text()).to.include('no such file or directory');
    });
});

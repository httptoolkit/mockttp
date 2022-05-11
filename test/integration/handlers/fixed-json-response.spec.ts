import { getLocal } from "../../..";
import { expect, fetch, isNode } from "../../test-utils";

describe("Fixed JSON response handler", function () {

    let server = getLocal({
        cors: isNode
            ? false
            : { exposedHeaders: '*' }
    });

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should reply with JSON when using the JSON helper", async () => {
        await server.forGet('/mocked-endpoint').thenJson(200, { myVar: 'foo' });

        let response = await fetch(server.urlFor('/mocked-endpoint'));

        expect(response.status).to.equal(200);
        expect(response.statusText).to.equal('OK');
        expect(response.headers.get('Content-Type')).to.equal('application/json');
        expect(response.headers.get('Content-Length')).to.equal('15');
        expect(await response.json()).to.deep.equal({"myVar":"foo"});
    });

    it("should successfully reply with JSON using the JSON helper with unicode content", async () => {
        await server.forGet('/mocked-endpoint').thenJson(200, { myVar: '🐶' });

        let response = await fetch(server.urlFor('/mocked-endpoint'));

        expect(response.status).to.equal(200);
        expect(response.statusText).to.equal('OK');
        expect(response.headers.get('Content-Type')).to.equal('application/json');
        expect(response.headers.get('Content-Length')).to.equal('16');
        expect(await response.json()).to.deep.equal({"myVar":"🐶"});
    });

    it("should reply with JSON and merge in extra headers when using the JSON helper", async () => {
        await server.forGet('/mocked-endpoint').thenJson(200, { myVar: 'foo' },
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

});
import { getLocal, matchers, handlers, completionCheckers } from "../..";
import { expect, fetch } from "../test-utils";
import * as _ from "lodash";

describe("Mockttp rule building", function () {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should allow manually adding a single rule", async () => {
        await server.addRules({
            matchers: [new matchers.SimplePathMatcherData('/endpoint')],
            handler: new handlers.SimpleHandlerData(200, 'mock response'),
        });

        let response = await fetch(server.urlFor('/endpoint'));
        let responseText = await response.text();

        expect(responseText).to.include('mock response');
    });

    it("should allow repeatedly adding rules", async () => {
        await server.addRules({
            matchers: [new matchers.SimplePathMatcherData('/endpoint')],
            handler: new handlers.SimpleHandlerData(200, 'first mock response'),
        });
        await server.addRules({
            matchers: [new matchers.SimplePathMatcherData('/endpoint')],
            handler: new handlers.SimpleHandlerData(200, 'second mock response'),
        });

        let firstResponse = await fetch(server.urlFor('/endpoint'));
        let firstResponseText = await firstResponse.text();
        let secondResponse = await fetch(server.urlFor('/endpoint'));
        let secondResponseText = await secondResponse.text();

        expect(firstResponseText).to.include('first mock response');
        expect(secondResponseText).to.include('second mock response');
    });

    it("should allow completely replacing rules", async () => {
        await server.addRules({
            matchers: [new matchers.SimplePathMatcherData('/endpoint')],
            handler: new handlers.SimpleHandlerData(200, 'original mock response')
        });
        await server.setRules({
            matchers: [new matchers.SimplePathMatcherData('/endpoint')],
            handler: new handlers.SimpleHandlerData(200, 'replacement mock response')
        });

        let firstResponse = await fetch(server.urlFor('/endpoint'));
        let firstResponseText = await firstResponse.text();

        expect(firstResponseText).to.include('replacement mock response');
    });
});
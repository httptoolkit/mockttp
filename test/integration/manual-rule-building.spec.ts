import * as _ from "lodash";
import * as WebSocket from 'isomorphic-ws';

import { getLocal, matchers, handlers, wsHandlers } from "../..";
import { expect, fetch } from "../test-utils";

describe("Mockttp rule building", function () {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should allow manually adding a single rule", async () => {
        await server.addRules({
            matchers: [new matchers.SimplePathMatcher('/endpoint')],
            handler: new handlers.SimpleHandler(200, '', 'mock response'),
        });

        let response = await fetch(server.urlFor('/endpoint'));
        let responseText = await response.text();

        expect(responseText).to.include('mock response');
    });

    it("should allow manually setting a rule id", async () => {
        const manualId = _.uniqueId();

        const rule = await server.addRules({
            id: manualId,
            matchers: [new matchers.SimplePathMatcher('/endpoint')],
            handler: new handlers.SimpleHandler(200, '', 'mock response'),
        });

        expect(rule[0].id).to.equal(manualId);
    });

    it("should allow repeatedly adding rules", async () => {
        await server.addRules({
            matchers: [new matchers.SimplePathMatcher('/endpoint')],
            handler: new handlers.SimpleHandler(200, '', 'first mock response'),
        });
        await server.addRules({
            matchers: [new matchers.SimplePathMatcher('/endpoint')],
            handler: new handlers.SimpleHandler(200, '', 'second mock response'),
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
            matchers: [new matchers.SimplePathMatcher('/endpoint')],
            handler: new handlers.SimpleHandler(200, '',  'original mock response')
        });
        await server.setRules({
            matchers: [new matchers.SimplePathMatcher('/endpoint')],
            handler: new handlers.SimpleHandler(200, '', 'replacement mock response')
        });

        let firstResponse = await fetch(server.urlFor('/endpoint'));
        let firstResponseText = await firstResponse.text();

        expect(firstResponseText).to.include('replacement mock response');
    });

    it("should allow adding websocket rules", async () => {
        await server.addWsRules({
            matchers: [new matchers.WildcardMatcher()],
            handler: new wsHandlers.PassThroughWebSocketHandler({
                forwarding: {
                    targetHost: 'wss://echo.websocket.org'
                }
            })
        });

        const ws = new WebSocket(server.url.replace('http', 'ws'));

        ws.addEventListener('open', () => ws.send('test echo'));

        const response = await new Promise((resolve, reject) => {
            ws.addEventListener('message', (evt) => resolve(evt.data));
            ws.addEventListener('error', (e) => reject(e));
        });
        ws.close(1000);

        expect(response).to.equal('test echo');
    });

    it("should reject rules with no configured matchers", async () => {
        return expect((async () => { // Funky setup to handle sync & async failure for node & browser
            await server.addRules({
                matchers: [],
                handler: new handlers.SimpleHandler(200, 'mock response'),
            })
        })()).to.be.rejectedWith('Cannot create a rule without at least one matcher');
    });

    it("should reject rules with no configured handler", async () => {
        return expect((async () => { // Funky setup to handle sync & async failure for node & browser
            await server.addRules({
                matchers: [new matchers.SimplePathMatcher('/')],
                handler: <any> null
            })
        })()).to.be.rejectedWith('Cannot create a rule with no handler');
    });
});
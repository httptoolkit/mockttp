import * as _ from 'lodash';
import * as WebSocket from 'isomorphic-ws';

import {
    getLocal,
    RawHeaders,
    RuleEvent
} from "../../..";
import {
    delay,
    expect,
    fetch,
    isNode
} from "../../test-utils";

describe("Rule event susbcriptions", () => {

    const server = getLocal();
    const remoteServer = getLocal();

    beforeEach(() => Promise.all([
        server.start(),
        remoteServer.start()
    ]));

    afterEach(() => Promise.all([
        server.stop(),
        remoteServer.stop()
    ]));

    it("should fire for proxied requests", async () => {
        await remoteServer.forAnyRequest().thenReply(200, 'Original response body');
        const forwardingRule = await server.forAnyRequest().thenForwardTo(remoteServer.url);

        const ruleEvents: RuleEvent<any>[] = [];
        await server.on('rule-event', (e) => ruleEvents.push(e));

        const response = await fetch(server.url);
        expect(response.status).to.equal(200);

        await delay(100);

        expect(ruleEvents.length).to.equal(4);

        const requestId = (await forwardingRule.getSeenRequests())[0].id;
        ruleEvents.forEach((event) => {
            expect(event.ruleId).to.equal(forwardingRule.id);
            expect(event.requestId).to.equal(requestId);
        });

        expect(ruleEvents.map(e => e.eventType)).to.deep.equal([
            'passthrough-request-head',
            'passthrough-request-body',
            'passthrough-response-head',
            'passthrough-response-body'
        ]);

        const requestHeadEvent = ruleEvents[0].eventData;
        expect(_.omit(requestHeadEvent, 'rawHeaders')).to.deep.equal({
            method: 'GET',
            protocol: 'http',
            hostname: 'localhost',
            // This reports the *modified* port, not the original:
            port: remoteServer.port.toString(),
            path: '/'
        });
        expect(requestHeadEvent.rawHeaders).to.deep.include([
            // This reports the *modified* header, not the original:
            'Host', `localhost:${remoteServer.port}`
        ]);

        const requestBodyEvent = ruleEvents[1].eventData;
        expect(requestBodyEvent).to.deep.equal({ overridden: false });

        const responseHeadEvent = ruleEvents[2].eventData;
        expect(_.omit(responseHeadEvent, 'rawHeaders')).to.deep.equal({
            statusCode: 200,
            statusMessage: 'OK',
            httpVersion: '1.1'
        });
        expect(responseHeadEvent.rawHeaders).to.deep.include(['Transfer-Encoding', 'chunked']);

        const responseBodyEvent = ruleEvents[3].eventData;
        expect(responseBodyEvent).to.deep.equal({ overridden: false });
    });

    it("should include upstream-perspective (= modified) request bodies", async () => {
        await remoteServer.forAnyRequest().thenReply(200);
        const forwardingRule = await server.forAnyRequest().thenForwardTo(remoteServer.url, {
            beforeRequest: () => {
                return {
                    method: 'POST',
                    body: 'MODIFIED REQUEST BODY'
                };
            }
        });

        const ruleEvents: RuleEvent<any>[] = [];
        await server.on('rule-event', (e) => ruleEvents.push(e));

        const response = await fetch(server.url);
        expect(response.status).to.equal(200);

        await delay(100);

        expect(ruleEvents.length).to.equal(4);

        const requestId = (await forwardingRule.getSeenRequests())[0].id;
        ruleEvents.forEach((event) => {
            expect(event.ruleId).to.equal(forwardingRule.id);
            expect(event.requestId).to.equal(requestId);
        });

        expect(ruleEvents.map(e => e.eventType)).to.deep.equal([
            'passthrough-request-head',
            'passthrough-request-body',
            'passthrough-response-head',
            'passthrough-response-body'
        ]);

        const requestHeadEvent = ruleEvents[0].eventData;
        expect(requestHeadEvent.method).to.equal('POST'); // <-- Modified method

        const requestBodyEvent = ruleEvents[1].eventData;
        expect(requestBodyEvent.overridden).to.equal(true);
        expect(requestBodyEvent.rawBody.toString('utf8')).to.equal('MODIFIED REQUEST BODY');

        const responseBodyEvent = ruleEvents[3].eventData;
        expect(responseBodyEvent).to.deep.equal({ overridden: false });
    });

    it("should include upstream-perspective (= unmodified) response bodies", async () => {
        await remoteServer.forAnyRequest().thenReply(200, 'Original response body');
        const forwardingRule = await server.forAnyRequest().thenForwardTo(remoteServer.url, {
            beforeResponse: () => {
                return {
                    status: 404,
                    body: 'MODIFIED RESPONSE BODY'
                };
            }
        });

        const ruleEvents: RuleEvent<any>[] = [];
        await server.on('rule-event', (e) => ruleEvents.push(e));

        const response = await fetch(server.url);
        expect(response.status).to.equal(404);

        await delay(100);

        expect(ruleEvents.length).to.equal(4);

        const requestId = (await forwardingRule.getSeenRequests())[0].id;
        ruleEvents.forEach((event) => {
            expect(event.ruleId).to.equal(forwardingRule.id);
            expect(event.requestId).to.equal(requestId);
        });

        expect(ruleEvents.map(e => e.eventType)).to.deep.equal([
            'passthrough-request-head',
            'passthrough-request-body',
            'passthrough-response-head',
            'passthrough-response-body'
        ]);

        const responseHeadEvent = ruleEvents[2].eventData;
        expect(responseHeadEvent.statusCode).to.equal(200); // <-- Original status

        const responseBodyEvent = ruleEvents[3].eventData;
        expect(responseBodyEvent.overridden).to.equal(true);
        expect(responseBodyEvent.rawBody.toString('utf8')).to.equal('Original response body');
    });

    it("should fire for proxied websockets", async () => {
        await remoteServer.forAnyWebSocket().thenPassivelyListen();
        const forwardingRule = await server.forAnyWebSocket().thenForwardTo(remoteServer.url);

        const ruleEvents: RuleEvent<any>[] = [];
        await server.on('rule-event', (e) => ruleEvents.push(e));

        const ws = new WebSocket(`ws://localhost:${server.port}`);
        const downstreamWsKey = isNode
            ? (ws as any)._req.getHeaders()['sec-websocket-key']
            : undefined;

        await new Promise<void>((resolve, reject) => {
            ws.addEventListener('open', () => {
                resolve();
                ws.close();
            });
            ws.addEventListener('error', reject);
        });

        await delay(100);

        expect(ruleEvents.length).to.equal(1);

        const requestId = (await forwardingRule.getSeenRequests())[0].id;
        ruleEvents.forEach((event) => {
            expect(event.ruleId).to.equal(forwardingRule.id);
            expect(event.requestId).to.equal(requestId);
        });

        expect(ruleEvents.map(e => e.eventType)).to.deep.equal([
            'passthrough-websocket-connect'
        ]);

        const connectEvent = ruleEvents[0].eventData;
        expect(_.omit(connectEvent, 'rawHeaders')).to.deep.equal({
            method: 'GET',
            protocol: 'http',
            hostname: 'localhost',
            // This reports the *modified* port, not the original:
            port: remoteServer.port.toString(),
            path: '/',
            subprotocols: []
        });

        // This reports the *modified* header, not the original:
        expect(connectEvent.rawHeaders).to.deep.include(['host', `localhost:${remoteServer.port}`]);
        expect(connectEvent.rawHeaders).to.deep.include(['sec-websocket-version', '13']);
        expect(connectEvent.rawHeaders).to.deep.include(['sec-websocket-extensions', 'permessage-deflate; client_max_window_bits']);
        expect(connectEvent.rawHeaders).to.deep.include(['connection', 'Upgrade']);
        expect(connectEvent.rawHeaders).to.deep.include(['upgrade', 'websocket']);

        // Make sure we want to see the upstream WS key, not the downstream one
        const upstreamWsKey = (connectEvent.rawHeaders as RawHeaders)
            .find(([key]) => key.toLowerCase() === 'sec-websocket-key')!;
        expect(upstreamWsKey[1]).to.not.equal(downstreamWsKey);
    });

    // For now, we only support transformation of websocket URLs in forwarding, and nothing
    // else, so initial conn params are the only passthrough data that's useful to expose.

});
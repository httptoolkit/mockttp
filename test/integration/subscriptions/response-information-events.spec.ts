import * as http from 'http';
import * as http2 from 'http2';

import {
    getLocal,
    InformationalResponse
} from "../../..";
import {
    expect,
    nodeOnly,
    getDeferred
} from "../../test-utils";

function postWithExpectContinue(url: string, body = 'hello') {
    return new Promise<void>((resolve, reject) => {
        const req = http.request(url, {
            method: 'POST',
            headers: { 'Expect': '100-continue', 'Content-Length': Buffer.byteLength(body) }
        });
        req.on('continue', () => req.end(body));
        req.on('response', (res) => {
            res.resume();
            res.on('end', () => resolve());
        });
        req.on('error', reject);
    });
}

async function get(url: string) {
    const res = await fetch(url);
    await res.text();
}

nodeOnly(() => {
    describe("Informational response subscriptions", () => {

        describe("for rule-driven 1xx responses", () => {

            const server = getLocal();

            beforeEach(() => server.start());
            afterEach(() => server.stop());

            it("notifies with status, headers, and request id", async () => {
                const seen = getDeferred<InformationalResponse>();
                await server.on('response-information', (info) => seen.resolve(info));

                await server.forGet('/x')
                    .sendInfoResponse(103, { 'link': '</style.css>; rel=preload' })
                    .thenReply(200, 'ok');

                await get(server.urlFor('/x'));

                const event = await seen;
                expect(event.statusCode).to.equal(103);
                expect(event.statusMessage).to.equal('Early Hints');
                expect(event.headers).to.deep.equal({ link: '</style.css>; rel=preload' });
                expect(event.rawHeaders).to.deep.equal([['link', '</style.css>; rel=preload']]);
                expect(event.id).to.be.a('string');
                expect(event.tags).to.deep.equal([]);
                expect(event.timingEvents.startTimestamp).to.be.a('number');
                expect(event.eventTimestamp).to.be.a('number');
                // eventTimestamp uses performance.now() — comparable to startTimestamp
                // (also performance.now()), not startTime (wall-clock ms since epoch).
                expect(event.eventTimestamp).to.be.greaterThanOrEqual(event.timingEvents.startTimestamp);
            });

            it("fires once per informational response", async () => {
                const events: InformationalResponse[] = [];
                await server.on('response-information', (info) => events.push(info));

                await server.forGet('/x')
                    .sendInfoResponse(102)
                    .sendInfoResponse(103, { 'link': '</a>' })
                    .sendInfoResponse(103, { 'link': '</b>' })
                    .thenReply(200, 'ok');

                await get(server.urlFor('/x'));

                expect(events.map(e => e.statusCode)).to.deep.equal([102, 103, 103]);
                expect(events[1].headers.link).to.equal('</a>');
                expect(events[2].headers.link).to.equal('</b>');
                // All three events share the same request id:
                expect(events[0].id).to.equal(events[1].id);
                expect(events[1].id).to.equal(events[2].id);
                // eventTimestamp distinguishes the three (monotonic, may not be strictly
                // greater on very fast machines, so we just check ordering loosely):
                expect(events[0].eventTimestamp).to.be.lessThanOrEqual(events[1].eventTimestamp);
                expect(events[1].eventTimestamp).to.be.lessThanOrEqual(events[2].eventTimestamp);
            });

            it("reports empty statusMessage for HTTP/2 informational responses", async () => {
                const seen = getDeferred<InformationalResponse>();
                await server.on('response-information', (info) => seen.resolve(info));

                await server.forGet('/x')
                    .sendInfoResponse(103, { 'link': '</a>' })
                    .thenReply(200, 'ok');

                const client = http2.connect(server.url);
                const req = client.request({ ':path': '/x' });
                req.resume();
                const reqDone = new Promise<void>((resolve) => req.on('end', resolve));

                const event = await seen;
                expect(event.statusCode).to.equal(103);
                // H2 has no status messages on the wire — match buildInitiatedResponse:
                expect(event.statusMessage).to.equal('');

                await reqDone;
                client.close();
            });

            it("fires for Node's auto 100 Continue on Expect: 100-continue", async () => {
                const seen = getDeferred<InformationalResponse>();
                await server.on('response-information', (info) => seen.resolve(info));

                await server.forPost('/x').thenReply(200, 'ok');

                const reqDone = postWithExpectContinue(server.urlFor('/x'));

                const event = await seen;
                expect(event.statusCode).to.equal(100);
                expect(event.statusMessage).to.equal('Continue');
                expect(event.headers).to.deep.equal({});
                expect(event.rawHeaders).to.deep.equal([]);
                expect(event.id).to.be.a('string');

                await reqDone;
            });

            it("fires for auto 100 Continue over HTTP/2 too", async () => {
                const seen = getDeferred<InformationalResponse>();
                await server.on('response-information', (info) => seen.resolve(info));

                await server.forPost('/x').thenReply(200, 'ok');

                const client = http2.connect(server.url);
                const req = client.request({
                    ':method': 'POST',
                    ':path': '/x',
                    'expect': '100-continue',
                    'content-length': '5'
                });
                req.end('hello');
                req.resume();
                const reqDone = new Promise<void>((resolve) => req.on('end', resolve));

                const event = await seen;
                expect(event.statusCode).to.equal(100);
                // H2 has no status messages on the wire:
                expect(event.statusMessage).to.equal('');

                await reqDone;
                client.close();
            });

            it("fires the auto-100 event after request-initiated, since the request is genuinely received first", async () => {
                const order: string[] = [];
                await server.on('request-initiated', () => order.push('request-initiated'));
                const eventReceived = getDeferred<void>();
                await server.on('response-information', () => {
                    order.push('response-information');
                    eventReceived.resolve();
                });

                await server.forPost('/x').thenReply(200, 'ok');

                const reqDone = postWithExpectContinue(server.urlFor('/x'));

                await eventReceived;
                expect(order).to.deep.equal(['request-initiated', 'response-information']);

                await reqDone;
            });

            it("does not fire when no rule sends a 1xx", async () => {
                const events: InformationalResponse[] = [];
                await server.on('response-information', (info) => events.push(info));

                await server.forGet('/x').thenReply(200, 'ok');

                await get(server.urlFor('/x'));

                expect(events).to.deep.equal([]);
            });
        });

        describe("for passthrough-forwarded 1xx responses", () => {

            const upstream = getLocal();
            const proxy = getLocal();

            beforeEach(async () => {
                await upstream.start();
                await proxy.start();
            });
            afterEach(async () => {
                await proxy.stop();
                await upstream.stop();
            });

            it("fires on the proxy when an upstream 1xx is forwarded", async () => {
                await upstream.forGet('/x')
                    .sendInfoResponse(103, { 'link': '</a>' })
                    .thenReply(200, 'ok');
                await proxy.forGet('/x').thenForwardTo(`http://localhost:${upstream.port}`);

                const proxyEvents: InformationalResponse[] = [];
                await proxy.on('response-information', (info) => proxyEvents.push(info));

                await get(proxy.urlFor('/x'));

                expect(proxyEvents.length).to.equal(1);
                expect(proxyEvents[0].statusCode).to.equal(103);
                expect(proxyEvents[0].headers.link).to.equal('</a>');
            });
        });
    });
});

import * as http from 'http';
import * as stream from 'stream';

import { getLocal, Mockttp, CompletedRequest, MockedEndpoint } from "../../..";
import {
    expect,
    nodeOnly,
    delay,
    nodeSatisfies,
    BROKEN_PEEKED_REQUEST_BACKPRESSURE
} from "../../test-utils";
import { streamToBuffer } from "../../../src/util/buffer-utils";

// Lengths first, so that a truncated body fails clearly, rather than with a huge buffer diff:
const expectSameBody = (actual: Uint8Array, expected: Uint8Array) => {
    expect(actual.length).to.equal(expected.length);
    expect(Buffer.from(actual).equals(expected)).to.equal(true);
};

// Sends a POST through the proxy, writing the body either all at once, or as several chunks
// spread over time. Fails fast if no response arrives.
//
// `agent` reuses a connection across calls, and `waitForUpload` holds the result until the request
// body has been fully sent too, so a stalled upload is detected rather than hidden by an early
// response. Streamed bodies send a small first chunk before the rest, so that a body only exceeds
// a small maxBodySize after the request has been handled.
function sendPost(
    proxy: Mockttp,
    targetUrl: string,
    body: Buffer,
    mode: 'upfront' | 'streamed',
    options: { agent?: http.Agent, waitForUpload?: boolean } = {}
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let uploaded = false;
        let responseBody: string | undefined;
        const finish = () => {
            if (responseBody !== undefined && (uploaded || !options.waitForUpload)) {
                resolve(responseBody);
            }
        };

        const req = http.request({
            host: 'localhost',
            port: proxy.port,
            method: 'POST',
            path: targetUrl,
            agent: options.agent,
            headers: {
                'content-type': 'text/plain',
                'content-length': body.length
            }
        }, (res) => {
            streamToBuffer(res).then((data) => {
                responseBody = data.toString();
                finish();
            }, reject);
        });
        req.on('finish', () => { uploaded = true; finish(); });
        req.on('error', reject);
        req.setTimeout(3000, () => {
            req.destroy(new Error('Timed out waiting for proxied response'));
        });

        if (mode === 'upfront') {
            req.end(body);
        } else {
            (async () => {
                const firstChunk = Math.min(512, body.length);
                req.write(body.subarray(0, firstChunk));
                await delay(20);

                const chunkSize = Math.ceil(body.length / 4);
                for (let i = firstChunk; i < body.length; i += chunkSize) {
                    req.write(body.subarray(i, i + chunkSize));
                    await delay(20);
                }
                req.end();
            })();
        }
    });
}

nodeOnly(() => {
    describe("Passthrough request body streaming", function () {
        this.timeout(10000);

        const SMALL_BODY = Buffer.from('marker: small body content');
        // Patterned, so that lost or reordered data shows up:
        const LARGE_BODY = Buffer.alloc(200 * 1024);
        for (let i = 0; i < LARGE_BODY.length; i++) LARGE_BODY[i] = 65 + (i % 26);
        LARGE_BODY.write('marker: ');

        let target: Mockttp;
        let targetEndpoint: MockedEndpoint;
        let proxy: Mockttp;

        beforeEach(async () => {
            target = getLocal();
            await target.start();
            targetEndpoint = await target.forAnyRequest().thenReply(200);
        });

        afterEach(async () => {
            await proxy?.stop();
            await target.stop();
        });

        const targetUrl = () => target.urlFor('/echo');

        const startProxy = async (options: { maxBodySize?: number } = {}) => {
            proxy = getLocal({ recordTraffic: false, ...options });
            await proxy.start();
            return proxy;
        };

        async function expectProxied(body: Buffer, mode: 'upfront' | 'streamed') {
            await sendPost(proxy, targetUrl(), body, mode);
            const upstreamRequests = await targetEndpoint.getSeenRequests();
            expectSameBody(upstreamRequests[upstreamRequests.length - 1].body.buffer, body);
        }

        const eachBody = (fn: (body: Buffer, mode: 'upfront' | 'streamed') => Promise<void>) => {
            it("with a small upfront body", () => fn(SMALL_BODY, 'upfront'));
            it("with a large streamed body", () => fn(LARGE_BODY, 'streamed'));
        };

        // Large enough that the upload can't complete into OS socket buffers alone:
        const HUGE_BODY = Buffer.alloc(32 * 1024 * 1024, 65);

        // Whether the client manages to send the whole body within the timeout:
        const uploadsCompletely = (body: Buffer, timeout = 3000) => new Promise<boolean>((resolve) => {
            const req = http.request({
                host: 'localhost',
                port: proxy.port,
                method: 'POST',
                path: targetUrl(),
                headers: { 'content-length': body.length }
            });
            req.on('error', () => {});
            req.on('finish', () => { resolve(true); req.destroy(); });
            setTimeout(() => { resolve(false); req.destroy(); }, timeout);
            req.end(body);
        });

        describe("before anything needs the body", () => {
            beforeEach(() => startProxy());

            it("holds back an upload that only a 'request-body-data' listener watches", async function () {
                if (nodeSatisfies(BROKEN_PEEKED_REQUEST_BACKPRESSURE)) this.skip();

                await proxy.on('request-body-data', () => {});
                await proxy.forAnyRequest().delay(1000).thenReply(200);

                // The listener sees the body only as it's actually used, so nothing reads it yet:
                expect(await uploadsCompletely(HUGE_BODY, 500)).to.equal(false);
            });
        });

        describe("with no observers", () => {
            beforeEach(async () => {
                await startProxy();
                await proxy.forAnyRequest().thenPassThrough();
            });

            eachBody((body, mode) => expectProxied(body, mode));
        });

        describe("with a 'request' listener", () => {
            let seen: CompletedRequest[];

            beforeEach(async () => {
                seen = [];
                await startProxy();
                await proxy.on('request', (r) => { seen.push(r); });
                await proxy.forAnyRequest().thenPassThrough();
            });

            eachBody(async (body, mode) => {
                await expectProxied(body, mode);
                await delay(20);
                expect(seen).to.have.length(1);
                expectSameBody(seen[0].body.buffer, body);
            });
        });

        describe("with a 'request-body-data' listener", () => {
            let chunks: Uint8Array[];

            beforeEach(async () => {
                chunks = [];
                await startProxy();
                await proxy.on('request-body-data', (d) => { chunks.push(d.content); });
                await proxy.forAnyRequest().thenPassThrough();
            });

            eachBody(async (body, mode) => {
                await expectProxied(body, mode);
                await delay(50);
                expectSameBody(Buffer.concat(chunks), body);
            });
        });

        describe("with a body matcher", () => {
            beforeEach(async () => {
                await startProxy();
                await proxy.forAnyRequest().withBodyIncluding('marker').thenPassThrough();
            });

            eachBody((body, mode) => expectProxied(body, mode));
        });

        describe("with a request webhook step before passthrough", () => {
            let webhookTarget: Mockttp;
            type WebhookRequestEvent = { eventData: { body: { format: string, data: string } } };
            let webhookBodies: WebhookRequestEvent[];

            beforeEach(async () => {
                webhookBodies = [];
                webhookTarget = getLocal();
                await webhookTarget.start();
                await webhookTarget.forAnyRequest().thenCallback(async (req) => {
                    webhookBodies.push(await req.body.getJson() as WebhookRequestEvent);
                    return { statusCode: 200 };
                });

                await startProxy();
                await proxy.forAnyRequest()
                    .addWebhook(webhookTarget.urlFor('/hook'), ['request'])
                    .thenPassThrough();
            });

            afterEach(() => webhookTarget.stop());

            eachBody(async (body, mode) => {
                await expectProxied(body, mode);
                await delay(50);
                expect(webhookBodies).to.have.length(1);
                const hookBody = webhookBodies[0].eventData.body;
                expect(hookBody.format).to.equal('base64');
                const received = Buffer.from(hookBody.data, 'base64');
                expectSameBody(received, body);
            });
        });

        describe("with a beforeResponse callback", () => {
            let reqBodySeen: Buffer | undefined;

            beforeEach(async () => {
                reqBodySeen = undefined;
                await startProxy();
                await proxy.forAnyRequest().thenPassThrough({
                    beforeResponse: (_res, req) => {
                        reqBodySeen = req.body.buffer;
                    }
                });
            });

            eachBody(async (body, mode) => {
                await expectProxied(body, mode);
                expect(reqBodySeen).to.not.equal(undefined);
                expectSameBody(reqBodySeen!, body);
            });
        });

        describe("with traffic recording enabled", () => {
            let endpoint: MockedEndpoint;

            beforeEach(async () => {
                proxy = getLocal();
                await proxy.start();
                endpoint = await proxy.forAnyRequest().thenPassThrough();
            });

            eachBody(async (body, mode) => {
                await expectProxied(body, mode);
                const seen = await endpoint.getSeenRequests();
                expect(seen).to.have.length(1);
                expectSameBody(seen[0].body.buffer, body);
            });
        });

        describe("with a delay step before passthrough", () => {
            beforeEach(async () => {
                await startProxy();
                await proxy.forAnyRequest().delay(100).thenPassThrough();
            });

            eachBody((body, mode) => expectProxied(body, mode));
        });

        describe("with a waitForRequestBody step before passthrough", () => {
            beforeEach(async () => {
                await startProxy();
                await proxy.forAnyRequest().waitForRequestBody().thenPassThrough();
            });

            eachBody((body, mode) => expectProxied(body, mode));
        });

        describe("with a body larger than maxBodySize", () => {
            let seen: CompletedRequest[];

            beforeEach(async () => {
                seen = [];
                await startProxy({ maxBodySize: 1024 });
            });

            it("proxies the full body with no observers", async () => {
                await proxy.forAnyRequest().thenPassThrough();
                await expectProxied(LARGE_BODY, 'streamed');
            });

            it("proxies the full body with a 'request' listener, which sees an empty body", async () => {
                await proxy.on('request', (r) => { seen.push(r); });
                await proxy.forAnyRequest().thenPassThrough();
                await expectProxied(LARGE_BODY, 'upfront');
                await expectProxied(LARGE_BODY, 'streamed');
                await delay(20);
                expect(seen).to.have.length(2);
                expect(seen[0].body.buffer.length).to.equal(0);
                expect(seen[1].body.buffer.length).to.equal(0);
            });

            it("proxies the full body with a 'request-body-data' listener, which sees the full body", async () => {
                const chunks: Uint8Array[] = [];
                await proxy.on('request-body-data', (d) => { chunks.push(d.content); });
                await proxy.forAnyRequest().thenPassThrough();
                await expectProxied(LARGE_BODY, 'upfront');
                await delay(50);
                expectSameBody(Buffer.concat(chunks), LARGE_BODY);
            });

            it("proxies the full body with a 'request' listener and a delay step", async () => {
                await proxy.on('request', (r) => { seen.push(r); });
                await proxy.forAnyRequest().delay(50).thenPassThrough();
                await expectProxied(LARGE_BODY, 'upfront');
            });

            it("proxies the full body with a request webhook step", async () => {
                const webhookTarget = getLocal();
                await webhookTarget.start();
                await webhookTarget.forAnyRequest().thenReply(200);
                try {
                    await proxy.forAnyRequest()
                        .addWebhook(webhookTarget.urlFor('/hook'), ['request'])
                        .thenPassThrough();
                    await expectProxied(LARGE_BODY, 'upfront');
                } finally {
                    await webhookTarget.stop();
                }
            });

            it("dumps a paused body once a non-streaming rule completes, so the connection can be reused", async () => {
                await proxy.on('request', (r) => { seen.push(r); });
                await proxy.forAnyRequest().thenReply(200, 'mocked');

                const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
                try {
                    expect(await sendPost(proxy, targetUrl(), LARGE_BODY, 'upfront', { agent, waitForUpload: true })).to.equal('mocked');
                    expect(await sendPost(proxy, targetUrl(), LARGE_BODY, 'upfront', { agent, waitForUpload: true })).to.equal('mocked');
                } finally {
                    agent.destroy();
                }

                await delay(20);
                expect(seen).to.have.length(2);
                expect(seen[0].body.buffer.length).to.equal(0);
            });

            it("drops a body that overflows after a non-streaming rule has already responded", async () => {
                await proxy.on('request', (r) => { seen.push(r); });
                await proxy.forAnyRequest().thenReply(200, 'mocked');

                const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
                try {
                    // The response is sent before most of the body has arrived:
                    expect(await sendPost(proxy, targetUrl(), LARGE_BODY, 'streamed', { agent, waitForUpload: true })).to.equal('mocked');
                    expect(await sendPost(proxy, targetUrl(), LARGE_BODY, 'streamed', { agent, waitForUpload: true })).to.equal('mocked');
                } finally {
                    agent.destroy();
                }
            });

            it("keeps forwarding the body when the upstream responds before the body is complete", async () => {
                // The response closes here while the passthrough is still streaming the request
                // body upstream, so resuming the body must not cut that consumer off.
                const earlyTarget = getLocal();
                await earlyTarget.start();
                const earlyEndpoint = await earlyTarget.forAnyRequest().thenReply(200, 'early');

                try {
                    await proxy.on('request', (r) => { seen.push(r); });
                    await proxy.forAnyRequest().thenPassThrough();

                    const result = await sendPost(proxy, earlyTarget.urlFor('/upload'), LARGE_BODY, 'streamed');
                    expect(result).to.equal('early');

                    // getSeenRequests only resolves once the request (and so its body) is complete:
                    const upstreamRequests = await earlyEndpoint.getSeenRequests();
                    expect(upstreamRequests).to.have.length(1);
                    expectSameBody(upstreamRequests[0].body.buffer, LARGE_BODY);
                } finally {
                    await earlyTarget.stop();
                }
            });

            it("fails cleanly when a step needs the whole body but it's too large to keep", async () => {
                // waitForRequestBody asks for the whole body to be captured, and a body past the
                // limit can't be, so the two are simply incompatible: we can't then forward a body
                // we've had to drop. That must fail as a clear error, rather than crash or hang.
                const upstream = getLocal();
                await upstream.start();
                const upstreamEndpoint = await upstream.forAnyRequest().thenReply(200);

                try {
                    await proxy.forAnyRequest().waitForRequestBody().thenPassThrough();

                    const result = await new Promise<{ status: number, body: string }>((resolve, reject) => {
                        const req = http.request({
                            host: 'localhost',
                            port: proxy.port,
                            method: 'POST',
                            path: upstream.urlFor('/upload'),
                            headers: { 'content-length': LARGE_BODY.length }
                        }, (res) => {
                            streamToBuffer(res).then((data) => {
                                resolve({ status: res.statusCode!, body: data.toString() });
                            }, reject);
                        });
                        req.on('error', reject);
                        req.setTimeout(3000, () => req.destroy(new Error('Timed out')));
                        req.end(LARGE_BODY);
                    });

                    expect(result.status).to.equal(500);
                    expect(result.body).to.include('exceeded the maximum size');

                    // We fail before ever going upstream, rather than sending a partial body:
                    expect(await upstreamEndpoint.getSeenRequests()).to.have.length(0);
                } finally {
                    await upstream.stop();
                }
            });

            it("drains the body of a request that's never answered", async () => {
                await proxy.forAnyRequest().thenTimeout();
                expect(await uploadsCompletely(HUGE_BODY)).to.equal(true);
            });

            it("drains the captured body of a request that's never answered", async () => {
                await proxy.on('request', (r) => { seen.push(r); });
                await proxy.forAnyRequest().thenTimeout();
                expect(await uploadsCompletely(HUGE_BODY)).to.equal(true);
            });

            it("drains the captured body while a never-ending stream response is sent", async () => {
                await proxy.on('request', (r) => { seen.push(r); });
                await proxy.forAnyRequest().thenStream(200, new stream.PassThrough());
                expect(await uploadsCompletely(HUGE_BODY)).to.equal(true);
            });

            it("drains the captured body while a callback never completes", async () => {
                await proxy.on('request', (r) => { seen.push(r); });
                await proxy.forAnyRequest().thenCallback(() => new Promise(() => {}));
                expect(await uploadsCompletely(HUGE_BODY)).to.equal(true);
            });

            it("responds directly from beforeRequest on a reusable connection", async () => {
                await proxy.forAnyRequest().thenPassThrough({
                    beforeRequest: () => ({
                        response: { statusCode: 200, headers: { 'content-length': '6' }, body: 'direct' }
                    })
                });

                const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
                try {
                    expect(await sendPost(proxy, targetUrl(), LARGE_BODY, 'upfront', { agent, waitForUpload: true })).to.equal('direct');
                    expect(await sendPost(proxy, targetUrl(), LARGE_BODY, 'streamed', { agent, waitForUpload: true })).to.equal('direct');
                } finally {
                    agent.destroy();
                }
            });
        });

        describe("with a 'rule-event' listener", () => {
            beforeEach(async () => {
                await startProxy();
                await proxy.on('rule-event', () => {});
                await proxy.forAnyRequest().thenPassThrough();
            });

            eachBody((body, mode) => expectProxied(body, mode));
        });
    });
});

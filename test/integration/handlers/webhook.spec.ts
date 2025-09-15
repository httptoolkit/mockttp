import { getLocal } from "../../..";
import { delay, expect, getDeferred, isWeb, nodeOnly } from "../../test-utils";

describe("Webhook handlers", () => {

    const server = getLocal();
    const webhookTarget = getLocal();

    beforeEach(() => Promise.all([
        server.start(),
        webhookTarget.start()
    ]));

    afterEach(() => Promise.all([
        server.stop(),
        webhookTarget.stop()
    ]));

    nodeOnly(() => {
        // Node-only just because browser request headers are hard to control, plentiful and change frequently.

        it("should fire both events if both are enabled explicitly", async () => {
            const resCompleted = getDeferred();
            let resCount = 0;
            webhookTarget.on('response', () => {
                resCount++;
                if (resCount == 2) resCompleted.resolve();
            });

            const webhookEndpoint = await webhookTarget.forPost().thenReply(200);

            const realEndpoint = await server.forAnyRequest()
                .addWebhook(webhookTarget.url)
                .waitForRequestBody()
                .thenReply(
                    404,
                    'Not found I think?',
                    "response body",
                    { 'response-header': 'X', 'trailer': 'response-trailer', 'transfer-encoding': 'chunked' },
                    { 'response-trailer': 'trailer' }
                );

            const response = await fetch(server.urlFor('/test?a=b'), {
                method: 'PUT',
                body: 'Hello',
                headers: { 'Content-Type': 'text/plain', 'request-header': 'Y' }
            });

            expect(response.status).to.equal(404);
            expect(await response.text()).to.equal('response body');

            await resCompleted;

            const realRequestId = (await realEndpoint.getSeenRequests())[0].id;

            const webhookRequests = await webhookEndpoint.getSeenRequests();
            const webhookBodies = await Promise.all(webhookRequests.map(((req) => req.body.getJson())));

            expect(webhookBodies.length).to.equal(2);
            expect(webhookBodies).to.deep.equal([
                {
                    eventType: 'request',
                    eventData: {
                        id: realRequestId,
                        method: 'PUT',
                        url: server.urlFor('/test?a=b'),
                        headers: {
                            'accept': '*/*',
                            'accept-encoding': 'gzip, deflate',
                            'accept-language': '*',
                            'connection': 'keep-alive',
                            'content-type': 'text/plain',
                            'content-length': '5',
                            'host': `localhost:${server.port}`,
                            'request-header': 'Y',
                            'sec-fetch-mode': 'cors',
                            'user-agent': 'node'
                        },
                        trailers: {},
                        body: { format: 'base64', data: Buffer.from('Hello').toString('base64') }
                    }
                },
                {
                    eventType: 'response',
                    eventData: {
                        id: realRequestId,
                        statusCode: 404,
                        statusMessage: 'Not found I think?',
                        headers: { 'response-header': 'X', 'trailer': 'response-trailer', 'transfer-encoding': 'chunked' },
                        body: { format: 'base64', data: Buffer.from('response body').toString('base64') },
                        trailers: { 'response-trailer': 'trailer' }
                    }
                }
            ]);
        });

        it("should fire a request event by itself", async () => {
            const resCompleted = getDeferred();
            let resCount = 0;
            webhookTarget.on('response', () => {
                resCount++;
                if (resCount == 1) resCompleted.resolve();
                if (resCount > 1) throw new Error("Received too many webhook calls");
            });

            const webhookEndpoint = await webhookTarget.forPost().thenReply(200);

            const realEndpoint = await server.forAnyRequest()
                .addWebhook(webhookTarget.url, ['request'])
                .waitForRequestBody()
                .thenReply(
                    404,
                    'Not found I think?',
                    "response body",
                    { 'response-header': 'X', 'trailer': 'response-trailer', 'transfer-encoding': 'chunked' },
                    { 'response-trailer': 'trailer' }
                );

            const response = await fetch(server.urlFor('/test?a=b'), {
                method: 'PUT',
                body: 'Hello',
                headers: { 'Content-Type': 'text/plain', 'request-header': 'Y' }
            });


            expect(response.status).to.equal(404);
            expect(await response.text()).to.equal('response body');

            await resCompleted;

            const webhookRequests = await webhookEndpoint.getSeenRequests();
            const webhookBodies = await Promise.all(webhookRequests.map(((req) => req.body.getJson())));

            const realRequestId = (await realEndpoint.getSeenRequests())[0].id;

            expect(webhookBodies.length).to.equal(1);
            expect(webhookBodies).to.deep.equal([
                {
                    eventType: 'request',
                    eventData: {
                        id: realRequestId,
                        method: 'PUT',
                        url: server.urlFor('/test?a=b'),
                        headers: {
                            'accept': '*/*',
                            'accept-encoding': 'gzip, deflate',
                            'accept-language': '*',
                            'connection': 'keep-alive',
                            'content-type': 'text/plain',
                            'content-length': '5',
                            'host': `localhost:${server.port}`,
                            'request-header': 'Y',
                            'sec-fetch-mode': 'cors',
                            'user-agent': 'node'
                        },
                        trailers: {},
                        body: { format: 'base64', data: Buffer.from('Hello').toString('base64') }
                    }
                }
            ]);
        });
    });

    it("should fire a response event by itself", async () => {
        const resCompleted = getDeferred();
        let resCount = 0;
        webhookTarget.on('response', () => {
            resCount++;
            if (resCount == 1) resCompleted.resolve();
            if (resCount > 1) throw new Error("Received too many webhook calls");
        });

        const webhookEndpoint = await webhookTarget.forPost().thenReply(200);

        const realEndpoint = await server.forAnyRequest()
            .addWebhook(webhookTarget.url, ['response'])
            .waitForRequestBody()
            .thenReply(
                404,
                'Not found I think?',
                "response body",
                { 'response-header': 'X', 'trailer': 'response-trailer', 'transfer-encoding': 'chunked' },
                { 'response-trailer': 'trailer' }
            );

        const response = await fetch(server.urlFor('/test?a=b'), {
            method: 'PUT',
            body: 'Hello',
            headers: { 'Content-Type': 'text/plain', 'request-header': 'Y' }
        });


        expect(response.status).to.equal(404);
        expect(await response.text()).to.equal('response body');

        await resCompleted;

        const webhookRequests = await webhookEndpoint.getSeenRequests();
        const webhookBodies = await Promise.all(webhookRequests.map(((req) => req.body.getJson())));


        const realRequestId = (await realEndpoint.getSeenRequests())[0].id

        expect(webhookBodies.length).to.equal(1);
        expect(webhookBodies).to.deep.equal([{
            eventType: 'response',
            eventData: {
                id: realRequestId,
                statusCode: 404,
                statusMessage: 'Not found I think?',
                headers: {
                    ...(isWeb ? { 'access-control-allow-origin': '*' } : {}),
                    'response-header': 'X',
                    'trailer': 'response-trailer',
                    'transfer-encoding': 'chunked'
                },
                body: { format: 'base64', data: Buffer.from('response body').toString('base64') },
                trailers: { 'response-trailer': 'trailer' }
            }
        }]);
    });

    it("should fire no events if an empty list is provided", async () => {
        webhookTarget.on('response', () => {
            throw new Error("Received unexpected webhook call");
        });

        const webhookEndpoint = await webhookTarget.forPost().thenReply(200);

        await server.forAnyRequest()
            .addWebhook(webhookTarget.url, [])
            .waitForRequestBody()
            .thenReply(
                404,
                'Not found I think?',
                "response body",
                { 'response-header': 'X', 'trailer': 'response-trailer', 'transfer-encoding': 'chunked' },
                { 'response-trailer': 'trailer' }
            );

        const response = await fetch(server.urlFor('/test?a=b'), {
            method: 'PUT',
            body: 'Hello',
            headers: { 'Content-Type': 'text/plain', 'request-header': 'Y' }
        });

        expect(response.status).to.equal(404);
        expect(await response.text()).to.equal('response body');

        await delay(10);

        const webhookRequests = await webhookEndpoint.getSeenRequests();
        expect(webhookRequests.length).to.equal(0);
    });

    it("should support multiple registrations to allow using different URLs", async () => {
        const resCompleted = getDeferred();
        let resCount = 0;
        webhookTarget.on('response', () => {
            resCount++;
            if (resCount == 2) resCompleted.resolve();
            if (resCount > 2) throw new Error("Received too many webhook calls");
        });

        const webhookRequestEndpoint = await webhookTarget.forPost('/request').thenReply(200);
        const webhookResponseEndpoint = await webhookTarget.forPost('/response').thenReply(200);

        await server.forAnyRequest()
            .addWebhook(webhookTarget.urlFor('/request'), ['request'])
            .addWebhook(webhookTarget.urlFor('/response'), ['response'])
            .waitForRequestBody()
            .thenReply(
                404,
                'Not found I think?',
                "response body",
                { 'response-header': 'X', 'trailer': 'response-trailer', 'transfer-encoding': 'chunked' },
                { 'response-trailer': 'trailer' }
            );

        const response = await fetch(server.urlFor('/test?a=b'), {
            method: 'PUT',
            body: 'Hello',
            headers: { 'Content-Type': 'text/plain', 'request-header': 'Y' }
        });

        expect(response.status).to.equal(404);
        expect(await response.text()).to.equal('response body');

        await resCompleted;

        const webhookRequestRequests = await webhookRequestEndpoint.getSeenRequests();
        expect(webhookRequestRequests.length).to.equal(1);

        const webhookResponseRequests = await webhookResponseEndpoint.getSeenRequests();
        expect(webhookResponseRequests.length).to.equal(1);

        const webhookRequestBody = await webhookRequestRequests[0].body.getJson() as any;
        expect(webhookRequestBody.eventType).to.equal('request');

        const webhookResponseBody = await webhookResponseRequests[0].body.getJson() as any;
        expect(webhookResponseBody.eventType).to.equal('response');
    });

    it("should throw given an invalid URL", async () => {
        expect(() => {
            server.forAnyRequest().addWebhook('INVALID URL').thenReply(200);
        }).to.throw('Webhook URL "INVALID URL" must be absolute');
    });

});
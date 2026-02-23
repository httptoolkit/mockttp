import * as WebSocket from 'isomorphic-ws';

import { getLocal } from "../../..";
import { expect, nodeOnly } from "../../test-utils";

describe('Protocol matching', () => {
    let server = getLocal({
        https: {
            keyPath: './test/fixtures/test-ca.key',
            certPath: './test/fixtures/test-ca.pem'
        }
    });

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it('should throw error when build with invalid protocol', () => {
        const builder = server.forGet("/") as any; // Avoid argument type checking.
        expect(() => builder.withProtocol("HTTP")).throw();
        expect(() => builder.withProtocol("http:")).throw();
        expect(() => builder.withProtocol("somethingelse")).throw();
    });

    it("should match requests with the protocol", async () => {
        await server.forGet('/')
        .withProtocol("https")
        .thenReply(200, 'Mocked response');

        let result = await fetch(server.urlFor("/"));

        await expect(result).to.have.responseText('Mocked response');
    });

    it("should reject requests that don't match the protocol", async () => {
        await server.forGet('/')
        .withProtocol("http")
        .thenReply(200, 'Mocked response');

        let result = await fetch(server.urlFor("/"));

        expect(result.status).to.equal(503);
    });

    nodeOnly(() => {
        // This does work in browsers, but we can't test it nicely without proper WS rules,
        // because all we can do is reject by status, and browsers don't expose the status
        // in WS errors so we can't check it.
        it("should match websockets by the correct protocol", async () => {
            await server.forAnyWebSocket().withProtocol("http").thenRejectConnection(400);
            await server.forAnyWebSocket().withProtocol("https").thenRejectConnection(401);
            await server.forAnyWebSocket().withProtocol("ws").thenRejectConnection(402);
            await server.forAnyWebSocket().withProtocol("wss").thenRejectConnection(403);

            const wss = new WebSocket(`wss://localhost:${server.port}`);
            const ws = new WebSocket(`ws://localhost:${server.port}`);

            const [wssResult, wsResult] = await Promise.all([wss, ws].map((websocket) =>
                new Promise<Error>((resolve, reject) => {
                    websocket.on('open', () => reject('opened'));
                    websocket.on('error', (e) => resolve(e));
                })
            ));

            expect(wssResult.message).to.equal('Unexpected server response: 403');
            expect(wsResult.message).to.equal('Unexpected server response: 402');
        });
    });
});

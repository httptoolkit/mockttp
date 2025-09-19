import * as WebSocket from 'ws';

import { getLocal } from "../../..";
import {
    expect,
    fetch,
    nodeOnly
} from "../../test-utils";

describe("Delay steps", function () {

    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should do nothing if delaying for 0ms", async () => {
        await server.forGet('/mocked-endpoint').delay(0).thenReply(200);

        const startTime = Date.now();
        let result = await fetch(server.urlFor('/mocked-endpoint')).catch(e => e);
        expect(await result.status).to.equal(200);
        expect(Date.now() - startTime).to.be.lessThan(100);
    });

    it("should delay if set to a non-zero value", async () => {
        await server.forGet('/mocked-endpoint').delay(100).thenReply(200);

        const startTime = Date.now();
        let result = await fetch(server.urlFor('/mocked-endpoint')).catch(e => e);
        expect(await result.status).to.equal(200);
        expect(Date.now() - startTime).to.be.greaterThanOrEqual(99);
    });

    nodeOnly(() => {
        it("should also delay websocket responses", async () => {
            await server.forAnyWebSocket().delay(100).thenRejectConnection(401);

            const startTime = Date.now();
            const ws = new WebSocket(`ws://localhost:${server.port}`);

            const result = await new Promise<'open' | Error>((resolve) => {
                ws.on('open', () => resolve('open'));
                ws.on('error', (e) => resolve(e));
            });

            expect(result).to.be.instanceOf(Error);
            expect((result as Error).message).to.equal("Unexpected server response: 401");
            ws.close(1000);

            expect(Date.now() - startTime).to.be.greaterThanOrEqual(100);
        });
    });
});
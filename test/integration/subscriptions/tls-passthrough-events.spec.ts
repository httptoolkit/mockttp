import { expect } from "chai";

import { CompletedRequest, getLocal } from "../../..";
import { delay, getDeferred, fetch, isNode } from "../../test-utils";

describe("TLS passthrough subscriptions", () => {

    let server = getLocal({
        https: {
            keyPath: './test/fixtures/test-ca.key',
            certPath: './test/fixtures/test-ca.pem',
            tlsPassthrough: [
                { hostname: 'bypass.localhost' }
            ]
        }
    });

    beforeEach(async () => {
        await server.start();

        // No unexpected errors here please:
        await server.on('tls-client-error', (e) => expect.fail(`TLS error: ${e.failureCause}`));
        await server.on('client-error', (e) => expect.fail(`Client error: ${e.errorCode}`));
    });

    afterEach(() => server.stop());

    it("should fire for TLS sockets that are passed through", async () => {
        const events: any[] = [];
        await server.on('tls-passthrough-opened', (e) => events.push(e));
        await server.on('tls-passthrough-closed', (e) => events.push(e));

        await fetch(`https://bypass.localhost:${server.port}`).catch(() => {});

        await delay(10);

        expect(events.length).to.equal(isNode
            ? 2
            : 4 // Chrome seems to retry closed TLS sockets, so we see this twice.
        );
        const [openEvent, closeEvent] = events;
        expect(openEvent.id).to.equal(closeEvent.id);

        expect(openEvent.hostname).to.equal('bypass.localhost');
        expect(openEvent.upstreamPort).to.equal(443);

        const { tlsMetadata } = openEvent;
        expect(tlsMetadata.sniHostname).to.equal('bypass.localhost');
        expect(tlsMetadata.connectHostname).to.equal(undefined);
        expect(tlsMetadata.connectPort).to.equal(undefined);
        expect(tlsMetadata.clientAlpn).to.deep.equal(isNode
            ? undefined
            : ['h2', 'http/1.1']
        );
        expect(tlsMetadata.ja3Fingerprint.length).to.equal(32);
        expect(tlsMetadata.ja4Fingerprint.length).to.equal(36);
    });

    it("should not fire for TLS sockets are received and handled", async () => {
        await server.on('tls-passthrough-opened', () => expect.fail('Unexpected TLS passthrough opened'));
        await server.on('tls-passthrough-closed', () => expect.fail('Unexpected TLS passthrough closed'));

        await server.forGet('/').thenReply(200);

        const requestPromise = getDeferred<CompletedRequest>();
        server.on('request', (r) => requestPromise.resolve(r));

        await fetch(`https://other.localhost:${server.port}`).catch(() => {});

        const request = await requestPromise;
        expect(request.url).to.equal(`https://other.localhost:${server.port}/`);
    });


});
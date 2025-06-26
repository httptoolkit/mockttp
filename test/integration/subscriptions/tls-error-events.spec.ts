import * as _ from 'lodash';
import HttpsProxyAgent = require('https-proxy-agent');

import {
    getLocal,
    TlsHandshakeFailure,
    ClientError
} from "../../..";
import {
    expect,
    fetch,
    nodeOnly,
    isNode,
    getDeferred,
    delay,
    openRawSocket,
    openRawTlsSocket,
    watchForEvent,
    http2DirectRequest
} from "../../test-utils";

describe("TLS error subscriptions", () => {
    let goodServer = getLocal({
        https: {
            keyPath: './test/fixtures/test-ca.key',
            certPath: './test/fixtures/test-ca.pem'
        }
    });

    let badServer = getLocal({
        https: {
            keyPath: './test/fixtures/untrusted-ca.key',
            certPath: './test/fixtures/untrusted-ca.pem'
        }
    });

    beforeEach(async () => {
        await badServer.start(),
        await goodServer.start()
    });

    const expectNoClientErrors = watchForEvent('client-error', goodServer, badServer);

    afterEach(() => Promise.all([
        badServer.stop(),
        goodServer.stop()
    ]));

    it("should not be sent for successful requests", async () => {
        let seenTlsErrorPromise = getDeferred<TlsHandshakeFailure>();
        await goodServer.on('tls-client-error', (r) => seenTlsErrorPromise.resolve(r));

        await fetch(goodServer.urlFor("/").replace('http:', 'https:'));

        await expect(Promise.race([
            seenTlsErrorPromise,
            delay(100).then(() => { throw new Error('timeout') })
        ])).to.be.rejectedWith('timeout');

        await expectNoClientErrors();
    });

    nodeOnly(() => {
        it("should not be sent for successful HTTP/2 requests", async () => {
            let seenTlsErrorPromise = getDeferred<TlsHandshakeFailure>();
            await goodServer.on('tls-client-error', (r) => seenTlsErrorPromise.resolve(r));

            await http2DirectRequest(goodServer, '/');

            await expect(Promise.race([
                seenTlsErrorPromise,
                delay(100).then(() => { throw new Error('timeout') })
            ])).to.be.rejectedWith('timeout');

            await expectNoClientErrors();
        });
    });

    it("should be sent for requests from clients that reject the certificate initially", async () => {
        let seenTlsErrorPromise = getDeferred<TlsHandshakeFailure>();
        await badServer.on('tls-client-error', (r) => seenTlsErrorPromise.resolve(r));

        await expect(
            fetch(badServer.urlFor("/"))
        ).to.be.rejectedWith(isNode ? /certificate/ : 'Failed to fetch');

        const tlsError = await seenTlsErrorPromise;

        expect(tlsError.failureCause).to.be.oneOf([
            // Depends on specific client behaviour:
            'reset', // Node 12+
            'cert-rejected' // Chrome
        ]);
        expect(tlsError.remoteIpAddress).to.be.oneOf([
            '::ffff:127.0.0.1', // IPv4 localhost
            '::1' // IPv6 localhost
        ]);
        expect(tlsError.remotePort).to.be.greaterThanOrEqual(32768);
        expect(tlsError.tags).to.deep.equal([]);

        expect(tlsError.timingEvents.startTime).to.be.greaterThan(0);
        expect(tlsError.timingEvents.connectTimestamp).to.be.greaterThan(0);
        expect(tlsError.timingEvents.failureTimestamp)
            .to.be.greaterThanOrEqual(tlsError.timingEvents.connectTimestamp);

        expect(tlsError.tlsMetadata.sniHostname).to.equal('localhost');
        expect(tlsError.tlsMetadata.ja3Fingerprint!.length).to.equal(32);
        expect(tlsError.tlsMetadata.ja4Fingerprint!.length).to.equal(36);

        await expectNoClientErrors();
    });

    nodeOnly(() => {
        it("should be sent for requests from clients that reject the certificate for the upstream server", async () => {
            let seenTlsErrorPromise = getDeferred<TlsHandshakeFailure>();
            await badServer.on('tls-client-error', (r) => seenTlsErrorPromise.resolve(r));
            await badServer.forAnyRequest().thenPassThrough();

            await expect(
                fetch(goodServer.urlFor("/"), {
                    // Ignores proxy cert issues by using the proxy via plain HTTP
                    agent: new HttpsProxyAgent({
                        protocol: 'http',
                        host: 'localhost',
                        port: badServer.port
                    })
                } as any)
            ).to.be.rejectedWith(/certificate/);

            const tlsError = await seenTlsErrorPromise;

            expect(tlsError.failureCause).to.be.equal('reset');
            expect(tlsError.remoteIpAddress).to.be.oneOf([
                '::ffff:127.0.0.1', // IPv4 localhost
                '::1' // IPv6 localhost
            ]);
            expect(tlsError.remotePort).to.be.greaterThanOrEqual(32768);

            expect(tlsError.timingEvents.startTime).to.be.greaterThan(0);
            expect(tlsError.timingEvents.connectTimestamp).to.be.greaterThan(0);

            expect(tlsError.timingEvents.tunnelTimestamp)
                .to.be.greaterThan(tlsError.timingEvents.connectTimestamp);
            expect(tlsError.timingEvents.failureTimestamp)
                .to.be.greaterThan(tlsError.timingEvents.tunnelTimestamp!);

            await expectNoClientErrors();
        });

        it("should be sent for requests from TLS clients that reset directly after handshake", async function () {
            const events: any[] = [];
            await goodServer.on('tls-client-error', () => events.push('tls-client-error'));
            await goodServer.on('client-error', () => events.push('client-error'));

            const tcpSocket = await openRawSocket(goodServer)
            await openRawTlsSocket(tcpSocket);
            tcpSocket.resetAndDestroy();

            await delay(50);

            // We see a TLS error (reset like this is a common form of cert rejection) but no client error
            // (no HTTP request has even been attempted):
            expect(events).to.deep.equal(['tls-client-error']);
        });

        it("should not be sent for requests from TLS clients that reset later in the connection", async function () {
            let seenTlsErrorPromise = getDeferred<TlsHandshakeFailure>();
            await goodServer.on('tls-client-error', (r) => seenTlsErrorPromise.resolve(r));

            let seenClientErrorPromise = getDeferred<ClientError>();
            await goodServer.on('client-error', (e) => seenClientErrorPromise.resolve(e));

            const tcpSocket = await openRawSocket(goodServer)
            const tlsSocket = await openRawTlsSocket(tcpSocket);
            tlsSocket.write("GET / HTTP/1.1\r\nHost: hello.world.invalid\r\n"); // Incomplete HTTP request

            // Kill the underlying socket before the request head completes (but after some content is sent):
            setTimeout(() => {
                tcpSocket.resetAndDestroy()
            }, 10);

            const seenTlsError = await Promise.race([
                delay(50).then(() => false),
                seenTlsErrorPromise
            ]);


            // No TLS error, but we do expect a client reset error:
            expect(seenTlsError).to.equal(false);
            expect((await seenClientErrorPromise).errorCode).to.equal('ECONNRESET');
        });

        it("should not be sent for requests from non-TLS clients that reset before sending anything", async () => {
            let seenTlsErrorPromise = getDeferred<TlsHandshakeFailure>();
            await goodServer.on('tls-client-error', (r) => seenTlsErrorPromise.resolve(r));

            const rawSocket = await openRawSocket(goodServer);
            rawSocket.resetAndDestroy(); // Immediate reset without sending any data

            const seenTlsError = await Promise.race([
                delay(50).then(() => false),
                seenTlsErrorPromise
            ]);

            // No TLS error, no client reset error:
            expect(seenTlsError).to.equal(false);
            await expectNoClientErrors();
        });
    });
});

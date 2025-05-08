import * as _ from 'lodash';
import HttpsProxyAgent = require('https-proxy-agent');
import * as semver from 'semver';

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
    writeAndReset,
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

            if (semver.satisfies(process.version, '>=12')) {
                expect(tlsError.timingEvents.tunnelTimestamp)
                    .to.be.greaterThan(tlsError.timingEvents.connectTimestamp);
                expect(tlsError.timingEvents.failureTimestamp)
                    .to.be.greaterThan(tlsError.timingEvents.tunnelTimestamp!);
            } else {
                expect(tlsError.timingEvents.failureTimestamp)
                    .to.be.greaterThan(tlsError.timingEvents.connectTimestamp);
            }

            await expectNoClientErrors();
        });

        it("should not be sent for requests from TLS clients that reset later in the connection", async function () {
            this.retries(3); // Can be slightly unstable, due to the race for RESET

            let seenTlsErrorPromise = getDeferred<TlsHandshakeFailure>();
            await goodServer.on('tls-client-error', (r) => seenTlsErrorPromise.resolve(r));

            let seenClientErrorPromise = getDeferred<ClientError>();
            await goodServer.on('client-error', (e) => seenClientErrorPromise.resolve(e));

            const tlsSocket = await openRawTlsSocket(goodServer);
            writeAndReset(tlsSocket, "GET / HTTP/1.1\r\n\r\n");

            const seenTlsError = await Promise.race([
                delay(100).then(() => false),
                seenTlsErrorPromise
            ]);
            expect(seenTlsError).to.equal(false);

            // No TLS error, but we do expect a client reset error:
            expect((await seenClientErrorPromise).errorCode).to.equal('ECONNRESET');
        });

        it("should not be sent for requests from non-TLS clients that reset before sending anything", async () => {
            let seenTlsErrorPromise = getDeferred<TlsHandshakeFailure>();
            await goodServer.on('tls-client-error', (r) => seenTlsErrorPromise.resolve(r));

            const tlsSocket = await openRawSocket(goodServer);
            writeAndReset(tlsSocket, ""); // Send nothing, just connect & RESET

            const seenTlsError = await Promise.race([
                delay(100).then(() => false),
                seenTlsErrorPromise
            ]);
            expect(seenTlsError).to.equal(false);

            await expectNoClientErrors();
        });
    });
});

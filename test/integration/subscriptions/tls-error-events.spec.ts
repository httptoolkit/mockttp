import * as _ from 'lodash';
import * as http2 from 'http2';
import HttpsProxyAgent = require('https-proxy-agent');

import { getLocal } from "../../..";
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
import { TlsRequest, ClientError } from "../../../dist/types";

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
        let seenTlsErrorPromise = getDeferred<TlsRequest>();
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
            let seenTlsErrorPromise = getDeferred<TlsRequest>();
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
        let seenTlsErrorPromise = getDeferred<TlsRequest>();
        await badServer.on('tls-client-error', (r) => seenTlsErrorPromise.resolve(r));

        await expect(
            fetch(badServer.urlFor("/"))
        ).to.be.rejectedWith(
            // Broken by bad TS handling of overrides, see
            // https://github.com/DefinitelyTyped/DefinitelyTyped/pull/37292
            (isNode ? /certificate/ : 'Failed to fetch') as any
        );

        const tlsError = await seenTlsErrorPromise;

        expect(tlsError.failureCause).to.be.oneOf([
            // Depends on specific client behaviour:
            'reset', // Node 12
            'closed', // Node 10
            'cert-rejected' // Chrome
        ]);
        expect(tlsError.hostname).to.equal('localhost');
        expect(tlsError.remoteIpAddress).to.be.oneOf([
            '::ffff:127.0.0.1', // IPv4 localhost
            '::1' // IPv6 localhost
        ]);
        expect(tlsError.tags).to.deep.equal([]);

        await expectNoClientErrors();
    });

    it("should be sent for requests that reject the cert, using the deprecated alias", async () => {
        let seenTlsErrorPromise = getDeferred<TlsRequest>();
        await badServer.on('tlsClientError', (r) => seenTlsErrorPromise.resolve(r));

        await expect(
            fetch(badServer.urlFor("/"))
        ).to.be.rejectedWith(
            // Broken by bad TS handling of overrides, see
            // https://github.com/DefinitelyTyped/DefinitelyTyped/pull/37292
            (isNode ? /certificate/ : 'Failed to fetch') as any
        );

        const tlsError = await seenTlsErrorPromise;

        expect(tlsError.failureCause).to.be.oneOf([
            // Depends on specific client behaviour:
            'reset', // Node 12
            'closed', // Node 10
            'cert-rejected' // Chrome
        ]);

        await expectNoClientErrors();
    });

    nodeOnly(() => {
        it("should be sent for requests from clients that reject the certificate for the upstream server", async () => {
            let seenTlsErrorPromise = getDeferred<TlsRequest>();
            await badServer.on('tls-client-error', (r) => seenTlsErrorPromise.resolve(r));
            await badServer.anyRequest().thenPassThrough();

            await expect(
                fetch(goodServer.urlFor("/"), <any> {
                    // Ignores proxy cert issues by using the proxy via plain HTTP
                    agent: new HttpsProxyAgent({
                        protocol: 'http',
                        host: 'localhost',
                        port: badServer.port
                    })
                })
            ).to.be.rejectedWith(/certificate/);

            const tlsError = await seenTlsErrorPromise;

            expect(tlsError.failureCause).to.be.oneOf([
                // Depends on specific client behaviour:
                'reset', // Node 12+
                'closed', // Node 10-
            ]);
            expect(tlsError.hostname).to.equal('localhost');
            expect(tlsError.remoteIpAddress).to.equal('::ffff:127.0.0.1');

            await expectNoClientErrors();
        });

        it("should not be sent for requests from TLS clients that reset later in the connection", async function () {
            this.retries(3); // Can be slightly unstable, due to the race for RESET

            let seenTlsErrorPromise = getDeferred<TlsRequest>();
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
            let seenTlsErrorPromise = getDeferred<TlsRequest>();
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

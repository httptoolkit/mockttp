import * as fs from 'fs/promises';
import * as net from 'net';
import * as tls from 'tls';
import * as https from 'https';
import * as http2 from 'http2';

import * as WebSocket from 'isomorphic-ws';
import { trackClientHellos } from 'read-tls-client-hello';

import { getLocal, Mockttp } from "../../..";
import { getCA, GeneratedCertificate } from "../../../src/util/certificates";
import {
    expect,
    nodeOnly,
    nodeSatisfies,
    makeDestroyable,
    DestroyableServer
} from "../../test-utils";

// Below Node v24.15 the native impersonate() throws (the OpenSSL API it needs is missing), so
// Mockttp falls back to its own default upstream fingerprint. From v24.15 it runs, and from v26.4
// it can reproduce a fingerprint with full fidelity (an exact JA4 match).
const IMPERSONATION_USABLE = '>=24.15.0';
const IMPERSONATION_FULL_FIDELITY = '>=26.4.0';

const CA_KEY_PATH = './test/fixtures/test-ca.key';
const CA_CERT_PATH = './test/fixtures/test-ca.pem';

nodeOnly(() => {
    describe("TLS fingerprint mirroring", function () {
        this.timeout(5000);

        let caCert: Buffer;
        let targetCert: GeneratedCertificate;

        let server: Mockttp;

        // An HTTP/1+2 server that records the JA4 fingerprint of the last inbound client hello, so
        // we can see exactly what TLS fingerprint Mockttp presented on the upstream connection.
        // We compare JA4 rather than JA3: JA4 doesn't hash the EC point formats (which current
        // OpenSSL can't yet reproduce exactly), so it's the fingerprint that matches in practice.
        let target: DestroyableServer<http2.Http2SecureServer> & {
            lastJa4?: string,
            lastAlpn?: string
        };
        let targetPort: number;

        before(async () => {
            caCert = await fs.readFile(CA_CERT_PATH);
            const ca = await getCA({ keyPath: CA_KEY_PATH, certPath: CA_CERT_PATH });
            targetCert = await ca.generateCertificate('localhost');
        });

        beforeEach(async () => {
            target = makeDestroyable(http2.createSecureServer({
                key: targetCert.key,
                cert: targetCert.cert,
                allowHTTP1: true
            }, (req, res) => {
                const socket = req.socket as tls.TLSSocket;
                target.lastJa4 = socket.tlsClientHello?.ja4;
                target.lastAlpn = socket.alpnProtocol || undefined;
                res.end('ok');
            })) as typeof target;
            trackClientHellos(target);
            await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
            targetPort = (target.address() as net.AddressInfo).port;

            server = getLocal({
                https: {
                    keyPath: CA_KEY_PATH,
                    certPath: CA_CERT_PATH
                },
                http2: true
            });
            await server.start();
        });

        afterEach(async () => {
            await server.stop();
            await target.destroy();
        });

        // Make an HTTPS request through Mockttp (which intercepts our TLS, then forwards upstream):
        const requestViaServer = (
            options: https.RequestOptions & tls.ConnectionOptions = {},
            port = server.port
        ) => new Promise<number | undefined>((resolve, reject) => {
            const req = https.request({
                host: 'localhost',
                port,
                path: '/',
                ca: caCert,
                servername: 'localhost',
                rejectUnauthorized: false,
                ...options
            }, (res) => {
                res.resume();
                res.on('end', () => resolve(res.statusCode));
                res.on('error', reject);
            });
            req.on('error', reject);
            req.end();
        });

        // The JA4 our own client presents, measured by connecting it directly to a tracking server
        // with an identical configuration to requestViaServer:
        const measureClientJa4 = async (
            options: https.RequestOptions & tls.ConnectionOptions = {}
        ) => {
            let ja4: string | undefined;
            const probe = makeDestroyable(https.createServer({
                key: targetCert.key,
                cert: targetCert.cert
            }, (req, res) => {
                ja4 = (req.socket as tls.TLSSocket).tlsClientHello?.ja4;
                res.end('ok');
            }));
            trackClientHellos(probe);
            await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
            const port = (probe.address() as net.AddressInfo).port;

            const status = await requestViaServer(options, port);
            await probe.destroy();

            expect(status).to.equal(200);
            expect(ja4!.length).to.be.greaterThan(0);
            return ja4;
        };

        // As above, but over HTTP/2 - the downstream connection is the H2 session, not a socket:
        const h2RequestViaServer = (url = server.url) => new Promise<number | undefined>((resolve, reject) => {
            const client = http2.connect(url, { ca: caCert, rejectUnauthorized: false });
            const req = client.request({ ':path': '/' });
            let status: number | undefined;
            req.on('response', (headers) => { status = headers[':status']; });
            req.resume();
            req.on('end', () => { client.close(); resolve(status); });
            req.on('error', reject);
            client.on('error', reject);
            req.end();
        });

        const measureClientH2Ja4 = async () => {
            let ja4: string | undefined;
            const probe = makeDestroyable(http2.createSecureServer({
                key: targetCert.key,
                cert: targetCert.cert
            }));
            trackClientHellos(probe);
            probe.on('stream', (stream: http2.ServerHttp2Stream) => {
                ja4 = (stream.session!.socket as tls.TLSSocket).tlsClientHello?.ja4;
                stream.respond({ ':status': 200 });
                stream.end('ok');
            });
            await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
            const port = (probe.address() as net.AddressInfo).port;

            const status = await h2RequestViaServer(`https://localhost:${port}`);
            await probe.destroy();

            expect(status).to.equal(200);
            expect(ja4!.length).to.be.greaterThan(0);
            return ja4;
        };

        it("uses Mockttp's default fingerprint when mirroring is disabled", async () => {
            await server.forAnyRequest().thenForwardTo(`https://localhost:${targetPort}`);

            const clientJa4 = await measureClientJa4();
            const status = await requestViaServer();

            // The upstream saw a fingerprint (so we did connect) and it's Mockttp's own, not a
            // passthrough of our client's fingerprint:
            expect(status).to.equal(200);
            expect(target.lastJa4!.length).to.be.greaterThan(0);
            expect(target.lastJa4).to.not.equal(clientJa4);
        });

        it("mirrors the client's TLS fingerprint upstream when enabled", async function () {
            if (!nodeSatisfies(IMPERSONATION_FULL_FIDELITY)) this.skip();

            await server.forAnyRequest().thenForwardTo(`https://localhost:${targetPort}`, {
                mirrorTlsFingerprint: true
            });

            const clientJa4 = await measureClientJa4();
            const status = await requestViaServer();

            // The upstream now sees our client's own fingerprint, mirrored through Mockttp:
            expect(status).to.equal(200);
            expect(target.lastJa4).to.equal(clientJa4);
        });

        it("mirrors the client's TLS fingerprint upstream over HTTP/2", async function () {
            if (!nodeSatisfies(IMPERSONATION_FULL_FIDELITY)) this.skip();

            await server.forAnyRequest().thenForwardTo(`https://localhost:${targetPort}`, {
                mirrorTlsFingerprint: true
            });

            // For an H2 request the downstream connection is the session, not a socket, so this
            // exercises mirroring the client hello up onto the session:
            const clientJa4 = await measureClientH2Ja4();
            const status = await h2RequestViaServer();

            expect(status).to.equal(200);
            expect(target.lastJa4).to.equal(clientJa4);
        });

        // Open a WS connection and resolve once it closes, reporting whether it ever opened - we
        // only need the TLS hello, not the WS exchange, so errors later are fine:
        const openWsOnce = (url: string) => new Promise<boolean>((resolve) => {
            let opened = false;
            const ws = new WebSocket(url, { rejectUnauthorized: false });
            ws.on('open', () => { opened = true; ws.close(); });
            ws.on('close', () => resolve(opened));
            ws.on('error', () => resolve(opened));
        });

        // The client's own WS JA4, measured against a tracking wss server (matching openWsOnce):
        const measureClientWsJa4 = async () => {
            let ja4: string | undefined;
            const probe = makeDestroyable(https.createServer({
                key: targetCert.key,
                cert: targetCert.cert
            }));
            trackClientHellos(probe);
            const probeWs = new WebSocket.Server({ server: probe });
            probeWs.on('connection', (ws, req) => {
                ja4 = (req.socket as tls.TLSSocket).tlsClientHello?.ja4;
                ws.close();
            });
            await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
            const port = (probe.address() as net.AddressInfo).port;

            const opened = await openWsOnce(`wss://localhost:${port}`);

            probeWs.close();
            await probe.destroy();

            expect(opened).to.equal(true);
            expect(ja4!.length).to.be.greaterThan(0);
            return ja4;
        };

        it("mirrors the client's TLS fingerprint upstream over WebSockets", async function () {
            if (!nodeSatisfies(IMPERSONATION_FULL_FIDELITY)) this.skip();

            // A wss target recording the JA4 of the (mirrored) upstream hello Mockttp presents:
            let upstreamJa4: string | undefined;
            const wsTarget = makeDestroyable(https.createServer({
                key: targetCert.key,
                cert: targetCert.cert
            }));
            trackClientHellos(wsTarget);
            const wsTargetServer = new WebSocket.Server({ server: wsTarget });
            wsTargetServer.on('connection', (ws, req) => {
                upstreamJa4 = (req.socket as tls.TLSSocket).tlsClientHello?.ja4;
                ws.close();
            });
            await new Promise<void>((resolve) => wsTarget.listen(0, '127.0.0.1', resolve));
            const wsTargetPort = (wsTarget.address() as net.AddressInfo).port;

            try {
                await server.forAnyWebSocket().thenForwardTo(`wss://localhost:${wsTargetPort}`, {
                    mirrorTlsFingerprint: true
                });

                const clientJa4 = await measureClientWsJa4();
                const opened = await openWsOnce(`wss://localhost:${server.port}`);

                // The upstream wss connection now presents our client's own fingerprint:
                expect(opened).to.equal(true);
                expect(upstreamJa4).to.equal(clientJa4);
            } finally {
                wsTargetServer.close();
                await wsTarget.destroy();
            }
        });

        it("offers upstream ALPN matching our protocol, not the client's mirrored ALPN", async function () {
            if (!nodeSatisfies(IMPERSONATION_USABLE)) this.skip();

            // A server with HTTP/2 disabled, so a client that offers h2 is still served H1
            // downstream - and thus forwarded H1 upstream. Mirroring the client's ALPN (h2) here
            // would make the H1 upstream negotiate h2 against our h2-capable target and break the
            // request (502 parse error), so the mirrored hello must offer http/1.1 instead.
            const h1Server = getLocal({
                https: {
                    keyPath: CA_KEY_PATH,
                    certPath: CA_CERT_PATH
                }
            });
            await h1Server.start();

            try {
                await h1Server.forAnyRequest().thenForwardTo(`https://localhost:${targetPort}`, {
                    mirrorTlsFingerprint: true
                });

                const h2ClientJa4 = await measureClientJa4({ ALPNProtocols: ['h2', 'http/1.1'] });
                const h1ClientJa4 = await measureClientJa4({ ALPNProtocols: ['http/1.1'] });
                expect(h2ClientJa4).to.not.equal(h1ClientJa4);

                const status = await requestViaServer({
                    ALPNProtocols: ['h2', 'http/1.1'] // Offer h2, though we're served (& forwarded) H1
                }, h1Server.port);

                expect(status).to.equal(200);

                // The upstream connection spoke H1, despite the client's mirrored hello offering h2:
                expect(target.lastAlpn).to.equal('http/1.1');

                // Where we can mirror exactly, the upstream hello is the client's own hello with
                // only the ALPN swapped - i.e. mirroring happened, and only ALPN was overridden:
                if (nodeSatisfies(IMPERSONATION_FULL_FIDELITY)) {
                    expect(target.lastJa4).to.equal(h1ClientJa4);
                }
            } finally {
                await h1Server.stop();
            }
        });

        it("ignores mirroring to connect to legacy-TLS servers when HTTPS checks are relaxed", async function () {
            if (!nodeSatisfies(IMPERSONATION_USABLE)) this.skip();

            // A server that only speaks TLS 1.0/1.1. Our client's default hello offers TLS 1.2 &
            // 1.3 only, so mirroring it upstream verbatim can't negotiate here at all. Ignoring HTTPS errors
            // needs to make this work, not just blindly mirror the hello's limitations and fail.
            let negotiatedProtocol: string | undefined;
            const legacyTarget = makeDestroyable(https.createServer({
                key: targetCert.key,
                cert: targetCert.cert,
                minVersion: 'TLSv1',
                maxVersion: 'TLSv1.1',
                ciphers: 'DEFAULT:@SECLEVEL=0'
            }, (req, res) => {
                negotiatedProtocol = (req.socket as tls.TLSSocket).getProtocol() ?? undefined;
                res.end('ok');
            }));
            await new Promise<void>((resolve) => legacyTarget.listen(0, '127.0.0.1', resolve));
            const legacyPort = (legacyTarget.address() as net.AddressInfo).port;

            try {
                await server.forAnyRequest().thenForwardTo(`https://localhost:${legacyPort}`, {
                    ignoreHostHttpsErrors: ['localhost', '127.0.0.1'],
                    mirrorTlsFingerprint: true
                });

                const status = await requestViaServer();

                expect(status).to.equal(200);
                expect(negotiatedProtocol).to.equal('TLSv1.1');
            } finally {
                await legacyTarget.destroy();
            }
        });

        it("still forwards successfully, using the default fingerprint, when impersonation is unavailable", async function () {
            if (nodeSatisfies(IMPERSONATION_USABLE)) this.skip();

            await server.forAnyRequest().thenForwardTo(`https://localhost:${targetPort}`, {
                mirrorTlsFingerprint: true
            });

            const clientJa4 = await measureClientJa4();
            const status = await requestViaServer(); // Does not throw despite mirroring being unavailable

            // Fell back to Mockttp's default fingerprint rather than the client's:
            expect(status).to.equal(200);
            expect(target.lastJa4!.length).to.be.greaterThan(0);
            expect(target.lastJa4).to.not.equal(clientJa4);
        });
    });
});

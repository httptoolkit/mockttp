import * as fs from 'fs/promises';
import * as net from 'net';
import * as tls from 'tls';
import * as https from 'https';
import * as http2 from 'http2';

import * as WebSocket from 'isomorphic-ws';
import { trackClientHellos } from 'read-tls-client-hello';

import { getLocal, Mockttp } from "../../..";
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

nodeOnly(() => {
    describe("TLS fingerprint mirroring", function () {
        this.timeout(5000);

        let key: Buffer;
        let cert: Buffer;

        let server: Mockttp;

        // An HTTP/1+2 server that records the JA4 fingerprint of the last inbound client hello, so
        // we can see exactly what TLS fingerprint Mockttp presented on the upstream connection.
        // We compare JA4 rather than JA3: JA4 doesn't hash the EC point formats (which current
        // OpenSSL can't yet reproduce exactly), so it's the fingerprint that matches in practice.
        let target: DestroyableServer<http2.Http2SecureServer> & { lastJa4?: string };
        let targetPort: number;

        before(async () => {
            key = await fs.readFile('./test/fixtures/test-ca.key');
            cert = await fs.readFile('./test/fixtures/test-ca.pem');
        });

        beforeEach(async () => {
            target = makeDestroyable(http2.createSecureServer({ key, cert, allowHTTP1: true }, (req, res) => {
                target.lastJa4 = (req.socket as tls.TLSSocket).tlsClientHello?.ja4;
                res.end('ok');
            })) as typeof target;
            trackClientHellos(target);
            await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
            targetPort = (target.address() as net.AddressInfo).port;

            server = getLocal({
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem'
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
        const requestViaServer = () => new Promise<void>((resolve, reject) => {
            const req = https.request({
                host: 'localhost',
                port: server.port,
                path: '/',
                ca: cert,
                servername: 'localhost',
                rejectUnauthorized: false
            }, (res) => {
                res.resume();
                res.on('end', () => resolve());
                res.on('error', reject);
            });
            req.on('error', reject);
            req.end();
        });

        // The JA4 our own client presents, measured by connecting it directly to a tracking server
        // with an identical configuration to requestViaServer:
        const measureClientJa4 = async () => {
            let ja4: string | undefined;
            const probe = makeDestroyable(https.createServer({ key, cert }, (req, res) => {
                ja4 = (req.socket as tls.TLSSocket).tlsClientHello?.ja4;
                res.end('ok');
            }));
            trackClientHellos(probe);
            await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
            const port = (probe.address() as net.AddressInfo).port;

            await new Promise<void>((resolve, reject) => {
                const req = https.request({
                    host: 'localhost', port, path: '/', ca: cert,
                    servername: 'localhost', rejectUnauthorized: false
                }, (res) => { res.resume(); res.on('end', () => resolve()); res.on('error', reject); });
                req.on('error', reject);
                req.end();
            });

            await probe.destroy();
            return ja4;
        };

        // As above, but over HTTP/2 - the downstream connection is the H2 session, not a socket:
        const h2RequestViaServer = () => new Promise<void>((resolve, reject) => {
            const client = http2.connect(server.url, { ca: cert, rejectUnauthorized: false });
            const req = client.request({ ':path': '/' });
            req.resume();
            req.on('end', () => { client.close(); resolve(); });
            req.on('error', reject);
            client.on('error', reject);
            req.end();
        });

        const measureClientH2Ja4 = async () => {
            let ja4: string | undefined;
            const probe = makeDestroyable(http2.createSecureServer({ key, cert }));
            trackClientHellos(probe);
            probe.on('stream', (stream: http2.ServerHttp2Stream) => {
                ja4 = (stream.session!.socket as tls.TLSSocket).tlsClientHello?.ja4;
                stream.respond({ ':status': 200 });
                stream.end('ok');
            });
            await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
            const port = (probe.address() as net.AddressInfo).port;

            await new Promise<void>((resolve, reject) => {
                const client = http2.connect(`https://localhost:${port}`, { ca: cert, rejectUnauthorized: false });
                const req = client.request({ ':path': '/' });
                req.resume();
                req.on('end', () => { client.close(); resolve(); });
                req.on('error', reject);
                client.on('error', reject);
                req.end();
            });

            await probe.destroy();
            return ja4;
        };

        it("uses Mockttp's default fingerprint when mirroring is disabled", async () => {
            await server.forAnyRequest().thenForwardTo(`https://localhost:${targetPort}`, {
                ignoreHostHttpsErrors: ['localhost', '127.0.0.1']
            });

            const clientJa4 = await measureClientJa4();
            await requestViaServer();

            // The upstream saw a fingerprint (so we did connect) and it's Mockttp's own, not a
            // passthrough of our client's fingerprint:
            expect(target.lastJa4).to.be.a('string').and.not.empty;
            expect(target.lastJa4).to.not.equal(clientJa4);
        });

        it("mirrors the client's TLS fingerprint upstream when enabled", async function () {
            if (!nodeSatisfies(IMPERSONATION_FULL_FIDELITY)) this.skip();

            await server.forAnyRequest().thenForwardTo(`https://localhost:${targetPort}`, {
                ignoreHostHttpsErrors: ['localhost', '127.0.0.1'],
                mirrorTlsFingerprint: true
            });

            const clientJa4 = await measureClientJa4();
            await requestViaServer();

            // The upstream now sees our client's own fingerprint, mirrored through Mockttp:
            expect(target.lastJa4).to.equal(clientJa4);
        });

        it("mirrors the client's TLS fingerprint upstream over HTTP/2", async function () {
            if (!nodeSatisfies(IMPERSONATION_FULL_FIDELITY)) this.skip();

            await server.forAnyRequest().thenForwardTo(`https://localhost:${targetPort}`, {
                ignoreHostHttpsErrors: ['localhost', '127.0.0.1'],
                mirrorTlsFingerprint: true
            });

            // For an H2 request the downstream connection is the session, not a socket, so this
            // exercises mirroring the client hello up onto the session:
            const clientJa4 = await measureClientH2Ja4();
            await h2RequestViaServer();

            expect(target.lastJa4).to.equal(clientJa4);
        });

        // Open a WS connection and resolve once it closes - we only need the TLS hello, not the WS
        // exchange, so we tolerate errors (e.g. the target closing immediately):
        const openWsOnce = (url: string) => new Promise<void>((resolve) => {
            const ws = new WebSocket(url, { rejectUnauthorized: false });
            ws.on('open', () => ws.close());
            ws.on('close', () => resolve());
            ws.on('error', () => resolve());
        });

        // The client's own WS JA4, measured against a tracking wss server (matching openWsOnce):
        const measureClientWsJa4 = async () => {
            let ja4: string | undefined;
            const probe = makeDestroyable(https.createServer({ key, cert }));
            trackClientHellos(probe);
            const probeWs = new WebSocket.Server({ server: probe });
            probeWs.on('connection', (ws, req) => {
                ja4 = (req.socket as tls.TLSSocket).tlsClientHello?.ja4;
                ws.close();
            });
            await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
            const port = (probe.address() as net.AddressInfo).port;

            await openWsOnce(`wss://localhost:${port}`);

            probeWs.close();
            await probe.destroy();
            return ja4;
        };

        it("mirrors the client's TLS fingerprint upstream over WebSockets", async function () {
            if (!nodeSatisfies(IMPERSONATION_FULL_FIDELITY)) this.skip();

            // A wss target recording the JA4 of the (mirrored) upstream hello Mockttp presents:
            let upstreamJa4: string | undefined;
            const wsTarget = makeDestroyable(https.createServer({ key, cert }));
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
                    ignoreHostHttpsErrors: ['localhost', '127.0.0.1'],
                    mirrorTlsFingerprint: true
                });

                const clientJa4 = await measureClientWsJa4();
                await openWsOnce(`wss://localhost:${server.port}`);

                // The upstream wss connection now presents our client's own fingerprint:
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
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem'
                }
            });
            await h1Server.start();

            try {
                await h1Server.forAnyRequest().thenForwardTo(`https://localhost:${targetPort}`, {
                    ignoreHostHttpsErrors: ['localhost', '127.0.0.1'],
                    mirrorTlsFingerprint: true
                });

                const result = await new Promise<{ status?: number, error?: string }>((resolve) => {
                    const req = https.request({
                        host: 'localhost', port: h1Server.port, path: '/', ca: cert,
                        servername: 'localhost', rejectUnauthorized: false,
                        // Offer h2, though we're served (& forwarded) H1. ALPNProtocols is a valid
                        // https.request option at runtime but typed only on tls.ConnectionOptions:
                        ALPNProtocols: ['h2', 'http/1.1']
                    } as https.RequestOptions & tls.ConnectionOptions, (res) => {
                        res.resume(); res.on('end', () => resolve({ status: res.statusCode }));
                    });
                    req.on('error', (e) => resolve({ error: e.message }));
                    req.end();
                });

                expect(result.error, `request errored: ${result.error}`).to.equal(undefined);
                expect(result.status).to.equal(200);
            } finally {
                await h1Server.stop();
            }
        });

        it("still forwards successfully, using the default fingerprint, when impersonation is unavailable", async function () {
            if (nodeSatisfies(IMPERSONATION_USABLE)) this.skip();

            await server.forAnyRequest().thenForwardTo(`https://localhost:${targetPort}`, {
                ignoreHostHttpsErrors: ['localhost', '127.0.0.1'],
                mirrorTlsFingerprint: true
            });

            const clientJa4 = await measureClientJa4();
            await requestViaServer(); // Does not throw despite mirroring being unavailable

            // Fell back to Mockttp's default fingerprint rather than the client's:
            expect(target.lastJa4).to.be.a('string').and.not.empty;
            expect(target.lastJa4).to.not.equal(clientJa4);
        });
    });
});

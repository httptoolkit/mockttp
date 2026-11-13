import * as fs from 'fs/promises';
import * as net from 'net';
import { Duplex } from 'stream';
import * as https from 'https';
import * as http2 from 'http2';
import * as tls from 'tls';
import { HttpsProxyAgent } from 'https-proxy-agent';
import getPort from 'get-port';

import {
    getLocal,
    getRemote,
    getAdminServer,
    generateCACertificate,
    Mockttp,
    CompletedRequest
} from '../..';
import {
    expect,
    nodeOnly,
    getHttp2Response,
    openSocksSocket,
    sendRawRequest
} from '../test-utils';

const FIXTURE_CA = {
    keyPath: './test/fixtures/test-ca.key',
    certPath: './test/fixtures/test-ca.pem'
};
const FIXTURE_CA_CN = 'Mockttp Testing CA - DO NOT TRUST';

nodeOnly(() => describe('Additional ports', () => {
    let primaryCA: { key: string, cert: string };
    let extraCA: { key: string, cert: string };
    let fixtureCACert: string;

    before(async () => {
        primaryCA = await generateCACertificate({ subject: { commonName: 'Primary CA' } });
        extraCA = await generateCACertificate({ subject: { commonName: 'Extra CA' } });
        fixtureCACert = await fs.readFile(FIXTURE_CA.certPath, 'utf8');
    });

    const getCert = (options: tls.ConnectionOptions) => new Promise<tls.PeerCertificate>((resolve, reject) => {
        const socket = tls.connect({ host: 'localhost', rejectUnauthorized: false, ...options }, () => {
            resolve(socket.getPeerCertificate());
            socket.destroy();
        });
        socket.once('error', reject);
    });
    const getIssuer = async (port: number, options: tls.ConnectionOptions = {}) =>
        (await getCert({ port, ...options })).issuer.CN;

    const request = (port: number, ca: string, proxy = false) => new Promise<string>((resolve, reject) => {
        const req = https.get(proxy ? 'https://example.test/' : `https://localhost:${port}/`, {
            ca,
            agent: proxy ? new HttpsProxyAgent(`http://localhost:${port}`) : undefined
        }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve(body));
            res.on('error', reject);
        });
        req.on('error', reject);
    });

    // Checks the code, since if both IPv4 & IPv6 are refused, the error is an AggregateError with no message
    const expectPortClosed = async (port: number) => {
        const error = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
            const socket = net.connect(port, 'localhost');
            socket.once('connect', () => { socket.destroy(); resolve(undefined); });
            socket.once('error', resolve);
        });
        expect(error?.code).to.equal('ECONNREFUSED');
    };

    describe('with a running HTTPS server', () => {
        let server: Mockttp;

        beforeEach(async () => {
            server = getLocal({
                https: { ...primaryCA, defaultDomain: 'default.test' },
                http2: true,
                socks: true
            });
            await server.start();
        });
        afterEach(() => server.stop());

        it('selects the CA by port, with and without SNI', async () => {
            const extraPort = await server.addPort({ https: extraCA });
            expect(extraPort).to.not.equal(server.port);

            for (const servername of [undefined, 'example.test']) {
                for (const [port, ca, issuer] of [
                    [server.port, primaryCA.cert, 'Primary CA'],
                    [extraPort, extraCA.cert, 'Extra CA']
                ] as const) {
                    expect(await getIssuer(port, {
                        ca,
                        rejectUnauthorized: true,
                        servername,
                        checkServerIdentity: () => undefined
                    })).to.equal(issuer);
                }
            }
        });

        it('uses the main CA on an extra port by default', async () => {
            const extraPort = await server.addPort();
            expect(extraPort).to.not.equal(server.port);
            expect(await getIssuer(extraPort)).to.equal('Primary CA');
        });

        it('replaces a key & cert CA with a keyPath & certPath CA', async () => {
            const extraPort = await server.addPort({ https: FIXTURE_CA });
            expect(await getIssuer(extraPort)).to.equal(FIXTURE_CA_CN);
        });

        it('inherits the other HTTPS settings from the main port', async () => {
            const extraPort = await server.addPort({ https: extraCA });
            const cert = await getCert({ port: extraPort });
            expect(cert.issuer.CN).to.equal('Extra CA');
            expect(cert.subject.CN).to.equal('default.test');
        });

        it('listens on a fixed port', async () => {
            const port = await getPort();
            expect(await server.addPort({ port, https: extraCA })).to.equal(port);
            expect(await getIssuer(port)).to.equal('Extra CA');
        });

        it('keeps the CA of a live port after a failed addPort on the same port', async () => {
            const extraPort = await server.addPort({ https: extraCA });

            await expect(server.addPort({ port: extraPort, https: FIXTURE_CA })).to.be.rejectedWith('EADDRINUSE');
            await expect(server.addPort({ port: server.port, https: FIXTURE_CA })).to.be.rejectedWith('EADDRINUSE');

            expect(await getIssuer(extraPort)).to.equal('Extra CA');
            expect(await getIssuer(server.port)).to.equal('Primary CA');
        });

        for (const proxy of [false, true]) {
            it(`shares rules and events across ports for ${proxy ? 'CONNECT' : 'direct HTTPS'}`, async () => {
                const extraPort = await server.addPort({ https: extraCA });
                const endpoint = await server.forAnyRequest().thenReply(200, 'shared response');
                const seenRequests: CompletedRequest[] = [];
                await server.on('request', (req) => seenRequests.push(req));

                expect(await request(server.port, primaryCA.cert, proxy)).to.equal('shared response');
                expect(await request(extraPort, extraCA.cert, proxy)).to.equal('shared response');

                expect(await endpoint.getSeenRequests()).to.have.length(2);
                expect(seenRequests).to.have.length(2);
            });
        }

        it('closes all extra ports when the server stops', async () => {
            const first = await server.addPort({ https: extraCA });
            const second = await server.addPort();
            await server.stop();

            await expectPortClosed(first);
            await expectPortClosed(second);

            await server.start(); // For afterEach
        });

        it('rejects if the server stops while the port is being added', async () => {
            const port = await getPort();
            const adding = server.addPort({ port, https: extraCA });
            const rejection = expect(adding).to.be.rejectedWith('Server stopped while adding a port');
            await server.stop();
            await rejection;

            await expectPortClosed(port);

            await server.start(); // For afterEach
        });

        const getTunnelIssuer = async (tunnel: Duplex) =>
            (await getCert({ socket: tunnel, servername: 'example.test' })).issuer.CN;

        it("uses the port's CA for TLS within HTTP/2 CONNECT", async () => {
            const extraPort = await server.addPort({ https: extraCA });
            const client = http2.connect(`https://localhost:${extraPort}`, { rejectUnauthorized: false });
            try {
                const tunnel = client.request({ ':method': 'CONNECT', ':authority': 'example.test:443' });
                expect((await getHttp2Response(tunnel))[':status']).to.equal(200);
                expect(await getTunnelIssuer(tunnel)).to.equal('Extra CA');
            } finally {
                client.destroy();
            }
        });

        it("uses the port's CA for TLS within SOCKS", async () => {
            const extraPort = await server.addPort({ https: extraCA });
            const socket = await openSocksSocket({ port: extraPort }, 'example.test', 443);
            expect(await getTunnelIssuer(socket)).to.equal('Extra CA');
        });
    });

    describe('with a plain HTTP server', () => {
        const server = getLocal();

        beforeEach(() => server.start());
        afterEach(() => server.stop());

        it('adds an HTTPS port', async () => {
            const extraPort = await server.addPort({ https: extraCA });
            await server.forAnyRequest().thenReply(200, 'HTTPS on extra port');
            expect(await request(extraPort, extraCA.cert)).to.equal('HTTPS on extra port');
        });

        it('closes TLS connections on ports without a CA immediately', async () => {
            const extraPort = await server.addPort();

            for (const port of [server.port, extraPort]) {
                const socket = net.connect(port, '127.0.0.1');
                await new Promise((resolve) => socket.once('connect', resolve));
                // The start of a TLS record, but not a complete client hello:
                socket.write(Buffer.from([0x16, 0x03, 0x01]));
                await new Promise((resolve) => socket.once('close', resolve));
            }
        });

        it('uses the extra port in the URL of requests without a host', async () => {
            const extraPort = await server.addPort();
            const endpoint = await server.forAnyRequest().thenReply(200);

            const socket = net.connect(extraPort, '127.0.0.1');
            await new Promise((resolve) => socket.once('connect', resolve));
            await sendRawRequest(socket, 'GET /path HTTP/1.0\r\n\r\n');

            const [seenRequest] = await endpoint.getSeenRequests();
            expect(seenRequest.url).to.equal(`http://localhost:${extraPort}/path`);
        });
    });

    it('rejects when the server is not running', async () => {
        const server = getLocal({ https: primaryCA });
        await expect(server.addPort()).to.be.rejectedWith('Cannot add a port when the server is not running');

        await server.start();
        await server.stop();
        await expect(server.addPort()).to.be.rejectedWith('Cannot add a port when the server is not running');
    });

    describe('with a remote client', () => {
        const adminServer = getAdminServer();
        let adminUrl: string;
        let remote: Mockttp;

        before(async () => {
            const adminPort = await getPort();
            await adminServer.start(adminPort);
            adminUrl = `http://localhost:${adminPort}`;
        });
        after(() => adminServer.stop());

        beforeEach(() => {
            remote = getRemote({ adminServerUrl: adminUrl, https: primaryCA });
        });

        it('rejects before the server has started', async () => {
            await expect(remote.addPort({ https: extraCA }))
                .to.be.rejectedWith('Cannot add a port before the server is started');
        });

        it('adds ports with key & cert or keyPath & certPath, sharing rules', async () => {
            await remote.start();
            try {
                const dataPort = await remote.addPort({ https: extraCA });
                const pathPort = await remote.addPort({ port: { startPort: 9500, endPort: 9600 }, https: FIXTURE_CA });
                expect(pathPort).to.be.within(9500, 9600);

                const endpoint = await remote.forAnyRequest().thenReply(200, 'remote session');
                expect(await request(remote.port, primaryCA.cert)).to.equal('remote session');
                expect(await request(dataPort, extraCA.cert)).to.equal('remote session');
                expect(await request(pathPort, fixtureCACert)).to.equal('remote session');
                expect(await endpoint.getSeenRequests()).to.have.length(3);
            } finally {
                await remote.stop();
            }
        });

        it('rejects invalid options without echoing their values', async () => {
            await remote.start();
            try {
                const secret = 'SUPER-SECRET-KEY-MATERIAL';
                const invalidOptions: Array<[unknown, string]> = [
                    [{ https: { key: secret } }, 'Unrecognized https options'],
                    [{ https: { key: secret, cert: secret } }, ''], // Rejected when loading the CA
                    [{ https: { ...extraCA, tlsPassthrough: [{ hostname: secret }] } }, 'Unsupported https option: tlsPassthrough'],
                    [{ https: { key: [secret], cert: extraCA.cert } }, 'Invalid https option: key must be a string'],
                    [{ https: secret }, 'Invalid https options: must be an object'],
                    [{ port: secret }, 'Invalid port: must be a port number or a { startPort, endPort } range'],
                    [{ port: { startPort: 9500 } }, 'Invalid port: must be a port number or a { startPort, endPort } range'],
                    [{ port: 70000 }, 'Invalid port: must be a port number or a { startPort, endPort } range']
                ];

                for (const [options, expectedMessage] of invalidOptions) {
                    // @ts-expect-error Deliberately invalid input, as a remote client could send
                    const error: Error = await remote.addPort(options).catch(e => e);
                    expect(error).to.be.instanceOf(Error);
                    expect(error.message).to.include(expectedMessage);
                    expect(error.message).to.not.include(secret);
                }
            } finally {
                await remote.stop();
            }
        });
    });
}));

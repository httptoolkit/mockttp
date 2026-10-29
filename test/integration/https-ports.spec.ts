import * as https from 'https';
import * as http2 from 'http2';
import * as tls from 'tls';
import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket from 'isomorphic-ws';
import getPort from 'get-port';
import { generateCACertificate, getRemote, PluggableAdmin, MockttpPluggableAdmin } from '../..';
import { MockttpServer } from '../../src/server/mockttp-server';
import { expect, nodeOnly, getHttp2Body } from '../test-utils';

nodeOnly(() => describe('Additional HTTPS ports', () => {
    let server: MockttpServer;
    let primaryCA: Awaited<ReturnType<typeof generateCACertificate>>;
    let extraCA: Awaited<ReturnType<typeof generateCACertificate>>;
    let stopped: boolean;

    before(async () => {
        primaryCA = await generateCACertificate({ subject: { commonName: 'Primary CA' } });
        extraCA = await generateCACertificate({ subject: { commonName: 'Extra CA' } });
    });
    beforeEach(async () => {
        server = new MockttpServer({ https: primaryCA, extraHttps: { extra: extraCA, second: extraCA } });
        stopped = false;
        await server.start();
    });
    afterEach(async () => { if (!stopped) await server.stop(); });

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

    for (const sni of [false, true]) {
        it(`selects the CA by port ${sni ? 'with' : 'without'} SNI`, async () => {
            const extra = await server.enableExtraHttps('extra');
            for (const [port, ca, issuer] of [
                [server.port, primaryCA.cert, 'Primary CA'],
                [extra, extraCA.cert, 'Extra CA']
            ] as const) {
                const peer = await new Promise<tls.PeerCertificate>((resolve, reject) => {
                    const socket = tls.connect({
                        host: 'localhost', port, ca,
                        servername: sni ? 'example.test' : undefined
                    }, () => {
                        resolve(socket.getPeerCertificate());
                        socket.end();
                    });
                    socket.once('error', reject);
                });
                expect(peer.issuer.CN).to.equal(issuer);
            }
        });
    }

    for (const proxy of [false, true]) {
        it(`shares rules and recorded requests across ports for ${proxy ? 'CONNECT' : 'direct HTTPS'}`, async () => {
            const extra = await server.enableExtraHttps('extra');
            const endpoint = await server.forAnyRequest().thenReply(200, 'shared response');
            expect(await request(server.port, primaryCA.cert, proxy)).to.equal('shared response');
            expect(await request(extra, extraCA.cert, proxy)).to.equal('shared response');
            expect(await endpoint.getSeenRequests()).to.have.length(2);
        });
    }

    it('keeps each CA confined to its own port', async () => {
        const extra = await server.enableExtraHttps('extra');
        await expect(request(server.port, extraCA.cert)).to.be.rejected;
        await expect(request(extra, primaryCA.cert)).to.be.rejected;
    });

    it('enables only configured names and reuses the port for repeated requests', async () => {
        expect(server.extraHttpsNames).to.deep.equal(['extra', 'second']);
        const [first, second] = await Promise.all([
            server.enableExtraHttps('extra'), server.enableExtraHttps('extra')
        ]);
        expect(first).to.equal(second);
        await expect(server.enableExtraHttps('missing')).to.be.rejectedWith('Unknown HTTPS port configuration');
        await expect(server.enableExtraHttps('toString')).to.be.rejectedWith('Unknown HTTPS port configuration');
        await server.forAnyRequest().thenReply(200, 'named port');
        expect(await request(first, extraCA.cert)).to.equal('named port');
    });

    it('supports named ports through the existing remote session API', async () => {
        const admin = new PluggableAdmin.AdminServer<{ http: MockttpPluggableAdmin.MockttpAdminPlugin }>({
            adminPlugins: { http: MockttpPluggableAdmin.MockttpAdminPlugin },
            pluginDefaults: { http: { options: {
                https: primaryCA, extraHttps: { extra: extraCA }
            } } }
        });
        const adminPort = await getPort();
        await admin.start(adminPort);
        const remote = getRemote({ adminServerUrl: `http://localhost:${adminPort}` });
        try {
            await remote.start();
            expect(remote.extraHttpsNames).to.deep.equal(['extra']);
            const [first, second] = await Promise.all([
                remote.enableExtraHttps('extra'), remote.enableExtraHttps('extra')
            ]);
            expect(first).to.equal(second);
            const endpoint = await remote.forAnyRequest().thenReply(200, 'remote session');
            expect(await request(remote.port, primaryCA.cert)).to.equal('remote session');
            expect(await request(first, extraCA.cert)).to.equal('remote session');
            expect(await endpoint.getSeenRequests()).to.have.length(2);
            await expect(remote.enableExtraHttps('missing')).to.be.rejectedWith('Unknown HTTPS port configuration');
            await remote.stop();
            await expect(request(first, extraCA.cert)).to.be.rejected;
        } finally {
            await admin.stop();
        }
    });

    it('shares HTTP/2 rules on the extra port', async () => {
        const extra = await server.enableExtraHttps('extra');
        await server.forAnyRequest().thenReply(200, 'HTTP/2 response');
        const client = http2.connect(`https://localhost:${extra}`, { ca: extraCA.cert });
        try {
            const request = client.request({ ':path': '/' });
            request.end();
            expect((await getHttp2Body(request)).toString()).to.equal('HTTP/2 response');
        } finally {
            client.destroy();
        }
    });

    it('shares WebSocket rules on the extra port', async () => {
        const extra = await server.enableExtraHttps('extra');
        await server.forAnyWebSocket().thenEcho();
        const socket = new WebSocket(`wss://localhost:${extra}`, { ca: extraCA.cert });
        try {
            const message = await new Promise<string>((resolve, reject) => {
                socket.once('open', () => socket.send('echo'));
                socket.once('message', data => resolve(data.toString()));
                socket.once('error', reject);
            });
            expect(message).to.equal('echo');
        } finally {
            socket.close();
        }
    });

    it('closes all extra ports when the session stops', async () => {
        const first = await server.enableExtraHttps('extra');
        const second = await server.enableExtraHttps('second');
        await server.stop();
        stopped = true;
        await expect(request(first, extraCA.cert)).to.be.rejected;
        await expect(request(second, extraCA.cert)).to.be.rejected;
    });

    it('does not open a port after the session has stopped', async () => {
        const opening = server.enableExtraHttps('extra');
        const rejected = expect(opening).to.be.rejectedWith(/stopped/);
        await server.stop();
        stopped = true;
        await rejected;
    });
}));

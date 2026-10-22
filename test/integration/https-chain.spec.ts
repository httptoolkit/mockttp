import * as tls from 'tls';
import * as fs from 'fs/promises';
import * as tmp from 'tmp-promise';
import * as x509 from '@peculiar/x509';
import { getLocal, Mockttp } from '../..';
import { getCA } from '../../src/util/certificates';
import { expect, nodeOnly } from '../test-utils';

nodeOnly(() => describe('HTTPS with an intermediate CA chain', () => {
    let root: string;
    let chain: string;
    let key: string;
    let server: Mockttp | undefined;
    let directory: Awaited<ReturnType<typeof tmp.dir>>;

    before(async () => {
        // A two-intermediate EC chain, matching the structure of cross-signed CAs.
        let issuer: x509.X509Certificate | undefined;
        let issuerKey: CryptoKey | undefined;
        const certificates: string[] = [];
        for (let i = 0; i < 3; i++) {
            const keys = await crypto.subtle.generateKey(
                { name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify']
            ) as CryptoKeyPair;
            const subject = `CN=Chain CA ${i}`;
            const cert = await x509.X509CertificateGenerator.create({
                serialNumber: `0${i + 1}`,
                subject,
                issuer: issuer?.subjectName ?? subject,
                notBefore: new Date(Date.now() - 60 * 60 * 1000),
                notAfter: new Date(Date.now() + 24 * 60 * 60 * 1000),
                signingAlgorithm: { name: 'ECDSA', hash: 'SHA-384' },
                publicKey: keys.publicKey,
                signingKey: issuerKey ?? keys.privateKey,
                extensions: [
                    new x509.BasicConstraintsExtension(true, undefined, true),
                    new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true)
                ]
            });
            certificates.unshift(cert.toString('pem'));
            issuer = cert;
            issuerKey = keys.privateKey;
        }
        root = certificates[2];
        // Deliberately omit the trusted root: the client must supply it itself.
        chain = certificates.slice(0, 2).join('\n');
        key = x509.PemConverter.encode(await crypto.subtle.exportKey('pkcs8', issuerKey!), 'PRIVATE KEY');
    });

    beforeEach(async () => { directory = await tmp.dir({ unsafeCleanup: true }); });
    afterEach(async () => {
        await server?.stop();
        server = undefined;
        await directory.cleanup();
    });

    it('retains every issuer when generating certificates', async () => {
        const ca = await getCA({ key, cert: chain });
        const generated = await ca.generateCertificate('localhost');
        expect(generated.ca).to.equal(chain);
        expect(await new x509.X509Certificate(generated.cert).verify({
            publicKey: new x509.X509Certificate(chain)
        })).to.equal(true);
    });

    for (const usePaths of [false, true]) {
        for (const sni of [false, true]) {
            it(`sends all intermediate issuers using ${usePaths ? 'paths' : 'PEM data'}, ${sni ? 'with' : 'without'} SNI`, async () => {
                const keyPath = `${directory.path}/ca.key`;
                const certPath = `${directory.path}/ca.pem`;
                await fs.writeFile(keyPath, key);
                await fs.writeFile(certPath, chain);
                server = getLocal({ https: usePaths ? { keyPath, certPath } : { key, cert: chain } });
                await server.start();
                const peer = await new Promise<tls.DetailedPeerCertificate>((resolve, reject) => {
                    const socket = tls.connect({
                        host: 'localhost', port: server!.port,
                        servername: sni ? 'chain.example' : undefined,
                        ca: root, rejectUnauthorized: true
                    }, () => {
                        const cert = socket.getPeerCertificate(true);
                        socket.end();
                        resolve(cert);
                    });
                    socket.once('error', reject);
                });
                expect(peer.subject.CN).to.equal(sni ? 'chain.example' : 'localhost');
                expect(peer.issuer.CN).to.equal('Chain CA 2');
                expect(peer.issuerCertificate.issuer.CN).to.equal('Chain CA 1');
                expect(peer.issuerCertificate.issuerCertificate.issuer.CN).to.equal('Chain CA 0');
            });
        }
    }
}));

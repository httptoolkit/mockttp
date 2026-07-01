import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs/promises';
import { createPrivateKey } from 'crypto';
import * as x509 from '@peculiar/x509';

import { HardenedHttpsAgent } from 'hardened-https-agent';

import { getLocal, getCertificateTransparencyLogs } from '..';
import { expect, nodeOnly } from "./test-utils";

import { getCA, CA } from '../src/util/certificates';

const crypto = globalThis.crypto;

const SCT_OID = '1.3.6.1.4.1.11129.2.4.2';

// The log's 'usable' state timestamp. Must be in the past at verification time
// and before any SCT we issue, exactly as the on-device list must be configured.
const LOG_USABLE_SINCE = '2020-01-01T00:00:00Z';

// Builds a log list shaped exactly like Android's on-device CT log list at
// /data/misc/keychain/ct/v1/log_list.json: top-level version & timestamp, with
// each log under its own operator entry (so the two logs count as two operators).
function buildDeviceLogList(ca: CA) {
    const logDetails = ca.getCTLogDetails();
    return {
        version: '1.0',
        log_list_timestamp: new Date().toISOString(),
        operators: logDetails.map((log, i) => ({
            name: `HTTP Toolkit CT Operator ${i + 1}`,
            email: ['ct@httptoolkit.tech'] as [string, ...string[]],
            logs: [{
                description: `HTTP Toolkit CT Log ${i + 1}`,
                log_id: log.logId.toString('base64'),
                key: log.publicKey.toString('base64'),
                url: `https://ct.httptoolkit.tech/log-${i + 1}/`,
                mmd: 86400,
                state: { usable: { timestamp: LOG_USABLE_SINCE } }
            }]
        }))
    };
}

// A hardened agent verifying against our derived logs, modelling Conscrypt's
// policy for <=180-day certs: >=2 embedded SCTs from >=2 distinct operators.
function buildCTAgent(
    ca: CA,
    caCertPem: string,
    policy: { minEmbeddedScts?: number, minDistinctOperators?: number } = {}
): HardenedHttpsAgent {
    return new HardenedHttpsAgent({
        ca: caCertPem,
        ctPolicy: {
            logList: buildDeviceLogList(ca),
            minEmbeddedScts: policy.minEmbeddedScts ?? 2,
            minDistinctOperators: policy.minDistinctOperators ?? 2
        },
        loggerOptions: { level: 'silent' }
    });
}

function requestThroughAgent(url: string, agent: HardenedHttpsAgent): Promise<string> {
    return new Promise((resolve, reject) => {
        https.get(url, { agent }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

nodeOnly(() => {
    describe("Certificate Transparency", () => {
        const caKey = fs.readFile(path.join(__dirname, 'fixtures', 'test-ca.key'), 'utf8');
        const caCert = fs.readFile(path.join(__dirname, 'fixtures', 'test-ca.pem'), 'utf8');

        it("does not include SCTs when CT is not enabled", async () => {
            const ca = await getCA({ key: await caKey, cert: await caCert });
            const { cert } = await ca.generateCertificate('localhost');
            const certObj = new x509.X509Certificate(cert);
            expect(certObj.getExtension(SCT_OID)).to.equal(null);
        });

        it("derives deterministic CT log keys from the CA certificate", async () => {
            const ca1 = await getCA({ key: await caKey, cert: await caCert, certificateTransparency: true });
            const ca2 = await getCA({ key: await caKey, cert: await caCert, certificateTransparency: true });
            const logs1 = ca1.getCTLogDetails();
            const logs2 = ca2.getCTLogDetails();
            expect(logs1[0].logId).to.deep.equal(logs2[0].logId);
            expect(logs1[1].logId).to.deep.equal(logs2[1].logId);
            expect(logs1[0].logId).to.not.deep.equal(logs1[1].logId);
        });

        it("derives identical CT logs regardless of CA key encoding (PKCS#1 vs PKCS#8)", async () => {
            // Derivation seeds from the cert's SPKI, not the key PEM, so the proxy and
            // the (separately-derived) device log list agree even if the CA key is
            // stored in a different encoding on each side.
            const cert = await caCert;
            const pkcs8Key = await caKey;
            const pkcs1Key = createPrivateKey(pkcs8Key)
                .export({ format: 'pem', type: 'pkcs1' }).toString();

            const caFromPkcs8 = await getCA({ key: pkcs8Key, cert, certificateTransparency: true });
            const caFromPkcs1 = await getCA({ key: pkcs1Key, cert, certificateTransparency: true });

            const logs8 = caFromPkcs8.getCTLogDetails();
            const logs1 = caFromPkcs1.getCTLogDetails();
            expect(logs8[0].logId).to.deep.equal(logs1[0].logId);
            expect(logs8[0].publicKey).to.deep.equal(logs1[0].publicKey);
            expect(logs8[1].logId).to.deep.equal(logs1[1].logId);
        });

        it("exposes the CA's CT logs publicly (from the cert alone), matching what is embedded", async () => {
            const cert = await caCert;
            const ca = await getCA({ key: await caKey, cert, certificateTransparency: true });

            const published = getCertificateTransparencyLogs(cert);
            const embedded = ca.getCTLogDetails();

            expect(published).to.have.length(2);
            expect(published[0].logId).to.have.length(32); // SHA-256 of the SPKI
            expect(published[0].logId).to.deep.equal(embedded[0].logId);
            expect(published[0].publicKey).to.deep.equal(embedded[0].publicKey);
            expect(published[1].logId).to.deep.equal(embedded[1].logId);
            expect(published[1].publicKey).to.deep.equal(embedded[1].publicKey);

            // usableSince is the CA cert's notBefore (safe: <= every backdated SCT):
            const caNotBefore = new x509.X509Certificate(cert).notBefore;
            expect(published[0].usableSince.getTime()).to.equal(caNotBefore.getTime());
            expect(published[1].usableSince.getTime()).to.equal(caNotBefore.getTime());
        });

        it("getCTLogDetails throws when CT is not enabled", async () => {
            const ca = await getCA({ key: await caKey, cert: await caCert });
            expect(() => ca.getCTLogDetails()).to.throw('CT not enabled');
        });

        it("backdates SCT timestamps by ~24h for clock-skew tolerance", async () => {
            const ca = await getCA({ key: await caKey, cert: await caCert, certificateTransparency: true });
            const now = Date.now();
            const { cert } = await ca.generateCertificate('localhost');

            const ext = new x509.X509Certificate(cert).getExtension(SCT_OID)!;
            const extBytes = Buffer.from(ext.value);
            // In each SCT the 8-byte timestamp immediately follows the 32-byte logId.
            const logId = ca.getCTLogDetails()[0].logId;
            const timestamp = Number(extBytes.readBigUInt64BE(extBytes.indexOf(logId) + logId.length));

            const backdateMs = now - timestamp;
            expect(backdateMs).to.be.greaterThan(23 * 60 * 60 * 1000);
            expect(backdateMs).to.be.lessThan(25 * 60 * 60 * 1000);
        });

        it("embeds SCTs and signs validly with ECDSA CAs (P-256/384/521)", async () => {
            // Exercises the signature-mode proto build (placeholderSignature must be
            // sized per curve) and the ECDSA re-signing path, for each supported curve.
            for (const [namedCurve, hash] of [
                ['P-256', 'SHA-256'], ['P-384', 'SHA-384'], ['P-521', 'SHA-512']
            ] as const) {
                const keys = await crypto.subtle.generateKey(
                    { name: 'ECDSA', namedCurve }, true, ['sign', 'verify']
                ) as CryptoKeyPair;
                const ecCaCert = await x509.X509CertificateGenerator.createSelfSigned({
                    serialNumber: 'A1', name: `CN=EC ${namedCurve} Test CA`,
                    notBefore: new Date(Date.now() - 3600e3), notAfter: new Date(Date.now() + 86400e3),
                    signingAlgorithm: { name: 'ECDSA', hash }, keys,
                    extensions: [
                        new x509.BasicConstraintsExtension(true, undefined, true),
                        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true)
                    ]
                });
                const key = x509.PemConverter.encode(
                    await crypto.subtle.exportKey('pkcs8', keys.privateKey), 'PRIVATE KEY'
                );

                const ca = await getCA({ key, cert: ecCaCert.toString('pem'), certificateTransparency: true });
                const { cert } = await ca.generateCertificate('localhost');
                const leaf = new x509.X509Certificate(cert);

                expect(leaf.getExtension(SCT_OID), namedCurve).to.not.equal(null);
                expect(leaf.signatureAlgorithm.name).to.equal('ECDSA');
                expect(await leaf.verify({ publicKey: ecCaCert.publicKey, signatureOnly: true }), namedCurve)
                    .to.equal(true);
            }
        });

        it("issues certificates within the <=180-day, 2-SCT validity regime", async () => {
            // Conscrypt requires 3 SCTs for certs valid >180 days, but only 2 at
            // or below 180 days. Our 2-log setup is only sufficient if we stay in
            // that regime, so lock the invariant here.
            const ca = await getCA({ key: await caKey, cert: await caCert, certificateTransparency: true });
            const { cert } = await ca.generateCertificate('localhost');
            const certObj = new x509.X509Certificate(cert);
            const lifetimeDays =
                (certObj.notAfter.getTime() - certObj.notBefore.getTime()) / (24 * 60 * 60 * 1000);
            expect(lifetimeDays).to.be.at.most(180);
        });

        async function expectRejected(url: string, agent: HardenedHttpsAgent) {
            try {
                await requestThroughAgent(url, agent);
                expect.fail('Connection should have been rejected by the CT policy');
            } catch (err) {
                expect((err as Error).message)
                    .to.match(/socket hang up|ECONNRESET|certificate|SCT|operator/i);
            } finally {
                agent.destroy();
            }
        }

        describe("against a CT-enabled Mockttp server", () => {
            const server = getLocal({
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem',
                    certificateTransparency: true
                }
            });

            // The server owns its CA internally; we re-derive the same (deterministic)
            // logs out-of-band to build the verifier's log list.
            let ca: CA;
            let caCertPem: string;

            beforeEach(async () => {
                caCertPem = await caCert;
                ca = await getCA({ key: await caKey, cert: caCertPem, certificateTransparency: true });
                await server.start();
                await server.forGet('/').thenReply(200, 'CT verified!');
            });

            afterEach(() => server.stop());

            it("accepts a cert with 2 SCTs from 2 operators", async () => {
                const agent = buildCTAgent(ca, caCertPem);
                try {
                    expect(await requestThroughAgent(server.url, agent)).to.equal('CT verified!');
                } finally {
                    agent.destroy();
                }
            });

            it("is rejected by a stricter 3-SCT policy (the >180-day regime)", async () => {
                // Documents the boundary: if our certs were valid >180 days, Conscrypt
                // would demand 3 SCTs and our 2-log setup would (correctly) fail here.
                await expectRejected(server.url, buildCTAgent(ca, caCertPem, { minEmbeddedScts: 3 }));
            });

            it("is rejected by a 3-distinct-operator policy", async () => {
                await expectRejected(server.url, buildCTAgent(ca, caCertPem, { minDistinctOperators: 3 }));
            });
        });

        describe("against a non-CT Mockttp server", () => {
            const server = getLocal({
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem'
                }
            });

            beforeEach(async () => {
                await server.start();
                await server.forGet('/').thenReply(200, 'should not reach');
            });

            afterEach(() => server.stop());

            it("is rejected when CT is required but the cert has no SCTs", async () => {
                const caCertPem = await caCert;
                const ctCA = await getCA({ key: await caKey, cert: caCertPem, certificateTransparency: true });
                await expectRejected(server.url, buildCTAgent(ctCA, caCertPem));
            });
        });
    });
});

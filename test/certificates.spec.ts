import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs/promises';
import { createPrivateKey, generateKeyPairSync } from 'crypto';
import * as x509 from '@peculiar/x509';

import {
    DestroyableServer,
    makeDestroyable,
    expect,
    nodeOnly
} from "./test-utils";

import { getCA, CA, generateCACertificate, generateSPKIFingerprint } from '../src/util/certificates';

// We use public pkimet.al for local dev, CI uses a self-hosted version for reliability
const LINTCERT_URL = `${process.env.PKIMETAL_BASE_URL ?? 'https://pkimet.al'}/lintcert`;

const validateLintSiteCertResults = (cert: string, results: any[]) => {
    // We don't worry about warnings
    const errors = results.filter((result: any) => result.Severity !== 'warning');
    // We don't worry about OCSP/CRL/AIA issues, since we can't include a URL to fully
    // support these in any practical way. In future, these may be optional for short-lived
    // certs, so we could reduce our leaf cert lifetimes to avoid these issues.
    const ignoredErrors = errors.filter((result: any) => {
        return result.Finding?.includes('OCSP') ||
            result.Finding?.toLowerCase().includes('crl') ||
            result.Finding?.includes('authorityInformationAccess') ||
            result.Code?.includes('authority_info_access')
    });

    const failures = errors.filter((result: any) => !ignoredErrors.includes(result));
    const warnings = results.filter((result: any) => !failures.includes(result));

    if (warnings.length || failures.length) console.log('Cert:', cert);
    if (warnings.length) console.log('Cert warnings:', warnings);
    if (failures.length) console.log('FAILURES:', warnings);

    expect(failures).to.deep.equal([]);
};

nodeOnly(() => {
    describe("Certificate generation", () => {
        const caKey = fs.readFile(path.join(__dirname, 'fixtures', 'test-ca.key'), 'utf8');
        const caCert = fs.readFile(path.join(__dirname, 'fixtures', 'test-ca.pem'), 'utf8');

        let server: DestroyableServer<https.Server> | undefined;

        afterEach(async () => {
            await server?.destroy();
            server = undefined;
        });

        it("can generate a certificate for a domain", async () => {
            const ca = await getCA({ key: await caKey, cert: await caCert, keyLength: 2048 });

            const { cert, key } = await ca.generateCertificate('localhost')

            server = makeDestroyable(https.createServer({ cert, key }, (req: any, res: any) => {
                res.writeHead(200);
                res.end('signed response!');
            }));

            await new Promise<void>((resolve) => server!.listen(4430, resolve));

            await expect(fetch('https://localhost:4430')).to.have.responseText('signed response!');
        });

        it("can calculate the SPKI fingerprint for a certificate", async () => {
            const ca = await getCA({ key: await caKey, cert: await caCert, keyLength: 2048 });

            const { cert } = await ca.generateCertificate('localhost');

            const caFingerprint = await generateSPKIFingerprint(await caCert);
            const certFingerprint = await generateSPKIFingerprint(cert);

            expect(caFingerprint).not.to.equal(certFingerprint);
        });

        it("can use a PKCS#1 RSA private key as a CA", async () => {
            // We only need these for backward compatibility, but it is generally good practice to
            // be able to handle this properly, and very convenient if you currently have one.
            await getCA({
                keyPath: path.join(__dirname, 'fixtures', 'ca-pkcs1.key'),
                certPath: path.join(__dirname, 'fixtures', 'ca-pkcs1.pem'),
            });
        });

        it("can sign certificates with both PKCS#8 and PKCS#1 RSA CA keys", async () => {
            const generatedCA = await generateCACertificate();

            const pkcs8Key = generatedCA.key;
            expect(pkcs8Key.split('\n')[0]).to.equal('-----BEGIN PRIVATE KEY-----');

            const pkcs1Key = createPrivateKey(pkcs8Key)
                .export({ type: 'pkcs1', format: 'pem' })
                .toString();
            expect(pkcs1Key.split('\n')[0]).to.equal('-----BEGIN RSA PRIVATE KEY-----');

            const parsedCaCert = new x509.X509Certificate(generatedCA.cert);

            for (const key of [pkcs8Key, pkcs1Key]) {
                const ca = await getCA({ key, cert: generatedCA.cert, keyLength: 2048 });
                const { cert } = await ca.generateCertificate('example.com');

                const leafCert = new x509.X509Certificate(cert);
                expect(await leafCert.verify({ publicKey: parsedCaCert })).to.equal(true);
            }
        });

        // We only ever generate RSA CAs by default, but we support external
        // EC CAs for use elsewhere:
        async function generateEcCA(namedCurve: 'P-256' | 'P-384' | 'P-521') {
            const keys = await crypto.subtle.generateKey(
                { name: 'ECDSA', namedCurve },
                true,
                ['sign', 'verify']
            ) as CryptoKeyPair;

            const cert = await x509.X509CertificateGenerator.createSelfSigned({
                serialNumber: 'A1',
                name: 'CN=EC Test CA',
                notBefore: new Date(Date.now() - 60 * 60 * 1000),
                notAfter: new Date(Date.now() + 24 * 60 * 60 * 1000),
                signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
                keys,
                extensions: [
                    new x509.BasicConstraintsExtension(true, undefined, true),
                    new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true)
                ]
            });

            const key = x509.PemConverter.encode(
                await crypto.subtle.exportKey('pkcs8', keys.privateKey),
                'PRIVATE KEY'
            );

            return { key, cert: cert.toString('pem') };
        }

        it("can use an EC (P-256) CA to sign certificates for HTTPS interception", async () => {
            const ecCA = await generateEcCA('P-256');
            const ca = await getCA({ key: ecCA.key, cert: ecCA.cert });

            const { cert, key } = await ca.generateCertificate('localhost');

            // The leaf keeps an RSA key, but is signed by the EC CA:
            const leafCert = new x509.X509Certificate(cert);
            expect(leafCert.signatureAlgorithm.name).to.equal('ECDSA');
            expect(leafCert.publicKey.algorithm.name).to.equal('RSASSA-PKCS1-v1_5');
            expect(await leafCert.verify({
                publicKey: new x509.X509Certificate(ecCA.cert)
            })).to.equal(true);

            server = makeDestroyable(https.createServer({ cert, key }, (req: any, res: any) => {
                res.writeHead(200);
                res.end('ec-signed response!');
            }));
            await new Promise<void>((resolve) => server!.listen(4430, resolve));

            const response = await new Promise<string>((resolve, reject) => {
                const req = https.request({
                    hostname: 'localhost',
                    port: 4430,
                    ca: [ecCA.cert]
                }, (res) => {
                    let data = '';
                    res.on('data', (d) => { data += d; });
                    res.on('end', () => resolve(data));
                });
                req.on('error', reject);
                req.end();
            });
            expect(response).to.equal('ec-signed response!');
        });

        it("can use P-384 & P-521 EC CA keys, with matching signature hashes", async () => {
            for (const [curve, expectedHash] of [['P-384', 'SHA-384'], ['P-521', 'SHA-512']] as const) {
                const ecCA = await generateEcCA(curve);
                const ca = await getCA({ key: ecCA.key, cert: ecCA.cert });

                const { cert } = await ca.generateCertificate('example.com');

                const leafCert = new x509.X509Certificate(cert);
                const signatureAlgorithm = leafCert.signatureAlgorithm as EcdsaParams;
                expect(signatureAlgorithm.name).to.equal('ECDSA');
                expect((signatureAlgorithm.hash as Algorithm).name).to.equal(expectedHash);
                expect(await leafCert.verify({
                    publicKey: new x509.X509Certificate(ecCA.cert)
                })).to.equal(true);
            }
        });

        it("can use a SEC1 'BEGIN EC PRIVATE KEY' PEM as a CA key", async () => {
            const ecCA = await generateEcCA('P-256');

            const sec1Key = createPrivateKey(ecCA.key)
                .export({ type: 'sec1', format: 'pem' })
                .toString();
            expect(sec1Key.split('\n')[0]).to.equal('-----BEGIN EC PRIVATE KEY-----');

            const ca = await getCA({ key: sec1Key, cert: ecCA.cert });
            const { cert } = await ca.generateCertificate('example.com');

            const leafCert = new x509.X509Certificate(cert);
            expect(await leafCert.verify({
                publicKey: new x509.X509Certificate(ecCA.cert)
            })).to.equal(true);
        });

        it("rejects unsupported CA keys with a clear error", async () => {
            const generatedCA = await generateCACertificate();

            // The certs here don't need to match - keys are imported (and so rejected) first:

            const ed25519Key = generateKeyPairSync('ed25519')
                .privateKey.export({ type: 'pkcs8', format: 'pem' })
                .toString();
            await expect(
                getCA({ key: ed25519Key, cert: generatedCA.cert })
            ).to.be.rejectedWith("only RSA & EC CA keys are supported");

            const secp256k1Key = generateKeyPairSync('ec', { namedCurve: 'secp256k1' })
                .privateKey.export({ type: 'pkcs8', format: 'pem' })
                .toString();
            await expect(
                getCA({ key: secp256k1Key, cert: generatedCA.cert })
            ).to.be.rejectedWith("only P-256, P-384 & P-521 are supported");
        });

        describe("with a constrained CA", () => {
            let constrainedCA: CA;
            let constrainedCaCert: string;

            function localhostRequest({ hostname, port }: { hostname: string; port: number }) {
                return https.request({
                    hostname,
                    port,
                    ca: [constrainedCaCert],
                    lookup: (_, options, callback) => {
                        if (options.all) {
                            callback(null, [{ address: "127.0.0.1", family: 4 }]);
                        } else {
                            callback(null, "127.0.0.1", 4);
                        }
                    },
                });
            }

            beforeEach(async () => {
                const rootCa = await generateCACertificate({
                    nameConstraints: { permitted: ["example.com"] },
                });
                constrainedCaCert = rootCa.cert;
                constrainedCA = await getCA(rootCa);
            });

            it("can generate a valid certificate for a domain included in a constrained CA", async () => {
                const { cert, key } = await constrainedCA.generateCertificate("hello.example.com");

                server = makeDestroyable(https.createServer({ cert, key }, (req: any, res: any) => {
                    res.writeHead(200);
                    res.end("signed response!");
                }));
                await new Promise<void>((resolve) => server!.listen(4430, resolve));

                const req = localhostRequest({hostname: "hello.example.com", port: 4430});
                return new Promise<void>((resolve, reject) => {
                    req.on("response", (res) => {
                        expect(res.statusCode).to.equal(200);
                        res.on("data", (data) => {
                            expect(data.toString()).to.equal("signed response!");
                            resolve();
                        });
                    });
                    req.on("error", (err) => {
                        reject(err);
                    });
                    req.end();
                });
            });

            it("can not generate a valid certificate for a domain not included in a constrained CA", async () => {
                const { cert, key } = await constrainedCA.generateCertificate("hello.other.com");

                server = makeDestroyable(https.createServer({ cert, key }, (req: any, res: any) => {
                    res.writeHead(200);
                    res.end("signed response!");
                }));
                await new Promise<void>((resolve) => server!.listen(4430, resolve));

                const req = localhostRequest({hostname: "hello.other.com", port: 4430});
                return new Promise<void>((resolve) => {
                    req.on("error", (err) => {
                        expect(err.message).to.equal("permitted subtree violation");
                        resolve();
                    });
                    req.on("response", (res) => {
                        expect.fail("Unexpected response received");
                    });
                    req.end();
                });
            });
        });
    });

    describe("CA certificate generation", () => {

        const caCertificatePromise = generateCACertificate();

        it("should be able to generate a CA certificate", async () => {
            const caCertificate = await caCertificatePromise;

            expect(caCertificate.cert.length).to.be.greaterThan(1000);
            expect(caCertificate.cert.split('\n')[0]).to.equal('-----BEGIN CERTIFICATE-----');
            expect(caCertificate.key.length).to.be.greaterThan(1000);
            expect(caCertificate.key.split('\n')[0]).to.equal('-----BEGIN PRIVATE KEY-----');
        });

        it("should generate a CA certificate that can be used to create domain certificates", async () => {
            const caCertificate = await caCertificatePromise;
            const ca = await getCA({ key: caCertificate.key, cert: caCertificate.cert, keyLength: 1024 });

            const { cert, key, expiresAt } = await ca.generateCertificate('localhost');

            expect(cert.length).to.be.greaterThan(1000);
            expect(cert.split('\n')[0]).to.equal('-----BEGIN CERTIFICATE-----');
            expect(key.length).to.be.greaterThan(500);
            expect(key.split('\n')[0]).to.equal('-----BEGIN PRIVATE KEY-----');

            const certData = new x509.X509Certificate(cert);
            const validityDays = (certData.notAfter.getTime() - certData.notBefore.getTime()) / (1000 * 60 * 60 * 24);
            expect(validityDays).to.be.at.most(45);
            expect(validityDays).to.be.at.least(43);

            // expiresAt should match the cert's notAfter (within 1s - cert times have second precision)
            expect(Math.abs(expiresAt.getTime() - certData.notAfter.getTime())).to.be.at.most(1000);
        });

        it("should generate certs within the SC-081v3 maximum validity", async () => {
            // We target the strictest SC-081v3 phase (47 days from 2029-03-15) already
            const caCertificate = await caCertificatePromise;
            const ca = await getCA({ key: caCertificate.key, cert: caCertificate.cert, keyLength: 1024 });

            const { cert } = await ca.generateCertificate('localhost');
            const certData = new x509.X509Certificate(cert);
            const validityDays = (certData.notAfter.getTime() - certData.notBefore.getTime()) / (1000 * 60 * 60 * 24);
            expect(validityDays).to.be.at.most(47);
        });

        it("should be able to generate a CA certificate that passes lintcert checks", async function () {
            const caCertificate = await caCertificatePromise;

            const { cert } = caCertificate;

            const response = await fetch(LINTCERT_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    'b64input': cert,
                    'format': 'json',
                    'severity': 'warning',
                    'profile': 'tbr_root_tlsserver' // TLS Baseline root CA
                })
            });

            expect(response.status).to.equal(200);
            const results = await response.json();
            validateLintSiteCertResults(cert, results);
        });

        it("should generate CA certs that can be used to create domain certs that pass lintcert checks", async function () {
            this.timeout(5000); // Large cert + remote request can make this slow

            const caCertificate = await caCertificatePromise;
            const ca = await getCA({ key: caCertificate.key, cert: caCertificate.cert, keyLength: 2048 });

            const { cert } = await ca.generateCertificate('httptoolkit.com');

            const certData = new x509.X509Certificate(cert);
            const altNameExtension = certData.getExtension('2.5.29.17') as x509.SubjectAlternativeNameExtension;
            expect(altNameExtension.names.items.map(({ type, value }) => ({ type, value }))).to.deep.equal([
                { type: 'dns', 'value': 'httptoolkit.com' },
            ]);

            const response = await fetch(LINTCERT_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    'b64input': cert,
                    'format': 'json',
                    'severity': 'warning',
                    'profile': 'tbr_leaf_tlsserver_dv' // TLS Baseline domain-validated server
                })
            });

            expect(response.status).to.equal(200);
            const results = await response.json();
            validateLintSiteCertResults(cert, results);
        });

        it("should generate wildcard certs that pass lintcert checks for invalid subdomain names", async function () {
            this.timeout(10_000); // Large cert + remote request can make this slow

            const caCertificate = await caCertificatePromise;
            const ca = await getCA({ key: caCertificate.key, cert: caCertificate.cert, keyLength: 2048 });

            const { cert } = await ca.generateCertificate('under_score.httptoolkit.com');

            const certData = new x509.X509Certificate(cert);
            const altNameExtension = certData.getExtension('2.5.29.17') as x509.SubjectAlternativeNameExtension;
            expect(altNameExtension.names.items.map(({ type, value }) => ({ type, value }))).to.deep.equal([
                { type: 'dns', 'value': '*.httptoolkit.com' },
            ]);

            const response = await fetch(LINTCERT_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    'b64input': cert,
                    'format': 'json',
                    'severity': 'warning',
                    'profile': 'tbr_leaf_tlsserver_dv' // TLS Baseline domain-validated server
                })
            });

            expect(response.status).to.equal(200);
            const results = await response.json();
            validateLintSiteCertResults(cert, results);
        });

        it("should generate a custom CA cert constrained to a domain that pass lintcert checks", async function() {
            const caCertificate = await generateCACertificate({
                subject: {
                    commonName: 'Custom CA',
                    serialNumber: '1234'
                },
                nameConstraints: {
                    permitted: ['example.com']
                }
            });

            const { cert } = caCertificate;

            const response = await fetch(LINTCERT_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    'b64input': cert,
                    'format': 'json',
                    'severity': 'warning',
                    'profile': 'tbr_root_tlsserver' // TLS Baseline root CA
                })
            });

            expect(response.status).to.equal(200);
            const results = await response.json();
            validateLintSiteCertResults(cert, results);
        });

    });
});
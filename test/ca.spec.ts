import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as x509 from '@peculiar/x509';

import {
    DestroyableServer,
    makeDestroyable,
    expect,
    fetch,
    ignoreNetworkError,
    nodeOnly
} from "./test-utils";

import { CA, generateCACertificate, generateSPKIFingerprint } from '../src/util/tls';

const validateLintSiteCertResults = (cert: string, results: any[]) => {
    // We don't worry about warnings
    const errors = results.filter((result: any) => result.Severity !== 'warning');
    // We don't worry about OCSP/CRL/AIA issues, since we can't include a URL to fully
    // support these in any practical way. In future, these may be optional for short-lived
    // certs, so we could reduce our leaf cert lifetimes to avoid these issues.
    const ignoredErrors = errors.filter((result: any) => {
        return result.Finding.includes('OCSP') ||
            result.Finding.includes('CRL') ||
            result.Finding.includes('authorityInformationAccess') ||
            result.Code.includes('authority_info_access')
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
            const ca = new CA({ key: await caKey, cert: await caCert, keyLength: 2048 });

            const { cert, key } = await ca.generateCertificate('localhost')

            server = makeDestroyable(https.createServer({ cert, key }, (req: any, res: any) => {
                res.writeHead(200);
                res.end('signed response!');
            }));

            await new Promise<void>((resolve) => server!.listen(4430, resolve));

            await expect(fetch('https://localhost:4430')).to.have.responseText('signed response!');
        });

        it("can calculate the SPKI fingerprint for a certificate", async () => {
            const ca = new CA({ key: await caKey, cert: await caCert, keyLength: 2048 });

            const { cert } = await ca.generateCertificate('localhost');

            const caFingerprint = await generateSPKIFingerprint(await caCert);
            const certFingerprint = await generateSPKIFingerprint(cert);

            expect(caFingerprint).not.to.equal(certFingerprint);
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
                constrainedCA = new CA(rootCa);
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
            const ca = new CA({ key: caCertificate.key, cert: caCertificate.cert, keyLength: 1024 });

            const { cert, key } = await ca.generateCertificate('localhost');

            expect(cert.length).to.be.greaterThan(1000);
            expect(cert.split('\n')[0]).to.equal('-----BEGIN CERTIFICATE-----');
            expect(key.length).to.be.greaterThan(1000);
            expect(key.split('\n')[0]).to.equal('-----BEGIN PRIVATE KEY-----');
        });

        it("should be able to generate a CA certificate that passes lintcert checks", async function () {
            const caCertificate = await caCertificatePromise;

            const { cert } = caCertificate;

            const response = await ignoreNetworkError(
                fetch('https://pkimet.al/lintcert', {
                    method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        'b64input': cert,
                        'format': 'json',
                        'severity': 'warning',
                        'profile': 'tbr_root_tlsserver' // TLS Baseline root CA
                    })
                }),
                { context: this }
            );

            expect(response.status).to.equal(200);
            const results = await response.json();
            validateLintSiteCertResults(cert, results);
        });

        it("should generate CA certs that can be used to create domain certs that pass lintcert checks", async function () {
            this.timeout(5000); // Large cert + remote request can make this slow

            const caCertificate = await caCertificatePromise;
            const ca = new CA({ key: caCertificate.key, cert: caCertificate.cert, keyLength: 2048 });

            const { cert } = await ca.generateCertificate('httptoolkit.com');

            const certData = new x509.X509Certificate(cert);
            const altNameExtension = certData.getExtension('2.5.29.17') as x509.SubjectAlternativeNameExtension;
            expect(altNameExtension.names.items.map(({ type, value }) => ({ type, value }))).to.deep.equal([
                { type: 'dns', 'value': 'httptoolkit.com' },
            ]);

            const response = await ignoreNetworkError(
                fetch('https://pkimet.al/lintcert', {
                    method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        'b64input': cert,
                        'format': 'json',
                        'severity': 'warning',
                        'profile': 'tbr_leaf_tlsserver_dv' // TLS Baseline domain-validated server
                    })
                }),
                { context: this }
            );

            expect(response.status).to.equal(200);
            const results = await response.json();
            validateLintSiteCertResults(cert, results);
        });

        it("should generate wildcard certs that pass lintcert checks for invalid subdomain names", async function () {
            this.timeout(10_000); // Large cert + remote request can make this slow

            const caCertificate = await caCertificatePromise;
            const ca = new CA({ key: caCertificate.key, cert: caCertificate.cert, keyLength: 2048 });

            const { cert } = await ca.generateCertificate('under_score.httptoolkit.com');

            const certData = new x509.X509Certificate(cert);
            const altNameExtension = certData.getExtension('2.5.29.17') as x509.SubjectAlternativeNameExtension;
            expect(altNameExtension.names.items.map(({ type, value }) => ({ type, value }))).to.deep.equal([
                { type: 'dns', 'value': '*.httptoolkit.com' },
            ]);

            const response = await ignoreNetworkError(
                fetch('https://pkimet.al/lintcert', {
                    method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        'b64input': cert,
                        'format': 'json',
                        'severity': 'warning',
                        'profile': 'tbr_leaf_tlsserver_dv' // TLS Baseline domain-validated server
                    })
                }),
                { context: this, timeout: 9000 }
            );

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

            const response = await ignoreNetworkError(
                fetch('https://pkimet.al/lintcert', {
                    method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        'b64input': cert,
                        'format': 'json',
                        'severity': 'warning',
                        'profile': 'tbr_root_tlsserver' // TLS Baseline root CA
                    })
                }),
                { context: this }
            );

            expect(response.status).to.equal(200);
            const results = await response.json();
            validateLintSiteCertResults(cert, results);
        });

    });
});
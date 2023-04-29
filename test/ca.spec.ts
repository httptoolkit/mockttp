import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as forge from 'node-forge';

import { expect, fetch, ignoreNetworkError, nodeOnly } from "./test-utils";

import { CA, generateCACertificate } from '../src/util/tls';

nodeOnly(() => {
    describe("Certificate generation", () => {
        const caKey = fs.readFile(path.join(__dirname, 'fixtures', 'test-ca.key'), 'utf8');
        const caCert = fs.readFile(path.join(__dirname, 'fixtures', 'test-ca.pem'), 'utf8');

        let server: https.Server;

        it("can generate a certificate for a domain", async () => {
            const ca = new CA({ key: await caKey, cert: await caCert, keyLength: 2048 });

            const { cert, key } = ca.generateCertificate('localhost')

            server = https.createServer({ cert, key }, (req: any, res: any) => {
                res.writeHead(200);
                res.end('signed response!');
            });

            await new Promise<void>((resolve) => server.listen(4430, resolve));

            await expect(fetch('https://localhost:4430')).to.have.responseText('signed response!');
        });

        afterEach((done) => {
            if (server) server.close(done);
        });
    });

    describe("CA certificate generation", () => {

        const caCertificatePromise = generateCACertificate();

        it("should be able to generate a CA certificate", async () => {
            const caCertificate = await caCertificatePromise;

            expect(caCertificate.cert.length).to.be.greaterThan(1000);
            expect(caCertificate.cert.split('\r\n')[0]).to.equal('-----BEGIN CERTIFICATE-----');
            expect(caCertificate.key.length).to.be.greaterThan(1000);
            expect(caCertificate.key.split('\r\n')[0]).to.equal('-----BEGIN RSA PRIVATE KEY-----');
        });

        it("should generate a CA certificate that can be used to create domain certificates", async () => {
            const caCertificate = await caCertificatePromise;
            const ca = new CA({ key: caCertificate.key, cert: caCertificate.cert, keyLength: 1024 });

            const { cert, key } = ca.generateCertificate('localhost');

            expect(caCertificate.cert.length).to.be.greaterThan(1000);
            expect(caCertificate.cert.split('\r\n')[0]).to.equal('-----BEGIN CERTIFICATE-----');
            expect(caCertificate.key.length).to.be.greaterThan(1000);
            expect(caCertificate.key.split('\r\n')[0]).to.equal('-----BEGIN RSA PRIVATE KEY-----');
        });

        it("should be able to generate a CA certificate that passes lintcert checks", async function () {
            this.retries(3); // Remote server can be unreliable

            const caCertificate = await caCertificatePromise;

            const { cert } = caCertificate;

            const response = await ignoreNetworkError(
                fetch('https://crt.sh/lintcert', {
                    method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({'b64cert': cert})
                }),
                { context: this }
            );

            const lintOutput = await response.text();

            const lintResults = lintOutput
                .split('\n')
                .map(line => line.split('\t').slice(1))
                .filter(line => line.length > 1);

            const errors = lintResults
                .filter(([level]) => level === 'ERROR')
                .map(([_level, message]) => message);

            expect(errors.join('\n')).to.equal('');
        });

        it("should generate CA certs that can be used to create domain certs that pass lintcert checks", async function () {
            this.timeout(5000); // Large cert + remote request can make this slow
            this.retries(3); // Remote server can be unreliable

            const caCertificate = await caCertificatePromise;
            const ca = new CA({ key: caCertificate.key, cert: caCertificate.cert, keyLength: 2048 });

            const { cert } = ca.generateCertificate('httptoolkit.tech');


            const certData = forge.pki.certificateFromPem(cert);
            expect((certData.getExtension('subjectAltName') as any).altNames[0].value).to.equal('httptoolkit.tech');

            const response = await ignoreNetworkError(
                fetch('https://crt.sh/lintcert', {
                    method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({'b64cert': cert})
                }),
                { context: this }
            );

            expect(response.status).to.equal(200);
            const lintOutput = await response.text();

            const lintResults = lintOutput
                .split('\n')
                .map(line => line.split('\t').slice(1))
                .filter(line => line.length > 1);

            const errors = lintResults
                .filter(([level]) => level === 'ERROR' || level === 'FATAL')
                .map(([_level, message]) => message)
                .filter((message) =>
                    // TODO: We don't yet support AIA due to https://github.com/digitalbazaar/forge/issues/988
                    // This is relatively new, tricky to support (we'd need an OCSP server), and not yet required
                    // anywhere AFAICT, so not a high priority short-term, but good to do later if possible.
                    !message.includes("OCSP") &&
                    !message.includes("authorityInformationAccess")
                );

            expect(errors.join('\n')).to.equal('');
        });

        it("should generate wildcard certs that pass lintcert checks for invalid subdomain names", async function () {
            this.timeout(5000); // Large cert + remote request can make this slow
            this.retries(3); // Remote server can be unreliable

            const caCertificate = await caCertificatePromise;
            const ca = new CA({ key: caCertificate.key, cert: caCertificate.cert, keyLength: 2048 });

            const { cert } = ca.generateCertificate('under_score.httptoolkit.tech');

            const certData = forge.pki.certificateFromPem(cert);
            expect((certData.getExtension('subjectAltName') as any).altNames[0].value).to.equal('*.httptoolkit.tech');

            const response = await ignoreNetworkError(
                fetch('https://crt.sh/lintcert', {
                    method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({'b64cert': cert})
                }),
                { context: this }
            );

            expect(response.status).to.equal(200);
            const lintOutput = await response.text();

            const lintResults = lintOutput
                .split('\n')
                .map(line => line.split('\t').slice(1))
                .filter(line => line.length > 1);

            const errors = lintResults
                .filter(([level]) => level === 'ERROR' || level === 'FATAL')
                .map(([_level, message]) => message)
                .filter((message) =>
                    // TODO: We don't yet support AIA due to https://github.com/digitalbazaar/forge/issues/988
                    // This is relatively new, tricky to support (we'd need an OCSP server), and not yet required
                    // anywhere AFAICT, so not a high priority short-term, but good to do later if possible.
                    !message.includes("OCSP") &&
                    !message.includes("authorityInformationAccess")
                );

            expect(errors.join('\n')).to.equal('');
        });

    });
});
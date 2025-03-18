import * as http from 'http';
import * as tls from 'tls';
import * as https from 'https';
import * as fs from 'fs/promises';

import { getLocal } from "../..";
import {
    expect,
    fetch,
    nodeOnly,
    delay,
    openRawSocket,
    openRawTlsSocket,
    http2ProxyRequest
} from "../test-utils";
import { streamToBuffer } from '../../src/util/buffer-utils';

describe("When configured for HTTPS", () => {
    describe("with key & cert paths", () => {
        let server = getLocal({
            https: {
                keyPath: './test/fixtures/test-ca.key',
                certPath: './test/fixtures/test-ca.pem'
            }
        });

        beforeEach(() => server.start());
        afterEach(() => server.stop());

        it("returns a HTTPS serverUrl", () => {
            expect(server.url.split('://')[0]).to.equal('https');
        });

        it("can handle HTTPS requests", async () => {
            await server.forGet('/').thenReply(200, "Super secure response");
            await expect(fetch(server.url)).to.have.responseText("Super secure response");
        });

        it("can handle HTTP requests", async () => {
            await server.forGet('/').thenReply(200, "Super secure response");
            await expect(fetch(server.url.replace('https', 'http'))).to.have.responseText("Super secure response");
        });

        it("matches HTTPS requests against protocol-less URL matchers", async () => {
            await server.forGet(`localhost:${server.port}/file.txt`).thenReply(200, 'Fake file');

            let result = await fetch(server.urlFor('/file.txt'));

            await expect(result).to.have.responseText('Fake file');
        });
    });

    nodeOnly(() => {
        // These tests can't be run in browsers since we can't configure SNI/CONNECT params:

        describe("with overriden cert parameters", () => {

            let server = getLocal({
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem',
                    defaultDomain: 'test.example',
                    countryName: 'UK',
                    localityName: 'London',
                    organizationName: 'Test Organiation'
                }
            });

            beforeEach(() => server.start());
            afterEach(() => server.stop());

            it("should use the default domain when no SNI is provided", async () => {
                const tlsSocket = tls.connect({
                    ca: await fs.readFile('./test/fixtures/test-ca.pem'),
                    key: await fs.readFile('./test/fixtures/test-ca.key'),
                    cert: await fs.readFile('./test/fixtures/test-ca.pem'),

                    host: 'localhost',
                    port: server.port,
                    rejectUnauthorized: false // Don't fail even though the hostname is wrong
                }).on('error', () => {}); // Ignore failure when this is closed later

                await new Promise((resolve) => tlsSocket.once('secureConnect', resolve));

                // The server uses the default name, when no 'servername' option is set:
                expect(tlsSocket.getPeerCertificate().subject.CN).to.equal("test.example");
                expect(tlsSocket.getPeerCertificate().subject.C).to.equal("UK");
            });

            it("should still use the SNI name if one is provided", async () => {
                const tlsSocket = tls.connect({
                    ca: await fs.readFile('./test/fixtures/test-ca.pem'),
                    key: await fs.readFile('./test/fixtures/test-ca.key'),
                    cert: await fs.readFile('./test/fixtures/test-ca.pem'),

                    host: 'localhost',
                    servername: 'sni-name.example', // <-- Set a name via SNI
                    port: server.port,
                    rejectUnauthorized: false // Don't fail even though the hostname is wrong
                }).on('error', () => {}); // Ignore failure when this is closed later

                await new Promise((resolve) => tlsSocket.once('secureConnect', resolve));

                // The SNI name is used, not the default:
                expect(tlsSocket.getPeerCertificate().subject.CN).to.equal("sni-name.example");
                expect(tlsSocket.getPeerCertificate().subject.C).to.equal("UK");
            });

        });

        describe("with some hostnames excluded", () => {

            let server = getLocal({
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem',
                    tlsPassthrough: [
                        { hostname: 'example.com' },
                        // A convenient server that doesn't require SNI to serve the right cert:
                        { hostname: 'ip-api.com' }
                    ]
                }
            });

            beforeEach(async () => {
                await server.start();
                await server.forGet('/').thenReply(200, "Mock response");
            });

            afterEach(async () => {
                await server.stop()
            });

            it("still handles non-matching HTTPS requests", async () => {
                const response: http.IncomingMessage = await new Promise((resolve) =>
                    https.get({ port: server.port }).on('response', resolve)
                );

                expect(response.statusCode).to.equal(200);
                const body = (await streamToBuffer(response)).toString();
                expect(body).to.equal("Mock response");
            });

            it("skips the server for matching HTTPS requests", async function () {
                this.retries(3); // Example.com can be unreliable

                const response: http.IncomingMessage = await new Promise((resolve, reject) =>
                    https.get({
                        host: 'localhost',
                        port: server.port,
                        servername: 'example.com',
                        headers: { 'Host': 'example.com' }
                    }).on('response', resolve).on('error', reject)
                );

                expect(response.statusCode).to.equal(200);
                const body = (await streamToBuffer(response)).toString();
                expect(body).to.include(
                    "This domain is for use in illustrative examples in documents."
                );
            });

            it("still handles matching direct plain-HTTP requests", async () => {
                const response: http.IncomingMessage = await new Promise((resolve) =>
                    http.get({
                        port: server.port,
                        headers: { 'Host': 'example.com' }
                    }).on('response', resolve)
                );

                expect(response.statusCode).to.equal(200);
                const body = (await streamToBuffer(response)).toString();
                expect(body).to.equal("Mock response");
            });

            it("still accepts TLS connections with other SNI", async () => {
                const tlsSocket = await openRawTlsSocket(server, {
                    rejectUnauthorized: false,
                    servername: 'unmatched.example'
                });

                const cert = tlsSocket.getPeerCertificate();
                expect(cert.subject.CN).to.equal('unmatched.example');
                expect(cert.issuer.CN).to.include('Mockttp');
            });

            it("still accepts TLS connections without SNI", async () => {
                const tlsSocket = await openRawTlsSocket(server);

                const cert = tlsSocket.getPeerCertificate();
                expect(cert.subject.CN).to.equal('localhost');
                expect(cert.issuer.CN).to.include('Mockttp');
            });

            it("bypasses Mockttp for TLS connections with matching SNI", async () => {
                const tlsSocket = await openRawTlsSocket(server, {
                    servername: 'example.com'
                });

                const cert = tlsSocket.getPeerCertificate();
                expect(cert.subject.CN).to.equal('*.example.com');
                expect(cert.issuer.CN).to.include('DigiCert'); // <-- This is the real issuer, right now at least
            });

            it("bypasses Mockttp for TLS connections inside matching HTTP/1 CONNECT tunnel", async () => {
                const tunnel = await openRawSocket(server);

                tunnel.write('CONNECT ip-api.com:443 HTTP/1.1\r\n\r\n');

                await delay(50);

                const result = tunnel.read();
                expect(result.toString()).to.equal('HTTP/1.1 200 OK\r\n\r\n');

                const tlsSocket = await openRawTlsSocket(tunnel, {
                    host: 'ip-api.com',
                    servername: '' // No SNI used here!
                });

                const cert = tlsSocket.getPeerCertificate();
                expect(cert.subject.CN).to.equal('*.ip-api.com');
                expect(cert.issuer.CN).to.include('Sectigo RSA Domain Validation Secure');
            });

            it("still handles matching CONNECT-tunnelled plain-HTTP requests", async () => {
                const tunnel = await openRawSocket(server);

                tunnel.write('CONNECT example.com:80 HTTP/1.1\r\n\r\n');

                await delay(50);
                const result = tunnel.read();
                expect(result.toString()).to.equal('HTTP/1.1 200 OK\r\n\r\n');

                const response: http.IncomingMessage = await new Promise((resolve) =>
                    http.get({
                        createConnection: () => tunnel,
                        headers: { 'Host': 'example.com' }
                    }).on('response', resolve)
                );

                expect(response.statusCode).to.equal(200);
                const body = (await streamToBuffer(response)).toString();
                expect(body).to.equal("Mock response"); // <-- Still intercepted by Mockttp
            });

            it("bypasses Mockttp for TLS connections inside matching HTTP/2 CONNECT tunnel", async function () {
                this.retries(3); // Example.com can be unreliable

                const response = await http2ProxyRequest(server, 'https://example.com');

                expect(response.body.toString()).to.include(
                    "This domain is for use in illustrative examples in documents."
                );
            });
        });

        describe("with wildcards hostnames excluded", () => {
            let server = getLocal({
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem',
                    tlsPassthrough: [
                        { hostname: '*.com' }
                    ]
                }
            });

            beforeEach(async () => {
                await server.start();
                await server.forGet('/').thenReply(200, "Mock response");
            });

            afterEach(async () => {
                await server.stop()
            });

            it("handles matching HTTPS requests", async () => {
                const response: http.IncomingMessage = await new Promise((resolve) =>
                    https.get({
                        host: 'localhost',
                        port: server.port,
                        servername: 'wikipedia.org',
                        headers: { 'Host': 'wikipedia.org' }
                    }).on('response', resolve)
                );

                expect(response.statusCode).to.equal(200);
                const body = (await streamToBuffer(response)).toString();
                expect(body).to.equal("Mock response");
            });

            it("skips the server for non-matching HTTPS requests", async function () {
                this.retries(3); // Example.com can be unreliable

                const response: http.IncomingMessage = await new Promise((resolve, reject) =>
                    https.get({
                        host: 'localhost',
                        port: server.port,
                        servername: 'example.com',
                        headers: { 'Host': 'example.com' }
                    }).on('response', resolve).on('error', reject)
                );

                expect(response.statusCode).to.equal(200);
                const body = (await streamToBuffer(response)).toString();
                expect(body).to.include(
                    "This domain is for use in illustrative examples in documents."
                );
            });
        });

        describe("with some hostnames included", () => {
            let server = getLocal({
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem',
                    tlsInterceptOnly: [
                        { hostname: 'wikipedia.org' }
                    ]
                }
            });

            beforeEach(async () => {
                await server.start();
                await server.forGet('/').thenReply(200, "Mock response");
            });

            afterEach(async () => {
                await server.stop()
            });

            it("handles matching HTTPS requests", async () => {
                const response: http.IncomingMessage = await new Promise((resolve) =>
                    https.get({
                        host: 'localhost',
                        port: server.port,
                        servername: 'wikipedia.org',
                        headers: { 'Host': 'wikipedia.org' }
                    }).on('response', resolve)
                );

                expect(response.statusCode).to.equal(200);
                const body = (await streamToBuffer(response)).toString();
                expect(body).to.equal("Mock response");
            });

            it("skips the server for non-matching HTTPS requests", async function () {
                this.retries(3); // Example.com can be unreliable

                const response: http.IncomingMessage = await new Promise((resolve, reject) =>
                    https.get({
                        host: 'localhost',
                        port: server.port,
                        servername: 'example.com',
                        headers: { 'Host': 'example.com' }
                    }).on('response', resolve).on('error', reject)
                );

                expect(response.statusCode).to.equal(200);
                const body = (await streamToBuffer(response)).toString();
                expect(body).to.include(
                    "This domain is for use in illustrative examples in documents."
                );
            });
        });

        describe("with wildcards hostnames included", () => {
            let server = getLocal({
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem',
                    tlsInterceptOnly: [
                        { hostname: '*.org' }
                    ]
                }
            });

            beforeEach(async () => {
                await server.start();
                await server.forGet('/').thenReply(200, "Mock response");
            });

            afterEach(async () => {
                await server.stop()
            });

            it("handles matching HTTPS requests", async () => {
                const response: http.IncomingMessage = await new Promise((resolve) =>
                    https.get({
                        host: 'localhost',
                        port: server.port,
                        servername: 'wikipedia.org',
                        headers: { 'Host': 'wikipedia.org' }
                    }).on('response', resolve)
                );

                expect(response.statusCode).to.equal(200);
                const body = (await streamToBuffer(response)).toString();
                expect(body).to.equal("Mock response");
            });

            it("skips the server for non-matching HTTPS requests", async function () {
                this.retries(3); // Example.com can be unreliable

                const response: http.IncomingMessage = await new Promise((resolve, reject) =>
                    https.get({
                        host: 'localhost',
                        port: server.port,
                        servername: 'example.com',
                        headers: { 'Host': 'example.com' }
                    }).on('response', resolve).on('error', reject)
                );

                expect(response.statusCode).to.equal(200);
                const body = (await streamToBuffer(response)).toString();
                expect(body).to.include(
                    "This domain is for use in illustrative examples in documents."
                );
            });
        });
    });

    describe("with TLS version restrictions", () => {
        const server = getLocal({
            https: {
                keyPath: './test/fixtures/test-ca.key',
                certPath: './test/fixtures/test-ca.pem',
                tlsServerOptions: {
                    minVersion: 'TLSv1.2'
                }
            }
        });

        beforeEach(async () => {
            await server.start();
            await server.forAnyRequest().thenReply(200, "Mock response");
        });

        afterEach(async () => {
            await server.stop();
        });

        it("should accept TLS 1.2 connections", async () => {
            const tlsSocket = await openRawTlsSocket(server, {
                rejectUnauthorized: false,
                minVersion: 'TLSv1.2',
                maxVersion: 'TLSv1.2'
            });

            expect(tlsSocket.getProtocol()).to.equal('TLSv1.2');
            tlsSocket.destroy();
        });

        it("should reject TLS 1.0 connections", async () => {
            try {
                await openRawTlsSocket(server, {
                    rejectUnauthorized: false,
                    minVersion: 'TLSv1',
                    maxVersion: 'TLSv1'
                });
                throw new Error('Expected connection to fail');
            } catch (e: any) {
                expect(e.code).to.include('ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION');
            }
        });

        it("should reject TLS 1.1 connections", async () => {
            try {
                await openRawTlsSocket(server, {
                    rejectUnauthorized: false,
                    minVersion: 'TLSv1.1',
                    maxVersion: 'TLSv1.1'
                });
                throw new Error('Expected connection to fail');
            } catch (e: any) {
                expect(e.code).to.include('ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION');
            }
        });

        it("should accept TLS 1.3 connections when TLS 1.2 is minimum", async () => {
            const tlsSocket = await openRawTlsSocket(server, {
                rejectUnauthorized: false,
                minVersion: 'TLSv1.3',
                maxVersion: 'TLSv1.3'
            });

            expect(tlsSocket.getProtocol()).to.equal('TLSv1.3');
            tlsSocket.destroy();
        });
    });
});

import * as fs from 'fs-extra';
import * as tls from 'tls';

import { getLocal } from "../..";
import { expect, fetch, nodeOnly } from "../test-utils";

describe("An HTTPS server", () => {
    describe("passed key & cert paths", () => {
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
            return expect(fetch(server.url)).to.have.responseText("Super secure response");
        });

        it("can handle HTTP requests", async () => {
            await server.forGet('/').thenReply(200, "Super secure response");
            return expect(fetch(server.url.replace('https', 'http'))).to.have.responseText("Super secure response");
        });

        it("matches HTTPS requests against protocol-less URL matchers", async () => {
            await server.forGet(`localhost:${server.port}/file.txt`).thenReply(200, 'Fake file');

            let result = await fetch(server.urlFor('/file.txt'));

            await expect(result).to.have.responseText('Fake file');
        });
    });

    nodeOnly(() => {
        describe("with an overriden default domain", () => {

            let server = getLocal({
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem',
                    defaultDomain: 'test.example'
                }
            });

            beforeEach(() => server.start());
            afterEach(() => server.stop());

            it("should use the default domain when no SNI is provided", async () => {
                const tlsSocket = tls.connect({
                    ca: fs.readFileSync('./test/fixtures/test-ca.pem'),
                    key: fs.readFileSync('./test/fixtures/test-ca.key'),
                    cert: fs.readFileSync('./test/fixtures/test-ca.pem'),

                    host: 'localhost',
                    port: server.port,
                    rejectUnauthorized: false // Don't fail even though the hostname is wrong
                }).on('error', () => {}); // Ignore failure when this is closed later

                await new Promise((resolve) => tlsSocket.once('secureConnect', resolve));

                // The server uses the default name, when no 'servername' option is set:
                expect(tlsSocket.getPeerCertificate().subject.CN).to.equal("test.example");
            });

            it("should still use the SNI name if one isis provided", async () => {
                const tlsSocket = tls.connect({
                    ca: fs.readFileSync('./test/fixtures/test-ca.pem'),
                    key: fs.readFileSync('./test/fixtures/test-ca.key'),
                    cert: fs.readFileSync('./test/fixtures/test-ca.pem'),

                    host: 'localhost',
                    servername: 'sni-name.example', // <-- Set a name via SNI
                    port: server.port,
                    rejectUnauthorized: false // Don't fail even though the hostname is wrong
                }).on('error', () => {}); // Ignore failure when this is closed later

                await new Promise((resolve) => tlsSocket.once('secureConnect', resolve));

                // The SNI name is used, not the default:
                expect(tlsSocket.getPeerCertificate().subject.CN).to.equal("sni-name.example");
            });

        });
    });
});
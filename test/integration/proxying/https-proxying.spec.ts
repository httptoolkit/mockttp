import _ = require("lodash");
import * as fs from 'fs-extra';
import * as https from 'https';
import * as http2 from 'http2';
import * as semver from 'semver';
import portfinder = require('portfinder');
import request = require("request-promise-native");
import * as zlib from 'zlib';

import { getLocal, Mockttp, CompletedResponse } from "../../..";
import {
    expect,
    nodeOnly,
    getDeferred,
    http2ProxyRequest,
    makeDestroyable,
    DestroyableServer,
    H2_TLS_ON_TLS_SUPPORTED,
    OLD_TLS_SUPPORTED,
    ignoreNetworkError
} from "../../test-utils";
import { CA } from "../../../src/util/tls";
import { streamToBuffer } from "../../../src/util/buffer-utils";

const INITIAL_ENV = _.cloneDeep(process.env);

nodeOnly(() => {
    describe("Mockttp when used as an HTTPS proxy", function () {

        let server = getLocal({
            https: {
                keyPath: './test/fixtures/test-ca.key',
                certPath: './test/fixtures/test-ca.pem'
            }
        });

        let remoteServer = getLocal();

        beforeEach(async () => {
            await remoteServer.start();
            await server.start();
            process.env = _.merge({}, process.env, server.proxyEnv);
        });

        afterEach(async () => {
            await server.stop();
            await remoteServer.stop();
            process.env = INITIAL_ENV;
        });

        describe("using request + process.env", () => {
            it("should mock proxied HTTP", async () => {
                await server.forGet("http://example.com/endpoint").thenReply(200, "mocked data");

                let response = await request.get("http://example.com/endpoint");
                expect(response).to.equal("mocked data");
            });

            it("should mock proxied HTTPS", async () => {
                await server.forGet("https://example.com/endpoint").thenReply(200, "mocked data");

                let response = await request.get("https://example.com/endpoint");
                expect(response).to.equal("mocked data");
            });

            it("should mock proxied traffic ignoring the protocol", async () => {
                await server.forGet("example.com/endpoint").thenReply(200, "mocked data");

                expect(
                    await request.get("https://example.com/endpoint")
                ).to.equal("mocked data");
                expect(
                    await request.get("http://example.com/endpoint")
                ).to.equal("mocked data");
            });

            it("should mock proxied HTTPS with a specific port", async () => {
                await server.forGet("https://example.com:1234/endpoint").thenReply(200, "mocked data");

                let response = await request.get("https://example.com:1234/endpoint");
                expect(response).to.equal("mocked data");
            });

            it("should pass through HTTPS with a non-Node.js TLS fingerprint", async function () {
                this.timeout(5000); // External service, can be slow

                await server.forAnyRequest().thenPassThrough();

                let response = await ignoreNetworkError( // External service, can be unreliable, c'est la vie
                    request.get("https://check.ja3.zone/", {
                        headers: {
                            // The hash may be recorded with the user agent that's used - we don't want the database
                            // to fill up with records that make it clear it's Mockttp's fingerprint!
                            'user-agent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:103.0) Gecko/20100101 Firefox/103.0'
                        }
                    }),
                    { context: this, timeout: 4000 }
                );

                const ja3Hash = JSON.parse(response).hash;

                // Any hash is fine, as long as it's not a super common Node.js hash:
                expect(ja3Hash).be.oneOf([
                    '66bd0ddf06e1943541373fc7283c0c00', // Node <17
                    '555d2f0593c1e23a9b59cfaa7dc0e43a' // Node 17+
                ]);
            });

            describe("given an untrusted upstream certificate", () => {

                let badServer: Mockttp;

                const certPath = './test/fixtures/untrusted-ca.pem';
                const cert = fs.readFileSync(certPath);

                beforeEach(async () => {
                    badServer = getLocal({
                        https: {
                            keyPath: './test/fixtures/untrusted-ca.key',
                            certPath
                        }
                    });
                    await badServer.start();
                });

                afterEach(() => badServer.stop());

                it("should refuse to pass through requests", async () => {
                    await badServer.forAnyRequest().thenReply(200);

                    await server.forAnyRequest().thenPassThrough();

                    let response = await request.get(badServer.url, {
                        resolveWithFullResponse: true,
                        simple: false
                    });

                    expect(response.statusCode).to.equal(502);
                });

                it("should tag failed passthrough requests", async () => {
                    await badServer.forAnyRequest().thenReply(200);
                    await server.forAnyRequest().thenPassThrough();

                    let responsePromise = getDeferred<CompletedResponse>();
                    await server.on('response', (r) => responsePromise.resolve(r));

                    await request.get(badServer.url).catch(() => {});

                    const seenResponse = await responsePromise;
                    expect(seenResponse.tags).to.deep.equal([
                        'passthrough-error:SELF_SIGNED_CERT_IN_CHAIN'
                    ]);
                });

                it("should allow passing through requests if the host is specifically listed", async () => {
                    await badServer.forAnyRequest().thenReply(200);

                    await server.forAnyRequest().thenPassThrough({
                        ignoreHostHttpsErrors: ['localhost']
                    });

                    let response = await request.get(badServer.url, {
                        resolveWithFullResponse: true,
                        simple: false
                    });

                    expect(response.statusCode).to.equal(200);
                });

                it("should refuse to pass through requests if a non-matching host is listed", async () => {
                    await badServer.forAnyRequest().thenReply(200);

                    await server.forGet(badServer.urlFor('/')).thenPassThrough({
                        ignoreHostHttpsErrors: ['differenthost']
                    });

                    let response = await request.get(badServer.url, {
                        resolveWithFullResponse: true,
                        simple: false
                    });

                    expect(response.statusCode).to.equal(502);
                });

                it("should allow passing through requests if the certificate is specifically listed", async () => {
                    await badServer.forAnyRequest().thenReply(200);

                    await server.forAnyRequest().thenPassThrough({
                        trustAdditionalCAs: [{ cert }]
                    });

                    let response = await request.get(badServer.url, {
                        resolveWithFullResponse: true,
                        simple: false
                    });

                    expect(response.statusCode).to.equal(200);
                });

                it("should allow passing through requests if the certificate path is specifically listed", async () => {
                    await badServer.forAnyRequest().thenReply(200);

                    await server.forAnyRequest().thenPassThrough({
                        trustAdditionalCAs: [{ certPath }]
                    });

                    let response = await request.get(badServer.url, {
                        resolveWithFullResponse: true,
                        simple: false
                    });

                    expect(response.statusCode).to.equal(200);
                });
            });

            describe("given a TLSv1 upstream server", () => {

                before(function () {
                    if (!semver.satisfies(process.version, OLD_TLS_SUPPORTED)) this.skip();
                });

                let oldServerPort: number;
                let oldServer: DestroyableServer<https.Server>;

                beforeEach(async () => {
                    const caKey = await fs.readFile('./test/fixtures/test-ca.key');
                    const caCert = await fs.readFile('./test/fixtures/test-ca.pem');
                    const ca = new CA(caKey, caCert, 1024);

                    const cert = ca.generateCertificate('localhost');

                    oldServer = makeDestroyable(https.createServer({
                        ...cert,
                        minVersion: 'TLSv1',
                        maxVersion: 'TLSv1',
                    }, (_req, res) => {
                        res.writeHead(200);
                        res.end('OK');
                    }));

                    oldServerPort = await portfinder.getPortPromise();
                    return new Promise<void>(async (resolve, reject) => {
                        oldServer.listen(oldServerPort, resolve);
                        oldServer.on('error', reject);
                    });
                });

                afterEach(() => {
                    if (oldServer) oldServer.destroy();
                });

                it("should refuse to pass through requests", async () => {
                    await server.forAnyRequest().thenPassThrough();

                    let response = await request.get(`https://localhost:${oldServerPort}`, {
                        resolveWithFullResponse: true,
                        simple: false
                    });

                    expect(response.statusCode).to.equal(502);
                    expect(response.body).to.include("SSL alert number 70");
                });

                it("should tag failed requests", async () => {
                    await server.forAnyRequest().thenPassThrough();

                    let responsePromise = getDeferred<CompletedResponse>();
                    await server.on('response', (r) => responsePromise.resolve(r));

                    await request.get(`https://localhost:${oldServerPort}`).catch(() => {});

                    const seenResponse = await responsePromise;
                    expect(seenResponse.tags).to.deep.equal([
                        'passthrough-error:EPROTO',
                        'passthrough-tls-error:ssl-alert-70'
                    ]);
                });

                it("should allow passing through requests if the host is specifically listed", async () => {
                    await server.forAnyRequest().thenPassThrough({
                        ignoreHostHttpsErrors: ['localhost']
                    });

                    let response = await request.get(`https://localhost:${oldServerPort}`, {
                        resolveWithFullResponse: true,
                        simple: false
                    });

                    expect(response.statusCode).to.equal(200);
                });

                it("should refuse to pass through requests if a non-matching host is listed", async () => {
                    await server.forAnyRequest().thenPassThrough({
                        ignoreHostHttpsErrors: ['differenthost']
                    });

                    let response = await request.get(`https://localhost:${oldServerPort}`, {
                        resolveWithFullResponse: true,
                        simple: false
                    });

                    expect(response.statusCode).to.equal(502);
                });
            });

            describe("talking to a target server that requires a client cert", () => {
                let authenticatingServerPort: number;
                let authenticatingServer: DestroyableServer<https.Server>;

                beforeEach(async () => {
                    const key = await fs.readFile('./test/fixtures/test-ca.key');
                    const cert = await fs.readFile('./test/fixtures/test-ca.pem');

                    authenticatingServer = makeDestroyable(https.createServer({
                        key: key,
                        cert: cert,

                        rejectUnauthorized: true,
                        requestCert: true,
                        ca: [cert]
                    }, (_req, res) => {
                        res.writeHead(200);
                        res.end('OK');
                    }));

                    authenticatingServerPort = await portfinder.getPortPromise();
                    return new Promise<void>(async (resolve, reject) => {
                        authenticatingServer.listen(authenticatingServerPort, resolve);
                        authenticatingServer.on('error', reject);
                    });
                });

                afterEach(() => {
                    authenticatingServer.destroy();
                });

                it("uses the matching client certificate for the hostname", async () => {
                    await server.forAnyRequest().thenPassThrough({
                        ignoreHostHttpsErrors: ['localhost'],
                        clientCertificateHostMap: {
                            [`localhost:${authenticatingServerPort}`]: {
                                pfx: await fs.readFile('./test/fixtures/test-ca.pfx'),
                                passphrase: 'test-passphrase'
                            }
                        }
                    });

                    let response = await request.get(`https://localhost:${authenticatingServerPort}/`);

                    expect(response).to.equal("OK");
                });
            });
        });

        describe("when making HTTP/2 requests", () => {

            before(function () {
                if (!semver.satisfies(process.version, H2_TLS_ON_TLS_SUPPORTED)) this.skip();
            });

            let http2Server: DestroyableServer<http2.Http2SecureServer>;
            let targetPort: number;

            beforeEach(async () => {
                http2Server = makeDestroyable(http2.createSecureServer({
                    allowHTTP1: false,
                    key: fs.readFileSync('./test/fixtures/test-ca.key'),
                    cert: fs.readFileSync('./test/fixtures/test-ca.pem')
                }, async (req, res) => {
                    res.writeHead(200, {
                        "received-url": req.url,
                        "received-method": req.method,
                        "received-headers": JSON.stringify(req.headers),
                        "received-body": (await streamToBuffer(req)).toString('utf8') || ''
                    });
                    res.end("Real HTTP/2 response");
                }));

                targetPort = await portfinder.getPortPromise();

                await new Promise<void>(async (resolve, reject) => {
                    http2Server.on('error', reject);
                    http2Server.listen(targetPort, resolve);
                });
            });

            afterEach(() => http2Server.destroy());

            it("can pass through requests successfully", async () => {
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost']
                });

                const response = await http2ProxyRequest(server, `https://localhost:${targetPort}`);

                expect(response.headers[':status']).to.equal(200);
                expect(response.headers['received-url']).to.equal('/');
                expect(response.body.toString('utf8')).to.equal("Real HTTP/2 response");
            });

            it("can rewrite request URLs en route", async () => {
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost'],
                    beforeRequest: (req) => {
                        expect(req.url).to.equal(`https://localhost:${targetPort}/initial-path`);

                        return {
                            url: req.url.replace('initial-path', 'replaced-path')
                        }
                    }
                });

                const response = await http2ProxyRequest(server, `https://localhost:${targetPort}/initial-path`);

                expect(response.headers[':status']).to.equal(200);
                expect(response.headers['received-url']).to.equal('/replaced-path');
            });

            it("can change the request method en route", async () => {
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost'],
                    beforeRequest: (req) => {
                        expect(req.method).to.equal('GET');
                        return { method: 'POST' };
                    }
                });

                const response = await http2ProxyRequest(server, `https://localhost:${targetPort}/`);

                expect(response.headers[':status']).to.equal(200);
                expect(response.headers['received-method']).to.equal('POST');
            });

            it("can rewrite request headers en route", async () => {
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost'],
                    beforeRequest: (req) => {
                        expect(req.headers).to.deep.equal({
                            ':scheme': 'https',
                            ':authority': `localhost:${targetPort}`,
                            ':method': 'GET',
                            ':path': '/'
                        });

                        return {
                            headers: {
                                'replacement-req-header': 'injected-value'
                            }
                        }
                    }
                });

                const response = await http2ProxyRequest(server, `https://localhost:${targetPort}/`);

                expect(response.headers[':status']).to.equal(200);

                const serverReceivedHeaders = JSON.parse(response.headers['received-headers'] as string);
                expect(serverReceivedHeaders['replacement-req-header']).to.equal('injected-value');
            });

            it("can rewrite request headers including :pseudoheaders, as long as they're not custom values", async () => {
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost'],
                    beforeRequest: (req) => {
                        expect(req.headers).to.deep.equal({
                            ':scheme': 'https',
                            ':authority': `localhost:${targetPort}`,
                            ':method': 'GET',
                            ':path': '/'
                        });

                        return {
                            method: 'POST',
                            url: req.url.replace(/\/$/, '/abc'),
                            // This still has the old values, including a now-mismatched
                            // :path, but as they're unmodified they're quietly updated automatically.
                            headers: Object.assign(req.headers, {
                                'extra-req-header': 'added-value'
                            })
                        }
                    }
                });

                const response = await http2ProxyRequest(server, `https://localhost:${targetPort}/`);

                expect(response.headers[':status']).to.equal(200);
                expect(response.headers['received-url']).to.equal('/abc');
                expect(response.headers['received-method']).to.equal('POST');
                const serverReceivedHeaders = JSON.parse(response.headers['received-headers'] as string);
                expect(serverReceivedHeaders['extra-req-header']).to.equal('added-value');
            });

            it("cannot inject custom request :path or :method pseudoheaders, even if they're correct", async () => {
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost'],
                    beforeRequest: (req) => {
                        expect(req.headers).to.deep.equal({
                            ':scheme': 'https',
                            ':authority': `localhost:${targetPort}`,
                            ':method': 'GET',
                            ':path': '/'
                        });

                        return {
                            method: 'POST',
                            url: req.url.replace(/\/$/, '/abc'),
                            headers: Object.assign(req.headers, {
                                ':path': '/abc',
                                ':method': 'POST'
                            })
                        }
                    }
                });

                const response = await http2ProxyRequest(server, `https://localhost:${targetPort}/`);

                expect(response.headers[':status']).to.equal(500);
                expect(response.body.toString()).to.match(
                    /Error: Cannot set custom (:path|:method), (:method|:path) pseudoheader values/
                );
            });

            it("can override the :scheme and :authority pseudoheaders", async () => {
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost'],
                    beforeRequest: (req) => {
                        expect(req.headers).to.deep.equal({
                            ':scheme': 'https',
                            ':authority': `localhost:${targetPort}`,
                            ':method': 'GET',
                            ':path': '/'
                        });

                        return {
                            headers: Object.assign(req.headers, {
                                ':scheme': 'magic',
                                ':authority': 'google.com'
                            })
                        }
                    }
                });

                const response = await http2ProxyRequest(server, `https://localhost:${targetPort}/`);

                expect(response.headers[':status']).to.equal(200);
                expect(JSON.parse(response.headers['received-headers'] as string)).to.deep.equal({
                    ':authority': 'google.com',
                    ':scheme': 'magic',
                    ':path': '/',
                    ':method': 'GET'
                });
            });

            it("rejects custom request pseudoheaders", async () => {
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost'],
                    beforeRequest: (req) => {
                        expect(req.headers).to.deep.equal({
                            ':scheme': 'https',
                            ':authority': `localhost:${targetPort}`,
                            ':method': 'GET',
                            ':path': '/'
                        });

                        return {
                            headers: {
                                ':path': '/abc',
                                ':custom': 'value'
                            }
                        }
                    }
                });

                const response = await http2ProxyRequest(server, `https://localhost:${targetPort}/`);

                expect(response.headers[':status']).to.equal(500);
                expect(response.body.toString()).to.equal('Error: Cannot set custom :path, :custom pseudoheader values');
            });

            it("can rewrite the request body en route", async () => {
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost'],
                    beforeRequest: async (req) => {
                        expect(await req.body.getText()).to.equal('initial-body');

                        return { body: 'replaced-body' };
                    }
                });

                const response = await http2ProxyRequest(
                    server,
                    `https://localhost:${targetPort}/`,
                    {
                        headers: { ':method': 'POST' },
                        requestBody: 'initial-body'
                    }
                );

                expect(response.headers[':status']).to.equal(200);
                expect(response.headers['received-body']).to.equal('replaced-body');
            });

            it("can rewrite the request body as empty en route", async () => {
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost'],
                    beforeRequest: async (req) => {
                        expect(await req.body.getText()).to.equal('');

                        return {
                            url: req.url,
                            headers: req.headers,
                            body: ''
                        };
                    }
                });

                const response = await http2ProxyRequest(
                    server,
                    `https://localhost:${targetPort}/`,
                    {
                        // GET isn't allowed a body
                        headers: { ':method': 'GET' }
                    }
                );

                expect(response.headers[':status']).to.equal(200);
                expect(response.headers['received-body']).to.equal('');
            });

            it("can rewrite the request body with JSON en route", async () => {
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost'],
                    beforeRequest: async (req) => {
                        expect(await req.body.getText()).to.equal('initial-body');

                        return { json: { mocked: true } };
                    }
                });

                const response = await http2ProxyRequest(
                    server,
                    `https://localhost:${targetPort}/`,
                    {
                        headers: { ':method': 'POST' },
                        requestBody: 'initial-body'
                    }
                );

                expect(response.headers[':status']).to.equal(200);
                expect(response.headers['received-body']).to.equal(JSON.stringify({ mocked: true }));
            });

            it("can inject a response directly en route", async () => {
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost'],
                    beforeRequest: () => {
                        return {
                            response: {
                                statusCode: 404,
                                headers: {
                                    'fake-header': 'injected'
                                },
                                body: 'fake-response'
                            }
                        };
                    }
                });

                const response = await http2ProxyRequest(server, `https://localhost:${targetPort}/`);

                expect(response.headers[':status']).to.equal(404);
                expect(response.headers['fake-header']).to.equal('injected');
                expect(response.body.toString('utf8')).to.equal('fake-response');
            });

            it("can rewrite a response status en route", async () => {
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost'],
                    beforeResponse: (res) => {
                        expect(res.statusCode).to.equal(200);
                        expect(res.statusMessage).to.equal(''); // Not used in HTTP/2

                        return { statusCode: 418 };
                    }
                });

                const response = await http2ProxyRequest(server, `https://localhost:${targetPort}/`);

                expect(response.headers[':status']).to.equal(418);
            });

            it("can rewrite response headers en route", async () => {
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost'],
                    beforeResponse: (res) => {
                        const receivedHeaders = JSON.parse(res.headers['received-headers'] as string);

                        expect(receivedHeaders).to.deep.equal({
                            ':scheme': 'https',
                            ':authority': `localhost:${targetPort}`,
                            ':path': '/',
                            ':method': 'GET'
                        });

                        expect(_.omit(res.headers, ['date', 'received-headers'])).to.deep.equal({
                            ':status': '200',
                            'received-url': '/',
                            'received-method': 'GET',
                            'received-body': '',
                        });

                        return {
                            headers: {
                                'replacement-header': 'added'
                            }
                        };
                    }
                });

                const response = await http2ProxyRequest(server, `https://localhost:${targetPort}/`);

                expect(
                    _.omit(response.headers, 'date') // https://github.com/nodejs/node/issues/34841
                ).to.deep.equal({
                    ':status': 200,
                    'replacement-header': 'added'
                });
            });

            it("can rewrite response headers including :status, as long as it's not a custom value", async () => {
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost'],
                    beforeResponse: (res) => {
                        expect(res.headers[':status']).to.equal('200');

                        return {
                            statusCode: 418,
                            // This still includes :status: 200, but statusCode willl quietly replace it:
                            headers: Object.assign(res.headers, {
                                'custom-header': 'set'
                            })
                        };
                    }
                });

                const response = await http2ProxyRequest(server, `https://localhost:${targetPort}/`);

                expect(response.headers[':status']).to.equal(418);
                expect(response.headers['custom-header']).to.equal('set');
            });

            it("rejects custom response pseudoheader headers added en route", async () => {
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost'],
                    beforeResponse: () => {
                        return {
                            headers: {
                                ':custom': 'value'
                            }
                        };
                    }
                });

                const response = await http2ProxyRequest(server, `https://localhost:${targetPort}/`);

                expect(response.headers[':status']).to.equal(500);
                expect(response.headers[':custom']).to.equal(undefined);
                expect(response.body.toString()).to.equal(
                    'Error: Cannot set custom :custom pseudoheader values'
                );
            });

            it("rejects a rewritten :status header", async () => {
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost'],
                    beforeResponse: (res) => {
                        expect(res.headers[':status']).to.equal('200');

                        return {
                            statusCode: 429,
                            headers: {
                                ':status': '418'
                            }
                        };
                    }
                });

                const response = await http2ProxyRequest(server, `https://localhost:${targetPort}/`);

                expect(response.headers[':status']).to.equal(500);
                expect(response.body.toString()).to.equal(
                    'Error: Cannot set custom :status pseudoheader values'
                );

            });

            it("can rewrite a response body en route", async () => {
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost'],
                    beforeResponse: async (res) => {
                        expect(await res.body.getText()).to.equal('Real HTTP/2 response');

                        return { body: 'Replacement response' };
                    }
                });

                const response = await http2ProxyRequest(server, `https://localhost:${targetPort}/`);

                expect(response.body.toString('utf8')).to.equal('Replacement response');
            });

            it("can rewrite the response body as empty en route", async () => {
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost'],
                    beforeResponse: async (res) => {
                        expect(await res.body.getText()).to.equal('Real HTTP/2 response');

                        return {
                            statusCode: 204, // 204 must not have a response body
                            headers: res.headers,
                            body: ''
                        };
                    }
                });

                const response = await http2ProxyRequest(
                    server,
                    `https://localhost:${targetPort}/`,
                    {
                        // HEAD must not have a response body
                        headers: { method: 'HEAD' }
                    }
                );

                expect(response.headers[':status']).to.equal(204);
                expect(response.headers['received-body']).to.equal('');
            });

            it("can rewrite a response body as JSON en route", async () => {
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost'],
                    beforeResponse: async (res) => {
                        expect(await res.body.getText()).to.equal('Real HTTP/2 response');

                        return { json: { replaced: true } };
                    }
                });

                const response = await http2ProxyRequest(server, `https://localhost:${targetPort}/`);

                expect(response.headers[':status']).to.equal(200);
                expect(response.headers['content-type']).to.equal('application/json');
                expect(response.body.toString('utf8')).to.equal(JSON.stringify({ replaced: true }));
            });

            it("can rewrite a response body as JSON and encode it automatically en route", async () => {
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost'],
                    beforeResponse: async (res) => {
                        expect(await res.body.getText()).to.equal('Real HTTP/2 response');
                        return {
                            headers: {
                                'content-encoding': 'gzip'
                            },
                            json: { replaced: true } // Should be automatically encoded due to header:
                        };
                    }
                });

                const response = await http2ProxyRequest(server, `https://localhost:${targetPort}/`);

                expect(response.headers[':status']).to.equal(200);
                expect(response.headers['content-type']).to.equal('application/json');
                expect(response.headers['content-encoding']).to.equal('gzip');
                expect(response.body.toString('utf-8')).to.deep.equal(
                    zlib.gzipSync(JSON.stringify({ replaced: true }), { level: 1 }).toString()
                );

                const decodedResponse = zlib.gunzipSync(response.body).toString('utf-8');
                expect(decodedResponse).to.equal(JSON.stringify({ replaced: true }));
            });

            it("should allow forwarding the request", async () => {
                await server.forAnyRequest().thenForwardTo(`localhost:${targetPort}`, {
                    ignoreHostHttpsErrors: ['localhost']
                });

                const response = await http2ProxyRequest(server, "https://example.com");

                expect(response.headers[':status']).to.equal(200);
                expect(response.body.toString()).to.equal("Real HTTP/2 response");

                const serverReceivedHeaders = JSON.parse(response.headers['received-headers'] as string);
                expect(serverReceivedHeaders[':authority']).to.equal(`localhost:${targetPort}`);
            });

            describe("to an HTTP/1 server", () => {

                before(function () {
                    if (!semver.satisfies(process.version, H2_TLS_ON_TLS_SUPPORTED)) this.skip();
                });

                const remoteH1Server = getLocal({
                    https: {
                        keyPath: './test/fixtures/test-ca.key',
                        certPath: './test/fixtures/test-ca.pem'
                    }
                });

                beforeEach(() => remoteH1Server.start());
                afterEach(() => remoteH1Server.stop());

                it("should translate to HTTP/1 successfully", async () => {
                    await remoteH1Server.forAnyRequest().thenReply(200, "HTTP/1 response");
                    await server.forAnyRequest().thenPassThrough();

                    const response = await http2ProxyRequest(server, remoteH1Server.url);

                    expect(response.headers[':status']).to.equal(200);
                    expect(response.body.toString()).to.equal("HTTP/1 response");
                });

                it("should allow rewriting the request", async () => {
                    await remoteH1Server.forGet().thenReply(200, "HTTP/1 GET response");
                    await remoteH1Server.forPost().thenReply(200, "HTTP/1 POST response");

                    await server.forAnyRequest().thenPassThrough({
                        beforeRequest: (req) => {
                            expect(req.headers).to.deep.equal({
                                ':scheme': 'https',
                                ':authority': `localhost:${remoteH1Server.port}`,
                                ':method': 'GET',
                                ':path': '/'
                            });

                            return {
                                method: 'POST'
                            }
                        }
                    });

                    const response = await http2ProxyRequest(server, remoteH1Server.url);

                    expect(response.headers[':status']).to.equal(200);
                    expect(response.body.toString()).to.equal("HTTP/1 POST response");
                });

                it("should allow forwarding the request", async () => {
                    const h1Endpoint = await remoteH1Server.forGet().thenReply(200, "HTTP/1 response");

                    await server.forAnyRequest().thenForwardTo(remoteH1Server.url);

                    const response = await http2ProxyRequest(server, "https://example.com");

                    expect(response.headers[':status']).to.equal(200);
                    expect(response.body.toString()).to.equal("HTTP/1 response");

                    const receivedRequest = (await h1Endpoint.getSeenRequests())[0];
                    expect(receivedRequest.headers['host']).to.equal(`localhost:${remoteH1Server.port}`);
                });

                it("should fail given overridden HTTP/2 pseudoheaders", async () => {
                    // 'Should' is a bit strong - it'd be better to somehow ignore/translate
                    // in this case, but that's not possible with http2-wrapper, so for
                    // now we just expect the request to hard fail with a clear error.

                    await server.forAnyRequest().thenPassThrough({
                        beforeRequest: (req) => {
                            return {
                                headers: Object.assign(req.headers, {
                                    ':scheme': 'magic',
                                    ':authority': 'google.com'
                                })
                            }
                        }
                    });

                    const response = await http2ProxyRequest(server, remoteH1Server.url);

                    expect(response.headers[':status']).to.equal(500);
                    expect(response.body.toString()).to.match(
                        /TypeError \[ERR_INVALID_HTTP_TOKEN\]: Header name must be a valid HTTP token \[":(scheme|authority)"\]/
                    );
                });
            });
        });
    });
});
import _ = require("lodash");
import * as path from 'path';
import * as fs from 'fs-extra';
import * as http from 'http';
import * as https from 'https';
import * as http2 from 'http2';
import * as semver from 'semver';
import portfinder = require('portfinder');
import request = require("request-promise-native");
import * as zlib from 'zlib';

import { getLocal, Mockttp, CompletedResponse, MockedEndpoint } from "../..";
import {
    expect,
    nodeOnly,
    getDeferred,
    Deferred,
    sendRawRequest,
    http2ProxyRequest,
    startDnsServer,
    destroyable,
    DestroyableServer,
    H2_TLS_ON_TLS_SUPPORTED,
    TLS_MIN_VERSION_SUPPORTED,
    ZLIB_BROTLI_AVAILABLE
} from "../test-utils";
import { generateCACertificate, CA } from "../../src/util/tls";
import { isLocalIPv6Available } from "../../src/util/socket-util";
import { streamToBuffer } from "../../src/util/buffer-utils";

const INITIAL_ENV = _.cloneDeep(process.env);

nodeOnly(() => {
    describe("Mockttp when used as a proxy with `request`", function () {

        let server: Mockttp;
        let remoteServer = getLocal();

        beforeEach(async () => {
            await remoteServer.start();
        });

        afterEach(async () => {
            await server.stop();
            await remoteServer.stop();
            process.env = INITIAL_ENV;
        });

        describe("with a default config", () => {

            beforeEach(async () => {
                server = getLocal();
                await server.start();
                process.env = _.merge({}, process.env, server.proxyEnv);
            });

            it("should mock proxied HTTP with request + process.env", async () => {
                await server.get("http://example.com/endpoint").thenReply(200, "mocked data");

                let response = await request.get("http://example.com/endpoint");
                expect(response).to.equal("mocked data");
            });

            it("should mock proxied HTTP matching relative URLs", async () => {
                await server.get("/endpoint").thenReply(200, "mocked data");
                let response = await request.get("http://example.com/endpoint");
                expect(response).to.equal("mocked data");
            });

            it("should mock proxied HTTP matching absolute protocol-less URLs", async () => {
                await server.get("example.com/endpoint").thenReply(200, "mocked data");
                let response = await request.get("http://example.com/endpoint");
                expect(response).to.equal("mocked data");
            });

            it("should mock proxied HTTP matching badly formatted URLs with empty paths", async () => {
                await server.get('/').thenReply(200, 'Mock response');

                const response = await sendRawRequest(server, 'GET http://example.com HTTP/1.1\n\n');
                expect(response).to.include('HTTP/1.1 200 OK');
                expect(response).to.include('Mock response');
            });

            it("should mock proxied HTTP matching requests by host", async () => {
                await server.get().forHost('example.com').thenReply(200, "host matched");

                await expect(
                    await request.get("http://example.com/")
                ).to.equal('host matched');

                await expect(
                    request.get("http://different-host.com/")
                ).to.be.rejectedWith('No rules were found matching this request');
            });

            it("should be able to pass through requests", async () => {
                await server.get("http://example.com/").thenPassThrough();

                let response = await request.get("http://example.com/");
                expect(response).to.include(
                    "This domain is for use in illustrative examples in documents."
                );
            });

            it("should be able to pass through request headers", async () => {
                await remoteServer.anyRequest().thenCallback(async (req) => ({
                    statusCode: 200,
                    body: await req.body.getText(),
                    headers: { "my-header": "123" }
                }));

                await server.get(remoteServer.url).thenPassThrough();

                let response = await request.get({
                    url: remoteServer.url,
                    resolveWithFullResponse: true
                });

                expect(response.headers['my-header']).to.equal('123');
                expect(response.headers['date']).to.equal(undefined); // No default headers added!
            });

            it("should be able to pass through requests with a body", async () => {
                await remoteServer.anyRequest().thenCallback(async (req) => ({
                    statusCode: 200,
                    body: await req.body.getText()
                }));
                await server.post(remoteServer.url).thenPassThrough();

                let response = await request.post({
                    url: remoteServer.url,
                    json: { "test": true }
                });

                expect(response).to.deep.equal({ "test":true });
            });

            it("should be able to pass through requests with a body buffer", async () => {
                await remoteServer.anyRequest().thenCallback((req) => ({
                    statusCode: 200,
                    body: req.body.buffer
                }));
                await server.post(remoteServer.url).thenPassThrough();

                let response = await request.post({
                    url: remoteServer.url,
                    json: { "test": true }
                });

                expect(response).to.deep.equal({ "test": true });
            });

            it("should be able to pass through requests with parameters", async () => {
                await remoteServer.anyRequest().thenCallback((req) => ({
                    statusCode: 200,
                    body: req.url
                }));
                await server.get(remoteServer.urlFor('/get')).thenPassThrough();

                let response = await request.get(remoteServer.urlFor('/get?a=b'));

                expect(response).to.equal(remoteServer.urlFor('/get?a=b'));
            });

            it("should be able to verify requests passed through with a body", async () => {
                await remoteServer.post('/post').thenReply(200);
                const endpointMock = await server.post(remoteServer.urlFor('/post')).thenPassThrough();

                await request.post({
                    url: remoteServer.urlFor('/post'),
                    json: { "test": true }
                });

                const seenRequests = await endpointMock.getSeenRequests();
                expect(seenRequests.length).to.equal(1);
                expect(await seenRequests[0].body.getText()).to.equal('{"test":true}');
            });

            it("should successfully pass through non-proxy requests with a host header", async () => {
                await remoteServer.get('/').thenReply(200, 'remote server');
                server.get(remoteServer.url).thenPassThrough();
                process.env = INITIAL_ENV;

                let response = await request.get(server.urlFor("/"), {
                    headers: { host: `localhost:${remoteServer.port}`  }
                });

                expect(response).to.equal('remote server');
            });

            it("should be able to pass through upstream connection resets", async () => {
                await remoteServer.anyRequest().thenCloseConnection();
                await server.get(remoteServer.url).thenPassThrough();

                let response: Response | Error = await request.get(remoteServer.url, {
                    simple: false
                }).catch((e) => e);

                expect(response).to.be.instanceOf(Error);
                expect((response as Error & {
                    cause: { code: string }
                }).cause.code).to.equal('ECONNRESET');
            });

            it("should be able to rewrite a request's method", async () => {
                await remoteServer.get('/').thenReply(200, 'GET');
                await remoteServer.post('/').thenReply(200, 'POST');

                await server.get(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: (req) => {
                        expect(req.method).to.equal('GET');
                        return { method: 'POST' };
                    }
                });

                let response = await request.get(remoteServer.urlFor("/"));
                expect(response).to.equal("POST");
            });

            it("should be able to rewrite a request's URL", async () => {
                await remoteServer.get('/').thenReply(200, 'Root');
                await remoteServer.get('/endpoint').thenReply(200, '/endpoint');

                await server.get(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: (req) => {
                        expect(req.url).to.equal(remoteServer.urlFor("/"));
                        return { url: req.url.replace(/\/$/, '/endpoint') };
                    }
                });

                let response = await request.get(remoteServer.urlFor("/"));
                expect(response).to.equal("/endpoint");
            });

            it("should clearly fail when rewriting a request's URL to a relative path", async () => {
                await remoteServer.get('/').thenReply(200, 'Root');
                await remoteServer.get('/endpoint').thenReply(200, '/endpoint');

                await server.get(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: (req) => {
                        return { url: '/endpoint' };
                    }
                });

                await expect(
                    request.get(remoteServer.urlFor("/"))
                ).to.be.rejectedWith("Error: Overridden request URLs must be absolute");
            });

            it("should be able to rewrite a request's URL to a different host", async () => {
                const remoteEndpoint = await remoteServer.get('/').thenReply(200, 'my remote');

                await server.get('http://example.com').thenPassThrough({
                    beforeRequest: (req) => {
                        expect(req.url).to.equal('http://example.com/');
                        return { url: remoteServer.url };
                    }
                });

                let response = await request.get('http://example.com');
                expect(response).to.equal("my remote");

                // Should automatically update the host header en route:
                let resultingRequest = (await remoteEndpoint.getSeenRequests())[0];
                expect(resultingRequest.headers).to.deep.equal({
                    'host': `localhost:${remoteServer.port}`,
                    'connection': 'close'
                });
            });

            it("should be able to rewrite a request's headers", async () => {
                await remoteServer.get('/rewrite').thenCallback((req) => ({
                    statusCode: 200,
                    json: req.headers
                }));

                await server.get(remoteServer.urlFor("/rewrite")).thenPassThrough({
                    beforeRequest: (req) => {
                        expect(req.headers).to.deep.equal({
                            'host': `localhost:${remoteServer.port}`,
                            'connection': 'close'
                        });
                        return {
                            headers: Object.assign({}, req.headers, { 'x-test-header': 'test' })
                        };
                    }
                });

                let response = await request.get(remoteServer.urlFor("/rewrite"));
                expect(JSON.parse(response)['x-test-header']).to.equal("test");
            });

            it("should be able to mutatively rewrite a request's headers", async () => {
                await remoteServer.get('/rewrite').thenCallback((req) => ({
                    statusCode: 200,
                    json: req.headers
                }));

                await server.get(remoteServer.urlFor("/rewrite")).thenPassThrough({
                    beforeRequest: (req) => {
                        expect(req.headers).to.deep.equal({
                            'host': `localhost:${remoteServer.port}`,
                            'connection': 'close'
                        });

                        req.headers['x-test-header'] = 'test';
                        // You shouldn't be able to return the request itself like this
                        // according to the types, but people will anyway, so check it
                        // more or less works:
                        return req as any;
                    }
                });

                let response = await request.get(remoteServer.urlFor("/rewrite"));
                expect(JSON.parse(response)['x-test-header']).to.equal("test");
            });

            it("should be able to rewrite a request's body", async () => {
                await remoteServer.post('/').thenCallback(async (req) => ({
                    statusCode: 200,
                    body: await req.body.getText()
                }));

                await server.post(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: async (req) => {
                        expect(await req.body.getText()).to.equal('initial body');

                        return {
                            body: Buffer.from(await req.body.getText() + ' extended')
                        };
                    }
                });

                let response = await request.post(remoteServer.urlFor("/"), {
                    body: "initial body"
                });
                expect(response).to.equal("initial body extended");
            });

            it("should be able to rewrite a request's body with an empty string", async () => {
                await remoteServer.post('/').thenCallback(async (req) => ({
                    statusCode: 200,
                    body: await req.body.getText()
                }));
                await server.post(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: async (req) => {
                        expect(await req.body.getText()).to.equal('initial body');
                        return { body: '' };
                    }
                });

                let response = await request.post(remoteServer.urlFor("/"), {
                    body: "initial body"
                });
                expect(response).to.equal("");
            });

            it("should be able to rewrite a request's body with json", async () => {
                await remoteServer.post('/').thenCallback(async (req) => ({
                    statusCode: 200,
                    json: await req.body.getJson()
                }));

                await server.post(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: async (req) => {
                        expect(await req.body.getJson()).to.equal(undefined);

                        return {
                            json: { hello: "world" }
                        };
                    }
                });

                let response = await request.post(remoteServer.urlFor("/"), {
                    json: true
                });
                expect(response).to.deep.equal({ hello: "world" });
            });

            it("should be able to edit a request to inject a response directly", async () => {
                const remoteEndpoint = await remoteServer.post('/').thenReply(200);

                await server.post(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: () => ({
                        response: {
                            statusCode: 404,
                            body: 'Fake 404'
                        }
                    })
                });

                let response = await request.post(remoteServer.urlFor("/"), {
                    resolveWithFullResponse: true,
                    simple: false
                });

                const seenRequests = await remoteEndpoint.getSeenRequests();
                expect(seenRequests.length).to.equal(0);

                expect(response.statusCode).to.equal(404);
                expect(response.body).to.equal('Fake 404');
            });

            it("should be able to rewrite a response's status", async () => {
                await remoteServer.get('/').thenReply(404);
                await server.get(remoteServer.urlFor("/")).thenPassThrough({
                    beforeResponse: (res) => {
                        expect(res.statusCode).to.equal(404);
                        expect(res.statusMessage).to.equal("Not Found");

                        return {
                            statusCode: 200,
                            statusMessage: 'muy bien'
                        };
                    }
                });

                let response = await request.get(remoteServer.urlFor("/"), {
                    resolveWithFullResponse: true,
                    simple: false
                });
                expect(response.statusCode).to.equal(200);
                expect(response.statusMessage).to.equal('muy bien');
            });

            it("should be able to rewrite a response's headers", async () => {
                await remoteServer.get('/').thenReply(200, '', {
                    'x-header': 'original'
                });

                await server.get(remoteServer.urlFor("/")).thenPassThrough({
                    beforeResponse: (res) => {
                        expect(res.headers).to.deep.equal({
                            'x-header': 'original'
                        });

                        return {
                            headers: { 'x-header': res.headers['x-header'] + ' extended' }
                        };
                    }
                });

                let response = await request.get(remoteServer.urlFor("/"), {
                    resolveWithFullResponse: true,
                    simple: false
                });
                expect(response.headers['x-header']).to.equal('original extended');
            });

            it("should be able to rewrite a response's body", async () => {
                await remoteServer.get('/').thenReply(200, 'original text', {
                    "content-length": "13"
                });

                await server.get(remoteServer.urlFor("/")).thenPassThrough({
                    beforeResponse: async (res) => {
                        expect(await res.body.getText()).to.equal('original text');

                        return {
                            headers: { 'content-length': undefined },
                            body: await res.body.getText() + ' extended'
                        }
                    }
                });

                let response = await request.get(remoteServer.urlFor("/"));
                expect(response).to.equal('original text extended');
            });

            it("should be able to rewrite a response's body with json", async () => {
                await remoteServer.get('/').thenReply(200, 'text');

                await server.get(remoteServer.urlFor("/")).thenPassThrough({
                    beforeResponse: async (res) => {
                        expect(await res.body.getJson()).to.equal(undefined);

                        return {
                            json: { hello: "world" }
                        };
                    }
                });

                let response = await request.get(remoteServer.urlFor("/"), {
                    json: true
                });
                expect(response).to.deep.equal({ hello: "world" });
            });

            it("should use the original body if not overwritten in beforeResponse", async () => {
                await remoteServer.get('/').thenReply(200, 'real body');
                await server.get(remoteServer.urlFor("/")).thenPassThrough({
                    beforeResponse: () => ({ })
                });

                let response = await request.get(remoteServer.urlFor("/"));
                expect(response).to.equal('real body');
            });

            it("should return a 500 if the request rewriting fails", async () => {
                await remoteServer.get('/').thenReply(200, 'text');

                await server.get(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: () => { throw new Error('Oops') }
                });

                let response = await request.get(remoteServer.urlFor("/"), {
                    resolveWithFullResponse: true,
                    simple: false
                });
                expect(response.statusCode).to.equal(500);
            });

            it("should return a 500 if the response rewriting fails", async () => {
                await remoteServer.get('/').thenReply(200, 'text');

                await server.get(remoteServer.urlFor("/")).thenPassThrough({
                    beforeResponse: () => { throw new Error('Oops') }
                });

                let response = await request.get(remoteServer.urlFor("/"), {
                    resolveWithFullResponse: true,
                    simple: false
                });
                expect(response.statusCode).to.equal(500);
            });

            describe("with an IPv6-only server", () => {
                if (!isLocalIPv6Available) return;

                let ipV6Port: number;
                let ipV6Server: http.Server;
                let requestReceived: Deferred<void>;

                beforeEach(async () => {
                    requestReceived = getDeferred<void>()
                    ipV6Port = await portfinder.getPortPromise();
                    ipV6Server = http.createServer((_req, res) => {
                        requestReceived.resolve();
                        res.writeHead(200);
                        res.end("OK");
                    });

                    return new Promise<void>((resolve, reject) => {
                        ipV6Server.listen({ host: '::1', family: 6, port: ipV6Port }, resolve);
                        ipV6Server.on('error', reject);
                    });
                });

                afterEach(() => new Promise<void>((resolve, reject) => {
                    ipV6Server.close((error) => {
                        if (error) reject();
                        else resolve();
                    });
                }));

                it("correctly forwards requests to the IPv6 port", async () => {
                    server.anyRequest().thenPassThrough();

                    // Localhost here will be ambiguous - we're expecting Mockttp to work it out
                    let response = await request.get(`http://localhost:${ipV6Port}`);
                    await requestReceived;

                    expect(response).to.equal("OK");
                });

            });
        });

        describe("when only tiny bodies are allowed", () => {

            beforeEach(async () => {
                server = getLocal({
                    maxBodySize: 10
                });
                await server.start();
                process.env = _.merge({}, process.env, server.proxyEnv);
            });

            it("should still proxy larger request bodies", async () => {
                const remoteEndpoint = await remoteServer.anyRequest().thenReply(200);
                const proxyEndpoint = await server.post(remoteServer.url).thenPassThrough();

                let response = await request.post({
                    url: remoteServer.url,
                    body: "A large request body",
                    resolveWithFullResponse: true
                });

                expect(response.statusCode).to.equal(200);

                // The request data is proxied through successfully
                const resultingRequest = (await remoteEndpoint.getSeenRequests())[0];
                expect(await resultingRequest.body.getText()).to.equal('A large request body');

                // But it's truncated in event data, not buffered
                const proxiedRequestData = (await proxyEndpoint.getSeenRequests())[0];
                expect(await proxiedRequestData.body.getText()).to.equal('');
            });

            it("should still proxy larger response bodies", async () => {
                await remoteServer.anyRequest().thenReply(200, "A large response body");
                const proxyEndpoint = await server.get(remoteServer.url).thenPassThrough();

                let response = await request.get({
                    url: remoteServer.url,
                    resolveWithFullResponse: true
                });

                expect(response.statusCode).to.equal(200);

                // The response data is proxied through successfully
                expect(response.body).to.equal('A large response body');

                // But it's truncated in event data, not buffered
                const proxiedRequestData = (await proxyEndpoint.getSeenRequests())[0];
                expect(await proxiedRequestData.body.getText()).to.equal('');
            });

        });

        describe("with an HTTPS config", () => {
            beforeEach(async () => {
                server = getLocal({
                    https: {
                        keyPath: './test/fixtures/test-ca.key',
                        certPath: './test/fixtures/test-ca.pem'
                    }
                });

                await server.start();
                process.env = _.merge({}, process.env, server.proxyEnv);
            });

            describe("using request + process.env", () => {
                it("should mock proxied HTTP", async () => {
                    await server.get("http://example.com/endpoint").thenReply(200, "mocked data");

                    let response = await request.get("http://example.com/endpoint");
                    expect(response).to.equal("mocked data");
                });

                it("should mock proxied HTTPS", async () => {
                    await server.get("https://example.com/endpoint").thenReply(200, "mocked data");

                    let response = await request.get("https://example.com/endpoint");
                    expect(response).to.equal("mocked data");
                });

                it("should mock proxied traffic ignoring the protocol", async () => {
                    await server.get("example.com/endpoint").thenReply(200, "mocked data");

                    expect(
                        await request.get("https://example.com/endpoint")
                    ).to.equal("mocked data");
                    expect(
                        await request.get("http://example.com/endpoint")
                    ).to.equal("mocked data");
                });

                it("should mock proxied HTTPS with a specific port", async () => {
                    await server.get("https://example.com:1234/endpoint").thenReply(200, "mocked data");

                    let response = await request.get("https://example.com:1234/endpoint");
                    expect(response).to.equal("mocked data");
                });

                describe("given an untrusted upstream certificate", () => {

                    let badServer: Mockttp;
                    const untrustedCACert = generateCACertificate({ bits: 1024 });

                    beforeEach(async () => {
                        badServer = getLocal({ https: await untrustedCACert });
                        await badServer.start();
                    });

                    afterEach(() => badServer.stop());

                    it("should refuse to pass through requests", async () => {
                        await badServer.anyRequest().thenReply(200);

                        await server.anyRequest().thenPassThrough();

                        let response = await request.get(badServer.url, {
                            resolveWithFullResponse: true,
                            simple: false
                        });

                        expect(response.statusCode).to.equal(502);
                    });

                    it("should tag failed passthrough requests", async () => {
                        await badServer.anyRequest().thenReply(200);
                        await server.anyRequest().thenPassThrough();

                        let responsePromise = getDeferred<CompletedResponse>();
                        await server.on('response', (r) => responsePromise.resolve(r));

                        await request.get(badServer.url).catch(() => {});

                        const seenResponse = await responsePromise;
                        expect(seenResponse.tags).to.deep.equal([
                            'passthrough-error:SELF_SIGNED_CERT_IN_CHAIN'
                        ]);
                    });

                    it("should allow passing through requests if the host is specifically listed", async () => {
                        await badServer.anyRequest().thenReply(200);

                        await server.anyRequest().thenPassThrough({
                            ignoreHostCertificateErrors: ['localhost']
                        });

                        let response = await request.get(badServer.url, {
                            resolveWithFullResponse: true,
                            simple: false
                        });

                        expect(response.statusCode).to.equal(200);
                    });

                    it("should refuse to pass through requests if a non-matching host is listed", async () => {
                        await badServer.anyRequest().thenReply(200);

                        await server.get(badServer.urlFor('/')).thenPassThrough({
                            ignoreHostCertificateErrors: ['differenthost']
                        });

                        let response = await request.get(badServer.url, {
                            resolveWithFullResponse: true,
                            simple: false
                        });

                        expect(response.statusCode).to.equal(502);
                    });
                });

                describe("given a TLSv1 upstream server", () => {

                    let oldServerPort: number;
                    let oldServer: DestroyableServer;

                    beforeEach(async function () {
                        if (!semver.satisfies(process.version, TLS_MIN_VERSION_SUPPORTED)) this.skip();

                        const caKey = await fs.readFile('./test/fixtures/test-ca.key');
                        const caCert = await fs.readFile('./test/fixtures/test-ca.pem');
                        const ca = new CA(caKey, caCert, 1024);

                        const cert = ca.generateCertificate('localhost');

                        oldServer = destroyable(https.createServer({
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
                        await server.anyRequest().thenPassThrough();

                        let response = await request.get(`https://localhost:${oldServerPort}`, {
                            resolveWithFullResponse: true,
                            simple: false
                        });

                        expect(response.statusCode).to.equal(502);
                        expect(response.body).to.include("SSL alert number 70");
                    });

                    it("should tag failed requests", async () => {
                        await server.anyRequest().thenPassThrough();

                        let responsePromise = getDeferred<CompletedResponse>();
                        await server.on('response', (r) => responsePromise.resolve(r));

                        await request.get(`https://localhost:${oldServerPort}`).catch(() => {});

                        const seenResponse = await responsePromise;
                        expect(seenResponse.tags).to.deep.equal([
                            'passthrough-tls-error:ssl-alert-70',
                            'passthrough-error:EPROTO'
                        ]);
                    });

                    it("should allow passing through requests if the host is specifically listed", async () => {
                        await server.anyRequest().thenPassThrough({
                            ignoreHostHttpsErrors: ['localhost']
                        });

                        let response = await request.get(`https://localhost:${oldServerPort}`, {
                            resolveWithFullResponse: true,
                            simple: false
                        });

                        expect(response.statusCode).to.equal(200);
                    });

                    it("should refuse to pass through requests if a non-matching host is listed", async () => {
                        await server.anyRequest().thenPassThrough({
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
                    let authenticatingServer: DestroyableServer;

                    beforeEach(async () => {
                        const key = await fs.readFile('./test/fixtures/test-ca.key');
                        const cert = await fs.readFile('./test/fixtures/test-ca.pem');

                        authenticatingServer = destroyable(https.createServer({
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
                        await server.anyRequest().thenPassThrough({
                            ignoreHostCertificateErrors: ['localhost'],
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

                let http2Server: DestroyableServer;
                let targetPort: number;

                beforeEach(async () => {
                    http2Server = destroyable(http2.createSecureServer({
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
                    await server.anyRequest().thenPassThrough({
                        ignoreHostCertificateErrors: ['localhost']
                    });

                    const response = await http2ProxyRequest(server, `https://localhost:${targetPort}`);

                    expect(response.headers[':status']).to.equal(200);
                    expect(response.headers['received-url']).to.equal('/');
                    expect(response.body.toString('utf8')).to.equal("Real HTTP/2 response");
                });

                it("can rewrite request URLs en route", async () => {
                    await server.anyRequest().thenPassThrough({
                        ignoreHostCertificateErrors: ['localhost'],
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
                    await server.anyRequest().thenPassThrough({
                        ignoreHostCertificateErrors: ['localhost'],
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
                    await server.anyRequest().thenPassThrough({
                        ignoreHostCertificateErrors: ['localhost'],
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
                    await server.anyRequest().thenPassThrough({
                        ignoreHostCertificateErrors: ['localhost'],
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
                    await server.anyRequest().thenPassThrough({
                        ignoreHostCertificateErrors: ['localhost'],
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
                    expect(response.body.toString()).to.equal('Error: Cannot set custom :method, :path pseudoheader values');
                });

                it("can override the :scheme and :authority pseudoheaders", async () => {
                    await server.anyRequest().thenPassThrough({
                        ignoreHostCertificateErrors: ['localhost'],
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
                    expect(response.headers['received-headers']).to.equal(
                        JSON.stringify({
                            ':authority': 'google.com',
                            ':scheme': 'magic',
                            ':path': '/',
                            ':method': 'GET'
                        })
                    );
                });

                it("rejects custom request pseudoheaders", async () => {
                    await server.anyRequest().thenPassThrough({
                        ignoreHostCertificateErrors: ['localhost'],
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
                    await server.anyRequest().thenPassThrough({
                        ignoreHostCertificateErrors: ['localhost'],
                        beforeRequest: async (req) => {
                            expect(await req.body.getText()).to.equal('initial-body');

                            return { body: 'replaced-body' };
                        }
                    });

                    const response = await http2ProxyRequest(
                        server,
                        `https://localhost:${targetPort}/`,
                        { ':method': 'POST' },
                        'initial-body'
                    );

                    expect(response.headers[':status']).to.equal(200);
                    expect(response.headers['received-body']).to.equal('replaced-body');
                });

                it("can rewrite the request body as empty en route", async () => {
                    await server.anyRequest().thenPassThrough({
                        ignoreHostCertificateErrors: ['localhost'],
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
                        { ':method': 'GET' } // GET isn't allowed a body
                    );

                    expect(response.headers[':status']).to.equal(200);
                    expect(response.headers['received-body']).to.equal('');
                });

                it("can rewrite the request body with JSON en route", async () => {
                    await server.anyRequest().thenPassThrough({
                        ignoreHostCertificateErrors: ['localhost'],
                        beforeRequest: async (req) => {
                            expect(await req.body.getText()).to.equal('initial-body');

                            return { json: { mocked: true } };
                        }
                    });

                    const response = await http2ProxyRequest(
                        server,
                        `https://localhost:${targetPort}/`,
                        { ':method': 'POST' },
                        'initial-body'
                    );

                    expect(response.headers[':status']).to.equal(200);
                    expect(response.headers['received-body']).to.equal(JSON.stringify({ mocked: true }));
                });

                it("can inject a response directly en route", async () => {
                    await server.anyRequest().thenPassThrough({
                        ignoreHostCertificateErrors: ['localhost'],
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
                    await server.anyRequest().thenPassThrough({
                        ignoreHostCertificateErrors: ['localhost'],
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
                    await server.anyRequest().thenPassThrough({
                        ignoreHostCertificateErrors: ['localhost'],
                        beforeResponse: (res) => {
                            expect(_.omit(res.headers, 'date')).to.deep.equal({
                                ':status': '200',
                                'received-url': '/',
                                'received-method': 'GET',
                                'received-body': '',
                                'received-headers': JSON.stringify({
                                    ':scheme': 'https',
                                    ':authority': `localhost:${targetPort}`,
                                    ':path': '/',
                                    ':method': 'GET'
                                })
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
                    await server.anyRequest().thenPassThrough({
                        ignoreHostCertificateErrors: ['localhost'],
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
                    await server.anyRequest().thenPassThrough({
                        ignoreHostCertificateErrors: ['localhost'],
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
                    await server.anyRequest().thenPassThrough({
                        ignoreHostCertificateErrors: ['localhost'],
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
                    await server.anyRequest().thenPassThrough({
                        ignoreHostCertificateErrors: ['localhost'],
                        beforeResponse: async (res) => {
                            expect(await res.body.getText()).to.equal('Real HTTP/2 response');

                            return { body: 'Replacement response' };
                        }
                    });

                    const response = await http2ProxyRequest(server, `https://localhost:${targetPort}/`);

                    expect(response.body.toString('utf8')).to.equal('Replacement response');
                });

                it("can rewrite the response body as empty en route", async () => {
                    await server.anyRequest().thenPassThrough({
                        ignoreHostCertificateErrors: ['localhost'],
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
                        { method: 'HEAD' } // HEAD must not have a response body
                    );

                    expect(response.headers[':status']).to.equal(204);
                    expect(response.headers['received-body']).to.equal('');
                });

                it("can rewrite a response body as JSON en route", async () => {
                    await server.anyRequest().thenPassThrough({
                        ignoreHostCertificateErrors: ['localhost'],
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

                it("should allow forwarding the request", async () => {
                    await server.anyRequest().thenForwardTo(`localhost:${targetPort}`, {
                        ignoreHostCertificateErrors: ['localhost']
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
                        await remoteH1Server.anyRequest().thenReply(200, "HTTP/1 response");
                        await server.anyRequest().thenPassThrough();

                        const response = await http2ProxyRequest(server, remoteH1Server.url);

                        expect(response.headers[':status']).to.equal(200);
                        expect(response.body.toString()).to.equal("HTTP/1 response");
                    });

                    it("should allow rewriting the request", async () => {
                        await remoteH1Server.get().thenReply(200, "HTTP/1 GET response");
                        await remoteH1Server.post().thenReply(200, "HTTP/1 POST response");

                        await server.anyRequest().thenPassThrough({
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
                        const h1Endpoint = await remoteH1Server.get().thenReply(200, "HTTP/1 response");

                        await server.anyRequest().thenForwardTo(remoteH1Server.url);

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

                        await server.anyRequest().thenPassThrough({
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
                        expect(response.body.toString()).to.equal(
                            'TypeError [ERR_INVALID_HTTP_TOKEN]: Header name must be a valid HTTP token [":scheme"]'
                        );
                    });
                });
            });
        });

        describe("when configured to forward requests to a different location", () => {

            beforeEach(async () => {
                server = getLocal();
                await server.start();
                process.env = _.merge({}, process.env, server.proxyEnv);

                expect(remoteServer.port).to.not.equal(server.port);
            });

            it("forwards to the location specified", async () => {
                await remoteServer.get('/').thenReply(200, "forwarded response");
                await server.anyRequest().thenForwardTo(remoteServer.url);

                let response = await request.get(server.urlFor("/"));

                expect(response).to.equal('forwarded response');
            });

            it("forwards to the location even if the port & protocol is implicit", async () => {
                await remoteServer.get('/').thenReply(200, "forwarded response");
                await server.anyRequest().thenForwardTo('example.com');

                let response = await request.get(server.urlFor("/"));

                expect(response).to.include('Example Domain');
            });

            it("uses the path portion from the original request url", async () => {
                let remoteEndpointMock = await remoteServer.get('/get').thenReply(200, "mocked data");
                await server.anyRequest().thenForwardTo(remoteServer.url);

                await request.get(server.urlFor("/get"));

                let seenRequests = await remoteEndpointMock.getSeenRequests();
                expect(seenRequests[0].path).to.equal("/get");
            });

            it("throws an error if the forwarding URL contains a path", async () => {
                const locationWithPath = 'http://localhost:1234/pathIsNotAllowed';

                await expect(server.anyRequest().thenForwardTo(locationWithPath))
                .to.be.rejectedWith(/Did you mean http:\/\/localhost:1234\?$/g);
            });

            it("updates the host header by default", async () => {
                let remoteEndpointMock = await remoteServer.get('/get').thenReply(200, "mocked data");
                await server.anyRequest().thenForwardTo(remoteServer.url);

                await request.get(server.urlFor("/get"));

                let seenRequests = await remoteEndpointMock.getSeenRequests();
                expect(seenRequests[0].headers.host).to.equal(`localhost:${remoteServer.port}`);
            });

            it("can skip updating the host header if requested", async () => {
                let remoteEndpointMock = await remoteServer.get('/get').thenReply(200, "mocked data");
                await server.anyRequest().thenForwardTo(remoteServer.url, {
                    forwarding: { updateHostHeader: false }
                });

                await request.get(server.urlFor("/get"));

                let seenRequests = await remoteEndpointMock.getSeenRequests();
                expect(seenRequests[0].headers.host).to.equal(`localhost:${server.port}`);
            });

            it("can update the host header to a custom value if requested", async () => {
                let remoteEndpointMock = await remoteServer.get('/get').thenReply(200, "mocked data");
                await server.anyRequest().thenForwardTo(remoteServer.url, {
                    forwarding: { updateHostHeader: 'google.com' }
                });

                await request.get(server.urlFor("/get"));

                let seenRequests = await remoteEndpointMock.getSeenRequests();
                expect(seenRequests[0].headers.host).to.equal('google.com');
            });
        });

        describe("when configured to transform requests automatically", () => {

            beforeEach(async () => {
                server = getLocal({ debug: true });
                await server.start();
                process.env = _.merge({}, process.env, server.proxyEnv);

                // The remote server always echoes our requests
                expect(remoteServer.port).to.not.equal(server.port);
                await remoteServer.anyRequest().thenCallback(async (req) => ({
                    status: 200,
                    json: {
                        url: req.url,
                        method: req.method,
                        headers: req.headers,
                        body: await req.body.getText(),
                    }
                }));
            });

            const baseHeaders = () => ({
                'host': `localhost:${remoteServer.port}`,
                'accept': 'application/json',
                'content-type': 'application/json',
                'connection': 'close',
            });

            it("does nothing with an empty transform", async () => {
                await server.anyRequest().thenPassThrough({
                    transformRequest: {}
                });

                let response = await request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1 },
                    json: true
                });

                expect(response).to.deep.equal({
                    url: remoteServer.urlFor("/abc"),
                    method: 'POST',
                    headers: {
                        ...baseHeaders(),
                        'content-length': '7',
                        'custom-header': 'a-value'
                    },
                    body: JSON.stringify({ a: 1 })
                });
            });

            it("can replace the request method", async () => {
                await server.anyRequest().thenPassThrough({
                    transformRequest: {
                        replaceMethod: 'PUT'
                    }
                });

                let response = await request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1 },
                    json: true
                });

                expect(response).to.deep.equal({
                    url: remoteServer.urlFor("/abc"),
                    method: 'PUT',
                    headers: {
                        ...baseHeaders(),
                        'content-length': '7',
                        'custom-header': 'a-value'
                    },
                    body: JSON.stringify({ a: 1 })
                });
            });

            it("can add extra headers", async () => {
                await server.anyRequest().thenPassThrough({
                    transformRequest: {
                        updateHeaders: {
                            'new-header': 'new-value'
                        }
                    }
                });

                let response = await request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1 },
                    json: true
                });

                expect(response).to.deep.equal({
                    url: remoteServer.urlFor("/abc"),
                    method: 'POST',
                    headers: {
                        ...baseHeaders(),
                        'content-length': '7',
                        'custom-header': 'a-value',
                        'new-header': 'new-value'
                    },
                    body: JSON.stringify({ a: 1 })
                });
            });

            it("can replace specific headers", async () => {
                await server.anyRequest().thenPassThrough({
                    transformRequest: {
                        updateHeaders: {
                            'custom-header': 'replaced-value'
                        }
                    }
                });

                let response = await request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1 },
                    json: true
                });

                expect(response).to.deep.equal({
                    url: remoteServer.urlFor("/abc"),
                    method: 'POST',
                    headers: {
                        ...baseHeaders(),
                        'content-length': '7',
                        'custom-header': 'replaced-value'
                    },
                    body: JSON.stringify({ a: 1 })
                });
            });

            it("can replace all headers", async () => {
                await server.anyRequest().thenPassThrough({
                    transformRequest: {
                        replaceHeaders: {
                            'custom-header': 'replaced-value'
                        }
                    }
                });

                let response = await request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1 },
                    json: true
                });

                expect(response).to.deep.equal({
                    url: remoteServer.urlFor("/abc"),
                    method: 'POST',
                    headers: {
                        // Required unavoidable headers:
                        'host': `localhost:${remoteServer.port}`,
                        'connection': 'close',
                        'transfer-encoding': 'chunked', // Because we removed content-length
                        // No other headers, only the given value:
                        'custom-header': 'replaced-value',

                    },
                    body: JSON.stringify({ a: 1 })
                });
            });

            it("can replace the body with a string", async () => {
                await server.anyRequest().thenPassThrough({
                    transformRequest: {
                        replaceBody: 'replacement-body'
                    }
                });

                let response = await request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1 },
                    json: true
                });

                expect(response).to.deep.equal({
                    url: remoteServer.urlFor("/abc"),
                    method: 'POST',
                    headers: {
                        ...baseHeaders(),
                        'content-length': '16',
                        'custom-header': 'a-value'
                    },
                    body: 'replacement-body'
                });
            });

            it("can replace the body with a buffer", async () => {
                await server.anyRequest().thenPassThrough({
                    transformRequest: {
                        replaceBody: Buffer.from('replacement buffer', 'utf8')
                    }
                });

                let response = await request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1 },
                    json: true
                });

                expect(response).to.deep.equal({
                    url: remoteServer.urlFor("/abc"),
                    method: 'POST',
                    headers: {
                        ...baseHeaders(),
                        'content-length': '18',
                        'custom-header': 'a-value'
                    },
                    body: 'replacement buffer'
                });
            });

            it("can replace the body with a file", async () => {
                await server.anyRequest().thenPassThrough({
                    transformRequest: {
                        updateHeaders: {
                            "content-type": 'text/plain'
                        },
                        replaceBodyFromFile:
                            path.join(__dirname, '..', 'fixtures', 'response-file.txt')
                    }
                });

                let response = await request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1 },
                    json: true
                });

                expect(response).to.deep.equal({
                    url: remoteServer.urlFor("/abc"),
                    method: 'POST',
                    headers: {
                        ...baseHeaders(),
                        'content-type': 'text/plain',
                        'content-length': '23',
                        'custom-header': 'a-value'
                    },
                    body: 'Response from text file'
                });
            });

            it("should show a clear error when replacing the body with a non-existent file", async () => {
                await server.anyRequest().thenPassThrough({
                    transformRequest: {
                        replaceBodyFromFile:
                            path.join(__dirname, '..', 'fixtures', 'non-existent-file.txt')
                    }
                });

                await expect(request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1 },
                    json: true
                })).to.be.rejectedWith('no such file or directory');
            });

            it("can update a JSON body with new fields", async () => {
                await server.anyRequest().thenPassThrough({
                    transformRequest: {
                        updateJsonBody:{
                            a: 100, // Update
                            b: undefined, // Remove
                            c: 2 // Add
                        }
                    }
                });

                let response = await request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1, b: 2 },
                    json: true
                });

                expect(response).to.deep.equal({
                    url: remoteServer.urlFor("/abc"),
                    method: 'POST',
                    headers: {
                        ...baseHeaders(),
                        'content-length': '15',
                        'custom-header': 'a-value'
                    },
                    body: JSON.stringify({ a: 100, c: 2 })
                });
            });

            it("can update a JSON body while handling encoding automatically", async () => {
                await server.anyRequest().thenPassThrough({
                    transformRequest: {
                        updateJsonBody:{
                            a: 100, // Update
                            b: undefined, // Remove
                            c: 2 // Add
                        }
                    }
                });

                let rawResponse = await request.post(remoteServer.urlFor("/abc"), {
                    headers: {
                        'accept': 'application/json',
                        'content-type': 'application/json',
                        'content-encoding': 'gzip',
                        'custom-header': 'a-value'
                    },
                    body: zlib.gzipSync(
                        JSON.stringify({ a: 1, b: 2 })
                    )
                });

                const response = JSON.parse(rawResponse);
                expect(response).to.deep.equal({
                    url: remoteServer.urlFor("/abc"),
                    method: 'POST',
                    headers: {
                        ...baseHeaders(),
                        'content-encoding': 'gzip',
                        'content-length': '35',
                        'custom-header': 'a-value'
                    },
                    body: JSON.stringify({ a: 100, c: 2 })
                });
            });
        });

        describe("when configured to transform responses automatically", () => {

            beforeEach(async () => {
                server = getLocal({ debug: true });
                await server.start();
                process.env = _.merge({}, process.env, server.proxyEnv);

                // The remote server always returns a fixed value
                expect(remoteServer.port).to.not.equal(server.port);
                await remoteServer.anyRequest().thenJSON(200, {
                    'body-value': true,
                    'another-body-value': 'a value',
                }, {
                    'custom-response-header': 'custom-value'
                });
            });

            it("does nothing with an empty transform", async () => {
                await server.anyRequest().thenPassThrough({
                    transformResponse: {}
                });

                let response = await request.post(remoteServer.url, {
                    resolveWithFullResponse: true
                });

                expect(response.statusCode).to.equal(200);
                expect(response.statusMessage).to.equal('OK');
                expect(response.headers).to.deep.equal({
                    'content-type': 'application/json',
                    'content-length': '50',
                    'custom-response-header': 'custom-value'
                });
                expect(JSON.parse(response.body)).to.deep.equal({
                    'body-value': true,
                    'another-body-value': 'a value',
                });
            });

            it("can replace the response status", async () => {
                await server.anyRequest().thenPassThrough({
                    transformResponse: {
                        replaceStatus: 404
                    }
                });

                let response = await request.post(remoteServer.url, {
                    resolveWithFullResponse: true,
                    simple: false
                });

                expect(response.statusCode).to.equal(404);
                expect(response.statusMessage).to.equal('Not Found');
                expect(response.headers).to.deep.equal({
                    'content-type': 'application/json',
                    'content-length': '50',
                    'custom-response-header': 'custom-value'
                });
                expect(JSON.parse(response.body)).to.deep.equal({
                    'body-value': true,
                    'another-body-value': 'a value',
                });
            });

            it("can add extra headers", async () => {
                await server.anyRequest().thenPassThrough({
                    transformResponse: {
                        updateHeaders: {
                            'new-header': 'new-value'
                        }
                    }
                });

                let response = await request.post(remoteServer.url, {
                    resolveWithFullResponse: true,
                    simple: false
                });

                expect(response.statusCode).to.equal(200);
                expect(response.statusMessage).to.equal('OK');
                expect(response.headers).to.deep.equal({
                    'content-type': 'application/json',
                    'content-length': '50',
                    'custom-response-header': 'custom-value',
                    'new-header': 'new-value'
                });
                expect(JSON.parse(response.body)).to.deep.equal({
                    'body-value': true,
                    'another-body-value': 'a value',
                });
            });

            it("can replace specific headers", async () => {
                await server.anyRequest().thenPassThrough({
                    transformResponse: {
                        updateHeaders: {
                            'custom-response-header': 'replaced-value'
                        }
                    }
                });

                let response = await request.post(remoteServer.url, {
                    resolveWithFullResponse: true,
                    simple: false
                });

                expect(response.statusCode).to.equal(200);
                expect(response.statusMessage).to.equal('OK');
                expect(response.headers).to.deep.equal({
                    'content-type': 'application/json',
                    'content-length': '50',
                    'custom-response-header': 'replaced-value',
                });
                expect(JSON.parse(response.body)).to.deep.equal({
                    'body-value': true,
                    'another-body-value': 'a value',
                });
            });

            it("can replace all headers", async () => {
                await server.anyRequest().thenPassThrough({
                    transformResponse: {
                        replaceHeaders: {
                            'custom-replacement-header': 'replaced-value'
                        }
                    }
                });

                let response = await request.post(remoteServer.url, {
                    resolveWithFullResponse: true,
                    simple: false
                });

                expect(response.statusCode).to.equal(200);
                expect(response.statusMessage).to.equal('OK');
                expect(response.headers).to.deep.equal({
                    'custom-replacement-header': 'replaced-value'
                });
                expect(JSON.parse(response.body)).to.deep.equal({
                    'body-value': true,
                    'another-body-value': 'a value',
                });
            });

            it("can replace the body with a string", async () => {
                await server.anyRequest().thenPassThrough({
                    transformResponse: {
                        replaceBody: 'replacement-body'
                    }
                });

                let response = await request.post(remoteServer.url, {
                    resolveWithFullResponse: true,
                    simple: false
                });

                expect(response.statusCode).to.equal(200);
                expect(response.statusMessage).to.equal('OK');
                expect(response.headers).to.deep.equal({
                    'content-type': 'application/json',
                    'content-length': '16',
                    'custom-response-header': 'custom-value',
                });
                expect(response.body).to.equal('replacement-body');
            });

            it("can replace the body with a buffer", async () => {
                await server.anyRequest().thenPassThrough({
                    transformResponse: {
                        replaceBody: Buffer.from('replacement buffer', 'utf8')
                    }
                });

                let response = await request.post(remoteServer.url, {
                    resolveWithFullResponse: true,
                    simple: false
                });

                expect(response.statusCode).to.equal(200);
                expect(response.statusMessage).to.equal('OK');
                expect(response.headers).to.deep.equal({
                    'content-type': 'application/json',
                    'content-length': '18',
                    'custom-response-header': 'custom-value',
                });
                expect(response.body).to.equal('replacement buffer');
            });

            it("can replace the body with a file", async () => {
                await server.anyRequest().thenPassThrough({
                    transformResponse: {
                        updateHeaders: {
                            "content-type": 'text/plain'
                        },
                        replaceBodyFromFile:
                            path.join(__dirname, '..', 'fixtures', 'response-file.txt')
                    }
                });

                let response = await request.post(remoteServer.url, {
                    resolveWithFullResponse: true,
                    simple: false
                });

                expect(response.statusCode).to.equal(200);
                expect(response.statusMessage).to.equal('OK');
                expect(response.headers).to.deep.equal({
                    'content-type': 'text/plain',
                    'content-length': '23',
                    'custom-response-header': 'custom-value'
                });
                expect(response.body).to.equal('Response from text file');
            });

            it("should show a clear error when replacing the body with a non-existent file", async () => {
                await server.anyRequest().thenPassThrough({
                    transformResponse: {
                        replaceBodyFromFile:
                            path.join(__dirname, '..', 'fixtures', 'non-existent-file.txt')
                    }
                });

                await expect(request.post(remoteServer.url, {
                    resolveWithFullResponse: true,
                })).to.be.rejectedWith('no such file or directory');
            });

            it("can update a JSON body with new fields", async () => {
                await server.anyRequest().thenPassThrough({
                    transformResponse: {
                        updateJsonBody:{
                            'body-value': false, // Update
                            'another-body-value': undefined, // Remove
                            'new-value': 123 // Add
                        }
                    }
                });

                let response = await request.post(remoteServer.url, {
                    resolveWithFullResponse: true,
                    simple: false
                });

                expect(response.statusCode).to.equal(200);
                expect(response.statusMessage).to.equal('OK');
                expect(response.headers).to.deep.equal({
                    'content-type': 'application/json',
                    'content-length': '36',
                    'custom-response-header': 'custom-value'
                });
                expect(JSON.parse(response.body)).to.deep.equal({
                    'body-value': false,
                    'new-value': 123
                });
            });

            it("can update a JSON body while handling encoding automatically", async function () {
                if (!semver.satisfies(process.version, ZLIB_BROTLI_AVAILABLE)) this.skip();

                await server.anyRequest().thenPassThrough({
                    transformResponse: {
                        updateHeaders: {
                            'content-encoding': 'br'
                        },
                        updateJsonBody:{
                            'body-value': false, // Update
                            'another-body-value': undefined, // Remove
                            'new-value': 123 // Add
                        }
                    }
                });

                let response = await request.post(remoteServer.url, {
                    resolveWithFullResponse: true,
                    simple: false,
                    encoding: null
                });

                expect(response.statusCode).to.equal(200);
                expect(response.statusMessage).to.equal('OK');
                expect(response.headers).to.deep.equal({
                    'content-type': 'application/json',
                    'content-length': '40',
                    'custom-response-header': 'custom-value',
                    'content-encoding': 'br'
                });

                expect(
                    JSON.parse(
                        zlib.brotliDecompressSync(
                            response.body
                        ).toString('utf8')
                    )
                ).to.deep.equal({
                    'body-value': false,
                    'new-value': 123
                });
            });

        });

        describe("when configured to use an upstream proxy", () => {

            const intermediateProxy = getLocal({ debug: true });
            let proxyEndpoint: MockedEndpoint;

            beforeEach(async () => {
                server = getLocal({ debug: true });
                await server.start();

                await intermediateProxy.start();
                proxyEndpoint = await intermediateProxy.anyRequest().thenPassThrough(); // Totally neutral proxy

                // Configure Request to use the *first* server as a proxy
                process.env = _.merge({}, process.env, server.proxyEnv);
            });

            afterEach(() => intermediateProxy.stop());

            it("should forward traffic through the remote proxy", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.get('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.anyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url
                    }
                });

                const response = await request.get(remoteServer.urlFor("/test-url"));

                // We get a successful response
                expect(response).to.equal("Remote server says hi!");
                // And it went via the intermediate proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(1);
            });
        });

        describe("when configured with custom DNS options", () => {

            beforeEach(async () => {
                server = getLocal();
                await server.start();
                process.env = _.merge({}, process.env, server.proxyEnv);

                fixedDnsResponse = undefined;
            });

            let dnsServer: DestroyableServer | undefined;
            let fixedDnsResponse: string | undefined = undefined;

            before(async () => {
                dnsServer = await startDnsServer(() => fixedDnsResponse);
            });

            after(async () => {
                await dnsServer!.destroy();
            });

            it("should use default DNS settings given an empty object", async () => {
                await server.anyRequest().thenPassThrough({
                    lookupOptions: {}
                });

                await expect(
                    request.get("http://not-a-real-server.test:${remoteServer.port}")
                ).to.be.rejectedWith("ENOTFOUND"); // Goes nowhere
            });

            it("should use custom DNS servers when provided", async () => {
                remoteServer.anyRequest().thenReply(200, "remote localhost server");
                fixedDnsResponse = '127.0.0.1'; // Resolve everything to localhost

                await server.anyRequest().thenPassThrough({
                    lookupOptions: {
                        servers: [`127.0.0.1:${(dnsServer!.address() as any).port}`]
                    }
                });

                const response = await request.get(`http://still-not-real.test:${remoteServer.port}`);

                expect(response).to.equal("remote localhost server");
            });

            it("should fall back to default DNS servers when custom servers can't resolve", async function () {
                remoteServer.anyRequest().thenReply(200, "remote localhost server");
                this.timeout(10000);

                fixedDnsResponse = undefined; // Don't resolve anything

                await server.anyRequest().thenPassThrough({
                    lookupOptions: {
                        servers: [`127.0.0.1:${(dnsServer!.address() as any).port}`]
                    }
                });

                const response = await request.get({
                    url: `http://local.httptoolkit.tech:${remoteServer.port}`, // Really does resolve to localhost
                    resolveWithFullResponse: true
                });

                await expect(response.statusCode).to.equal(200);
            });
        });
    });
});
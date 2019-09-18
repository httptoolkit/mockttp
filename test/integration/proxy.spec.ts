import _ = require("lodash");
import http = require('http');
import portfinder = require('portfinder');
import { getLocal, Mockttp } from "../..";
import request = require("request-promise-native");
import { expect, nodeOnly, getDeferred, Deferred, sendRawRequest } from "../test-utils";
import { generateCACertificate } from "../../src/util/tls";
import { isLocalIPv6Available } from "../../src/util/socket-util";

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

            it("should be able to pass through requests", async () => {
                await server.get("http://example.com/").thenPassThrough();

                let response = await request.get("http://example.com/");
                expect(response).to.include(
                    "This domain is established to be used for illustrative examples in documents."
                );
            });

            it("should be able to pass through request headers", async () => {
                await server.get("http://example.com/").thenPassThrough();

                let response = await request.get({
                    uri: "http://example.com/",
                    resolveWithFullResponse: true
                });

                expect(response.headers['content-type']).to.equal('text/html; charset=UTF-8');
            });

            it("should be able to pass through requests with a body", async () => {
                await remoteServer.anyRequest().thenCallback((req) => ({
                    statusCode: 200,
                    body: req.body.text
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
                expect(await seenRequests[0].body.text).to.equal('{"test":true}');
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
                    beforeRequest: () => ({ method: 'POST' })
                });

                let response = await request.get(remoteServer.urlFor("/"));
                expect(response).to.equal("POST");
            });

            it("should be able to rewrite a request's URL", async () => {
                await remoteServer.get('/').thenReply(200, 'Root');
                await remoteServer.get('/endpoint').thenReply(200, '/endpoint');

                await server.get(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: (req) => ({ url: req.url.replace(/\/$/, '/endpoint') })
                });

                let response = await request.get(remoteServer.urlFor("/"));
                expect(response).to.equal("/endpoint");
            });

            it("should be able to rewrite a request's URL to a different host", async () => {
                await remoteServer.get('/').thenReply(200, 'my remote');

                await server.get('http://example.com').thenPassThrough({
                    beforeRequest: () => ({ url: remoteServer.url })
                });

                let response = await request.get('http://example.com');
                expect(response).to.equal("my remote");
            });

            it("should be able to rewrite a request's headers", async () => {
                await remoteServer.get('/rewrite').thenCallback((req) => ({
                    statusCode: 200,
                    json: req.headers
                }));

                await server.get(remoteServer.urlFor("/rewrite")).thenPassThrough({
                    beforeRequest: (req) => ({
                        headers: Object.assign({}, req.headers, { 'x-test-header': 'test' })
                    })
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
                await remoteServer.post('/').thenCallback((req) => ({
                    statusCode: 200,
                    body: req.body.text
                }));

                await server.post(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: (req) => ({
                        body: Buffer.from(req.body.text + ' extended')
                    })
                });

                let response = await request.post(remoteServer.urlFor("/"), {
                    body: "initial body"
                });
                expect(response).to.equal("initial body extended");
            });

            it("should be able to rewrite a request's body with an empty string", async () => {
                await remoteServer.post('/').thenCallback((req) => ({
                    statusCode: 200,
                    body: req.body.text
                }));
                await server.post(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: () => ({ body: '' })
                });

                let response = await request.post(remoteServer.urlFor("/"), {
                    body: "initial body"
                });
                expect(response).to.equal("");
            });

            it("should be able to rewrite a request's body with json", async () => {
                await remoteServer.post('/').thenCallback((req) => ({
                    statusCode: 200,
                    json: req.body.json
                }));

                await server.post(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: () => ({
                        json: { hello: "world" }
                    })
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
                    beforeResponse: () => ({
                        statusCode: 204,
                        statusMessage: 'muy bien'
                    })
                });

                let response = await request.get(remoteServer.urlFor("/"), {
                    resolveWithFullResponse: true,
                    simple: false
                });
                expect(response.statusCode).to.equal(204);
                expect(response.statusMessage).to.equal('muy bien');
            });

            it("should be able to rewrite a response's headers", async () => {
                await remoteServer.get('/').thenReply(200, '', {
                    'x-header': 'original'
                });

                await server.get(remoteServer.urlFor("/")).thenPassThrough({
                    beforeResponse: (res) => ({
                        headers: { 'x-header': res.headers['x-header'] + ' extended' }
                    })
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
                    beforeResponse: (res) => ({
                        headers: { 'content-length': undefined },
                        body: res.body.text + ' extended'
                    })
                });

                let response = await request.get(remoteServer.urlFor("/"));
                expect(response).to.equal('original text extended');
            });

            it("should be able to rewrite a response's body with json", async () => {
                await remoteServer.get('/').thenReply(200, 'text');

                await server.get(remoteServer.urlFor("/")).thenPassThrough({
                    beforeResponse: (res) => ({
                        json: { hello: "world" }
                    })
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

                    return new Promise((resolve, reject) => {
                        ipV6Server.listen({ host: '::1', family: 6, port: ipV6Port }, resolve);
                        ipV6Server.on('error', reject);
                    });
                });

                afterEach(() => new Promise((resolve, reject) => {
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

                    it("should allow passing through requests if a non-matching host is specifically listed", async () => {
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
        });
    });
});
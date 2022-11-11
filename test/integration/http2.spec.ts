import * as _ from 'lodash';
import * as net from 'net';
import * as tls from 'tls';
import * as http from 'http';
import * as https from 'https';
import * as http2 from 'http2';
import * as semver from 'semver';
import * as fs from 'fs';
import * as portfinder from 'portfinder';

import { CompletedRequest, getLocal } from "../..";
import {
    expect,
    nodeOnly,
    browserOnly,
    getHttp2Response,
    getHttp2Body,
    makeDestroyable,
    cleanup,
    fetch,
    H2_TLS_ON_TLS_SUPPORTED,
    getDeferred
} from "../test-utils";

browserOnly(() => {
    function checkHttp2Usage(config: { tls: boolean, serverHttp2: true | false | 'fallback', usesHttp2: boolean }) {
        describe(`${
            config.tls ? "with TLS" : "without TLS"
        } and HTTP/2 ${
            config.serverHttp2 === true
                ? "enabled"
            : config.serverHttp2 === 'fallback'
                ? "as a fallback"
            : "disabled"
        }`, () => {

            const server = getLocal({
                http2: config.serverHttp2,
                https: config.tls ? {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem'
                } : undefined
            });

            beforeEach(() => server.start());
            afterEach(() => server.stop());

            const expectedProtocol = config.usesHttp2 ? '2.0' : '1.1';

            it(`responds to browser requests with HTTP/${expectedProtocol}`, async () => {
                const mockRule = await server.forGet('/').thenReply(200);

                const response = await fetch(server.url);

                expect(response.status).to.equal(200);

                const seenRequests = await mockRule.getSeenRequests();
                expect(seenRequests.length).to.equal(1);
                expect(seenRequests[0].httpVersion).to.equal(expectedProtocol);
            });
        });
    }

    describe("Using Mockttp with HTTP/2", () => {

        checkHttp2Usage({ tls: true, serverHttp2: true, usesHttp2: true });
        checkHttp2Usage({ tls: true, serverHttp2: 'fallback', usesHttp2: false });
        checkHttp2Usage({ tls: true, serverHttp2: false, usesHttp2: false });

        checkHttp2Usage({ tls: false, serverHttp2: true, usesHttp2: false });
        checkHttp2Usage({ tls: false, serverHttp2: 'fallback', usesHttp2: false });
        checkHttp2Usage({ tls: false, serverHttp2: false, usesHttp2: false });

    });
});

nodeOnly(() => {
    describe("Using Mockttp with HTTP/2", function () {

        describe("without TLS", () => {

            const server = getLocal();

            beforeEach(() => server.start());
            afterEach(() => server.stop());

            it("can respond to direct HTTP/2 requests", async () => {
                await server.forGet('/').thenReply(200, "HTTP2 response!");

                const client = http2.connect(server.url);

                const req = client.request();

                const responseHeaders = await getHttp2Response(req);
                expect(responseHeaders[':status']).to.equal(200);

                expect(client.alpnProtocol).to.equal('h2c'); // Plaintext HTTP/2

                const responseBody = await getHttp2Body(req);
                expect(responseBody.toString('utf8')).to.equal("HTTP2 response!");

                await cleanup(client);
            });

            it("can respond to proxied HTTP/2 requests", async () => {
                await server.forGet('http://example.com/mocked-endpoint')
                    .thenReply(200, "Proxied HTTP2 response!");

                const client = http2.connect(server.url);

                const req = client.request({
                    ':method': 'CONNECT',
                    ':authority': 'example.com:80'
                });

                // Initial response, the proxy has set up our tunnel:
                const responseHeaders = await getHttp2Response(req);
                expect(responseHeaders[':status']).to.equal(200);

                // We can now read/write to req as a raw TCP socket to example.com:
                const proxiedClient = http2.connect('http://example.com', {
                     // Tunnel this request through the proxy stream
                    createConnection: () => req
                });

                const proxiedRequest = proxiedClient.request({
                    ':path': '/mocked-endpoint'
                });
                const proxiedResponse = await getHttp2Response(proxiedRequest);
                expect(proxiedResponse[':status']).to.equal(200);

                const responseBody = await getHttp2Body(proxiedRequest);
                expect(responseBody.toString('utf8')).to.equal("Proxied HTTP2 response!");

                await cleanup(proxiedClient, client);
            });

            it("can respond to HTTP1-proxied HTTP/2 requests", async () => {
                await server.forGet('http://example.com/mocked-endpoint')
                    .thenReply(200, "Proxied HTTP2 response!");

                // Get an HTTP/1.1 tunnel:
                const req = http.request({
                    method: 'CONNECT',
                    host: 'localhost',
                    port: server.port,
                    path: 'example.com'
                });
                req.end();

                const tunnelledSocket = await new Promise<net.Socket>((resolve) => {
                    req.on('connect', (_res, socket) => resolve(socket));
                });

                // We can now read/write to our raw TCP socket to example.com:
                const client = http2.connect('http://example.com', {
                    // Tunnel this request through the HTTP/1.1 tunnel:
                    createConnection: () => tunnelledSocket
                });

                const proxiedRequest = client.request({
                    ':path': '/mocked-endpoint'
                });
                const proxiedResponse = await getHttp2Response(proxiedRequest);
                expect(proxiedResponse[':status']).to.equal(200);

                const responseBody = await getHttp2Body(proxiedRequest);
                expect(responseBody.toString('utf8')).to.equal("Proxied HTTP2 response!");

                await cleanup(client, tunnelledSocket);
            });

            describe("with a remote HTTPS server", () => {
                const remoteServer = getLocal({
                    https: {
                        keyPath: './test/fixtures/test-ca.key',
                        certPath: './test/fixtures/test-ca.pem'
                    }
                });

                beforeEach(() => remoteServer.start());
                afterEach(() => remoteServer.stop());

                it("can forward requests upstream", async () => {
                    await remoteServer.forGet('/mocked-endpoint')
                        .thenReply(200, "Remote HTTP2 response!");
                    await server.forGet(remoteServer.urlFor('/mocked-endpoint'))
                        .thenPassThrough();

                    const client = http2.connect(server.url);

                    const req = client.request({
                        ':method': 'CONNECT',
                        ':authority': `localhost:${remoteServer.port}`
                    });

                    // Initial response, so the proxy has set up our tunnel:
                    const responseHeaders = await getHttp2Response(req);
                    expect(responseHeaders[':status']).to.equal(200);

                    // We can now read/write to req as a raw TCP socket to remoteServer:
                    const proxiedClient = http2.connect(remoteServer.url, {
                        // Tunnel this request through the proxy stream
                        createConnection: () => req
                    });

                    const proxiedRequest = proxiedClient.request({
                        ':path': '/mocked-endpoint'
                    });
                    const proxiedResponse = await getHttp2Response(proxiedRequest);
                    expect(proxiedResponse[':status']).to.equal(200);

                    const responseBody = await getHttp2Body(proxiedRequest);
                    expect(responseBody.toString('utf8')).to.equal("Remote HTTP2 response!");

                    await cleanup(proxiedClient, client);
                });

                it("reformats forwarded request headers for HTTP/1.1", async () => {
                    const mockedEndpoint = await remoteServer.forGet('/mocked-endpoint')
                        .thenReply(200, "Remote HTTP2 response!");
                    await server.forGet(remoteServer.urlFor('/mocked-endpoint'))
                        .thenPassThrough();

                    const client = http2.connect(server.url);

                    const req = client.request({
                        ':method': 'CONNECT',
                        ':authority': `localhost:${remoteServer.port}`
                    });

                    // Initial response, so the proxy has set up our tunnel:
                    const responseHeaders = await getHttp2Response(req);
                    expect(responseHeaders[':status']).to.equal(200);

                    // We can now read/write to req as a raw TCP socket to remoteServer:
                    const proxiedClient = http2.connect(remoteServer.url, {
                        // Tunnel this request through the proxy stream
                        createConnection: () => req
                    });

                    const proxiedReq = proxiedClient.request({
                        ':path': '/mocked-endpoint',
                        'Cookie': 'a=b',
                        'cookie': 'b=c'
                    });
                    await getHttp2Response(proxiedReq);

                    const seenRequests = await mockedEndpoint.getSeenRequests();
                    expect(seenRequests.length).to.equal(1);

                    expect(seenRequests[0].headers).to.deep.equal({
                        'host': `localhost:${remoteServer.port}`, // Host replaces :authority
                        'connection': 'keep-alive', // We add this for upstream, as all H2 are keep-alive
                        'cookie': 'a=b; b=c' // Concatenated automatically
                    });

                    await cleanup(proxiedReq, proxiedClient, client);
                });

                it("reformats forwarded response headers for HTTP/1.1", async () => {
                    await remoteServer.forGet('/mocked-endpoint')
                        .thenReply(200, "Remote HTTP2 response!", {
                            'HEADER-KEY': 'HEADER-VALUE',
                            'Connection': 'close'
                        });
                    await server.forGet(remoteServer.urlFor('/mocked-endpoint'))
                        .thenPassThrough();

                    const client = http2.connect(server.url);

                    const req = client.request({
                        ':method': 'CONNECT',
                        ':authority': `localhost:${remoteServer.port}`
                    });

                    // Initial response, so the proxy has set up our tunnel:
                    const responseHeaders = await getHttp2Response(req);
                    expect(responseHeaders[':status']).to.equal(200);

                    // We can now read/write to req as a raw TCP socket to remoteServer:
                    const proxiedClient = http2.connect(remoteServer.url, {
                        // Tunnel this request through the proxy stream
                        createConnection: () => req
                    });

                    const proxiedRequest = proxiedClient.request({
                        ':path': '/mocked-endpoint',
                    });

                    const proxiedResponseHeaders = await getHttp2Response(proxiedRequest);

                    expect(_.omit(proxiedResponseHeaders, 'date')).to.deep.equal({
                        ':status': 200,
                        'header-key': 'HEADER-VALUE' // We lowercase all header keys
                        // Connection: close is omitted
                    });

                    await cleanup(proxiedRequest, proxiedClient, client);
                });
            });

        });

        describe("with TLS", () => {

            const server = getLocal({
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem'
                }
            });

            beforeEach(() => server.start());
            afterEach(() => server.stop());

            it("can respond to direct HTTP/2 requests", async () => {
                await server.forGet('/').thenReply(200, "HTTP2 response!");

                const client = http2.connect(server.url);

                const req = client.request();

                const responseHeaders = await getHttp2Response(req);
                expect(responseHeaders[':status']).to.equal(200);

                expect(client.alpnProtocol).to.equal('h2'); // HTTP/2 over TLS

                const responseBody = await getHttp2Body(req);
                expect(responseBody.toString('utf8')).to.equal("HTTP2 response!");

                await cleanup(client);
            });

            it("can respond to proxied HTTP/2 requests", async function() {
                if (!semver.satisfies(process.version, H2_TLS_ON_TLS_SUPPORTED)) this.skip();

                await server.forGet('https://example.com/mocked-endpoint')
                    .thenReply(200, "Proxied HTTP2 response!");

                const client = http2.connect(server.url);

                const req = client.request({
                    ':method': 'CONNECT',
                    ':authority': 'example.com:443'
                });

                // Initial response, the proxy has set up our tunnel:
                const responseHeaders = await getHttp2Response(req);
                expect(responseHeaders[':status']).to.equal(200);

                // We can now read/write to req as a raw TCP socket to example.com:
                const proxiedClient = http2.connect('https://example.com', {
                     // Tunnel this request through the proxy stream
                    createConnection: () => tls.connect({
                        socket: req as any,
                        ALPNProtocols: ['h2']
                    })
                });

                const proxiedRequest = proxiedClient.request({
                    ':path': '/mocked-endpoint'
                });
                const proxiedResponse = await getHttp2Response(proxiedRequest);
                expect(proxiedResponse[':status']).to.equal(200);

                const responseBody = await getHttp2Body(proxiedRequest);
                expect(responseBody.toString('utf8')).to.equal("Proxied HTTP2 response!");

                await cleanup(proxiedClient, client);
            });

            it("should include request metadata in events for proxied HTTP/2 requests", async function() {
                if (!semver.satisfies(process.version, H2_TLS_ON_TLS_SUPPORTED)) this.skip();

                let seenRequestPromise = getDeferred<CompletedRequest>();
                await server.on('request', (r) => seenRequestPromise.resolve(r));

                await server.forGet('https://example.com/mocked-endpoint')
                    .thenReply(200, "Proxied HTTP2 response!");

                const client = http2.connect(server.url);

                const req = client.request({
                    ':method': 'CONNECT',
                    ':authority': 'example.com:443'
                });

                // Initial response, the proxy has set up our tunnel:
                const responseHeaders = await getHttp2Response(req);
                expect(responseHeaders[':status']).to.equal(200);

                // We can now read/write to req as a raw TCP socket to example.com:
                const proxiedClient = http2.connect('https://example.com', {
                     // Tunnel this request through the proxy stream
                    createConnection: () => tls.connect({
                        socket: req as any,
                        ALPNProtocols: ['h2']
                    })
                });

                const proxiedRequest = proxiedClient.request({
                    ':path': '/mocked-endpoint'
                });
                await getHttp2Response(proxiedRequest);
                await getHttp2Body(proxiedRequest)

                const seenRequest = await seenRequestPromise;
                expect(seenRequest.method).to.equal('GET');
                expect(seenRequest.protocol).to.equal('https');
                expect(seenRequest.httpVersion).to.equal('2.0');
                expect(seenRequest.url).to.equal("https://example.com/mocked-endpoint");
                expect(seenRequest.remoteIpAddress).to.be.oneOf([
                    '::ffff:127.0.0.1', // IPv4 localhost
                    '::1' // IPv6 localhost
                ]);
                expect(seenRequest.remotePort).to.be.greaterThan(32768);

                await cleanup(proxiedClient, client);
            });

            it("can respond to HTTP1-proxied HTTP/2 requests", async function() {
                if (!semver.satisfies(process.version, H2_TLS_ON_TLS_SUPPORTED)) this.skip();

                await server.forGet('https://example.com/mocked-endpoint')
                    .thenReply(200, "Proxied HTTP2 response!");

                // Get an HTTP/1.1 tunnel:
                const req = https.request({
                    method: 'CONNECT',
                    host: 'localhost',
                    port: server.port,
                    path: 'example.com'
                });
                req.end();

                const tunnelledSocket = await new Promise<net.Socket>((resolve) => {
                    req.on('connect', (_res, socket) => resolve(socket));
                });

                // We can now read/write to our raw TCP socket to example.com:
                const client = http2.connect('https://example.com', {
                    // Tunnel this request through the HTTP/1.1 tunnel, via TLS:
                    createConnection: () => tls.connect({
                        socket: tunnelledSocket,
                        ALPNProtocols: ['h2']
                    })
                });

                const proxiedRequest = client.request({
                    ':path': '/mocked-endpoint'
                });
                const proxiedResponse = await getHttp2Response(proxiedRequest);
                expect(proxiedResponse[':status']).to.equal(200);

                const responseBody = await getHttp2Body(proxiedRequest);
                expect(responseBody.toString('utf8')).to.equal("Proxied HTTP2 response!");

                await cleanup(tunnelledSocket, client);
            });

            describe("to an HTTP/2-only target", () => {

                const http2Server = makeDestroyable(http2.createSecureServer({
                    allowHTTP1: false,
                    key: fs.readFileSync('./test/fixtures/test-ca.key'),
                    cert: fs.readFileSync('./test/fixtures/test-ca.pem')
                }, (req, res) => {
                    res.writeHead(200);
                    res.end("Real HTTP/2 response");
                }));

                let targetPort: number;

                beforeEach(async () => {
                    targetPort = await portfinder.getPortPromise();

                    await new Promise<void>(async (resolve, reject) => {
                        http2Server.on('error', reject);
                        http2Server.listen(targetPort, resolve);
                    });
                });

                afterEach(() => http2Server.destroy());

                it("can pass through end-to-end HTTP/2", async function () {
                    if (!semver.satisfies(process.version, H2_TLS_ON_TLS_SUPPORTED)) this.skip();

                    await server.forGet(`https://localhost:${targetPort}/`)
                        .thenPassThrough({ ignoreHostHttpsErrors: ['localhost'] });

                    const client = http2.connect(server.url);

                    const req = client.request({
                        ':method': 'CONNECT',
                        ':authority': `localhost:${targetPort}`
                    });

                    // Initial response, the proxy has set up our tunnel:
                    const responseHeaders = await getHttp2Response(req);
                    expect(responseHeaders[':status']).to.equal(200);

                    // We can now read/write to req as a raw TCP socket to our target server
                    const proxiedClient = http2.connect(`https://localhost:${targetPort}`, {
                         // Tunnel this request through the proxy stream
                        createConnection: () => tls.connect({
                            socket: req as any,
                            ALPNProtocols: ['h2']
                        })
                    });
                    

                    const proxiedRequest = proxiedClient.request({
                        ':path': '/'
                    });
                    const proxiedResponse = await getHttp2Response(proxiedRequest);
                    expect(proxiedResponse[':status']).to.equal(200);

                    const responseBody = await getHttp2Body(proxiedRequest);
                    expect(responseBody.toString('utf8')).to.equal("Real HTTP/2 response");

                    await cleanup(proxiedClient, client);
                });

            });

        });

    });
});
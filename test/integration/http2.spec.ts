import _ from 'lodash';
import * as net from 'net';
import * as tls from 'tls';
import * as http from 'http';
import * as https from 'https';
import * as http2 from 'http2';
import * as fs from 'fs';
import getPort from 'get-port';

import { CompletedRequest, CompletedResponse, getLocal, requestSteps } from "../..";
import {
    expect,
    nodeOnly,
    browserOnly,
    getHttp2Response,
    getHttp2Body,
    makeDestroyable,
    cleanup,
    BROKEN_H2_OVER_H2_TUNNELLING,
    getDeferred,
    nodeSatisfies
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

        describe("without TLS", function () {

            if (nodeSatisfies(BROKEN_H2_OVER_H2_TUNNELLING)) return;

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

                    expect(
                        _.omit(proxiedResponseHeaders, ['date', http2.sensitiveHeaders])
                    ).to.deep.equal({
                        ':status': 200,
                        'header-key': 'HEADER-VALUE' // We lowercase all header keys
                        // Connection: close is omitted
                    });

                    await cleanup(proxiedRequest, proxiedClient, client);
                });

                it("preserves duplicated-key HTTP/2 response headers", async () => {
                    const mockedEndpoint = await remoteServer.forGet('/mocked-endpoint')
                        .thenReply(200, "Remote HTTP2 response!", {
                            'set-cookie': ['a', 'b']
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

                    const proxiedReq = proxiedClient.request({
                        ':path': '/mocked-endpoint'
                    });
                    const response = await getHttp2Response(proxiedReq);

                    expect(response['set-cookie']).to.deep.equal(
                        ['a', 'b']
                    );

                    await cleanup(proxiedReq, proxiedClient, client);
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
                expect(seenRequest.remotePort).to.be.greaterThanOrEqual(32768);

                await cleanup(proxiedClient, client);
            });

            it("should include response metadata in events for proxied HTTP/2 responses", async function() {
                let seenResponsePromise = getDeferred<CompletedResponse>();
                await server.on('response', (r) => seenResponsePromise.resolve(r));

                await server.forGet('https://example.com/mocked-endpoint')
                    .thenReply(200, "Proxied HTTP2 response!", {
                        'TEST-header': 'value'
                    });

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

                const seenResponse = await seenResponsePromise;
                expect(seenResponse.statusCode).to.equal(200);
                expect(seenResponse.statusMessage).to.equal('');
                expect(seenResponse.headers).to.deep.equal({
                    ':status': '200',
                    'test-header': 'value'
                });
                expect(seenResponse.rawHeaders).to.deep.equal([
                    [':status', '200'],
                    ['TEST-header', 'value']
                ]);
                expect(await seenResponse.body.getText()).to.equal('Proxied HTTP2 response!');

                await cleanup(proxiedClient, client);
            });

            it("can respond to HTTP1-proxied HTTP/2 requests", async function() {
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

                await cleanup(tunnelledSocket);
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
                    targetPort = await getPort();

                    await new Promise<void>(async (resolve, reject) => {
                        http2Server.on('error', reject);
                        http2Server.listen(targetPort, resolve);
                    });
                });

                afterEach(() => http2Server.destroy());

                it("can pass through end-to-end HTTP/2", async function () {
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

                it("can pass through HTTP/2 with duplicate single-value request headers", async function () {
                    if (!nodeSatisfies(">=25.7.0")) this.skip();

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
                        }),
                        // Allow the test client to send duplicate single-value headers:
                        strictSingleValueFields: false
                    } as any);

                    const proxiedRequest = proxiedClient.request({
                        ':path': '/',
                        'user-agent': ['agent-1', 'agent-2'] as any
                    });
                    const proxiedResponse = await getHttp2Response(proxiedRequest);
                    expect(proxiedResponse[':status']).to.equal(200);

                    const responseBody = await getHttp2Body(proxiedRequest);
                    expect(responseBody.toString('utf8')).to.equal("Real HTTP/2 response");

                    await cleanup(proxiedClient, client);
                });

            });

            describe("sending responses with no body", () => {

                interface FramedResponse {
                    headers: http2.IncomingHttpHeaders;
                    // Whether END_STREAM was set on the response's HEADERS frame:
                    headersEnded: boolean;
                    body: string;
                    trailers?: http2.IncomingHttpHeaders;
                    rstCode?: number;
                    headersReceivedAt?: number;
                    closedAt?: number;
                }

                function sendRequest(client: http2.ClientHttp2Session, path: string) {
                    return new Promise<FramedResponse>((resolve, reject) => {
                        const req = client.request({
                            ':method': 'POST',
                            ':path': path,
                            'content-type': 'application/grpc',
                            'te': 'trailers'
                        }, { endStream: true });

                        const result: FramedResponse = { headers: {}, headersEnded: false, body: '' };
                        req.on('response', (headers, flags) => {
                            result.headersReceivedAt = Date.now();
                            result.headers = headers;
                            result.headersEnded = (flags & http2.constants.NGHTTP2_FLAG_END_STREAM) !== 0;
                        });
                        req.on('trailers', (trailers) => { result.trailers = trailers; });
                        req.setEncoding('utf8');
                        req.on('data', (chunk: string) => { result.body += chunk; });
                        req.on('error', reject);
                        req.on('close', () => resolve({ ...result, rstCode: req.rstCode, closedAt: Date.now() }));
                    });
                }

                const grpcError = {
                    'content-type': 'application/grpc',
                    'grpc-status': '5',
                    'grpc-message': 'not%20found'
                };

                describe("from a callback", () => {

                    async function callbackResponse(result: requestSteps.CallbackResponseMessageResult) {
                        await server.forPost('/svc.Service/Method').thenCallback(() => result);
                        const client = http2.connect(server.url);
                        try {
                            return await sendRequest(client, '/svc.Service/Method');
                        } finally {
                            await cleanup(client);
                        }
                    }

                    it("sends headers alone as a single HEADERS frame with END_STREAM", async () => {
                        const response = await callbackResponse({ statusCode: 200, headers: grpcError });

                        expect(response.headersEnded).to.equal(true);
                        expect(response.headers[':status']).to.equal(200);
                        expect(response.headers['grpc-status']).to.equal('5');
                        expect(response.headers['grpc-message']).to.equal('not%20found');
                        expect(response.body).to.equal('');
                        expect(response.trailers).to.equal(undefined);
                        expect(response.rstCode).to.equal(http2.constants.NGHTTP2_NO_ERROR);
                    });

                    it("treats an empty body as no body", async () => {
                        const response = await callbackResponse({ statusCode: 200, headers: grpcError, body: '' });
                        expect(response.headersEnded).to.equal(true);
                        expect(response.headers['grpc-status']).to.equal('5');
                    });

                    it("does the same with repeated Set-Cookie headers", async () => {
                        const response = await callbackResponse({
                            statusCode: 404,
                            headers: {
                                'content-type': 'application/grpc',
                                'set-cookie': ['a=1', 'b=2']
                            }
                        });
                        expect(response.headersEnded).to.equal(true);
                        expect(response.headers[':status']).to.equal(404);
                        expect(response.headers['set-cookie']).to.deep.equal(['a=1', 'b=2']);
                    });

                    it("reports the response's status and headers in the response event", async () => {
                        const responseEvent = getDeferred<CompletedResponse>();
                        await server.on('response', (r) => responseEvent.resolve(r));

                        await callbackResponse({ statusCode: 200, headers: grpcError });

                        const response = await responseEvent;
                        expect(response.statusCode).to.equal(200);
                        expect(response.headers['grpc-status']).to.equal('5');
                        expect(response.headers['grpc-message']).to.equal('not%20found');
                        expect(response.rawHeaders[0]).to.deep.equal([':status', '200']);
                    });

                    it("still sends a body after the headers", async () => {
                        const response = await callbackResponse({ statusCode: 200, body: 'some body' });
                        expect(response.headersEnded).to.equal(false);
                        expect(response.body).to.equal('some body');
                    });

                    it("still sends trailers after the headers", async () => {
                        const response = await callbackResponse({
                            statusCode: 200,
                            headers: { 'content-type': 'application/grpc' },
                            trailers: { 'grpc-status': '5' }
                        });
                        expect(response.headersEnded).to.equal(false);
                        expect(response.headers['grpc-status']).to.equal(undefined);
                        expect(response.trailers?.['grpc-status']).to.equal('5');
                    });

                    it("still rejects an invalid status as before", async () => {
                        const response = await callbackResponse({ statusCode: 101, headers: grpcError });
                        expect(response.headers[':status']).to.equal(500);
                        expect(response.rstCode).to.equal(http2.constants.NGHTTP2_NO_ERROR);
                    });

                    it("still sends other repeated headers the usual way", async () => {
                        // Node checks these only as it sends them, so they aren't sent with the end:
                        const response = await callbackResponse({
                            statusCode: 200,
                            headers: { ...grpcError, 'vary': ['a', 'b'] }
                        });
                        expect(response.headersEnded).to.equal(false);
                        expect(response.headers[':status']).to.equal(200);
                        expect(response.headers['grpc-status']).to.equal('5');
                        expect(response.rstCode).to.equal(http2.constants.NGHTTP2_NO_ERROR);
                    });
                });

                describe("passed through from an HTTP/2 target", () => {

                    const targetServer = makeDestroyable(http2.createSecureServer({
                        allowHTTP1: false,
                        key: fs.readFileSync('./test/fixtures/test-ca.key'),
                        cert: fs.readFileSync('./test/fixtures/test-ca.pem')
                    }));

                    targetServer.on('stream', (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
                        const path = headers[':path'];
                        if (path === '/headers-only') {
                            stream.respond({ ':status': 200, ...grpcError }, { endStream: true });
                        } else if (path === '/body-at-once') {
                            stream.respond({ ':status': 200, 'content-type': 'text/plain' });
                            stream.end('the whole body');
                        } else if (path === '/end-later') {
                            stream.respond({ ':status': 200, 'content-type': 'text/plain' });
                            setTimeout(() => stream.end(), 300);
                        } else if (path === '/with-trailers') {
                            stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
                            stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
                            stream.end(Buffer.from([0, 0, 0, 0, 0]));
                        } else {
                            stream.respond({ ':status': 404 }, { endStream: true });
                        }
                    });

                    let targetPort: number;

                    beforeEach(async () => {
                        targetPort = await getPort();
                        await new Promise<void>((resolve, reject) => {
                            targetServer.once('error', reject);
                            targetServer.listen(targetPort, resolve);
                        });
                    });

                    afterEach(() => targetServer.destroy());

                    async function proxiedResponse(
                        path: string,
                        passThroughOptions: requestSteps.PassThroughStepOptions = {}
                    ) {
                        await server.forAnyRequest().thenPassThrough({
                            ignoreHostHttpsErrors: ['localhost'],
                            ...passThroughOptions
                        });

                        const client = http2.connect(server.url);
                        const tunnel = client.request({
                            ':method': 'CONNECT',
                            ':authority': `localhost:${targetPort}`
                        });
                        expect((await getHttp2Response(tunnel))[':status']).to.equal(200);

                        const proxiedClient = http2.connect(`https://localhost:${targetPort}`, {
                            createConnection: () => tls.connect({
                                socket: tunnel as any,
                                ALPNProtocols: ['h2']
                            })
                        });
                        try {
                            return await sendRequest(proxiedClient, path);
                        } finally {
                            await cleanup(proxiedClient, client);
                        }
                    }

                    it("sends a response the target ended with its headers in the same way", async () => {
                        const response = await proxiedResponse('/headers-only');

                        expect(response.headersEnded).to.equal(true);
                        expect(response.headers[':status']).to.equal(200);
                        expect(response.headers['grpc-status']).to.equal('5');
                        expect(response.body).to.equal('');
                        expect(response.rstCode).to.equal(http2.constants.NGHTTP2_NO_ERROR);
                    });

                    it("does the same for other responses with no body, like a 404", async () => {
                        const response = await proxiedResponse('/missing');
                        expect(response.headersEnded).to.equal(true);
                        expect(response.headers[':status']).to.equal(404);
                    });

                    it("reports such a response's status and headers in the response event", async () => {
                        const responseEvent = getDeferred<CompletedResponse>();
                        await server.on('response', (r) => responseEvent.resolve(r));

                        await proxiedResponse('/headers-only');

                        const response = await responseEvent;
                        expect(response.statusCode).to.equal(200);
                        expect(response.headers['grpc-status']).to.equal('5');
                        expect(response.rawHeaders[0]).to.deep.equal([':status', '200']);
                    });

                    it("doesn't lose a short body that arrives with the end", async () => {
                        const response = await proxiedResponse('/body-at-once');
                        expect(response.headersEnded).to.equal(false);
                        expect(response.body).to.equal('the whole body');
                    });

                    it("doesn't hold back headers until a slow response ends", async () => {
                        const response = await proxiedResponse('/end-later');
                        expect(response.headersEnded).to.equal(false);
                        expect(response.body).to.equal('');
                        // The target ends 300ms after its headers, so they must arrive well before the end:
                        expect(response.closedAt! - response.headersReceivedAt!).to.be.at.least(200);
                    });

                    it("still sends a body that replaces the target's empty one", async () => {
                        const response = await proxiedResponse('/headers-only', {
                            transformResponse: { replaceBody: 'replaced' }
                        });
                        expect(response.headersEnded).to.equal(false);
                        expect(response.body).to.equal('replaced');
                    });

                    it("still sends a body read by beforeResponse", async () => {
                        const response = await proxiedResponse('/body-at-once', {
                            beforeResponse: () => undefined
                        });
                        expect(response.headersEnded).to.equal(false);
                        expect(response.body).to.equal('the whole body');
                    });

                    it("doesn't lose a body that arrived while the headers were being changed", async () => {
                        const response = await proxiedResponse('/body-at-once', {
                            transformResponse: { updateHeaders: { 'x-changed': 'yes' } }
                        });
                        expect(response.headersEnded).to.equal(false);
                        expect(response.headers['x-changed']).to.equal('yes');
                        expect(response.body).to.equal('the whole body');
                    });

                    it("still sends trailers after the body", async () => {
                        const response = await proxiedResponse('/with-trailers');
                        expect(response.headersEnded).to.equal(false);
                        expect(response.body.length).to.equal(5);
                        expect(response.trailers?.['grpc-status']).to.equal('0');
                    });
                });
            });

            describe("to a lenient HTTP/2 target accepting duplicate single-value headers", () => {

                // Upstream HTTP/2 server with strictSingleValueFields disabled, so it can
                // receive duplicate single-value request headers and send duplicate
                // single-value response headers (e.g. x-content-type-options).
                const lenientH2Server = makeDestroyable(http2.createSecureServer({
                    allowHTTP1: false,
                    key: fs.readFileSync('./test/fixtures/test-ca.key'),
                    cert: fs.readFileSync('./test/fixtures/test-ca.pem'),
                    strictSingleValueFields: false
                } as any));

                // Use the low-level stream API to bypass the compat-layer header
                // validation and directly emit duplicate single-value headers.
                lenientH2Server.on('stream', (stream: http2.ServerHttp2Stream, headers: any, flags: number, rawHeaders: string[]) => {
                    // Capture the values we received for x-test-header (from rawHeaders,
                    // since the compat-style headers object collapses duplicates) and
                    // echo them back so the test can verify request-direction duplicates.
                    const received: string[] = [];
                    for (let i = 0; i < rawHeaders.length; i += 2) {
                        if (rawHeaders[i].toLowerCase() === 'x-test-header') {
                            received.push(rawHeaders[i + 1]);
                        }
                    }

                    stream.respond({
                        ':status': 200,
                        'x-received-test-header': JSON.stringify(received),
                        // Duplicate single-value response header to test response direction:
                        'x-content-type-options': ['nosniff', 'nosniff']
                    } as any);
                    stream.end("Real HTTP/2 response");
                });

                let targetPort: number;

                beforeEach(async () => {
                    targetPort = await getPort();
                    await new Promise<void>((resolve, reject) => {
                        lenientH2Server.on('error', reject);
                        lenientH2Server.listen(targetPort, resolve);
                    });
                });

                afterEach(() => lenientH2Server.destroy());

                it("preserves duplicate single-value headers in both directions", async function () {
                    if (!nodeSatisfies(">=24.15.0")) this.skip();

                    await server.forGet(`https://localhost:${targetPort}/`)
                        .thenPassThrough({ ignoreHostHttpsErrors: ['localhost'] });

                    const client = http2.connect(server.url);

                    const req = client.request({
                        ':method': 'CONNECT',
                        ':authority': `localhost:${targetPort}`
                    });

                    const responseHeaders = await getHttp2Response(req);
                    expect(responseHeaders[':status']).to.equal(200);

                    const proxiedClient = http2.connect(`https://localhost:${targetPort}`, {
                        createConnection: () => tls.connect({
                            socket: req as any,
                            ALPNProtocols: ['h2']
                        }),
                        // Allow the test client to send duplicate single-value headers:
                        strictSingleValueFields: false
                    } as any);

                    const proxiedRequest = proxiedClient.request({
                        ':path': '/',
                        'x-test-header': ['value-1', 'value-2'] as any
                    });

                    // Capture both parsed headers and rawHeaders, since the parsed
                    // headers object collapses duplicate single-value fields.
                    const responseInfo = await new Promise<{
                        headers: http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader,
                        rawHeaders: string[]
                    }>((resolve, reject) => {
                        proxiedRequest.on('response', (headers, _flags, rawHeaders) => {
                            resolve({ headers, rawHeaders });
                        });
                        proxiedRequest.on('error', reject);
                    });

                    expect(responseInfo.headers[':status']).to.equal(200);

                    // Request direction: both header values must reach upstream.
                    expect(responseInfo.headers['x-received-test-header']).to.equal(
                        JSON.stringify(['value-1', 'value-2'])
                    );

                    // Response direction: duplicate single-value response header
                    // must reach the test client, with both copies preserved on the wire.
                    const ctoValues: string[] = [];
                    for (let i = 0; i < responseInfo.rawHeaders.length; i += 2) {
                        if (responseInfo.rawHeaders[i].toLowerCase() === 'x-content-type-options') {
                            ctoValues.push(responseInfo.rawHeaders[i + 1]);
                        }
                    }
                    expect(ctoValues).to.deep.equal(['nosniff', 'nosniff']);

                    const responseBody = await getHttp2Body(proxiedRequest);
                    expect(responseBody.toString('utf8')).to.equal("Real HTTP/2 response");

                    await cleanup(proxiedClient, client);
                });

            });

        });

    });
});
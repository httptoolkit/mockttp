import { Buffer } from 'buffer';
import * as http from 'http';
import * as zlib from 'zlib';

import _ = require("lodash");
import portfinder = require('portfinder');
import request = require("request-promise-native");

import {
    Mockttp,
    getLocal,
    AbortedRequest,
    CompletedRequest,
    Request
} from "../../..";
import {
    expect,
    nodeOnly,
    getDeferred,
    Deferred,
    sendRawRequest,
    makeAbortableRequest,
    defaultNodeConnectionHeader
} from "../../test-utils";
import { isLocalIPv6Available } from "../../../src/util/socket-util";
import { streamToBuffer } from "../../../src/util/buffer-utils";

const INITIAL_ENV = _.cloneDeep(process.env);

nodeOnly(() => {
    describe("Mockttp when used as an HTTP proxy", function () {

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
                await server.forGet("http://example.com/endpoint").thenReply(200, "mocked data");

                let response = await request.get("http://example.com/endpoint");
                expect(response).to.equal("mocked data");
            });

            it("should mock proxied HTTP matching relative URLs", async () => {
                await server.forGet("/endpoint").thenReply(200, "mocked data");
                let response = await request.get("http://example.com/endpoint");
                expect(response).to.equal("mocked data");
            });

            it("should mock proxied HTTP matching absolute protocol-less URLs", async () => {
                await server.forGet("example.com/endpoint").thenReply(200, "mocked data");
                let response = await request.get("http://example.com/endpoint");
                expect(response).to.equal("mocked data");
            });

            it("should mock proxied HTTP matching badly formatted URLs with empty paths", async () => {
                await server.forGet('/').thenReply(200, 'Mock response');

                const response = await sendRawRequest(server, 'GET http://example.com HTTP/1.1\r\n\r\n');
                expect(response).to.include('HTTP/1.1 200 OK');
                expect(response).to.include('Mock response');
            });

            it("should mock proxied HTTP matching requests by host", async () => {
                await server.forGet().forHost('example.com').thenReply(200, "host matched");

                await expect(
                    await request.get("http://example.com/")
                ).to.equal('host matched');

                await expect(
                    request.get("http://different-host.com/")
                ).to.be.rejectedWith('No rules were found matching this request');
            });

            it("should be able to pass through requests", async function () {
                await server.forGet("http://example.testserver.host/").thenPassThrough();

                let response = await request.get("http://example.testserver.host/");
                expect(response).to.include(
                    "This domain is for use in illustrative examples in documents."
                );
            });

            it("should be able to pass through request headers", async () => {
                await remoteServer.forAnyRequest().thenCallback(async (req) => {
                    expect(req.headers).to.deep.equal({
                        'dupe-header': ['A', 'B'],
                        uppercaseheader: 'VALUE',
                        host: `localhost:${remoteServer.port}`,
                        connection: defaultNodeConnectionHeader
                    });

                    expect(req.rawHeaders).to.deep.equal([
                        ['Dupe-Header', 'A'],
                        ['UPPERCASEHEADER', 'VALUE'],
                        ['Dupe-Header', 'B'],
                        ['Host', `localhost:${remoteServer.port}`],
                        ['Connection', defaultNodeConnectionHeader] // Added by node in initial request
                    ]);
                    return {};
                });

                await server.forGet(remoteServer.url).thenPassThrough();

                const request = http.request({
                    method: 'GET',
                    hostname: 'localhost',
                    port: server.port,
                    headers: [
                        ['Dupe-Header', 'A'],
                        ['UPPERCASEHEADER', 'VALUE'],
                        ['Dupe-Header', 'B'],
                        ['Host', `localhost:${remoteServer.port}`] // Manually proxy upstream
                    ] as any
                }).end();

                const response = await new Promise<http.IncomingMessage>((resolve) =>
                    request.on('response', resolve)
                );

                expect(response.statusCode).to.equal(200); // Callback expectations should run OK
            });

            it("should be able to pass through request trailers", async () => {
                await remoteServer.forAnyRequest().thenCallback(async (req) => {
                    const trailers = req.rawTrailers;
                    expect(trailers).to.deep.equal([
                        ['trailer-NAME', 'trailer-value']
                    ]);

                    return {
                        statusCode: 200,
                        body: 'Found expected trailers'
                    };
                });

                await server.forAnyRequest().thenPassThrough();

                const request = http.request({
                    method: 'POST',
                    hostname: 'localhost',
                    port: server.port,
                    headers: {
                        'Trailer': 'trailer-name',
                        'Host': `localhost:${remoteServer.port}` // Manually proxy upstream
                    }
                });

                request.addTrailers({ 'trailer-NAME': 'trailer-value' });
                request.end();

                const response = await new Promise<http.IncomingMessage>((resolve) =>
                    request.on('response', resolve)
                );

                expect(response.statusCode).to.equal(200);
                expect((await streamToBuffer(response)).toString('utf8'))
                    .to.equal('Found expected trailers');
            });

            it("should be able to pass back response headers", async () => {
                await remoteServer.forAnyRequest().thenCallback(async (req) => ({
                    statusCode: 200,
                    body: await req.body.getText(),
                    headers: {
                        "first": "hi",
                        "second": "bye",
                        "my-UPPERCASE-header": "123"
                    }
                }));

                await server.forGet(remoteServer.url).thenPassThrough();

                let response = await request.get({
                    url: remoteServer.url,
                    resolveWithFullResponse: true
                });

                expect(response.headers['date']).to.equal(undefined); // No default headers added!
                expect(response.headers['my-uppercase-header']).to.equal('123');

                expect(response.rawHeaders).to.deep.equal([ // Preserves raw header details:
                    'first', 'hi',
                    'second', 'bye', // Preserves order!
                    'my-UPPERCASE-header', '123' // Preserves case!
                ]);
            });

            it("should be able to pass back response trailers", async () => {
                await remoteServer.forAnyRequest().thenCallback(async (req) => ({
                    statusCode: 200,
                    body: await req.body.getText(),
                    headers: {
                        'Trailer': 'trailer-name',
                        'Transfer-Encoding': 'chunked'
                    },
                    trailers: {
                        'Trailer-Name': 'trailer-value' // N.b thenCallback is not case sensitive (yet?)
                    }
                }));

                await server.forAnyRequest().thenPassThrough();

                const request = http.request({
                    method: 'GET',
                    hostname: 'localhost',
                    port: server.port,
                    headers: {
                        'Host': `localhost:${remoteServer.port}` // Manually proxy upstream
                    }
                }).end();

                const response = await new Promise<http.IncomingMessage>((resolve) =>
                    request.on('response', resolve)
                );

                await streamToBuffer(response); // Wait for response to complete
                expect(response.rawTrailers).to.deep.equal([
                    'Trailer-Name', 'trailer-value'
                ]);
            });

            it("should be able to pass through requests with a body", async () => {
                await remoteServer.forAnyRequest().thenCallback(async (req) => ({
                    statusCode: 200,
                    body: await req.body.getText()
                }));
                await server.forPost(remoteServer.url).thenPassThrough();

                let response = await request.post({
                    url: remoteServer.url,
                    json: { "test": true }
                });

                expect(response).to.deep.equal({ "test":true });
            });

            it("should be able to pass through requests with a body buffer", async () => {
                await remoteServer.forAnyRequest().thenCallback((req) => ({
                    statusCode: 200,
                    body: req.body.buffer
                }));
                await server.forPost(remoteServer.url).thenPassThrough();

                let response = await request.post({
                    url: remoteServer.url,
                    json: { "test": true }
                });

                expect(response).to.deep.equal({ "test": true });
            });

            it("should be able to pass through requests with parameters", async () => {
                await remoteServer.forAnyRequest().thenCallback((req) => ({
                    statusCode: 200,
                    body: req.url
                }));
                await server.forGet(remoteServer.urlFor('/get')).thenPassThrough();

                let response = await request.get(remoteServer.urlFor('/get?a=b'));

                expect(response).to.equal(remoteServer.urlFor('/get?a=b'));
            });

            it("should be able to verify requests passed through with a body", async () => {
                await remoteServer.forPost('/post').thenReply(200);
                const endpointMock = await server.forPost(remoteServer.urlFor('/post')).thenPassThrough();

                await request.post({
                    url: remoteServer.urlFor('/post'),
                    json: { "test": true }
                });

                const seenRequests = await endpointMock.getSeenRequests();
                expect(seenRequests.length).to.equal(1);
                expect(await seenRequests[0].body.getText()).to.equal('{"test":true}');
            });

            it("should successfully pass through non-proxy requests with a host header", async () => {
                await remoteServer.forGet('/').thenReply(200, 'remote server');
                server.forGet(remoteServer.url).thenPassThrough();
                process.env = INITIAL_ENV;

                let response = await request.get(server.urlFor("/"), {
                    headers: { host: `localhost:${remoteServer.port}`  }
                });

                expect(response).to.equal('remote server');
            });

            it("should be able to run a callback that checks the request's data", async () => {
                await remoteServer.forGet('/').thenReply(200, 'GET');

                await server.forGet(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: (req) => {
                        expect(req.method).to.equal('GET');
                    }
                });

                let response = await request.get(remoteServer.urlFor("/"));
                expect(response).to.equal("GET");
            });

            it("should be able to rewrite a request's method", async () => {
                await remoteServer.forGet('/').thenReply(200, 'GET');
                await remoteServer.forPost('/').thenReply(200, 'POST');

                await server.forGet(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: (req) => {
                        expect(req.method).to.equal('GET');
                        return { method: 'POST' };
                    }
                });

                let response = await request.get(remoteServer.urlFor("/"));
                expect(response).to.equal("POST");
            });

            it("should be able to rewrite a request's URL", async () => {
                await remoteServer.forGet('/').thenReply(200, 'Root');
                await remoteServer.forGet('/endpoint').thenReply(200, '/endpoint');

                await server.forGet(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: (req) => {
                        expect(req.url).to.equal(remoteServer.urlFor("/"));
                        return { url: req.url.replace(/\/$/, '/endpoint') };
                    }
                });

                let response = await request.get(remoteServer.urlFor("/"));
                expect(response).to.equal("/endpoint");
            });

            it("should clearly fail when rewriting a request's URL to a relative path", async () => {
                await remoteServer.forGet('/').thenReply(200, 'Root');
                await remoteServer.forGet('/endpoint').thenReply(200, '/endpoint');

                await server.forGet(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: (req) => {
                        return { url: '/endpoint' };
                    }
                });

                await expect(
                    request.get(remoteServer.urlFor("/"))
                ).to.be.rejectedWith("Error: Overridden request URLs must be absolute");
            });

            it("should be able to rewrite a request's URL to a different host", async () => {
                const remoteEndpoint = await remoteServer.forGet('/').thenReply(200, 'my remote');

                await server.forGet('http://example.com').thenPassThrough({
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
                    'connection': defaultNodeConnectionHeader
                });
            });

            it("should be able to examine a request's raw headers in beforeRequest", async () => {
                await remoteServer.forGet('/rewrite').thenCallback((req) => ({
                    statusCode: 200,
                    json: req.headers
                }));

                await server.forGet(remoteServer.urlFor("/rewrite")).thenPassThrough({
                    beforeRequest: (req) => {
                        expect(req.headers).to.deep.equal({
                            'host': `localhost:${remoteServer.port}`,
                            'connection': defaultNodeConnectionHeader,
                            'uppercase-header': 'UPPERCASE-VALUE',
                            'multival': ['value 1', 'value 2']
                        });

                        expect(req.rawHeaders).to.deep.equal([
                            ['UPPERCASE-HEADER', 'UPPERCASE-VALUE'],
                            ['multival', 'value 1'],
                            ['multival', 'value 2'],
                            ['host', `localhost:${remoteServer.port}`],
                            ['Connection', defaultNodeConnectionHeader]
                        ]);

                        return {
                            headers: Object.assign({}, req.headers, { 'x-test-header': 'test' })
                        };
                    }
                });

                let response = await request.get(remoteServer.urlFor("/rewrite"), {
                    headers: {
                        'UPPERCASE-HEADER': 'UPPERCASE-VALUE',
                        'multival': ['value 1', 'value 2']
                    }
                });
                expect(JSON.parse(response)['x-test-header']).to.equal("test");
            });

            it("should be able to rewrite a request's headers", async () => {
                await remoteServer.forGet('/rewrite').thenCallback((req) => ({
                    statusCode: 200,
                    json: req.headers
                }));

                await server.forGet(remoteServer.urlFor("/rewrite")).thenPassThrough({
                    beforeRequest: (req) => {
                        expect(req.headers).to.deep.equal({
                            'host': `localhost:${remoteServer.port}`,
                            'connection': defaultNodeConnectionHeader
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
                await remoteServer.forGet('/rewrite').thenCallback((req) => ({
                    statusCode: 200,
                    json: req.headers
                }));

                await server.forGet(remoteServer.urlFor("/rewrite")).thenPassThrough({
                    beforeRequest: (req) => {
                        expect(req.headers).to.deep.equal({
                            'host': `localhost:${remoteServer.port}`,
                            'connection': defaultNodeConnectionHeader
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
                await remoteServer.forPost('/').thenCallback(async (req) => ({
                    statusCode: 200,
                    body: await req.body.getText()
                }));

                await server.forPost(remoteServer.urlFor("/")).thenPassThrough({
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
                await remoteServer.forPost('/').thenCallback(async (req) => ({
                    statusCode: 200,
                    body: await req.body.getText()
                }));
                await server.forPost(remoteServer.urlFor("/")).thenPassThrough({
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

            it("should be able to rewrite a request's body as JSON", async () => {
                await remoteServer.forPost('/').thenCallback(async (req) => ({
                    statusCode: 200,
                    json: await req.body.getJson()
                }));

                await server.forPost(remoteServer.urlFor("/")).thenPassThrough({
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

            it("should be able to rewrite a request's body as JSON and encode it automatically", async () => {
                await remoteServer.forAnyRequest().thenCallback(async (req) => ({
                    status: 200,
                    json: { // Echo back the request data
                        url: req.url,
                        method: req.method,
                        headers: req.headers,
                        rawBody: req.body.buffer.toString(),
                        decodedBody: await req.body.getText(), // Echo's the DECODED content
                    }
                }));

                await server.forPost(remoteServer.urlFor("/abc")).thenPassThrough({
                    beforeRequest: async (req) => {
                        expect(await req.body.getJson()).to.deep.equal({ // Decoded automatically
                            a: 1,
                            b: 2
                        });

                        return {
                            // Return a body, which should be encoded automatically (due to the existing
                            // gzip header) before its sent upstream.
                            body: JSON.stringify({ hello: "world" })
                        };
                    }
                });

                const rawResponse = await request.post(remoteServer.urlFor("/abc"), {
                    headers: {
                        'content-encoding': 'gzip',
                        'custom-header': 'a-value'
                    },
                    body: zlib.gzipSync(
                        JSON.stringify({ a: 1, b: 2 })
                    )
                });

                // Use the echoed response to see what the remote server received:
                const response = JSON.parse(rawResponse);
                expect(response).to.deep.equal({
                    url: remoteServer.urlFor("/abc"),
                    method: 'POST',
                    headers: {
                        'host': `localhost:${remoteServer.port}`,
                        'connection': defaultNodeConnectionHeader,
                        'content-encoding': 'gzip',
                        'content-length': '37',
                        'custom-header': 'a-value'
                    },
                    rawBody: zlib.gzipSync(JSON.stringify({ hello: 'world' }), { level: 1 }).toString(),
                    decodedBody: JSON.stringify({ hello: "world" })
                });
            });

            it("should be able to rewrite a request's body with already encoded raw data", async () => {
                await remoteServer.forAnyRequest().thenCallback(async (req) => ({
                    status: 200,
                    json: { // Echo back the request data
                        url: req.url,
                        method: req.method,
                        headers: req.headers,
                        rawBody: req.body.buffer.toString('base64') // Encoded data as base64
                    }
                }));

                await server.forPost(remoteServer.urlFor("/abc")).thenPassThrough({
                    beforeRequest: async () => ({
                        headers: { 'content-encoding': 'gibberish' }, // Would fail to encode if not raw
                        rawBody: zlib.gzipSync('Raw manually encoded data')
                    })
                });

                const rawResponse = await request.post(remoteServer.urlFor("/abc"), {
                    headers: {
                        'content-encoding': 'gzip',
                        'custom-header': 'a-value'
                    },
                    body: zlib.gzipSync(
                        JSON.stringify({ a: 1, b: 2 })
                    )
                });

                // Use the echoed response to see what the remote server received:
                const response = JSON.parse(rawResponse);
                const decodedRequestBody = zlib.gunzipSync(Buffer.from(response.rawBody, 'base64'));
                expect(decodedRequestBody.toString()).to.equal("Raw manually encoded data");
            });

            it("should be able to rewrite a request's body and fix the content-length automatically", async () => {
                await remoteServer.forPost('/').thenCallback(async (req) => ({
                    statusCode: 200,
                    json: { // Echo request back as JSON in response
                        headers: req.headers,
                        body: await req.body.getText()
                    }
                }));

                await server.forPost(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: async (req) => {
                        expect(await req.body.getText()).to.equal('initial body');

                        const body = Buffer.from(await req.body.getText() + ' extended');

                        return {
                            body,
                            headers: {
                                'content-length': '0' // Wrong!
                            }
                        };
                    }
                });

                let response = await request.post(remoteServer.urlFor("/"), {
                    body: "initial body"
                });
                const requestData = JSON.parse(response);
                expect(requestData.headers['content-length']).to.equal('21'); // Fixed
                expect(requestData.body).to.equal("initial body extended");
            });

            it("should be able to rewrite a request's body and add the missing content-length automatically", async () => {
                await remoteServer.forPost('/').thenCallback(async (req) => ({
                    statusCode: 200,
                    json: { // Echo request back as JSON in response
                        headers: req.headers,
                        body: await req.body.getText()
                    }
                }));

                await server.forPost(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: async (req) => {
                        expect(await req.body.getText()).to.equal('initial body');

                        const body = Buffer.from(await req.body.getText() + ' extended');

                        const headers = { ...req.headers };
                        delete headers['content-length']; // Remove the existing content-length

                        return { body, headers };
                    }
                });

                let response = await request.post(remoteServer.urlFor("/"), {
                    body: "initial body"
                });
                const requestData = JSON.parse(response);
                expect(requestData.headers['content-length']).to.equal('21'); // Fixed
                expect(requestData.body).to.equal("initial body extended");
            });

            it("should be able to rewrite a request's body without a content-length given transfer-encoding", async () => {
                await remoteServer.forPost('/').thenCallback(async (req) => ({
                    statusCode: 200,
                    json: { // Echo request back as JSON in response
                        headers: req.headers,
                        body: await req.body.getText()
                    }
                }));

                await server.forPost(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: async (req) => {
                        expect(await req.body.getText()).to.equal('initial body');

                        const body = Buffer.from(await req.body.getText() + ' extended');

                        return {
                            body,
                            headers: { 'transfer-encoding': 'chunked' }
                        };
                    }
                });

                let response = await request.post(remoteServer.urlFor("/"), {
                    body: "initial body"
                });
                const requestData = JSON.parse(response);
                expect(requestData.headers['content-length']).to.equal(undefined);
                expect(requestData.headers['transfer-encoding']).to.equal('chunked');
                expect(requestData.body).to.equal("initial body extended");
            });

            it("should be able to edit a request to inject a response directly", async () => {
                const remoteEndpoint = await remoteServer.forPost('/').thenReply(200);

                await server.forPost(remoteServer.urlFor("/")).thenPassThrough({
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

            it("should be able to edit a request to inject a response with automatic encoding", async () => {
                const remoteEndpoint = await remoteServer.forPost('/').thenReply(200);

                await server.forPost(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: () => ({
                        response: {
                            statusCode: 200,
                            headers: { 'content-encoding': 'gzip' },
                            body: 'A mock body'
                        }
                    })
                });

                let response = await request.post(remoteServer.urlFor("/"), {
                    resolveWithFullResponse: true,
                    encoding: null,
                    simple: false
                });

                const seenRequests = await remoteEndpoint.getSeenRequests();
                expect(seenRequests.length).to.equal(0);

                expect(response.statusCode).to.equal(200);

                const decodedBody = zlib.gunzipSync(response.body).toString();
                expect(decodedBody).to.equal('A mock body');
            });

            it("should be able to edit a request to inject a raw encoded response", async () => {
                const remoteEndpoint = await remoteServer.forPost('/').thenReply(200);

                await server.forPost(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: () => ({
                        response: {
                            statusCode: 200,
                            headers: { 'content-encoding': 'gzip' },
                            rawBody: zlib.gzipSync('An already encoded body')
                        }
                    })
                });

                let response = await request.post(remoteServer.urlFor("/"), {
                    resolveWithFullResponse: true,
                    encoding: null,
                    simple: false
                });

                const seenRequests = await remoteEndpoint.getSeenRequests();
                expect(seenRequests.length).to.equal(0);

                expect(response.statusCode).to.equal(200);

                const decodedBody = zlib.gunzipSync(response.body).toString();
                expect(decodedBody).to.equal('An already encoded body');
            });

            it("should be able to edit a request to close the connection directly", async () => {
                const remoteEndpoint = await remoteServer.forGet('/').thenReply(200);

                await server.forGet(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: () => ({
                        response: 'close'
                    })
                });

                let response: Response | Error = await request.get(remoteServer.url, {
                    simple: false
                }).catch((e) => e);

                expect(response).to.be.instanceOf(Error);
                expect((response as Error & {
                    cause: { code: string }
                }).cause.code).to.equal('ECONNRESET');

                const seenRequests = await remoteEndpoint.getSeenRequests();
                expect(seenRequests.length).to.equal(0);
            });

            it("should be able to run a callback that checks the response's data", async () => {
                await remoteServer.forGet('/').thenReply(200);

                await server.forGet(remoteServer.urlFor("/")).thenPassThrough({
                    beforeResponse: (res) => {
                        expect(res.statusCode).to.equal(200);
                    }
                });

                let response = await request.get(remoteServer.urlFor("/"), {
                    resolveWithFullResponse: true,
                    simple: false
                });
                expect(response.statusCode).to.equal(200);
            });

            it("should be able to examine a response's raw headers in beforeResponse", async () => {
                await remoteServer.forGet('/').thenCallback(() => ({
                    status: 500,
                    headers: {
                        'UPPERCASE-HEADER': 'VALUE'
                    }
                }));

                await server.forGet(remoteServer.urlFor("/")).thenPassThrough({
                    beforeResponse: (res) => {
                        expect(res.headers).to.deep.equal({
                            'uppercase-header': 'VALUE'
                        });

                        expect(res.rawHeaders).to.deep.equal([
                            ['UPPERCASE-HEADER', 'VALUE']
                        ]);

                        return { status: 200, body: 'all good' };
                    }
                });

                let response = await request.get(remoteServer.urlFor("/"));
                expect(response).to.equal('all good');
            });

            it("should be able to examine the request in beforeResponse", async () => {
                await remoteServer.forGet('/').thenCallback(() => ({
                    status: 500,
                    headers: {
                        'UPPERCASE-HEADER': 'VALUE'
                    }
                }));

                await server.forGet(remoteServer.urlFor("/")).thenPassThrough({
                    beforeResponse: (_res, req) => {
                        expect(req.url).to.equal(remoteServer.urlFor('/'));
                        return { status: 200, body: 'got correct req url' };
                    }
                });

                let response = await request.get(remoteServer.urlFor("/"));
                expect(response).to.equal('got correct req url');
            });

            it("should be able to rewrite a response's status", async () => {
                await remoteServer.forGet('/').thenReply(404);
                await server.forGet(remoteServer.urlFor("/")).thenPassThrough({
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
                await remoteServer.forGet('/').thenReply(200, '', {
                    'x-header': 'original'
                });

                await server.forGet(remoteServer.urlFor("/")).thenPassThrough({
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
                await remoteServer.forGet('/').thenReply(200, 'original text', {
                    "content-length": "13"
                });

                await server.forGet(remoteServer.urlFor("/")).thenPassThrough({
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
                await remoteServer.forGet('/').thenReply(200, 'text');

                await server.forGet(remoteServer.urlFor("/")).thenPassThrough({
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

            it("should be able to rewrite a response's body with automatic encoding", async () => {
                await remoteServer.forGet('/').thenReply(200, 'text');

                await server.forGet(remoteServer.urlFor("/")).thenPassThrough({
                    beforeResponse: async () => {
                        return {
                            headers: { 'content-encoding': 'gzip' },
                            body: 'decoded data'
                        };
                    }
                });

                let response = await request.get(remoteServer.urlFor("/"), {
                    json: true,
                    encoding: null
                });
                const decodedResponse = zlib.gunzipSync(response).toString(); // Data was auto-gzipped
                expect(decodedResponse).to.deep.equal('decoded data');
            });

            it("should be able to rewrite a response's body with raw data ignoring encoding", async () => {
                await remoteServer.forGet('/').thenReply(200, 'text');

                await server.forGet(remoteServer.urlFor("/")).thenPassThrough({
                    beforeResponse: async () => {
                        return {
                            headers: { 'content-encoding': 'gibberish' }, // Would fail to encode if not raw
                            rawBody: zlib.gzipSync('decoded data')
                        };
                    }
                });

                let response = await request.get(remoteServer.urlFor("/"), {
                    json: true,
                    encoding: null
                });
                const decodedResponse = zlib.gunzipSync(response).toString();
                expect(decodedResponse).to.deep.equal('decoded data');
            });

            it("should use the original body if not overwritten in beforeResponse", async () => {
                await remoteServer.forGet('/').thenReply(200, 'real body');
                await server.forGet(remoteServer.urlFor("/")).thenPassThrough({
                    beforeResponse: () => ({ })
                });

                let response = await request.get(remoteServer.urlFor("/"));
                expect(response).to.equal('real body');
            });

            it("should be able to close the response connection from beforeResponse", async () => {
                const remoteEndpoint = await remoteServer.forGet('/').thenReply(200);
                await server.forAnyRequest().thenPassThrough({
                    ignoreHostHttpsErrors: ['localhost'],
                    beforeResponse: () => 'close'
                });

                let response: Response | Error = await request.get(remoteServer.url, {
                    simple: false
                }).catch((e) => e);

                expect(response).to.be.instanceOf(Error);
                expect((response as Error & {
                    cause: { code: string }
                }).cause.code).to.equal('ECONNRESET');

                const seenRequests = await remoteEndpoint.getSeenRequests();
                expect(seenRequests.length).to.equal(1); // Request is really sent first though
            });

            it("should return a 500 if the request rewriting fails", async () => {
                await remoteServer.forGet('/').thenReply(200, 'text');

                await server.forGet(remoteServer.urlFor("/")).thenPassThrough({
                    beforeRequest: () => { throw new Error('Oops') }
                });

                let response = await request.get(remoteServer.urlFor("/"), {
                    resolveWithFullResponse: true,
                    simple: false
                });
                expect(response.statusCode).to.equal(500);
            });

            it("should return a 500 if the response rewriting fails", async () => {
                await remoteServer.forGet('/').thenReply(200, 'text');

                await server.forGet(remoteServer.urlFor("/")).thenPassThrough({
                    beforeResponse: () => { throw new Error('Oops') }
                });

                let response = await request.get(remoteServer.urlFor("/"), {
                    resolveWithFullResponse: true,
                    simple: false
                });
                expect(response.statusCode).to.equal(500);
            });

            it("should return a 502 if proxying fails", async () => {
                await server.forGet().thenPassThrough();

                let response = await request.get(`http://invalid.example`, {
                    resolveWithFullResponse: true,
                    simple: false
                });

                expect(response.statusCode).to.equal(502);
            });

            it("should kill the connection if proxying fails with error simulation", async () => {
                await server.forGet().thenPassThrough({
                    simulateConnectionErrors: true
                });

                let result = await request.get(`http://invalid.example`, {
                    resolveWithFullResponse: true,
                    simple: false
                }).catch(e => e);

                expect(result).to.be.instanceOf(Error);
                expect(result.message).to.be.oneOf([
                    'Error: socket hang up',
                    'Error: read ECONNRESET'
                ]);
            });

            it('should abort upstream requests if downstream is aborted', async () => {
                const seenRequestPromise = getDeferred<CompletedRequest>();
                remoteServer.on('request', (r) => seenRequestPromise.resolve(r));

                const seenAbortPromise = getDeferred<AbortedRequest>();
                remoteServer.on('abort', (r) => seenAbortPromise.resolve(r));

                await remoteServer.forPost('/mocked-endpoint').thenTimeout();
                await server.forPost('/mocked-endpoint').thenPassThrough();

                const abortableRequest = makeAbortableRequest(
                    server,
                    remoteServer.urlFor('/mocked-endpoint')
                ) as http.ClientRequest;
                abortableRequest.end();

                const seenRequest = await seenRequestPromise;
                abortableRequest.abort();

                const seenAbort = await seenAbortPromise;
                expect(seenRequest.id).to.equal(seenAbort.id);
                expect(seenAbort.error).to.equal(undefined); // Client abort, not an error
            });

            it('should gracefully handle client connection getting closed in the middle of the body', async () => {
                const seenRequestPromise = getDeferred<Request>();
                remoteServer.on('request-initiated', (r) => seenRequestPromise.resolve(r));

                const seenAbortPromise = getDeferred<AbortedRequest>();
                remoteServer.on('abort', (r) => seenAbortPromise.resolve(r));

                await remoteServer.forPost('/mocked-endpoint').thenTimeout();
                const mockEndpoint = await server.forPost('/mocked-endpoint').thenPassThrough();

                const abortableRequest = makeAbortableRequest(
                    server,
                    remoteServer.urlFor('/mocked-endpoint')
                ) as http.ClientRequest;

                abortableRequest.write('some data');

                // Wait for the request to be seen by the upstream server, before aborting the
                // client request.
                const seenRequest = await seenRequestPromise;
                abortableRequest.abort();

                const seenAbort = await seenAbortPromise;
                const [recordedRequest] = await mockEndpoint.getSeenRequests();

                expect(seenAbort.id).equal(seenRequest.id);

                expect(recordedRequest.body.buffer).to.have.length(0);
                expect(recordedRequest.timingEvents.abortedTimestamp).to.be.a('number');
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
                    server.forAnyRequest().thenPassThrough();

                    // Localhost here will be ambiguous - we're expecting Mockttp to work it out
                    let response = await request.get(`http://localhost:${ipV6Port}`);
                    await requestReceived;

                    expect(response).to.equal("OK");
                });

            });

            it("should be able to pass socket metadata by proxy-auth username + password", async () => {
                process.env.HTTP_PROXY = process.env.HTTPS_PROXY =
                    `http://metadata:{"tags":["http-proxy-tag"]}@localhost:${server.port}/`;

                const rule = await server.forAnyRequest().thenReply(200, "mocked data");

                let response = await request.get("http://example.com/endpoint");
                expect(response).to.equal("mocked data");

                const seenRequests = await rule.getSeenRequests();
                expect(seenRequests.length).to.equal(1);
                const seenRequest = seenRequests[0];
                expect(seenRequest.tags).to.deep.equal(["socket-metadata:http-proxy-tag"]);
            });

            it("should be able to pass socket metadata by proxy-auth username + base64url password", async () => {
                process.env.HTTP_PROXY = process.env.HTTPS_PROXY =
                    `http://metadata:${
                        Buffer.from(JSON.stringify({"tags":["base64-http-proxy-tag"]})).toString('base64url')
                    }@localhost:${server.port}/`;

                const rule = await server.forAnyRequest().thenReply(200, "mocked data");

                let response = await request.get("http://example.com/endpoint");
                expect(response).to.equal("mocked data");

                const seenRequests = await rule.getSeenRequests();
                expect(seenRequests.length).to.equal(1);
                const seenRequest = seenRequests[0];
                expect(seenRequest.tags).to.deep.equal(["socket-metadata:base64-http-proxy-tag"]);
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
                const remoteEndpoint = await remoteServer.forAnyRequest().thenReply(200);
                const proxyEndpoint = await server.forPost(remoteServer.url).thenPassThrough();

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

            it("should still proxy larger request bodies even if beforeRequest is used", async () => {
                const message = "A large request body";

                const remoteEndpoint = await remoteServer.forAnyRequest().thenReply(200);
                const proxyEndpoint = await server.forPost(remoteServer.url).thenPassThrough({
                    beforeRequest: async (req) => {
                        const bodyText = await req.body.getText();
                        // Body is too long, and so should be truncated when examined (as here)
                        expect(bodyText).to.equal('');
                        return {};
                    }
                });

                let response = await request.post({
                    url: remoteServer.url,
                    body: message,
                    resolveWithFullResponse: true
                });

                expect(response.statusCode).to.equal(200);

                // Even though it's truncated for buffering, the request data should still be proxied
                // through successfully to the upstream server:
                const resultingRequest = (await remoteEndpoint.getSeenRequests())[0];
                expect(await resultingRequest.body.getText()).to.equal(message);

                // But it's truncated in event data, not buffered
                const proxiedRequestData = (await proxyEndpoint.getSeenRequests())[0];
                expect(await proxiedRequestData.body.getText()).to.equal('');
            });

            it("should still proxy larger response bodies", async () => {
                await remoteServer.forAnyRequest().thenReply(200, "A large response body");
                const proxyEndpoint = await server.forGet(remoteServer.url).thenPassThrough();

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

    });
});
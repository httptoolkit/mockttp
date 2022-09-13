import _ = require("lodash");
import * as path from 'path';
import * as fs from 'fs-extra';
import * as net from 'net';
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
    OLD_TLS_SUPPORTED,
    ignoreNetworkError
} from "../test-utils";
import { CA } from "../../src/util/tls";
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

                const response = await sendRawRequest(server, 'GET http://example.com HTTP/1.1\n\n');
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

            it("should be able to pass through requests", async () => {
                await server.forGet("http://example.com/").thenPassThrough();

                let response = await request.get("http://example.com/");
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
                        connection: 'close'
                    });

                    expect(req.rawHeaders).to.deep.equal([
                        ['Dupe-Header', 'A'],
                        ['UPPERCASEHEADER', 'VALUE'],
                        ['Dupe-Header', 'B'],
                        ['Host', `localhost:${remoteServer.port}`],
                        ['Connection', 'close' ] // Added by node in initial request
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

            it("should be able to pass through upstream connection resets", async () => {
                await remoteServer.forAnyRequest().thenCloseConnection();
                await server.forGet(remoteServer.url).thenPassThrough();

                let response: Response | Error = await request.get(remoteServer.url, {
                    simple: false
                }).catch((e) => e);

                expect(response).to.be.instanceOf(Error);
                expect((response as Error & {
                    cause: { code: string }
                }).cause.code).to.equal('ECONNRESET');
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
                    'connection': 'close'
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
                            'connection': 'close',
                            'uppercase-header': 'UPPERCASE-VALUE',
                            'multival': ['value 1', 'value 2']
                        });

                        expect(req.rawHeaders).to.deep.equal([
                            ['UPPERCASE-HEADER', 'UPPERCASE-VALUE'],
                            ['multival', 'value 1'],
                            ['multival', 'value 2'],
                            ['host', `localhost:${remoteServer.port}`],
                            ['Connection', 'close']
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
                await remoteServer.forGet('/rewrite').thenCallback((req) => ({
                    statusCode: 200,
                    json: req.headers
                }));

                await server.forGet(remoteServer.urlFor("/rewrite")).thenPassThrough({
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
                        'connection': 'close',
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
                        request.get("https://ja3er.com/json", {
                            headers: {
                                // The hash will get recorded with the user agent that's used - we don't want the database
                                // to fill up with records that make it clear it's Mockttp's fingerprint!
                                'user-agent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:103.0) Gecko/20100101 Firefox/103.0'
                            }
                        }),
                        { context: this, timeout: 4000 }
                    );

                    const ja3Hash = JSON.parse(response).ja3_hash;

                    // Any hash is fine, as long as it's not a super common Node.js hash:
                    expect(ja3Hash).not.to.be.oneOf([
                        '5d1b45c217fe17488ef0a688cf2cc497', // Node 10.23
                        'c4aac137ff0b0ac82f3c138cf174b427', // Node 16.8, 14.17, 12.22
                        '4c319ebb1fb1ef7937f04ac445bbdf86' // Node 17.0
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
                    let oldServer: DestroyableServer & https.Server;

                    beforeEach(async () => {
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
                            'passthrough-tls-error:ssl-alert-70',
                            'passthrough-error:EPROTO'
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
                    let authenticatingServer: DestroyableServer & https.Server;

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

                let http2Server: DestroyableServer & http2.Http2SecureServer;
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
                        { ':method': 'POST' },
                        'initial-body'
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
                        { ':method': 'GET' } // GET isn't allowed a body
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
                        { ':method': 'POST' },
                        'initial-body'
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
                        { method: 'HEAD' } // HEAD must not have a response body
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

        describe("when configured to forward requests to a different location", () => {

            beforeEach(async () => {
                server = getLocal();
                await server.start();
                process.env = _.merge({}, process.env, server.proxyEnv);

                expect(remoteServer.port).to.not.equal(server.port);
            });

            it("forwards to the location specified", async () => {
                await remoteServer.forGet('/').thenReply(200, "forwarded response");
                await server.forAnyRequest().thenForwardTo(remoteServer.url);

                let response = await request.get(server.urlFor("/"));

                expect(response).to.equal('forwarded response');
            });

            it("forwards to the location even if the port & protocol is implicit", async () => {
                await remoteServer.forGet('/').thenReply(200, "forwarded response");
                await server.forAnyRequest().thenForwardTo('example.com');

                let response = await request.get(server.urlFor("/"));

                expect(response).to.include('Example Domain');
            });

            it("uses the path portion from the original request url", async () => {
                let remoteEndpointMock = await remoteServer.forGet('/get').thenReply(200, "mocked data");
                await server.forAnyRequest().thenForwardTo(remoteServer.url);

                await request.get(server.urlFor("/get"));

                let seenRequests = await remoteEndpointMock.getSeenRequests();
                expect(seenRequests[0].path).to.equal("/get");
            });

            it("throws an error if the forwarding URL contains a path", async () => {
                const locationWithPath = 'http://localhost:1234/pathIsNotAllowed';

                await expect(server.forAnyRequest().thenForwardTo(locationWithPath))
                .to.be.rejectedWith(/Did you mean http:\/\/localhost:1234\?$/g);
            });

            it("updates the host header by default", async () => {
                let remoteEndpointMock = await remoteServer.forGet('/get').thenReply(200, "mocked data");
                await server.forAnyRequest().thenForwardTo(remoteServer.url);

                await request.get(server.urlFor("/get"));

                let seenRequests = await remoteEndpointMock.getSeenRequests();
                expect(seenRequests[0].headers.host).to.equal(`localhost:${remoteServer.port}`);
            });

            it("can skip updating the host header if requested", async () => {
                let remoteEndpointMock = await remoteServer.forGet('/get').thenReply(200, "mocked data");
                await server.forAnyRequest().thenForwardTo(remoteServer.url, {
                    forwarding: { updateHostHeader: false }
                });

                await request.get(server.urlFor("/get"));

                let seenRequests = await remoteEndpointMock.getSeenRequests();
                expect(seenRequests[0].headers.host).to.equal(`localhost:${server.port}`);
            });

            it("can update the host header to a custom value if requested", async () => {
                let remoteEndpointMock = await remoteServer.forGet('/get').thenReply(200, "mocked data");
                await server.forAnyRequest().thenForwardTo(remoteServer.url, {
                    forwarding: { updateHostHeader: 'google.com' }
                });

                await request.get(server.urlFor("/get"));

                let seenRequests = await remoteEndpointMock.getSeenRequests();
                expect(seenRequests[0].headers.host).to.equal('google.com');
            });
        });

        describe("when configured to transform requests automatically", () => {

            beforeEach(async () => {
                server = getLocal();
                await server.start();
                process.env = _.merge({}, process.env, server.proxyEnv);

                // The remote server always echoes our requests
                expect(remoteServer.port).to.not.equal(server.port);
                await remoteServer.forAnyRequest().thenCallback(async (req) => ({
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
                await server.forAnyRequest().thenPassThrough({
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
                await server.forAnyRequest().thenPassThrough({
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
                await server.forAnyRequest().thenPassThrough({
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
                await server.forAnyRequest().thenPassThrough({
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
                await server.forAnyRequest().thenPassThrough({
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
                    url: `http://undefined/abc`, // Because we removed the host header completely
                    method: 'POST',
                    headers: {
                        // Required unavoidable headers:
                        'connection': 'close',
                        'transfer-encoding': 'chunked', // Because we removed content-length
                        // No other headers, only injected value:
                        'custom-header': 'replaced-value'

                    },
                    body: JSON.stringify({ a: 1 })
                });
            });

            it("can replace the body with a string", async () => {
                await server.forAnyRequest().thenPassThrough({
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
                await server.forAnyRequest().thenPassThrough({
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
                await server.forAnyRequest().thenPassThrough({
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
                await server.forAnyRequest().thenPassThrough({
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
                await server.forAnyRequest().thenPassThrough({
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
                await server.forAnyRequest().thenPassThrough({
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
                server = getLocal();
                await server.start();
                process.env = _.merge({}, process.env, server.proxyEnv);

                // The remote server always returns a fixed value
                expect(remoteServer.port).to.not.equal(server.port);
                await remoteServer.forAnyRequest().thenJson(200, {
                    'body-value': true,
                    'another-body-value': 'a value',
                }, {
                    'custom-response-header': 'custom-value'
                });
            });

            it("does nothing with an empty transform", async () => {
                await server.forAnyRequest().thenPassThrough({
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
                await server.forAnyRequest().thenPassThrough({
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
                await server.forAnyRequest().thenPassThrough({
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
                await server.forAnyRequest().thenPassThrough({
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
                await server.forAnyRequest().thenPassThrough({
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
                await server.forAnyRequest().thenPassThrough({
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
                await server.forAnyRequest().thenPassThrough({
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
                await server.forAnyRequest().thenPassThrough({
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
                await server.forAnyRequest().thenPassThrough({
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
                await server.forAnyRequest().thenPassThrough({
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

            it("can update a JSON body while handling encoding automatically", async () => {
                await server.forAnyRequest().thenPassThrough({
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

            const intermediateProxy = getLocal();
            let proxyEndpoint: MockedEndpoint;

            beforeEach(async () => {
                server = getLocal();
                await server.start();

                await intermediateProxy.start();
                proxyEndpoint = await intermediateProxy.forAnyRequest().thenPassThrough(); // Totally neutral proxy

                // Configure Request to use the *first* server as a proxy
                process.env = _.merge({}, process.env, server.proxyEnv);
            });

            afterEach(() => intermediateProxy.stop());

            it("should forward traffic through the remote proxy", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
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

            it("should support authenticating to the remote proxy", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url
                            .replace('://', '://username:password@')
                    }
                });

                const response = await request.get(remoteServer.urlFor("/test-url"));

                // We get a successful response
                expect(response).to.equal("Remote server says hi!");
                // And it went via the intermediate proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(1);

                // N.B: we don't actually check that the auth params are used here, only that the request with
                // them in the URL sends OK. We can't, unfortunately, since they only exist in the CONNECT
                // and that's always unwrapped and never exposed. Visible in Wireshark though.
            });

            it("should skip the proxy if the target is in the no-proxy list", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url,
                        noProxy: ['localhost']
                    }
                });

                const response = await request.get(remoteServer.urlFor("/test-url"));

                // We get a successful response
                expect(response).to.equal("Remote server says hi!");

                // And it didn't use the proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(0);
            });

            it("should skip the proxy if the target is in the no-proxy list with a matching port", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url,
                        noProxy: [`localhost:${remoteServer.port}`]
                    }
                });

                const response = await request.get(remoteServer.urlFor("/test-url"));

                // We get a successful response
                expect(response).to.equal("Remote server says hi!");

                // And it didn't use the proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(0);
            });

            it("should skip the proxy if the target's implicit port is in the no-proxy list", async () => {
                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url,
                        noProxy: ['example.com:80']
                    }
                });

                await request.get('http://example.com/').catch(() => {});

                // And it didn't use the proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(0);
            });

            it("should skip the proxy if a suffix of the target is in the no-proxy list", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url,
                        noProxy: ['localhost']
                    }
                });

                const response = await request.get(
                    `http://test-subdomain.localhost:${remoteServer.port}/test-url`
                );

                // We get a successful response
                expect(response).to.equal("Remote server says hi!");

                // And it didn't use the proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(0);
            });

            it("should not skip the proxy if an unrelated URL is in the no-proxy list", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url,
                        noProxy: ['example.com']
                    }
                });

                const response = await request.get(remoteServer.urlFor("/test-url"));

                // We get a successful response
                expect(response).to.equal("Remote server says hi!");

                // And it went via the intermediate proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(1);
            });

            it("should not skip the proxy if the target's port is not in the no-proxy list", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url,
                        noProxy: ['localhost:1234']
                    }
                });

                const response = await request.get(remoteServer.urlFor("/test-url"));

                // We get a successful response
                expect(response).to.equal("Remote server says hi!");

                // And it went via the intermediate proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(1);
            });

            it("should not skip the proxy if the target's implicit port is not in the no-proxy list", async () => {
                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url,
                        noProxy: ['example.com:443']
                    }
                });

                await request.get('http://example.com/').catch(() => {});

                // And it went via the intermediate proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(1);
            });

            it("should forward traffic through the remote proxy specified by a callback", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: ({ hostname }) => {
                        expect(hostname).to.equal('localhost');
                        return { proxyUrl: intermediateProxy.url }
                    }
                });

                const response = await request.get(remoteServer.urlFor("/test-url"));

                // We get a successful response
                expect(response).to.equal("Remote server says hi!");
                // And it went via the intermediate proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(1);
            });
        });

        describe("when configured to use an upstream HTTPS proxy", () => {

            const intermediateProxy = getLocal({
                https: {
                    keyPath: './test/fixtures/untrusted-ca.key',
                    certPath: './test/fixtures/untrusted-ca.pem'
                }
            });
            // HTTPS proxy - note that the remote server is plain HTTP.

            let proxyEndpoint: MockedEndpoint;

            beforeEach(async () => {
                server = getLocal();
                await server.start();

                await intermediateProxy.start();
                proxyEndpoint = await intermediateProxy.forAnyRequest().thenPassThrough(); // Totally neutral proxy

                // Configure Request to use the *first* server as a proxy
                process.env = _.merge({}, process.env, server.proxyEnv);
            });

            afterEach(() => intermediateProxy.stop());

            it("should not trust unknown proxy CAs by default", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url
                    }
                });

                const result = await request.get(remoteServer.urlFor("/test-url")).catch(e => e);

                expect(result).to.be.instanceOf(Error);
                expect(result.message).to.match(/self(-| )signed certificate/); // Dash varies by Node version
            });

            it("should trust the remote proxy's CA if explicitly specified", async () => {
                // Remote server sends fixed response on this one URL:
                await remoteServer.forGet('/test-url').thenReply(200, "Remote server says hi!");

                // Mockttp forwards requests via our intermediate proxy
                await server.forAnyRequest().thenPassThrough({
                    proxyConfig: {
                        proxyUrl: intermediateProxy.url,
                        trustedCAs: [
                            (await fs.readFile('./test/fixtures/untrusted-ca.pem')).toString()
                        ]
                    }
                });

                const response = await request.get(remoteServer.urlFor("/test-url"));

                // We get a successful response
                expect(response).to.equal("Remote server says hi!");
                // And it went via the intermediate proxy
                expect((await proxyEndpoint.getSeenRequests()).length).to.equal(1);
            });

        });

        describe("when configured with custom DNS options", function () {

            this.timeout(5000); // Sometimes these can take a little while, DNS failures can be slow

            beforeEach(async () => {
                server = getLocal();
                await server.start();
                process.env = _.merge({}, process.env, server.proxyEnv);

                fixedDnsResponse = undefined;
            });

            let dnsServer: (DestroyableServer & net.Server) | undefined;
            let fixedDnsResponse: string | undefined = undefined;

            before(async () => {
                dnsServer = await startDnsServer(() => fixedDnsResponse);
            });

            after(async () => {
                await dnsServer!.destroy();
            });

            it("should use default DNS settings given an empty object", async () => {
                await server.forAnyRequest().thenPassThrough({
                    lookupOptions: {}
                });

                await expect(
                    request.get("http://not-a-real-server.test:${remoteServer.port}")
                ).to.be.rejectedWith("ENOTFOUND"); // Goes nowhere
            });

            it("should use custom DNS servers when provided", async () => {
                remoteServer.forAnyRequest().thenReply(200, "remote localhost server");
                fixedDnsResponse = '127.0.0.1'; // Resolve everything to localhost

                await server.forAnyRequest().thenPassThrough({
                    lookupOptions: {
                        servers: [`127.0.0.1:${(dnsServer!.address() as any).port}`]
                    }
                });

                const response = await request.get(`http://still-not-real.test:${remoteServer.port}`);

                expect(response).to.equal("remote localhost server");
            });

            it("should fall back to default DNS servers when custom servers can't resolve", async function () {
                remoteServer.forAnyRequest().thenReply(200, "remote localhost server");
                this.timeout(10000);

                fixedDnsResponse = undefined; // Don't resolve anything

                await server.forAnyRequest().thenPassThrough({
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
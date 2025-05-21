import _ = require("lodash");
import * as path from 'path';
import * as http from 'http';
import * as zlib from 'zlib';

import request = require("request-promise-native");

import { getLocal, Mockttp } from "../../..";
import {
    expect,
    nodeOnly,
    defaultNodeConnectionHeader,
    nodeSatisfies,
    DEFAULT_REQ_HEADERS_DISABLED
} from "../../test-utils";
import { streamToBuffer } from "../../../src/util/buffer-utils";

const INITIAL_ENV = _.cloneDeep(process.env);

nodeOnly(() => {
    describe("Mockttp when used as a transforming proxy", function () {

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

        describe("that forwards requests to a different location", () => {

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
                await server.forAnyRequest().thenForwardTo('example.testserver.host');

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

            it("can update the host header when used with beforeRequest", async () => {
                let remoteEndpointMock = await remoteServer.forGet('/get').thenReply(200, "mocked data");
                await server.forAnyRequest().thenForwardTo(remoteServer.url, {
                    beforeRequest: (req) => {
                        // Forwarding modifications should be applied before beforeRequest:
                        expect(req.url).to.equal(remoteServer.urlFor('/get'));
                        expect(req.headers.host).to.equal(`localhost:${remoteServer.port}`);
                    }
                });

                await request.get(server.urlFor("/get"));

                let seenRequests = await remoteEndpointMock.getSeenRequests();
                expect(seenRequests[0].headers.host).to.equal(`localhost:${remoteServer.port}`);
            });

            it("can avoid updating the host header when used with beforeRequest", async () => {
                let remoteEndpointMock = await remoteServer.forGet('/get').thenReply(200, "mocked data");
                await server.forAnyRequest().thenForwardTo(remoteServer.url, {
                    beforeRequest: (req) => {
                        // Forwarding modifications should be applied before beforeRequest:
                        expect(req.url).to.equal(remoteServer.urlFor('/get')); // <-- New destination
                        expect(req.headers.host).to.equal(`localhost:${server.port}`); // <-- but old Host
                    },
                    forwarding: { updateHostHeader: false }
                });

                await request.get(server.urlFor("/get"));

                let seenRequests = await remoteEndpointMock.getSeenRequests();
                expect(seenRequests[0].headers.host).to.equal(`localhost:${server.port}`);
            });

            it("doesn't override the host header if beforeRequest does instead", async () => {
                await remoteServer.forGet('/get').thenReply(200, "mocked data");
                await server.forAnyRequest().thenForwardTo(remoteServer.url, {
                    beforeRequest: () => ({ url: 'http://never.test' })
                });

                const response = await request.get(server.urlFor("/get")).catch(e => e);

                expect(response).to.be.instanceOf(Error);
                expect(response.message).to.include('ENOTFOUND never.test');
            });

            it("overrides the host header correctly if not set", async () => {
                let remoteEndpointMock = await remoteServer.forGet('/get').thenReply(200, "mocked data");
                await server.forAnyRequest().thenForwardTo(remoteServer.url, {
                    beforeRequest: () => ({ headers: { 'other-header': 'injected-value' } })
                });

                await request.get(server.urlFor("/get")).catch(e => e);

                let seenRequests = await remoteEndpointMock.getSeenRequests();
                expect(seenRequests[0].headers.host).to.equal(`localhost:${remoteServer.port}`); // <-- Preserves new host
                expect(seenRequests[0].headers['other-header']).to.equal('injected-value');
            });

            it("overrides the host header correctly if not set", async () => {
                let remoteEndpointMock = await remoteServer.forGet('/get').thenReply(200, "mocked data");
                await server.forAnyRequest().thenForwardTo(remoteServer.url, {
                    beforeRequest: () => ({ headers: { 'other-header': 'injected-value' } }),
                    forwarding: { updateHostHeader: false }
                });

                await request.get(server.urlFor("/get")).catch(e => e);

                let seenRequests = await remoteEndpointMock.getSeenRequests();
                expect(seenRequests[0].headers.host).to.equal(`localhost:${server.port}`); // <-- Preserves original host
                expect(seenRequests[0].headers['other-header']).to.equal('injected-value');
            });
        });

        describe("that transforms requests automatically", () => {

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
                        rawHeaders: req.rawHeaders,
                        body: await req.body.getText(),
                    }
                }));
            });

            const baseHeaders = () => ({
                'host': `localhost:${remoteServer.port}`,
                'accept': 'application/json',
                'content-type': 'application/json',
                'connection': defaultNodeConnectionHeader
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

                expect(response.url).to.equal(remoteServer.urlFor("/abc"));
                expect(response.method).to.equal('POST');
                expect(response.headers).to.deep.equal({
                    ...baseHeaders(),
                    'custom-header': 'a-value',
                    'content-length': '7'
                });
                expect(response.body).to.equal(JSON.stringify({ a: 1 }));
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

                expect(response.url).to.equal(remoteServer.urlFor("/abc"));
                expect(response.method).to.equal('PUT');
                expect(response.headers).to.deep.equal({
                    ...baseHeaders(),
                    'content-length': '7',
                    'custom-header': 'a-value'
                });
                expect(response.body).to.equal(JSON.stringify({ a: 1 }));
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

                expect(response.url).to.equal(remoteServer.urlFor("/abc"));
                expect(response.method).to.equal('POST');
                expect(response.headers).to.deep.equal({
                    ...baseHeaders(),
                    'content-length': '7',
                    'custom-header': 'a-value',
                    'new-header': 'new-value'
                });
                expect(response.body).to.equal(JSON.stringify({ a: 1 }));
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

                expect(response.url).to.equal(remoteServer.urlFor("/abc"));
                expect(response.method).to.equal('POST');
                expect(response.headers).to.deep.equal({
                    ...baseHeaders(),
                    'content-length': '7',
                    'custom-header': 'replaced-value'
                });
                expect(response.body).to.equal(JSON.stringify({ a: 1 }));
            });

            it("can replace all headers", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformRequest: {
                        replaceHeaders: {
                            'transfer-encoding': 'chunked', // Required for body
                            'custom-header': 'replaced-value'
                        }
                    }
                });

                let response = await request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1 },
                    json: true
                });

                expect(response.url).to.equal(`http://localhost:${remoteServer.port}/abc`); // From tunnel, even without the host header
                expect(response.method).to.equal('POST');
                expect(response.headers).to.deep.equal({
                    ...(!nodeSatisfies(DEFAULT_REQ_HEADERS_DISABLED)
                        ? { 'connection': defaultNodeConnectionHeader }
                    : {}),
                    'transfer-encoding': 'chunked',
                    'custom-header': 'replaced-value'
                });
                expect(response.body).to.equal(JSON.stringify({ a: 1 }));
            });

            it("preserves raw headers where possible", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformRequest: {
                        updateHeaders: {
                            'Extra-Header': 'ABC'
                        }
                    }
                });

                const req = http.request(server.urlFor("/abc"), {
                    method: 'POST',
                    headers: [
                        'host', `localhost:${remoteServer.port}`,
                        'Custom-HEADER', 'a-value',
                        'other-header', 'other-value',
                        'custom-header', 'b-value'
                    ] as any
                }).end();

                const fullResponse = await new Promise<http.IncomingMessage>((resolve, reject) => {
                    req.on('response', resolve);
                    req.on('error', reject);
                });

                const response: any = JSON.parse(
                    (await streamToBuffer(fullResponse)).toString()
                );

                expect(response.url).to.equal(remoteServer.urlFor("/abc"));
                expect(response.method).to.equal('POST');
                expect(response.rawHeaders).to.deep.equal([
                    ['host', `localhost:${remoteServer.port}`,],
                    ['Custom-HEADER', 'a-value',],
                    ['other-header', 'other-value',],
                    ['custom-header', 'b-value'],
                    ['Connection', defaultNodeConnectionHeader], // Set by http.request above automatically
                    ['Transfer-Encoding', 'chunked'], // Set by http.request above automatically
                    ['Extra-Header', 'ABC']
                ]);
                expect(response.body).to.equal('');
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

                expect(response.url).to.equal(remoteServer.urlFor("/abc"));
                expect(response.method).to.equal('POST');
                expect(response.headers).to.deep.equal({
                    ...baseHeaders(),
                    'content-length': '16',
                    'custom-header': 'a-value'
                });
                expect(response.body).to.equal('replacement-body');
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

                expect(response.url).to.equal(remoteServer.urlFor("/abc"));
                expect(response.method).to.equal('POST');
                expect(response.headers).to.deep.equal({
                    ...baseHeaders(),
                    'content-length': '18',
                    'custom-header': 'a-value'
                });
                expect(response.body).to.equal('replacement buffer');
            });

            it("can replace the body with a file", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformRequest: {
                        updateHeaders: {
                            "content-type": 'text/plain'
                        },
                        replaceBodyFromFile:
                            path.join(__dirname, '..', '..', 'fixtures', 'response-file.txt')
                    }
                });

                let response = await request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1 },
                    json: true
                });

                expect(response.url).to.equal(remoteServer.urlFor("/abc"));
                expect(response.method).to.equal('POST');
                expect(response.headers).to.deep.equal({
                    ...baseHeaders(),
                    'content-type': 'text/plain',
                    'content-length': '23',
                    'custom-header': 'a-value'
                });
                expect(response.body).to.equal('Response from text file');
            });

            it("should show a clear error when replacing the body with a non-existent file", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformRequest: {
                        replaceBodyFromFile:
                            path.join(__dirname, 'non-existent-file.txt')
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
                        // Same update as the JSON Patch below, in simpler merge form:
                        updateJsonBody: {
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

                expect(response.url).to.equal(remoteServer.urlFor("/abc"));
                expect(response.method).to.equal('POST');
                expect(response.headers).to.deep.equal({
                    ...baseHeaders(),
                    'content-length': '15',
                    'custom-header': 'a-value'
                });
                expect(response.body).to.equal(JSON.stringify({ a: 100, c: 2 }));
            });

            it("can update a JSON body while handling encoding automatically", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformRequest: {
                        // Same update as the JSON Patch below, in simpler merge form:
                        updateJsonBody: {
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
                expect(response.url).to.equal(remoteServer.urlFor("/abc"));
                expect(response.method).to.equal('POST');
                expect(response.headers).to.deep.equal({
                    ...baseHeaders(),
                    'content-encoding': 'gzip',
                    'content-length': '35',
                    'custom-header': 'a-value'
                });
                expect(response.body).to.equal(JSON.stringify({ a: 100, c: 2 }));
            });

            it("can update a JSON body with a JSON patch", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformRequest: {
                        patchJsonBody: [
                            // Same logic as the update above, in JSON Patch form:
                            { op: 'replace', path: '/a', value: 100 },
                            { op: 'remove', path: '/b' },
                            { op: 'add', path: '/c', value: 2 }
                        ]
                    }
                });

                let response = await request.post(remoteServer.urlFor("/abc"), {
                    headers: { 'custom-header': 'a-value' },
                    body: { a: 1, b: 2 },
                    json: true
                });

                expect(response.url).to.equal(remoteServer.urlFor("/abc"));
                expect(response.method).to.equal('POST');
                expect(response.headers).to.deep.equal({
                    ...baseHeaders(),
                    'content-length': '15',
                    'custom-header': 'a-value'
                });
                expect(response.body).to.equal(JSON.stringify({ a: 100, c: 2 }));
            });
        });

        describe("that transforms responses automatically", () => {

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
                    'connection': 'keep-alive',
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
                    'connection': 'keep-alive',
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
                    'connection': 'keep-alive',
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
                    'connection': 'keep-alive',
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

            it("preserves raw headers if untouched", async () => {
                await remoteServer.forAnyRequest().asPriority(999).thenReply(200, "", {
                    'UPPERCASE-HEADER': 'TEST-VALUE'
                });

                await server.forAnyRequest().thenPassThrough({
                    transformResponse: {
                        updateHeaders: {
                            'Extra-Header': 'ABC'
                        }
                    }
                });

                const req = http.get(server.urlFor("/abc"), {
                    headers: {
                        host: `localhost:${remoteServer.port}`
                    }
                });
                const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
                    req.on('response', resolve);
                    req.on('error', reject);
                });

                expect(response.statusCode).to.equal(200);
                expect(response.rawHeaders).to.deep.equal([
                    'UPPERCASE-HEADER', 'TEST-VALUE',
                    'Extra-Header', 'ABC'
                ]);
                response.resume();
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
                    'connection': 'keep-alive',
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
                    'connection': 'keep-alive',
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
                            path.join(__dirname, '..', '..', 'fixtures', 'response-file.txt')
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
                    'connection': 'keep-alive',
                    'custom-response-header': 'custom-value'
                });
                expect(response.body).to.equal('Response from text file');
            });

            it("should show a clear error when replacing the body with a non-existent file", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformResponse: {
                        replaceBodyFromFile:
                            path.join(__dirname, 'non-existent-file.txt')
                    }
                });

                await expect(request.post(remoteServer.url, {
                    resolveWithFullResponse: true,
                })).to.be.rejectedWith('no such file or directory');
            });

            it("can update a JSON body with new fields", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformResponse: {
                        // Same update as the JSON Patch below, in simpler merge form:
                        updateJsonBody: {
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
                    'connection': 'keep-alive',
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
                        // Same update as the JSON Patch below, in simpler merge form:
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
                    'connection': 'keep-alive',
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

            it("can update a JSON body with a JSON patch", async () => {
                await server.forAnyRequest().thenPassThrough({
                    transformResponse: {
                        patchJsonBody: [
                            // Same logic as the update above, in JSON Patch form:
                            { op: 'replace', path: '/body-value', value: false },
                            { op: 'remove', path: '/another-body-value' },
                            { op: 'add', path: '/new-value', value: 123 }
                        ]
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
                    'connection': 'keep-alive',
                    'custom-response-header': 'custom-value'
                });
                expect(JSON.parse(response.body)).to.deep.equal({
                    'body-value': false,
                    'new-value': 123
                });
            });

        });
    });
});
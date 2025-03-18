import * as sourceMapSupport from 'source-map-support'
sourceMapSupport.install({ handleUncaughtExceptions: false });

import * as _ from 'lodash';
import * as net from 'net';
import * as tls from 'tls';
import * as http from 'http';
import * as https from 'https';
import * as http2 from 'http2';
import * as http2Wrapper from 'http2-wrapper';
import * as streams from 'stream';
import * as URL from 'url';
import * as CrossFetch from "cross-fetch";
import {
    FormData as FormDataPolyfill,
    File as FilePolyfill
} from "formdata-node";
import { RequestPromise } from 'request-promise-native';
import * as semver from 'semver';

import chai = require("chai");
import chaiAsPromised = require("chai-as-promised");
import chaiFetch = require("chai-fetch");

import * as dns2 from 'dns2'; // Imported here just for types

import { Mockttp } from "..";

export { getDeferred, Deferred } from '../src/util/promise';
import { makeDestroyable, DestroyableServer } from "destroyable-server";
import { isNode, isWeb, delay } from '../src/util/util';
import { getEffectivePort } from '../src/util/url';
export { isNode, isWeb, delay, makeDestroyable, DestroyableServer };

if (isNode) {
    // Run a target websocket server in the background. In browsers, this is
    // launched by from the Karma script. Eventually this should be replaced
    // by a Mockttp-spawned WS server, once we have one.
    require('./fixtures/websocket-test-server');
}

// In some cases, Mocha fails to properly surface unhandled rejections, so we do it ourselves.
// https://github.com/mochajs/mocha/issues/2640
process.on('unhandledRejection', (reason, promise) => {
    throw reason;
});

chai.use(chaiAsPromised);
chai.use(chaiFetch);

export const AssertionError = chai.AssertionError;

function getGlobalFetch() {
    return {
        fetch: globalThis.fetch.bind(globalThis),
        Headers: globalThis.Headers,
        Request: globalThis.Request,
        Response: globalThis.Response
    };
}

let fetchImplementation = isNode ? CrossFetch : getGlobalFetch();

export const fetch = fetchImplementation.fetch;

// All a bit convoluted, so we don't shadow the global vars,
// and we can still use those to define these in the browser
const headersImplementation = fetchImplementation.Headers;
const requestImplementation = fetchImplementation.Request;
const responseImplementation = fetchImplementation.Response;
export { headersImplementation as Headers };
export { requestImplementation as Request };
export { responseImplementation as Response };

export const FormData = globalThis.FormData ?? FormDataPolyfill;
export const File = globalThis.File ?? FilePolyfill;

// Quick helper to convert Fetch response headers back into an object. Very dumb,
// doesn't deal with multiple header values or anything correctly, but ok for tests.
export function headersToObject(fetchHeaders: Headers) {
    const headers: _.Dictionary<string> = {};
    fetchHeaders.forEach((value, key) => {
        headers[key] = value;
    });
    return headers;
}

export const URLSearchParams: typeof window.URLSearchParams = (isNode || !window.URLSearchParams) ?
    require('url').URLSearchParams : window.URLSearchParams;

export const expect = chai.expect;

export function browserOnly(body: Function) {
    if (!isNode) body();
}

export function nodeOnly(body: Function) {
    if (isNode) body();
}

// Wrap a test promise that might fail due to irrelevant remote network issues, and it'll skip the test
// if there's a timeout, connection error or 502 response (but still throw any other errors). This allows
// us to write tests that will fail if a remote server explicitly rejects something, but make them
// resilient to the remote server simply being entirely unavailable.
export async function ignoreNetworkError<T extends RequestPromise | Promise<Response>>(request: T, options: {
    context: Mocha.Context,
    timeout?: number
}): Promise<T> {
    const TimeoutError = new Error('timeout');

    const result = await Promise.race([
        request,
        delay(options.timeout ?? 1000).then(() => { throw TimeoutError; })
    ]).catch(error => {
        console.log(error);
        if (error === TimeoutError || error.name === 'FetchError') {
            console.warn(`Skipping test due to network error: ${error.message || error}`);
            if ('abort' in request) request.abort();
            throw options.context.skip();
        } else {
            throw error;
        }
    });

    if ((result as any).status === 502) {
        console.warn('Skipping test due to remote 502 response');
        throw options.context.skip();
    }

    return result;
}

const TOO_LONG_HEADER_SIZE = 1024 * (isNode ? 16 : 160) + 1;
export const TOO_LONG_HEADER_VALUE = _.range(TOO_LONG_HEADER_SIZE).map(() => "X").join("");

export async function openRawSocket(server: Mockttp) {
    const socket = new net.Socket();
    return new Promise<net.Socket>((resolve, reject) => {
        socket.connect({
            port: server.port,
            host: '127.0.0.1'
        });
        socket.on('connect', () => resolve(socket));
        socket.on('error', reject);
    });
}

export async function sendRawRequest(server: Mockttp, requestContent: string): Promise<string> {
    const client = new net.Socket();
    await new Promise<void>((resolve) => client.connect(server.port, '127.0.0.1', resolve));

    const dataPromise = new Promise<string>((resolve) => {
        client.on('data', function(data) {
            resolve(data.toString());
            client.destroy();
        });
    });

    client.write(requestContent);
    client.end();
    return dataPromise;
}

export async function openRawTlsSocket(
    target: Mockttp | net.Socket,
    options: tls.ConnectionOptions = {}
): Promise<tls.TLSSocket> {
    return await new Promise<tls.TLSSocket>((resolve, reject) => {
        const socket: tls.TLSSocket = tls.connect({
            host: 'localhost',
            ...(target instanceof net.Socket
                ? { socket: target }
                : { port: target.port }
            ),
            ...options
        });
        socket.once('secureConnect', () => resolve(socket));
        socket.once('error', reject);
    });
}

// Write a message to a socket that will trigger a respnse, but kill the socket
// before the response is received, so a real response triggers a reset.
export async function writeAndReset(socket: net.Socket, content: string) {
    socket.write(content);
    setTimeout(() => socket.destroy(), 0);
}

export function makeAbortableRequest(server: Mockttp, path: string) {
    if (isNode) {
        let req = http.request({
            method: 'POST',
            hostname: 'localhost',
            port: server.port,
            path
        });
        req.on('error', () => {});
        return req;
    } else {
        let abortController = new AbortController();
        fetch(server.urlFor(path), {
            method: 'POST',
            signal: abortController.signal as AbortSignal
        }).catch(() => {});
        return abortController;
    }
}

export function watchForEvent(event: string, ...servers: Mockttp[]) {
    let eventResult: any;

    beforeEach(async () => {
        eventResult = undefined;
        await Promise.all(servers.map((server) =>
            server.on(event as any, (result: any) => {
                eventResult = result || true;
            })
        ));
    });

    return async () => {
        await delay(100);
        expect(eventResult).to.equal(undefined, `Unexpected ${event} event`);
    }
}

// An extremely simple & dumb DNS server for quick testing:
export async function startDnsServer(callback: (question: dns2.DnsQuestion) => string | undefined) {
    // We import the implementation async, because it fails in the browser
    const dns2 = await import('dns2');

    const server = makeDestroyable(dns2.createServer(async (request, sendResponse) => {
        const response = dns2.Packet.createResponseFromRequest(request);

        // Multiple questions are allowed in theory, but apparently nobody
        // supports it, so we don't either.
        const [question] = request.questions;

        const answer = callback(question);

        if (answer) response.answers.push({
            name: question.name,
            type: dns2.Packet.TYPE.A,
            class: dns2.Packet.CLASS.IN,
            ttl: 0,
            address: answer
        });
        sendResponse(response);
    }));

    return new Promise<DestroyableServer<net.Server>>((resolve, reject) => {
        server.listen(5333, '127.0.0.1');
        server.on('listening', () => resolve(server));
        server.on('error', reject);
    });
}

export const H2_TLS_ON_TLS_SUPPORTED = ">=12.17";
export const HTTP_ABORTSIGNAL_SUPPORTED = ">=14.17";
export const DETAILED_TLS_ERROR_CODES = ">=18";
export const NATIVE_FETCH_SUPPORTED = ">=18";
export const SOCKET_RESET_SUPPORTED = "^16.17 || >=18.3";
export const BROKEN_H1_OVER_H2_TUNNELLING = "^18.8";
export const DEFAULT_KEEP_ALIVE = ">=19";
export const FIXED_KEEP_ALIVE_BEHAVIOUR = ">=20";
export const CHUNKED_ENCODING_BUG = "<16";
export const BROKEN_H2_OVER_H2_TUNNELLING = "~20.12"; // https://github.com/nodejs/node/issues/52344
export const BROKEN_WASM_BUFFER_ISSUE = "~22.2"; // https://github.com/nodejs/node/issues/53075

export const defaultNodeConnectionHeader = () =>
    semver.satisfies(process.version, DEFAULT_KEEP_ALIVE)
    ? 'keep-alive'
    : 'close';

type Http2ResponseHeaders = http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader;

type Http2TestRequestResult = {
    alpnProtocol: string | undefined,
    headers: http2.IncomingHttpHeaders,
    body: Buffer,
    trailers: http2.IncomingHttpHeaders
};

export function getHttp2Response(req: http2.ClientHttp2Stream) {
    return new Promise<Http2ResponseHeaders>((resolve, reject) => {
        req.on('response', resolve);
        req.on('error', reject);
    });
}

export function getHttp2Body(req: http2.ClientHttp2Stream) {
    return new Promise<Buffer>((resolve, reject) => {
        if (req.closed) {
            resolve(Buffer.from([]));
            return;
        }

        const body: Buffer[] = [];
        req.on('data', (d: Buffer | string) => {
            body.push(Buffer.from(d as Buffer));
        });
        req.on('end', () => req.close());
        req.on('close', () => resolve(Buffer.concat(body)));
        req.on('error', reject);
    });
}

export function getHttp2ResponseTrailers(req: http2.ClientHttp2Stream) {
    return new Promise<Http2ResponseHeaders>((resolve, reject) => {
        req.on('trailers', resolve);
        req.on('end', () => resolve({}));
        req.on('error', reject);
    });
}

export async function http2Request(
    url: string,
    headers: {},
    requestBody = '',
    createConnection?: (() => streams.Duplex) | undefined
) {
    const client = http2.connect(url, { createConnection });
    return new Promise<Http2TestRequestResult>(async (resolve, reject) => {
        try {
            const req = client.request(headers, {
                endStream: !requestBody
            });
            req.on('error', reject);

            if (requestBody) req.end(requestBody);

            const [
                responseHeaders,
                responseBody,
                responseTrailers
            ] = await Promise.all([
                getHttp2Response(req),
                getHttp2Body(req),
                getHttp2ResponseTrailers(req)
            ]);

            const alpnProtocol = client.alpnProtocol;

            resolve({
                alpnProtocol,
                headers: responseHeaders,
                body: responseBody,
                trailers: responseTrailers
            });
        } catch (e) {
            reject(e);
        }
    }).finally(() => cleanup(client));
}

export function http2DirectRequest(
    server: Mockttp,
    path: string,
    headers: {} = {}
) {
    return http2Request(server.url, {
        ':path': path,
        ...headers
    });
}

export async function http2ProxyRequest(
    proxyServer: Mockttp,
    url: string,
    options: {
        headers?: {},
        requestBody?: string,
        http1Within?: boolean
    } = {}
) {
    const { headers, requestBody, http1Within } = options;

    const parsedUrl = URL.parse(url);
    const isTLS = parsedUrl.protocol === 'https:';

    const targetHost = parsedUrl.hostname!;
    const targetPort = getEffectivePort(parsedUrl);

    const proxyClient = http2.connect(proxyServer.url);
    return await new Promise<Http2TestRequestResult>(async (resolve, reject) => {
        try {
            const proxyReq = proxyClient.request({
                ':method': 'CONNECT',
                ':authority': `${targetHost}:${targetPort}`
            });
            proxyReq.on('error', reject);

            const proxyResponse = await getHttp2Response(proxyReq);
            expect(proxyResponse[':status']).to.equal(200);

            const createConnection = () => isTLS
                ? tls.connect({
                    host: targetHost,
                    servername: targetHost,
                    socket: proxyReq as any,
                    ALPNProtocols: http1Within ? ['http/1.1'] : ['h2']
                })
                : proxyReq as unknown as net.Socket

            if (!http1Within) {
                resolve(http2Request(
                    url,
                    {
                        ':path': parsedUrl.path,
                        ...headers
                    },
                    requestBody,
                    createConnection
                ));
            } else {
                const req = (isTLS ? https : http).request(url, {
                    headers: { host: `${targetHost}:${targetPort}` },
                    createConnection
                });
                req.end(requestBody);

                req.on('response', resolve);
                req.on('error', reject);
            }
        } catch (e) {
            reject(e);
        }
    }).finally(() => cleanup(proxyClient));
}

export async function cleanup(
    ...streams: (streams.Duplex | http2.Http2Session | http2.Http2Stream)[]
) {
    return new Promise<void>((resolve, reject) => {
        if (streams.length === 0) resolve();
        else {
            const nextStream = streams[0];

            nextStream.on('error', reject);
            if ('resume' in nextStream) {
                // Drain the stream, to ensure it closes OK
                nextStream.resume();
            }

            if ('close' in nextStream) {
                nextStream.close();
                nextStream.on('close', () => {
                    cleanup(...streams.slice(1))
                        .then(resolve).catch(reject);
                });
            } else {
                nextStream.destroy();
                cleanup(...streams.slice(1))
                    .then(resolve).catch(reject);
            }
        }
    });
}

beforeEach(() => {
    if (isNode) {
        // Http2-wrapper has a hostname -> H1/H2 cache, which can cause problems
        // when our tests reuse ports with servers of different protocols.
        (http2Wrapper.auto as any).protocolCache.clear();
    }
});
import * as sourceMapSupport from 'source-map-support'
sourceMapSupport.install({ handleUncaughtExceptions: false });

import * as _ from 'lodash';
import * as net from 'net';
import * as tls from 'tls';
import * as http2 from 'http2';
import * as http2Wrapper from 'http2-wrapper';
import * as streams from 'stream';
import * as URL from 'url';
import getFetchPonyfill = require("fetch-ponyfill");

import chai = require("chai");
import chaiAsPromised = require("chai-as-promised");
import chaiFetch = require("chai-fetch");

import * as dns2 from 'dns2'; // Imported here just for types

import { Mockttp } from "..";
import { destroyable, DestroyableServer } from "../src/util/destroyable-server";
import { isNode, isWeb, delay } from '../src/util/util';
export { isNode, isWeb, delay, destroyable, DestroyableServer };

if (isNode) {
    // Run a target websocket server in the background. In browsers, this is
    // launched by from the Karma script. Eventually this should be replaced
    // by a Mockttp-spawned WS server, once we have one.
    require('./fixtures/websocket-test-server');
}

chai.use(chaiAsPromised);
chai.use(chaiFetch);

export const AssertionError = chai.AssertionError;

function getGlobalFetch() {
    return {
        fetch: <typeof window.fetch> (<any> window.fetch).bind(window),
        Headers: Headers,
        Request: Request,
        Response: Response
    };
}

let fetchImplementation = isNode ? getFetchPonyfill() : getGlobalFetch();

export const fetch = fetchImplementation.fetch;

// All a bit convoluted, so we don't shadow the global vars,
// and we can still use those to define these in the browser
const headersImplementation = fetchImplementation.Headers;
const requestImplementation = fetchImplementation.Request;
const responseImplementation = fetchImplementation.Response;
export { headersImplementation as Headers };
export { requestImplementation as Request };
export { responseImplementation as Response };

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

export type Deferred<T> = Promise<T> & {
    resolve(value: T): void,
    reject(e: Error): void
}
export function getDeferred<T>(): Deferred<T> {
    let resolveCallback: (value: T) => void;
    let rejectCallback: (e: Error) => void;
    let result = <Deferred<T>> new Promise((resolve, reject) => {
        resolveCallback = resolve;
        rejectCallback = reject;
    });
    result.resolve = resolveCallback!;
    result.reject = rejectCallback!;

    return result;
}

const TOO_LONG_HEADER_SIZE = 1024 * (isNode ? 16 : 160) + 1;
export const TOO_LONG_HEADER_VALUE = _.range(TOO_LONG_HEADER_SIZE).map(() => "X").join("");

export async function openRawSocket(server: Mockttp) {
    const client = new net.Socket();
    await new Promise<void>((resolve) => client.connect(server.port, '127.0.0.1', resolve));
    return client;
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
    server: Mockttp,
    options: {
        servername?: string
        alpn?: string[]
    } = {}
): Promise<tls.TLSSocket> {
    if (!options.alpn) options.alpn = ['http/1.1']

    return await new Promise<tls.TLSSocket>((resolve) => {
        const socket: tls.TLSSocket = tls.connect({
            host: 'localhost',
            port: server.port,
            servername: options.servername,
            ALPNProtocols: options.alpn
        }, () => resolve(socket));
    });
}

// Write a message to a socket that will trigger a respnse, but kill the socket
// before the response is received, so a real response triggers a reset.
export async function writeAndReset(socket: net.Socket, content: string) {
    socket.write(content);
    setTimeout(() => socket.destroy(), 0);
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

    const server = destroyable(dns2.createServer(async (request, sendResponse) => {
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

    return new Promise<DestroyableServer>((resolve, reject) => {
        server.listen(5333, '127.0.0.1');
        server.on('listening', () => resolve(server));
        server.on('error', reject);
    });
}

export const H2_TLS_ON_TLS_SUPPORTED = ">=12.17";

type Http2ResponseHeaders = http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader;

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
            body.push(Buffer.from(d));
        });
        req.on('end', () => req.close());
        req.on('close', () => resolve(Buffer.concat(body)));
        req.on('error', reject);
    });
}

async function http2Request(
    url: string,
    headers: {},
    requestBody = '',
    createConnection?: (() => streams.Duplex) | undefined
) {
    const client = http2.connect(url, { createConnection });
    const req = client.request(headers, {
        endStream: !requestBody
    });
    if (requestBody) req.end(requestBody);

    const responseHeaders = await getHttp2Response(req);
    const responseBody = await getHttp2Body(req);
    const alpnProtocol = client.alpnProtocol;

    await cleanup(client);

    return {
        alpnProtocol,
        headers: responseHeaders,
        body: responseBody
    };
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
    headers: {} = {},
    requestBody = ''
) {
    const proxyClient = http2.connect(proxyServer.url);
    const parsedUrl = URL.parse(url);
    const proxyReq = proxyClient.request({
        ':method': 'CONNECT',
        ':authority': parsedUrl.host!
    });

    const proxyResponse = await getHttp2Response(proxyReq);
    expect(proxyResponse[':status']).to.equal(200);

    const result = http2Request(
        url,
        {
            ':path': parsedUrl.path,
            ...headers
        },
        requestBody,
        () => tls.connect({
            socket: proxyReq as any,
            ALPNProtocols: ['h2']
        })
    );

    await cleanup(proxyClient);

    return result;
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
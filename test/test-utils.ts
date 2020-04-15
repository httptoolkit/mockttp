import * as sourceMapSupport from 'source-map-support'
sourceMapSupport.install({ handleUncaughtExceptions: false });

import * as net from 'net';
import * as tls from 'tls';
import * as semver from 'semver';
import getFetchPonyfill = require("fetch-ponyfill");

import chai = require("chai");
import chaiAsPromised = require("chai-as-promised");
import chaiFetch = require("chai-fetch");

import { Mockttp } from "..";
import { isNode } from '../src/util/util';
export { isNode };

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

export const URLSearchParams: typeof window.URLSearchParams = (isNode || !window.URLSearchParams) ?
    require('url').URLSearchParams : window.URLSearchParams;

export const expect = chai.expect;

export function browserOnly(body: Function) {
    if (!isNode) body();
}

export function nodeOnly(body: Function) {
    if (isNode) body();
}

export function delay(t: number): Promise<void> {
    return new Promise((r) => setTimeout(r, t));
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

export const TOO_LONG_HEADER_SIZE = 1024 * 16 + 1;

export async function openRawSocket(server: Mockttp) {
    const client = new net.Socket();
    await new Promise((resolve) => client.connect(server.port, '127.0.0.1', resolve));
    return client;
}

export async function sendRawRequest(server: Mockttp, requestContent: string): Promise<string> {
    const client = new net.Socket();
    await new Promise((resolve) => client.connect(server.port, '127.0.0.1', resolve));

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

export async function openRawTlsSocket(server: Mockttp): Promise<tls.TLSSocket> {
    return await new Promise<tls.TLSSocket>((resolve) => {
        const socket: tls.TLSSocket = tls.connect({
            host: 'localhost',
            port: server.port
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
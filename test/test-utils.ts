import * as sourceMapSupport from 'source-map-support'
sourceMapSupport.install({ handleUncaughtExceptions: false });

import * as net from 'net';
import getFetchPonyfill = require("fetch-ponyfill");

import chai = require("chai");
import chaiAsPromised = require("chai-as-promised");
import chaiFetch = require("chai-fetch");

import { Mockttp } from "..";
import { isNode } from '../src/util/util';
export { isNode };

chai.use(chaiAsPromised);
chai.use(chaiFetch);

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
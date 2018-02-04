import * as sourceMapSupport from 'source-map-support'
sourceMapSupport.install({ handleUncaughtExceptions: false });

import getFetch = require("fetch-ponyfill");
import URLSearchParamsPolyfill = require('url-search-params');

import chai = require("chai");
import sinonChai = require("sinon-chai");
import chaiAsPromised = require("chai-as-promised");
import chaiFetch = require("chai-fetch");

chai.use(sinonChai);
chai.use(chaiAsPromised);
chai.use(chaiFetch);

function isNode() {
    return typeof window === 'undefined';
}

let fetchPonyfill = getFetch();
export const fetch = fetchPonyfill.fetch;
export const Headers = fetchPonyfill.Headers;
export const Request = fetchPonyfill.Request;
export const Response = fetchPonyfill.Response;

export const URLSearchParams: typeof window.URLSearchParams = ((isNode() || !window.URLSearchParams) ?
    require('url').URLSearchParams : window.URLSearchParams) || URLSearchParamsPolyfill;

export const expect = chai.expect;

export function browserOnly(body: Function) {
    if (!isNode()) body();
}

export function nodeOnly(body: Function) {
    if (isNode()) body();
}

export function delay(t: number): Promise<void> {
    return new Promise((r) => setTimeout(r, t));
}

type Deferred<T> = Promise<T> & {
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
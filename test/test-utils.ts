import getFetch = require("fetch-ponyfill");

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

export const URLSearchParams: typeof window.URLSearchParams = (isNode() || !window.URLSearchParams) ?
    require('url').URLSearchParams : window.URLSearchParams

export const expect = chai.expect;

export function browserOnly(body: Function) {
    if (!isNode()) body();
}

export function nodeOnly(body: Function) {
    if (isNode()) body();
}
import * as _ from 'lodash';
import * as http from 'http';

import {
    Headers,
    OngoingResponse,
    RawHeaders
} from "../types";

/*

These utils support conversion between the various header representations that we deal
with. Those are:

- Flat arrays of [key, value, key, value, key, ...]. This is the raw header format
  generally used by Node.js's APIs throughout.
- Raw header tuple arrays like [[key, value], [key, value]]. This is our own raw header
  format, aiming to be fairly easy to use and to preserve header order, header dupes &
  header casing throughout.
- Formatted header objects of { key: value, key: value }. These are returned as the most
  convenient and consistent header format: keys are lowercased, and values are either
  strings or arrays of strings (for duplicate headers). This is returned by Node's APIs,
  but with some unclear normalization rules, so in practice we build raw headers and
  reconstruct this ourselves everyhere, by lowercasing & building arrays of values.

*/

export const findRawHeader = (rawHeaders: RawHeaders, targetKey: string) =>
    rawHeaders.find(([key]) => key.toLowerCase() === targetKey);

export const getHeaderValue = (headers: Headers | RawHeaders, targetKey: Lowercase<string>) => {
    if (Array.isArray(headers)) {
        return findRawHeader(headers, targetKey)?.[1];
    } else {
        const value = headers[targetKey];
        if (Array.isArray(value)) {
            return value[0];
        } else {
            return value;
        }
    }
};

export const findRawHeaderIndex = (rawHeaders: RawHeaders, targetKey: string) =>
    rawHeaders.findIndex(([key]) => key.toLowerCase() === targetKey);

export const findRawHeaders = (rawHeaders: RawHeaders, targetKey: string) =>
    rawHeaders.filter(([key]) => key.toLowerCase() === targetKey);

/**
 * Return node's _very_ raw headers ([k, v, k, v, ...]) into our slightly more convenient
 * pairwise tuples [[k, v], [k, v], ...] RawHeaders structure.
 */
export function pairFlatRawHeaders(flatRawHeaders: string[]): RawHeaders {
    const result: RawHeaders = [];
    for (let i = 0; i < flatRawHeaders.length; i += 2 /* Move two at a time */) {
        result[i/2] = [flatRawHeaders[i], flatRawHeaders[i+1]];
    }
    return result;
}

export function flattenPairedRawHeaders(rawHeaders: RawHeaders): string[] {
    return rawHeaders.flat();
}

/**
 * Take a raw headers, and turn them into headers, but without some of Node's concessions
 * to ease of use, i.e. keeping multiple values as arrays.
 *
 * This lowercases all names along the way, to provide a convenient header API for most
 * downstream use cases, and to match Node's own behaviour.
 */
export function rawHeadersToObject(rawHeaders: RawHeaders): Headers {
    return rawHeaders.reduce<Headers>((headers, [key, value]) => {
        key = key.toLowerCase();

        const existingValue = headers[key];

        if (Array.isArray(existingValue)) {
            existingValue.push(value);
        } else if (existingValue) {
            headers[key] = [existingValue, value];
        } else {
            headers[key] = value;
        }

        return headers;
    }, {});
}

/**
 * Take raw headers, and turn them into headers just like `rawHeadersToObject` but
 * also preserves case en route.
 *
 * This is separated because our public APIs should _not_ do this, but there's a few
 * internal use cases where we want to, notably including passing headers to WS which
 * only accepts a headers object when sending upstream requests, but does preserve
 * case from the object.
 */
export function rawHeadersToObjectPreservingCase(rawHeaders: RawHeaders): Headers {
    // Duplicate keys with different cases in the final object clobber each other (last
    // value wins) so we need to pick a single casing for each header name. We don't want
    // to just use lowercase, because we want to preserve original casing wherever possible.
    // To make that work, we use the casing from the first instance of each header, along with
    // a lowercase -> first casing map here to look up that value later:
    const headerNameMap: { [lowerName: string]: string } = {};

    return rawHeaders.reduce<Headers>((headers, [key, value]) => {
        const lowerCaseKey = key.toLowerCase();

        if (headerNameMap[lowerCaseKey]) {
            // If we've already seen this header, we need to use the same
            // casing as before to avoid issues with duplicates:
            key = headerNameMap[lowerCaseKey];
        } else {
            // If we haven't, we store this key as the canonical format
            // to make it easy to merge with any duplicates:
            headerNameMap[lowerCaseKey] = key;
        }

        const existingValue = headers[key];

        if (Array.isArray(existingValue)) {
            existingValue.push(value);
        } else if (existingValue) {
            headers[key] = [existingValue, value];
        } else {
            headers[key] = value;
        }

        return headers;
    }, {});
}

export function objectHeadersToRaw(headers: Headers): RawHeaders {
    const rawHeaders: RawHeaders = [];

    for (let key in headers) {
        const value = headers[key];

        if (value === undefined) continue; // Drop undefined header values

        if (Array.isArray(value)) {
            value.forEach((v) => rawHeaders.push([key, v.toString()]));
        } else {
            rawHeaders.push([key, value.toString()]);
        }
    }

    return rawHeaders;
}

export function objectHeadersToFlat(headers: Headers): string[] {
    const flatHeaders: string[] = [];

    for (let key in headers) {
        const value = headers[key];

        if (value === undefined) continue; // Drop undefined header values

        if (Array.isArray(value)) {
            value.forEach((v) => {
                flatHeaders.push(key);
                flatHeaders.push(v.toString());
            });
        } else {
            flatHeaders.push(key);
            flatHeaders.push(value.toString());
        }
    }

    return flatHeaders;
}

/**
 * Combine the given headers with the raw headers, preserving the raw header details where
 * possible. Headers keys that exist in the raw headers (case insensitive) will be overridden,
 * while undefined header values will remove the header from the raw headers entirely.
 *
 * When proxying we often have raw received headers that we want to forward upstream exactly
 * as they were received, but we also want to add or modify a subset of those headers. This
 * method carefully does that - preserving everything that isn't actively modified as-is.
 */
export function updateRawHeaders(
    rawHeaders: RawHeaders,
    headers: Headers
) {
    const updatedRawHeaders = [...rawHeaders];
    const rawHeaderKeys = updatedRawHeaders.map(([key]) => key.toLowerCase());

    for (const key of Object.keys(headers)) {
        const lowerCaseKey = key.toLowerCase();
        for (let i = 0; i < rawHeaderKeys.length; i++) {
            // If you insert a header that already existed, remove all previous values
            if (rawHeaderKeys[i] === lowerCaseKey) {
                updatedRawHeaders.splice(i, 1);
                rawHeaderKeys.splice(i, 1);
            }
        }
    }

    // We do all removals in advance, then do all additions here, to ensure that adding
    // a new header twice works correctly.

    for (const [key, value] of Object.entries(headers)) {
        // Skip (effectively delete) undefined/null values from the headers
        if (value === undefined || value === null) continue;

        if (Array.isArray(value)) {
            value.forEach((v) => updatedRawHeaders.push([key, v]));
        } else {
            updatedRawHeaders.push([key, value]);
        }
    }

    return updatedRawHeaders;
}

// See https://httptoolkit.com/blog/translating-http-2-into-http-1/ for details on the
// transformations required between H2 & H1 when proxying.
export function h2HeadersToH1(h2Headers: RawHeaders): RawHeaders {
    let h1Headers = h2Headers.filter(([key]) => key[0] !== ':');

    if (!findRawHeader(h1Headers, 'host') && findRawHeader(h2Headers, ':authority')) {
        h1Headers.unshift(['Host', findRawHeader(h2Headers, ':authority')![1]]);
    }

    // In HTTP/1 you MUST only send one cookie header - in HTTP/2 sending multiple is fine,
    // so we have to concatenate them:
    const cookieHeaders = findRawHeaders(h1Headers, 'cookie')
    if (cookieHeaders.length > 1) {
        h1Headers = h1Headers.filter(([key]) => key.toLowerCase() !== 'cookie');
        h1Headers.push(['Cookie', cookieHeaders.join('; ')]);
    }

    return h1Headers;
}

// Take from http2/util.js in Node itself
const HTTP2_ILLEGAL_HEADERS = [
    'connection',
    'upgrade',
    'host',
    'http2-settings',
    'keep-alive',
    'proxy-connection',
    'transfer-encoding'
];

export function h1HeadersToH2(headers: RawHeaders): RawHeaders {
    return headers.filter(([key]) =>
        !HTTP2_ILLEGAL_HEADERS.includes(key.toLowerCase())
    );
}

// If the user explicitly specifies headers, we tell Node not to handle them,
// so the user-defined headers are the full set.
export function dropDefaultHeaders(response: OngoingResponse) {
    // Drop the default headers, so only the headers we explicitly configure are included
    [
        'connection',
        'content-length',
        'transfer-encoding',
        'date'
    ].forEach((defaultHeader) =>
        response.removeHeader(defaultHeader)
    );
}

export function validateHeader(name: string, value: string | string[]): boolean {
    try {
        http.validateHeaderName(name);
        http.validateHeaderValue(name, value);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Set the value of a given header, overwriting it if present or otherwise adding it as a new header.
 *
 * For header objects, this overwrites all values. For raw headers, this overwrites the last value, so
 * if multiple values are present others may remain. In general you probably don't want to use this
 * for headers that could legally have multiple values present.
 */
export const setHeaderValue = (
    headers: Headers | RawHeaders,
    headerKey: string,
    headerValue: string,
    options: { prepend?: true } = {}
) => {
    const lowercaseHeaderKey = headerKey.toLowerCase();

    if (Array.isArray(headers)) {
        const headerPair = _.findLast(headers, ([key]) => key.toLowerCase() === lowercaseHeaderKey);
        if (headerPair) {
            headerPair[1] = headerValue;
        } else {
            if (options.prepend) headers.unshift([headerKey, headerValue]);
            else headers.push([headerKey, headerValue]);
        }
    } else {
        const existingKey = Object.keys(headers).find(k => k.toLowerCase() === lowercaseHeaderKey);
        headers[existingKey || headerKey] = headerValue;
    }
}
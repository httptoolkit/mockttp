import { isIPv6Address } from './ip-utils';
import { LruCache } from './lru-cache';
import { Destination } from '../types';

// Is this URL fully qualified?
// Note that this supports only HTTP - no websockets or anything else.
export const isAbsoluteUrl = (url: string) =>
    url.toLowerCase().startsWith('http://') ||
    url.toLowerCase().startsWith('https://');

export const isRelativeUrl = (url: string) =>
    url.startsWith('/');

export const isAbsoluteProtocollessUrl = (url: string) =>
    !isAbsoluteUrl(url) && !isRelativeUrl(url);

export const getUrlWithoutProtocol = (url: string): string => {
    return url.split('://', 2).slice(-1).join('');
}

const getAuthorityStartIndex = (url: string) => url.indexOf('://') + 3;

// The index where the request target (path & query) begins, or -1 if there's none at all.
// Backslashes end the authority too, to match WHATWG URL parsing of the host.
const getTargetStartIndex = (url: string) => {
    const authorityStart = getAuthorityStartIndex(url);
    const targetOffset = url.slice(authorityStart).search(/[/\\?#]/);
    return targetOffset === -1
        ? -1
        : authorityStart + targetOffset;
}

export const getHostFromAbsoluteUrl = (url: string) => {
    const targetIndex = getTargetStartIndex(url);
    return url.slice(
        getAuthorityStartIndex(url),
        targetIndex === -1 ? undefined : targetIndex
    );
}

export const getPathFromAbsoluteUrl = (url: string) => {
    const targetIndex = getTargetStartIndex(url);
    if (targetIndex === -1) return '/';

    const target = url.slice(targetIndex);
    return target.startsWith('/')
        ? target
        : '/' + target;
}

/**
 * Splits a request target into its pathname and its search (the query including its
 * leading '?', or an empty string if there's no query at all), without modifying either.
 */
const splitPathAndSearch = (path: string): { pathname: string, search: string } => {
    const queryIndex = path.indexOf('?');
    return queryIndex === -1
        ? { pathname: path, search: '' }
        : { pathname: path.slice(0, queryIndex), search: path.slice(queryIndex) };
}

const textEncoder = new TextEncoder();

// Node refuses to send request paths containing these characters at all, so they're the
// one thing we have to encode. Everything else is left exactly as it was received.
const escapeUnsendableChars = (path: string) =>
    path.replace(/[\u0000-\u0020]|[^\u0000-\u00ff]+/g, (chars) =>
        Array.from(textEncoder.encode(chars))
            .map((byte) => '%' + byte.toString(16).toUpperCase().padStart(2, '0'))
            .join('')
    );

export interface RequestUrlParts {
    protocol: string; // Including the trailing colon, e.g. 'https:'
    host: string;
    hostname: string; // IPv6 addresses are unbracketed
    port: string; // Empty if not specified
    path: string;
    pathname: string;
    search: string;
}

/**
 * Parse an absolute URL into its components, normalizing the scheme & authority, but leaving the
 * path & query as provided (encoding only characters that can't be sent at all) so that requests
 * can be forwarded without modification.
 */
export const parseRequestUrl = (absoluteUrl: string): RequestUrlParts => {
    const scheme = absoluteUrl.slice(0, absoluteUrl.indexOf('://'));
    const rawHost = getHostFromAbsoluteUrl(absoluteUrl);
    const parsedOrigin = new URL(`${scheme}://${rawHost}`);

    // WHATWG parsing drops explicit default ports, but we want to keep what was specified
    const port = parsedOrigin.port || rawHost.match(/:(\d+)$/)?.[1] || '';
    const hostname = parsedOrigin.hostname;

    const path = escapeUnsendableChars(getPathFromAbsoluteUrl(absoluteUrl));

    return {
        protocol: parsedOrigin.protocol,
        host: port ? `${hostname}:${port}` : hostname,
        hostname: hostname.startsWith('[')
            ? hostname.slice(1, -1)
            : hostname,
        port,
        path,
        ...splitPathAndSearch(path)
    };
}

/**
 * Build an absolute URL, normalizing the protocol & host, but leaving the
 * provided path & query exactly as-is.
 */
export const buildAbsoluteUrl = (protocol: string, host: string, path: string) => {
    const scheme = protocol.replace(/:$/, '');
    new URL(`${scheme}://${host}${path}`); // Throws if the URL as a whole is invalid

    const parsedOrigin = new URL(`${scheme}://${host}`);
    return `${parsedOrigin.protocol}//${parsedOrigin.host}${path}`;
};

/**
 * Get the query string (including the leading '?') from any URL, ignoring any fragment.
 * Returns an empty string if there is no query.
 */
export const getUrlSearch = (url: string): string => {
    const hashIndex = url.indexOf('#');
    return splitPathAndSearch(
        hashIndex === -1 ? url : url.slice(0, hashIndex)
    ).search;
}

export const parseQueryString = (search: string): { [key: string]: string | string[] } => {
    const result: { [key: string]: string | string[] } = Object.create(null);

    for (const [key, value] of new URLSearchParams(search)) {
        const existingValue = result[key];
        if (existingValue === undefined) {
            result[key] = value;
        } else if (Array.isArray(existingValue)) {
            existingValue.push(value);
        } else {
            result[key] = [existingValue, value];
        }
    }

    return result;
}

export const getDefaultPort = (protocol: string) => {
    if (protocol[protocol.length - 1] === ':') {
        protocol = protocol.slice(0, -1);
    }

    if (protocol === 'https' || protocol === 'wss') {
        return 443;
    } else if (protocol === 'http' || protocol === 'ws') {
        return 80;
    } else {
        throw new Error(`Unknown protocol: ${protocol}`);
    }
}

export const getEffectivePort = (url: { protocol: string | null, port: string | null }) => {
    if (url.port) {
        return parseInt(url.port, 10);
    } else {
        return getDefaultPort(url.protocol || 'http');
    }
}

export const getDestination = (protocol: string, host: string): Destination => {
    let hostname: string;
    let portString: string | undefined;

    const lastColonIndex = host.lastIndexOf(':');
    if (lastColonIndex !== -1) {
        hostname = host.slice(0, lastColonIndex);
        portString = host.slice(lastColonIndex + 1);
    } else {
        hostname = host;
        portString = undefined;
    }

    if (hostname[0] === '[' && hostname[hostname.length - 1] === ']') {
        // Bracketed IPv6 address, drop the brackets:
        hostname = hostname.slice(1, -1);
    }

    const port = portString
        ? parseInt(portString, 10)
        : getDefaultPort(protocol);

    if (isNaN(port)) {
        throw new Error(`Invalid port: ${portString}`);
    }

    return { hostname, port };
};

export const normalizeHost = (protocol: string, host: string) => {
    const { hostname, port } = getDestination(protocol, host);
    const normalizedHostname = isIPv6Address(hostname)
        ? `[${hostname}]`
        : hostname;

    if (port === getDefaultPort(protocol)) {
        return normalizedHostname;
    } else {
        return `${normalizedHostname}:${port}`;
    }
}

/**
 * Normalizes URLs to the form used when matching them.
 *
 * This accepts URLs in all three formats: relative, absolute, and protocolless-absolute,
 * and returns them in the same format but normalized.
 */
// Normalized URLs are cached, but requested URLs are untrusted & unlimited, so the cache is bounded.
const normalizedUrlCache = new LruCache<string, string>(1000);

export const normalizeUrl = (url: string): string => {
    const cachedResult = normalizedUrlCache.get(url);
    if (cachedResult !== undefined) return cachedResult;

    const result = calculateNormalizedUrl(url);
    normalizedUrlCache.set(url, result);
    return result;
};

const calculateNormalizedUrl = (urlInput: string): string => {
    // Strip the query, fragment and anything following them
    const queryOrHashIndex = urlInput.search(/[?#]/);
    if (queryOrHashIndex !== -1) {
        urlInput = urlInput.slice(0, queryOrHashIndex);
    }

    const isRelative = isRelativeUrl(urlInput);
    const isProtocolless = isAbsoluteProtocollessUrl(urlInput);

    let parsedUrl: URL;
    try {
        parsedUrl = new URL(
            isRelative
                ? 'http://placeholder' + urlInput
            : isProtocolless
                ? 'http://' + urlInput
            : urlInput
        );
    } catch (e) {
        console.log(`Failed to normalize URL ${urlInput}`);
        console.log(e);
        return urlInput;
    }

    const pathname = parsedUrl.pathname
        // Beyond the WHATWG encode set, we also encode the chars that Node's
        // legacy URL parser always encoded, for backward compat.
        .replace(/[|^']/g, (char) =>
            '%' + char.charCodeAt(0).toString(16).toUpperCase()
        )
        .replace(/\%[A-Fa-z0-9]{2}/g, (encoded) => encoded.toUpperCase());

    if (isRelative) return pathname;

    const host = parsedUrl.hostname.replace(/\.$/, '') +
        (parsedUrl.port ? `:${parsedUrl.port}` : '');

    return isProtocolless
        ? `${host}${pathname}`
        : `${parsedUrl.protocol}//${host}${pathname}`;
};

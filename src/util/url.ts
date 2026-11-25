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

/**
 * Split a host into hostname & port, or return null if it isn't an unambiguous authority -
 * i.e. if reading it as one could mean something other than what was written.
 */
const tryToSplitHostAndPort = (host: string): [string, string | null] | null => {
    if (!host || /[\/@?#]/.test(host)) return null;

    if (host.startsWith('[')) {
        const bracketEnd = host.indexOf(']');
        if (bracketEnd === -1) return null;

        const hostname = host.slice(1, bracketEnd);
        const remainder = host.slice(bracketEnd + 1);
        if (!hostname || (remainder && !remainder.startsWith(':'))) return null;
        return [hostname, remainder ? remainder.slice(1) : null];
    }

    // A bare IPv6 address has no unambiguous port separator. IPv6 with a port
    // must use the standard bracketed authority form.
    if (isIPv6Address(host)) return [host, null];

    const colonIndex = host.lastIndexOf(':');
    if (colonIndex === -1) return [host, null];

    const hostname = host.slice(0, colonIndex);
    if (!hostname || hostname.includes(':')) return null;
    return [hostname, host.slice(colonIndex + 1)];
};

/**
 * Split a host we control - from rule configuration, or built by us - into hostname & port.
 *
 * Throws if it isn't a valid authority, because at these call sites that means a mistake
 * we should report rather than quietly reinterpret.
 */
export const splitHostAndPortStrictly = (host: string): [hostname: string, port: string | null] => {
    const parsed = tryToSplitHostAndPort(host);
    if (!parsed) throw new Error(`Invalid host: ${host}`);
    return parsed;
};

/**
 * Split a host declared by a client - a Host header, :authority, SNI name or CONNECT
 * target - into hostname & port.
 *
 * Clients can send anything, so we're relaxed here, aiming to accurately reproduce the
 * real errors that these trigger upstream without auto-correction.
 */
export const splitHostAndPortLeniently = (host: string): [hostname: string, port: string | null] => {
    const parsed = tryToSplitHostAndPort(host);
    if (parsed) return parsed;

    // A malformed bracketed host has no reliable port, so we don't guess at one:
    if (host.startsWith('[')) return [host, null];

    const portMatch = /:(\d+)$/.exec(host);
    return portMatch
        ? [host.slice(0, portMatch.index), portMatch[1]]
        : [host, null];
};

export const getDestination = (protocol: string, host: string): Destination => {
    // Destinations come from clients, so host parsing is best effort
    const [hostname, portString] = splitHostAndPortLeniently(host);

    const port = portString
        ? parseInt(portString, 10)
        : getDefaultPort(protocol);

    if (isNaN(port)) {
        throw new Error(`Invalid port: ${portString}`);
    }

    return { hostname, port };
};

// Anything that could be an IPv6 literal (including IPv4-mapped or with a zone ID), which must be
// bracketed for a port to be unambiguous. Any other host with a colon came from a malformed client
// host, and joining it as-is reproduces what the client sent.
const IPV6_LITERAL_FORM = /^[0-9a-fA-F.]*:[0-9a-fA-F:.]*(%.+)?$/;

export const formatHostAndPort = (
    hostname: string,
    port?: string | number | null
): string => {
    const unbracketedHostname = hostname.startsWith('[') && hostname.endsWith(']')
        ? hostname.slice(1, -1)
        : hostname;
    const formattedHostname = IPV6_LITERAL_FORM.test(unbracketedHostname)
        ? `[${unbracketedHostname}]`
        : unbracketedHostname;
    const hasPort = port !== undefined && port !== null && port !== '';
    return formattedHostname + (hasPort ? `:${port}` : '');
};

export const normalizeHost = (protocol: string, host: string) => {
    const { hostname, port } = getDestination(protocol, host);

    if (port === getDefaultPort(protocol)) {
        return formatHostAndPort(hostname);
    } else {
        return formatHostAndPort(hostname, port);
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

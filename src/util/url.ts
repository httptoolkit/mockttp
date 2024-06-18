import * as url from 'url';
import * as _ from 'lodash';

import { nthIndexOf } from './util';

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

export const getPathFromAbsoluteUrl = (url: string) => {
    const pathIndex = nthIndexOf(url, '/', 3);
    if (pathIndex !== -1) {
        return url.slice(pathIndex);
    } else {
        return '';
    }
}

export const getEffectivePort = (url: { protocol: string | null, port: string | null }) => {
    if (url.port) {
        return parseInt(url.port, 10);
    } else if (url.protocol === 'https:' || url.protocol === 'wss:') {
        return 443;
    } else {
        return 80;
    }
}

/**
 * Normalizes URLs to the form used when matching them.
 *
 * This accepts URLs in all three formats: relative, absolute, and protocolless-absolute,
 * and returns them in the same format but normalized.
 */
export const normalizeUrl: (url: string) => string =
    _.memoize(
        (urlInput: string): string => {
            let parsedUrl: Partial<url.UrlWithStringQuery> | undefined;

            let isProtocolless = false;

            try {
                // Strip the query and anything following it
                const queryIndex = urlInput.indexOf('?');
                if (queryIndex !== -1) {
                    urlInput = urlInput.slice(0, queryIndex);
                }

                if (isAbsoluteProtocollessUrl(urlInput)) {
                    parsedUrl = url.parse('http://' + urlInput);
                    isProtocolless = true;
                } else {
                    parsedUrl = url.parse(urlInput);
                }

                // Trim out lots of the bits we don't like:
                delete parsedUrl.host;
                delete parsedUrl.query;
                delete parsedUrl.search;
                delete parsedUrl.hash;

                if (parsedUrl.pathname) {
                    parsedUrl.pathname = parsedUrl.pathname.replace(
                        /\%[A-Fa-z0-9]{2}/g,
                        (encoded) => encoded.toUpperCase()
                    ).replace(
                        /[^\u0000-\u007F]+/g,
                        (unicodeChar) => encodeURIComponent(unicodeChar)
                    );
                }

                if (parsedUrl.hostname && parsedUrl.hostname.endsWith('.')) {
                    parsedUrl.hostname = parsedUrl.hostname.slice(0, -1);
                }

                if (
                    (parsedUrl.protocol === 'https:' && parsedUrl.port === '443') ||
                    (parsedUrl.protocol === 'http:' && parsedUrl.port === '80')
                ) {
                    delete parsedUrl.port;
                }
            } catch (e) {
                console.log(`Failed to normalize URL ${urlInput}`);
                console.log(e);

                if (!parsedUrl) return urlInput; // Totally unparseble: use as-is
                // If we've successfully parsed it, we format what we managed
                // and leave it at that:
            }

            let normalizedUrl = url.format(parsedUrl);

            // If the URL came in with no protocol, it should leave with
            // no protocol (protocol added temporarily above to allow parsing)
            if (isProtocolless) {
                normalizedUrl = normalizedUrl.slice('http://'.length);
            }

            return normalizedUrl;
        }
    );

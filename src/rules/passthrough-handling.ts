import * as _ from 'lodash';
import * as fs from 'fs/promises';
import * as tls from 'tls';
import url = require('url');
import { oneLine } from 'common-tags';
import CacheableLookup from 'cacheable-lookup';
import * as semver from 'semver';

import { CompletedBody, Headers, RawHeaders } from '../types';
import { byteLength } from '../util/util';
import { asBuffer } from '../util/buffer-utils';
import { isIP, isLocalhostAddress, normalizeIP } from '../util/ip-utils';
import { CachedDns, dnsLookup, DnsLookupFunction } from '../util/dns';
import { isMockttpBody, encodeBodyBuffer } from '../util/request-utils';
import { areFFDHECurvesSupported } from '../util/openssl-compat';
import { ErrorLike, unreachableCheck } from '@httptoolkit/util';
import { findRawHeaderIndex, getHeaderValue } from '../util/header-utils';

import {
    CallbackRequestResult,
    CallbackResponseMessageResult
} from './requests/request-step-definitions';
import { AbortError } from './requests/request-step-impls';
import {
    CADefinition,
    PassThroughInitialTransforms,
    PassThroughLookupOptions
} from './passthrough-handling-definitions';
import { getDefaultPort } from '../util/url';
import { applyMatchReplace } from './match-replace';

// TLS settings for proxied connections, intended to avoid TLS fingerprint blocking
// issues so far as possible, by closely emulating a Firefox Client Hello:
const NEW_CURVES_SUPPORTED = areFFDHECurvesSupported(process.versions.openssl);

const SSL_OP_LEGACY_SERVER_CONNECT = 1 << 2;
const SSL_OP_TLSEXT_PADDING = 1 << 4;
const SSL_OP_NO_ENCRYPT_THEN_MAC = 1 << 19;

// All settings are designed to exactly match Firefox v103, since that's a good baseline
// that seems to be widely accepted and is easy to emulate from Node.js.
export const getUpstreamTlsOptions = (strictChecks: boolean): tls.SecureContextOptions => ({
    ecdhCurve: [
        'X25519',
        'prime256v1', // N.B. Equivalent to secp256r1
        'secp384r1',
        'secp521r1',
        ...(NEW_CURVES_SUPPORTED
            ? [ // Only available with OpenSSL v3+:
                'ffdhe2048',
                'ffdhe3072'
            ] : []
        )
    ].join(':'),
    sigalgs: [
        'ecdsa_secp256r1_sha256',
        'ecdsa_secp384r1_sha384',
        'ecdsa_secp521r1_sha512',
        'rsa_pss_rsae_sha256',
        'rsa_pss_rsae_sha384',
        'rsa_pss_rsae_sha512',
        'rsa_pkcs1_sha256',
        'rsa_pkcs1_sha384',
        'rsa_pkcs1_sha512',
        'ECDSA+SHA1',
        'rsa_pkcs1_sha1'
    ].join(':'),
    ciphers: [
        'TLS_AES_128_GCM_SHA256',
        'TLS_CHACHA20_POLY1305_SHA256',
        'TLS_AES_256_GCM_SHA384',
        'ECDHE-ECDSA-AES128-GCM-SHA256',
        'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-ECDSA-CHACHA20-POLY1305',
        'ECDHE-RSA-CHACHA20-POLY1305',
        'ECDHE-ECDSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES256-GCM-SHA384',
        'ECDHE-ECDSA-AES256-SHA',
        'ECDHE-ECDSA-AES128-SHA',
        'ECDHE-RSA-AES128-SHA',
        'ECDHE-RSA-AES256-SHA',
        'AES128-GCM-SHA256',
        'AES256-GCM-SHA384',
        'AES128-SHA',
        'AES256-SHA',

        // This magic cipher is the very obtuse way that OpenSSL downgrades the overall
        // security level to allow various legacy settings, protocols & ciphers:
        ...(!strictChecks
            ? ['@SECLEVEL=0']
            : []
        )
    ].join(':'),
    secureOptions: strictChecks
        ? SSL_OP_TLSEXT_PADDING | SSL_OP_NO_ENCRYPT_THEN_MAC
        : SSL_OP_TLSEXT_PADDING | SSL_OP_NO_ENCRYPT_THEN_MAC | SSL_OP_LEGACY_SERVER_CONNECT,
    ...({
        // Valid, but not included in Node.js TLS module types:
        requestOSCP: true
    } as any),

    // Trust intermediate certificates from the trusted CA list too. Without this, trusted CAs
    // are only used when they are self-signed root certificates. Seems to cause issues in Node v20
    // in HTTP/2 tests, so disabled below the supported v22 version.
    allowPartialTrustChain: semver.satisfies(process.version, '>=22.9.0'),

    // Allow TLSv1, if !strict:
    minVersion: strictChecks ? tls.DEFAULT_MIN_VERSION : 'TLSv1',

    // Skip certificate validation entirely, if not strict:
    rejectUnauthorized: strictChecks,
});

export async function getTrustedCAs(
    trustedCAs: Array<CADefinition> | undefined,
    additionalTrustedCAs: Array<CADefinition> | undefined
): Promise<Array<string> | undefined> {
    if (trustedCAs && additionalTrustedCAs?.length) {
        throw new Error(`trustedCAs and additionalTrustedCAs options are mutually exclusive`);
    }

    if (trustedCAs) {
        return Promise.all(trustedCAs.map((caDefinition) => getCA(caDefinition)));
    }

    if (additionalTrustedCAs) {
        const CAs = await Promise.all(additionalTrustedCAs.map((caDefinition) => getCA(caDefinition)));
        return tls.rootCertificates.concat(CAs);
    }
}

const getCA = async (caDefinition: CADefinition) => {
    return 'certPath' in caDefinition
        ? await fs.readFile(caDefinition.certPath, 'utf8')
    : 'cert' in caDefinition
        ? caDefinition.cert.toString('utf8')
    : unreachableCheck(caDefinition);
}


// --- Various helpers for deriving parts of request/response data given partial overrides: ---

/**
 * Takes a callback result and some headers, and returns a ready to send body, using the headers
 * (and potentially modifying them) to match the content type & encoding.
 */
export async function buildOverriddenBody(
    callbackResult: CallbackRequestResult | CallbackResponseMessageResult | void,
    headers: Headers
) {
    // Raw bodies are easy: use them as is.
    if (callbackResult?.rawBody) return callbackResult?.rawBody!;

    // In the json/body case, we need to get the body and transform it into a buffer
    // for consistent handling later, and encode it to match the headers.

    let replacementBody: string | Uint8Array | Buffer | CompletedBody | undefined;
    if (callbackResult?.json) {
        headers['content-type'] = 'application/json';
        replacementBody = JSON.stringify(callbackResult?.json);
    } else {
        replacementBody = callbackResult?.body;
    }

    if (replacementBody === undefined) return replacementBody;

    let rawBuffer: Buffer;
    if (isMockttpBody(replacementBody)) {
        // It's our own bodyReader instance. That's not supposed to happen, but
        // it's ok, we just need to use the buffer data instead of the whole object
        rawBuffer = Buffer.from((replacementBody as CompletedBody).buffer);
    } else if (replacementBody === '') {
        // For empty bodies, it's slightly more convenient if they're truthy
        rawBuffer = Buffer.alloc(0);
    } else {
        rawBuffer = asBuffer(replacementBody);
    }

    return await encodeBodyBuffer(rawBuffer, headers);
}

/**
 * Effectively match the slightly-different-context logic in MockttpServer for showing a
 * request's destination within the URL. We prioritise domain names over IPs, and
 * derive the most appropriate name available. In this case, we drop the port, since that's
 * always specified elsewhere.
 */
export function getUrlHostname(
    destinationHostname: string | null,
    rawHeaders: RawHeaders
) {
    return destinationHostname && !isIP(destinationHostname)
        ? destinationHostname
        : ( // Use header info rather than raw IPs, if we can:
            getHeaderValue(rawHeaders, ':authority') ??
            getHeaderValue(rawHeaders, 'host') ??
            destinationHostname ?? // Use destination if it's a bare IP, if we have nothing else
            'localhost'
        ).replace(/:\d+$/, '');
}

/**
 * If you override some headers, they have implications for the effective URL we send the
 * request to. If you override that and the URL at the same time, it gets complicated.
 *
 * This method calculates the correct header value we should use: prioritising the header
 * value you provide, printing a warning if it's contradictory, or return the URL-inferred
 * value to override the header correctly if you didn't specify.
 */
function deriveUrlLinkedHeader(
    originalHeaders: Headers,
    replacementHeaders: Headers | undefined,
    headerName: 'host' | ':authority' | ':scheme',
    expectedValue: string // The inferred 'correct' value from the URL
) {
    const replacementValue = replacementHeaders?.[headerName];

    if (replacementValue !== undefined) {
        if (replacementValue !== expectedValue && replacementValue === originalHeaders[headerName]) {
            // If you rewrite the URL-based header wrongly, by explicitly setting it to the
            // existing value, we accept it but print a warning. This would be easy to
            // do if you mutate the existing headers, for example, and ignore the host.
            console.warn(oneLine`
                Passthrough callback overrode the URL and the ${headerName} header
                with mismatched values, which may be a mistake. The URL implies
                ${expectedValue}, whilst the header was set to ${replacementValue}.
            `);
        }
        // Whatever happens, if you explicitly set a value, we use it.
        return replacementValue;
    }

    // If you didn't override the header at all, then we automatically ensure
    // the correct value is set automatically.
    return expectedValue;
}

export function applyDestinationTransforms(
    transform: PassThroughInitialTransforms,
    { isH2Downstream, rawHeaders, port, protocol, hostname, pathname, query }: {
        isH2Downstream: boolean,
        rawHeaders: RawHeaders,
        port: string | null
        protocol: string | null,
        hostname: string,
        pathname: string | null
        query: string | null
    },
) {
    const {
        setProtocol,
        replaceHost,
        matchReplaceHost,
        matchReplacePath,
        matchReplaceQuery,
    } = transform;

    if (setProtocol) {
        const wasDefaultPort = port === null || getDefaultPort(protocol || 'http') === parseInt(port, 10);
        protocol = setProtocol + ':';

        // If we were on the default port, update that accordingly:
        if (wasDefaultPort) {
            port = getDefaultPort(protocol).toString();
        }
    }

    if (replaceHost) {
        const { targetHost } = replaceHost;
        [hostname, port] = targetHost.split(':');
    }

    if (matchReplaceHost) {
        const result = applyMatchReplace(port === null ? hostname! : `${hostname}:${port}`, matchReplaceHost.replacements);
        [hostname, port] = result.split(':');
    }

    if ((replaceHost?.updateHostHeader ?? matchReplaceHost?.updateHostHeader) !== false) {
        const updateHostHeader = replaceHost?.updateHostHeader ?? matchReplaceHost?.updateHostHeader;
        const hostHeaderName = isH2Downstream ? ':authority' : 'host';

        let hostHeaderIndex = findRawHeaderIndex(rawHeaders, hostHeaderName);
        let hostHeader: [string, string];

        if (hostHeaderIndex === -1) {
            // Should never happen really, but just in case:
            hostHeader = [hostHeaderName, hostname!];
            hostHeaderIndex = rawHeaders.length;
        } else {
            // Clone this - we don't want to modify the original headers, as they're used for events
            hostHeader = _.clone(rawHeaders[hostHeaderIndex]);
        }
        rawHeaders[hostHeaderIndex] = hostHeader;

        if (updateHostHeader === undefined || updateHostHeader === true) {
            // If updateHostHeader is true, or just not specified, match the new target
            hostHeader[1] = hostname + (port ? `:${port}` : '');
        } else if (updateHostHeader) {
            // If it's an explicit custom value, use that directly.
            hostHeader[1] = updateHostHeader;
        } // Otherwise: falsey means don't touch it.
    }

    if (matchReplacePath) {
        pathname = applyMatchReplace(pathname || '/', matchReplacePath);
    }

    if (matchReplaceQuery) {
        query = applyMatchReplace(query || '', matchReplaceQuery);
    }

    return {
        reqUrl: new URL(`${protocol}//${hostname}${(port ? `:${port}` : '')}${pathname || '/'}${query || ''}`).toString(),
        protocol,
        hostname,
        port,
        pathname,
        query,
        rawHeaders
    };
}

/**
 * Autocorrect the host header only in the case that if you didn't explicitly
 * override it yourself for some reason (e.g. if you're testing bad behaviour).
 */
export function getHostAfterModification(
    reqUrl: string,
    originalHeaders: Headers,
    replacementHeaders: Headers | undefined
): string {
    return deriveUrlLinkedHeader(
        originalHeaders,
        replacementHeaders,
        'host',
        url.parse(reqUrl).host!
    );
}

// These pseudoheaders are modifable, in that they are independent from the other HTTP
// request params: you can send plain HTTP but set :scheme:https, and you can send
// to one hostname but set another hostname as the authority.
export const MODIFIABLE_PSEUDOHEADERS = [
    ':authority',
    ':scheme'
] as const;

/**
 * Automatically update the :scheme and :authority headers to match the updated URL,
 * as long as they weren't explicitly overriden themselves, in which case let them
 * be set to any invalid value you like (e.g. to send a request to one server but
 * pretend it was sent to another).
 */
export function getH2HeadersAfterModification(
    reqUrl: string,
    originalHeaders: Headers,
    replacementHeaders: Headers | undefined
): { [K in typeof MODIFIABLE_PSEUDOHEADERS[number]]: string } {
    const parsedUrl = url.parse(reqUrl);

    return {
        ':scheme': deriveUrlLinkedHeader(
            originalHeaders,
            replacementHeaders,
            ':scheme',
            parsedUrl.protocol!.slice(0, -1)
        ),
        ':authority': deriveUrlLinkedHeader(
            originalHeaders,
            replacementHeaders,
            ':authority',
            parsedUrl.host!
        )
    };
}

// When modifying requests, we ensure you always have correct framing, as it's impossible
// to send a request with framing that doesn't match the body.
export function getRequestContentLengthAfterModification(
    body: string | Uint8Array | Buffer,
    originalHeaders: Headers | RawHeaders,
    replacementHeaders: Headers | RawHeaders | undefined,
    context: {
        httpVersion: 1 | 2
        // N.b. we ignore the method though - you can proxy requests that include a body
        // even if they really shouldn't, as long as it's plausibly parseable.
    }
): string | undefined {
    // If there was a content-length header, it might now be wrong, and it's annoying
    // to need to set your own content-length override when you just want to change
    // the body. To help out, if you override the body in a way that results in invalid
    // content-length headers, we fix them for you.

    // For HTTP/2, framing is optional/advisory so we can just skip this entirely.
    if (context.httpVersion !== 1) return undefined;

    const resultingHeaders = replacementHeaders || originalHeaders;

    if (getHeaderValue(resultingHeaders, 'transfer-encoding')?.includes('chunked')) {
        return undefined; // No content-length header games needed
    }

    const expectedLength = byteLength(body).toString();
    const contentLengthHeader = getHeaderValue(resultingHeaders, 'content-length');

    if (contentLengthHeader === expectedLength) return undefined;
    if (contentLengthHeader === undefined) return expectedLength; // Differs from responses

    // The content-length is expected, but it's wrong or missing.

    // If there is a wrong content-length set, and it's not just leftover from the original headers (i.e.
    // you intentionally set it) then we show a warning since we're ignoring your (invalid) instructions.
    if (contentLengthHeader && contentLengthHeader !== getHeaderValue(originalHeaders, 'content-length')) {
        console.warn(`Invalid request content-length header was ignored - resetting from ${
            contentLengthHeader
        } to ${
            expectedLength
        }`);
    }

    return expectedLength;
}

// When modifying responses, we ensure you always have correct framing, but in a slightly more
// relaxed way than for requests: we allow no framing and HEAD responses, we just block invalid values.
export function getResponseContentLengthAfterModification(
    body: string | Uint8Array | Buffer,
    originalHeaders: Headers | RawHeaders,
    replacementHeaders: Headers | RawHeaders | undefined,
    context: {
        httpMethod: string
        httpVersion: 1 | 2
    }
): string | undefined {
    // For HEAD requests etc, you can set an arbitrary content-length header regardless
    // of the empty body, so we don't bother checking anything. For HTTP/2, framing is
    // optional/advisory so we can just skip this entirely.
    if (context.httpVersion !== 1 || context.httpMethod === 'HEAD') return undefined;

    const resultingHeaders = replacementHeaders || originalHeaders;

    if (getHeaderValue(resultingHeaders, 'transfer-encoding')?.includes('chunked')) {
        return undefined; // No content-length header games needed
    }

    const expectedLength = byteLength(body).toString();
    const contentLengthHeader = getHeaderValue(resultingHeaders, 'content-length');

    if (contentLengthHeader === expectedLength) return undefined;
    if (contentLengthHeader === undefined) return undefined; // Differs from requests - we do allow this for responses

    // The content-length is set, but it's wrong.

    // If there is a wrong content-length set, and it's not just leftover from the original headers (i.e.
    // you intentionally set it) then we show a warning since we're ignoring your (invalid) instructions.
    if (contentLengthHeader && contentLengthHeader !== getHeaderValue(originalHeaders, 'content-length')) {
        console.warn(`Invalid response content-length header was ignored - resetting from ${
            contentLengthHeader
        } to ${
            expectedLength
        }`);
    }

    return expectedLength;
}

// Function to check if we should skip https errors for the current hostname and port,
// based on the given config
export function shouldUseStrictHttps(
    hostname: string,
    port: number,
    ignoreHostHttpsErrors: string[] | boolean
) {
    let skipHttpsErrors = false;

    if (ignoreHostHttpsErrors === true) {
        // Ignore cert errors if `ignoreHostHttpsErrors` is set to true, or
        skipHttpsErrors = true;
    } else if (Array.isArray(ignoreHostHttpsErrors) && (
        // if the whole hostname or host+port is whitelisted
        _.includes(ignoreHostHttpsErrors, hostname) ||
        _.includes(ignoreHostHttpsErrors, `${hostname}:${port}`)
    )) {
        skipHttpsErrors = true;
    }
    return !skipHttpsErrors;
}

export const getDnsLookupFunction = _.memoize((lookupOptions: PassThroughLookupOptions | undefined) => {
    if (!lookupOptions) {
        // By default, use 10s caching of hostnames, just to reduce the delay from
        // endlessly 10ms query delay for 'localhost' with every request.
        return new CachedDns(10000).lookup;
    } else {
        // Or if options are provided, use those to configure advanced DNS cases:
        const cacheableLookup = new CacheableLookup({
            maxTtl: lookupOptions.maxTtl,
            errorTtl: lookupOptions.errorTtl,
            // As little caching of "use the fallback server" as possible:
            fallbackDuration: 0
        });

        if (lookupOptions.servers) {
            cacheableLookup.servers = lookupOptions.servers;
        }

        return cacheableLookup.lookup;
    }
});

export async function getClientRelativeHostname(
    hostname: string,
    remoteIp: string | undefined,
    lookupFn: DnsLookupFunction
) {
    if (!remoteIp || isLocalhostAddress(remoteIp)) return hostname;

    // Otherwise, we have a request from a different machine (or Docker container/VM/etc) and we need
    // to make sure that 'localhost' means _that_ machine, not ourselves.

    // This check must be run before req modifications. If a modification changes the address to localhost,
    // then presumably it really does mean *this* localhost.

    if (
        // If the hostname is a known localhost address, we're done:
        isLocalhostAddress(hostname) ||
        // Otherwise, we look up the IP, so we can accurately check for localhost-bound requests. This adds a little
        // delay, but since it's cached we save the equivalent delay in request lookup later, so it should be
        // effectively free. We ignore errors to delegate unresolvable etc to request processing later.
        isLocalhostAddress(await dnsLookup(lookupFn, hostname).catch(() => null))
    ) {
        return normalizeIP(remoteIp);

        // Note that we just redirect - we don't update the host header. From the POV of the target, it's still
        // 'localhost' traffic that should appear identical to normal.
    } else {
        return hostname;
    }
}

export function buildUpstreamErrorTags(e: ErrorLike) {
    const tags: string[] = [];

    // OpenSSL can throw all sorts of weird & wonderful errors here, and rarely exposes a
    // useful error code from them. To handle that, we try to detect the most common cases,
    // notable including the useless but common 'unsupported' error that covers all
    // OpenSSL-unsupported (e.g. legacy) configurations.
    if (!e.code && e.stack?.split('\n')[1]?.includes('node:internal/tls/secure-context')) {
        let tlsErrorTag: string;
        if (e.message === 'unsupported') {
            e.code = 'ERR_TLS_CONTEXT_UNSUPPORTED';
            tlsErrorTag = 'context-unsupported';
            e.message = 'Unsupported TLS configuration';
        } else {
            e.code = 'ERR_TLS_CONTEXT_UNKNOWN';
            tlsErrorTag = 'context-unknown';
            e.message = `TLS context error: ${e.message}`;
        }

        tags.push(`passthrough-tls-error:${tlsErrorTag}`);
    }

    // All raw error codes are included in the tags:
    tags.push('passthrough-error:' + e.code);

    // We build tags for by SSL alerts, for each recognition elsewhere:
    const tlsAlertMatch = /SSL alert number (\d+)/.exec(e.message ?? '');
    if (tlsAlertMatch) {
        tags.push('passthrough-tls-error:ssl-alert-' + tlsAlertMatch[1]);
    }

    if (e instanceof AbortError) {
        tags.push('passthrough-error:mockttp-abort')
    }

    return tags;
}
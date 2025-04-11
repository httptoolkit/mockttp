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
import { isLocalhostAddress, normalizeIP } from '../util/socket-util';
import { CachedDns, dnsLookup, DnsLookupFunction } from '../util/dns';
import { isMockttpBody, encodeBodyBuffer } from '../util/request-utils';
import { areFFDHECurvesSupported } from '../util/openssl-compat';
import { ErrorLike } from '../util/error';
import { getHeaderValue } from '../util/header-utils';

import {
    CallbackRequestResult,
    CallbackResponseMessageResult
} from './requests/request-handler-definitions';
import { AbortError } from './requests/request-handlers';
import {
    CADefinition,
    PassThroughLookupOptions
} from './passthrough-handling-definitions';

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
    trustedCAs: Array<string | CADefinition> | undefined,
    additionalTrustedCAs: Array<CADefinition> | undefined
): Promise<Array<string> | undefined> {
    if (trustedCAs && additionalTrustedCAs?.length) {
        throw new Error(`trustedCAs and additionalTrustedCAs options are mutually exclusive`);
    }

    if (trustedCAs) {
        return Promise.all(trustedCAs.map((caDefinition) =>  getCA(caDefinition)));
    }

    if (additionalTrustedCAs) {
        const CAs = await Promise.all(additionalTrustedCAs.map((caDefinition) =>  getCA(caDefinition)));
        return tls.rootCertificates.concat(CAs);
    }
}

const getCA = async (caDefinition: string | CADefinition) => {
    return typeof caDefinition === 'string'
        ? caDefinition
    : 'certPath' in caDefinition
        ? await fs.readFile(caDefinition.certPath, 'utf8')
    // 'cert' in caDefinition
        : caDefinition.cert.toString('utf8')
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

export const OVERRIDABLE_REQUEST_PSEUDOHEADERS = [
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
): { [K in typeof OVERRIDABLE_REQUEST_PSEUDOHEADERS[number]]: string } {
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

// Helper to handle content-length nicely for you when rewriting requests with callbacks
export function getContentLengthAfterModification(
    body: string | Uint8Array | Buffer,
    originalHeaders: Headers | RawHeaders,
    replacementHeaders: Headers | RawHeaders | undefined,
    mismatchAllowed: boolean = false
): string | undefined {
    // If there was a content-length header, it might now be wrong, and it's annoying
    // to need to set your own content-length override when you just want to change
    // the body. To help out, if you override the body but don't explicitly override
    // the (now invalid) content-length, then we fix it for you.

    if (getHeaderValue(originalHeaders, 'content-length') === undefined) {
        // Nothing to override - use the replacement value, or undefined
        return getHeaderValue(replacementHeaders || {}, 'content-length');
    }

    if (!replacementHeaders) {
        // There was a length set, and you've provided a body but not changed it.
        // You probably just want to send this body and have it work correctly,
        // so we should fix the content length for you automatically.
        return byteLength(body).toString();
    }

    // There was a content length before, and you're replacing the headers entirely
    const lengthOverride = getHeaderValue(replacementHeaders, 'content-length')?.toString();

    // If you're setting the content-length to the same as the origin headers, even
    // though that's the wrong value, it *might* be that you're just extending the
    // existing headers, and you're doing this by accident (we can't tell for sure).
    // We use invalid content-length as instructed, but print a warning just in case.
    if (
        lengthOverride === getHeaderValue(originalHeaders, 'content-length') &&
        lengthOverride !== byteLength(body).toString() &&
        !mismatchAllowed // Set for HEAD responses
    ) {
        console.warn(oneLine`
            Passthrough modifications overrode the body and the content-length header
            with mismatched values, which may be a mistake. The body contains
            ${byteLength(body)} bytes, whilst the header was set to ${lengthOverride}.
        `);
    }

    return lengthOverride;
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
    hostname: string | null,
    remoteIp: string | undefined,
    lookupFn: DnsLookupFunction
) {
    if (!hostname || !remoteIp || isLocalhostAddress(remoteIp)) return hostname;

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
        return normalizeIP(remoteIp) as string | null;

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
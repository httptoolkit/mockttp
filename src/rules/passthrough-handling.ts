import * as _ from 'lodash';
import * as tls from 'tls';
import url = require('url');
import { oneLine } from 'common-tags';

import { Headers } from '../types';
import { byteLength } from '../util/util';

// We don't want to use the standard Node.js ciphers as-is, because remote servers can
// examine the TLS fingerprint to recognize they as coming from Node.js. To anonymize
// ourselves, we use a ever-so-slightly tweaked cipher config, which ensures we aren't
// easily recognizeable by default.
const defaultCiphers = (tls as any).DEFAULT_CIPHERS?.split(':') || []; // Standard, but not yet in the types - watch this space. [] included for browser fallback.
export const MOCKTTP_UPSTREAM_CIPHERS = [
    // We swap the ciphers position 1 & 3. These must be already preferred ciphers,
    // at the top of the list, so this should always be safe. For Node 14, this swaps
    // TLS_AES_256_GCM_SHA384 for TLS_AES_128_GCM_SHA256. Both are modern TLS 1.3
    // options, and this order matches Firefox & cURL's current top 3 ciphers too.
    defaultCiphers[2],
    defaultCiphers[1],
    defaultCiphers[0],
    ...defaultCiphers.slice(3)
].join(':');

// --- Various helpers for deriving parts of request/response data given partial overrides: ---

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
    originalHeaders: Headers,
    replacementHeaders: Headers | undefined,
    mismatchAllowed: boolean = false
): string | undefined {
    // If there was a content-length header, it might now be wrong, and it's annoying
    // to need to set your own content-length override when you just want to change
    // the body. To help out, if you override the body but don't explicitly override
    // the (now invalid) content-length, then we fix it for you.

    if (!_.has(originalHeaders, 'content-length')) {
        // Nothing to override - use the replacement value, or undefined
        return (replacementHeaders || {})['content-length'];
    }

    if (!replacementHeaders) {
        // There was a length set, and you've provided a body but not changed it.
        // You probably just want to send this body and have it work correctly,
        // so we should fix the content length for you automatically.
        return byteLength(body).toString();
    }

    // There was a content length before, and you're replacing the headers entirely
    const lengthOverride = replacementHeaders['content-length'] === undefined
        ? undefined
        : replacementHeaders['content-length'].toString();

    // If you're setting the content-length to the same as the origin headers, even
    // though that's the wrong value, it *might* be that you're just extending the
    // existing headers, and you're doing this by accident (we can't tell for sure).
    // We use invalid content-length as instructed, but print a warning just in case.
    if (
        lengthOverride === originalHeaders['content-length'] &&
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
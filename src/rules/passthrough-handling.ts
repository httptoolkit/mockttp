import * as crypto from 'crypto';

// We don't want to use the standard Node.js ciphers as-is, because remote servers can
// examine the TLS fingerprint to recognize they as coming from Node.js. To anonymize
// ourselves, we use a ever-so-slightly tweaked cipher config, which ensures we aren't
// easily recognizeable by default.
const defaultCiphers = (crypto.constants.defaultCipherList || '').split(':'); // Fallback for browser imports
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
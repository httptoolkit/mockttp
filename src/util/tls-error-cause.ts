import type { TlsHandshakeFailure } from '../types';

// No Node APIs in this file, so the browser test suite can import it too.

// Certificate alerts, by error code. OpenSSL names the alert in lower case in the message,
// which getCauseFromError matches, but BoringSSL (used by Electron, for example) names it only
// in upper case, e.g. SSLV3_ALERT_CERTIFICATE_UNKNOWN, so we check the code too.
const CERT_REJECTED_ALERT_CODE =
    /^ERR_SSL_.*_ALERT_(BAD_CERTIFICATE|CERTIFICATE_(UNKNOWN|EXPIRED|REVOKED|REQUIRED)|UNKNOWN_CA)$/;

export function getCauseFromError(
    error: Error & { code?: string }
): TlsHandshakeFailure['failureCause'] {
    const cause = (
        /alert certificate/.test(error.message) ||
        /alert bad certificate/.test(error.message) ||
        /alert unknown ca/.test(error.message) ||
        CERT_REJECTED_ALERT_CODE.test(error.code ?? '')
    )
        // The client explicitly told us it doesn't like the certificate
        ? 'cert-rejected'
    : /no shared cipher/.test(error.message)
        // The client refused to negotiate a cipher. Probably means it didn't like the
        // cert so refused to continue, but it could genuinely not have a shared cipher.
        ? 'no-shared-cipher'
    : (/ECONNRESET/.test(error.message) || error.code === 'ECONNRESET')
        // The client sent no TLS alert, it just hard RST'd the connection
        ? 'reset'
    : error.code === 'ERR_TLS_HANDSHAKE_TIMEOUT'
        ? 'handshake-timeout'
    : 'unknown'; // Something else.

    if (cause === 'unknown') console.log('Unknown TLS error:', error);

    return cause;
}

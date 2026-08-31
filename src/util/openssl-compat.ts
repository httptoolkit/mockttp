import * as tls from 'tls';
import * as semver from 'semver';

export function areFFDHECurvesSupported(opensslVersion: string | undefined) {
    // FFDHE curves (ffdhe2048, ffdhe3072) are only avaliable from
    // OpenSSL 3+

    // Before 3.0.0, OpenSSL has followed non-semver version
    // format (see https://wiki.openssl.org/index.php/Versioning).
    // For example, there was a version `1.1.1t`. `semver` package, however
    // can parse such versions with `loose: true` option

    // If not version is available, assume that the curves are not supported
    if (!opensslVersion) {
        return false;
    }

    try {
        const m = semver.major(opensslVersion, true);
        return m >= 3;
    }
    catch {
        // For any weirdly formed version where even the major part cannot be found,
        // we assume that the curves are not supported for safety
        return false;
    }
}

let secLevelSupport: boolean | undefined;

export function isSecLevelSupported() {
    // The @SECLEVEL cipher-string directive is an OpenSSL extension. Backends that
    // don't implement it (e.g. BoringSSL) reject the entire cipher string with
    // ERR_SSL_INVALID_COMMAND, rather than ignoring the unknown directive.

    // Feature-detected, not derived from process.versions.openssl, because that
    // isn't reliable: Bun reports '1.1.0', a version that does support @SECLEVEL.
    if (secLevelSupport === undefined) {
        try {
            tls.createSecureContext({ ciphers: 'AES128-SHA:@SECLEVEL=0' });
            secLevelSupport = true;
        } catch (e) {
            secLevelSupport = false;
        }
    }
    return secLevelSupport;
}

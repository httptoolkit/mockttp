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
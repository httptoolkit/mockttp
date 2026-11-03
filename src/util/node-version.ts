import semver from 'semver';

// Prereleases (e.g. v27.0.0-alpha) are excluded from plain ranges by default,
// so we include them, to correctly match nightly & alpha Node builds.
export const nodeVersionSatisfies = (range: string) =>
    semver.satisfies(process.version, range, { includePrerelease: true });

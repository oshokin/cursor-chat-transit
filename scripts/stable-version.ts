import semver from 'semver';

/** True for a stable `X.Y.Z` version, with no prerelease or build suffix. */
export function stableVersion(value: string): boolean {
  return (
    semver.valid(value) === value &&
    semver.prerelease(value) === null &&
    /^\d+\.\d+\.\d+$/.test(value)
  );
}

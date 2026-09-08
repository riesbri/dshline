/**
 * Strict semver shapes shared by release tag and registry validation.
 *
 * Release automation must reject malformed versions before an immutable tag or
 * package publication can be attempted. This is grammar validation only; it does
 * not compare versions or replace a semver library where ordering is needed.
 * Build metadata is intentionally excluded because pnpm strips it while packing.
 *
 * @module tools/release-version
 */

/** Semver numeric identifiers cannot have leading zeroes. */
const NUMERIC = '(?:0|[1-9][0-9]*)'

/** A prerelease identifier is numeric or contains at least one non-digit. */
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`

/** Shared semver grammar without anchors or a leading tag marker. */
const VERSION_PATTERN = `${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}`
  + `(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?`

/** A published package version accepted by the release tools. */
export const VERSION_SHAPE = new RegExp(`^${VERSION_PATTERN}(?![\\s\\S])`, 'u')

/** An immutable release tag carrying one accepted package version. */
export const RELEASE_TAG = new RegExp(`^v${VERSION_PATTERN}(?![\\s\\S])`, 'u')

/**
 * Return the version claimed by a release tag.
 * @param tag - immutable release tag.
 * @returns the package version without its leading `v`.
 * @throws when the tag is not a strict semver release tag.
 */
export function versionFromReleaseTag(tag) {
  // pnpm strips build metadata while packing, so it cannot remain an exact
  // immutable package identity in this release pipeline.
  if (
    typeof tag !== 'string'
    || !RELEASE_TAG.test(tag)
    || tag.includes('+')
    || isPrereleaseVersion(tag.slice(1))
  ) {
    throw new Error(`expected a release tag like v1.2.3, got ${JSON.stringify(tag)}`)
  }
  return tag.slice(1)
}

/**
 * Validate an immutable release tag before it reaches a registry or API path.
 * @param tag - requested release tag.
 * @returns the same validated tag.
 * @throws when the tag is not a strict semver release tag.
 */
export function validateReleaseTag(tag) {
  versionFromReleaseTag(tag)
  return tag
}

/**
 * Determine whether a version is a prerelease, ignoring build metadata.
 * @param version - strict semver version without a leading tag marker.
 * @returns whether the prerelease component is present.
 */
export function isPrereleaseVersion(version) {
  return version.split('+', 1)[0].includes('-')
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  try {
    validateReleaseTag(process.env.RELEASE_TAG ?? '')
  } catch (error) {
    process.stderr.write(`release-version: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  }
}

/**
 * Create a GitHub Release for an immutable tag, or safely reuse the existing one.
 *
 * The read is explicit rather than `gh release view || gh release create`: an
 * authentication or GitHub outage must never be mistaken for an absent release.
 * A create race is re-read and accepted only when the resulting object names the
 * exact requested tag. Existing releases are never deleted or rewritten. Creation
 * uses GitHub CLI's `--verify-tag`, which refuses to create a tag when the immutable
 * reference is absent instead of relying on the Releases API's tag auto-creation.
 *
 * @module tools/ensure-github-release
 */

import { execFileSync } from 'node:child_process'

import { validateReleaseTag, versionFromReleaseTag } from './release-version.mjs'

export { validateReleaseTag }

/** GitHub's default API origin when Actions does not override it. */
const DEFAULT_API_URL = 'https://api.github.com'

/**
 * Read one release object from GitHub.
 * @param options - API access and injected fetch.
 * @param options.apiUrl - GitHub API origin.
 * @param options.repository - owner/name repository.
 * @param options.tag - immutable release tag.
 * @param options.token - GitHub token.
 * @param options.fetchImpl - fetch implementation.
 * @returns whether the release is absent or an existing published release.
 */
export async function readGithubRelease({
  apiUrl = DEFAULT_API_URL,
  repository,
  tag,
  token,
  fetchImpl = fetch,
}) {
  validateReleaseTag(tag)
  if (typeof repository !== 'string' || !/^[^/]+\/[^/]+$/u.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must be owner/name')
  }
  if (typeof token !== 'string' || token === '') throw new Error('GH_TOKEN is required to create or inspect a GitHub Release')
  let response
  try {
    response = await fetchImpl(
      `${apiUrl.replace(/\/$/u, '')}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    )
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`GitHub Release lookup failed before a response: ${reason}`)
  }
  if (response.status === 404) return { kind: 'absent' }
  if (!response.ok) throw new Error(`GitHub Release lookup returned HTTP ${String(response.status)}`)
  let release
  try {
    release = await response.json()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`GitHub Release lookup returned invalid JSON: ${reason}`)
  }
  if (release === null || typeof release !== 'object' || release.tag_name !== tag) {
    throw new Error(`GitHub returned a Release that does not point at ${tag}`)
  }
  if (release.draft !== false) {
    throw new Error(`GitHub Release ${tag} does not have the required published state`)
  }
  versionFromReleaseTag(tag)
  const expectedPrerelease = false
  if (release.prerelease !== expectedPrerelease) {
    throw new Error(`GitHub Release ${tag} has the wrong prerelease state`)
  }
  return { kind: 'existing', release }
}

/**
 * Confirm the tag exists before asking GitHub to create a Release. The API would
 * otherwise create a new tag at its default target, which is forbidden here.
 * @param options - API access and injected fetch.
 * @param options.apiUrl - GitHub API origin.
 * @param options.repository - owner/name repository.
 * @param options.tag - immutable release tag.
 * @param options.token - GitHub token.
 * @param options.fetchImpl - fetch implementation.
 * @returns nothing when the exact tag reference exists.
 */
export async function requireGithubTag({
  apiUrl = DEFAULT_API_URL,
  repository,
  tag,
  token,
  fetchImpl = fetch,
}) {
  validateReleaseTag(tag)
  if (typeof repository !== 'string' || !/^[^/]+\/[^/]+$/u.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must be owner/name')
  }
  if (typeof token !== 'string' || token === '') throw new Error('GH_TOKEN is required to inspect a GitHub tag')
  let response
  try {
    response = await fetchImpl(
      `${apiUrl.replace(/\/$/u, '')}/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    )
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`GitHub tag lookup failed before a response: ${reason}`)
  }
  if (response.status === 404) throw new Error(`GitHub tag ${tag} does not exist; refusing to create it`)
  if (!response.ok) throw new Error(`GitHub tag lookup returned HTTP ${String(response.status)}`)
  let reference
  try {
    reference = await response.json()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`GitHub tag lookup returned invalid JSON: ${reason}`)
  }
  if (
    reference === null
    || typeof reference !== 'object'
    || reference.ref !== `refs/tags/${tag}`
    || reference.object === null
    || typeof reference.object !== 'object'
    || typeof reference.object.sha !== 'string'
    || !['commit', 'tag'].includes(reference.object.type)
  ) {
    throw new Error(`GitHub returned a tag reference that does not point at ${tag}`)
  }
  return reference
}

/**
 * Error for the one create response that may be caused by a concurrent creator.
 */
export class ReleaseCreateError extends Error {
  /**
   * @param kind - whether a second read can safely resolve the outcome.
   * @param message - safe diagnostic.
   */
  constructor(kind, message) {
    super(message)
    this.name = 'ReleaseCreateError'
    this.kind = kind
  }
}

/**
 * Create a release with the existing generated-notes and immutable-tag semantics.
 * @param options - release tag and GitHub token.
 * @param options.apiUrl - GitHub API origin.
 * @param options.repository - owner/name repository.
 * @param options.tag - immutable release tag.
 * @param options.token - GitHub token.
 * @param options.exec - command runner, injectable for tests.
 * @returns a placeholder release object after gh succeeds.
 * @throws {ReleaseCreateError} when gh reports a create race.
 */
export function createGithubRelease({
  apiUrl = DEFAULT_API_URL,
  repository,
  tag,
  token,
  exec = execFileSync,
}) {
  versionFromReleaseTag(tag)
  if (typeof repository !== 'string' || !/^[^/]+\/[^/]+$/u.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must be owner/name')
  }
  if (typeof token !== 'string' || token === '') throw new Error('GH_TOKEN is required to create a GitHub Release')
  const args = ['release', 'create', tag, '--repo', repository, '--generate-notes', '--verify-tag']
  const apiHost = new URL(apiUrl).hostname
  const env = { ...process.env, GH_TOKEN: token }
  if (apiHost !== 'api.github.com') env.GH_HOST = apiHost
  else delete env.GH_HOST
  try {
    exec('gh', args, {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const output = [error?.stdout, error?.stderr, error?.message]
      .filter(value => value !== undefined)
      .map(String)
      .join('\n')
    const duplicateRelease = /(?:\b409\b|\b422\b)[\s\S]*(?:already_exists[\s\S]*tag_name|tag_name[\s\S]*already_exists|release[\s\S]*already exists[\s\S]*tag|tag[\s\S]*already exists)/iu
    const mixedFatal = /\b(?:401|403|5\d\d)\b|authentication|permission denied|forbidden/iu.test(output)
    if (duplicateRelease.test(output) && !mixedFatal) {
      throw new ReleaseCreateError('conflict', 'GitHub Release creation raced another creator')
    }
    throw error
  }
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
  }
}

/**
 * Ensure one valid GitHub Release exists without rewriting an existing object.
 * @param options - tag, repository, token, API, and injectable operations.
 * @param options.apiUrl - GitHub API origin.
 * @param options.repository - owner/name repository.
 * @param options.tag - immutable release tag.
 * @param options.token - GitHub token.
 * @param options.fetchImpl - fetch implementation.
 * @param options.createRelease - release creator, injected for tests.
 * @param options.write - status logger.
 * @returns whether the object was reused or newly created.
 */
export async function ensureGithubRelease({
  apiUrl = process.env.GITHUB_API_URL ?? DEFAULT_API_URL,
  repository = process.env.GITHUB_REPOSITORY,
  tag = process.env.RELEASE_TAG,
  token = process.env.GH_TOKEN,
  fetchImpl = fetch,
  createRelease = createGithubRelease,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  readbackAttempts = 3,
  readbackDelayMs = 1000,
  write = text => process.stdout.write(text),
} = {}) {
  if (repository === undefined || tag === undefined || token === undefined) {
    throw new Error('GITHUB_REPOSITORY, RELEASE_TAG, and GH_TOKEN are required')
  }
  if (!Number.isSafeInteger(readbackAttempts) || readbackAttempts < 1 || !Number.isSafeInteger(readbackDelayMs) || readbackDelayMs < 0) {
    throw new Error('GitHub Release readback bounds are invalid')
  }
  const request = { apiUrl, repository, tag, token, fetchImpl }
  const readbackRelease = async () => {
    let result
    for (let attempt = 0; attempt < readbackAttempts; attempt += 1) {
      result = await readGithubRelease(request)
      if (result.kind === 'existing' || attempt + 1 === readbackAttempts) return result
      await sleep(readbackDelayMs)
    }
    return result
  }
  const tagReference = await requireGithubTag(request)
  const existing = await readGithubRelease(request)
  if (existing.kind === 'existing') {
    write(`ensure-github-release: ${tag} already has a valid GitHub Release; leaving it unchanged\n`)
    return { kind: 'existing', release: existing.release }
  }

  try {
    const beforeCreateTag = await requireGithubTag(request)
    if (
      beforeCreateTag.object.sha !== tagReference.object.sha
      || beforeCreateTag.object.type !== tagReference.object.type
    ) {
      throw new Error(`GitHub tag ${tag} changed during release creation; refusing to create a Release`)
    }
    const release = await createRelease(request)
    const expectedPrerelease = false
    if (
      release === null
      || typeof release !== 'object'
      || release.tag_name !== tag
      || release.draft === true
      || (release.prerelease !== undefined && release.prerelease !== expectedPrerelease)
    ) {
      throw new Error(`release creation did not return a valid ${tag} release`)
    }
    const afterCreateTag = await requireGithubTag(request)
    if (
      afterCreateTag.object.sha !== tagReference.object.sha
      || afterCreateTag.object.type !== tagReference.object.type
    ) {
      throw new Error(`GitHub tag ${tag} changed during Release creation; refusing to continue`)
    }
    const afterCreate = await readbackRelease()
    if (afterCreate.kind !== 'existing') {
      throw new Error(`GitHub did not return the created Release for ${tag}`)
    }
    write(`ensure-github-release: created the GitHub Release for ${tag}\n`)
    return { kind: 'created', release: afterCreate.release }
  } catch (createError) {
    // Only a documented create conflict is a race. Re-read and accept the result
    // only if GitHub now serves this exact tag; auth and other failures stay red.
    if (!(createError instanceof ReleaseCreateError) || createError.kind !== 'conflict') throw createError
    const afterRace = await readbackRelease()
    if (afterRace.kind === 'existing') {
      write(`ensure-github-release: ${tag} was created concurrently; leaving it unchanged\n`)
      return { kind: 'existing', release: afterRace.release }
    }
    throw createError
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  try {
    await ensureGithubRelease()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`ensure-github-release: ${message}\n`)
    process.exit(1)
  }
}

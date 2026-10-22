/** Verify a tag against protected main before executing any tagged-tree code. */
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { versionFromReleaseTag } from './release-version.mjs'

/**
 * Refuse mismatched tags and commits outside the reviewed main history.
 * @param tag - stable release tag supplied by the event.
 * @param commit - immutable event revision, including an annotated tag object.
 * @param cwd - checkout of trusted main with full history and tags.
 * @returns the verified peeled commit.
 */
export function checkReleaseSource(tag, commit, cwd = process.cwd()) {
  versionFromReleaseTag(tag)
  if (!/^[a-f\d]{40}$/iu.test(commit ?? '')) throw new Error('release event must name an immutable revision')
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  let tagged
  let event
  try {
    tagged = git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`])
    event = git(['rev-parse', '--verify', `${commit}^{commit}`])
  } catch {
    throw new Error('release tag and event revision must both resolve to commits')
  }
  if (tagged !== event) throw new Error('release tag does not match the immutable event revision')
  try {
    git(['merge-base', '--is-ancestor', event, 'refs/remotes/origin/main'])
  } catch {
    throw new Error('release commit is not in protected main history')
  }
  return event
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const commit = checkReleaseSource(process.env.RELEASE_TAG, process.env.RELEASE_COMMIT)
    process.stdout.write(`check-release-source: verified protected-main release ${commit}\n`)
  } catch (error) {
    process.stderr.write(`check-release-source: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

/**
 * Refuse to make a dshline release the default install while the default
 * Harness install is a different generation.
 *
 * This is a RELEASE-channel check, not a compatibility one, and the difference
 * is the whole point. Development correctness is settled by `HARNESS_TARGET`:
 * an exact upstream commit and the exact version cut from it, which every
 * `dsh-*` spec carries literally and which `.github/workflows/ci.yml` proves
 * from source. None of that reads a dist-tag, and none of it should — a
 * channel pointer moves without the architecture moving.
 *
 * A release is the one moment where a pointer someone else owns does decide
 * something. The documented install is two unqualified names:
 *
 * ```sh
 * npm install -g @deepseek-ai/dsh @dshline/dshline
 * ```
 *
 * Both resolve through npm's default `latest`, and `@deepseek-ai/dsh` pins the
 * whole `dsh-*` line to its own generation, so whatever version `latest`
 * serves IS the Harness generation an ordinary install ends up running. If
 * `@dshline/dshline@latest` advanced to a build adopting a different
 * generation, that one command would resolve a pair dshline does not support —
 * not because dshline regressed, but because the two defaults disagree.
 *
 * The answer is to wait, never to widen. dshline supports one generation, so
 * the comparison is exact string equality in both directions: a Harness
 * `latest` NEWER than the adopted target fails too, because "newer" is not
 * "supported" and the fix there is to migrate `HARNESS_TARGET` forward onto
 * the generation Harness actually promoted.
 *
 * `main` is free to run ahead of this the entire time. A red result means "do
 * not merge this release yet", never "main is broken".
 *
 * Exit codes are distinct on purpose, because the two failures need different
 * responses: `1` is a real mismatch that a human resolves by waiting or
 * migrating, `2` is an inability to establish the fact at all. Both fail
 * closed — a release must never proceed on an unanswered question — but only
 * one of them means anything is actually wrong with the release.
 *
 * ```text
 * 0  adopted == @deepseek-ai/dsh@latest
 * 1  they differ, in either direction
 * 2  npm could not be asked, or answered something that is not a version
 * ```
 * @module tools/check-release-harness
 */

import { execFileSync } from 'node:child_process'

import { LAUNCHER_PACKAGE, readTarget } from './harness-target.mjs'

/**
 * A version string npm can actually serve.
 *
 * Anchored and newline-free, so a multi-line or decorated answer is treated as
 * "could not establish" rather than silently compared. `npm view <pkg>@latest
 * version` prints one bare line for a tag that resolves to a single version;
 * anything else means the question was not answered the way this expects, and
 * guessing at that is how a release gate becomes a coin flip.
 */
const VERSION_SHAPE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

/**
 * Ask npm what its default dist-tag serves for the launcher.
 *
 * `npm view` rather than a hand-rolled packument fetch: resolving a dist-tag is
 * npm's own job, it already honours whatever registry and auth the environment
 * configures, and reimplementing it here would mean owning a second answer to
 * a question npm is authoritative for. One call, no retry — a release gate
 * that hammered the registry to turn a network failure into a pass would be
 * the opposite of failing closed.
 * @returns the raw stdout of the lookup.
 * @throws when npm exits non-zero, including an unreachable registry.
 */
function npmLatestVersion() {
  return execFileSync('npm', ['view', `${LAUNCHER_PACKAGE}@latest`, 'version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * What happened when the release question was asked.
 * @typedef {{ kind: 'ready', adopted: string, latest: string }
 *   | { kind: 'mismatch', adopted: string, latest: string }
 *   | { kind: 'unverifiable', adopted: string, reason: string }} ReleaseChannelStatus
 */

/**
 * Whether publishing this tree as the default dshline release would leave the
 * documented unqualified install resolving a coherent pair.
 *
 * Deliberately NOT a semver comparison. There is no "at least" here: dshline
 * carries no compatibility code for a neighbouring generation, so the only
 * relation that means anything is identity.
 * @param adopted - `HARNESS_TARGET.version`, the generation this tree is built against.
 * @param options - injectable registry lookup, for tests.
 * @param options.readLatest - returns npm's answer for the launcher's default tag.
 * @returns the channel verdict.
 */
export function releaseChannelStatus(adopted, { readLatest = npmLatestVersion } = {}) {
  let answer
  try {
    answer = readLatest()
  } catch (error) {
    return { kind: 'unverifiable', adopted, reason: error instanceof Error ? error.message : String(error) }
  }
  const latest = typeof answer === 'string' ? answer.trim() : ''
  if (!VERSION_SHAPE.test(latest)) {
    return {
      kind: 'unverifiable',
      adopted,
      reason: `npm answered ${JSON.stringify(latest)}, which is not a single version`,
    }
  }
  return { kind: latest === adopted ? 'ready' : 'mismatch', adopted, latest }
}

/**
 * The verdict as a maintainer needs to read it, and the exit code it earns.
 *
 * Both failures say plainly that this is about the release channel, because
 * the natural misreading — "dshline is broken against Harness" — would send
 * someone to write exactly the compatibility code this policy exists to
 * refuse.
 * @param result - the channel verdict.
 * @returns the report text and the process exit code.
 */
export function formatChannelStatus(result) {
  if (result.kind === 'ready') {
    return {
      code: 0,
      text: `check-release-harness: ${LAUNCHER_PACKAGE}@latest is ${result.latest}, matching the adopted Harness target.\n`
        + 'An unqualified install of both packages resolves one coherent generation.\n',
    }
  }
  if (result.kind === 'unverifiable') {
    return {
      code: 2,
      text: `Could not verify ${LAUNCHER_PACKAGE}@latest from npm.\n`
        + 'Release-channel coherence cannot be established, so this is not a mismatch —\n'
        + 'it is an unanswered question, and a release does not proceed on one. Retry\n'
        + `when the registry is reachable.\n\n  reason: ${result.reason}\n`,
    }
  }
  const labels = ['adopted Harness (HARNESS_TARGET):', `${LAUNCHER_PACKAGE}@latest:`]
  const column = Math.max(...labels.map(label => label.length))
  return {
    code: 1,
    text: 'dshline release is not ready.\n\n'
      + `  ${labels[0].padEnd(column)}  ${result.adopted}\n`
      + `  ${labels[1].padEnd(column)}  ${result.latest}\n\n`
      + 'This is a RELEASE-channel failure, not a source-compatibility one. Development\n'
      + 'against the adopted generation is unaffected and main is not broken: the whole\n'
      + 'point of adopting a generation early is that main may run ahead of the default\n'
      + 'Harness release.\n\n'
      + 'What it does mean is that publishing this as the default dshline release would\n'
      + 'make `npm install -g @deepseek-ai/dsh @dshline/dshline` resolve two packages\n'
      + 'built for different Harness generations.\n\n'
      + 'Resolve it one of two ways, and never by widening what dshline supports:\n'
      + `  - wait until ${LAUNCHER_PACKAGE}@latest is the adopted generation; or\n`
      + '  - migrate HARNESS_TARGET onto the generation Harness actually promoted.\n\n'
      + 'Do not widen a peer range, restore support for the previous generation, point\n'
      + 'this check at another dist-tag, or move dshline off `latest` to dodge it.\n',
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const target = await readTarget(process.env.RELEASE_ROOT)
  const { code, text } = formatChannelStatus(releaseChannelStatus(target.version))
  process[code === 0 ? 'stdout' : 'stderr'].write(text)
  process.exit(code)
}

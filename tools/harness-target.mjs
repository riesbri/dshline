/**
 * The adopted Harness generation, and everything that has to equal it.
 *
 * `HARNESS_TARGET` at the repository root names one upstream commit and the
 * one Harness version cut from it. dshline supports exactly that generation:
 * every `dsh-*` dependency, devDependency, and peerDependency carries that
 * version literally, so "are we coherent" is a string comparison rather than
 * a compatibility question.
 *
 * That is the whole design. An earlier draft of this module checked peer
 * RANGES, which meant reimplementing caret bounds, prerelease precedence, and
 * npm's rule that a prerelease is only eligible when a comparator on the same
 * major.minor.patch tuple is itself a prerelease — roughly 150 lines of
 * semver engine whose only purpose was to decide whether `^0.1.1-rc.2` still
 * admitted the version we had already written down two lines above. A caret
 * also silently promises later releases in the same range, which is a
 * compatibility claim nothing tests. Exact versions delete both problems: if
 * supporting one generation can be expressed with `===`, do not build a
 * version compatibility engine.
 *
 * Scope is the `dsh-*` line only ({@link HARNESS_LINE_SCOPE}). cordis and
 * `@deepseek-ai/schemastery` version on their own numbering, are not cut from
 * the Harness revision this file records, and keep ordinary caret ranges that
 * Dependabot watches.
 *
 * Usage:
 *   node tools/harness-target.mjs                    # is the repository coherent with the target?
 *   node tools/harness-target.mjs --revision         # print the adopted commit
 *   node tools/harness-target.mjs --version          # print the adopted version
 *   node tools/harness-target.mjs --pin              # rewrite dependency pins to the target version
 *   node tools/harness-target.mjs --published        # has npm published the target version yet?
 *   node tools/harness-target.mjs --verify-source .harness   # is that checkout the adopted generation?
 *
 * The no-flag run also fails while `HARNESS_COMPAT` records a temporary shim
 * confirmed against some other generation — see {@link parseCompat}.
 * @module tools/harness-target
 */

import { readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET_FILE = join(repoRoot, 'HARNESS_TARGET')
/**
 * The register of temporary workarounds for defects in the adopted generation.
 *
 * Separate from `HARNESS_TARGET` rather than folded into it: that file's format
 * is two `key value` lines precisely so a migration can edit it without
 * understanding a parser, and records carrying a path would erode that. Its
 * header points here instead, and this module is what makes the two coherent.
 */
const COMPAT_FILE = 'HARNESS_COMPAT'
/**
 * The same two manifests as path SEGMENTS, so a caller can resolve them
 * against a root other than this repository's. Only `pinTargetVersion` needs
 * that, and only so its tests can write into a throwaway tree instead of the
 * checkout they are running in.
 */
const MANIFEST_PATHS = [['packages', 'dshline', 'package.json'], ['package.json']]
const REGISTRY_HOST = 'https://registry.npmjs.org'
const HARNESS_NUMERIC = '(?:0|[1-9][0-9]*)'
const HARNESS_PRERELEASE = `(?:${HARNESS_NUMERIC}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`
const HARNESS_VERSION = new RegExp(
  `^${HARNESS_NUMERIC}\\.${HARNESS_NUMERIC}\\.${HARNESS_NUMERIC}(?:-${HARNESS_PRERELEASE}(?:\\.${HARNESS_PRERELEASE})*)?(?![\\s\\S])`,
  'u',
)

/**
 * The package a consumer installs, and therefore the one whose publication
 * decides whether the target is reachable.
 *
 * Exported because `tools/check-release-harness.mjs` asks a different question
 * of the same package — not "does this exact version exist" but "is this the
 * version an unqualified install resolves" — and the two must never disagree
 * about which package the launcher is.
 */
export const LAUNCHER_PACKAGE = '@deepseek-ai/dsh'

/**
 * Manifest fields `--pin` rewrites. `peerDependencies` is deliberately absent:
 * it is CHECKED against the target and never written, so changing what dshline
 * publicly promises stays a decision a human records rather than a side effect
 * of running a tool.
 */
const PINNED_FIELDS = ['dependencies', 'devDependencies']

/** Every field that must equal the target version, including the public promise. */
export const CHECKED_FIELDS = [...PINNED_FIELDS, 'peerDependencies']

/**
 * Matches the `dsh-*` line — the packages cut from the Harness revision this
 * module tracks. Narrower than a bare `@deepseek-ai/` prefix on purpose:
 * cordis and `@deepseek-ai/schemastery` share the scope but not the release
 * cadence, so pinning them to a Harness version would be wrong rather than
 * merely noisy.
 */
export const HARNESS_LINE_SCOPE = /^@deepseek-ai\/dsh-/

/**
 * The version field of the Harness workspace root, which is the package whose
 * version IS the release generation (`@deepseek-ai/dsh-root`). Verified to
 * track the generation across the line: `0.1.1-rc.2` at the rc.2 release
 * commit, `0.1.2-alpha.5` at the adopted revision.
 */
const HARNESS_ROOT_MANIFEST = 'package.json'

/**
 * The adopted Harness generation.
 * @typedef {object} HarnessTarget
 * @property {string} revision - the exact upstream release-generation commit, 40 lowercase hex characters.
 * @property {string} version - the exact Harness version cut from that revision.
 */

/**
 * Parse `HARNESS_TARGET`. The format is two `key value` lines and comments —
 * small enough to read at a glance and to hand to `grep`, which is the point:
 * a migration edits this file, and a format needing a parser to understand
 * would invite a second copy of the truth somewhere more convenient.
 * @param text - the file's contents.
 * @returns the adopted target.
 * @throws when a field is missing, duplicated, unknown, or malformed — never a partial target.
 */
export function parseTarget(text) {
  /** @type {Record<string, string>} */
  const fields = {}
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (line === '') continue
    const [key, value, ...rest] = line.split(/\s+/)
    if (value === undefined || rest.length > 0) throw new Error(`HARNESS_TARGET: expected "key value", got: ${line}`)
    if (key !== 'revision' && key !== 'version') throw new Error(`HARNESS_TARGET: unknown field: ${key}`)
    if (key in fields) throw new Error(`HARNESS_TARGET: ${key} declared twice`)
    fields[key] = value
  }
  for (const key of ['revision', 'version']) {
    if (!(key in fields)) throw new Error(`HARNESS_TARGET: missing ${key}`)
  }
  // A branch name or short sha would make the blocking lane follow whatever
  // that pointer means on the day it runs — precisely the property the
  // informational upstream lane owns and this one must not have.
  if (!/^[0-9a-f]{40}$/.test(fields.revision)) {
    throw new Error(`HARNESS_TARGET: revision must be a full 40-character commit sha, got: ${fields.revision}`)
  }
  // A shape check, not a semver engine: nothing here ever orders or compares
  // two versions, so this only rejects a typo that could never match a real
  // published version.
  if (!HARNESS_VERSION.test(fields.version)) {
    throw new Error(`HARNESS_TARGET: version must look like 1.2.3 or 1.2.3-tag.4, got: ${fields.version}`)
  }
  return { revision: fields.revision, version: fields.version }
}

/**
 * Read the adopted target from disk.
 * @param root - repository root whose target file should be read.
 * @returns the adopted target.
 */
export async function readTarget(root = repoRoot) {
  return parseTarget(await readFile(join(root, 'HARNESS_TARGET'), 'utf8'))
}

/**
 * Every `dsh-*` spec in one dependency map that is not literally the target
 * version.
 *
 * A caret counts as wrong even when it would accept the target: `^0.1.1-rc.2`
 * also promises later releases in the same range, and dshline promises one
 * generation. The same function backs both the check and `--pin`, so what the
 * checker demands and what the rewriter produces cannot drift apart.
 * @param dependencies - a manifest's dependency map.
 * @param version - the adopted target version.
 * @returns the sorted disagreements; empty when every entry already matches.
 */
export function targetUpdates(dependencies, version) {
  return Object.entries(dependencies)
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([name, current]) => HARNESS_LINE_SCOPE.test(name) && current !== version)
    .map(([name, current]) => ({ name, from: current, to: version }))
}

/**
 * The Harness release version a source checkout carries.
 *
 * `HARNESS_TARGET` records a commit and a version separately, and nothing
 * about the file itself stops those two lines from describing different
 * generations. That mistake would be invisible: the target lane would
 * typecheck against one generation's source while Core and the published lane
 * validated another, and both could pass. The Harness workspace root's own
 * manifest is the authority for which generation a commit belongs to.
 * @param manifest - the parsed root `package.json` of a Harness checkout.
 * @returns the release version it declares.
 * @throws when the manifest carries no version, which means the checkout is not what we think it is.
 */
export function sourceVersion(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.name !== '@deepseek-ai/dsh-root') {
    throw new Error(`harness checkout root manifest must be @deepseek-ai/dsh-root (found ${JSON.stringify(manifest?.name ?? null)})`)
  }
  const version = manifest.version
  if (typeof version !== 'string' || version === '') {
    throw new Error(`harness checkout root manifest declares no version (found ${JSON.stringify(manifest.name)})`)
  }
  return version
}

/**
 * Whether the registry carries an exact version of a package.
 *
 * Deliberately a `versions` lookup rather than a dist-tag read: which channel
 * upstream publishes a generation under (`next`, `alpha`, `rc`, …) is a
 * distribution detail that changes without dshline's architecture changing,
 * and a check keyed on the channel name would need redesigning every time it
 * moved. The exact version either exists or it does not.
 * @param name - the package name.
 * @param version - the exact version to look for.
 * @param fetchPackument - injected registry access, for tests.
 * @returns whether npm serves that version today.
 */
export async function isPublished(name, version, fetchPackument = defaultFetchPackument) {
  const packument = await fetchPackument(name)
  if (packument === null || typeof packument !== 'object' || Array.isArray(packument)) {
    throw new Error(`registry returned an invalid packument for ${name}`)
  }
  if (packument.versions === null || typeof packument.versions !== 'object' || Array.isArray(packument.versions)) {
    throw new Error(`registry returned an invalid versions map for ${name}`)
  }
  return Object.hasOwn(packument.versions, version)
}

/**
 * Read a packument from the public registry.
 * @param name - the package name.
 * @returns the decoded packument document.
 */
async function defaultFetchPackument(name) {
  const response = await fetch(`${REGISTRY_HOST}/${encodeURIComponent(name)}`)
  if (!response.ok) throw new Error(`registry returned ${String(response.status)} for ${name}`)
  return response.json()
}

/**
 * Rewrite every governed `dsh-*` spec in both manifests to one exact version.
 *
 * The single implementation of "what the governed line is and how it is
 * written down", shared by two callers with deliberately different reach.
 * `--pin` passes {@link PINNED_FIELDS} and therefore never touches
 * `peerDependencies`: a peer range is the public compatibility promise, and a
 * tool that rewrote it as a side effect of refreshing dependencies would turn
 * a decision into a formatting pass.
 *
 * `tools/harness-sync.mjs` passes {@link CHECKED_FIELDS}, peers included,
 * because adopting a generation IS that decision — it is the one operation
 * whose whole purpose is to move the promise, and it does so under review in a
 * pull request nobody merges without CI. Sharing this function rather than
 * copying the loop is what keeps one answer to which packages are governed.
 * @param version - the exact version to write.
 * @param fields - manifest fields to rewrite; defaults to the dependency fields only.
 * @param root - repository root the manifests are resolved against; overridden by tests.
 * @returns one human-readable line per rewritten spec, in manifest order.
 */
export async function pinTargetVersion(version, fields = PINNED_FIELDS, root = repoRoot) {
  const applied = []
  for (const relative of MANIFEST_PATHS) {
    const manifestPath = join(root, ...relative)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    let changed = false
    for (const field of fields) {
      const dependencies = manifest[field]
      if (dependencies === undefined) continue
      const updates = targetUpdates(dependencies, version)
      if (updates.length === 0) continue
      for (const update of updates) dependencies[update.name] = update.to
      manifest[field] = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)))
      for (const update of updates) {
        applied.push(`${relative.join('/')} (${field}): ${update.name} ${update.from} -> ${update.to}`)
      }
      changed = true
    }
    if (changed) await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  return applied
}

/**
 * One temporary workaround for a defect in the adopted Harness generation.
 * @typedef {object} CompatShim
 * @property {string} path - the shim's own module, repository-relative.
 * @property {string} confirmed - the generation it was last confirmed to still be needed against.
 */

/**
 * Parse `HARNESS_COMPAT`.
 *
 * `shim <path> <version>` records and comments, in the same read-at-a-glance
 * spirit as `HARNESS_TARGET`. No description field: the shim's own module
 * header is where the behavior and the removal condition are written down, and
 * a second copy here would be the one that goes stale.
 * @param text - the file's contents.
 * @returns the recorded shims, in file order.
 * @throws when a record is malformed or names a path twice — never a partial register.
 */
export function parseCompat(text) {
  /** @type {CompatShim[]} */
  const shims = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (line === '') continue
    const [key, path, confirmed, ...rest] = line.split(/\s+/)
    if (key !== 'shim') throw new Error(`${COMPAT_FILE}: unknown field: ${key}`)
    if (path === undefined || confirmed === undefined || rest.length > 0) {
      throw new Error(`${COMPAT_FILE}: expected "shim <path> <version>", got: ${line}`)
    }
    if (!HARNESS_VERSION.test(confirmed)) {
      throw new Error(`${COMPAT_FILE}: ${path} confirmed against something that is not a version: ${confirmed}`)
    }
    if (shims.some(shim => shim.path === path)) throw new Error(`${COMPAT_FILE}: ${path} recorded twice`)
    shims.push({ path, confirmed })
  }
  return shims
}

/**
 * Read the register, treating its absence as an empty one.
 *
 * Absence is not an error: a released tag predating this file is checked with
 * `RELEASE_ROOT` pointing at it, and a repository carrying no workarounds is
 * the state this register exists to return to.
 * @param root - repository root whose register should be read.
 * @returns the recorded shims, or none.
 */
export async function readCompat(root = repoRoot) {
  try {
    return parseCompat(await readFile(join(root, COMPAT_FILE), 'utf8'))
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

/**
 * Every recorded shim that the adopted generation has not been reconciled with.
 *
 * Two ways a record can be wrong, and both are worth failing on. A shim
 * confirmed against another generation means a migration moved the target
 * without deciding what to do about the workaround — which is the whole reason
 * the register exists. A record whose module is gone means the workaround was
 * deleted and its entry was not, so the next migration would be asked to
 * reconfirm a file nobody can read.
 * @param target - the adopted target.
 * @param shims - the recorded shims.
 * @param root - repository root the paths resolve against.
 * @returns one entry per unreconciled record; empty when the register agrees with the target.
 */
export async function compatProblems(target, shims, root = repoRoot) {
  const problems = []
  for (const shim of shims) {
    const present = await stat(join(root, shim.path)).then(() => true, () => false)
    if (!present) problems.push({ ...shim, reason: 'missing' })
    else if (shim.confirmed !== target.version) problems.push({ ...shim, reason: 'unconfirmed' })
  }
  return problems
}

/**
 * Render the coherence report.
 * @param target - the adopted target.
 * @param problems - `{ manifest, field, name, from }` entries whose spec is not the target version.
 * @param shims - `{ path, confirmed, reason }` entries from {@link compatProblems}.
 * @returns the report text, ending in a newline.
 */
export function formatReport(target, problems, shims = []) {
  const lines = [`Harness target ${target.version} @ ${target.revision.slice(0, 8)}`]
  if (problems.length === 0) {
    lines.push(`✓ every dsh-* dependency, devDependency, and peerDependency is exactly ${target.version}`)
  } else {
    lines.push(`✗ ${String(problems.length)} dsh-* spec${problems.length === 1 ? '' : 's'} not exactly ${target.version}:`)
    for (const problem of problems) {
      lines.push(`  ${problem.manifest} (${problem.field}): ${problem.name} ${problem.from}`)
    }
    lines.push('run `node tools/harness-target.mjs --pin && pnpm install` for dependencies.')
    if (problems.some(problem => problem.field === 'peerDependencies')) {
      lines.push('peerDependencies are never rewritten by a tool: a peer range is the public')
      lines.push('compatibility promise, and one generation means one exact version, not a range.')
    }
  }
  if (shims.length === 0) {
    return [...lines, ''].join('\n')
  }
  // Named as a decision rather than as a failure: the tool cannot tell whether
  // the workaround is still needed, and guessing would be worse than stopping.
  lines.push(`✗ ${String(shims.length)} temporary shim${shims.length === 1 ? '' : 's'} in ${COMPAT_FILE} not reconciled with ${target.version}:`)
  for (const shim of shims) {
    lines.push(shim.reason === 'missing'
      ? `  ${shim.path} is recorded but does not exist — delete the record`
      : `  ${shim.path} last confirmed against ${shim.confirmed}`)
  }
  lines.push(`read each module's header, then either delete the shim with its wiring,`)
  lines.push(`its tests and its ${COMPAT_FILE} record, or bump the record to ${target.version}`)
  lines.push('to state deliberately that this generation still needs it.')
  return [...lines, ''].join('\n')
}

/**
 * Collect every checked spec that is not literally the target version.
 * @param target - the adopted target.
 * @param root - repository root whose manifests should be checked.
 * @returns one entry per disagreeing spec, with the manifest and field it came from.
 */
async function collectProblems(target, root = repoRoot) {
  const problems = []
  for (const relative of MANIFEST_PATHS) {
    const manifestPath = join(root, ...relative)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    for (const field of CHECKED_FIELDS) {
      for (const update of targetUpdates(manifest[field] ?? {}, target.version)) {
        problems.push({ manifest: relative.join('/'), field, name: update.name, from: update.from })
      }
    }
  }
  return problems
}

// Entry point: vitest imports the pure functions above, so the side-effecting
// CLI runs only when this file is executed directly.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [flag, argument, ...rest] = process.argv.slice(2)
  const usage = 'usage: node tools/harness-target.mjs [--revision | --version | --pin | --published | --verify-source <dir>]\n'
  if (rest.length > 0 || (argument !== undefined && flag !== '--verify-source')) {
    process.stderr.write(usage)
    process.exit(2)
  }
  const targetRoot = process.env.RELEASE_ROOT ?? repoRoot
  const target = await readTarget(targetRoot)

  if (flag === '--revision') {
    process.stdout.write(`${target.revision}\n`)
  } else if (flag === '--version') {
    process.stdout.write(`${target.version}\n`)
  } else if (flag === '--published') {
    // A fact, not a verdict: npm lagging the adopted source revision is
    // expected and is reported as such. The caller decides what it means.
    const published = await isPublished(LAUNCHER_PACKAGE, target.version)
    process.stdout.write(`published=${published ? 'true' : 'false'}\n`)
  } else if (flag === '--verify-source') {
    if (argument === undefined) {
      process.stderr.write(usage)
      process.exit(2)
    }
    const manifestPath = join(resolve(argument), HARNESS_ROOT_MANIFEST)
    const found = sourceVersion(JSON.parse(await readFile(manifestPath, 'utf8')))
    if (found !== target.version) {
      process.stderr.write(
        `HARNESS_TARGET is incoherent: revision ${target.revision} is Harness ${found}, `
        + `but version records ${target.version}.\n`
        + 'The two lines must describe one release generation. Fix whichever is wrong —\n'
        + 'a source lane and an npm lane validating different generations would both pass.\n',
      )
      process.exit(1)
    }
    process.stdout.write(`${target.revision.slice(0, 8)} is Harness ${found}, matching HARNESS_TARGET\n`)
  } else if (flag === '--pin') {
    const applied = await pinTargetVersion(target.version)
    for (const line of applied) process.stdout.write(`${line}\n`)
    process.stdout.write(applied.length === 0
      ? `dependencies already pinned to ${target.version}\n`
      : `pinned ${String(applied.length)} package(s) to ${target.version}; run \`pnpm install\` to refresh the lockfile\n`)
  } else if (flag === undefined) {
    const problems = await collectProblems(target, targetRoot)
    // The same run, because they are the same question asked of two files: is
    // this repository coherent with the generation it says it adopts. A
    // migration that bumps the target sees both answers at once.
    const shims = await compatProblems(target, await readCompat(targetRoot), targetRoot)
    process.stdout.write(formatReport(target, problems, shims))
    process.exit(problems.length + shims.length > 0 ? 1 : 0)
  } else {
    process.stderr.write(`unknown flag: ${flag}\n${usage}`)
    process.exit(2)
  }
}

/**
 * Propose the next adopted Harness generation, and nothing else.
 *
 * dshline adopts RELEASE GENERATIONS, not commits. Upstream marks each one the
 * same way every time — a published GitHub Release whose tag is `dsh-v<version>`
 * — and every revision this repository has ever adopted is exactly the commit
 * one of those tags names. That convention is the only upstream signal this
 * module reads. It deliberately does not read `master`, `latest`, `next`,
 * `alpha`, or any other channel: a branch head is not an adoption unit, and a
 * dist-tag is a distribution pointer whose movement says nothing about whether
 * a coherent generation exists. The alpha.5 episode is the whole argument —
 * npm's `alpha` moved most of a day before the release and tag appeared, and
 * only the latter is something `HARNESS_TARGET` can record.
 *
 * What this module does NOT do is decide whether dshline works against the
 * candidate. It cannot, and it must not try: the repository already owns that
 * answer in `.github/workflows/ci.yml`, where `Harness target` checks the
 * revision out from source, links it, typechecks, and runs the capability
 * probes. Building a second opinion here would mean two compatibility
 * architectures disagreeing at 3am. So the output is a mechanical adoption
 * candidate; the existing pull-request checks are the verdict.
 *
 * ```text
 * harness-sync   is there a newer authoritative generation to propose?
 * ci             does dshline actually work against it?
 * ```
 *
 * Every external read is injectable, so the tests never touch the network.
 * @module tools/harness-sync
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CHECKED_FIELDS, HARNESS_LINE_SCOPE, pinTargetVersion, readManifests, readTarget } from './harness-target.mjs'

/** Repository root, resolved from this file rather than the caller's cwd. */
const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')

/** The upstream repository whose releases define an adoption unit. */
export const HARNESS_REPO = 'deepseek-ai/deepseek-harness'

/**
 * Upstream's release-tag convention, and the only shape treated as a
 * generation. Anchored: a tag that merely contains `dsh-v` somewhere is not
 * this convention, and guessing at one would be how an arbitrary tag becomes
 * an adoption candidate.
 */
export const RELEASE_TAG = /^dsh-v(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u

/**
 * What one sync pass concluded.
 * @typedef {{ kind: 'current', version: string }
 *   | { kind: 'candidate', version: string, revision: string, tag: string, from: { version: string, revision: string } }
 *   | { kind: 'none', reason: string }
 *   | { kind: 'blocked', reason: string }} SyncOutcome
 */

/**
 * The newest release whose tag follows the convention.
 *
 * Draft releases are skipped because they are not published facts — a draft is
 * editable and can vanish. Prereleases are NOT skipped: the entire `0.1.2`
 * line is prereleases, and refusing them would mean never adopting anything.
 * Ordering is `published_at` rather than semver: the question is which
 * generation upstream most recently declared, and inventing a version-ordering
 * opinion here would let this module disagree with upstream about what "newest"
 * means.
 * @param releases - GitHub release objects, in any order.
 * @returns the newest conventional release, or undefined when none qualifies.
 */
export function newestRelease(releases) {
  return releases
    .filter(release => release?.draft !== true
      && typeof release?.tag_name === 'string'
      && RELEASE_TAG.test(release.tag_name)
      && typeof release.published_at === 'string')
    .sort((left, right) => right.published_at.localeCompare(left.published_at))[0]
}

/**
 * The version a conventional release tag encodes.
 * @param tag - the release tag name.
 * @returns the version, or undefined when the tag is not the convention.
 */
export function versionOfTag(tag) {
  return RELEASE_TAG.exec(tag)?.groups?.version
}

/**
 * Decide what this pass should do, from injected upstream reads.
 *
 * Each verification exists because skipping it would let something that is not
 * a generation become one:
 *
 * - the tag must dereference to a COMMIT. An annotated tag is a tag object
 *   that points at the commit, so a caller reading `object.sha` blindly would
 *   record the tag object's own hash — a sha that exists, checks out as
 *   nothing, and fails only later inside CI.
 * - `target_commitish` is deliberately never used. It is usually the literal
 *   string `master`, which is a branch name, not the immutable revision the
 *   release was cut from.
 * - the candidate's own root manifest must declare exactly the version its tag
 *   encodes, the same coherence `harness-target.mjs --verify-source` proves in
 *   CI. A tag and a tree that disagree are not one generation.
 * - the currently adopted revision must be an ANCESTOR of the candidate. Git
 *   ancestry, not version ordering: a rewritten, reverted, or parallel release
 *   history is exactly the case where semver would happily walk dshline
 *   sideways, so an unprovable relationship fails closed for a human to read.
 * @param options - the injected upstream reads.
 * @param options.target - the currently adopted target.
 * @param options.listReleases - returns the upstream repository's releases.
 * @param options.resolveTag - returns `{ type, sha }` for a tag ref.
 * @param options.dereferenceTag - returns the commit sha an annotated tag object points at.
 * @param options.rootVersion - returns the root manifest version at one commit.
 * @param options.compare - returns the ancestry status of base vs head.
 * @returns what the pass concluded.
 */
export async function resolveCandidate({
  target,
  listReleases,
  resolveTag,
  dereferenceTag,
  rootVersion,
  compare,
}) {
  const release = newestRelease(await listReleases())
  if (release === undefined) {
    return { kind: 'none', reason: `no published ${HARNESS_REPO} release matches the dsh-v<version> convention` }
  }
  const tag = release.tag_name
  const version = versionOfTag(tag)

  const ref = await resolveTag(tag)
  let revision = ref?.sha
  if (ref?.type === 'tag') revision = await dereferenceTag(ref.sha)
  if (typeof revision !== 'string' || !/^[0-9a-f]{40}$/u.test(revision)) {
    return { kind: 'blocked', reason: `${tag} does not resolve to a commit sha` }
  }

  // A generation is a version AND the revision it was cut from, so identity
  // needs both. Matching only the revision would call it current whenever the
  // newest release tag happens to name the adopted commit under a DIFFERENT
  // version — an upstream state that is malformed rather than settled, and one
  // that would then pass silently forever, because the no-op returns before
  // the coherence read below could notice.
  if (revision === target.revision) {
    if (version === target.version) return { kind: 'current', version: target.version }
    return {
      kind: 'blocked',
      reason: `${tag} names ${revision.slice(0, 8)}, which is the already-adopted revision, but under version `
        + `${version} rather than the adopted ${target.version}; one revision cannot be two generations, `
        + 'so a human should inspect upstream before this is adopted',
    }
  }

  const declared = await rootVersion(revision)
  if (declared !== version) {
    return {
      kind: 'blocked',
      reason: `${tag} names ${revision.slice(0, 8)}, whose root manifest declares ${String(declared)} rather than ${version}`,
    }
  }

  // Ancestry, proven upstream rather than inferred from the numbers.
  const status = await compare(target.revision, revision)
  if (status !== 'ahead') {
    return {
      kind: 'blocked',
      reason: `${revision.slice(0, 8)} is "${String(status)}" relative to the adopted ${target.revision.slice(0, 8)}, `
        + 'not a forward release history; a human should inspect before adopting',
    }
  }

  return { kind: 'candidate', version, revision, tag, from: { version: target.version, revision: target.revision } }
}

/**
 * The changeset a candidate adoption carries.
 *
 * Deliberately one sentence. The interesting prose belongs to whoever performs
 * a migration, if CI turns out to need one; a machine announcing an
 * architecture it did not analyse would be inventing content.
 * @param version - the candidate version.
 * @returns the changeset filename and body.
 */
export function changesetFor(version) {
  return {
    // Normalized so the name is filesystem- and Changesets-safe, and stable:
    // re-running a pass for the same candidate rewrites one file rather than
    // accumulating a new one per run.
    name: `harness-${version.replace(/[^0-9A-Za-z]+/gu, '-')}.md`,
    body: `---\n'@dshline/dshline': minor\n---\n\nAdopt DeepSeek Harness \`${version}\`.\n`,
  }
}

/**
 * The Harness workspace package directory names that exist at one revision.
 *
 * Read from the upstream GIT TREE, never from the registry, and that choice is
 * the whole reason this function exists. `ERR_PNPM_NO_MATCHING_VERSION` means
 * two opposite things — upstream has not finished publishing, or upstream
 * RETIRED the package — and they are indistinguishable from the install log.
 * Asking the registry would reproduce the ambiguity, and resolving it by
 * assuming "not published yet" would delete a dependency out from under a
 * breaking change. The tree at the commit the release was cut from is a fact
 * instead of a timing: the package is in that commit or it is not.
 *
 * Upstream names a package directory after its unscoped package name —
 * `@deepseek-ai/dsh-invariants` lives in `packages/runtime-diagnostics/invariants`.
 * That convention is what makes one recursive tree read sufficient instead of a
 * manifest fetch per package, and it was checked rather than assumed: all 51
 * governed `dsh-*` specs resolve through it at the adopted revision.
 * @param tree - a GitHub git-tree response for the candidate revision.
 * @returns each workspace directory name mapped to its `package.json` path, so
 *   a caller can read a directory's declared name without scanning the tree
 *   again.
 * @throws when the tree is truncated, carries no entries, or names no
 *   workspace packages. Each is an absence of evidence rather than evidence of
 *   absence, and reading one as "every governed package was retired" would
 *   delete the whole Harness line.
 */
export function packageDirsFromTree(tree) {
  if (tree?.truncated === true) {
    throw new Error('the harness tree came back truncated; an absent package cannot be told from an omitted subtree')
  }
  // An API error shape, a permission failure, or a relaid-out upstream all
  // arrive here with no `tree` array. Falling through to an empty set is what
  // would make every governed spec look retired.
  if (!Array.isArray(tree?.tree)) {
    throw new Error('the harness tree response carried no entries; an absent package cannot be told from an unread response')
  }
  const dirs = new Map()
  for (const entry of tree.tree) {
    const match = /^packages\/[^/]+\/(?<name>[^/]+)\/package\.json$/u.exec(entry?.path ?? '')
    if (match !== null && match.groups !== undefined) dirs.set(match.groups.name, entry.path)
  }
  // The most destructive outcome this module has: an empty set makes
  // `retiredSpecs` report EVERY governed package as retired, and
  // `applyCandidate` would then remove the entire Harness line while still
  // printing "Adoption proposed". The Harness repository always carries
  // hundreds of workspaces, so a listing this empty is never a fact about
  // upstream.
  if (dirs.size === 0) {
    throw new Error('the harness tree named no workspace packages; refusing to read every governed spec as retired')
  }
  return dirs
}

/**
 * The npm names the candidate declares in directories the adopted revision did
 * not have.
 *
 * A directory basename is not an npm identity. Upstream names a package's
 * directory after its unscoped name, but nothing enforces that, so a release
 * that MOVES a package to a differently-named directory while keeping its npm
 * name would read as a retirement — and this module deletes what it reports
 * retired. The directories the adopted revision did not have are the only place
 * a move can hide, and there are only ever a handful of them, so reading their
 * manifests is a bounded way to establish identity rather than infer it.
 *
 * Deliberately not a registry read: absence from npm means either "retired" or
 * "not published yet", and the second resolves itself, so a heuristic there
 * would delete a live dependency during an ordinary publication lag.
 * @param adopted - the adopted revision's directory names.
 * @param candidate - the candidate revision's directory names, mapped to paths.
 * @param readName - reads the package name a manifest path declares.
 * @param revision - the candidate revision the manifests are read at.
 * @returns the declared names, as a set.
 * @throws when a moved directory's manifest cannot be read or declares no name.
 *   Failing closed here leaves the adoption to a human rather than deleting a
 *   dependency on an unread answer.
 */
export async function movedNames(adopted, candidate, readName, revision) {
  const names = new Set()
  for (const [basename, path] of candidate) {
    if (adopted.has(basename)) continue
    const declared = await readName(path, revision)
    if (typeof declared !== 'string' || declared === '') {
      throw new Error(`the candidate manifest at ${path} declares no package name; refusing to infer a retirement from it`)
    }
    names.add(declared)
  }
  return names
}

/**
 * The governed specs a candidate generation no longer publishes.
 *
 * Scoped to the governed line on purpose: cordis and schemastery are not cut
 * from the Harness revision and are never retired by it, so a bare
 * `@deepseek-ai/` test would let this delete packages that must keep their
 * ordinary caret ranges.
 *
 * A name is retired only when the candidate has no directory named for it AND
 * no directory it gained declares it — see {@link movedNames}. Both halves are
 * required: the first alone is the basename inference that would read a move as
 * a deletion.
 * @param governed - the governed `dsh-*` names the repository declares.
 * @param dirs - the candidate revision's directory names.
 * @param declared - npm names the candidate declares in directories it gained.
 * @returns the governed names with no directory at that revision, sorted.
 */
export function retiredSpecs(governed, dirs, declared = new Set()) {
  return governed
    .filter(name => HARNESS_LINE_SCOPE.test(name)
      && !dirs.has(name.replace(/^@deepseek-ai\/dsh-/u, ''))
      && !declared.has(name))
    .sort()
}

/**
 * Every governed spec the repository currently declares, across both manifests.
 *
 * Deduplicated across manifests and fields: a package listed in one manifest's
 * dependencies and another's peerDependencies is one retirement, and removing
 * it twice would be reported twice.
 * @param root - repository root; overridden by tests.
 * @returns the sorted governed names.
 */
export async function governedSpecs(root = repoRoot) {
  const names = new Set()
  for (const { manifest } of await readManifests(root)) {
    for (const field of CHECKED_FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (HARNESS_LINE_SCOPE.test(name)) names.add(name)
      }
    }
  }
  return [...names].sort()
}

/**
 * Delete named specs from both manifests, peers included.
 *
 * Peers deliberately included, unlike `harness-target.mjs --pin`: a peer range
 * is the public compatibility promise, and a promise naming a package the
 * generation deleted is worse than no promise at all. `applyCandidate` is
 * already the operation that moves that promise, so it is the one place a
 * retired package may leave it.
 *
 * Removal happens BEFORE {@link pinTargetVersion} runs, so the pinner never
 * sees a retired spec and cannot write a version that does not exist.
 * @param names - the retired package names to remove.
 * @param root - repository root; overridden by tests.
 * @returns one human-readable line per removed spec, in manifest order.
 */
export async function removeRetired(names, root = repoRoot) {
  const applied = []
  if (names.length === 0) return applied
  const retiring = new Set(names)
  for (const { relative, manifest } of await readManifests(root)) {
    let changed = false
    for (const field of CHECKED_FIELDS) {
      const dependencies = manifest[field]
      if (dependencies === undefined) continue
      const removed = Object.keys(dependencies).filter(name => retiring.has(name))
      if (removed.length === 0) continue
      for (const name of removed) {
        delete dependencies[name]
        applied.push(`${relative.join('/')} (${field}): removed retired ${name}`)
      }
      changed = true
    }
    if (changed) await writeFile(join(root, ...relative), `${JSON.stringify(manifest, null, 2)}\n`)
  }
  return applied
}

/**
 * Write the candidate into the working tree, and nothing beyond it.
 *
 * Three mechanical edits: the two lines of `HARNESS_TARGET`, every governed
 * `dsh-*` spec, and one changeset. The lockfile is deliberately NOT written
 * here — pnpm owns that, and the workflow refreshes it through the ordinary
 * install path so the repository's own supply-chain policies (release age,
 * trust downgrade) get their say rather than being bypassed by a tool that
 * edited YAML directly.
 *
 * `retired` is the one edit that is a deletion rather than a rewrite. A
 * generation that retires a governed package cannot be adopted by pinning it
 * to a version the registry does not serve, so without this the proposer has
 * no move at all: it would pin the dead name, the installer would refuse
 * forever, and a human would have to hand-write the whole adoption. Removing it
 * here instead leaves an openable pull request that is red for the RIGHT
 * reason — the compatibility and HARNESS_COMPAT decision — with the removal
 * visible in its own diff for review.
 *
 * Peers are included, unlike `harness-target.mjs --pin`. Adopting a generation
 * is precisely the decision that moves the public compatibility promise, so it
 * moves here and nowhere else — see {@link pinTargetVersion}.
 * @param candidate - the resolved candidate.
 * @param root - repository root, for tests.
 * @param options.retired - governed specs the candidate generation no longer
 *   publishes, removed before anything is pinned.
 * @returns the changeset path, one line per removed spec, and one per rewritten spec.
 */
export async function applyCandidate(candidate, root = repoRoot, { retired = [] } = {}) {
  const targetPath = join(root, 'HARNESS_TARGET')
  const before = await readFile(targetPath, 'utf8')
  const after = before
    .replace(/^revision .*$/mu, `revision ${candidate.revision}`)
    .replace(/^version .*$/mu, `version ${candidate.version}`)
  if (after === before) throw new Error('HARNESS_TARGET did not change; refusing to propose an empty adoption')
  await writeFile(targetPath, after)

  const removed = await removeRetired(retired, root)
  const pinned = await pinTargetVersion(candidate.version, CHECKED_FIELDS, root)

  const changeset = changesetFor(candidate.version)
  const changesetPath = join(root, '.changeset', changeset.name)
  await writeFile(changesetPath, changeset.body)

  return { changesetPath, pinned, removed }
}

/**
 * The pull-request body for a candidate.
 * @param candidate - the resolved candidate.
 * @param retired - governed specs the candidate generation no longer publishes.
 * @returns the markdown body.
 */
export function pullRequestBody(candidate, retired = []) {
  return [
    `Adopt DeepSeek Harness \`${candidate.version}\`.`,
    '',
    '| | version | revision |',
    '|---|---|---|',
    `| adopted | \`${candidate.from.version}\` | \`${candidate.from.revision}\` |`,
    `| candidate | \`${candidate.version}\` | \`${candidate.revision}\` |`,
    '',
    `Upstream release [\`${candidate.tag}\`](https://github.com/${HARNESS_REPO}/releases/tag/${candidate.tag}) `
      + `· [compare](https://github.com/${HARNESS_REPO}/compare/${candidate.from.revision}...${candidate.revision})`,
    '',
    'This pull request contains only mechanical adoption state: `HARNESS_TARGET`,',
    'the governed `@deepseek-ai/dsh-*` pins, the lockfile, and a changeset. No',
    'source was read and no compatibility was assessed to produce it.',
    ...(retired.length === 0 ? [] : [
      '',
      `> **This generation retires ${String(retired.length)} package(s) this repository governs:**`,
      ...retired.map(name => `> - \`${name}\``),
      '>',
      '> They were removed from the manifests rather than pinned, because the',
      '> registry does not serve them at this version. If anything here still',
      '> imports one, `Harness target` will say so — that is a migration, and',
      '> the fix is to stop using it, not to reintroduce the pin.',
    ]),
    '',
    'Existing CI decides whether this generation is directly compatible.',
    'If Harness-facing source changes are required, do not add compatibility;',
    'migrate forward against this generation.',
  ].join('\n')
}

/**
 * A one-line summary for the workflow log and job summary.
 * @param outcome - what the pass concluded.
 * @returns the summary text.
 */
export function summarize(outcome) {
  if (outcome.kind === 'current') return `Harness target is current (${outcome.version}).`
  if (outcome.kind === 'candidate') {
    return `Harness ${outcome.version} (${outcome.tag} @ ${outcome.revision.slice(0, 8)}) supersedes the adopted ${outcome.from.version}.`
  }
  if (outcome.kind === 'blocked') return `Harness sync stopped: ${outcome.reason}`
  return `No candidate: ${outcome.reason}`
}

/**
 * GitHub reads through the CLI already available in Actions.
 *
 * `gh api` rather than a bespoke fetch client: it carries the job's token,
 * honours the API version, and is already how every other workflow in this
 * repository talks to GitHub. Nothing here writes.
 * @param path - the API path.
 * @param jq - optional jq filter.
 * @returns the parsed JSON response, or the filtered string.
 */
async function githubApi(path, jq) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const args = ['api', path, ...jq === undefined ? [] : ['--jq', jq]]
  const { stdout } = await promisify(execFile)('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return jq === undefined ? JSON.parse(stdout) : stdout.trim()
}

/** The live upstream reads, wired to `gh api`. */
export const liveReads = {
  listReleases: () => githubApi(`repos/${HARNESS_REPO}/releases?per_page=100`),
  resolveTag: async (tag) => {
    const ref = await githubApi(`repos/${HARNESS_REPO}/git/ref/tags/${tag}`)
    return { type: ref.object.type, sha: ref.object.sha }
  },
  dereferenceTag: async (sha) => (await githubApi(`repos/${HARNESS_REPO}/git/tags/${sha}`)).object.sha,
  rootVersion: async (revision) => {
    const content = await githubApi(`repos/${HARNESS_REPO}/contents/package.json?ref=${revision}`, '.content')
    return JSON.parse(Buffer.from(content, 'base64').toString('utf8')).version
  },
  compare: async (base, head) => githubApi(`repos/${HARNESS_REPO}/compare/${base}...${head}`, '.status'),
  workspaceDirs: async revision => packageDirsFromTree(
    await githubApi(`repos/${HARNESS_REPO}/git/trees/${revision}?recursive=1`),
  ),
  // One `contents` read per directory the candidate GAINED, never a scan of the
  // tree: see `movedNames` for why a basename is not an npm identity.
  manifestName: async (path, revision) => {
    const content = await githubApi(`repos/${HARNESS_REPO}/contents/${path}?ref=${revision}`, '.content')
    return JSON.parse(Buffer.from(content, 'base64').toString('utf8')).name
  },
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  // `--apply` is a separate invocation on purpose: the workflow establishes the
  // candidate's identity first, with read-only credentials and no package graph
  // installed, and only then writes anything.
  if (process.argv[2] === '--apply') {
    const [version, revision, tag] = process.argv.slice(3)
    if (version === undefined || revision === undefined) {
      process.stderr.write('usage: node tools/harness-sync.mjs --apply <version> <revision> [tag]\n')
      process.exit(2)
    }
    const target = await readTarget()
    // Read the candidate's tree before writing anything: a retirement is the
    // difference between an openable proposal and a pin the registry refuses
    // forever, and it is only knowable from the revision.
    const candidate = await liveReads.workspaceDirs(revision)
    // What the candidate gained, read by NAME. A directory that moved keeps its
    // npm name, and this module deletes whatever it reports retired, so the
    // basename alone is not enough to call a governed package gone.
    const declared = await movedNames(
      await liveReads.workspaceDirs(target.revision),
      candidate,
      liveReads.manifestName,
      revision,
    )
    const retired = retiredSpecs(await governedSpecs(repoRoot), candidate, declared)
    const { changesetPath, pinned, removed } = await applyCandidate({
      version, revision, tag: tag ?? `dsh-v${version}`, from: target,
    }, repoRoot, { retired })
    for (const line of removed) process.stdout.write(`${line}\n`)
    for (const line of pinned) process.stdout.write(`${line}\n`)
    process.stdout.write(`wrote ${changesetPath.slice(repoRoot.length + 1)} and HARNESS_TARGET ${version} @ ${revision.slice(0, 8)}\n`)
    // Written outside the repository on purpose: the pull-request body is not
    // part of the adoption, and a file left in the tree would be committed
    // into it.
    if (process.env.PR_BODY_PATH !== undefined) {
      await writeFile(process.env.PR_BODY_PATH, `${pullRequestBody({
        version, revision, tag: tag ?? `dsh-v${version}`, from: target,
      }, retired)}\n`)
    }
    process.exit(0)
  }
  const outcome = await resolveCandidate({ target: await readTarget(), ...liveReads })
  process.stdout.write(`${summarize(outcome)}\n`)
  if (process.env.GITHUB_OUTPUT !== undefined) {
    const { appendFileSync } = await import('node:fs')
    const lines = [`kind=${outcome.kind}`, `summary=${summarize(outcome)}`]
    if (outcome.kind === 'candidate') {
      lines.push(`version=${outcome.version}`, `revision=${outcome.revision}`, `tag=${outcome.tag}`)
    }
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
  }
  // A blocked pass is a real refusal a human has to read; `none` and `current`
  // are ordinary quiet outcomes.
  if (outcome.kind === 'blocked') process.exit(1)
}

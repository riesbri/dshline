/**
 * The release-generation proposer: what it will adopt, what it refuses, and
 * what it is structurally incapable of doing.
 *
 * The refusals matter more than the happy path. This runs unattended on a
 * schedule and opens pull requests, so every way it could propose something
 * that is NOT a coherent generation — a draft, a tag that resolves to a tag
 * object, a tag whose tree disagrees with it, a sideways history — is a way to
 * quietly walk dshline onto a target nobody chose.
 *
 * Every upstream read is injected. Nothing here touches GitHub or npm.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { readFile as read } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  applyCandidate,
  changesetFor,
  governedSpecs,
  newestRelease,
  packageDirsFromTree,
  pullRequestBody,
  RELEASE_TAG,
  resolveCandidate,
  retiredSpecs,
  summarize,
  versionOfTag,
} from './harness-sync.mjs'

/** The currently adopted target every case starts from. */
const ADOPTED = { version: '0.1.2-alpha.5', revision: 'a'.repeat(40) }

/** A candidate commit distinct from the adopted one. */
const NEXT = 'b'.repeat(40)

/**
 * Injected upstream reads with sensible defaults, overridable per case.
 * @param overrides - the reads this case wants to change.
 * @returns the full read set plus the adopted target.
 */
function reads(overrides = {}) {
  return {
    target: ADOPTED,
    listReleases: async () => [
      { tag_name: 'dsh-v0.1.2-alpha.6', draft: false, published_at: '2026-09-03T10:00:00Z' },
    ],
    resolveTag: async () => ({ type: 'commit', sha: NEXT }),
    dereferenceTag: async () => NEXT,
    rootVersion: async () => '0.1.2-alpha.6',
    compare: async () => 'ahead',
    ...overrides,
  }
}

const TMP = []

afterEach(async () => {
  while (TMP.length > 0) await rm(TMP.pop(), { recursive: true, force: true })
})

/**
 * A throwaway repository tree with the files `applyCandidate` rewrites.
 * @returns the root path.
 */
async function fixtureRepo() {
  const root = await mkdtemp(join(tmpdir(), 'harness-sync-'))
  TMP.push(root)
  await mkdir(join(root, '.changeset'), { recursive: true })
  await mkdir(join(root, 'packages', 'dshline'), { recursive: true })
  await writeFile(join(root, 'HARNESS_TARGET'), [
    '# a comment worth keeping',
    `revision ${ADOPTED.revision}`,
    `version ${ADOPTED.version}`,
    '',
  ].join('\n'))
  return root
}

describe('only an official dsh-v release is an adoption unit', () => {
  it('accepts exactly the upstream tag convention', () => {
    expect(versionOfTag('dsh-v0.1.2-alpha.6')).toBe('0.1.2-alpha.6')
    expect(versionOfTag('dsh-v1.0.0')).toBe('1.0.0')
  })

  it.each([
    ['a bare version tag', 'v0.1.2'],
    ['another package in the monorepo', 'dsh-web-v0.1.2'],
    ['a prefixed lookalike', 'pre-dsh-v0.1.2'],
    ['a suffixed lookalike', 'dsh-v0.1.2-'],
    ['a branch-shaped name', 'release/dsh-0.1.2'],
  ])('rejects %s', (_label, tag) => {
    expect(RELEASE_TAG.test(tag)).toBe(false)
    expect(versionOfTag(tag)).toBeUndefined()
  })

  it('ignores drafts and non-conventional tags when picking the newest', () => {
    const picked = newestRelease([
      { tag_name: 'dsh-v0.1.2-alpha.4', draft: false, published_at: '2026-09-01T10:00:00Z' },
      // Newest by date, but a draft is editable and can vanish.
      { tag_name: 'dsh-v0.2.0', draft: true, published_at: '2026-09-05T10:00:00Z' },
      // Newest published, but not this repository's release convention.
      { tag_name: 'web-v9.9.9', draft: false, published_at: '2026-09-04T10:00:00Z' },
      { tag_name: 'dsh-v0.1.2-alpha.5', draft: false, published_at: '2026-09-02T10:00:00Z' },
    ])
    expect(picked?.tag_name).toBe('dsh-v0.1.2-alpha.5')
  })

  it('reports no candidate rather than guessing when nothing qualifies', async () => {
    const outcome = await resolveCandidate(reads({ listReleases: async () => [{ tag_name: 'v1.0.0', draft: false, published_at: 'x' }] }))
    expect(outcome.kind).toBe('none')
  })
})

describe('the candidate must be an immutable commit', () => {
  it('dereferences an annotated tag to the commit it points at', async () => {
    const outcome = await resolveCandidate(reads({
      // An annotated tag is its own object; recording that sha would name
      // something that checks out as nothing.
      resolveTag: async () => ({ type: 'tag', sha: 'c'.repeat(40) }),
      dereferenceTag: async (sha) => (sha === 'c'.repeat(40) ? NEXT : undefined),
    }))
    expect(outcome).toMatchObject({ kind: 'candidate', revision: NEXT })
  })

  it('uses a lightweight tag’s commit directly', async () => {
    const outcome = await resolveCandidate(reads())
    expect(outcome).toMatchObject({ kind: 'candidate', revision: NEXT })
  })

  it('fails closed when the tag resolves to no commit sha', async () => {
    const outcome = await resolveCandidate(reads({ resolveTag: async () => ({ type: 'commit', sha: 'master' }) }))
    expect(outcome.kind).toBe('blocked')
  })
})

describe('the tag and the tree it names must agree', () => {
  it('refuses a candidate whose root manifest declares another version', async () => {
    const outcome = await resolveCandidate(reads({ rootVersion: async () => '0.1.2-alpha.5' }))
    expect(outcome.kind).toBe('blocked')
    expect(outcome.reason).toContain('0.1.2-alpha.5')
    expect(outcome.reason).toContain('0.1.2-alpha.6')
  })
})

describe('the candidate must be forward history, proven not assumed', () => {
  it('adopts when upstream reports the adopted revision is behind it', async () => {
    expect((await resolveCandidate(reads({ compare: async () => 'ahead' }))).kind).toBe('candidate')
  })

  it.each([['diverged'], ['behind'], ['identical'], [undefined]])(
    'fails closed on a "%s" relationship rather than trusting the version numbers',
    async (status) => {
      // The case semver would wave through: a higher version on a history that
      // is not a descendant is not a forward adoption.
      const outcome = await resolveCandidate(reads({ compare: async () => status }))
      expect(outcome.kind).toBe('blocked')
      expect(outcome.reason).toContain('human')
    },
  )
})

describe('the same generation is a quiet no-op', () => {
  /** The newest release is the one already adopted, version and revision both. */
  const alreadyAdopted = {
    listReleases: async () => [
      { tag_name: `dsh-v${ADOPTED.version}`, draft: false, published_at: '2026-09-02T10:00:00Z' },
    ],
    resolveTag: async () => ({ type: 'commit', sha: ADOPTED.revision }),
  }

  it('reports current without producing a candidate', async () => {
    const outcome = await resolveCandidate(reads(alreadyAdopted))
    expect(outcome).toEqual({ kind: 'current', version: ADOPTED.version })
    expect(summarize(outcome)).toContain('current')
  })

  it('does not even read the tree or the history to say so', async () => {
    let touched = false
    const outcome = await resolveCandidate(reads({
      ...alreadyAdopted,
      rootVersion: async () => { touched = true; return 'x' },
      compare: async () => { touched = true; return 'ahead' },
    }))
    // The cheap path is the point: an unchanged generation costs two API reads.
    expect(outcome.kind).toBe('current')
    expect(touched).toBe(false)
  })
})

describe('one revision cannot be two generations', () => {
  it('refuses a newer tag that names the already-adopted revision', async () => {
    // Malformed upstream, not a settled state: the newest release claims a new
    // version for a commit already adopted under another. Matching on the
    // revision alone would return `current` and keep doing so forever, because
    // the no-op answers before any coherence read happens.
    const outcome = await resolveCandidate(reads({
      listReleases: async () => [
        { tag_name: 'dsh-v0.1.2-alpha.6', draft: false, published_at: '2026-09-03T10:00:00Z' },
      ],
      resolveTag: async () => ({ type: 'commit', sha: ADOPTED.revision }),
    }))
    expect(outcome.kind).toBe('blocked')
    expect(outcome.kind).not.toBe('current')
    expect(outcome.reason).toContain('0.1.2-alpha.6')
    expect(outcome.reason).toContain(ADOPTED.version)
    expect(outcome.reason).toContain('human')
  })

  it('says so without proposing an adoption of any kind', async () => {
    const outcome = await resolveCandidate(reads({
      listReleases: async () => [
        { tag_name: 'dsh-v0.1.2-alpha.6', draft: false, published_at: '2026-09-03T10:00:00Z' },
      ],
      resolveTag: async () => ({ type: 'commit', sha: ADOPTED.revision }),
    }))
    expect(outcome).not.toHaveProperty('revision')
    expect(summarize(outcome)).toContain('stopped')
  })
})

/**
 * A manifest pair whose governed and non-governed specs are distinguishable.
 *
 * Module scope rather than one describe's local: both the adoption block and the
 * retirement block need the same governed line, and a second copy here would be
 * free to drift from the fixtures that actually get edited.
 * @param root - the fixture root.
 */
async function seedManifests(root) {
  await writeFile(join(root, 'package.json'), `${JSON.stringify({
    name: 'dshline-workspace',
    devDependencies: {
      '@deepseek-ai/dsh-agent': ADOPTED.version,
      '@deepseek-ai/cordis': '4.0.2',
      typescript: '^7.0.2',
    },
  }, null, 2)}\n`)
  await writeFile(join(root, 'packages', 'dshline', 'package.json'), `${JSON.stringify({
    name: '@dshline/dshline',
    version: '0.15.0',
    dependencies: { '@deepseek-ai/dsh-atomic-write': ADOPTED.version, '@deepseek-ai/schemastery': '^3.18.2' },
    devDependencies: { '@deepseek-ai/dsh-session': ADOPTED.version },
    peerDependencies: { '@deepseek-ai/dsh-llm': ADOPTED.version, '@deepseek-ai/cordis': '^4.0.2' },
  }, null, 2)}\n`)
}

describe('applying a candidate writes exactly the adoption state', () => {
  it('rewrites HARNESS_TARGET to exactly the candidate, comments intact', async () => {
    const root = await fixtureRepo()
    await seedManifests(root)
    await applyCandidate({ version: '0.1.2-alpha.6', revision: NEXT, tag: 'dsh-v0.1.2-alpha.6', from: ADOPTED }, root)
    const written = await readFile(join(root, 'HARNESS_TARGET'), 'utf8')
    expect(written).toContain(`revision ${NEXT}`)
    expect(written).toContain('version 0.1.2-alpha.6')
    expect(written).toContain('# a comment worth keeping')
    expect(written).not.toContain(ADOPTED.revision)
  })

  it('pins every governed dsh-* spec, peers included', async () => {
    const root = await fixtureRepo()
    await seedManifests(root)
    await applyCandidate({ version: '0.1.2-alpha.6', revision: NEXT, tag: 'dsh-v0.1.2-alpha.6', from: ADOPTED }, root)
    const bundle = JSON.parse(await readFile(join(root, 'packages', 'dshline', 'package.json'), 'utf8'))
    const workspace = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    expect(bundle.dependencies['@deepseek-ai/dsh-atomic-write']).toBe('0.1.2-alpha.6')
    expect(bundle.devDependencies['@deepseek-ai/dsh-session']).toBe('0.1.2-alpha.6')
    // Adopting a generation IS the decision that moves the public promise, so
    // unlike `--pin` this reaches peerDependencies.
    expect(bundle.peerDependencies['@deepseek-ai/dsh-llm']).toBe('0.1.2-alpha.6')
    expect(workspace.devDependencies['@deepseek-ai/dsh-agent']).toBe('0.1.2-alpha.6')
  })

  it('never pins a package family that is not the governed Harness line', async () => {
    const root = await fixtureRepo()
    await seedManifests(root)
    await applyCandidate({ version: '0.1.2-alpha.6', revision: NEXT, tag: 'dsh-v0.1.2-alpha.6', from: ADOPTED }, root)
    const bundle = JSON.parse(await readFile(join(root, 'packages', 'dshline', 'package.json'), 'utf8'))
    const workspace = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    // cordis and schemastery version on their own numbering. Pinning them to a
    // Harness version would be wrong rather than merely noisy.
    expect(bundle.peerDependencies['@deepseek-ai/cordis']).toBe('^4.0.2')
    expect(bundle.dependencies['@deepseek-ai/schemastery']).toBe('^3.18.2')
    expect(workspace.devDependencies['@deepseek-ai/cordis']).toBe('4.0.2')
    expect(workspace.devDependencies.typescript).toBe('^7.0.2')
  })

  it('writes one short deterministic changeset with a safe stable name', async () => {
    const root = await fixtureRepo()
    await seedManifests(root)
    await applyCandidate({ version: '0.1.2-alpha.6', revision: NEXT, tag: 'dsh-v0.1.2-alpha.6', from: ADOPTED }, root)
    const body = await readFile(join(root, '.changeset', 'harness-0-1-2-alpha-6.md'), 'utf8')
    expect(body).toContain("'@dshline/dshline': minor")
    expect(body).toContain('Adopt DeepSeek Harness `0.1.2-alpha.6`.')
    // Short on purpose: a machine that did not analyse anything must not
    // narrate an architecture.
    expect(body.split('\n').filter(line => line.trim() !== '')).toHaveLength(4)
  })

  it('names the changeset from the version, so a re-run rewrites rather than accumulates', () => {
    expect(changesetFor('0.1.2-alpha.6').name).toBe('harness-0-1-2-alpha-6.md')
    expect(changesetFor('1.0.0').name).toBe('harness-1-0-0.md')
    expect(changesetFor('0.1.2-alpha.6').name).not.toMatch(/[^0-9A-Za-z.-]/u)
  })

  it('refuses to propose an adoption that changes nothing', async () => {
    const root = await fixtureRepo()
    await seedManifests(root)
    await expect(applyCandidate(
      { version: ADOPTED.version, revision: ADOPTED.revision, tag: 'dsh-v0.1.2-alpha.5', from: ADOPTED },
      root,
    )).rejects.toThrow(/did not change/u)
  })
})

describe('a generation that retires a governed package is still adoptable', () => {
  /**
   * The candidate revision's tree. `invariants` is absent from it: upstream
   * removed the package and every `<package>/invariant` subpath, which is the
   * whole situation this block exists to cover. Compare {@link ADOPTED_TREE},
   * where it is still present.
   */
  const TREE = {
    truncated: false,
    tree: [
      { path: 'packages/agent/agent/package.json' },
      { path: 'packages/session/session/package.json' },
      { path: 'packages/llm/llm/package.json' },
      { path: 'README.md' },
      { path: 'packages/agent/agent/src/index.ts' },
      // Two segments below `packages/`, and not a package. A matcher that
      // stopped at the directory instead of the manifest would read this as a
      // package named CODEOWNERS, and every governed spec whose unscoped name
      // is not present would then look retired.
      { path: 'packages/runtime-diagnostics/CODEOWNERS' },
    ],
  }

  /** The adopted revision's tree, where the same package is still published. */
  const ADOPTED_TREE = {
    truncated: false,
    tree: [...TREE.tree, { path: 'packages/runtime-diagnostics/invariants/package.json' }],
  }

  it('reads the package directories out of one upstream tree', () => {
    // The `package.json` level, not the directory: sibling source files under a
    // package must not read as packages of their own.
    expect([...packageDirsFromTree(ADOPTED_TREE)].sort()).toEqual(['agent', 'invariants', 'llm', 'session'])
  })

  it('refuses a truncated tree, where absence would prove nothing', () => {
    // A truncated listing means "the listing stopped", not "the package is
    // gone". Reading retirement from one would delete a live dependency.
    expect(() => packageDirsFromTree({ truncated: true, tree: ADOPTED_TREE.tree })).toThrow(/truncated/u)
  })

  it('names the governed spec the candidate no longer publishes', () => {
    const governed = ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-invariants']
    // Present at the adopted revision, retired at the candidate: the same two
    // names must answer differently at two revisions.
    expect(retiredSpecs(governed, packageDirsFromTree(ADOPTED_TREE))).toEqual([])
    expect(retiredSpecs(governed, packageDirsFromTree(TREE))).toEqual(['@deepseek-ai/dsh-invariants'])
  })

  it('never treats an ungoverned package as retired', () => {
    // cordis and schemastery are not cut from the Harness revision and are
    // never retired by it; a bare `@deepseek-ai/` test would delete both.
    const dirs = packageDirsFromTree(TREE)
    expect(retiredSpecs(['@deepseek-ai/cordis', '@deepseek-ai/schemastery'], dirs)).toEqual([])
  })

  it('removes the retired spec instead of pinning a version that does not exist', async () => {
    const root = await fixtureRepo()
    await seedManifests(root)
    await writeFile(join(root, 'package.json'), `${JSON.stringify({
      name: 'dshline-workspace',
      devDependencies: {
        '@deepseek-ai/dsh-agent': ADOPTED.version,
        '@deepseek-ai/dsh-invariants': ADOPTED.version,
        '@deepseek-ai/cordis': '4.0.2',
      },
    }, null, 2)}\n`)
    const { removed, pinned } = await applyCandidate(
      { version: '0.1.2-alpha.6', revision: NEXT, tag: 'dsh-v0.1.2-alpha.6', from: ADOPTED },
      root,
      { retired: ['@deepseek-ai/dsh-invariants'] },
    )
    const root_ = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    // Gone from the manifest, and never pinned to the candidate version.
    expect(root_.devDependencies['@deepseek-ai/dsh-invariants']).toBeUndefined()
    expect(pinned.join('\n')).not.toContain('dsh-invariants')
    expect(removed.join('\n')).toContain('@deepseek-ai/dsh-invariants')
    // Everything else is adopted as usual, and the non-governed line is untouched.
    expect(root_.devDependencies['@deepseek-ai/dsh-agent']).toBe('0.1.2-alpha.6')
    expect(root_.devDependencies['@deepseek-ai/cordis']).toBe('4.0.2')
  })

  it('removes a retired peer too, because a promise cannot outlive its package', async () => {
    const root = await fixtureRepo()
    await seedManifests(root)
    await applyCandidate(
      { version: '0.1.2-alpha.6', revision: NEXT, tag: 'dsh-v0.1.2-alpha.6', from: ADOPTED },
      root,
      { retired: ['@deepseek-ai/dsh-llm'] },
    )
    const published = JSON.parse(await readFile(join(root, 'packages', 'dshline', 'package.json'), 'utf8'))
    expect(published.peerDependencies['@deepseek-ai/dsh-llm']).toBeUndefined()
    // cordis shares that peer map and keeps its own caret range.
    expect(published.peerDependencies['@deepseek-ai/cordis']).toBe('^4.0.2')
    // The rest of the governed line still moves.
    expect(published.dependencies['@deepseek-ai/dsh-atomic-write']).toBe('0.1.2-alpha.6')
  })

  it('collects the governed line from every manifest field, deduplicated', async () => {
    const root = await fixtureRepo()
    await seedManifests(root)
    const governed = await governedSpecs(root)
    // Present in dependencies, devDependencies and peerDependencies across two manifests.
    expect(governed).toContain('@deepseek-ai/dsh-atomic-write')
    expect(governed).toContain('@deepseek-ai/dsh-llm')
    expect(new Set(governed).size).toBe(governed.length)
    expect(governed.filter(name => name === '@deepseek-ai/dsh-llm')).toHaveLength(1)
    expect(governed).not.toContain('@deepseek-ai/cordis')
  })

  it('tells the reviewer which packages the generation retired', () => {
    const body = pullRequestBody(
      { version: '0.1.2-alpha.6', revision: NEXT, tag: 'dsh-v0.1.2-alpha.6', from: ADOPTED },
      ['@deepseek-ai/dsh-invariants'],
    )
    expect(body).toContain('@deepseek-ai/dsh-invariants')
    expect(body).toContain('removed from the manifests rather than pinned')
  })

  it('says nothing about retirement when the generation retired nothing', () => {
    const body = pullRequestBody(
      { version: '0.1.2-alpha.6', revision: NEXT, tag: 'dsh-v0.1.2-alpha.6', from: ADOPTED },
      [],
    )
    expect(body).not.toContain('retire')
  })
})

describe('the proposal says what it is, and what it is not', () => {
  it('names both generations, the release, and who decides compatibility', () => {
    const body = pullRequestBody({
      version: '0.1.2-alpha.6', revision: NEXT, tag: 'dsh-v0.1.2-alpha.6', from: ADOPTED,
    })
    expect(body).toContain(ADOPTED.version)
    expect(body).toContain(ADOPTED.revision)
    expect(body).toContain('0.1.2-alpha.6')
    expect(body).toContain(NEXT)
    expect(body).toContain('releases/tag/dsh-v0.1.2-alpha.6')
    expect(body).toContain('Existing CI decides whether this generation is directly compatible.')
    expect(body).toContain('do not add compatibility')
    // No diff analysis: this tool read no source.
    expect(body.length).toBeLessThan(1200)
  })
})

describe('the workflow stays a proposer, never a second opinion', () => {
  /**
   * The sync workflow's code, `#` comment lines removed so prose describing
   * what it deliberately does NOT do cannot satisfy an assertion about what it
   * does.
   * @returns the workflow's code lines only.
   */
  async function workflowCode() {
    const text = await read(new URL('../.github/workflows/harness-sync.yml', import.meta.url), 'utf8')
    return text.split('\n').filter(line => !line.trim().startsWith('#')).join('\n')
  }

  it('never reads a branch head or an npm dist-tag', async () => {
    const workflow = await workflowCode()
    // The whole point of the replacement: adoption units are release tags.
    expect(workflow).not.toMatch(/ref:\s*master/u)
    expect(workflow).not.toMatch(/@(latest|next|alpha)\b/u)
    expect(workflow).not.toContain('dist-tag')
  })

  it('does not rebuild the compatibility answer CI already owns', async () => {
    const workflow = await workflowCode()
    for (const duplicated of ['link-harness', 'capability-report', 'pnpm run test', 'pnpm run typecheck', 'pnpm run build']) {
      expect(workflow, `${duplicated} belongs to ci.yml, not to the proposer`).not.toContain(duplicated)
    }
  })

  it('proves only the mechanical state, leaving the register to the pull request', async () => {
    const workflow = await workflowCode()
    // A proposal always leaves HARNESS_COMPAT one generation stale, so the
    // full check here would mean no proposal could ever be opened while a shim
    // exists. The mechanical mode proves the tree; the blocking lane, on the
    // pull request, keeps the human decision.
    expect(workflow).toContain('run: node tools/harness-target.mjs --mechanical')
    expect(workflow).not.toMatch(/run: node tools\/harness-target\.mjs\s*$/mu)
    // And the summary says where the verdict lives, so a red `Harness target`
    // check on the proposal is not read as a broken proposer.
    expect(workflow).toContain('HARNESS_COMPAT')
  })

  it('carries no model, AI, or publishing credential of any kind', async () => {
    const workflow = await workflowCode()
    // A proposer that could ask a model whether migration is needed would be
    // exactly the architecture this design refuses.
    for (const forbidden of [
      'ANTHROPIC', 'OPENAI', 'OPENROUTER', 'AI_', 'LLM', 'MODEL_API',
      'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'RELEASE_TOKEN', 'id-token',
    ]) {
      expect(workflow, `${forbidden} must not appear`).not.toContain(forbidden)
    }
    // Exactly one secret, and it is the PR-creation credential the Version
    // Packages pull request already uses.
    const secrets = [...workflow.matchAll(/secrets\.([A-Z_]+)/gu)].map(match => match[1])
    expect([...new Set(secrets)]).toEqual(['VERSION_TOKEN'])
  })

  it('never merges anything by itself', async () => {
    const workflow = await workflowCode()
    for (const forbidden of ['merge-method', 'auto-merge', 'automerge', 'gh pr merge', 'pull-request-merge']) {
      expect(workflow).not.toContain(forbidden)
    }
  })

  it('holds write access nowhere, and reaches for the token only at the PR step', async () => {
    const workflow = await workflowCode()
    expect(workflow).not.toMatch(/permissions:\s*\n\s+contents:\s*write/u)
    expect(workflow).not.toMatch(/pull-requests:\s*write/u)
    // The install and apply steps must never see it.
    const beforeToken = workflow.slice(0, workflow.indexOf('secrets.VERSION_TOKEN'))
    expect(beforeToken).toContain('pnpm install')
    expect(beforeToken).not.toContain('VERSION_TOKEN')
  })

  it('establishes the candidate before installing anything the candidate chose', async () => {
    const workflow = await workflowCode()
    const resolve = workflow.indexOf('run: node tools/harness-sync.mjs\n')
    const apply = workflow.indexOf('--apply')
    const install = workflow.indexOf('pnpm install')
    expect(resolve).toBeGreaterThanOrEqual(0)
    expect(apply).toBeGreaterThan(resolve)
    expect(install).toBeGreaterThan(apply)
  })

  it('pins every third-party action to a commit', async () => {
    const workflow = await workflowCode()
    const uses = [...workflow.matchAll(/uses: (\S+)/gu)].map(match => match[1])
    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) expect(action, `${action} must be pinned to a sha`).toMatch(/@[0-9a-f]{40}$/u)
  })

  it('treats the release-age quarantine as a reason to wait, not to propose', async () => {
    const workflow = await workflowCode()
    expect(workflow).toContain('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION')
    // No exclusion, no override, no independent age arithmetic — pnpm decides.
    expect(workflow).not.toContain('minimumReleaseAgeExclude')
    expect(workflow).not.toContain('minimum-release-age')
    expect(workflow).not.toContain('MINIMUM_RELEASE_AGE=')
    // The pull-request step is gated on a successful install, so a quarantined
    // candidate cannot produce one.
    const prStep = workflow.slice(workflow.indexOf('open or update the adoption pull request'))
    expect(prStep).toContain("if: steps.install.outcome == 'success'")
  })

  it('claims an adoption exists only when the pull request step actually ran', async () => {
    const workflow = await workflowCode()
    // The mechanical root of a summary that reported "ordinary CI on that pull
    // request" for a pull request that was never opened: this step carried no
    // id, so there was no step outcome for the summary to ask.
    const prStep = workflow.slice(
      workflow.indexOf('open or update the adoption pull request'),
      workflow.indexOf('uses: peter-evans'),
    )
    expect(prStep).toContain('id: pr')
    expect(workflow).toContain('steps.pr.outcome')
    // And the claim is gated on that outcome, ahead of the candidate-only branch
    // it used to fall into. `$KIND` occurs exactly once, in that old branch.
    const proposed = workflow.indexOf('$PROPOSED')
    const refused = workflow.indexOf('$KIND')
    expect(proposed).toBeGreaterThan(-1)
    expect(refused).toBeGreaterThan(proposed)
    const claim = workflow.indexOf('Adoption proposed from mechanical state only')
    expect(claim).toBeGreaterThan(proposed)
    expect(claim).toBeLessThan(refused)
  })

  it('says plainly when a candidate reached no pull request', async () => {
    const workflow = await workflowCode()
    // Every failure between finding a candidate and opening its pull request
    // lands here: a refused install, a failed `--apply`, a failed coherence
    // check. Saying only that one "could not be installed" would be wrong for
    // two of the three.
    const refused = workflow.slice(workflow.indexOf('$KIND'))
    expect(refused).toContain('No pull request was opened')
    expect(refused).toContain('Read the run log')
  })

  it('keeps a refused candidate red instead of inventing a quiet outcome for it', async () => {
    const workflow = await workflowCode()
    // ERR_PNPM_NO_MATCHING_VERSION means one of two opposite things: upstream
    // has not finished publishing, or upstream RETIRED a governed package. The
    // install log cannot tell them apart, so classifying it as benign lag would
    // green-wash a documented breaking change for as long as nobody noticed.
    expect(workflow).not.toContain('ERR_PNPM_NO_MATCHING_VERSION')
    const failStep = workflow.slice(
      workflow.indexOf('fail on an install refusal'),
      workflow.indexOf('the proposed tree is mechanically coherent'),
    )
    expect(failStep).toContain('exit 1')
    // And it names both possibilities rather than asserting one of them.
    expect(failStep).toContain('not finished publishing')
    expect(failStep).toContain('retired a')
  })

  it('refuses to supersede an adoption that is already open', async () => {
    const workflow = await workflowCode()
    expect(workflow).toContain('state=open&head=')
    const applyStep = workflow.slice(workflow.indexOf('apply the candidate'))
    expect(applyStep).toContain("steps.open-pr.outputs.blocked == 'false'")
  })

  it('runs on a modest schedule and on demand', async () => {
    const workflow = await workflowCode()
    expect(workflow).toMatch(/cron: '[0-9]+ \*\/6 \* \* \*'/u)
    expect(workflow).toContain('workflow_dispatch')
  })
})

/**
 * Capability probe: dshline's `standard` preset, over the REAL Harness
 * filesystem skill providers and the REAL installed
 * `@deepseek-ai/dsh-agent-preset` package.
 *
 * `skills.probe.spec.ts` deliberately mounts no filesystem provider, because
 * where skill FILES live is not part of the `ctx.skills` contract dshline
 * consumes. That is right for the seam and wrong for THIS question. The shipped
 * `standard` declaration mounts two instances of `@deepseek-ai/dsh-skill-filesystem`:
 * the ordinary one exactly as upstream states it, and a second isolated one
 * whose only root is the `bundledSkillDir` the `@deepseek-ai/dsh-agent-preset`
 * package ships. A structural check of the YAML proves only that the strings
 * look plausible. The chain that actually has to work is
 *
 * ```text
 *   the two rows in presets/standard.patch.yml
 *     → the Loader's own `!!js` expression, evaluated with a real `baseUrl`
 *     → the installed @deepseek-ai/dsh-agent-preset/skills directory
 *     → the real dsh-skill-filesystem provider, twice
 *     → ctx.skills.snapshot(), which is what /skills reads
 * ```
 *
 * so this file mounts that shape and asserts the catalog. Both providers are
 * configured from the declaration itself rather than restated here, and nothing
 * about the packaged skills is a fixture: the bodies are the bytes the published
 * package carries.
 *
 * The authoring provider contributes package-owned baseline skills, so it must
 * sit BELOW every root a person controls. The cases below therefore use
 * SAME-NAME skills, not unrelated ones — an unrelated skill would be visible
 * under either shape and would prove nothing about precedence.
 * @module
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { parse } from 'yaml'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
// The presentation layer, reached only to prove that surfacing these needs no
// dshline-side knowledge of them. Nothing in `src/` imports or names a skill.
import { invocationLabel, skillRows, slashCandidates, sourceLabel } from '../../src/skills/model.ts'
import type { SkillView } from '../../src/skills/model.ts'

/**
 * Loader's own `!!js` tag, so a conditional entry parses to its raw source text
 * — the form this file evaluates. The Loader's `with (ctx) { … }` scope is not
 * reimplemented: the only identifier these expressions bind is `baseUrl`, and
 * it is supplied as a parameter.
 */
const JS_EXPR_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (source: string) => source }

/** The explicit skill catalog the adopted `@deepseek-ai/dsh-agent-preset` ships. */
const PACKAGED_SKILLS = [
  'agent-experience',
  'cordis-composition-reference',
  'editing-cordis-compositions',
  'cordis-plugin-development',
] as const

/**
 * The `config` block the shipped `standard` declaration puts on one named row.
 *
 * The whole block, not just the field this file cares about, because every field
 * in it is load-bearing and a probe that read only `bundledSkillDir` would pass
 * against a declaration that had also switched `includeDefaultRoots` back on.
 * @param id - the preset row to read.
 * @returns the row's parsed config.
 */
function shippedConfig(id: string): Record<string, unknown> {
  const text = readFileSync(new URL('../../presets/standard.patch.yml', import.meta.url), 'utf8')
  const parsed: unknown = parse(text, { customTags: [JS_EXPR_TAG] })
  if (!Array.isArray(parsed)) throw new Error('standard.patch.yml must be a top-level patch list')
  const rows = parsed.flatMap(entry => (entry as { insert?: unknown[] }).insert ?? [])
  const preset = rows.find(candidate => (candidate as { id?: string }).id === 'preset-standard')
  const plugins = (preset as { config: { plugins: { id?: string; config?: Record<string, unknown> }[] } } | undefined)
    ?.config.plugins
  const row = plugins?.find(candidate => candidate.id === id)
  if (row === undefined) throw new Error(`standard must declare a ${id} row`)
  return row.config ?? {}
}

/**
 * Evaluate a Loader `!!js` expression the way the Loader does.
 * @param expression - the raw source text from the patch file.
 * @param baseUrl - the module URL the Loader would have in scope.
 * @returns the resolved directory.
 */
function evaluate(expression: string, baseUrl: string): string {
  return new Function('baseUrl', `return (${expression})`)(baseUrl) as string
}

/**
 * What a child interpreter reports about the packaged authoring root.
 *
 * Paths are realpath'd in the child, so the caller compares identities rather
 * than spellings: a registry install and a source-linked checkout place the same
 * package in different directories, and this must hold for both.
 */
interface FreshResolution {
  /** The child's `NODE_PATH`, or null when it had none. */
  nodePath: string | null
  /** The resolved `package.json`. */
  manifest: string
  /** The resolved package's real directory. */
  dir: string
  /** The `name` its own manifest declares. */
  name: string
  /** The real directory of the `skills/` root beside it. */
  skills: string
}

/**
 * Resolve the packaged authoring root from a NEW Node process started without
 * `NODE_PATH`.
 *
 * This is the only way to prove the shipped expression resolves without a
 * package manager's hidden hoist, and in-process attempts do not: Node
 * assembles its global search paths once during startup, so deleting
 * `process.env.NODE_PATH` afterwards leaves `createRequire().resolve()` fully
 * able to use them. A registry install's hoist would then answer for a wrong
 * origin exactly as it always did, and the case would pass while proving
 * nothing. A fresh interpreter has no such memory.
 *
 * The child repeats production's own shape — `createRequire(baseUrl).resolve(…)`
 * from the Loader origin — and reports what it found as JSON.
 * @param origin - the Loader origin to resolve from: a file URL.
 * @returns the child's report and its exit status.
 */
function resolveInFreshProcess(origin: string): { status: number | null, report: FreshResolution | undefined } {
  const env = { ...process.env }
  delete env.NODE_PATH
  const source = `
    const { createRequire } = require('node:module')
    const { readFileSync, realpathSync } = require('node:fs')
    const { dirname, join } = require('node:path')
    const manifest = createRequire(${JSON.stringify(origin)}).resolve('@deepseek-ai/dsh-agent-preset/package.json')
    const dir = realpathSync(dirname(manifest))
    process.stdout.write(JSON.stringify({
      nodePath: process.env.NODE_PATH ?? null,
      manifest,
      dir,
      name: JSON.parse(readFileSync(manifest, 'utf8')).name,
      skills: realpathSync(join(dir, 'skills')),
    }))
  `
  const child = spawnSync(process.execPath, ['-e', source], { env, encoding: 'utf8' })
  return { status: child.status, report: child.status === 0 ? JSON.parse(child.stdout) as FreshResolution : undefined }
}

/** A scratch directory tree. */
let scratch: string

/** A scratch project root and a scratch user home, kept out of the real `$DSH_HOME`. */
let project: string
let dshHome: string
let agentsHome: string

/** A fake deployment-bundled root, standing in for `$DSH_BUNDLED_SKILL_DIR`. */
let deploymentBundled: string

/**
 * The directory the shipped `standard.patch.yml` actually lives in.
 *
 * This is the Loader origin the include carrier hands a preset row in a real
 * profile, derived from this spec's own location — the same directory
 * `shippedConfig` reads the declaration from — so the two cannot drift apart.
 */
const SHIPPED_PRESET_DIR = fileURLToPath(new URL('../../presets/', import.meta.url))

/** The `baseUrl` shape the Loader evaluates a preset row under. */
let baseUrl: string

/**
 * `DSH_BUNDLED_SKILL_DIR` as this process found it, and whether it was there.
 *
 * Production HONORS this variable: the ordinary provider falls back to it exactly
 * when `bundledSkillDir` is unset and `includeDefaultRoots` is true, and the
 * shipped row deliberately leaves both alone. That is correct, and this file
 * does not weaken it. What would be wrong is letting an inherited value decide
 * the result of a default case — on a machine or a CI runner that happens to
 * export one, the packaged skills would no longer be the whole catalog and
 * a test would fail for a reason that has nothing to do with this composition.
 *
 * So the suite saves, clears, and restores exactly this one variable. Nothing
 * else in the environment is touched, and the cases that genuinely need a
 * deployment bundled root pass one explicitly rather than reading the ambient
 * value. The original is put back in `afterAll` — including leaving it absent
 * when it was absent — so a test process cannot leak a change into its parent.
 */
const inheritedBundledDir = process.env.DSH_BUNDLED_SKILL_DIR

beforeAll(async () => {
  delete process.env.DSH_BUNDLED_SKILL_DIR
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'dshline-preset-skills-')))
  project = join(scratch, 'project')
  dshHome = join(scratch, 'dsh-home')
  agentsHome = join(scratch, 'agents-home')
  deploymentBundled = join(scratch, 'deployment-bundled')
  for (const dir of [project, dshHome, agentsHome, deploymentBundled]) {
    await mkdir(dir, { recursive: true })
  }
  // The Loader evaluates a preset row with the BASE URL of the composition
  // resolving it. That value is not a caller-chosen root: the include carrier
  // that reads a patch file sets it to that FILE'S OWN DIRECTORY —
  // `this.ctx.baseUrl = new URL('.', pathToFileURL(this.filename)).href` in
  // `vendor/include/src/index.ts` of the adopted generation. dshline's bundle
  // manifest declares `./presets/standard.patch.yml`, so in a real profile the
  // authoring row's `createRequire(baseUrl)` starts from inside the installed
  // `@dshline/dshline` package and walks up to
  // `@dshline/dshline/node_modules/@deepseek-ai/dsh-agent-preset`, which is
  // there because that package is a declared runtime dependency of this one.
  //
  // Modelling anything else — a scratch directory, a profile root — resolves
  // from a place the package was never installed, and can therefore only ever
  // succeed by reaching sideways into a package manager's hidden hoist. That
  // is not a property of the shipped plugin: the hidden hoist holds a linked
  // package nowhere, so the same code passed against a registry install and
  // failed against a source-linked one, which is precisely the seam the
  // `Harness target` lane exists to test. Anchoring on the real origin makes
  // this exercise production resolution rather than an accident of layout.
  //
  // What that claim needs, and cannot get from this process, is proof the
  // resolution does not depend on a hidden-hoist search path. Deleting
  // `process.env.NODE_PATH` here would NOT be that proof: Node builds its global
  // search paths once at startup, and `createRequire().resolve()` keeps using
  // them after the variable is gone. `resolveInFreshProcess()` below spawns a
  // new interpreter instead, which is the only clean boundary for this.
  baseUrl = pathToFileURL(`${SHIPPED_PRESET_DIR}/`).href
})

afterEach(async () => {
  for (const root of [join(project, '.dsh'), join(project, '.agents'), dshHome, agentsHome, deploymentBundled]) {
    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true })
  }
})

/**
 * Remove the whole scratch tree and put the environment back.
 *
 * `afterAll` rather than a final `afterEach`, because the per-case reset only
 * clears the child roots; without this the suite would leave a `mkdtemp`
 * directory behind on every run. `force` makes it a no-op on a tree a failing
 * test already removed, so teardown still restores the variable on the way out
 * rather than throwing before it gets there.
 */
afterAll(async () => {
  if (inheritedBundledDir === undefined) {
    delete process.env.DSH_BUNDLED_SKILL_DIR
  } else {
    process.env.DSH_BUNDLED_SKILL_DIR = inheritedBundledDir
  }
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
})

/**
 * The packaged directory the authoring row's `bundledSkillDir` names.
 * @returns the resolved directory.
 */
function packagedRoot(): string {
  const expression = shippedConfig('skill-harness-authoring')['bundledSkillDir']
  if (typeof expression !== 'string') {
    throw new Error('standard must set bundledSkillDir on skill-harness-authoring')
  }
  return evaluate(expression, baseUrl)
}

/**
 * Mount the real registry with BOTH production providers, the way the shipped
 * `standard` declaration composes them.
 * @param ordinary - extra fields for the ordinary provider. A deployment bundled
 *   root is passed this way rather than through `DSH_BUNDLED_SKILL_DIR`, so the
 *   cases that want one are deterministic and the cases that do not are not at
 *   the mercy of the ambient environment.
 * @returns a context carrying the real `ctx.skills`.
 */
async function catalogWith(ordinary: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  // Row order follows the declaration. The ordinary provider gets ONLY the two
  // fields a hermetic case must override — its home directories, so a
  // developer's real `~/.dsh/skills` cannot decide a test result. Its
  // `includeDefaultRoots` and `providerName` are whatever the declaration says,
  // which for upstream's own row is "unset", i.e. the shipped defaults.
  await ctx.plugin(skillFilesystem, {
    ...shippedConfig('skill-filesystem'),
    dshHome,
    agentsHome,
    ...ordinary,
  })
  // The authoring provider, configured from the declaration verbatim. Its
  // `bundledSkillDir` is a `!!js` value, so it is the one field evaluated here
  // against a real Loader-shaped `baseUrl`.
  const authoring = shippedConfig('skill-harness-authoring')
  await ctx.plugin(skillFilesystem, {
    ...authoring,
    bundledSkillDir: packagedRoot(),
  })
  return ctx
}

/**
 * Write one skill into a root.
 * @param dir - the absolute root directory to create the skill in.
 * @param name - the directory and frontmatter name.
 * @param description - the frontmatter description.
 */
async function writeSkill(dir: string, name: string, description: string): Promise<void> {
  // The SKILL directory itself, not just the root: `writeFile` creates no
  // parents, and a root holding no skill directory is a valid but empty root.
  await mkdir(join(dir, name), { recursive: true })
  await writeFile(
    join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`,
    'utf8',
  )
}

/** Write a project skill under `.dsh/skills` or `.agents/skills`. @param root - which one. @param name - the skill name. @param description - its description. */
async function writeProjectSkill(root: string, name: string, description: string): Promise<void> {
  await writeSkill(join(project, root, 'skills'), name, description)
}

describe('capability: skills · the authoring provider the standard preset declares', () => {
  it('resolves the shipped expression from the origin the Loader would use', () => {
    // Two claims, and the second is the one that used to be unproven.
    //
    // 1. The origin is the shipped preset file's own directory — what the
    //    include carrier sets — and not somewhere invented. A cheap guard on
    //    the assignment in `beforeAll`, so a later edit to it fails here with a
    //    plain message instead of surfacing as a confusing resolution error.
    //    It is NOT the proof; the child process is.
    // 2. A Node process that NEVER had NODE_PATH resolves the package from
    //    there. That is the claim a registry install made true and a
    //    source-linked checkout made false, and it cannot be checked from
    //    inside this worker: Node fixes its global search paths at startup, so
    //    unsetting the variable here changes nothing the resolver can see, and
    //    a hidden hoist would answer for a wrong origin just as it always did.
    expect(baseUrl).toBe(pathToFileURL(`${SHIPPED_PRESET_DIR}/`).href)

    const { status, report } = resolveInFreshProcess(baseUrl)
    expect(status, 'a fresh process with no NODE_PATH must resolve the packaged root').toBe(0)
    // The child reports its own environment, so "no NODE_PATH" is established
    // where the resolution actually happened rather than assumed here.
    expect(report?.nodePath).toBeNull()
    // The manifest is the real one, named by itself, not merely found at a
    // path that looks plausible.
    expect(report?.name).toBe('@deepseek-ai/dsh-agent-preset')
    // And it is reached as THIS package's declared dependency, from this
    // package's own node_modules — the relationship production walks. Stated as
    // a realpath identity, because a registry install and a source-linked
    // checkout serve that same dependency from different directories and the
    // claim has to hold for both.
    expect(report?.dir).toBe(
      realpathSync(join(SHIPPED_PRESET_DIR, '..', 'node_modules', '@deepseek-ai', 'dsh-agent-preset')),
    )
    expect(report?.skills).toBe(join(report?.dir ?? '', 'skills'))
  })

  it('resolves the shipped expression to the installed package\'s own skills directory', async () => {
    // Not "the expression mentions the right words": the Loader's `!!js` value
    // is source text, so the only meaningful check is what it evaluates to in a
    // real composition, and that the directory is the PACKAGE's, not a copy.
    const dir = packagedRoot()
    const manifestPath = await realpath(join(dir, '..', 'package.json'))
    const declared = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: string }
    expect(declared.name).toBe('@deepseek-ai/dsh-agent-preset')
    // That package's OWN `skills` root, identified by sitting beside its own
    // manifest rather than by the path spelling. A registry install supplies it
    // from `node_modules/@deepseek-ai/dsh-agent-preset`; a source-linked
    // checkout supplies the same package from `packages/preset/agent-preset`.
    // Requiring the store spelling proved nothing about the plugin and failed
    // the one lane whose whole subject is a source-linked Harness.
    expect(await realpath(dir)).toBe(join(dirname(manifestPath), 'skills'))
  })

  it('exposes the package-owned first-party authoring skills as bundled, from harness-authoring', async () => {
    const ctx = await catalogWith()
    try {
      const observed = await ctx.skills.snapshot({ cwd: project })
      expect(observed.complete, 'discovery must settle for a catalog to mean anything').toBe(true)
      expect(observed.skills.map(skill => skill.name).sort()).toEqual([...PACKAGED_SKILLS].sort())
      // `bundled`, not `custom`: the adopted generation resolves a
      // `bundledSkillDir` root to `source: bundled` at `BUNDLED_SKILL_RANK`, and
      // that label is what `/skills` shows. It is also why a project or user
      // skill of the same name wins — see the precedence cases.
      for (const skill of observed.skills) {
        expect(skill.source, skill.name).toBe('bundled')
        expect(skill.provider, skill.name).toBe('harness-authoring')
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reads a packaged skill body from the installed package, not a fixture', async () => {
    const ctx = await catalogWith()
    try {
      const loaded = await ctx.skills.get('cordis-composition-reference', { cwd: project })
      if (loaded === undefined) throw new Error('the packaged skill was not loadable')
      // Proof the bytes are the published ones, two ways: the file the provider
      // located is INSIDE the installed package's `skills/` directory, and the
      // body is that package's real prose with its frontmatter already parsed
      // off. A fixture copied into this repository could not satisfy the first.
      expect(loaded.path?.startsWith(packagedRoot())).toBe(true)
      expect(loaded.source).toBe('bundled')
      expect(loaded.content).toContain('# Cordis composition reference')
      expect(loaded.content).toContain('## Loader patch dialect')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reads that root from the Host, not through a workspace ctx.fs', async () => {
    // A `bundled` root is marked `trustedHost`, which is what makes the provider
    // bypass the optional `ctx.fs` service and read the Host path directly. That
    // is the correct production contract here: the path is inside an installed
    // package, not inside anything a workspace's filesystem policy restricts.
    // The case mounts a `ctx.fs` that refuses EVERY path, and the skills still
    // arrive — so a workspace boundary cannot be what is serving them.
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.provide('fs', {
      resolve: () => { throw new Error('the workspace refuses this path') },
      stat: () => { throw new Error('the workspace refuses this path') },
      readTextFile: () => { throw new Error('the workspace refuses this path') },
      readDir: () => { throw new Error('the workspace refuses this path') },
    } as never)
    await ctx.plugin(skillFilesystem, {
      ...shippedConfig('skill-harness-authoring'),
      bundledSkillDir: packagedRoot(),
    })
    try {
      const observed = await ctx.skills.snapshot({ cwd: project })
      expect(observed.skills.map(skill => skill.name).sort()).toEqual([...PACKAGED_SKILLS].sort())
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('surfaces them as user- and model-invocable, as their real frontmatter says', async () => {
    // The packaged skills ship no `user-invocable` or `disable-model-invocation` field, so
    // Harness's own defaults decide. Asserting the ANSWER rather than a guess is
    // what lets `/skills` and the `/name` gesture keep treating them like any
    // other skill — and what makes the model-facing claim in the docs true
    // rather than assumed.
    const ctx = await catalogWith()
    try {
      const observed = await ctx.skills.snapshot({ cwd: project })
      const byName = new Map(observed.skills.map(skill => [skill.name, skill]))
      for (const name of PACKAGED_SKILLS) {
        expect(byName.get(name)?.invocation, name).toEqual({ modelInvocable: true, userInvocable: true })
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('capability: skills · the bundled authoring root sits below every root a person owns', () => {
  it.each(PACKAGED_SKILLS)('lets a project .dsh/skills skill override %s', async name => {
    await writeProjectSkill('.dsh', name, 'The project copy')
    const ctx = await catalogWith()
    try {
      const observed = await ctx.skills.snapshot({ cwd: project })
      const winner = observed.skills.find(skill => skill.name === name)
      // Rank 100 against rank 600. Asserting `source` rather than mere presence
      // is the whole point: BOTH candidates exist, and only the source says which
      // one survived.
      expect(winner?.source).toBe('project-dsh')
      const loaded = await ctx.skills.get(name, { cwd: project })
      expect(loaded?.content).toContain('The project copy')
      expect(loaded?.content).not.toContain('Loader YAML dialect')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(PACKAGED_SKILLS)('lets a project .agents/skills skill override %s', async name => {
    await writeProjectSkill('.agents', name, 'The shared-agents copy')
    const ctx = await catalogWith()
    try {
      const winner = (await ctx.skills.snapshot({ cwd: project }))
        .skills.find(skill => skill.name === name)
      expect(winner?.source).toBe('project-agents')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(PACKAGED_SKILLS)('lets a ~/.dsh/skills skill override %s', async name => {
    // THE case that distinguishes this design from a `customSkillDirs` entry,
    // which sits at rank 300 and would LOSE this. A packaged baseline skill must
    // not outrank something a person wrote in their own home.
    await writeSkill(join(dshHome, 'skills'), name, 'The user copy')
    const ctx = await catalogWith()
    try {
      const winner = (await ctx.skills.snapshot({ cwd: project }))
        .skills.find(skill => skill.name === name)
      expect(winner?.source).toBe('user-dsh')
      const loaded = await ctx.skills.get(name, { cwd: project })
      expect(loaded?.content).toContain('The user copy')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(PACKAGED_SKILLS)('lets a ~/.agents/skills skill override %s', async name => {
    await writeSkill(join(agentsHome, 'skills'), name, 'The agents-home copy')
    const ctx = await catalogWith()
    try {
      const winner = (await ctx.skills.snapshot({ cwd: project }))
        .skills.find(skill => skill.name === name)
      expect(winner?.source).toBe('user-agents')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('falls back to the packaged skill when nothing claims the name', async () => {
    const ctx = await catalogWith()
    try {
      const observed = await ctx.skills.snapshot({ cwd: project })
      expect(observed.skills.map(skill => skill.name).sort()).toEqual([...PACKAGED_SKILLS].sort())
      for (const skill of observed.skills) expect(skill.source).toBe('bundled')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps unrelated ordinary roots visible alongside them', async () => {
    await writeProjectSkill('.dsh', 'local-test', 'A local project skill')
    await writeProjectSkill('.agents', 'agents-test', 'A shared-agents project skill')
    await writeSkill(join(dshHome, 'skills'), 'user-test', 'A user skill')
    await writeSkill(join(agentsHome, 'skills'), 'user-agents-test', 'An agents-home skill')
    const ctx = await catalogWith()
    try {
      const names = await namesIn(ctx)
      for (const name of ['local-test', 'agents-test', 'user-test', 'user-agents-test']) {
        expect(names, name).toContain(name)
      }
      expect(names).toEqual(expect.arrayContaining([...PACKAGED_SKILLS]))
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('capability: skills · the ordinary provider keeps its own bundled channel', () => {
  it('serves a deployment bundled root and the Harness authoring skills together', async () => {
    // The regression that proves the second provider did not commandeer the
    // first's bundled slot. An explicit `bundledSkillDir` REPLACES an instance's
    // `$DSH_BUNDLED_SKILL_DIR` fallback, so had the authoring root been set on
    // the ordinary row instead, this deployment skill would have vanished. Both
    // are `bundled`; they are told apart by `provider`, and no claim is made here
    // about how two same-rank candidates would otherwise be ordered.
    await writeSkill(deploymentBundled, 'deployment-skill', 'Shipped by this deployment')
    const ctx = await catalogWith({ bundledSkillDir: deploymentBundled })
    try {
      const observed = await ctx.skills.snapshot({ cwd: project })
      const names = observed.skills.map(skill => skill.name)
      expect(names).toContain('deployment-skill')
      expect(names).toEqual(expect.arrayContaining([...PACKAGED_SKILLS]))
      const byName = new Map(observed.skills.map(skill => [skill.name, skill]))
      expect(byName.get('deployment-skill')?.provider).toBe('filesystem')
      for (const name of PACKAGED_SKILLS) {
        expect(byName.get(name)?.provider, name).toBe('harness-authoring')
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('still prefers a user skill over the deployment bundled root', async () => {
    await writeSkill(deploymentBundled, 'deployment-skill', 'Shipped by this deployment')
    await writeSkill(join(dshHome, 'skills'), 'deployment-skill', 'The user copy')
    const ctx = await catalogWith({ bundledSkillDir: deploymentBundled })
    try {
      const winner = (await ctx.skills.snapshot({ cwd: project }))
        .skills.find(skill => skill.name === 'deployment-skill')
      expect(winner?.source).toBe('user-dsh')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves every ordinary root to the ordinary provider', async () => {
    // Which provider ANSWERS for an ordinary skill. Worth asserting, but note
    // what it does and does not catch: rank would mask a second scan of the same
    // root, because the ordinary provider's candidates are lower-ranked and win
    // the merge even when the authoring provider also found them. So this is a
    // guard on provider identity, not on duplication. What actually catches
    // `includeDefaultRoots: false` being dropped is the structural assertion
    // plus the Host-read case above, where the duplicate scan goes through a
    // workspace `ctx.fs` that refuses it.
    await writeProjectSkill('.dsh', 'project-skill', 'A project skill')
    await writeProjectSkill('.agents', 'agents-skill', 'A shared-agents project skill')
    await writeSkill(join(dshHome, 'skills'), 'user-skill', 'A user skill')
    await writeSkill(deploymentBundled, 'deployment-skill', 'Shipped by this deployment')
    const ctx = await catalogWith({ bundledSkillDir: deploymentBundled })
    try {
      const observed = await ctx.skills.snapshot({ cwd: project })
      const byName = new Map(observed.skills.map(skill => [skill.name, skill]))
      for (const name of ['project-skill', 'agents-skill', 'user-skill', 'deployment-skill']) {
        expect(byName.get(name)?.provider, `${name} must stay on the ordinary provider`).toBe('filesystem')
      }
      // And the reverse: nothing the authoring provider answers for is an
      // ordinary root.
      for (const name of PACKAGED_SKILLS) {
        expect(byName.get(name)?.provider, name).toBe('harness-authoring')
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('capability: skills · /skills needs no special case for them', () => {
  it('offers all packaged skills as ordinary, launchable rows labelled bundled', async () => {
    // The last link in the chain: the summaries Harness really produced, run
    // through dshline's own presentation functions. If surfacing these needed
    // anything, it would show up HERE — a name the interface had to know, a
    // source bucket it had to invent, or a row it had to add by hand. It needs
    // none of that, which is why no skill name appears anywhere in `src/skills`.
    const ctx = await catalogWith()
    try {
      const observed = await ctx.skills.snapshot({ cwd: project })
      const views = observed.skills.map(toView)
      const rows = skillRows(views, ['/plugins', '/skills'])
      expect(rows.map(row => row.skill.name).sort()).toEqual([...PACKAGED_SKILLS].sort())
      for (const row of rows) {
        expect(row.launchable, row.skill.name).toBe(true)
        expect(row.shadowed).toBe(false)
        // `bundled`, not `custom`: the source Harness resolved. The label is an
        // existing bucket in `sourceLabel`, not a dshline category invented for
        // these skills.
        expect(sourceLabel(row.skill.source)).toBe('bundled')
        expect(invocationLabel(row.skill)).toBe('you + model')
      }
      // And the `/` menu reaches the same skills through the same rule.
      expect(slashCandidates([], views).map(candidate => candidate.name).sort())
        .toEqual([...PACKAGED_SKILLS].sort())
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

/**
 * The catalog names the production providers discovered for the scratch project.
 * @param ctx - a context carrying the real `ctx.skills`.
 * @returns every discovered skill name.
 */
async function namesIn(ctx: Context): Promise<readonly string[]> {
  const observed = await ctx.skills.snapshot({ cwd: project })
  expect(observed.complete).toBe(true)
  return (observed.skills as readonly SkillSummary[]).map(skill => skill.name)
}

/**
 * Copy one resolved Harness summary into the view this frontend presents.
 *
 * The same field-for-field copy `./catalog.ts` performs, written out here so the
 * probe exercises the real presentation boundary rather than the real registry
 * alone.
 * @param summary - one effective skill summary.
 * @returns the presentation view.
 */
function toView(summary: SkillSummary): SkillView {
  return {
    name: summary.name,
    description: summary.description,
    ...summary.whenToUse === undefined ? {} : { whenToUse: summary.whenToUse },
    userInvocable: summary.invocation.userInvocable,
    modelInvocable: summary.invocation.modelInvocable,
    source: summary.source,
  }
}

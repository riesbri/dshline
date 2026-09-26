/**
 * Capability probe: dshline's `standard` preset, over the REAL Harness
 * filesystem skill provider and the REAL installed `@deepseek-ai/dsh-agent-preset`
 * package.
 *
 * `skills.probe.spec.ts` deliberately mounts no filesystem provider, because
 * where skill FILES live is not part of the `ctx.skills` contract dshline
 * consumes. That is right for the seam and wrong for THIS question. The shipped
 * `standard` declaration now points the real `@deepseek-ai/dsh-skill-filesystem`
 * provider at the `skills/` directory that ships inside
 * `@deepseek-ai/dsh-agent-preset`, and a structural check of the YAML proves
 * only that the string looks plausible. The chain that actually has to work is
 *
 * ```text
 *   the row in presets/standard.patch.yml
 *     → the Loader's own `!!js` expression, evaluated with a real `baseUrl`
 *     → the installed @deepseek-ai/dsh-agent-preset/skills directory
 *     → the real dsh-skill-filesystem provider
 *     → ctx.skills.snapshot(), which is what /skills reads
 * ```
 *
 * so this file walks that chain end to end and asserts the catalog. Nothing here
 * is a fixture: the three skill bodies are the bytes the published package
 * carries, and the provider is the one a profile actually mounts.
 *
 * The custom root must AUGMENT the ordinary ones, not replace them, and the
 * precedence between them is Harness's alone — so the last two cases assert
 * Harness's real ranking over a scratch project rather than describing one.
 * @module
 */

import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
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

/** The three skills the adopted `@deepseek-ai/dsh-agent-preset` ships. */
const PACKAGED_SKILLS = [
  'cordis-composition-reference',
  'editing-cordis-compositions',
  'cordis-plugin-development',
] as const

/**
 * The whole `config` block the shipped `standard` declaration puts on its
 * `skill-filesystem` row, read from this bundle's own patch file rather than
 * restated here.
 *
 * The WHOLE block, not just `customSkillDirs`, because every field in it is
 * load-bearing and a probe that read only the directory would pass against a
 * declaration that had also switched `includeDefaultRoots` off — which would
 * hide every project and user skill behind a row that still looks right.
 * @returns the row's parsed config.
 */
function shippedSkillFilesystemConfig(): Record<string, unknown> {
  const text = readFileSync(new URL('../../presets/standard.patch.yml', import.meta.url), 'utf8')
  const parsed: unknown = parse(text, { customTags: [JS_EXPR_TAG] })
  if (!Array.isArray(parsed)) throw new Error('standard.patch.yml must be a top-level patch list')
  const rows = parsed.flatMap(entry => (entry as { insert?: unknown[] }).insert ?? [])
  const preset = rows.find(candidate => (candidate as { id?: string }).id === 'preset-standard')
  const plugins = (preset as { config: { plugins: { id?: string; config?: Record<string, unknown> }[] } } | undefined)
    ?.config.plugins
  const row = plugins?.find(candidate => candidate.id === 'skill-filesystem')
  if (row === undefined) throw new Error('standard must declare a skill-filesystem row')
  return row.config ?? {}
}

/**
 * The `customSkillDirs` entry that shipped config carries.
 * @returns the raw Loader expression string.
 */
function customSkillDirExpression(): string {
  const dirs = shippedSkillFilesystemConfig()['customSkillDirs']
  if (!Array.isArray(dirs) || dirs.length !== 1) {
    throw new Error('standard must declare exactly one customSkillDirs entry')
  }
  const expression = dirs[0]
  if (typeof expression !== 'string') throw new Error('a customSkillDirs entry must be a Loader expression')
  return expression
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

/** A scratch directory tree, removed when the suite finishes. */
let scratch: string

/** A scratch project root and a scratch user home, kept out of the real `$DSH_HOME`. */
let project: string
let dshHome: string
let agentsHome: string

/** The directory the shipped declaration actually resolves to, or `undefined`. */
let packagedSkills: string | undefined

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'dshline-preset-skills-')))
  project = join(scratch, 'project')
  dshHome = join(scratch, 'dsh-home')
  agentsHome = join(scratch, 'agents-home')
  for (const dir of [project, dshHome, agentsHome]) await mkdir(dir, { recursive: true })
  // The Loader evaluates a preset row with the BASE URL of the composition
  // resolving it. A profile root is the realistic value, and a file URL is what
  // `createRequire` needs, so this is the real thing rather than a stand-in.
  //
  // Resolved here but never asserted here on purpose: a `beforeAll` that THROWS
  // skips every case below, and a silently skipped catalog is a much weaker
  // signal than ten cases that each fail by name. `packagedRoot()` turns a
  // missing or unresolvable declaration into a failure inside the case.
  try {
    packagedSkills = evaluate(customSkillDirExpression(), pathToFileURL(`${scratch}/`).href)
  } catch {
    packagedSkills = undefined
  }
})

afterEach(async () => {
  await rm(join(project, '.dsh'), { recursive: true, force: true })
  await rm(join(project, '.agents'), { recursive: true, force: true })
  await rm(join(dshHome, 'skills'), { recursive: true, force: true })
  await rm(join(agentsHome, 'skills'), { recursive: true, force: true })
})

/**
 * The packaged directory the shipped declaration names.
 * @returns the resolved directory.
 */
function packagedRoot(): string {
  if (packagedSkills === undefined) {
    throw new Error("standard.patch.yml must resolve one customSkillDirs entry to @deepseek-ai/dsh-agent-preset/skills")
  }
  return packagedSkills
}

/**
 * Mount the real registry and the real filesystem provider with the shipped
 * declaration's own custom root.
 * @param over - provider fields this case varies, merged over the shipped ones.
 * @returns a context carrying the real `ctx.skills`.
 */
async function catalogWith(over: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(skillFilesystem, {
    // The shipped config verbatim, so a field added there later is exercised
    // here rather than silently ignored by a probe that hard-coded the one it
    // knew about.
    ...shippedSkillFilesystemConfig(),
    // `!!js` is source text to the YAML parser, so the one field that needs
    // evaluating is evaluated here with a real Loader-shaped `baseUrl`.
    customSkillDirs: [packagedRoot()],
    // `dshHome`/`agentsHome` are redirected so the case reads only its own
    // fixture: a developer's real `~/.dsh/skills` must not decide a test result.
    // `watch: false` keeps a chokidar watcher off the packaged directory. None of
    // the three is what is under test — `customSkillDirs`, `includeDefaultRoots`
    // and everything else in the declaration are.
    dshHome,
    agentsHome,
    watch: false,
    ...over,
  })
  return ctx
}

/**
 * Write one project-local skill.
 * @param root - the skill root, relative to the project (`.dsh/skills` or `.agents/skills`).
 * @param name - the directory and frontmatter name.
 * @param description - the frontmatter description.
 */
async function writeProjectSkill(root: string, name: string, description: string): Promise<void> {
  const dir = join(project, root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`,
    'utf8',
  )
}

describe('capability: skills · the packaged root the standard preset declares', () => {
  it('resolves the shipped expression to the installed package\'s own skills directory', async () => {
    // Not "the expression mentions the right words": the Loader's `!!js` value
    // is source text, so the only meaningful check is what it evaluates to in a
    // real composition, and that the directory is the PACKAGE's, not a copy.
    const manifestPath = await realpath(join(packagedRoot(), '..', 'package.json'))
    const declared = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: string }
    expect(declared.name).toBe('@deepseek-ai/dsh-agent-preset')
    expect(packagedRoot().endsWith(join('@deepseek-ai', 'dsh-agent-preset', 'skills'))).toBe(true)
  })

  it('exposes the three packaged Cordis skills through ctx.skills', async () => {
    const ctx = await catalogWith()
    try {
      const observed = await ctx.skills.snapshot({ cwd: project })
      expect(observed.complete, 'discovery must settle for a catalog to mean anything').toBe(true)
      expect(observed.skills.map(skill => skill.name).sort()).toEqual([...PACKAGED_SKILLS].sort())
      // They arrive as an ordinary Harness discovery bucket, which is what
      // `/skills` already labels and filters on. dshline hard-codes no name.
      for (const skill of observed.skills) expect(skill.source).toBe('custom')
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
      expect(loaded.source).toBe('custom')
      expect(loaded.content).toContain('# Cordis composition reference')
      expect(loaded.content).toContain('## Loader patch dialect')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('surfaces them as user- and model-invocable, as their real frontmatter says', async () => {
    // The three ship no `user-invocable` or `disable-model-invocation` field, so
    // Harness's own defaults decide. Asserting the ANSWER rather than a guess is
    // what lets `/skills` and the `/name` gesture keep treating them like any
    // other skill.
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

describe('capability: skills · the packaged root augments the default roots', () => {
  it('keeps an ordinary project skill visible beside the packaged ones', async () => {
    // `includeDefaultRoots` is deliberately unset in the declaration because
    // Harness's own default is `true`. If it ever stopped being true, `.dsh/skills`
    // would go dark and only this assertion would notice.
    await writeProjectSkill('.dsh/skills', 'local-test', 'A local project skill')
    const ctx = await catalogWith()
    try {
      const names = await namesIn(ctx)
      expect(names).toContain('local-test')
      expect(names).toEqual(expect.arrayContaining([...PACKAGED_SKILLS]))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps an ordinary .agents/skills project skill visible too', async () => {
    await writeProjectSkill('.agents/skills', 'agents-test', 'A shared-agents project skill')
    const ctx = await catalogWith()
    try {
      expect(await namesIn(ctx)).toContain('agents-test')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the user roots visible as well', async () => {
    const dir = join(dshHome, 'skills', 'user-test')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: user-test\ndescription: A user skill\n---\n\nbody\n', 'utf8')
    const ctx = await catalogWith()
    try {
      const names = await namesIn(ctx)
      expect(names).toContain('user-test')
      expect(names).toEqual(expect.arrayContaining([...PACKAGED_SKILLS]))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('drops the default roots entirely when they are switched off', async () => {
    // The other half of the same default, and the negative control for it: with
    // `includeDefaultRoots: false` the packaged root still resolves, so a test
    // that only asserted the packaged skills would pass. This one is what makes
    // the "augments, not replaces" claim falsifiable.
    await writeProjectSkill('.dsh/skills', 'local-test', 'A local project skill')
    const ctx = await catalogWith({ includeDefaultRoots: false })
    try {
      const names = await namesIn(ctx)
      expect(names).toEqual(expect.arrayContaining([...PACKAGED_SKILLS]))
      expect(names).not.toContain('local-test')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('capability: skills · precedence stays Harness\'s', () => {
  it('lets a project skill of the same name win over the packaged one', async () => {
    // Harness ranks project roots ahead of `customSkillDirs`; dshline implements
    // no ranking of its own, so this is a statement about the adopted generation's
    // provider and nothing else. The assertion is on `source`, not just presence:
    // both candidates exist, and only the source says which one survived.
    await writeProjectSkill('.dsh/skills', 'cordis-composition-reference', 'The project copy')
    const ctx = await catalogWith()
    try {
      const observed = await ctx.skills.snapshot({ cwd: project })
      expect(observed.skills.map(skill => skill.name).sort()).toEqual([...PACKAGED_SKILLS].sort())
      const winner = observed.skills.find(skill => skill.name === 'cordis-composition-reference')
      expect(winner?.source).toBe('project-dsh')
      const loaded = await ctx.skills.get('cordis-composition-reference', { cwd: project })
      expect(loaded?.content).toContain('The project copy')
      expect(loaded?.content).not.toContain('Loader YAML dialect')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the packaged body when no project skill claims the name', async () => {
    const ctx = await catalogWith()
    try {
      const loaded = await ctx.skills.get('editing-cordis-compositions', { cwd: project })
      expect(loaded?.source).toBe('custom')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('capability: skills · /skills needs no special case for them', () => {
  it('offers all three as ordinary, launchable rows with a `custom` source label', async () => {
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
      // `userInvocable` came from the real frontmatter, so `/name` reaches them
      // and the inspector offers the slash without consulting a name list.
      for (const row of rows) {
        expect(row.launchable, row.skill.name).toBe(true)
        expect(row.shadowed).toBe(false)
        expect(sourceLabel(row.skill.source)).toBe('custom')
        expect(invocationLabel(row.skill)).toBe('you + model')
      }
      // And the `/` menu reaches the same three through the same rule.
      expect(slashCandidates([], views).map(candidate => candidate.name).sort())
        .toEqual([...PACKAGED_SKILLS].sort())
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

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

/**
 * The catalog names this provider discovered for the scratch project.
 * @param ctx - a context carrying the real `ctx.skills`.
 * @returns every discovered skill name.
 */
async function namesIn(ctx: Context): Promise<readonly string[]> {
  const observed = await ctx.skills.snapshot({ cwd: project })
  expect(observed.complete).toBe(true)
  return (observed.skills as readonly SkillSummary[]).map(skill => skill.name)
}

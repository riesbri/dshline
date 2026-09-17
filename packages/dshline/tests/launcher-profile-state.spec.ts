/**
 * What dshline is allowed to know about its own profile, and the four ways it can be
 * installed.
 *
 * The independent clean-room QA found three states this wrapper used to conflate, and
 * each one cost a user something:
 *
 * - A profile whose manifest exists and holds nothing. `dsh plugin` writes the
 *   manifest BEFORE it installs, so a setup that stopped — no pnpm, a package it could
 *   not fetch — left a profile that looked initialized. The wrapper handed over to a
 *   frontend that had never been installed, which is a blank terminal with no message
 *   and no exit.
 * - A profile recording a release older than the running wrapper, after
 *   `npm i -g @dshline/dshline@latest` moved one half and not the other. The launch
 *   died inside the harness with `cannot get property "agent" without inject`.
 * - A profile installed from a checkout, which must NOT be read as either of those.
 *   Its recorded spec is a folder, so there is no release for it to disagree with, and
 *   subjecting it to npm-version equality would break the mode outright.
 *
 * The four installation combinations below are *planning* cases: they assert what the
 * wrapper decides, not that a network install happened. Which of them were executed
 * end to end, and which are only structurally covered here, is stated per case.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapPlan, pnpmRequirement, profileState, splitCommandLine, versionInSpec } from '../bin/dshline.mjs'
import { resolveLauncher } from '../src/launcher.ts'

let dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
  dirs = []
})

/** A temp directory that is cleaned up after the test. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dshline-profile-'))
  dirs.push(dir)
  return dir
}

/** This wrapper's own version, which a set-up profile is expected to record. */
const VERSION = '0.22.0'

/**
 * A profile directory holding the given manifest text, or no manifest at all.
 * @param manifest - the text to write, or undefined for no file.
 * @returns the profile directory.
 */
async function profileWith(manifest: string | undefined): Promise<string> {
  const dir = await tempDir()
  await mkdir(dir, { recursive: true })
  if (manifest !== undefined) await writeFile(join(dir, 'package.json'), manifest, 'utf8')
  return dir
}

/** A profile manifest recording one dependency spec against this package. */
function manifestRecording(spec: unknown): string {
  return `${JSON.stringify({ name: 'dsh-profile-dshline', dependencies: { '@dshline/dshline': spec } })}\n`
}

/**
 * What the wrapper would do about a profile, at the planning level.
 * @param state - what `profileState` found.
 * @param wrapperVersion - the running wrapper's version.
 * @returns the plan.
 */
function plan(state: Record<string, unknown>, wrapperVersion = VERSION): string {
  return bootstrapPlan({ args: [], state: state as never, wrapperVersion, interactive: true }) as string
}

describe('what the profile says about this package', () => {
  it('is absent when the harness has never initialized it', async () => {
    expect(profileState(await tempDir())).toEqual({ kind: 'absent' })
  })

  it('is incomplete when the manifest a failed setup left behind records nothing', async () => {
    // The exact QA state. Worth stating plainly: this is not a corrupt profile and not
    // a broken plugin set, it is the file `dsh plugin` writes before it installs
    // anything, left where a failure stopped.
    expect(profileState(await profileWith(manifestRecording(undefined)))).toEqual({ kind: 'incomplete' })
    expect(profileState(await profileWith(`${JSON.stringify({ name: 'dsh-profile-dshline', dependencies: {} })}\n`)))
      .toEqual({ kind: 'incomplete' })
  })

  it('is incomplete when the recorded spec is not a spec at all', async () => {
    for (const spec of ['', '   ', 7, null, {}]) {
      expect(profileState(await profileWith(manifestRecording(spec))), JSON.stringify(spec)).toEqual({ kind: 'incomplete' })
    }
  })

  it('is incomplete when the manifest cannot be read, rather than throwing', async () => {
    // An unparsable manifest describes no installed package. Throwing here would turn a
    // diagnosable state into a stack trace, which is the failure this model exists to
    // remove.
    expect(profileState(await profileWith('{ not json'))).toEqual({ kind: 'incomplete' })
  })

  it('is registry when a release is recorded', async () => {
    expect(profileState(await profileWith(manifestRecording(VERSION))))
      .toEqual({ kind: 'registry', spec: VERSION, version: VERSION })
    expect(profileState(await profileWith(manifestRecording(`^${VERSION}`))))
      .toEqual({ kind: 'registry', spec: `^${VERSION}`, version: VERSION })
  })

  it('is local for every spelling of a checkout', async () => {
    // The mode that must survive all of this. Each of these is a decision already made
    // by the person who ran `dshline --setup <path>`, and none of them is a release.
    const specs = [
      './packages/dshline',
      '../dshline/packages/dshline',
      '/srv/dshline/packages/dshline',
      'C:\\src\\dshline\\packages\\dshline',
      '\\\\server\\share\\dshline',
      'file:../dshline',
      'link:../dshline',
      'workspace:*',
      'github:riesbri/dshline',
      'https://example.invalid/dshline.tgz',
    ]
    for (const spec of specs) {
      const state = profileState(await profileWith(manifestRecording(spec)))
      expect(state, spec).toEqual({ kind: 'local', spec })
      expect(plan(state), spec).toBe('launch')
    }
  })

  it('never reads a checkout as a stale release', async () => {
    // The precise mistake to avoid: `0.20.0` in a spec is a mismatch, but the same
    // digits inside a path are part of a folder name.
    const state = profileState(await profileWith(manifestRecording('./releases/0.20.0/dshline')))
    expect(state.kind).toBe('local')
    expect(plan(state)).toBe('launch')
  })

  it('reads only its own dependency, not the rest of the manifest', async () => {
    // The narrowness is the point: this wrapper answers for its own package in its own
    // profile and judges nothing else, which is what keeps it from becoming a second
    // Harness dependency resolver.
    const manifest = `${JSON.stringify({
      name: 'dsh-profile-dshline',
      dependencies: { '@dshline/dshline': '0.19.0', '@deepseek-ai/dsh-base': '0.1.6-alpha.2' },
    })}\n`
    expect(profileState(await profileWith(manifest))).toEqual({ kind: 'registry', spec: '0.19.0', version: '0.19.0' })
  })
})

describe('a version inside a dependency spec', () => {
  it('takes the first release-shaped version', () => {
    expect(versionInSpec('0.22.0')).toBe('0.22.0')
    expect(versionInSpec('^0.22.0')).toBe('0.22.0')
    expect(versionInSpec('~0.22.0')).toBe('0.22.0')
    expect(versionInSpec('>=0.22.0 <0.23.0')).toBe('0.22.0')
    expect(versionInSpec('0.22.0-beta.1')).toBe('0.22.0-beta.1')
  })

  it('finds nothing in a spec that names no release', () => {
    // Which is what keeps `latest` and `*` from being reported as mismatches.
    for (const spec of ['latest', 'next', '*', 'x', 'file:../dshline', 'github:riesbri/dshline']) {
      expect(versionInSpec(spec), spec).toBeUndefined()
    }
  })
})

describe('splitting a checkout command line', () => {
  it('splits a bare command the way a shell would', () => {
    expect(splitCommandLine('node --import tsx/esm apps/cli/src/bin.ts'))
      .toEqual(['node', '--import', 'tsx/esm', 'apps/cli/src/bin.ts'])
  })

  it('keeps a quoted program path whole', () => {
    // The pre-existing Windows failure, in one line: Node lives under
    // `C:\Program Files\nodejs` on a default install, and an unquoted path with a space
    // was split into `C:\Program` and `Files\nodejs\node.exe`, so the launch failed
    // with ENOENT beside a checkout that worked from a shell.
    expect(splitCommandLine('"C:\\Program Files\\nodejs\\node.exe" apps/cli.ts'))
      .toEqual(['C:\\Program Files\\nodejs\\node.exe', 'apps/cli.ts'])
    expect(splitCommandLine("'/opt/my node/bin/node' apps/cli.ts"))
      .toEqual(['/opt/my node/bin/node', 'apps/cli.ts'])
  })

  it('keeps an empty quoted argument, and drops unquoted whitespace', () => {
    // The one distinction a naive trim-and-split loses.
    expect(splitCommandLine('node  --flag   x')).toEqual(['node', '--flag', 'x'])
    expect(splitCommandLine('node ""')).toEqual(['node', ''])
    expect(splitCommandLine('   ')).toEqual([])
  })
})

describe('the pnpm remedy matches how the harness was reached', () => {
  it('says nothing at all when pnpm is there', () => {
    expect(pnpmRequirement({ available: true, origin: 'package' })).toEqual({ ok: true })
    expect(pnpmRequirement({ available: true, origin: 'checkout' })).toEqual({ ok: true })
  })

  it('offers the global install for a package harness', () => {
    const missing = pnpmRequirement({ available: false, origin: 'package' })
    expect(missing.ok).toBe(false)
    if (missing.ok) throw new Error('expected a requirement')
    expect(missing.message).toContain('npm install -g pnpm')
    expect(missing.message).not.toContain('corepack')
  })

  it('offers corepack first for a harness checkout, which declares its own pnpm', () => {
    const missing = pnpmRequirement({ available: false, origin: 'checkout' })
    expect(missing.ok).toBe(false)
    if (missing.ok) throw new Error('expected a requirement')
    expect(missing.message).toContain('corepack')
    expect(missing.message.indexOf('corepack')).toBeLessThan(missing.message.indexOf('npm install -g pnpm'))
  })

  it('says why pnpm is needed, and that nothing was changed', () => {
    // The two facts the QA message was missing. `'pnpm' is not recognized` names a
    // command with no explanation of what wanted it, and it arrived after the profile
    // had already been created.
    const missing = pnpmRequirement({ available: false, origin: 'package' })
    if (missing.ok) throw new Error('expected a requirement')
    expect(missing.message).toContain('installs a profile\'s plugins with pnpm')
    expect(missing.message).toContain('Nothing has been changed')
    expect(missing.message).toContain('dshline --setup')
  })
})

describe('the four ways Harness and dshline can be paired', () => {
  /**
   * One combination, as the wrapper sees it.
   *
   * `harness` and `dshline` are the two independent axes: where each of the two
   * packages came from. What the wrapper decides is a function of the recorded spec
   * (the dshline axis) and, for a prerequisite, of how the launcher was found (the
   * harness axis).
   */
  const combinations = [
    {
      name: 'A. npm Harness + npm dshline',
      /** Where the dshline axis points. */
      spec: VERSION,
      /** Which launcher mechanism answers. */
      origin: 'package' as const,
      /** Executed end to end by `tools/consumer-smoke.mjs`; planned here. */
      coverage: 'EXECUTED AND PASSED',
    },
    {
      name: 'B. npm Harness + local dshline checkout',
      spec: './packages/dshline',
      origin: 'package' as const,
      coverage: 'STRUCTURALLY TESTED',
    },
    {
      name: 'C. local Harness checkout + npm dshline',
      spec: VERSION,
      origin: 'checkout' as const,
      coverage: 'STRUCTURALLY TESTED',
    },
    {
      name: 'D. local Harness checkout + local dshline checkout',
      spec: 'file:../dshline/packages/dshline',
      origin: 'checkout' as const,
      coverage: 'STRUCTURALLY TESTED',
    },
  ] as const

  for (const combination of combinations) {
    it(`${combination.name} launches`, async () => {
      const state = profileState(await profileWith(manifestRecording(combination.spec)))
      expect(plan(state), combination.coverage).toBe('launch')
    })

    it(`${combination.name} has a prerequisite remedy`, () => {
      const missing = pnpmRequirement({ available: false, origin: combination.origin })
      expect(missing.ok).toBe(false)
      if (missing.ok) throw new Error('expected a requirement')
      expect(missing.message).toContain('dshline --setup')
    })
  }

  it('tells the two harness axes apart by how the launcher was found', async () => {
    // The npm/checkout split on the harness side is the launcher's own answer, and it
    // is what the prerequisite remedy keys off. A checkout is recognized from its
    // manifest, not from an assumption about where npm puts things.
    const checkout = await tempDir()
    await writeFile(
      join(checkout, 'package.json'),
      `${JSON.stringify({ name: 'harness', packageManager: 'pnpm@11.7.0', scripts: { dsh: 'node --import tsx/esm apps/cli/src/bin.ts' } })}\n`,
      'utf8',
    )
    const local = resolveLauncher({ DSH_HARNESS: checkout })
    if (local.kind !== 'found') throw new Error('expected found')
    expect(local.launcher.origin).toBe('checkout')

    const bin = await tempDir()
    await writeFile(join(bin, 'dsh'), '', 'utf8')
    const explicit = resolveLauncher({ DSH_BIN: join(bin, 'dsh') })
    if (explicit.kind !== 'found') throw new Error('expected found')
    expect(explicit.launcher.origin).toBe('package')
  })

  it('tells the two dshline axes apart by the recorded spec', async () => {
    // The npm/checkout split on the dshline side, and the reason a path must never be
    // compared with the wrapper's version string.
    const registry = profileState(await profileWith(manifestRecording(VERSION)))
    const local = profileState(await profileWith(manifestRecording('./packages/dshline')))
    expect(registry.kind).toBe('registry')
    expect(local.kind).toBe('local')
    // Same running wrapper, two answers — and only one of them has a version to check.
    expect(plan(registry)).toBe('launch')
    expect(plan(local)).toBe('launch')
  })
})

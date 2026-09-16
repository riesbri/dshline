/**
 * The startup gate: a confirmed Harness generation mismatch must stop dshline
 * before any session exists, and an unreadable version must not be mistaken for
 * one.
 *
 * The environments here are real temp Harness homes laid out the way
 * `$DSH_HOME/profiles` actually is, so the generation comparison under test is
 * the production one — `adoptedGeneration()` reads this package's own peer pin
 * and `installedGeneration()` reads `@deepseek-ai/dsh-base` off the booted
 * profile. Nothing here stubs the comparison itself; a fixture that injected a
 * `HarnessGeneration` would prove only that the predicate can read a field.
 *
 * The regression shape is the reproduced failure: an old `permissionPresets`
 * service that registers the same name but exposes no `catalog()`. The point is
 * not that dshline now tolerates it — it must NOT — but that a known-incompatible
 * Host never reaches the code that would call it.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { stripAnsi } from '@dshline/renderer'
import { permissionPicker } from '../src/permission.ts'
import { readHarnessGeneration, runSetup } from '../src/setup/index.ts'
import type { SetupSpec } from '../src/setup/index.ts'
import { harnessBlocksStartup } from '../src/setup/model.ts'
import { offerSetup } from '../src/window.ts'
import type { Window } from '../src/window.ts'

/** The generation this package's peer pin adopts; read from the real manifest in tests. */
const ADOPTED = '0.1.6-alpha.1'
/** A previous generation, the skewed side of the reproduced environment. */
const OLD = '0.1.5-rc.2'

let homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.map(async home => rm(home, { recursive: true, force: true })))
  homes = []
})

/** What a test wants a Host to be. */
interface HostOptions {
  /** Version of `@deepseek-ai/dsh-base`, or undefined to leave it unreadable. */
  readonly installed: string | undefined
  /** Route keys an adapter registered. */
  readonly registered?: readonly string[]
  /** The window's model selection. */
  readonly selected?: { readonly provider: string; readonly model: string }
  /** The `permissionPresets` service to mount, when the test supplies one. */
  readonly permissionPresets?: unknown
}

/** A Host under test, and the observations the assertions read. */
interface Host {
  readonly ctx: Context
  readonly selection: ModelSelectionRef
  readonly spec: SetupSpec
  readonly committed: string[]
  readonly overlays: string[]
  /** The catalog the default `permissionPresets` service would return. */
  readonly catalog: { readonly options: { readonly value: string; readonly name: string }[] }
}

/**
 * Build a real profile tree at a chosen installed generation.
 * @param options - what the Host should look like.
 * @returns the context, the setup spec, and recorded output.
 */
async function host(options: HostOptions): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'dshline-gate-'))
  homes.push(home)
  const root = join(home, 'profiles')
  const profileDir = join(root, 'dshline')
  await mkdir(profileDir, { recursive: true })
  await writeFile(
    join(profileDir, 'package.json'),
    JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
    'utf8',
  )
  if (options.installed !== undefined) {
    const installed = join(root, 'node_modules', '@deepseek-ai', 'dsh-base')
    await mkdir(installed, { recursive: true })
    await writeFile(join(installed, 'package.json'), JSON.stringify({ version: options.installed }), 'utf8')
  }

  const committed: string[] = []
  const overlays: string[] = []
  const catalog = { options: [{ value: 'auto', name: 'Auto' }] }
  const permissionPresets = options.permissionPresets ?? { catalog: () => catalog }
  const registered = (options.registered ?? ['openai']).map(id => ({ id, name: id }))
  const ctx = {
    get: (name: string) => {
      if (name === 'dshHomePath') return (...segments: string[]) => join(home, ...segments)
      if (name === 'permissionPresets') return permissionPresets
      return undefined
    },
    baseUrl: `${pathToFileURL(profileDir).href}/`,
    llm: {
      listProviders: () => registered,
      listConfigurableProviders: () => [],
      listModels: async () => [],
      discoverModels: async () => [],
      resolveModelInfo: async () => ({}),
    },
    tuiSlots: {
      pushOverlay: (overlay: { readonly view?: string }) => {
        overlays.push(overlay.view ?? 'overlay')
        return (): void => {}
      },
      invalidate: (): void => {},
      activeOverlay: undefined,
    },
    on: () => (): void => {},
  } as unknown as Context
  const selection: ModelSelectionRef = {
    current: options.selected,
    assembled: undefined,
  }
  return {
    ctx,
    selection,
    spec: {
      ctx,
      commit: lines => { committed.push(...lines.map(stripAnsi)) },
      version: '0.22.0',
      selection,
      onModelChanged: () => {},
    },
    committed,
    overlays,
    catalog,
  }
}

/** A minimal Window for `offerSetup`, which reads six fields and nothing else. */
function windowFor(host: Host): Window {
  return {
    ctx: host.ctx,
    selection: host.selection,
    commit: host.spec.commit,
    version: host.spec.version,
    refreshModelInfo: (): void => {},
    setDispatch: (): void => {},
  } as unknown as Window
}

describe('the generation predicate', () => {
  it('blocks only a confirmed mismatch', () => {
    expect(harnessBlocksStartup({ kind: 'match', version: ADOPTED })).toBe(false)
    expect(harnessBlocksStartup({ kind: 'mismatch', adopted: ADOPTED, installed: OLD })).toBe(true)
    // Uncertainty is not incompatibility: an unreadable side must not gate.
    expect(harnessBlocksStartup({ kind: 'unknown', adopted: ADOPTED, installed: undefined })).toBe(false)
    expect(harnessBlocksStartup({ kind: 'unknown', adopted: undefined, installed: OLD })).toBe(false)
    expect(harnessBlocksStartup({ kind: 'unknown', adopted: undefined, installed: undefined })).toBe(false)
  })
})

describe('a coherent Host', () => {
  it('continues normally and reports a matching Harness generation', async () => {
    const h = await host({ installed: ADOPTED, registered: [], selected: undefined })
    expect(await readHarnessGeneration(h.ctx)).toEqual({ kind: 'match', version: ADOPTED })
    expect(await runSetup(h.spec)).toBe('continued')
    const report = h.committed.join('\n')
    expect(report).toContain(`✓ Harness    ${ADOPTED}`)
    expect(report).not.toContain('unsupported')
    expect(report).not.toContain('will not continue')
    expect(h.overlays).toEqual([])
  })

  it('leaves the permission service seam reachable', async () => {
    const h = await host({ installed: ADOPTED, registered: [], selected: undefined })
    // The coherent fixture's service supplies `catalog()`; the picker built from
    // it must produce rows. This is the seam `/permission` consumes, and it
    // stays reachable because startup never blocked.
    expect(permissionPicker(h.catalog, { currentValue: 'auto' })?.choices)
      .toEqual([{ value: 'auto', label: 'Auto' }])
  })

  it('lets a settled launch proceed without opening setup at all', async () => {
    const h = await host({ installed: ADOPTED, selected: { provider: 'openai', model: 'gpt-x' } })
    expect(await offerSetup(windowFor(h))).toBe('continued')
    // A working launch is not interrupted, and the report is never committed.
    expect(h.committed).toEqual([])
    expect(h.overlays).toEqual([])
  })
})

describe('a confirmed mismatch', () => {
  it('stops setup with both exact versions and the deterministic recovery command', async () => {
    const h = await host({ installed: OLD, registered: [], selected: undefined })
    expect(await readHarnessGeneration(h.ctx)).toEqual({ kind: 'mismatch', adopted: ADOPTED, installed: OLD })
    expect(await runSetup(h.spec)).toBe('blocked')
    const report = h.committed.join('\n')
    expect(report).toContain(`${OLD} installed`)
    expect(report).toContain(`dshline targets ${ADOPTED}`)
    expect(report).toContain('dshline supports one Harness generation at a time.')
    expect(report).toContain(`npm install -g @deepseek-ai/dsh@${ADOPTED}`)
    // The conditional second direction is retained, not turned into a promise.
    expect(report).toContain('if one exists')
    expect(report).toContain('does not by itself land on the installed generation')
    expect(report).toContain('unsupported')
    expect(report).toContain('will not continue')
    expect(report).toContain('ctrl-d')
    // No generic exception or stack trace reached the reader.
    expect(report).not.toMatch(/is not a function/)
    expect(report).not.toMatch(/TypeError/)
    // No interactive surface, so there is nowhere to go but recovery or exit.
    expect(h.overlays).toEqual([])
  })

  it('gates the launch before any session can start, on the real startup boundary', async () => {
    const h = await host({ installed: OLD, selected: { provider: 'openai', model: 'gpt-x' } })
    expect(await offerSetup(windowFor(h))).toBe('blocked')
    expect(h.overlays).toEqual([])
    expect(h.committed.join('\n')).toContain('will not continue')
  })

  it('never touches an old permission service that has no catalog()', async () => {
    // The reproduced failure: `@deepseek-ai/dsh-permission-presets@0.1.5-rc.2`
    // registers `permissionPresets` but has no `catalog()`, so `/permission`'s
    // `ctx.get('permissionPresets')?.catalog()` threw. The assertion is not that
    // the call is now guarded — it is not — but that the gate stops before the
    // attachment that would make it.
    let touched = false
    const oldService = new Proxy({}, {
      get: () => {
        touched = true
        return undefined
      },
    })
    const h = await host({ installed: OLD, permissionPresets: oldService, selected: { provider: 'openai', model: 'gpt-x' } })
    expect(await offerSetup(windowFor(h))).toBe('blocked')
    expect(touched).toBe(false)
    expect(h.committed.join('\n')).toContain(`npm install -g @deepseek-ai/dsh@${ADOPTED}`)
  })
})

describe('an unknown generation', () => {
  it('stays a diagnostic and does not gate startup', async () => {
    const h = await host({ installed: undefined })
    expect(await readHarnessGeneration(h.ctx)).toEqual({
      kind: 'unknown',
      adopted: ADOPTED,
      installed: undefined,
    })
    expect(await runSetup(h.spec)).toBe('continued')
    const report = h.committed.join('\n')
    expect(report).toContain('the installed version could not be read')
    // Neither verdict, in either direction.
    expect(report).not.toContain('unsupported')
    expect(report).not.toContain('will not continue')
    expect(report).not.toContain('incompatible')
  })

  it('does not gate a launch whose version cannot be established', async () => {
    const h = await host({ installed: undefined, selected: { provider: 'openai', model: 'gpt-x' } })
    expect(await offerSetup(windowFor(h))).toBe('continued')
    expect(h.committed.join('\n')).not.toContain('will not continue')
  })
})

describe('the old permission shape is not a compatibility fallback', () => {
  it('keeps the unguarded catalog call in the attachment', async () => {
    // A guard added there would be the compatibility shim this change refuses.
    // The production call is `ctx.get('permissionPresets')?.catalog()`; the fix
    // is upstream of it, at the startup gate. This test names the invariant so a
    // future "defensive" `typeof` does not arrive unnoticed.
    const source = await readFile(new URL('../src/attachment.ts', import.meta.url), 'utf8')
    expect(source).toContain("ctx.get('permissionPresets')?.catalog()")
    expect(source).not.toContain("typeof ctx.get('permissionPresets')")
  })
})

/**
 * The Skill Surface's lifecycle, against the REAL `@deepseek-ai/dsh-skill`
 * registry.
 *
 * Nothing here recreates Harness behavior in a fake: precedence, layering,
 * merging, and the `complete` contract are the real service's, and the
 * providers below are ordinary same-process providers written to the public
 * provider interface. What is asserted is dshline's half — which scope and
 * cwd it reads for, what it retains when discovery cannot complete, and what
 * it will and will not say about a name.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type {
  SkillCandidate,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
  SkillProviderObservation,
} from '@deepseek-ai/dsh-skill'
import SessionStore, { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SkillCatalog } from '../src/skills/catalog.ts'

/** A workspace the providers below key on, so a wrong cwd is visible. */
const CWD = '/work/project'

/**
 * One provider candidate with the fields the registry validates.
 * @param name - the skill name.
 * @param over - anything this case varies.
 * @returns a complete candidate.
 */
function candidate(name: string, over: Partial<SkillCandidate> = {}): SkillCandidate {
  return {
    name,
    description: `${name} description`,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'project-dsh',
    provider: 'test',
    rank: 100,
    locator: name,
    ...over,
  }
}

/** A provider whose every discovery this spec drives by hand. */
interface Driven {
  readonly plugin: { readonly inject: string[]; readonly apply: (ctx: Context) => void }
  /** What the next `list()` does. */
  answer: (options: SkillLookupOptions) =>
    | readonly SkillCandidate[]
    | SkillProviderObservation
    | Promise<readonly SkillCandidate[] | SkillProviderObservation>
  /** Every cwd the registry asked this provider about. */
  readonly seen: string[]
  /** The registration-scoped invalidation capability the registry lends. */
  control?: SkillProviderControl
}

/**
 * A real provider registration, driven from the spec.
 * @param name - the provider name.
 * @returns the plugin and the handles to steer it.
 */
function driven(name = 'test'): Driven {
  const driver: Driven = {
    seen: [],
    answer: () => [],
    plugin: {
      inject: ['skills'],
      apply: ctx => {
        ctx.effect(() => ctx.skills.registerProvider(control => {
          driver.control = control
          const provider: SkillProvider = {
            name,
            list: async options => {
              driver.seen.push(options.cwd ?? '<none>')
              return await driver.answer(options)
            },
            get: async () => undefined,
          }
          return provider
        }), `provider ${name}`)
      },
    },
  }
  return driver
}

/** A catalog over one context, plus how many times it asked for a redraw. */
interface Harness {
  readonly catalog: SkillCatalog
  readonly changes: () => number
  readonly dispose: () => void
}

/**
 * Install a catalog over a context, scoped to one agent-shaped key.
 * @param ctx - the context carrying the optional registry.
 * @param scope - the viewing scope.
 * @returns the catalog and its teardown.
 */
function install(ctx: Context, scope: object = {}, session = Session.create(SessionId('skill-catalog-test'), undefined, {
  version: SESSION_FORMAT_VERSION, id: SessionId('skill-catalog-test'), createdAt: 0, cwd: CWD, isSeeded: false,
})): Harness {
  let changes = 0
  const catalog = new SkillCatalog({ ctx, scope, session, cwd: CWD, changed: () => { changes += 1 } })
  const stop = catalog.install()
  return { catalog, changes: () => changes, dispose: stop }
}

/**
 * Let the injected fiber load and every refresh it started settle.
 *
 * Macrotasks, not a fixed run of microtasks: `ctx.inject` loads its fiber
 * asynchronously and the refresh it triggers awaits a provider, so counting
 * ticks would encode this version of Cordis's scheduling into every case.
 */
async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
  }
}

describe('the registry lifecycle', () => {
  it('reports unavailable while no registry is mounted, and follows a late mount', async () => {
    const ctx = new Context()
    const provider = driven()
    provider.answer = () => [candidate('review-pr')]
    const { catalog, dispose } = install(ctx)
    try {
      await settle()
      expect(catalog.reading()).toEqual({ kind: 'unavailable' })
      // A one-shot `ctx.get('skills')` at attach time would still be reporting
      // `unavailable` after this line.
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(provider.plugin)
      await settle()
      expect(catalog.reading()).toMatchObject({ kind: 'ready' })
      expect(catalog.skills().map(skill => skill.name)).toEqual(['review-pr'])
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('forgets the catalog when the registry unmounts, and rebuilds it on remount', async () => {
    const ctx = new Context()
    const provider = driven()
    provider.answer = () => [candidate('review-pr')]
    const registry = await ctx.plugin(SkillRegistry)
    const mounted = await ctx.plugin(provider.plugin)
    const { catalog, dispose } = install(ctx)
    try {
      await settle()
      expect(catalog.skills()).toHaveLength(1)
      await mounted.dispose()
      await registry.dispose()
      await settle()
      // Not an empty agent and not a stale list: the capability is gone, and
      // saying anything else would advertise a composition that is not mounted.
      expect(catalog.reading()).toEqual({ kind: 'unavailable' })
      expect(catalog.skills()).toEqual([])
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(provider.plugin)
      await settle()
      expect(catalog.skills().map(skill => skill.name)).toEqual(['review-pr'])
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('answers from the remounted registry, not the one that went away', async () => {
    const ctx = new Context()
    const provider = driven()
    provider.answer = () => [candidate('old')]
    const first = await ctx.plugin(SkillRegistry)
    const mounted = await ctx.plugin(provider.plugin)
    const { catalog, dispose } = install(ctx)
    try {
      await settle()
      await expect(catalog.verify('old')).resolves.toMatchObject({ kind: 'user-invocable' })
      await mounted.dispose()
      await first.dispose()
      await settle()
      // The replacement composition contributes nothing, and its discovery is
      // held open until this case releases it — so the verdict below can only
      // come from the new registry finishing, never from what the old one
      // said.
      let release = (): void => {}
      provider.answer = async () => {
        await new Promise<void>(resolve => { release = resolve })
        return []
      }
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(provider.plugin)
      const verdict = catalog.verify('old')
      release()
      await expect(verdict).resolves.toEqual({ kind: 'unknown' })
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('reads the session cwd, not the process one', async () => {
    const ctx = new Context()
    const provider = driven()
    provider.answer = () => []
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(provider.plugin)
    const { dispose } = install(ctx)
    try {
      await settle()
      expect(provider.seen).toContain(CWD)
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('reads the viewing agent scope, so a preset-owned provider is visible', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const agent = {}
    const scope = createScope(ctx, agent)
    const scoped = driven('preset')
    scoped.answer = () => [candidate('preset-skill', { provider: 'preset' })]
    await scope.ctx.plugin(scoped.plugin)
    const viewer = install(ctx, agent)
    const blind = install(ctx, {})
    try {
      await settle()
      // The registry merges the global layer with the VIEWING scope's chain.
      // Omitting `scope` — or passing another agent — reads the global layer
      // alone, which is exactly how a preset's own skills go missing.
      expect(viewer.catalog.skills().map(skill => skill.name)).toEqual(['preset-skill'])
      expect(blind.catalog.skills()).toEqual([])
    } finally {
      viewer.dispose()
      blind.dispose()
      await scope.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('carries every invocation combination through unchanged', async () => {
    const ctx = new Context()
    const provider = driven()
    provider.answer = () => [
      candidate('both'),
      candidate('user-only', { invocation: { modelInvocable: false, userInvocable: true } }),
      candidate('model-only', { invocation: { modelInvocable: true, userInvocable: false } }),
      candidate('neither', { invocation: { modelInvocable: false, userInvocable: false } }),
    ]
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(provider.plugin)
    const { catalog, dispose } = install(ctx)
    try {
      await settle()
      expect(catalog.skills().map(skill => [skill.name, skill.userInvocable, skill.modelInvocable]))
        .toEqual([
          ['both', true, true],
          ['model-only', false, true],
          ['neither', false, false],
          ['user-only', true, false],
        ])
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('presents every discovery source the registry can report', async () => {
    const ctx = new Context()
    const provider = driven()
    provider.answer = () => [
      candidate('a', { source: 'project-agents' }),
      candidate('b', { source: 'user-dsh' }),
      candidate('c', { source: 'bundled' }),
      candidate('d', { source: 'custom' }),
      candidate('e', { source: 'marketplace' }),
    ]
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(provider.plugin)
    const { catalog, dispose } = install(ctx)
    try {
      await settle()
      expect(catalog.skills().map(skill => skill.source))
        .toEqual(['project-agents', 'user-dsh', 'bundled', 'custom', 'marketplace'])
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })
})

describe('completeness and last-good state', () => {
  it('keeps the last complete catalog when discovery cannot complete', async () => {
    const ctx = new Context()
    const provider = driven()
    provider.answer = () => [candidate('review-pr')]
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(provider.plugin)
    const { catalog, dispose } = install(ctx)
    try {
      await settle()
      expect(catalog.skills().map(skill => skill.name)).toEqual(['review-pr'])
      provider.answer = () => ({ candidates: [], complete: false })
      provider.control?.invalidate()
      await settle()
      // Flashing an empty list on a transient provider failure is the exact
      // behavior this contract exists to avoid.
      expect(catalog.skills().map(skill => skill.name)).toEqual(['review-pr'])
      expect(catalog.reading()).toMatchObject({ kind: 'ready' })
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('keeps the last complete catalog when a provider rejects', async () => {
    const ctx = new Context()
    const provider = driven()
    provider.answer = () => [candidate('review-pr')]
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(provider.plugin)
    const { catalog, dispose } = install(ctx)
    try {
      await settle()
      provider.answer = () => { throw new Error('provider is down') }
      provider.control?.invalidate()
      await settle()
      expect(catalog.skills().map(skill => skill.name)).toEqual(['review-pr'])
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('replaces the catalog once a later observation completes', async () => {
    const ctx = new Context()
    const provider = driven()
    provider.answer = () => ({ candidates: [candidate('half')], complete: false })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(provider.plugin)
    const { catalog, dispose } = install(ctx)
    try {
      await settle()
      // No last-good to fall back on, so the incomplete observation is shown
      // and is explicitly not authoritative.
      expect(catalog.reading()).toEqual({ kind: 'incomplete', skills: catalog.skills() })
      expect(catalog.skills().map(skill => skill.name)).toEqual(['half'])
      provider.answer = () => [candidate('whole')]
      provider.control?.invalidate()
      await settle()
      expect(catalog.reading()).toMatchObject({ kind: 'ready', stale: false })
      expect(catalog.skills().map(skill => skill.name)).toEqual(['whole'])
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('refetches on skills/change rather than polling', async () => {
    const ctx = new Context()
    const provider = driven()
    provider.answer = () => [candidate('one')]
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(provider.plugin)
    const { catalog, dispose } = install(ctx)
    try {
      await settle()
      const before = provider.seen.length
      provider.answer = () => [candidate('one'), candidate('two')]
      // The registry's own unfiltered invalidation, carrying no diff.
      provider.control?.invalidate()
      await settle()
      expect(provider.seen.length).toBeGreaterThan(before)
      expect(catalog.skills().map(skill => skill.name)).toEqual(['one', 'two'])
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('cannot be overwritten by a refresh a newer one already superseded', async () => {
    const ctx = new Context()
    const provider = driven()
    let release = (): void => {}
    provider.answer = async () => {
      await new Promise<void>(resolve => { release = resolve })
      return [candidate('slow')]
    }
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(provider.plugin)
    const { catalog, dispose } = install(ctx)
    try {
      // Let the mount's own refresh settle first, so the race below is between
      // two refreshes this case controls.
      release()
      await settle()
      const stale = catalog.refresh()
      const holdStale = release
      provider.answer = () => [candidate('fresh')]
      const fresh = catalog.refresh()
      await fresh
      expect(catalog.skills().map(skill => skill.name)).toEqual(['fresh'])
      holdStale()
      await stale
      // The older observation resolved last and still lost: generation, not
      // arrival order, decides which one is the catalog.
      expect(catalog.skills().map(skill => skill.name)).toEqual(['fresh'])
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })

  it('drops a refresh that settles after disposal', async () => {
    const ctx = new Context()
    const provider = driven()
    let release = (): void => {}
    provider.answer = async () => {
      await new Promise<void>(resolve => { release = resolve })
      return [candidate('late')]
    }
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(provider.plugin)
    const { catalog, dispose } = install(ctx)
    release()
    await settle()
    const pending = catalog.refresh()
    dispose()
    release()
    await pending
    expect(catalog.skills()).toEqual([])
    await ctx.fiber.dispose()
  })
})

describe('what the catalog will say about one name', () => {
  /**
   * A catalog over a ready registry.
   * @param answer - what the provider reports.
   * @returns the context, the catalog, the provider, and teardown.
   */
  async function ready(answer: Driven['answer']): Promise<{
    ctx: Context
    catalog: SkillCatalog
    provider: Driven
    stop: () => Promise<void>
  }> {
    const ctx = new Context()
    const provider = driven()
    provider.answer = answer
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(provider.plugin)
    const { catalog, dispose } = install(ctx)
    await settle()
    return {
      ctx,
      catalog,
      provider,
      stop: async () => {
        dispose()
        await ctx.fiber.dispose()
      },
    }
  }

  it('names a user-invocable skill', async () => {
    const { catalog, stop } = await ready(() => [candidate('review-pr')])
    await expect(catalog.verify('review-pr')).resolves.toMatchObject({ kind: 'user-invocable' })
    await stop()
  })

  it('refuses to spend a turn on a skill no person may invoke', async () => {
    const { catalog, stop } = await ready(() => [
      candidate('architecture', { invocation: { modelInvocable: true, userInvocable: false } }),
      candidate('sealed', { invocation: { modelInvocable: false, userInvocable: false } }),
    ])
    await expect(catalog.verify('architecture')).resolves.toMatchObject({ kind: 'not-user-invocable' })
    await expect(catalog.verify('sealed')).resolves.toMatchObject({ kind: 'not-user-invocable' })
    await stop()
  })

  it('calls an authoritative miss unknown', async () => {
    const { catalog, stop } = await ready(() => [candidate('help-me')])
    await expect(catalog.verify('hlep')).resolves.toEqual({ kind: 'unknown' })
    await stop()
  })

  it('refetches before declaring a name unknown against a stale catalog', async () => {
    const { catalog, provider, stop } = await ready(() => [])
    provider.answer = () => [candidate('just-added')]
    // The skill exists now; only dshline's copy is behind. Declaring it a typo
    // here is the stale negative this refetch exists to prevent.
    provider.control?.invalidate()
    await expect(catalog.verify('just-added')).resolves.toMatchObject({ kind: 'user-invocable' })
    await stop()
  })

  it('neither denies nor sends a name it cannot verify', async () => {
    const { catalog, provider, stop } = await ready(() => [])
    provider.answer = () => { throw new Error('provider is down') }
    provider.control?.invalidate()
    await expect(catalog.verify('maybe-a-skill')).resolves.toEqual({ kind: 'unverifiable' })
    await stop()
  })

  it('gives up on a provider that never answers rather than holding the line', async () => {
    const { catalog, provider, stop } = await ready(() => [])
    // Never settles on its own: only the caller's deadline can end this wait.
    provider.answer = async () => new Promise<never>(() => {})
    provider.control?.invalidate()
    await expect(catalog.verify('maybe-a-skill', AbortSignal.abort()))
      .resolves.toEqual({ kind: 'unverifiable' })
    await stop()
  })

  it('calls every name unknown while no registry is mounted', async () => {
    const ctx = new Context()
    const { catalog, dispose } = install(ctx)
    await settle()
    await expect(catalog.verify('review-pr')).resolves.toEqual({ kind: 'unknown' })
    dispose()
    await ctx.fiber.dispose()
  })
})

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Composer, stripAnsi } from '@dshline/renderer'
import { createCompletion } from '../src/completion.ts'
import type { LocalCommandChoice } from '../src/local-commands.ts'
import { ModelCompletionCatalog, watchModelCompletion } from '../src/model-completion.ts'
import { modelCompletionValues, readModelCompletion } from '../src/model.ts'
import type { ModelCompletionReading } from '../src/model.ts'
import { createModelCompletionCatalog } from '../src/window.ts'

/** One candidate, for a test that does not care what it says. */
function choice(value: string): LocalCommandChoice {
  return { value }
}

/** Let queued microtasks run, so a read started by a loop has begun. */
async function settled(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

/**
 * One deferred read per call, addressed by call number.
 * @returns the call numbers in order, the read, and its settle/reject controls.
 */
function deferredRead(): {
  calls: number[]
  read: () => Promise<ModelCompletionReading>
  resolve: (call: number, values: readonly LocalCommandChoice[], complete?: boolean) => void
  reject: (call: number, error: unknown) => void
} {
  const calls: number[] = []
  const pending = new Map<number, {
    resolve: (reading: ModelCompletionReading) => void
    reject: (error: unknown) => void
  }>()
  let sequence = 0
  const read = (): Promise<ModelCompletionReading> => {
    sequence += 1
    const call = sequence
    calls.push(call)
    return new Promise((resolve, reject) => { pending.set(call, { resolve, reject }) })
  }
  return {
    calls,
    read,
    resolve: (call, values, complete = true) => { pending.get(call)?.resolve({ values, complete }) },
    reject: (call, error) => { pending.get(call)?.reject(error) },
  }
}

/** A `{ on, emit }` pair with the shape the watcher subscribes through. */
function eventBus(): {
  on: (name: string, listener: (...args: unknown[]) => void) => () => void
  emit: (name: string, ...args: unknown[]) => void
} {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  return {
    on: (name, listener) => {
      const set = listeners.get(name) ?? new Set()
      set.add(listener)
      listeners.set(name, set)
      return () => { set.delete(listener) }
    },
    emit: (name, ...args) => {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(...args)
    },
  }
}

/** A provider→models fixture, the shape the registry and the picker use. */
const CATALOG: Record<string, readonly { id: string; name: string }[]> = {
  'deepseek-official': [
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  ],
  opencode: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
}

/**
 * A fake llm registry that counts work and settles only when told to, plus an
 * event bus the watcher can subscribe through.
 * @param providers - route keys `listProviders()` reports.
 * @returns the context, the counters, the bus, and per-round settle controls.
 */
function deferredLlm(providers: readonly string[]): {
  ctx: Context
  bus: ReturnType<typeof eventBus>
  providerReads: number[]
  modelReads: string[]
  effects: (() => void)[]
  settle: (provider: string, models: readonly { id: string; name: string }[]) => void
  fail: (provider: string, error: unknown) => void
  settleAll: (models: Record<string, readonly { id: string; name: string }[]>) => void
} {
  const bus = eventBus()
  const providerReads: number[] = []
  const modelReads: string[] = []
  /** Window-scope disposers the catalog factory registered through `ctx.effect`. */
  const effects: (() => void)[] = []
  const pending: {
    provider: string
    resolve: (models: readonly { id: string; name: string }[]) => void
    reject: (error: unknown) => void
  }[] = []
  const take = (provider: string): (typeof pending)[number] | undefined => {
    const index = pending.findIndex(entry => entry.provider === provider)
    return index < 0 ? undefined : pending.splice(index, 1)[0]
  }
  const ctx = {
    llm: {
      listProviders: () => {
        providerReads.push(1)
        return providers.map(id => ({ id, name: id }))
      },
      listModels: (provider: string) => {
        modelReads.push(provider)
        return new Promise<readonly { id: string; name: string }[]>((resolve, reject) => {
          pending.push({ provider, resolve, reject })
        })
      },
    },
    on: bus.on,
    // The window owner registers the catalog's subscriptions and disposal with
    // the plugin fiber; the fake runs the callback once and keeps its disposer.
    effect: (callback: () => (() => void) | void) => {
      const dispose = callback()
      if (typeof dispose === 'function') effects.push(dispose)
    },
  } as unknown as Context
  return {
    ctx,
    bus,
    providerReads,
    modelReads,
    effects,
    settle: (provider, models) => { take(provider)?.resolve(models) },
    fail: (provider, error) => { take(provider)?.reject(error) },
    settleAll: models => {
      for (const provider of Object.keys(models)) take(provider)?.resolve(models[provider] ?? [])
    },
  }
}

/** An llm registry that answers immediately, for the uncached reference path. */
function immediateLlm(models: Record<string, readonly { id: string; name: string }[]>): Context {
  return {
    llm: {
      listProviders: () => Object.keys(models).map(id => ({ id, name: id })),
      listModels: async (provider: string) => models[provider] ?? [],
    },
  } as unknown as Context
}

describe('ModelCompletionCatalog', () => {
  it('does not read until the first request', () => {
    const arena = deferredRead()
    new ModelCompletionCatalog(arena.read)
    expect(arena.calls).toEqual([])
  })

  it('serves every concurrent caller from one in-flight read', async () => {
    const arena = deferredRead()
    const catalog = new ModelCompletionCatalog(arena.read)
    const first = catalog.completions()
    const second = catalog.completions()
    const third = catalog.completions()
    expect(arena.calls).toEqual([1])

    const values = [choice('a')]
    arena.resolve(1, values)
    expect(await first).toBe(values)
    expect(await second).toBe(values)
    expect(await third).toBe(values)
    expect(arena.calls).toEqual([1])
  })

  it('serves later requests from the cache without reading again', async () => {
    const arena = deferredRead()
    const catalog = new ModelCompletionCatalog(arena.read)
    const running = catalog.completions()
    const values = [choice('a')]
    arena.resolve(1, values)
    expect(await running).toBe(values)

    for (let index = 0; index < 5; index += 1) expect(await catalog.completions()).toBe(values)
    expect(arena.calls).toEqual([1])
  })

  it('starts a fresh read after invalidation and does not join the stale one', async () => {
    const arena = deferredRead()
    const catalog = new ModelCompletionCatalog(arena.read)
    const before = catalog.completions()
    expect(arena.calls).toEqual([1])

    catalog.invalidate()
    const after = catalog.completions()
    expect(arena.calls).toEqual([1, 2])

    const stale = [choice('stale')]
    const fresh = [choice('fresh')]
    arena.resolve(1, stale)
    arena.resolve(2, fresh)
    expect(await after).toBe(fresh)
    expect(await catalog.completions()).toBe(fresh)
    // The caller that straddled the invalidation is owed the new generation too.
    expect(await before).toBe(fresh)
    expect(arena.calls).toEqual([1, 2])
  })

  it('does not install a read that straddled an invalidation', async () => {
    const arena = deferredRead()
    const catalog = new ModelCompletionCatalog(arena.read)
    const straddled = catalog.completions()
    catalog.invalidate()
    arena.resolve(1, [choice('stale')])
    await settled()
    // The stale read did not become current; the caller looped onto a new one.
    expect(arena.calls).toEqual([1, 2])

    const fresh = [choice('fresh')]
    arena.resolve(2, fresh)
    expect(await straddled).toBe(fresh)
    expect(await catalog.completions()).toBe(fresh)
  })

  it('retries when an invalidated read rejects instead of reporting the stale failure', async () => {
    const arena = deferredRead()
    const catalog = new ModelCompletionCatalog(arena.read)
    const straddled = catalog.completions()
    catalog.invalidate()
    arena.reject(1, new Error('stale failure'))
    await settled()
    // The failure belonged to a generation that no longer exists, so the caller
    // moved onto a new read rather than surfacing it.
    expect(arena.calls).toEqual([1, 2])

    const fresh = [choice('fresh')]
    arena.resolve(2, fresh)
    expect(await straddled).toBe(fresh)
  })

  it('keeps only the newest of several overlapping generations', async () => {
    const arena = deferredRead()
    const catalog = new ModelCompletionCatalog(arena.read)
    const first = catalog.completions()
    catalog.invalidate()
    const second = catalog.completions()
    catalog.invalidate()
    const third = catalog.completions()
    expect(arena.calls).toEqual([1, 2, 3])

    const newest = [choice('newest')]
    arena.resolve(1, [choice('one')])
    arena.resolve(2, [choice('two')])
    arena.resolve(3, newest)
    expect(await first).toBe(newest)
    expect(await second).toBe(newest)
    expect(await third).toBe(newest)
    expect(await catalog.completions()).toBe(newest)
  })

  it('abandons an in-flight read when disposed and never installs its result', async () => {
    const arena = deferredRead()
    const catalog = new ModelCompletionCatalog(arena.read)
    const pending = catalog.completions()
    catalog.dispose()
    arena.resolve(1, [choice('late')])
    expect(await pending).toEqual([])
    expect(await catalog.completions()).toEqual([])
    expect(arena.calls).toEqual([1])
  })

  it('drops the cached reading on dispose without starting another read', async () => {
    const arena = deferredRead()
    const catalog = new ModelCompletionCatalog(arena.read)
    const running = catalog.completions()
    const values = [choice('a')]
    arena.resolve(1, values)
    expect(await running).toBe(values)

    catalog.dispose()
    expect(await catalog.completions()).toEqual([])
    expect(arena.calls).toEqual([1])
  })

  it('does not cache a rejected read, so the next request retries', async () => {
    const arena = deferredRead()
    const catalog = new ModelCompletionCatalog(arena.read)
    const failed = catalog.completions()
    arena.reject(1, new Error('registry down'))
    await expect(failed).rejects.toThrow('registry down')

    const retry = catalog.completions()
    expect(arena.calls).toEqual([1, 2])
    const values = [choice('a')]
    arena.resolve(2, values)
    expect(await retry).toBe(values)
  })

  it('does not cache a partial reading, so a failed route is retried', async () => {
    const arena = deferredRead()
    const catalog = new ModelCompletionCatalog(arena.read)
    const partial = catalog.completions()
    arena.resolve(1, [choice('healthy')], false)
    expect(await partial).toEqual([choice('healthy')])

    // The route that failed is absent from that reading, so it must not become
    // the standing answer: the next request reads again.
    const retry = catalog.completions()
    expect(arena.calls).toEqual([1, 2])
    const complete = [choice('healthy'), choice('recovered')]
    arena.resolve(2, complete)
    expect(await retry).toBe(complete)
    expect(await catalog.completions()).toBe(complete)
  })
})

describe('upstream work across completion refreshes', () => {
  it('reads every provider once across repeated refreshes in one generation', async () => {
    const arena = deferredLlm(['deepseek-official', 'opencode'])
    const catalog = new ModelCompletionCatalog(() => readModelCompletion(arena.ctx))
    const running = catalog.completions()
    // Started synchronously: both route reads are in flight before either lands.
    expect(arena.providerReads).toHaveLength(1)
    expect(arena.modelReads).toEqual(['deepseek-official', 'opencode'])

    arena.settleAll(CATALOG)
    const values = await running
    for (let index = 0; index < 5; index += 1) expect(await catalog.completions()).toBe(values)
    // P reads for one generation, not R x P.
    expect(arena.providerReads).toHaveLength(1)
    expect(arena.modelReads).toHaveLength(2)
  })

  it('shares one discovery across concurrent refreshes', async () => {
    const arena = deferredLlm(['deepseek-official', 'opencode'])
    const catalog = new ModelCompletionCatalog(() => readModelCompletion(arena.ctx))
    const first = catalog.completions()
    const second = catalog.completions()
    expect(arena.modelReads).toHaveLength(2)

    arena.settleAll(CATALOG)
    expect(await first).toBe(await second)
  })

  it('refetches after llm/adapters-updated, and only lazily', async () => {
    const arena = deferredLlm(['deepseek-official'])
    const catalog = new ModelCompletionCatalog(() => readModelCompletion(arena.ctx))
    const stop = watchModelCompletion(arena.ctx, catalog)
    try {
      const first = catalog.completions()
      arena.settleAll({ 'deepseek-official': [{ id: 'a', name: '' }] })
      expect(await first).toHaveLength(1)
      expect(arena.modelReads).toHaveLength(1)

      arena.bus.emit('llm/adapters-updated')
      // The event discards; it does not read. The next request is what refetches.
      expect(arena.modelReads).toHaveLength(1)

      const next = catalog.completions()
      expect(arena.modelReads).toHaveLength(2)
      arena.settleAll({ 'deepseek-official': [{ id: 'b', name: '' }] })
      expect((await next).map(entry => entry.value)).toEqual(['deepseek-official/b'])

      // A removed subscription leaves the snapshot alone.
      stop()
      arena.bus.emit('llm/adapters-updated')
      expect(arena.modelReads).toHaveLength(2)
    } finally {
      stop()
    }
  })

  it('refetches after settings/document-updated', async () => {
    const arena = deferredLlm(['deepseek-official'])
    const catalog = new ModelCompletionCatalog(() => readModelCompletion(arena.ctx))
    const stop = watchModelCompletion(arena.ctx, catalog)
    try {
      const first = catalog.completions()
      arena.settleAll({ 'deepseek-official': [{ id: 'a', name: '' }] })
      expect(await first).toHaveLength(1)

      arena.bus.emit('settings/document-updated', 'llm-deepseek', 1)
      const next = catalog.completions()
      expect(arena.modelReads).toHaveLength(2)
      arena.settleAll({ 'deepseek-official': [{ id: 'b', name: '' }] })
      expect((await next).map(entry => entry.value)).toEqual(['deepseek-official/b'])
    } finally {
      stop()
    }
  })

  it('refetches for a settings change in any entry, not only the route’s own', async () => {
    // `settings/updated` announced a RESOLVED-VALUE commit, so a consumer could
    // afford to be picky; `settings/document-updated` announces a raw entry
    // change and is not value-gated, and it does not say which entry moved
    // anything relevant. A profile edit to a route is exactly this event, and
    // guessing from the namespace would be a guess.
    const arena = deferredLlm(['deepseek-official'])
    const catalog = new ModelCompletionCatalog(() => readModelCompletion(arena.ctx))
    const stop = watchModelCompletion(arena.ctx, catalog)
    try {
      const first = catalog.completions()
      arena.settleAll({ 'deepseek-official': [{ id: 'a', name: '' }] })
      const values = await first
      expect(arena.modelReads).toHaveLength(1)

      arena.bus.emit('settings/document-updated', 'some-other-plugin', 7)
      const next = catalog.completions()
      expect(arena.modelReads).toHaveLength(2)
      arena.settleAll({ 'deepseek-official': [{ id: 'b', name: '' }] })
      expect((await next).map(entry => entry.value)).toEqual(['deepseek-official/b'])
      expect(await catalog.completions()).not.toBe(values)
    } finally {
      stop()
    }
  })

  it('does not refetch for events that cannot change catalog membership', async () => {
    const arena = deferredLlm(['deepseek-official'])
    const catalog = new ModelCompletionCatalog(() => readModelCompletion(arena.ctx))
    const stop = watchModelCompletion(arena.ctx, catalog)
    try {
      const first = catalog.completions()
      arena.settleAll({ 'deepseek-official': [{ id: 'a', name: '' }] })
      const values = await first

      // Credentials gate authentication on the request path, not which models a
      // route advertises. The settings feed is deliberately absent: it is the
      // raw entry change the two cases above cover.
      arena.bus.emit('credentials/reference-updated', 'ref')
      arena.bus.emit('credentials/record-updated', 'key')
      expect(await catalog.completions()).toBe(values)
      expect(arena.modelReads).toHaveLength(1)
    } finally {
      stop()
    }
  })

  it('keeps the healthy routes when one provider fails, and retries the failed one', async () => {
    const arena = deferredLlm(['deepseek-official', 'opencode'])
    const catalog = new ModelCompletionCatalog(() => readModelCompletion(arena.ctx))
    const running = catalog.completions()
    arena.fail('deepseek-official', new Error('route down'))
    arena.settle('opencode', [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }])

    const values = await running
    expect(values).toEqual([
      { value: 'opencode/deepseek-v4-pro', aliases: ['deepseek-v4-pro'], note: 'DeepSeek V4 Pro' },
    ])
    // The reading was partial, so it was not cached: the next request retries
    // the failed route instead of reusing a list that is missing it.
    expect(arena.modelReads).toHaveLength(2)
    const retry = catalog.completions()
    expect(arena.modelReads).toHaveLength(4)
    arena.settleAll({
      'deepseek-official': [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
      opencode: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
    })
    expect((await retry).map(entry => entry.value)).toEqual([
      'deepseek-official/deepseek-v4-pro',
      'opencode/deepseek-v4-pro',
    ])
  })

  it('caches an empty provider list without reading a route', async () => {
    const arena = deferredLlm([])
    const catalog = new ModelCompletionCatalog(() => readModelCompletion(arena.ctx))
    const values = await catalog.completions()
    expect(values).toEqual([])
    expect(arena.providerReads).toHaveLength(1)
    expect(arena.modelReads).toEqual([])
    expect(await catalog.completions()).toBe(values)
  })

  it('treats a provider with zero models as offering none, not as failed', async () => {
    const arena = deferredLlm(['empty', 'opencode'])
    const catalog = new ModelCompletionCatalog(() => readModelCompletion(arena.ctx))
    const running = catalog.completions()
    arena.settleAll({ empty: [], opencode: [{ id: 'm', name: 'M' }] })
    expect((await running).map(entry => entry.value)).toEqual(['opencode/m'])
  })

  it('publishes exactly what the uncached discovery publishes', async () => {
    const expected = await modelCompletionValues(immediateLlm(CATALOG))
    const arena = deferredLlm(['deepseek-official', 'opencode'])
    const catalog = new ModelCompletionCatalog(() => readModelCompletion(arena.ctx))
    const running = catalog.completions()
    arena.settleAll(CATALOG)

    const values = await running
    expect(values).toEqual(expected)
    // Order, aliases, and notes, pinned explicitly rather than by deep equality.
    expect(values.map(entry => entry.value)).toEqual([
      'deepseek-official/deepseek-v4-flash',
      'deepseek-official/deepseek-v4-pro',
      'opencode/deepseek-v4-pro',
    ])
    expect(values[0]?.note).toBeUndefined()
    expect(values[2]?.aliases).toEqual(['deepseek-v4-pro'])
    expect(values[2]?.note).toBe('DeepSeek V4 Pro')
  })

  it('renders the same /model argument rows as the uncached path', async () => {
    const ctx = immediateLlm(CATALOG)
    const catalog = new ModelCompletionCatalog(() => readModelCompletion(ctx))
    /** Type an argument token and render whatever completion offers. */
    const render = async (
      commandArguments: () => Promise<readonly LocalCommandChoice[]>,
    ): Promise<string[]> => {
      const composer = new Composer()
      composer.handle({ kind: 'text', text: '/model deepseek-v4' })
      const completion = createCompletion(composer, {
        commands: () => [{ name: 'model', description: 'pick a model' }],
        commandArguments,
        paths: async () => [],
      }, () => {})
      await completion.refresh()
      return completion.view.render(80).map(stripAnsi)
    }

    const cached = await render(() => catalog.completions())
    const direct = await render(() => modelCompletionValues(ctx))
    expect(cached).toEqual(direct)
    expect(cached.join('\n')).toContain('deepseek-official/deepseek-v4-pro')
  })
})

describe('the window-owned completion catalog', () => {
  it('reuses one snapshot across session attachments and refetches only on Harness invalidation', async () => {
    const arena = deferredLlm(['deepseek-official', 'opencode'])
    const catalog = createModelCompletionCatalog(arena.ctx)

    // Session A asks for `/model`'s values: one provider enumeration.
    const inSessionA = catalog.completions()
    arena.settleAll(CATALOG)
    const first = await inSessionA
    expect(arena.providerReads).toHaveLength(1)
    expect(arena.modelReads).toHaveLength(2)

    // Session B attaches to the SAME window and asks again. The catalog is the
    // window's, so the switch itself is not an invalidation: cached, no reads.
    expect(await catalog.completions()).toBe(first)
    expect(arena.providerReads).toHaveLength(1)
    expect(arena.modelReads).toHaveLength(2)

    // Only a Harness event discards the snapshot.
    arena.bus.emit('settings/document-updated', 'llm-deepseek', 1)
    const afterEvent = catalog.completions()
    expect(arena.providerReads).toHaveLength(2)
    expect(arena.modelReads).toHaveLength(4)
    arena.settleAll(CATALOG)
    expect(await afterEvent).not.toBe(first)

    // Window teardown removes the subscriptions and disposes the snapshot.
    for (const dispose of arena.effects) dispose()
    arena.bus.emit('settings/document-updated', 'llm-deepseek', 2)
    expect(await catalog.completions()).toEqual([])
    expect(arena.providerReads).toHaveLength(2)
    expect(arena.modelReads).toHaveLength(4)
  })
})

describe('catalog ownership', () => {
  /** Source of one module, for the structural ownership check. */
  const source = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

  it('lives on the window and is consumed by attachments, never rebuilt per session', () => {
    const attachment = source('../src/attachment.ts')
    const window = source('../src/window.ts')
    // Every attachment reads the window's one catalog and constructs none.
    expect(attachment).toContain('w.modelCompletionValues()')
    expect(attachment).not.toContain('new ModelCompletionCatalog')
    expect(attachment).not.toContain('watchModelCompletion')
    // The window constructs it, with the subscriptions and disposal it owns.
    expect(window).toContain('createModelCompletionCatalog')
    expect(window).toContain('new ModelCompletionCatalog')
    expect(window).toContain('watchModelCompletion')
  })
})

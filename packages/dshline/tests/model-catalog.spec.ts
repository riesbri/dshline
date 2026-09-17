/**
 * The shared native model-catalog read.
 *
 * `/model` and the subagent authorization editor project from this one read, so
 * these tests pin the properties both depend on: every provider read begins
 * before any is awaited, `listProviders()` order survives settlement order, a
 * provider-local failure never rejects the whole catalog, and the raw shape
 * carries the exact route beside both display names.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { modelRouteKey, readModelCatalog } from '../src/model-catalog.ts'

/** One provider as the registry reports it. */
type Provider = { id: string; name: string }

/** One model as a provider reports it. */
type Model = { id: string; name: string }

/**
 * A context whose route catalogs settle only when the test says so.
 * @param providers - the routes to advertise, in order.
 * @returns the context and controls over each route's listing.
 */
function deferredContext(providers: readonly Provider[]): {
  ctx: Context
  called: string[]
  settle: (provider: string, models: readonly Model[]) => void
  fail: (provider: string, error: Error) => void
} {
  const called: string[] = []
  const pending = new Map<string, { resolve: (models: readonly Model[]) => void; reject: (error: Error) => void }>()
  const ctx = {
    llm: {
      listProviders: () => providers.map(provider => ({ ...provider })),
      listModels: (provider: string) => {
        called.push(provider)
        return new Promise<readonly Model[]>((resolve, reject) => { pending.set(provider, { resolve, reject }) })
      },
    },
  } as unknown as Context
  return {
    ctx,
    called,
    settle: (provider, models) => { pending.get(provider)?.resolve(models) },
    fail: (provider, error) => { pending.get(provider)?.reject(error) },
  }
}

/** Let a macrotask turn, so a promise that will not settle is distinguishable. */
async function settled(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

const PROVIDERS: readonly Provider[] = [
  { id: 'deepseek-official', name: 'DeepSeek' },
  { id: 'opencode', name: 'opencode' },
]

describe('modelRouteKey()', () => {
  it('keys one exact route with an opaque provider/model identity', () => {
    expect(modelRouteKey('a', 'b')).toBe('a\u0000b')
    // The separator is not a character an id can contain, so a slash inside
    // either half cannot make two different routes share a key.
    expect(modelRouteKey('a/b', 'c')).not.toBe(modelRouteKey('a', 'b/c'))
    expect(modelRouteKey('a', 'b')).not.toBe(modelRouteKey('a', 'b/c'))
  })
})

describe('readModelCatalog()', () => {
  it('begins every provider read before awaiting any, and keeps listProviders order', async () => {
    const arena = deferredContext(PROVIDERS)
    const running = readModelCatalog(arena.ctx)
    // Both reads were started synchronously; neither awaited the other.
    expect(arena.called).toEqual(['deepseek-official', 'opencode'])

    let landed = false
    void running.then(() => { landed = true })
    arena.settle('opencode', [{ id: 'later', name: 'Later' }])
    await settled()
    // The first route is still outstanding, so settlement order cannot be what
    // decides the result.
    expect(landed).toBe(false)

    arena.settle('deepseek-official', [{ id: 'earlier', name: 'Earlier' }])
    const reading = await running
    expect(reading.routes.map(route => `${route.provider}/${route.model}`)).toEqual([
      'deepseek-official/earlier',
      'opencode/later',
    ])
  })

  it('records a provider-local failure and never rejects the whole catalog', async () => {
    const arena = deferredContext(PROVIDERS)
    const running = readModelCatalog(arena.ctx)
    arena.fail('deepseek-official', new Error('route down'))
    arena.settle('opencode', [{ id: 'survivor', name: 'Survivor' }])
    const reading = await running
    expect(reading.failedProviders).toEqual(['deepseek-official'])
    expect(reading.routes).toEqual([
      { provider: 'opencode', providerName: 'opencode', model: 'survivor', modelName: 'Survivor' },
    ])
  })

  it('names every failed provider in provider order when none answers', async () => {
    const arena = deferredContext(PROVIDERS)
    const running = readModelCatalog(arena.ctx)
    arena.fail('opencode', new Error('down'))
    arena.fail('deepseek-official', new Error('down'))
    const reading = await running
    expect(reading.failedProviders).toEqual(['deepseek-official', 'opencode'])
    expect(reading.routes).toEqual([])
  })

  it('carries the exact route beside both provider and model display names', async () => {
    const arena = deferredContext([{ id: 'deepseek-official', name: 'DeepSeek' }])
    const running = readModelCatalog(arena.ctx)
    arena.settle('deepseek-official', [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }])
    const reading = await running
    expect(reading.routes).toEqual([{
      provider: 'deepseek-official',
      providerName: 'DeepSeek',
      model: 'deepseek-v4-pro',
      modelName: 'DeepSeek V4 Pro',
    }])
  })
})

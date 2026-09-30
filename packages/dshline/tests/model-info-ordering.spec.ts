/** The latest selected model alone may describe the window's capabilities. */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { pricingFrom } from '../src/usage.ts'
import { createWindow } from '../src/window.ts'

vi.mock('@dshline/renderer', async importOriginal => {
  const renderer = await importOriginal<typeof import('@dshline/renderer')>()
  return {
    ...renderer,
    acquireTerminal: () => ({
      columns: () => 80,
      rows: () => 24,
      write: () => {},
      setTitle: () => {},
      onKey: () => () => {},
      onResize: () => () => {},
      close: () => {},
    }),
  }
})

/** Let promises scheduled by `refreshModelInfo` start and settle. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('model metadata ordering', () => {
  it('does not let an older lookup overwrite the latest selected model', async () => {
    let resolveA: ((value: unknown) => void) | undefined
    let resolveB: ((value: unknown) => void) | undefined
    const llm = {
      resolveModelInfo: vi.fn((_provider: string, model: string) => new Promise(resolve => {
        if (model === 'a') resolveA = resolve
        else resolveB = resolve
      })),
    }
    const prefs = { current: () => 'queue' as const, watch: () => () => {}, save: async () => {} }
    const ctx = {
      get: (name: string) => name === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'test', model: 'a' }) }
        : undefined,
      tuiStartup: { options: { cwd: '/ws', task: undefined, resume: undefined } },
      tuiSlots: { compose: () => ({ lines: [], cursor: undefined }), invalidate: vi.fn() },
      llm,
      effect: (setup: () => (() => void) | void) => { setup() },
      on: () => () => {},
    } as unknown as Context

    const window = await createWindow(ctx, {
      pricing: pricingFrom(undefined),
      peakHours: [],
      version: 'test',
      settings: { theme: { current: () => 'default', watch: () => () => {}, save: async () => {} }, busyEnter: prefs },
    })
    window.selection.current = { provider: 'test', model: 'b' }
    window.refreshModelInfo()

    resolveB?.({ context: { contextWindow: 200 }, reasoning: { levels: ['low'] }, inputModalities: ['text', 'image'] })
    await settle()
    resolveA?.({ context: { contextWindow: 100 }, reasoning: undefined, inputModalities: ['text'] })
    await settle()

    expect(window.modelInfo).toEqual({
      contextWindow: 200,
      reasoning: { levels: ['low'] },
      inputModalities: ['text', 'image'],
    })
  })
})

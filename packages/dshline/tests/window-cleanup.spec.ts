/** Window ownership must reach Terminal even when Screen's final write fails. */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { TerminalStreams } from '@dshline/renderer'
import { createWindow } from '../src/window.ts'
import { pricingFrom } from '../src/usage.ts'

const sink = vi.hoisted(() => ({ streams: undefined as TerminalStreams | undefined }))
vi.mock('@dshline/renderer', async importOriginal => {
  const original = await importOriginal<typeof import('@dshline/renderer')>()
  return { ...original, acquireTerminal: () => original.acquireTerminal(sink.streams!) }
})
vi.mock('../src/stderr.ts', () => ({ holdStderrOffTerminal: () => () => {} }))

afterEach(() => { vi.restoreAllMocks() })

/** Run real window effects against controllable streams, retaining their teardown errors. */
function fixture(themeFailure?: Error) {
  let raw = false
  let paused = true
  let failWrites = false
  const failure = new Error('window sink failed')
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    get isRaw() { return raw },
    setRawMode(value: boolean) { raw = value },
    setEncoding() {}, resume() { paused = false }, pause() { paused = true },
  })
  const written: string[] = []
  const output = Object.assign(new EventEmitter(), {
    isTTY: true, columns: 80, rows: 24,
    write(chunk: string) { if (failWrites) throw failure; written.push(chunk); return true },
  })
  sink.streams = { input, output } as unknown as TerminalStreams
  const effects = new Map<string, () => void>()
  const ctx = {
    tuiStartup: { options: { cwd: '/workspace' } },
    tuiSlots: { compose: () => ({ lines: [], cursor: undefined }) },
    get: () => undefined,
    on: () => () => {},
    effect: (install: () => () => void, label: string) => {
      const dispose = install()
      effects.set(label, dispose)
      return dispose
    },
  } as unknown as Context
  const preference = <T>(value: T) => ({ current: () => value, watch: () => () => {}, save: async () => {} })
  const opening = createWindow(ctx, {
    pricing: pricingFrom(undefined), peakHours: [], version: 'test',
    settings: {
      theme: {
        ...preference('default'),
        current: () => { if (themeFailure !== undefined) throw themeFailure; return 'default' },
      },
      busyEnter: preference('queue' as const),
    },
  })
  return {
    opening, input, output, written, failure, effects,
    fail: (value: boolean) => { failWrites = value },
    isRaw: () => raw, isPaused: () => paused,
  }
}

describe('window terminal cleanup', () => {
  it('owns raw-mode cleanup before palette setup can fail', async () => {
    const failure = new Error('theme read failed')
    const fake = fixture(failure)
    await expect(fake.opening).rejects.toBe(failure)
    const cleanup = fake.effects.get('dshline: terminal ownership')
    expect(cleanup).toBeDefined()
    cleanup?.()
    expect(fake.isRaw()).toBe(false)
    expect(fake.isPaused()).toBe(true)
    expect(fake.input.listenerCount('data')).toBe(0)
    expect(fake.output.listenerCount('resize')).toBe(0)
    for (const [label, dispose] of fake.effects) {
      if (label !== 'dshline: terminal ownership') dispose()
    }
  })

  it('restores raw mode and removes stream listeners when Screen.close throws', async () => {
    const fake = fixture()
    await fake.opening
    const cleanup = fake.effects.get('dshline: terminal ownership')!
    fake.fail(true)
    try {
      expect(() => cleanup()).toThrow()
      expect(fake.isRaw()).toBe(false)
      expect(fake.isPaused()).toBe(true)
      expect(fake.input.listenerCount('data')).toBe(0)
      expect(fake.output.listenerCount('resize')).toBe(0)
    } finally {
      fake.fail(false)
      for (const dispose of [...fake.effects.values()].reverse()) dispose()
    }
  })

  it('reports both shutdown write failures rather than replacing the Screen failure', async () => {
    const fake = fixture()
    await fake.opening
    const cleanup = fake.effects.get('dshline: terminal ownership')!
    fake.fail(true)
    let caught: unknown
    try { cleanup() } catch (error: unknown) { caught = error }
    fake.fail(false)
    try {
      expect(caught).toBeInstanceOf(AggregateError)
      expect((caught as AggregateError).errors).toEqual([fake.failure, fake.failure])
      expect(fake.isRaw()).toBe(false)
    } finally {
      for (const dispose of [...fake.effects.values()].reverse()) dispose()
    }
  })

  it('stops a pending paint before releasing terminal ownership', async () => {
    const fake = fixture()
    const window = await fake.opening
    window.draw()
    fake.effects.get('dshline: terminal ownership')!()
    const written = [...fake.written]
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(fake.written).toEqual(written)
    expect(fake.isRaw()).toBe(false)
    expect(fake.input.listenerCount('data')).toBe(0)
    expect(fake.output.listenerCount('resize')).toBe(0)
    for (const [label, dispose] of [...fake.effects.entries()].reverse()) {
      if (label !== 'dshline: terminal ownership') dispose()
    }
  })
})

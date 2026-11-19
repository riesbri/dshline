import { setImmediate as nextInput } from 'node:timers/promises'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { replayTranscript } from '../src/transcript-replay.ts'

/** @param count - log size. @returns immutable synthetic log events. */
function log(count: number): readonly SessionEvent[] {
  return Array.from({ length: count }, (_, seq) => ({ seq, type: 'fixture', data: {}, time: seq }) as unknown as SessionEvent)
}

describe('cooperative transcript replay', () => {
  it('yields to input and bounds commits without dropping or reordering rows', async () => {
    const source = log(300)
    const batches: string[][] = []
    let projected = 0
    let observedAtInput = 0
    const ready = vi.fn()
    const task = replayTranscript({
      snapshot: () => source,
      signal: new AbortController().signal,
      project: event => { projected += 1; return [`${String(event.seq)}:${'x'.repeat(180)}`, 'tail'] },
      commit: rows => { batches.push([...rows]) },
      historicalEnd: () => {}, ready,
    })
    await nextInput()
    observedAtInput = projected
    expect(observedAtInput).toBeGreaterThan(0)
    expect(observedAtInput).toBeLessThan(300)
    expect(await task).toBe(true)
    expect(batches.flat()).toEqual(source.flatMap(event => [`${String(event.seq)}:${'x'.repeat(180)}`, 'tail']))
    expect(batches.every(rows => rows.length <= 128 && rows.join('').length <= 32768)).toBe(true)
    expect(ready).toHaveBeenCalledOnce()
  })

  it('also yields for structural events that draw no rows', async () => {
    let processed = 0
    const task = replayTranscript({
      snapshot: () => log(400), signal: new AbortController().signal,
      project: () => { processed += 1; return [] }, commit: () => {}, historicalEnd: () => {}, ready: () => {},
    })
    await nextInput()
    expect(processed).toBeLessThan(400)
    expect(await task).toBe(true)
  })

  it('catches up appends after the historical prefix without a second event queue', async () => {
    let source = log(100)
    const projected: Array<{ seq: number; historical: boolean }> = []
    const order: string[] = []
    const task = replayTranscript({
      snapshot: () => source, signal: new AbortController().signal,
      project: (event, historical) => { projected.push({ seq: event.seq, historical }); return [String(event.seq)] },
      commit: rows => { order.push(...rows) },
      historicalEnd: () => { order.push('history-end') },
      ready: () => { order.push('ready') },
    })
    await nextInput()
    source = log(105)
    expect(await task).toBe(true)
    expect(projected).toEqual(Array.from({ length: 105 }, (_, seq) => ({ seq, historical: seq < 100 })))
    expect(order.indexOf('history-end')).toBeLessThan(order.indexOf('100'))
    expect(order.at(-1)).toBe('ready')
  })

  it('cancels before another projection or write when retirement races a commit', async () => {
    const controller = new AbortController()
    const project = vi.fn(event => [String(event.seq)])
    const commit = vi.fn(() => { controller.abort() })
    const ready = vi.fn()
    const historicalEnd = vi.fn()
    expect(await replayTranscript({
      snapshot: () => log(500), signal: controller.signal,
      project, commit, historicalEnd, ready,
    })).toBe(false)
    const projected = project.mock.calls.length
    await nextInput()
    expect(project.mock.calls).toHaveLength(projected)
    expect(commit).toHaveBeenCalledOnce()
    expect(ready).not.toHaveBeenCalled()
    expect(historicalEnd).not.toHaveBeenCalled()
  })

  it('splits a single large projected event into bounded commits', async () => {
    const rows = Array.from({ length: 600 }, (_, index) => `${String(index)}:${'x'.repeat(500)}`)
    const committed: string[][] = []
    const project = vi.fn(() => rows)
    expect(await replayTranscript({
      snapshot: () => log(1), signal: new AbortController().signal,
      project, commit: batch => { committed.push([...batch]) }, historicalEnd: () => {}, ready: () => {},
    })).toBe(true)
    expect(project).toHaveBeenCalledOnce()
    expect(committed.flat()).toEqual(rows)
    expect(committed.every(batch => batch.length <= 128 && batch.join('').length <= 32768)).toBe(true)
  })
})

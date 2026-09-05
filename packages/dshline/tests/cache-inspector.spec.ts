/**
 * Tests for `/cache`.
 *
 * Two authorities, and both are the real thing here. The accounting half rides
 * the REAL `@deepseek-ai/dsh-token-meter` over a real `SessionStore` and
 * projection registry — the same buckets `/usage` reads, which is the point: a
 * fake would let the two inspectors drift apart without a test noticing. The
 * header half calls the real `Session.requestHeader()` over real
 * `request/header` events, including the case that decides the whole design —
 * an unchanged header logged again as `series`, which this inspector must not
 * turn into a claim about history because it makes none. It reports the LATEST
 * recorded header, never a promise about the next request.
 *
 * What no test here asserts is a causal claim, because the report makes none.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { EpochHeader, Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import { cacheInspection, hasCacheReads, requestHeaderReading } from '../src/cache/model.ts'
import type { CacheInspection, RequestHeaderReading } from '../src/cache/model.ts'
import { createCacheOverlay } from '../src/cache/overlay.ts'

/** One projection cut, carrying whatever the test wants the meter to have said. */
function cut(values: ProjectionSnapshot['values'] = {}): ProjectionSnapshot {
  return { asOfSeq: 0, values }
}

/** A session with no plugins beyond the store, for reading header events back. */
async function session(): Promise<Session> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return ctx.sessions.create()
}

/** One tool schema, named. */
function tool(name: string): ToolSchema {
  return { name, description: 'does one thing', parameters: { type: 'object', properties: {} } }
}

/** A header with the fields this inspector reads, and defaults for the rest. */
function header(overrides: Partial<EpochHeader> = {}): EpochHeader {
  return {
    config: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    system: 'You are a terminal agent.',
    tools: [tool('read'), tool('write')],
    ...overrides,
  }
}

/**
 * Log one header the way the loop does: inside an open turn, before dispatch.
 * @param target - the session to append to.
 * @param snapshot - the full header snapshot to record.
 * @param reason - why upstream recorded it.
 * @param turn - the turn it belongs to.
 */
function logHeader(
  target: Session,
  snapshot: EpochHeader,
  reason: 'initial' | 'resume' | 'change' | 'series',
  turn: number,
): void {
  target.append('turn/start', { turn })
  target.append('step/start', { turn, step: 1 })
  target.append('request/header', { header: snapshot, reason })
  target.append('step/end', { turn, step: 1 })
  target.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** A recorded-header reading, for presentation tests. */
function reading(overrides: Partial<RequestHeaderReading> = {}): RequestHeaderReading {
  return {
    recorded: true,
    route: 'deepseek/deepseek-v4-flash',
    system: true,
    tools: 26,
    ...overrides,
  }
}

/** One drawn row without its frame border, for a claim about the row itself. */
function bare(row: string): string {
  return row.replaceAll('│', '').trimEnd()
}

/** The rows one inspection renders as, at a given geometry. */
function rows(inspection: CacheInspection, columns = 80, terminalRows = 24): string[] {
  const overlay = createCacheOverlay({ inspection: () => inspection, close: () => {} })
  return overlay.render(columns, terminalRows).map(stripAnsi)
}

/** The whole report as one string, for phrase assertions. */
function report(inspection: CacheInspection, columns = 80): string {
  return rows(inspection, columns).join('\n')
}

/**
 * The report as running text, for a sentence the frame wrapped across rows.
 * @param inspection - the current reading.
 * @param columns - the terminal's width.
 * @returns the body with its borders and row breaks collapsed away.
 */
function prose(inspection: CacheInspection, columns = 80): string {
  return rows(inspection, columns).map(bare).join(' ').replaceAll(/\s+/gu, ' ')
}

/** A cut whose meter reported cache reads. */
const CACHING_ROUTE = cut({
  tokenUsage: {
    uncachedInputTokens: 12_800,
    cacheReadTokens: 1_420_000,
    cacheWriteTokens: 0,
    outputTokens: 42_000,
  },
})

/** A cut from a route that reported prompt tokens and no cache reads. */
const SILENT_ROUTE = cut({
  tokenUsage: {
    uncachedInputTokens: 96_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 4_000,
  },
})

describe('the latest recorded request header', () => {
  it('reports the route, the system prompt, and the tool count Harness folded', async () => {
    const target = await session()
    logHeader(target, header(), 'initial', 1)

    const current = requestHeaderReading(target)
    expect(current.recorded).toBe(true)
    // `provider/model`, the form every Harness route id is written in — cache
    // behaviour belongs to the route, and a bare model id names only half of it.
    expect(current.route).toBe('deepseek/deepseek-v4-flash')
    expect(current.system).toBe(true)
    expect(current.tools).toBe(2)
  })

  it('reports nothing recorded before the session has logged a header', async () => {
    const current = requestHeaderReading(await session())
    expect(current.recorded).toBe(false)
    expect(current.route).toBeUndefined()
    expect(current.tools).toBe(0)
  })

  it('reads the newest header after a change', async () => {
    const target = await session()
    logHeader(target, header(), 'initial', 1)
    logHeader(target, {
      config: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      tools: [tool('read')],
    }, 'change', 2)

    const current = requestHeaderReading(target)
    expect(current.route).toBe('deepseek/deepseek-v4-pro')
    expect(current.system).toBe(false)
    expect(current.tools).toBe(1)
  })

  it('says nothing about history, so a repeated header changes nothing it reports', async () => {
    const target = await session()
    // Upstream logs an unchanged header again on resume and after a surface
    // replacement. This inspector holds no history to be confused by that, and
    // the reading before and after must be the same object's worth of facts.
    logHeader(target, header(), 'initial', 1)
    const first = requestHeaderReading(target)
    logHeader(target, header(), 'resume', 2)
    logHeader(target, header(), 'series', 3)

    expect(requestHeaderReading(target)).toEqual(first)
  })
})

describe('the cache inspection', () => {
  it('reads the same buckets and share `/usage` reads, from the real projection', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(TokenMeter)
    const target: Session = ctx.sessions.create()
    target.append('turn/start', { turn: 1 })
    target.append('step/start', { turn: 1, step: 1 })
    target.append('assistant/message', {
      turn: 1, step: 1,
      message: {
        id: 'a-1', role: 'assistant',
        content: [{ type: 'text', text: 'ok' }], source: { kind: 'model' },
      },
      usage: { inputTokens: 1_000, outputTokens: 20, cacheReadTokens: 99_000, cacheWriteTokens: 0 },
    } as never, { surfaceOp: 'append' })
    target.append('step/end', { turn: 1, step: 1 })
    target.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const inspection = cacheInspection(ctx.sessionProjections.snapshot(target), reading())
    expect(inspection.buckets).toEqual({
      uncachedInput: 1_000,
      cacheRead: 99_000,
      cacheWrite: 0,
      input: 100_000,
      output: 20,
    })
    expect(inspection.cacheReadShare).toBeCloseTo(0.99, 10)
    expect(hasCacheReads(inspection)).toBe(true)
  })

  it('has no cache read without a registry, without the meter, or with a zero read bucket', () => {
    expect(hasCacheReads(cacheInspection(undefined, reading()))).toBe(false)
    expect(hasCacheReads(cacheInspection(cut(), reading()))).toBe(false)
    // The case this guard exists for: `cacheReadTokens` is optional and Harness
    // folds an absent one to zero, so a route that reports no cache reads is
    // indistinguishable from one whose cache went cold. Neither is a measured 0%.
    expect(hasCacheReads(cacheInspection(SILENT_ROUTE, reading()))).toBe(false)
  })

  it('does not let a cache write certify a zero cache read', () => {
    // `cacheWriteTokens` is independently optional, so a positive write is no
    // evidence that the zero beside it was reported rather than defaulted.
    const written = cacheInspection(cut({
      tokenUsage: {
        uncachedInputTokens: 96_000, cacheReadTokens: 0, cacheWriteTokens: 96_000, outputTokens: 40,
      },
    }), reading())
    expect(hasCacheReads(written)).toBe(false)
    expect(report(written)).not.toContain('%')
  })
})

describe('the cache report', () => {
  it('reports the share and the buckets behind it', () => {
    const drawn = report(cacheInspection(CACHING_ROUTE, reading()))
    expect(drawn).toContain('Cache accounting')
    expect(drawn).toContain('cache read')
    expect(drawn).toContain('99.1%')
    expect(drawn).toContain('cached input')
    expect(drawn).toContain('1.4M')
    expect(drawn).toContain('uncached input')
    expect(drawn).toContain('13k')
  })

  it('omits the cache-write row only when the provider reported no write', () => {
    expect(report(cacheInspection(CACHING_ROUTE, reading()))).not.toContain('cache write')
    // With a write, the row appears: the share's denominator is all three prompt
    // buckets, so two of three under a percentage from three would not reconcile.
    expect(report(cacheInspection(cut({
      tokenUsage: {
        uncachedInputTokens: 12_800,
        cacheReadTokens: 1_420_000,
        cacheWriteTokens: 6_400,
        outputTokens: 42_000,
      },
    }), reading()))).toContain('cache write')
  })

  it('never prints a percentage for a route that reported no cache read', () => {
    const drawn = report(cacheInspection(SILENT_ROUTE, reading()))
    expect(drawn).not.toContain('%')
    expect(drawn).not.toContain('uncached input')
    expect(drawn).toContain('This session has no provider-reported cache reads.')
  })

  it('says when figures would appear, for every absence', () => {
    for (const inspection of [
      cacheInspection(undefined, reading()),
      cacheInspection(cut(), reading()),
      cacheInspection(SILENT_ROUTE, reading()),
    ]) {
      expect(prose(inspection)).toContain(
        'dshline will show provider cache usage when the active Harness adapter exposes it.',
      )
    }
  })

  it('names which absence it is, so a reader can tell an unmounted meter from a quiet route', () => {
    expect(report(cacheInspection(undefined, reading())))
      .toContain('Session projections are unavailable in this profile.')
    expect(report(cacheInspection(cut(), reading())))
      .toContain('The Harness token meter is not mounted.')
  })

  it('reports the recorded header as facts, with no verdict and no promise', () => {
    const drawn = report(cacheInspection(CACHING_ROUTE, reading()))
    expect(drawn).toContain('Request header')
    expect(drawn).toContain('deepseek/deepseek-v4-flash')
    expect(drawn).toContain('system prompt')
    expect(drawn).toContain('present')
    expect(drawn).toContain('tools')
    expect(drawn).toContain('26')
    expect(drawn).toContain('Latest request header Harness recorded.')
    // A step may reassemble the system prompt and the tool list before a new
    // header is logged, so this accessor is the newest RECORD and never a
    // statement about the request that follows it.
    expect(drawn).not.toMatch(/next request|will build|will use/iu)
    // Harness publishes no prefix-stability authority in this generation, and a
    // header event does not even mean the header moved. So no row may carry a
    // verdict about how still the request head has been.
    expect(drawn).not.toMatch(/stable|unchanged|changed|drift|disrupt/iu)
  })

  it('keeps the header section when accounting is unavailable', () => {
    const drawn = report(cacheInspection(undefined, reading({ tools: 31 })))
    expect(drawn).toContain('Request header')
    expect(drawn).toContain('deepseek/deepseek-v4-flash')
    expect(drawn).toContain('31')
  })

  it('never claims a saving, a waste, or a cause', () => {
    for (const inspection of [
      cacheInspection(CACHING_ROUTE, reading()),
      cacheInspection(SILENT_ROUTE, reading()),
      cacheInspection(undefined, reading({ recorded: false, route: undefined })),
    ]) {
      expect(report(inspection)).not.toMatch(/wasted|saved|saving|\$|broke|miss(ed)?\b/iu)
    }
  })

  it('says so rather than inventing rows before the first request', () => {
    const drawn = report(cacheInspection(cut(), reading({
      recorded: false, route: undefined, system: false, tools: 0,
    })))
    expect(drawn).toContain('No request header has been recorded in this session yet.')
    expect(drawn).not.toContain('system prompt')
  })

  it('wraps a sentence instead of cutting it, so half of it cannot read as the whole', () => {
    // `The Harness token meter is not` says the opposite of what the sentence
    // goes on to say, which is why prose here wraps where facts truncate.
    expect(prose(cacheInspection(cut(), reading()), 40))
      .toContain('The Harness token meter is not mounted.')
  })

  it('never draws a row wider than the terminal, at any width it accepts', () => {
    for (const columns of [20, 34, 48, 80, 120]) {
      for (const row of rows(cacheInspection(CACHING_ROUTE, reading()), columns)) {
        expect(displayWidth(row)).toBeLessThanOrEqual(columns)
      }
    }
  })

  it('falls back to one whole phrase on a terminal too small for the frame', () => {
    expect(rows(cacheInspection(CACHING_ROUTE, reading()), 13, 24)).toEqual(['esc close'])
    // Wide enough for the whole phrase, but too short for the frame.
    expect(rows(cacheInspection(CACHING_ROUTE, reading()), 40, 3))
      .toEqual(['cache read 99.1% · esc close'])
    // And a route with no reported cache read says so rather than reading `0%`.
    expect(rows(cacheInspection(SILENT_ROUTE, reading()), 40, 3))
      .toEqual(['cache read unreported · esc close'])
    expect(rows(cacheInspection(CACHING_ROUTE, reading()), 2, 24)).toEqual([])
  })

  it('never leaks a row past the terminal height', () => {
    for (const height of [1, 3, 4, 8, 24]) {
      expect(rows(cacheInspection(CACHING_ROUTE, reading()), 80, height).length)
        .toBeLessThanOrEqual(height)
    }
  })

  it('closes on escape and on ctrl-c, once', () => {
    let closed = 0
    const overlay = createCacheOverlay({
      inspection: () => cacheInspection(CACHING_ROUTE, reading()),
      close: () => { closed += 1 },
    })
    overlay.handleKey?.({ kind: 'key', name: 'escape' } as never)
    overlay.handleKey?.({ kind: 'key', name: 'ctrl-c' } as never)
    expect(closed).toBe(1)
  })

  it('ignores text, because it sets nothing', () => {
    let closed = 0
    const overlay = createCacheOverlay({
      inspection: () => cacheInspection(CACHING_ROUTE, reading()),
      close: () => { closed += 1 },
    })
    overlay.handleKey?.({ kind: 'text', text: 's' } as never)
    expect(closed).toBe(0)
  })
})

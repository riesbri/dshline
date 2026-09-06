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
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import {
  CACHE_TRANSITION_NOTE,
  cacheInspection,
  cacheTransitionNote,
  hasCacheReads,
  requestHeaderReading,
} from '../src/cache/model.ts'
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

  it('keeps one cumulative fold across a provider/model change', async () => {
    // A provider/model switch is exactly the case the scope caption exists for:
    // the session's totals must NOT reset at the boundary, because the buckets
    // are a session bill, not any one route's gauge. The second route below
    // starts without a cache read, the way a real switch behaves.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(TokenMeter)
    const target: Session = ctx.sessions.create()
    const send = (
      turn: number,
      id: string,
      source: { provider: string; model: string },
      usage: Record<string, number>,
    ): void => {
      target.append('turn/start', { turn })
      target.append('step/start', { turn, step: 1 })
      target.append('assistant/message', {
        turn, step: 1,
        message: {
          id, role: 'assistant',
          content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', ...source },
        },
        usage,
      } as never, { surfaceOp: 'append' })
      target.append('step/end', { turn, step: 1 })
      target.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    send(1, 'a-1', { provider: 'openai-codex', model: 'gpt-5.6-terra' },
      { inputTokens: 12_800, outputTokens: 40, cacheReadTokens: 1_400_000, cacheWriteTokens: 0 })
    send(2, 'a-2', { provider: 'opencode-go', model: 'deepseek-v4-flash' },
      { inputTokens: 45_508, outputTokens: 300 })

    const inspection = cacheInspection(ctx.sessionProjections.snapshot(target), reading())
    // Both routes' billing in one fold: the switch is a request boundary, not
    // a reset boundary.
    expect(inspection.buckets).toEqual({
      uncachedInput: 58_308,
      cacheRead: 1_400_000,
      cacheWrite: 0,
      input: 1_458_308,
      output: 340,
    })
    expect(inspection.cacheReadShare).toBeCloseTo(1_400_000 / 1_458_308, 10)
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

  it('says the accounting is session-cumulative across provider/model changes', () => {
    // The header section below names ONE recorded route; the caption stops the
    // totals above it from being read as that route's own cache.
    const drawn = report(cacheInspection(CACHING_ROUTE, reading()))
    expect(drawn).toContain('Session cumulative')
    expect(drawn).toContain('includes requests across provider/model changes')
  })

  it('keeps the scope caption when accounting is unavailable', () => {
    // The statement is about the session regardless of whether figures exist.
    expect(prose(cacheInspection(undefined, reading())))
      .toContain('Session cumulative · includes requests across provider/model changes')
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

describe('the model-switch cache note', () => {
  /** A selection shaped like the ref's current value. */
  function sel(provider: string, model: string): ModelSelection {
    return { provider, model }
  }

  it('notes that cache reuse is provider-dependent when the route actually changes', () => {
    expect(cacheTransitionNote(sel('openai-codex', 'gpt-5.6-terra'), sel('opencode-go', 'deepseek-v4-flash')))
      .toBe(CACHE_TRANSITION_NOTE)
  })

  it('stays silent when the already-active provider/model is selected again', () => {
    // Re-selecting what is current is not a move, so it earns no note.
    const current = sel('opencode-go', 'deepseek-v4-flash')
    expect(cacheTransitionNote(current, current)).toBeUndefined()
  })

  it('stays silent when either side of the transition is unknown', () => {
    // `before` undefined means no explicit override existed — Harness may
    // already be resolving an effective route underneath it, so nothing proves
    // a change happened. `after` undefined means nothing was applied.
    expect(cacheTransitionNote(undefined, sel('deepseek-official', 'deepseek-v4-flash')))
      .toBeUndefined()
    expect(cacheTransitionNote(sel('deepseek-official', 'deepseek-v4-flash'), undefined))
      .toBeUndefined()
    expect(cacheTransitionNote(undefined, undefined)).toBeUndefined()
  })

  it('states provider dependence and session-cumulative scope, and nothing more', () => {
    // dshline has no authority to promise either outcome — "the cache is lost"
    // or "the cache carries over" — only to say what its own metric is. The
    // wording must therefore commit to neither.
    expect(CACHE_TRANSITION_NOTE).toContain('provider-dependent')
    expect(CACHE_TRANSITION_NOTE).toContain('session-cumulative')
    expect(CACHE_TRANSITION_NOTE).not.toMatch(/will|guaranteed|lost|resend|uncached|carry over/iu)
  })
})

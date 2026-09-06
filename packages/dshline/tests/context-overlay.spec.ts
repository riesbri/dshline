/**
 * Tests for the `/context` inspector's presentation and navigation.
 *
 * The properties under test are the ones a mockup cannot promise: that every
 * figure states the precision its authority claims, that an absent capability
 * produces an honest row rather than a fabricated one, that the compaction key
 * is advertised only when it exists, that a terminal too small to hold the
 * frame still closes, and that model-authored text can neither add a row nor
 * operate the terminal.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Key } from '@dshline/renderer'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import { createContextOverlay } from '../src/context/overlay.ts'
import type { ContextEntry, ContextPreview, ContextReading, ContextSurvey } from '../src/context/model.ts'

/** A metered reading with a projected occupancy, which cases override. */
function reading(overrides: Partial<ContextReading> = {}): ContextReading {
  return {
    projections: true,
    metered: true,
    occupancy: { tokens: 184_000, capacity: 1_000_000 },
    composition: { system: 12_000, tools: 48_000, messages: 124_000, total: 184_000 },
    ...overrides,
  }
}

/** One resolved entry. */
function entry(overrides: Partial<ContextEntry> = {}): ContextEntry {
  return {
    seq: 418,
    position: 41,
    tokens: 42_000,
    share: 0.22,
    kind: 'tool-result',
    form: undefined,
    tool: 'run_shell_command',
    turn: 31,
    step: 4,
    replaced: false,
    ...overrides,
  }
}

/** A survey with the given entries. */
function survey(entries: readonly ContextEntry[], overrides: Partial<ContextSurvey> = {}): ContextSurvey {
  return {
    available: true,
    surfaceTokens: 190_000,
    nodes: Math.max(entries.length, 128),
    entries,
    ...overrides,
  }
}

/** A driver over one overlay, reading the rows a person would see. */
function driver(options: {
  readonly reading?: ContextReading
  readonly survey?: ContextSurvey
  readonly preview?: ContextPreview
  readonly capacity?: number | undefined
  readonly canCompact?: () => boolean
  readonly compact?: () => Promise<string | undefined>
} = {}): {
  readonly rows: (columns?: number, terminalRows?: number) => string[]
  readonly press: (key: Key) => void
  readonly cursor: (columns?: number, terminalRows?: number) => string
  readonly closed: () => boolean
} {
  let closed = false
  const overlay = createContextOverlay({
    reading: () => options.reading ?? reading(),
    survey: () => options.survey ?? survey([entry()]),
    preview: () => options.preview ?? { text: 'PASS one', truncated: false, available: true },
    capacity: () => ('capacity' in options ? options.capacity : 1_000_000),
    canCompact: () => options.canCompact?.() ?? options.compact !== undefined,
    compact: options.compact ?? (async () => undefined),
    close: () => { closed = true },
    invalidate: () => {},
  })
  const rows = (columns = 80, terminalRows = 40): string[] =>
    overlay.render(columns, terminalRows).map(stripAnsi)
  return {
    rows,
    press: key => { overlay.handleKey(key) },
    cursor: (columns = 80, terminalRows = 40) =>
      (rows(columns, terminalRows).find(row => row.includes('❯')) ?? '').replace(/[│❯]/gu, '').trim(),
    closed: () => closed,
  }
}

/** The rows as one string, for containment checks. */
function text(rows: readonly string[]): string {
  return rows.join('\n')
}

describe('the context inspector’s overview', () => {
  it('states occupancy, its proportion, a bar, and what kind of figure it is', () => {
    const body = text(driver().rows())
    // One word, always: the figure is upstream's projection of the next
    // request's prompt, so it says so instead of toggling a `~` from an
    // equality that could not prove exactness.
    expect(body).toContain('184k / 1.0M · 18% · projected')
    expect(body).not.toContain('~184k')
    // The eighths bar, which is what makes any reading visible on a
    // million-token window.
    expect(body).toMatch(/[█▏▎▍▌▋▊▉░]/u)
  })

  it('says `projected` the same way whatever the surface has done since', () => {
    const moved = driver({ reading: reading({ occupancy: { tokens: 191_500, capacity: 1_000_000 } }) })
    const body = text(moved.rows())
    expect(body).toContain('192k / 1.0M · 19% · projected')
    expect(body).not.toContain('~192k')
  })

  it('draws no percentage and no bar when no route advertised a window', () => {
    const unknown = driver({
      reading: reading({ occupancy: { tokens: 184_000, capacity: undefined } }),
      capacity: undefined,
    })
    const rows = unknown.rows()
    const occupancy = rows.find(row => row.includes('184k')) ?? ''
    expect(occupancy).not.toContain('/')
    expect(occupancy).not.toContain('%')
    // No bar either: its scale is the window, and there is no window.
    expect(text(rows)).not.toMatch(/[█░]/u)
  })

  it('labels composition as estimated and shares it against its own total', () => {
    const body = text(driver().rows())
    expect(body).toContain('Composition · estimated')
    // 12k of 184k is 7%; 48k is 26%; 124k is 67% — of the composition sum, not
    // of the projected occupancy figure.
    expect(body).toMatch(/system\s+~12k.*7%/u)
    expect(body).toMatch(/tools\s+~48k.*26%/u)
    expect(body).toMatch(/messages\s+~124k.*67%/u)
  })

  it('labels every entry price as estimated and names what it can prove', () => {
    const body = text(driver({
      survey: survey([
        entry({ seq: 418, tokens: 42_000, share: 0.22 }),
        entry({ seq: 300, tokens: 18_000, share: 0.09, kind: 'assistant', tool: undefined }),
        entry({ seq: 12, tokens: 9_000, share: 0.05, kind: 'context', tool: undefined, form: 'instructions' }),
        entry({ seq: 500, tokens: 5_000, share: 0.02, kind: 'summary', tool: undefined, replaced: true }),
        entry({ seq: 505, tokens: 4_000, share: 0.02, tool: 'read_file', replaced: true }),
      ]),
    }).rows())
    expect(body).toContain('Largest entries · estimated · 5 of 128')
    expect(body).toContain('~42k  22%  tool result · run_shell_command')
    expect(body).toContain('assistant reply')
    expect(body).toContain('injected context · instructions')
    expect(body).toContain('compaction summary')
    // A replaced result says only that: the durable log does not prove a
    // replacement was a reduction, and only a checkpoint proves who wrote one.
    expect(body).toContain('tool result · replaced · read_file')
    expect(body).not.toContain('reduced')
  })

  it('offers the compaction key only when the agent really has the command', () => {
    expect(text(driver().rows())).not.toContain('c compact')
    expect(text(driver({ compact: async () => undefined }).rows())).toContain('c compact')
  })

  it('reports each absent capability as itself, and fabricates nothing', () => {
    expect(text(driver({ reading: reading({ projections: false, metered: false, occupancy: undefined, composition: undefined }) }).rows()))
      .toContain('Session projections are unavailable')
    expect(text(driver({ reading: reading({ metered: false, occupancy: undefined, composition: undefined }) }).rows()))
      .toContain('token meter is not mounted')
    expect(text(driver({ reading: reading({ occupancy: undefined }) }).rows()))
      .toContain('No request has reported a prompt size yet')
    expect(text(driver({ survey: survey([], { available: false }) }).rows()))
      .toContain('Per-entry measurement is unavailable')
    expect(text(driver({ survey: survey([]) }).rows()))
      .toContain('carries no conversation yet')
  })
})

describe('the context inspector’s navigation', () => {
  it('moves the visible cursor over entries and opens one with enter', () => {
    const view = driver({
      survey: survey([
        entry({ seq: 1, tokens: 40_000 }),
        entry({ seq: 2, tokens: 20_000, kind: 'assistant', tool: undefined }),
      ]),
    })
    view.rows()
    expect(view.cursor()).toContain('~40k')
    view.press({ kind: 'key', name: 'down' })
    expect(view.cursor()).toContain('~20k')

    view.press({ kind: 'key', name: 'enter' })
    const detail = text(view.rows())
    expect(detail).toContain('Context entry')
    expect(detail).toContain('type       assistant reply')
    expect(detail).toContain('estimated')
    // Named for the denominator it divides: `surfaceTokens` prices the
    // conversation only, so this is not a share of the whole request context.
    expect(detail).toContain('% of message context')
    expect(detail).toContain('Preview')
    expect(detail).toContain('↑↓ scroll · esc back')
  })

  it('walks back to the overview with esc, and closes only from there', () => {
    const view = driver()
    view.rows()
    view.press({ kind: 'key', name: 'enter' })
    view.press({ kind: 'key', name: 'escape' })
    expect(text(view.rows())).toContain('Composition')
    expect(view.closed()).toBe(false)
    view.press({ kind: 'key', name: 'escape' })
    expect(view.closed()).toBe(true)
  })

  it('leaves an open entry when the surface no longer carries it', () => {
    // A compaction landed while the entry was open: its price is no longer a
    // fact about the model's context, so the stage leaves rather than freezing.
    let entries: readonly ContextEntry[] = [entry({ seq: 418 })]
    let closed = false
    const overlay = createContextOverlay({
      reading: () => reading(),
      survey: () => survey(entries),
      preview: () => ({ text: 'x', truncated: false, available: true }),
      capacity: () => 1_000_000,
      canCompact: () => true,
      compact: async () => undefined,
      close: () => { closed = true },
      invalidate: () => {},
    })
    overlay.render(80, 40)
    overlay.handleKey({ kind: 'key', name: 'enter' })
    expect(stripAnsi(overlay.render(80, 40).join('\n'))).toContain('Context entry')
    entries = [entry({ seq: 999, tokens: 3_000 })]
    const back = stripAnsi(overlay.render(80, 40).join('\n'))
    expect(back).toContain('Composition')
    expect(closed).toBe(false)
  })

  it('does nothing on enter over a non-actionable fact row', () => {
    const view = driver({ survey: survey([]) })
    view.rows()
    view.press({ kind: 'key', name: 'enter' })
    // Still the overview: a focused row does not have to be actionable, and a
    // stage with no openable row invents no action.
    expect(text(view.rows())).toContain('Composition')
    expect(view.closed()).toBe(false)
  })
})

describe('the context inspector’s compaction key', () => {
  it('runs the owner’s registered command once, shows progress, and refreshes', async () => {
    let calls = 0
    let settle = (): void => {}
    const pending = new Promise<string | undefined>(resolve => {
      settle = () => { resolve(undefined) }
    })
    let occupancy = reading()
    const overlay = createContextOverlay({
      reading: () => occupancy,
      survey: () => survey([entry()]),
      preview: () => ({ text: 'x', truncated: false, available: true }),
      capacity: () => 1_000_000,
      canCompact: () => true,
      compact: () => { calls += 1; return pending },
      close: () => {},
      invalidate: () => {},
    })
    overlay.render(80, 40)
    overlay.handleKey({ kind: 'text', text: 'c' })
    expect(calls).toBe(1)
    expect(stripAnsi(overlay.render(80, 40).join('\n'))).toContain('compacting context')

    // A second press while one is in flight sends nothing.
    overlay.handleKey({ kind: 'text', text: 'c' })
    expect(calls).toBe(1)

    settle()
    await Promise.resolve()
    await Promise.resolve()
    // The figures come from the reading, so a landed compaction shows up on the
    // next paint without the overlay caching anything of its own.
    occupancy = reading({ occupancy: { tokens: 91_000, capacity: 1_000_000 } })
    const after = stripAnsi(overlay.render(80, 40).join('\n'))
    expect(after).not.toContain('compacting context')
    expect(after).toContain('91k / 1.0M · 9% · projected')
  })

  it('shows a refusal the registry answered with, without committing anything', async () => {
    const overlay = createContextOverlay({
      reading: () => reading(),
      survey: () => survey([entry()]),
      preview: () => ({ text: 'x', truncated: false, available: true }),
      capacity: () => 1_000_000,
      canCompact: () => true,
      compact: async () => 'This profile has no /compact command.',
      close: () => {},
      invalidate: () => {},
    })
    overlay.render(80, 40)
    overlay.handleKey({ kind: 'text', text: 'c' })
    await Promise.resolve()
    await Promise.resolve()
    expect(stripAnsi(overlay.render(80, 40).join('\n'))).toContain('no /compact command')
  })

  it('starts no heartbeat while the inspector is merely open', () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    try {
      const view = driver({ compact: async () => undefined })
      view.rows()
      view.rows()
      // Nothing on this frame moves, so a timer here would exist to do nothing.
      expect(interval).not.toHaveBeenCalled()
      view.press({ kind: 'text', text: 'c' })
      // One heartbeat, and only for the spinner that now has something to say.
      expect(interval).toHaveBeenCalledTimes(1)
    } finally {
      interval.mockRestore()
    }
  })

  it('ignores the key entirely when no compaction command was offered', () => {
    const view = driver()
    view.rows()
    view.press({ kind: 'text', text: 'c' })
    expect(text(view.rows())).not.toContain('compacting')
  })

  it('reads the compaction offer live, so a changed composition repaints the footer', () => {
    // Harness can register or remove a scoped command while the inspector is
    // open; the footer must never advertise a control the registry cannot
    // resolve, nor hide one it can.
    let available = false
    let calls = 0
    const view = driver({
      canCompact: () => available,
      compact: async () => { calls += 1; return undefined },
    })
    expect(text(view.rows())).not.toContain('c compact')
    view.press({ kind: 'text', text: 'c' })
    expect(calls).toBe(0)
    available = true
    expect(text(view.rows())).toContain('c compact')
    view.press({ kind: 'text', text: 'c' })
    expect(calls).toBe(1)
    available = false
    expect(text(view.rows())).not.toContain('c compact')
  })

  it('compacts only from the overview, never from an open entry', () => {
    // The footer offers `c compact` only on the overview; the gesture follows
    // that offer rather than firing beneath an entry's scroll keys.
    let calls = 0
    const view = driver({
      canCompact: () => true,
      compact: async () => { calls += 1; return undefined },
    })
    view.rows()
    view.press({ kind: 'key', name: 'enter' })
    expect(text(view.rows())).toContain('Context entry')
    view.press({ kind: 'text', text: 'c' })
    expect(calls).toBe(0)
    view.press({ kind: 'key', name: 'escape' })
    view.press({ kind: 'text', text: 'c' })
    expect(calls).toBe(1)
  })

  it('keeps reporting an in-flight compaction on a terminal too short for the frame', async () => {
    let settle = (): void => {}
    const pending = new Promise<string | undefined>(resolve => {
      settle = () => { resolve(undefined) }
    })
    const view = driver({
      canCompact: () => true,
      compact: () => pending,
    })
    view.rows()
    view.press({ kind: 'text', text: 'c' })
    // The one-row backstop carries the same state the framed view does, so a
    // resize during compaction does not make the command look idle.
    expect(view.rows(80, 3)[0]).toContain('compacting context')
    settle()
    await Promise.resolve()
    await Promise.resolve()
    expect(view.rows(80, 3)[0]).toContain('esc close')
  })
})

describe('the context inspector’s geometry and safety', () => {
  it('falls back to one closable row on a terminal that cannot hold the frame', () => {
    const view = driver()
    const narrow = view.rows(12, 40)
    expect(narrow.length).toBe(1)
    expect(narrow[0]).toContain('esc close')

    const short = view.rows(80, 3)
    expect(short.length).toBeLessThanOrEqual(1)
  })

  it('closes from the fallback, and acts on no aimed row while it is up', () => {
    const view = driver()
    view.rows(12, 40)
    view.press({ kind: 'key', name: 'enter' })
    // No stage was opened: there was no visible cursor to open anything with.
    expect(view.rows(12, 40)[0]).toContain('esc close')
    view.press({ kind: 'key', name: 'escape' })
    expect(view.closed()).toBe(true)
  })

  it('keeps the fallback truthful when even the summary does not fit', () => {
    const view = driver()
    expect(view.rows(8, 40)[0]).toBe('esc')
    expect(view.rows(2, 40)).toEqual([])
  })

  it('never lets a frame exceed the terminal it was given', () => {
    const view = driver({
      survey: survey(Array.from({ length: 32 }, (_, index) => entry({
        seq: index,
        tokens: 40_000 - index * 100,
        share: 0.2 - index * 0.001,
      }))),
    })
    for (const rows of [5, 8, 14, 24, 40]) {
      const drawn = view.rows(80, rows)
      const physical = drawn.reduce((count, row) => count + Math.max(1, Math.ceil(displayWidth(row) / 80)), 0)
      expect(physical, `frame must fit ${String(rows)} rows`).toBeLessThanOrEqual(rows)
    }
  })

  it('escapes model text and keeps a wide-character preview on its own rows', () => {
    const view = driver({
      survey: survey([entry({ tool: '上下文[31m', kind: 'tool-result' })]),
      preview: { text: '上下文が非常に長い[31m赤', truncated: true, available: true },
    })
    view.rows()
    view.press({ kind: 'key', name: 'enter' })
    const detail = view.rows()
    const body = text(detail)
    // The escape character itself is neutralized: nothing here may operate the
    // terminal or consume a row's style reset.
    expect(body).not.toContain('[31m')
    expect(body).toContain('上下文')
    expect(body).toContain('preview truncated')
    // Every row still fits the frame in DISPLAY columns, which is the only
    // measure a wide character respects.
    for (const row of detail) expect(displayWidth(row)).toBeLessThanOrEqual(80)
  })

  it('scrolls a long preview instead of growing the frame', () => {
    const long = Array.from({ length: 400 }, (_, index) => `line ${String(index)}`).join('\n')
    const view = driver({ preview: { text: long, truncated: false, available: true } })
    view.rows()
    view.press({ kind: 'key', name: 'enter' })
    const first = text(view.rows(80, 20))
    view.press({ kind: 'key', name: 'end' })
    const last = text(view.rows(80, 20))
    expect(first).not.toBe(last)
    expect(last).toContain('line 399')
  })
})

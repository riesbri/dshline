/**
 * Tests for `/turns`: the Harness `turnOutline` adapter, its bounded outline and
 * read-only inspection surfaces, and the presenter that wires them.
 *
 * The properties under test are the ones a mockup cannot promise: that
 * `/turns` reads the authoritative projection rather than folding the log a
 * second time; that a turn's identity is its `turn/start` seq, so filtering and
 * live projection updates cannot move an action onto another turn; that an open
 * or no-text turn is never mistaken for a completed one; that a filter matching
 * nothing says so; that a long outline and a long preview stay bounded on narrow
 * and short terminals; and that Escape pops exactly one surface.
 *
 * The real `@deepseek-ai/dsh-session-turn-outline` plugin is mounted over a real
 * `SessionStore` and projection registry in the first block, so the projection
 * contract is exercised rather than a dshline-shaped fake of it.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import * as SessionTurnOutlinePlugin from '@deepseek-ai/dsh-session-turn-outline'
import type { TurnOutlineEntry } from '@deepseek-ai/dsh-session-turn-outline/types'
import type { Key } from '@dshline/renderer'
import { displayWidth, stripAnsi, wrapToWidth } from '@dshline/renderer'
import { SessionProjectionObserver } from '../src/projections/observer.ts'
import type { TuiOverlay } from '../src/slots.ts'
import type { TuiSlots } from '../src/slots.ts'
import { turnReading } from '../src/turns/model.ts'
import type { TurnReading } from '../src/turns/model.ts'
import { filterTurns, neighbourSeq, turnLabel } from '../src/turns/model.ts'
import { createTurnInspectionOverlay, createTurnsOverlay } from '../src/turns/overlay.ts'
import { createTurnsPresenter } from '../src/turns/presenter.ts'

/** A turn entry with a branded seq, so fixtures match the authoritative shape. */
function entry(turn: number, seq: number, prompt = '', response = ''): TurnOutlineEntry {
  return { turn, seq: SessionSeq(seq), prompt, response }
}

/** A list reading over the given entries. */
function list(...entries: readonly TurnOutlineEntry[]): TurnReading {
  return { kind: 'list', turns: entries }
}

/** A projection cut carrying the given unit values. */
function cut(values: ProjectionSnapshot['values']): ProjectionSnapshot {
  return { asOfSeq: 0, values }
}

/** A decoded keystroke. */
function key(name: string): Key {
  return { kind: 'key', name } as Key
}

/** A decoded printable key. */
function typed(value: string): Key {
  return { kind: 'text', text: value } as Key
}

/**
 * Mount the real store, projection registry, and optionally the real
 * turn-outline unit — never a dshline reimplementation of the fold.
 * @param withOutline - whether to mount `@deepseek-ai/dsh-session-turn-outline`.
 * @returns the context, a fresh session, and the generic observer.
 */
async function harness(withOutline: boolean): Promise<{
  ctx: Context
  session: Session
  observer: SessionProjectionObserver
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  if (withOutline) await ctx.plugin(SessionTurnOutlinePlugin)
  const session = ctx.sessions.create()
  const observer = new SessionProjectionObserver({ registry: ctx.sessionProjections, session, invalidate: () => {} })
  return { ctx, session, observer }
}

/** Append one completed turn, optionally with a prompt and a response. */
function appendTurnWith(session: Session, turn: number, prompt: string, response: string): void {
  if (prompt !== '') {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  if (response !== '') {
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: response }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
  }
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** A driver over one outline overlay, reading the rows a person would see. */
function outlineDriver(options: {
  readonly reading: () => TurnReading
  readonly initialQuery?: string
}): {
  readonly rows: (columns?: number, terminalRows?: number) => string[]
  readonly rawRows: (columns?: number, terminalRows?: number) => string[]
  readonly press: (key: Key) => void
  readonly closed: () => boolean
  readonly inspected: () => number | undefined
} {
  let closed = false
  let inspected: number | undefined
  const overlay = createTurnsOverlay({
    reading: options.reading,
    ...options.initialQuery === undefined ? {} : { initialQuery: options.initialQuery },
    inspect: seq => { inspected = seq as number },
    invalidate: () => {},
    close: () => { closed = true },
  })
  return {
    rows: (columns = 80, terminalRows = 24) => overlay.render(columns, terminalRows).map(stripAnsi),
    rawRows: (columns = 80, terminalRows = 24) => [...overlay.render(columns, terminalRows)],
    press: key => { overlay.handleKey(key) },
    closed: () => closed,
    inspected: () => inspected,
  }
}

/** A driver over one inspection overlay. */
function inspectionDriver(options: {
  readonly reading: () => TurnReading
  readonly initialSeq: number
}): {
  readonly rows: (columns?: number, terminalRows?: number) => string[]
  readonly rawRows: (columns?: number, terminalRows?: number) => string[]
  readonly press: (key: Key) => void
  readonly closed: () => boolean
  readonly title: (columns?: number, terminalRows?: number) => string
} {
  let closed = false
  const overlay = createTurnInspectionOverlay({
    reading: options.reading,
    initialSeq: SessionSeq(options.initialSeq),
    invalidate: () => {},
    close: () => { closed = true },
  })
  return {
    rows: (columns = 80, terminalRows = 24) => overlay.render(columns, terminalRows).map(stripAnsi),
    rawRows: (columns = 80, terminalRows = 24) => [...overlay.render(columns, terminalRows)],
    press: key => { overlay.handleKey(key) },
    closed: () => closed,
    title: (columns = 80, terminalRows = 24) =>
      stripAnsi(overlay.render(columns, terminalRows)[1] ?? ''),
  }
}

/** A live-region registry double that keeps the overlay stack, like the real one. */
function stackSlots(): {
  readonly slots: TuiSlots
  readonly depth: () => number
  readonly top: () => TuiOverlay | undefined
  readonly closeTop: () => void
} {
  const stack: TuiOverlay[] = []
  const slots = {
    pushOverlay(overlay: TuiOverlay) {
      stack.push(overlay)
      overlay.mounted?.()
      return () => {
        const at = stack.indexOf(overlay)
        if (at >= 0) stack.splice(at, 1)
        overlay.dispose?.()
      }
    },
    invalidate() {},
    get activeOverlay() { return stack.at(-1) },
  } as unknown as TuiSlots
  return {
    slots,
    depth: () => stack.length,
    top: () => stack.at(-1),
    closeTop: () => { stack.at(-1)?.handleKey(key('escape')) },
  }
}

/** One string of the rows, for containment checks. */
function text(rows: readonly string[]): string {
  return rows.join('\n')
}

describe('the Harness turnOutline adapter', () => {
  it('distinguishes absent infrastructure, an unregistered unit, no turns, and a list', () => {
    expect(turnReading(undefined)).toEqual({ kind: 'projections-unavailable' })
    expect(turnReading(cut({}))).toEqual({ kind: 'unregistered' })
    expect(turnReading(cut({ turnOutline: [] }))).toEqual({ kind: 'none' })
    const turns = [entry(1, 3, 'hello', 'world')]
    expect(turnReading(cut({ turnOutline: turns }))).toEqual({ kind: 'list', turns })
  })

  it('reads the real unit through the generic observer, with each turn/start seq', async () => {
    const { session, observer } = await harness(true)
    const firstBoundary = session.append('turn/start', { turn: 1 }).seq
    appendTurnWith(session, 1, 'Fix rollback invalidation', 'Compared previous runs.')
    const secondBoundary = session.append('turn/start', { turn: 2 }).seq
    appendTurnWith(session, 2, 'Split bounds matrix', 'Done.')

    const reading = turnReading(observer.snapshot())
    expect(reading.kind).toBe('list')
    const turns = reading.kind === 'list' ? reading.turns : []
    expect(turns).toHaveLength(2)
    // The seq is the AUTHORITATIVE `turn/start` boundary, not a locally computed
    // end boundary: a substitution would fail here by name.
    expect(turns[0]?.seq).toBe(firstBoundary)
    expect(turns[1]?.seq).toBe(secondBoundary)
    expect(turns[0]).toMatchObject({ turn: 1, prompt: 'Fix rollback invalidation', response: 'Compared previous runs.' })
    observer.dispose()
  })

  it('cold-folds a session resumed after every turn was already logged', async () => {
    // The events land with no unit mounted, which is the shape a reopened session
    // presents. Mounting afterwards is the registry's lazy build; nothing here
    // replays the log itself.
    const { ctx, session } = await harness(false)
    session.append('turn/start', { turn: 1 })
    appendTurnWith(session, 1, 'historical prompt', 'historical answer')
    await ctx.plugin(SessionTurnOutlinePlugin)
    const observer = new SessionProjectionObserver({ registry: ctx.sessionProjections, session, invalidate: () => {} })
    const reading = turnReading(observer.snapshot())
    expect(reading.kind).toBe('list')
    expect(reading.kind === 'list' ? reading.turns : []).toHaveLength(1)
    observer.dispose()
  })

  it('reports a completed no-text turn as an empty response, not an open one', async () => {
    const { session, observer } = await harness(true)
    session.append('turn/start', { turn: 1 })
    appendTurnWith(session, 1, 'prompt only', '')
    const reading = turnReading(observer.snapshot())
    const turns = reading.kind === 'list' ? reading.turns : []
    expect(turns[0]).toMatchObject({ prompt: 'prompt only', response: '' })
    // The turn HAS completed: the surface must not infer openness from the empty
    // preview. It draws the neutral no-preview sentence instead.
    const view = inspectionDriver({ reading: () => reading, initialSeq: turns[0]?.seq ?? 0 })
    expect(text(view.rows())).toContain('recorded no response preview')
    observer.dispose()
  })

  it('reports an unregistered unit rather than folding the log itself', async () => {
    const { session, observer } = await harness(false)
    appendTurnWith(session, 1, 'anything', 'anything')
    expect(turnReading(observer.snapshot())).toEqual({ kind: 'unregistered' })
    const view = outlineDriver({ reading: () => turnReading(observer.snapshot()) })
    expect(text(view.rows())).toContain('turn outline projection is not mounted')
    observer.dispose()
  })
})

describe('the turns model', () => {
  it('labels from the prompt, then the response, then the Harness turn number', () => {
    expect(turnLabel(entry(4, 10, 'a prompt', 'a response'))).toBe('a prompt')
    expect(turnLabel(entry(4, 10, '', 'a response'))).toBe('a response')
    // An empty response is a valid state, so the fallback names the turn rather
    // than pretending the prompt's absence proves anything.
    expect(turnLabel(entry(4, 10, '', ''))).toBe('Turn 4')
  })

  it('filters case-insensitively over turn number, prompt, and response', () => {
    const turns = [
      entry(1, 1, 'Implement context presenter', 'done'),
      entry(2, 2, 'Review surface architecture', 'CI variance'),
      entry(12, 3, '', 'ROllback investigation'),
    ]
    expect(filterTurns(turns, '')).toHaveLength(3)
    expect(filterTurns(turns, '   ')).toHaveLength(3)
    expect(filterTurns(turns, 'CONTEXT').map(t => t.turn)).toEqual([1])
    expect(filterTurns(turns, 'variance').map(t => t.turn)).toEqual([2])
    expect(filterTurns(turns, 'rollback').map(t => t.turn)).toEqual([12])
    // The number is searchable as its decimal text, which is what a reader sees.
    expect(filterTurns(turns, '12').map(t => t.turn)).toEqual([12])
    expect(filterTurns(turns, 'nothing here')).toEqual([])
  })

  it('walks to a neighbour by seq and clamps at both ends', () => {
    const turns = [entry(1, 10), entry(2, 20), entry(3, 30)]
    expect(neighbourSeq(turns, SessionSeq(10), 1)).toBe(20)
    expect(neighbourSeq(turns, SessionSeq(30), 1)).toBeUndefined()
    expect(neighbourSeq(turns, SessionSeq(10), -1)).toBeUndefined()
    expect(neighbourSeq(turns, SessionSeq(999), 1)).toBeUndefined()
  })
})

describe('the turns outline surface', () => {
  it('shows 0, 1, and many turns without inventing one', () => {
    expect(text(outlineDriver({ reading: () => ({ kind: 'none' }) }).rows())).toContain('no turns yet')
    const one = outlineDriver({ reading: () => list(entry(1, 5, 'only turn')) })
    expect(text(one.rows())).toContain('only turn')
    expect(text(one.rows())).toContain('❯')

    const many = outlineDriver({
      reading: () => list(...Array.from({ length: 26 }, (_, index) => entry(index + 1, index + 10, `turn ${String(index + 1)}`))),
    })
    expect(text(many.rows())).toContain('turn 1')
    many.press(key('end'))
    expect(text(many.rows())).toContain('turn 26')
  })

  it('keeps a long outline bounded and scrolls the window to the focused row', () => {
    const turns = Array.from({ length: 200 }, (_, index) => entry(index + 1, index + 10, `turn ${String(index + 1)}`))
    const view = outlineDriver({ reading: () => list(...turns) })
    const first = view.rows(80, 10)
    expect(text(first)).toContain('turn 1')
    expect(text(first)).not.toContain('turn 200')
    view.press(key('end'))
    expect(text(view.rows(80, 10))).toContain('turn 200')
  })

  it('opens the aimed turn on its Harness turn/start seq', () => {
    // Selection and row position coincide in an unfiltered, append-only outline,
    // so this proves the seq is what is handed over — the identity claim itself
    // is proven below, where a filter breaks that coincidence.
    const view = outlineDriver({ reading: () => list(entry(1, 10, 'a'), entry(2, 20, 'b')) })
    view.rows()
    view.press(key('down'))
    view.press(key('enter'))
    expect(view.inspected()).toBe(20)
  })

  it('does not drag the cursor when a projection update appends below it', () => {
    let turns = [entry(1, 10, 'a'), entry(2, 20, 'b')]
    const view = outlineDriver({ reading: () => list(...turns) })
    view.rows()
    view.press(key('down'))
    expect(text(view.rows()).split('\n').find(row => row.includes('❯'))).toContain('b')
    // Harness appends a new turn: the cursor stays on the turn the reader aimed
    // at rather than following the list's newest row.
    turns = [...turns, entry(3, 30, 'c')]
    const rows = view.rows()
    expect(rows.find(row => row.includes('❯'))).toContain('b')
    expect(rows.find(row => row.includes('❯'))).not.toContain('c')
  })

  it('wraps at both ends of the outline, matching the shared focus ring', () => {
    const view = outlineDriver({ reading: () => list(entry(1, 10, 'a'), entry(2, 20, 'b'), entry(3, 30, 'c')) })
    view.rows()
    view.press(key('up'))
    expect(text(view.rows()).split('\n').find(row => row.includes('❯'))).toContain('c')
    view.press(key('down'))
    expect(text(view.rows()).split('\n').find(row => row.includes('❯'))).toContain('a')
  })

  it('keeps the aimed turn across a filter that removes rows above it', () => {
    // A filter is what would break INDEX-keyed selection: removing turn 1 keeps
    // turn 2 valid but at a new array position, so an index would silently aim
    // at turn 3 and the next action would land on the wrong turn.
    const turns = [
      entry(1, 10, 'alpha'),
      entry(2, 20, 'beta'),
      entry(3, 30, 'beta one'),
      entry(4, 40, 'beta two'),
    ]
    const view = outlineDriver({ reading: () => list(...turns) })
    view.rows()
    view.press(key('down'))
    view.press(typed('/'))
    for (const character of 'beta') view.press(typed(character))
    view.press(key('enter'))
    view.press(key('enter'))
    expect(view.inspected()).toBe(20)
  })

  it('filters locally, reports zero matches, and clears with ctrl-u', () => {
    const turns = [entry(1, 10, 'alpha'), entry(2, 20, 'beta')]
    const view = outlineDriver({ reading: () => list(...turns) })
    view.rows()
    view.press(typed('/'))
    view.press(typed('b'))
    view.press(typed('e'))
    const filtered = view.rows()
    expect(text(filtered)).toContain('beta')
    expect(text(filtered)).not.toContain('alpha')
    view.press(typed('z'))
    expect(text(view.rows())).toContain('No turn matches that filter')
    view.press(key('ctrl-u'))
    expect(text(view.rows())).toContain('alpha')
  })

  it('pre-filters from a `/turns <text>` argument', () => {
    const view = outlineDriver({
      reading: () => list(entry(1, 10, 'alpha'), entry(2, 20, 'beta')),
      initialQuery: 'beta',
    })
    expect(text(view.rows())).toContain('beta')
    expect(text(view.rows())).not.toContain('alpha')
  })

  it('keeps every state bounded on narrow and short terminals', () => {
    const long = entry(1, 10, '上下文的非常长的提示😀'.repeat(20), 'a response '.repeat(40))
    const states: readonly TurnReading[] = [
      { kind: 'projections-unavailable' },
      { kind: 'unregistered' },
      { kind: 'none' },
      list(...Array.from({ length: 40 }, (_, index) => entry(index + 1, index + 10, `turn ${String(index + 1)}`))),
      list(long),
    ]
    for (const reading of states) {
      for (const columns of [6, 8, 12, 20, 40, 80]) {
        for (const rows of [1, 2, 3, 4, 8, 12, 24]) {
          for (const overlay of [
            createTurnsOverlay({ reading: () => reading, inspect: () => {}, invalidate: () => {}, close: () => {} }),
            createTurnInspectionOverlay({
              reading: () => reading,
              initialSeq: SessionSeq(10),
              invalidate: () => {},
              close: () => {},
            }),
          ]) {
            const drawn = overlay.render(columns, rows)
            const physical = drawn.flatMap(row => wrapToWidth(row, columns)).length
            expect(physical, `${String(columns)}x${String(rows)}`).toBeLessThanOrEqual(rows)
          }
        }
      }
    }
  })

  it('keeps a long authoritative preview in one framed row rather than wrapping it', () => {
    // The row prefix (gutter, turn number, gap) must be part of the label
    // budget. Budgeting only the gutter makes the row wider than the frame's
    // inner width, so a wide terminal with room to spare still wraps the turn
    // across two physical rows.
    const preview = 'Investigate why CI suddenly became slower after the runner image update'
    const view = outlineDriver({ reading: () => list(entry(24, 100, preview)) })
    const rows = view.rows(80, 24)
    expect(text(rows)).toContain('Investigate why CI')
    expect(rows[1]).toMatch(/^╭/u)
    // Two borders, one body row, and the leading blank — not a wrapped second.
    expect(rows).toHaveLength(4)
  })

  it('escapes model text and measures wide characters by display columns', () => {
    const view = outlineDriver({
      reading: () => list(entry(1, 10, '上下文\u001b[31mred\nnext')),
    })
    // The RAW rows, before `stripAnsi`: the injected ESC must have become the
    // visible `^[` form rather than being scrubbed by the test helper, which is
    // the difference between escaping it and merely hiding it.
    const raw = view.rawRows(30, 10).join('\n')
    expect(raw).not.toContain('\u001b[31m')
    expect(raw).toContain('^[[31m')
    const rows = view.rows(30, 10)
    expect(text(rows)).toContain('上下文')
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(30)
  })

  it('draws a multi-line preview as separate rows rather than one flattened line', () => {
    const multiline = 'first line\nsecond line\nthird line'
    const view = inspectionDriver({ reading: () => list(entry(1, 10, multiline)), initialSeq: 10 })
    const body = text(view.rows())
    expect(body).toContain('first line')
    expect(body).toContain('second line')
    expect(body).toContain('third line')
    // `escapeControls` preserves a line feed, so one row carrying a raw newline
    // would flatten the three lines above into a single visual line.
    expect(body).not.toContain('first line\nsecond line')
  })
})

describe('the turn inspection surface', () => {
  it('is read-only and shows both bounded previews', () => {
    const view = inspectionDriver({
      reading: () => list(entry(24, 100, 'Investigate why CI slowed.', 'Compared previous runs.')),
      initialSeq: 100,
    })
    const body = text(view.rows())
    expect(body).toContain('Turn 24')
    expect(body).toContain('Prompt')
    expect(body).toContain('Investigate why CI slowed.')
    expect(body).toContain('Response')
    expect(body).toContain('Compared previous runs.')
    expect(body).toContain('esc back')
  })

  it('never treats an empty preview as an open turn', () => {
    const view = inspectionDriver({ reading: () => list(entry(7, 70, '', '')), initialSeq: 70 })
    const body = text(view.rows())
    expect(body).toContain('recorded no prompt preview')
    expect(body).toContain('recorded no response preview')
    // No claim about the turn still running is anywhere on the surface.
    expect(body).not.toMatch(/still|open|running|pending/iu)
  })

  it('walks previous/next by seq and clamps at the ends', () => {
    const turns = [entry(1, 10, 'one'), entry(2, 20, 'two'), entry(3, 30, 'three')]
    const view = inspectionDriver({ reading: () => list(...turns), initialSeq: 20 })
    expect(text(view.rows())).toContain('Turn 2')
    view.press(key('left'))
    expect(text(view.rows())).toContain('Turn 1')
    view.press(key('left'))
    expect(text(view.rows())).toContain('Turn 1')
    view.press(key('right'))
    view.press(key('right'))
    view.press(key('right'))
    expect(text(view.rows())).toContain('Turn 3')
  })

  it('reads the current entry by seq after a live projection update', () => {
    let turns = [entry(2, 20, 'old response')]
    const view = inspectionDriver({ reading: () => list(...turns), initialSeq: 20 })
    expect(text(view.rows())).toContain('old response')
    // The same turn settled with a longer response while the detail was open.
    turns = [entry(2, 20, 'old response', 'new settled response')]
    expect(text(view.rows())).toContain('new settled response')
  })

  it('says so when the selected turn is no longer in the outline', () => {
    const view = inspectionDriver({ reading: () => list(entry(3, 30, 'x')), initialSeq: 20 })
    expect(text(view.rows())).toContain('no longer in this session')
  })

  it('scrolls a long preview instead of growing the frame', () => {
    const long = Array.from({ length: 400 }, (_, index) => `line ${String(index)}`).join('\n')
    const view = inspectionDriver({
      reading: () => list(entry(1, 10, 'prompt', long)),
      initialSeq: 10,
    })
    const first = text(view.rows(80, 20))
    view.press(key('end'))
    const last = text(view.rows(80, 20))
    expect(first).not.toBe(last)
    expect(last).toContain('line 399')
  })

  it('closes on Escape through the shared kernel', () => {
    const view = inspectionDriver({ reading: () => list(entry(1, 10, 'x')), initialSeq: 10 })
    view.press(key('escape'))
    expect(view.closed()).toBe(true)
  })
})

describe('the turns presenter', () => {
  it('mounts an outline, pushes a read-only inspection, and pops it with Escape', () => {
    const { slots, depth, top, closeTop } = stackSlots()
    const presenter = createTurnsPresenter({
      slots,
      snapshot: () => cut({ turnOutline: [entry(1, 10, 'alpha'), entry(2, 20, 'beta')] }),
      invalidate: () => {},
    })
    void presenter.command.execute('')
    expect(depth()).toBe(1)
    expect(stripAnsi(top()?.render(80, 24).join('\n') ?? '')).toContain('Session outline')

    top()?.handleKey(key('enter'))
    expect(depth()).toBe(2)
    expect(stripAnsi(top()?.render(80, 24).join('\n') ?? '')).toContain('Prompt')

    // Escape closes exactly the top surface; the outline is still there.
    closeTop()
    expect(depth()).toBe(1)
    expect(stripAnsi(top()?.render(80, 24).join('\n') ?? '')).toContain('Session outline')
    closeTop()
    expect(depth()).toBe(0)
  })

  it('passes the selected turn/start seq to the inspection surface', () => {
    const { slots, top } = stackSlots()
    const presenter = createTurnsPresenter({
      slots,
      snapshot: () => cut({ turnOutline: [entry(1, 10, 'alpha'), entry(2, 20, 'beta')] }),
      invalidate: () => {},
    })
    void presenter.command.execute('')
    top()?.handleKey(key('down'))
    top()?.handleKey(key('enter'))
    // The inspection surface opened on turn 2, addressed by its seq.
    expect(stripAnsi(top()?.render(80, 24).join('\n') ?? '')).toContain('Turn 2')
  })

  it('reports capability absence honestly instead of folding a fallback', () => {
    const absent = stackSlots()
    const noRegistry = createTurnsPresenter({ slots: absent.slots, snapshot: () => undefined, invalidate: () => {} })
    void noRegistry.command.execute('')
    expect(stripAnsi(absent.top()?.render(80, 24).join('\n') ?? '')).toContain('projections are unavailable')

    const unregistered = stackSlots()
    const noUnit = createTurnsPresenter({ slots: unregistered.slots, snapshot: () => cut({}), invalidate: () => {} })
    void noUnit.command.execute('')
    expect(stripAnsi(unregistered.top()?.render(80, 24).join('\n') ?? '')).toContain('not mounted in this profile')
  })

  it('exposes /turns as a plain local command', () => {
    const { slots } = stackSlots()
    const presenter = createTurnsPresenter({ slots, snapshot: () => undefined, invalidate: () => {} })
    expect(presenter.command.name).toBe('turns')
    expect(presenter.command.description).not.toBe('')
    expect(typeof presenter.command.execute).toBe('function')
    // The "never the Harness registry" half is the module-boundary guard below,
    // which fails if the presenter source ever names `ctx.commands` at all.
  })
})

describe('the turns module boundary', () => {
  it('contains no second fold of session events', () => {
    // The projection stays the only authority: reading these names from source
    // fails the day someone reaches for the raw log instead of the snapshot.
    const root = fileURLToPath(new URL('../src/turns', import.meta.url))
    const source = sourceFiles(root).map(path => readFileSync(path, 'utf8')).join('\n')
    expect(source).not.toMatch(/session\/event|session\.append|snapshotEvents|eventAt|sessionQuery|sessionController|ctx\.agents|ctx\.commands|inheritedEventCount|turn\/end/u)
  })
})

/** Find production source files under a directory, recursively. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : []
  })
}

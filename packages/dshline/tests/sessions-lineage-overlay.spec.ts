/** Tests for the lineage browser's ordering, keyboard, safety, and bounds. */

import { describe, expect, it, vi } from 'vitest'
import type { Key, KeyName } from '@dshline/renderer'
import { displayWidth, Screen, stripAnsi } from '@dshline/renderer'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createEmulator } from '../../../tests/emulator.ts'
import type { LineageRow, LineageState } from '../src/sessions/model.ts'
import type { LineageOverlaySpec } from '../src/sessions/lineage-overlay.ts'
import { createLineageOverlay } from '../src/sessions/lineage-overlay.ts'

/** Comfortable dimensions used by non-emulator assertions. */
const COLUMNS = 90
const ROWS = 24

/** Fixed clock for exact relative ages and notice expiry. */
const NOW = 1_800_000_000_000

/** Default session this lineage browser opens on. */
const TARGET = 'target' as SessionId

/** A session-bearing lineage row. */
type SessionRow = Exclude<LineageRow, { kind: 'pruned' }>

/**
 * Make one lineage session row.
 * @param kind - the row's place relative to the target.
 * @param id - stable session identity.
 * @param depth - tree indentation depth.
 * @param overrides - fields to replace.
 * @returns one session-bearing row.
 */
function row(
  kind: SessionRow['kind'],
  id: string,
  depth: number,
  overrides: Partial<SessionRow> = {},
): SessionRow {
  return {
    kind,
    id: id as SessionId,
    depth,
    title: `Title ${id}`,
    createdAt: NOW - 7_200_000,
    cwd: '/home/dev/projects/dshline',
    origin: 'own',
    ...overrides,
  }
}

/**
 * Make a landed lineage state.
 * @param rows - already-flattened tree rows.
 * @param targetRow - stable target position in those rows.
 * @param overrides - state fields to replace.
 * @returns ready lineage state.
 */
function ready(
  rows: readonly LineageRow[],
  targetRow: number,
  overrides: Partial<Extract<LineageState, { kind: 'ready' }>> = {},
): Extract<LineageState, { kind: 'ready' }> {
  return {
    kind: 'ready',
    sessionId: TARGET,
    rows,
    targetRow,
    complete: true,
    ...overrides,
  }
}

/** Inputs a test may replace on the overlay owner. */
interface Harness {
  state?: LineageState
  target?: SessionId | undefined
  focus?: (sessionId: SessionId) => boolean
  now?: () => number
  mount?: boolean
}

/** An overlay plus recorded owner interactions. */
interface Mounted {
  readonly overlay: ReturnType<typeof createLineageOverlay>
  render(columns?: number, rows?: number): string[]
  press(...keys: Key[]): void
  readonly requested: SessionId[]
  readonly focused: SessionId[]
  readonly closed: () => boolean
}

/**
 * Mount one lineage overlay with recorded owner calls.
 * @param harness - state and authority overrides.
 * @returns the overlay and interaction records.
 */
function mount(harness: Harness = {}): Mounted {
  const fallback = ready([row('target', 'target', 0)], 0)
  const requested: SessionId[] = []
  const focused: SessionId[] = []
  let closed = false
  const spec: LineageOverlaySpec = {
    lineage: () => harness.state ?? fallback,
    requestLineage: sessionId => { requested.push(sessionId) },
    target: !('target' in harness) ? TARGET : harness.target,
    home: '/home/dev',
    now: harness.now ?? ((): number => NOW),
    focus: sessionId => {
      focused.push(sessionId)
      return harness.focus?.(sessionId) ?? true
    },
    close: () => { closed = true },
    invalidate: () => {},
  }
  const overlay = createLineageOverlay(spec)
  if (harness.mount !== false) overlay.mounted?.()
  return {
    overlay,
    render: (columns = COLUMNS, rows = ROWS) => [...overlay.render(columns, rows)],
    press: (...keys) => { for (const one of keys) overlay.handleKey(one) },
    requested,
    focused,
    closed: () => closed,
  }
}

/**
 * One decoded named key.
 * @param name - key name.
 * @returns the decoded keystroke.
 */
function key(name: KeyName): Key {
  return { kind: 'key', name }
}

/**
 * Strip styling from everything an overlay draws.
 * @param view - mounted overlay.
 * @param columns - terminal width.
 * @param rows - terminal height.
 * @returns plain rendered frame.
 */
function plain(view: Mounted, columns = COLUMNS, rows = ROWS): string {
  return view.render(columns, rows).map(stripAnsi).join('\n')
}

/** An erase-display sequence a stored title, id, or error could contain. */
const ERASE_DISPLAY = '\u001b[2Jafter'

describe('opening and read states', () => {
  it('requests the target trace once when opening', () => {
    // Deliberate break: requesting from render makes the second render fail this count.
    const view = mount({ state: { kind: 'idle' } })
    view.render()
    view.render()
    expect(view.requested).toEqual([TARGET])
  })

  it('does not re-request an already-ready target when mounted again', () => {
    // Deliberate break: treating every mount as idle adds an unwanted request.
    const view = mount({ mount: false })
    view.overlay.mounted?.()
    view.overlay.mounted?.()
    expect(view.requested).toEqual([])
  })

  it.each([
    [{ kind: 'idle' } as LineageState, 'No lineage read yet.'],
    [{ kind: 'loading', sessionId: TARGET } as LineageState, 'Reading lineage…'],
  ])('renders the non-tree read state %#', (state, expected) => {
    // Deliberate break: an empty body makes the current read state indistinguishable.
    expect(plain(mount({ state }))).toContain(expected)
  })

  it('escapes a failed lineage message before drawing it', () => {
    // Deliberate break: drawing Harness's failure verbatim lets its CSI erase the frame.
    const view = mount({ state: { kind: 'failed', sessionId: TARGET, message: ERASE_DISPLAY } })
    const rendered = view.render().join('\n')
    expect(rendered).not.toContain(ERASE_DISPLAY)
    const text = view.render().map(stripAnsi).join('\n')
    expect(text).toContain('Lineage failed: ^[[2Jafter')
    expect(text).not.toContain('\u001b')
  })
})

describe('the flattened tree', () => {
  it('renders a root as one target with no invented relatives', () => {
    // Deliberate break: adding a synthetic ancestor or descendant introduces another title.
    const view = mount({ state: ready([row('target', 'root', 0, { title: 'ROOT-ONLY' })], 0) })
    const drawn = plain(view)
    expect(drawn.match(/ROOT-ONLY/gu)).toHaveLength(1)
    expect(drawn).not.toContain('parent is not')
    expect(drawn).not.toContain('descendants hidden')
  })

  it('preserves parents outermost-first and children depth-first', () => {
    // Deliberate break: reversing ancestors to immediate-first changes these offsets.
    const rows = [
      row('ancestor', 'root', 0),
      row('ancestor', 'parent', 1),
      row('target', 'target', 2),
      row('descendant', 'child-a', 3),
      row('descendant', 'grandchild-a', 4),
      row('descendant', 'child-b', 3),
    ]
    const drawn = plain(mount({ state: ready(rows, 2) }))
    const labels = rows.map(item => `Title ${item.kind === 'pruned' ? '' : item.id}`)
    for (let index = 1; index < labels.length; index += 1) {
      expect(drawn.indexOf(labels[index - 1]!)).toBeLessThan(drawn.indexOf(labels[index]!))
    }
  })

  it('starts the cursor on the target row', () => {
    // Deliberate break: initializing selection to row zero highlights the ancestor.
    const state = ready([
      row('ancestor', 'root', 0),
      row('target', 'target', 1),
      row('descendant', 'child', 2),
    ], 1)
    const selection = plain(mount({ state })).split('\n').find(line => line.includes('❯'))
    expect(selection).toContain('Title target')
  })

  it('skips pruned marker rows while moving', () => {
    // Deliberate break: incrementing the raw row index makes Enter land on the marker.
    const state = ready([
      row('target', 'target', 0),
      { kind: 'pruned', depth: 1, label: '… 8 descendants hidden' },
      row('descendant', 'child', 1),
    ], 0)
    const view = mount({ state })
    view.press(key('down'), key('enter'))
    expect(view.focused).toEqual(['child'])
  })

  it('wraps movement and jumps to the first and last selectable rows', () => {
    // Deliberate break: clamping raw indices makes up stop at the target or end land on pruning.
    const state = ready([
      row('ancestor', 'root', 0),
      row('target', 'target', 1),
      { kind: 'pruned', depth: 2, label: '… 3 descendants hidden' },
      row('descendant', 'child', 2),
    ], 1)
    const view = mount({ state })
    view.press(key('home'), key('up'), key('enter'))
    expect(view.focused.at(-1)).toBe('child')

    const end = mount({ state })
    end.press(key('end'), key('enter'))
    expect(end.focused.at(-1)).toBe('child')
  })

  it('shows exact ancestor and descendant pruning counts', () => {
    // Deliberate break: recomputing either bound locally changes the catalog's exact count.
    const state = ready([
      { kind: 'pruned', depth: 0, label: '… 12 earlier ancestors' },
      row('target', 'target', 1),
      { kind: 'pruned', depth: 2, label: '… 37 descendants hidden' },
    ], 1)
    const drawn = plain(mount({ state }))
    expect(drawn).toContain('… 12 earlier ancestors')
    expect(drawn).toContain('… 37 descendants hidden')
  })

  it('renders an escaped unresolved parent above the known tree', () => {
    // Deliberate break: omitting or drawing this id raw either hides the gap or executes CSI.
    const state = ready([row('target', 'target', 0)], 0, {
      complete: false,
      unresolvedParentId: ERASE_DISPLAY as SessionId,
    })
    const rendered = mount({ state }).render()
    const text = rendered.map(stripAnsi).join('\n')
    expect(text.indexOf('parent ^[[2Jafter')).toBeLessThan(text.indexOf('Title target'))
    expect(text).toContain('— parent ^[[2Jafter is not in the visible corpus')
    expect(text).not.toContain('\u001b')
  })

  it('fits CJK titles by display columns and preserves a deep title floor', () => {
    // Deliberate break: string-length cutting lets the wide title cross the right border.
    const state = ready([
      row('target', 'target', 30, { title: '审查渲染器'.repeat(40), origin: 'delegated' }),
    ], 0)
    const rendered = mount({ state }).render(70, ROWS)
    expect(rendered).toHaveLength(6)
    for (const physical of rendered) expect(displayWidth(stripAnsi(physical))).toBeLessThanOrEqual(70)
    expect(rendered.map(stripAnsi).join('\n')).toContain('审查')
  })

  it('shows restrained metadata and selected workspace detail', () => {
    // Deliberate break: copying list badges would add `open`; omitting detail loses path and id.
    const state = ready([
      row('target', 'target', 0, { origin: 'delegated' }),
    ], 0)
    const wide = plain(mount({ state }))
    expect(wide).toContain('delegated · 2h ago')
    expect(wide).toContain('~/projects/dshline · target')
    expect(wide).not.toContain('open')
    // Deliberate break: keeping badges below the title floor makes metadata eat identity.
    const narrower = plain(mount({ state }), 49, ROWS)
    expect(narrower).toContain('2h ago')
    expect(narrower).not.toContain('delegated')
  })
})

describe('focusing and closing', () => {
  it('focuses a visible row and closes', () => {
    // Deliberate break: forgetting the successful close leaves two browsers handling keys.
    const view = mount()
    view.press(key('enter'))
    expect(view.focused).toEqual([TARGET])
    expect(view.closed()).toBe(true)
  })

  it('keeps the overlay open with a notice when the parent cannot show the row', () => {
    // Deliberate break: always closing discards the only explanation for the refusal.
    const view = mount({ focus: () => false })
    view.press(key('enter'))
    expect(view.closed()).toBe(false)
    expect(plain(view)).toContain('That session is not in the current list.')
  })

  it('expires a refused-focus notice after four seconds', () => {
    // Deliberate break: a permanent notice hides the tree after one stale focus attempt.
    let clock = NOW
    const view = mount({ focus: () => false, now: () => clock })
    view.press(key('enter'))
    expect(plain(view)).toContain('That session is not in the current list.')
    clock += 4_000
    expect(plain(view)).not.toContain('That session is not in the current list.')
  })

  it('asks for a repaint at expiry, and none after close', () => {
    // An idle tree has no heartbeat, so the notice's own timer retires the
    // refusal without a keypress.
    vi.useFakeTimers()
    try {
      let invalidates = 0
      const overlay = createLineageOverlay({
        lineage: () => ready([row('target', 'target', 0)], 0),
        requestLineage: () => {},
        target: TARGET,
        home: '/home/dev',
        now: () => Date.now(),
        focus: () => false,
        close: () => {},
        invalidate: () => { invalidates += 1 },
      })
      overlay.render(COLUMNS, ROWS)
      overlay.handleKey({ kind: 'key', name: 'enter' })
      const afterShow = invalidates
      vi.advanceTimersByTime(4_000)
      expect(invalidates).toBe(afterShow + 1)

      overlay.handleKey({ kind: 'key', name: 'enter' })
      const beforeDispose = invalidates
      overlay.dispose?.()
      vi.advanceTimersByTime(4_000)
      expect(invalidates).toBe(beforeDispose)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores text and closes on escape or ctrl-c', () => {
    // Deliberate break: treating text as navigation changes the selected session.
    const view = mount()
    view.press({ kind: 'text', text: 'down' }, key('escape'))
    expect(view.focused).toEqual([])
    expect(view.closed()).toBe(true)
    const ctrl = mount()
    ctrl.press(key('ctrl-c'))
    expect(ctrl.closed()).toBe(true)
  })
})

describe('bounded terminal rendering', () => {
  /** More rows than either emulator window can show. */
  const many = [
    row('target', 'target', 0, { title: 'LINEAGE-FIRST-SENTINEL' }),
    ...Array.from({ length: 70 }, (_unused, index) => row(
      'descendant',
      `child-${String(index)}`,
      Math.min(index + 1, 20),
      { title: index === 69 ? 'LINEAGE-LAST-SENTINEL' : `Child ${String(index)}` },
    )),
  ]

  it.each([24, 15])('keeps the frame inside a %i-row terminal and follows the end', async terminalRows => {
    // Deliberate break: removing viewport follow makes the last sentinel stay below the window.
    const emulator = createEmulator(80, terminalRows)
    const screen = new Screen(emulator.target)
    screen.commit(['TRANSCRIPT before lineage A', 'TRANSCRIPT before lineage B'])
    const view = mount({ state: ready(many, 0) })
    const draw = (): void => { screen.setLive(view.render(80, terminalRows)) }
    draw()
    for (let press = 0; press < many.length - 1; press += 1) view.press(key('down'))
    draw()
    const visible = await emulator.screen()
    const all = await emulator.scrollback()
    expect(visible.length).toBeLessThanOrEqual(terminalRows)
    expect(visible.join('\n')).toContain('LINEAGE-LAST-SENTINEL')
    expect(all.filter(line => line.includes('TRANSCRIPT before lineage A'))).toHaveLength(1)
    expect(all.filter(line => line.includes('TRANSCRIPT before lineage B'))).toHaveLength(1)
    expect(all.filter(line => line.includes('LINEAGE-FIRST-SENTINEL'))).toHaveLength(0)
    emulator.dispose()
  })

  it('uses a compact summary at forty columns and lets a notice replace it', () => {
    // Deliberate break: forcing the full frame at this width collides hierarchy and metadata.
    const view = mount({ focus: () => false })
    expect(plain(view, 40, ROWS)).toBe('Lineage · 1 rows · esc back')
    view.press(key('enter'))
    const refused = plain(view, 40, ROWS)
    expect(refused).toContain('That session is not in the current')
    expect(refused).not.toContain('Lineage · 1 rows')
  })

  it('leaves no lineage rows behind after unmount', async () => {
    // Deliberate break: committing overlay rows leaves the sentinel in scrollback.
    const emulator = createEmulator(80, ROWS)
    const screen = new Screen(emulator.target)
    screen.commit(['TRANSCRIPT before lineage'])
    const view = mount({ state: ready(many, 0) })
    screen.setLive(view.render(80, ROWS))
    screen.setLive(['', '  composer'])
    const all = await emulator.scrollback()
    expect(all.filter(line => line.includes('LINEAGE-FIRST-SENTINEL'))).toHaveLength(0)
    expect(all.filter(line => line.includes('Sessions · lineage'))).toHaveLength(0)
    expect(all.filter(line => line.includes('TRANSCRIPT before lineage'))).toHaveLength(1)
    expect(all.at(-1)).toContain('composer')
    emulator.dispose()
  })
})

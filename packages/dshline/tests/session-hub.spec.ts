/** Tests for the isolated current-session hub's presentation and routing. */

import { describe, expect, it } from 'vitest'
import type { Key, KeyName } from '@dshline/renderer'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TuiOverlay } from '../src/slots.ts'
import type { CurrentSessionHubCapabilities, CurrentSessionReading } from '../src/session/model.ts'
import type { CurrentSessionRenameOutcome } from '../src/session/overlay.ts'
import { createCurrentSessionHubPresenter } from '../src/session/presenter.ts'

/** Comfortable terminal geometry for ordinary hub frames. */
const COLUMNS = 90
const ROWS = 24

/** Stable session identity carried through child factory calls. */
const SESSION = 'current-session' as SessionId

/** All actions enabled for a fully capable current attachment. */
const ALL_CAPABILITIES: CurrentSessionHubCapabilities = {
  findConversation: true,
  turns: true,
  lineage: true,
  rename: true,
}

/** One named decoded key. */
function key(name: KeyName): Key {
  return { kind: 'key', name }
}

/** One printable decoded key. */
function text(value: string): Key {
  return { kind: 'text', text: value }
}

/** Controls a hub mounted on a small normal-overlay-stack double. */
interface Mounted {
  readonly press: (...keys: Key[]) => void
  readonly rows: (columns?: number, rows?: number) => string[]
  readonly depth: () => number
  readonly turns: () => number
  readonly renames: () => number
  readonly navigatorCalls: () => number
}

/** Mount a hub and record its owner callbacks without any Harness context. */
function mount(options: {
  readonly reading?: CurrentSessionReading
  readonly capabilities?: CurrentSessionHubCapabilities
  readonly rename?: () => Promise<CurrentSessionRenameOutcome>
} = {}): Mounted {
  const stack: TuiOverlay[] = []
  let turns = 0
  let renames = 0
  let navigatorCalls = 0
  const push = (overlay: TuiOverlay): (() => void) => {
    stack.push(overlay)
    overlay.mounted?.()
    return () => {
      const index = stack.indexOf(overlay)
      if (index >= 0) stack.splice(index, 1)
      overlay.dispose?.()
    }
  }
  const presenter = createCurrentSessionHubPresenter({
    reading: () => options.reading ?? {
      sessionId: SESSION,
      title: 'Repair session presentation',
      facts: [
        { label: 'Workspace', value: '/work/dshline' },
        { label: 'Mode', value: 'review' },
      ],
    },
    capabilities: () => options.capabilities ?? ALL_CAPABILITIES,
    navigator: {
      events: () => { navigatorCalls += 1; return { kind: 'idle' } },
      searchEvents: () => { navigatorCalls += 1 },
      loadMoreEvents: () => { navigatorCalls += 1 },
      requestEventContext: () => { navigatorCalls += 1 },
      eventContext: () => { navigatorCalls += 1; return { kind: 'idle' } },
      lineage: () => { navigatorCalls += 1; return { kind: 'idle' } },
      requestLineage: () => { navigatorCalls += 1 },
    },
    openTurns: () => { turns += 1 },
    rename: options.rename === undefined
      ? async () => { renames += 1; return { kind: 'cancelled' as const } }
      : async () => {
        renames += 1
        return options.rename!()
      },
    home: '/home/dev',
    now: () => 1_800_000_000_000,
    push,
    invalidate: () => {},
  })
  presenter.open()
  return {
    press: (...keys) => { for (const one of keys) stack.at(-1)?.handleKey(one) },
    rows: (columns = COLUMNS, rows = ROWS) => [...(stack.at(-1)?.render(columns, rows) ?? [])],
    depth: () => stack.length,
    turns: () => turns,
    renames: () => renames,
    navigatorCalls: () => navigatorCalls,
  }
}

/** Read rows as a reader sees them, without styling. */
function plain(view: Mounted, columns = COLUMNS, rows = ROWS): string {
  return view.rows(columns, rows).map(stripAnsi).join('\n')
}

describe('current session hub rendering', () => {
  it('renders owner-supplied title, facts, and only enabled actions', () => {
    const view = mount()
    const drawn = plain(view)
    expect(drawn).toContain('Repair session presentation')
    expect(drawn).toContain('Workspace')
    expect(drawn).toContain('/work/dshline')
    expect(drawn).toContain('Find in conversation')
    expect(drawn).toContain('Turns')
    expect(drawn).toContain('Lineage')
    expect(drawn).toContain('Rename')
    // Rendering only reads owner state; a navigator child opens on action.
    expect(view.navigatorCalls()).toBe(0)
  })

  it('reports a missing attachment and does not advertise unavailable controls', () => {
    const view = mount({
      reading: { sessionId: undefined },
      capabilities: { findConversation: false, turns: false, lineage: false, rename: false },
    })
    expect(plain(view)).toContain('No current session is attached.')
    view.press(text('f'), text('t'), text('l'), text('r'), key('enter'))
    expect(view.depth()).toBe(1)
    expect(view.turns()).toBe(0)
    expect(view.renames()).toBe(0)
  })

  it('escapes controls and truncates all supplied rows by display width', () => {
    const control = '\u001b[2Jafter'
    const view = mount({
      reading: {
        sessionId: SESSION,
        title: `${control}审查`.repeat(40),
        facts: [{ label: `${control}Label`, value: `${control}\n审查`.repeat(40) }],
      },
    })
    const rows = view.rows(48, ROWS)
    expect(rows.join('\n')).not.toContain(control)
    expect(rows.map(stripAnsi).join('\n')).toContain('^[[2Jafter')
    for (const row of rows) expect(displayWidth(stripAnsi(row))).toBeLessThanOrEqual(48)
  })

  it('uses the shared compact fallback and retains escape on tiny geometry', () => {
    const view = mount()
    expect(plain(view, 20, 2)).toContain('esc')
    expect(view.rows(20, 2)).toHaveLength(1)
  })
})

describe('current session hub actions', () => {
  it('pushes Find as a normal child and escape returns to the hub', () => {
    const view = mount()
    view.press(text('f'))
    expect(view.depth()).toBe(2)
    expect(plain(view)).toContain('Sessions · events')
    view.press(key('escape'))
    expect(view.depth()).toBe(1)
    expect(plain(view)).toContain('Current session')
  })

  it('routes accelerator and selected Enter to equivalent actions', () => {
    const findKey = mount()
    findKey.press(text('f'))
    const findEnter = mount()
    findEnter.press(key('enter'))
    expect(plain(findKey)).toContain('Sessions · events')
    expect(plain(findEnter)).toContain('Sessions · events')

    const turnsKey = mount()
    turnsKey.press(text('t'))
    const turnsEnter = mount()
    turnsEnter.press(key('down'), key('enter'))
    expect(turnsKey.turns()).toBe(1)
    expect(turnsEnter.turns()).toBe(1)

    const lineageKey = mount()
    lineageKey.press(text('l'))
    const lineageEnter = mount()
    lineageEnter.press(key('down'), key('down'), key('enter'))
    expect(plain(lineageKey)).toContain('Sessions · lineage')
    expect(plain(lineageEnter)).toContain('Sessions · lineage')

    const renameKey = mount()
    renameKey.press(text('r'))
    const renameEnter = mount()
    renameEnter.press(key('down'), key('down'), key('down'), key('enter'))
    expect(renameKey.renames()).toBe(1)
    expect(renameEnter.renames()).toBe(1)
  })

  it('closes the hub itself on escape after no child is active', () => {
    const view = mount()
    view.press(key('escape'))
    expect(view.depth()).toBe(0)
  })

  it('offers Rename again after a dismissed prompt rather than latching it off', async () => {
    // A cancelled outcome must clear the pending flag: otherwise one Escape in
    // the title prompt would leave the action permanently inert.
    const view = mount()
    view.press(text('r'))
    await new Promise<void>(resolve => setImmediate(resolve))
    view.press(text('r'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(view.renames()).toBe(2)
  })

  it('reports a refused rename as a notice instead of failing silently', async () => {
    const view = mount({ rename: async () => ({ kind: 'failed', message: 'not live in this store' }) })
    view.press(text('r'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(plain(view)).toContain('Rename failed: not live in this store')
  })
})

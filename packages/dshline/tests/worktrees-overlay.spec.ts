/**
 * `/worktrees`: the place first, then the conversation.
 *
 * The behaviour worth pinning is the ORDER. Selecting a worktree must open a
 * second question rather than resume something, `+ New session` must be a
 * first-class answer to that question, and going back must not have chosen
 * anything. Everything else here is the ordinary overlay contract this
 * project's other browsers already keep: a bounded frame, a truthful empty
 * state, and a refusal that says which rule refused.
 */

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Key } from '@dshline/renderer'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import type { CatalogState, SessionEntry } from '../src/sessions/model.ts'
import type { NewPlan, ResumePlan } from '../src/sessions/plan.ts'
import type { RegisterOutcome } from '../src/worktrees/catalog.ts'
import type { WorktreeListing, WorktreeRow, WorktreeSelection } from '../src/worktrees/model.ts'
import { createWorktreesOverlay } from '../src/worktrees/overlay.ts'

/** The reader's home, so shortened paths are assertable. */
const HOME = '/home/dev'

/** A fixed instant, so relative ages are assertable. */
const NOW = 1_800_000_000_000

/**
 * One session row in a workspace's listing.
 * @param id - the session id.
 * @param title - its folded title.
 * @param minutesAgo - how long before {@link NOW} it was created.
 * @param overrides - entry fields to replace.
 * @returns the entry.
 */
function entry(
  id: string,
  title: string | undefined,
  minutesAgo: number,
  overrides: Partial<SessionEntry> = {},
): SessionEntry {
  return {
    id: id as SessionId,
    title,
    createdAt: NOW - minutesAgo * 60_000,
    cwd: `${HOME}/src/dshline-auth`,
    live: false,
    persisted: true,
    parent: undefined,
    origin: 'own',
    ...overrides,
  }
}

/** The three workspaces the picker lists. */
const ROWS: readonly WorktreeRow[] = [
  { id: 'ws-main', title: 'dshline', path: `${HOME}/src/dshline`, sessions: 2, current: true },
  { id: 'ws-auth', title: 'auth experiment', path: `${HOME}/src/dshline-auth`, sessions: 1, current: false },
  { id: 'ws-quiet', title: 'workspaces', path: `${HOME}/src/dshline-workspaces`, sessions: 0, current: false },
]

/** The sessions the `auth experiment` workspace holds. */
const AUTH_SESSIONS: CatalogState = {
  kind: 'ready',
  truncated: 0,
  entries: [
    entry('s-auth', 'Implement auth flow', 18),
    entry('s-token', 'Investigate token refresh', 120),
    entry('s-old', 'Previous conversation', 3 * 24 * 60),
  ],
}

/** What one opened picker reports back. */
interface Opened {
  readonly rows: (columns?: number, rows?: number) => string[]
  readonly press: (key: Key) => void
  readonly type: (text: string) => void
  readonly opened: () => readonly string[]
  readonly wentBack: () => number
  readonly registered: () => readonly string[]
  readonly closed: () => boolean
}

/** How one case configures the picker it opens. */
interface Options {
  readonly listing?: WorktreeListing
  readonly unregistered?: string
  /** Which workspace the second view is showing, if any. */
  readonly selected?: WorktreeSelection
  readonly resume?: (entry: SessionEntry) => ResumePlan
  readonly create?: (workspace: WorktreeRow) => NewPlan
  readonly register?: (path: string) => Promise<RegisterOutcome>
  readonly currentSessionId?: SessionId
}

/**
 * Open the picker over one listing.
 *
 * `open`/`back` mutate a local selection exactly as the catalog does, so a
 * case can drive the real two-view navigation without a harness.
 * @param options - the listing, the selection, and the plans.
 * @returns handles for driving and reading it.
 */
function open(options: Options = {}): Opened {
  const listing: WorktreeListing = options.listing ?? { kind: 'ready', rows: ROWS }
  const openedIds: string[] = []
  const registeredPaths: string[] = []
  let backs = 0
  let closed = false
  let selection = options.selected
  const overlay = createWorktreesOverlay({
    listing: () => listing,
    unregistered: () => options.unregistered,
    selection: () => selection,
    open: (workspaceId) => {
      openedIds.push(workspaceId)
      const workspace = listing.kind === 'ready'
        ? listing.rows.find(row => row.id === workspaceId)
        : undefined
      if (workspace !== undefined) {
        selection = {
          workspace,
          status: 'ok',
          sessions: workspaceId === 'ws-auth' ? AUTH_SESSIONS : { kind: 'ready', entries: [], truncated: 0 },
        }
      }
    },
    back: () => {
      backs += 1
      selection = undefined
    },
    register: async (path) => {
      registeredPaths.push(path)
      return await (options.register?.(path) ?? Promise.resolve<RegisterOutcome>({
        kind: 'registered',
        workspaceId: 'ws-new',
      }))
    },
    resume: options.resume ?? (() => ({ kind: 'resume' })),
    create: options.create ?? (() => ({ kind: 'new' })),
    ...(options.currentSessionId === undefined ? {} : { currentSessionId: options.currentSessionId }),
    home: HOME,
    now: () => NOW,
    close: () => { closed = true },
    invalidate: () => {},
  })
  return {
    rows: (columns = 88, rows = 26) => overlay.render(columns, rows).map(stripAnsi),
    press: key => { overlay.handleKey(key) },
    type: text => { overlay.handleKey({ kind: 'text', text }) },
    opened: () => openedIds,
    wentBack: () => backs,
    registered: () => registeredPaths,
    closed: () => closed,
  }
}

/**
 * The BODY row containing some text.
 *
 * The frame's own borders are excluded, because the left title is literally
 * `dshline` and would answer for the workspace of the same name.
 * @param rows - rendered rows.
 * @param text - the text to find.
 * @returns the row, or undefined.
 */
function rowFor(rows: readonly string[], text: string): string | undefined {
  return body(rows).find(row => row.includes(text))
}

/**
 * The rows inside the frame: no leading blank, no top or bottom border.
 * @param rows - rendered rows.
 * @returns the body rows.
 */
function body(rows: readonly string[]): readonly string[] {
  return rows.filter(row => !row.startsWith('╭') && !row.startsWith('╰') && row !== '')
}

/** A key with no text payload. */
const key = (name: Key extends { name: infer N } ? N : never): Key => ({ kind: 'key', name } as Key)

describe('the worktree picker', () => {
  it('opens on the workspace list, naming every known worktree with its path', () => {
    const rows = open().rows()
    expect(rowFor(rows, 'Worktrees · 3 known')).toBeDefined()
    expect(rowFor(rows, 'dshline')).toContain('~/src/dshline')
    expect(rowFor(rows, 'auth experiment')).toContain('~/src/dshline-auth')
    expect(rowFor(rows, 'workspaces')).toContain('~/src/dshline-workspaces')
  })

  it('marks the workspace this window is rooted in, and claims nothing about other processes', () => {
    const rows = open().rows()
    expect(rowFor(rows, 'dshline')).toContain('current')
    expect(rowFor(rows, 'auth experiment')).not.toContain('current')
    // `ctx.agents` is process-local and the adopted Harness generation
    // publishes no cross-process ownership contract, so no row may suggest one.
    for (const row of body(rows)) {
      expect(row).not.toMatch(/another terminal|elsewhere|take over|idle in/iu)
    }
  })

  it('reports the registry\'s own membership count beside each worktree', () => {
    const rows = open().rows()
    expect(rowFor(rows, 'auth experiment')).toContain('1 session')
    expect(rowFor(rows, 'workspaces')).toContain('no sessions')
  })

  it('closes on esc from the workspace list, having chosen nothing', () => {
    const picker = open()
    picker.press(key('escape'))
    expect(picker.closed()).toBe(true)
    expect(picker.opened()).toEqual([])
  })

  it('filters by title and path as you type, and esc gives the list back first', () => {
    const picker = open()
    picker.type('auth')
    let rows = picker.rows()
    expect(rowFor(rows, 'auth experiment')).toBeDefined()
    expect(rowFor(rows, 'workspaces')).toBeUndefined()
    expect(rowFor(rows, 'filter: auth')).toBeDefined()
    picker.press(key('escape'))
    rows = picker.rows()
    expect(picker.closed()).toBe(false)
    expect(rowFor(rows, 'workspaces')).toBeDefined()
  })
})

describe('choosing a worktree', () => {
  it('opens that worktree\'s sessions instead of resuming one of them', () => {
    let resumes = 0
    const picker = open({ resume: () => { resumes += 1; return { kind: 'resume' } } })
    picker.press(key('down'))
    picker.press(key('enter'))
    expect(picker.opened()).toEqual(['ws-auth'])
    expect(picker.closed()).toBe(false)
    // The whole reason this is two views: a directory is not a conversation.
    expect(resumes).toBe(0)
  })

  it('shows the workspace\'s identity and its sessions, newest first, with + New session on top', () => {
    const picker = open()
    picker.press(key('down'))
    picker.press(key('enter'))
    const rows = picker.rows()
    expect(rowFor(rows, 'auth experiment')).toBeDefined()
    expect(rowFor(rows, '~/src/dshline-auth')).toBeDefined()
    expect(rowFor(rows, '+ New session')).toBeDefined()
    expect(rowFor(rows, 'Implement auth flow')).toContain('18m ago')
    expect(rowFor(rows, 'Previous conversation')).toContain('3d ago')
    const order = rows.findIndex(row => row.includes('+ New session'))
    const first = rows.findIndex(row => row.includes('Implement auth flow'))
    expect(order).toBeLessThan(first)
  })

  it('discloses a workspace on → but never triggers the register row with it', () => {
    const picker = open({ unregistered: `${HOME}/src/fresh-worktree` })
    picker.press(key('right'))
    expect(picker.opened()).toEqual(['ws-main'])
    picker.press(key('left'))
    for (let step = 0; step < 3; step += 1) picker.press(key('down'))
    picker.press(key('right'))
    // A durable Harness write is not something an arrow key performs.
    expect(picker.registered()).toEqual([])
  })

  it('goes back to the workspace list on ← without choosing anything', () => {
    const picker = open()
    picker.press(key('enter'))
    picker.press(key('left'))
    expect(picker.wentBack()).toBe(1)
    expect(picker.closed()).toBe(false)
    expect(rowFor(picker.rows(), 'Worktrees · 3 known')).toBeDefined()
  })

  it('spends esc on going back before it spends it on closing', () => {
    const picker = open()
    picker.press(key('enter'))
    picker.press(key('escape'))
    expect(picker.wentBack()).toBe(1)
    expect(picker.closed()).toBe(false)
    picker.press(key('escape'))
    expect(picker.closed()).toBe(true)
  })

  it('leaves with ctrl-c from either view', () => {
    const first = open()
    first.press(key('ctrl-c'))
    expect(first.closed()).toBe(true)
    const second = open()
    second.press(key('enter'))
    second.press(key('ctrl-c'))
    expect(second.closed()).toBe(true)
  })
})

describe('choosing what happens in that worktree', () => {
  it('reopens the selected session when the resume plan accepts it', () => {
    const chosen: SessionEntry[] = []
    const picker = open({
      resume: (target) => { chosen.push(target); return { kind: 'resume' } },
    })
    picker.press(key('down'))
    picker.press(key('enter'))
    picker.press(key('down'))
    picker.press(key('enter'))
    expect(chosen.map(target => target.id)).toEqual(['s-auth'])
    expect(picker.closed()).toBe(true)
  })

  it('says which rule refused a resume and stays open on it', () => {
    const picker = open({
      resume: () => ({ kind: 'refused', message: 'That session is already live in this process.' }),
    })
    picker.press(key('down'))
    picker.press(key('enter'))
    picker.press(key('down'))
    picker.press(key('enter'))
    expect(picker.closed()).toBe(false)
    expect(rowFor(picker.rows(), 'already live in this process')).toBeDefined()
  })

  it('starts a fresh session in the selected worktree from the + New session row', () => {
    const created: WorktreeRow[] = []
    const picker = open({ create: (workspace) => { created.push(workspace); return { kind: 'new' } } })
    picker.press(key('down'))
    picker.press(key('enter'))
    picker.press(key('enter'))
    expect(created.map(workspace => workspace.path)).toEqual([`${HOME}/src/dshline-auth`])
    expect(picker.closed()).toBe(true)
  })

  it('offers n as the same gesture, only in the view where a bare letter is free', () => {
    const created: WorktreeRow[] = []
    const picker = open({ create: (workspace) => { created.push(workspace); return { kind: 'new' } } })
    // In the first view every printable character is filter input, so `n`
    // must narrow the list rather than start a session.
    picker.type('n')
    expect(created).toEqual([])
    picker.press(key('escape'))
    picker.press(key('down'))
    picker.press(key('enter'))
    picker.type('n')
    expect(created.map(workspace => workspace.id)).toEqual(['ws-auth'])
    expect(picker.closed()).toBe(true)
  })

  it('says which rule refused a fresh session and stays open on it', () => {
    const picker = open({
      create: () => ({ kind: 'refused', message: '2 jobs or subagents are still attached to this session.' }),
    })
    picker.press(key('enter'))
    picker.press(key('enter'))
    expect(picker.closed()).toBe(false)
    expect(rowFor(picker.rows(), 'still attached to this session')).toBeDefined()
  })

  it('marks the session this window is already driving', () => {
    const picker = open({ currentSessionId: 's-auth' as SessionId })
    picker.press(key('down'))
    picker.press(key('enter'))
    expect(rowFor(picker.rows(), 'Implement auth flow')).toContain('open')
  })

  it('still offers + New session in a worktree whose sessions could not be read', () => {
    const picker = open({
      selected: {
        workspace: ROWS[1] as WorktreeRow,
        status: 'ok',
        sessions: { kind: 'failed', message: 'session persistence is unavailable' },
      },
    })
    const rows = picker.rows()
    expect(rowFor(rows, '+ New session')).toBeDefined()
    expect(rowFor(rows, 'session persistence is unavailable')).toBeDefined()
  })

  it('says a worktree has no sessions rather than showing an empty view', () => {
    const picker = open()
    picker.press(key('down'))
    picker.press(key('down'))
    picker.press(key('enter'))
    expect(rowFor(picker.rows(), 'No sessions here yet')).toBeDefined()
  })

  it('warns when the selected worktree\'s directory is missing right now', () => {
    const picker = open({
      selected: { workspace: ROWS[1] as WorktreeRow, status: 'missing-dir', sessions: AUTH_SESSIONS },
    })
    expect(rowFor(picker.rows(), 'directory is missing right now')).toBeDefined()
  })
})

describe('what it says when there is nothing to list', () => {
  it('names the absent capability rather than falling back to anything', () => {
    const rows = open({ listing: { kind: 'unavailable' } }).rows()
    expect(rowFor(rows, 'No Harness Workspace registry is mounted in this profile.')).toBeDefined()
    // No scan of the sessions tree, no `git worktree list`, no invented rows.
    for (const row of body(rows)) expect(row).not.toMatch(/git worktree|\.git/iu)
  })

  it('reports a refused registry read with Harness\'s own message', () => {
    const rows = open({
      listing: { kind: 'failed', message: 'workspace domain is inconsistent' },
    }).rows()
    expect(rowFor(rows, 'workspace domain is inconsistent')).toBeDefined()
  })

  it('explains an empty but mounted registry', () => {
    const rows = open({ listing: { kind: 'ready', rows: [] } }).rows()
    expect(rowFor(rows, 'Harness knows no workspaces yet')).toBeDefined()
  })

  it('says a filter matched nothing without losing the register row', () => {
    const picker = open({ unregistered: `${HOME}/src/fresh` })
    picker.type('zzz')
    const rows = picker.rows()
    expect(rowFor(rows, '+ Register ~/src/fresh')).toBeDefined()
  })
})

describe('registering the directory this window is in', () => {
  it('offers it only when Harness positively holds no record, and calls the add route', () => {
    const without = open()
    expect(rowFor(without.rows(), '+ Register')).toBeUndefined()
    const picker = open({ unregistered: `${HOME}/src/fresh-worktree` })
    const rows = picker.rows()
    expect(rowFor(rows, '+ Register ~/src/fresh-worktree')).toBeDefined()
    for (let step = 0; step < 3; step += 1) picker.press(key('down'))
    picker.press(key('enter'))
    expect(picker.registered()).toEqual([`${HOME}/src/fresh-worktree`])
    expect(picker.closed()).toBe(false)
  })

  it('shows a refusal from Harness instead of a row that was never created', async () => {
    const picker = open({
      unregistered: `${HOME}/src/a-file`,
      register: async () => ({ kind: 'failed', message: 'path is not a directory' }),
    })
    for (let step = 0; step < 3; step += 1) picker.press(key('down'))
    picker.press(key('enter'))
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    expect(rowFor(picker.rows(), 'path is not a directory')).toBeDefined()
  })
})

describe('staying inside the live region', () => {
  it('never draws more physical rows than the terminal has', () => {
    for (const rows of [4, 8, 12, 26]) {
      for (const columns of [40, 60, 88, 120]) {
        const drawn = open().rows(columns, rows)
        const physical = drawn.reduce(
          (total, row) => total + Math.max(1, Math.ceil(displayWidth(row) / columns)),
          0,
        )
        expect(physical, `${String(columns)}x${String(rows)}`).toBeLessThanOrEqual(rows)
      }
    }
  })

  it('falls back to one closable headline on a terminal too small to frame', () => {
    // One row that still identifies the view; the `esc close` suffix is the
    // first thing the fallback chain gives up, exactly as `/skills` does.
    const drawn = open().rows(20, 2)
    expect(drawn).toHaveLength(1)
    expect(drawn[0]).toContain('Worktrees')
    expect(displayWidth(drawn[0] ?? '')).toBeLessThanOrEqual(20)
    const wider = open().rows(40, 2)
    expect(wider[0]).toContain('esc close')
  })

  it('keeps every row inside the frame at the narrowest framed width', () => {
    const picker = open()
    picker.press(key('down'))
    picker.press(key('enter'))
    for (const row of picker.rows(46, 20)) expect(displayWidth(row)).toBeLessThanOrEqual(46)
  })
})

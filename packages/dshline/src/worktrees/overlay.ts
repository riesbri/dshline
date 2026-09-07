/**
 * `/worktrees`: choose the place first, then the conversation.
 *
 * Two views, in that order, and the order is the product decision. A worktree
 * is not a session, so selecting one must not resume whichever conversation
 * happens to be newest in it — that is the mistake this shape exists to
 * prevent. The first view answers "where", the second answers "which
 * conversation there, or a new one", and `+ New session` is the second view's
 * first row rather than its last resort.
 *
 * Everything drawn here is bounded live-region chrome under the shared visual
 * root, exactly as `/sessions`, `/skills`, and `/plugins` are: the committed
 * transcript underneath is never rewritten, and the one thing this overlay can
 * do that outlives it — a session transition — is decided by the plans its
 * owner supplies at the moment `enter` is pressed.
 * @module dshline/worktrees/overlay
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Key } from '@dshline/renderer'
import {
  BOX_CHROME_COLUMNS,
  displayWidth,
  escapeControls,
  paint,
  truncateToWidth,
  wrapToWidth,
} from '@dshline/renderer'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from '../chrome.ts'
import type { SessionEntry } from '../sessions/model.ts'
import { relativeAge, sessionLabel } from '../sessions/model.ts'
import type { NewPlan, ResumePlan } from '../sessions/plan.ts'
import type { TuiOverlay } from '../slots.ts'
import type { RegisterOutcome } from './catalog.ts'
import type {
  WorktreeListing,
  WorktreeListRow,
  WorktreeRow,
  WorktreeSelection,
  WorktreeSessionRow,
} from './model.ts'
import {
  listingMessage,
  sessionCountLabel,
  sessionsMessage,
  worktreeListRows,
  worktreePath,
  worktreeSessionRows,
} from './model.ts'

/** Leading blank and the two frame borders, outside any content. */
const FIXED_ROWS = 3

/** Narrower than this and the framed form cannot hold a title beside a mark. */
const MIN_COLUMNS = BOX_CHROME_COLUMNS + 14

/** Widest a title column grows, so one long title cannot crowd out every path. */
const TITLE_COLUMN_MAX = 24

/** Columns between the title and the path. */
const TITLE_GAP = 2

/** Inner width at which a row can afford a right-hand meta cue at all. */
const META_COLUMNS = 46

/** Columns between the path and the right-hand meta cue. */
const META_GAP = 2

/** Marker on the highlighted row. */
const CURSOR = '›'

/** What the picker needs from the attachment that opens it. */
export interface WorktreesOverlaySpec {
  /** The live workspace listing; re-read every frame. */
  readonly listing: () => WorktreeListing
  /** The current directory when Harness positively holds no record for it. */
  readonly unregistered: () => string | undefined
  /** The open workspace's sessions, or undefined in the first view. */
  readonly selection: () => WorktreeSelection | undefined
  /** Open one workspace's sessions. */
  readonly open: (workspaceId: string) => void
  /** Return to the workspace list. */
  readonly back: () => void
  /** Register the current directory through Harness's own add route. */
  readonly register: (path: string) => Promise<RegisterOutcome>
  /**
   * Decide whether the chosen session may be reopened.
   *
   * A function rather than a value, and called at the moment `enter` is
   * pressed: the picker stays open across turns, and the answer that matters
   * is the one at the instant the reader chose. An accepted plan is also how
   * the owner learns WHICH session was chosen.
   */
  readonly resume: (entry: SessionEntry) => ResumePlan
  /** Decide whether a fresh session may be started in this workspace. */
  readonly create: (workspace: WorktreeRow) => NewPlan
  /** The session this window is driving, for the `open` cue. */
  readonly currentSessionId?: SessionId
  /** The user's home directory, for shortening paths. */
  readonly home: string
  /** Current time, injected so relative ages are assertable. */
  readonly now: () => number
  /** Remove this temporary overlay. */
  readonly close: () => void
  /** Ask the runner to redraw. */
  readonly invalidate: () => void
}

/**
 * Create the `/worktrees` picker.
 * @param spec - the two listings, the two plans, and the navigation actions.
 * @returns a live-region overlay that never writes the transcript.
 */
export function createWorktreesOverlay(spec: WorktreesOverlaySpec): TuiOverlay {
  let query = ''
  let listCursor = 0
  let sessionCursor = 0
  let notice: string | undefined
  let registering = false
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    spec.close()
  }
  /** Rows the first view currently has, recomputed on every read. */
  const listRows = (): readonly WorktreeListRow[] => {
    const listing = spec.listing()
    const rows = listing.kind === 'ready' ? listing.rows : []
    return worktreeListRows(rows, spec.unregistered(), query)
  }
  /** Rows the second view currently has, or none while the first is in front. */
  const sessionRows = (): readonly WorktreeSessionRow[] => {
    const selection = spec.selection()
    return selection === undefined ? [] : worktreeSessionRows(selection.sessions)
  }
  const edit = (next: string): void => {
    query = next
    listCursor = 0
    notice = undefined
    spec.invalidate()
  }
  const move = (amount: number): void => {
    const selection = spec.selection()
    const total = selection === undefined ? listRows().length : sessionRows().length
    if (total === 0) return
    if (selection === undefined) listCursor = (listCursor + amount + total) % total
    else sessionCursor = (sessionCursor + amount + total) % total
    notice = undefined
    spec.invalidate()
  }
  const report = (message: string): void => {
    notice = message
    spec.invalidate()
  }
  const enterWorkspace = (workspaceId: string): void => {
    sessionCursor = 0
    notice = undefined
    spec.open(workspaceId)
  }
  const leaveWorkspace = (): void => {
    notice = undefined
    spec.back()
  }
  const startFresh = (workspace: WorktreeRow): void => {
    const plan = spec.create(workspace)
    if (plan.kind === 'refused') {
      report(plan.message)
      return
    }
    close()
  }
  const registerCurrent = (path: string): void => {
    if (registering) return
    registering = true
    report(`Registering ${path}…`)
    void spec.register(path).then((outcome) => {
      registering = false
      if (closed) return
      switch (outcome.kind) {
        case 'registered':
          notice = undefined
          spec.invalidate()
          return
        case 'unavailable':
          report('No Harness Workspace registry is mounted in this profile.')
          return
        case 'failed':
          report(outcome.message)
      }
    })
  }
  const confirm = (): void => {
    const selection = spec.selection()
    if (selection === undefined) {
      const row = listRows()[listCursor]
      if (row === undefined) return
      if (row.kind === 'register') registerCurrent(row.path)
      else enterWorkspace(row.workspace.id)
      return
    }
    const row = sessionRows()[sessionCursor]
    if (row === undefined) return
    if (row.kind === 'new') {
      startFresh(selection.workspace)
      return
    }
    const plan = spec.resume(row.entry)
    if (plan.kind === 'refused') {
      report(plan.message)
      return
    }
    close()
  }
  return {
    render(columns, terminalRows = 24) {
      const selection = spec.selection()
      const rows = selection === undefined ? listRows() : sessionRows()
      const cursor = selection === undefined ? listCursor : sessionCursor
      const bounded = Math.min(cursor, Math.max(0, rows.length - 1))
      if (selection === undefined) listCursor = bounded
      else sessionCursor = bounded
      if (terminalRows <= FIXED_ROWS || columns < MIN_COLUMNS) {
        return compactFallback(spec, selection, columns, terminalRows)
      }
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const capacity = terminalRows - FIXED_ROWS
      const body = selection === undefined
        ? workspacesBody(spec, listRows(), bounded, query, notice, inner, capacity)
        : sessionsBody(spec, selection, sessionRows(), bounded, notice, inner, capacity)
      if (body.length === 0) return compactFallback(spec, selection, columns, terminalRows)
      const frame = [
        '',
        ...rootFrame({
          columns,
          context: paint(selection === undefined ? 'Worktrees' : 'Worktrees · sessions', 'overlay-title'),
          body,
          footer: fitFooterHelp(
            help(selection !== undefined, bounded, rows.length, query),
            footerBudget(columns),
          ),
        }),
      ]
      // Every content row above is already truncated to `inner`; this is the
      // backstop that keeps a forgotten one from pushing the live region into
      // committed scrollback.
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : compactFallback(spec, selection, columns, terminalRows)
    },
    handleKey(key: Key) {
      const inSessions = spec.selection() !== undefined
      if (key.kind === 'text') {
        // The second view has no filter: its list is one workspace's sessions
        // and is already bounded, which is what frees a bare letter for the
        // `n` shortcut. The first view is a corpus, so every printable
        // character there is filter input.
        if (inSessions) {
          if (key.text === 'n' || key.text === 'N') {
            const selection = spec.selection()
            if (selection !== undefined) startFresh(selection.workspace)
          }
          return
        }
        edit(query + key.text)
        return
      }
      if (key.kind === 'paste') {
        if (inSessions) return
        // A filter is one line; pasted breaks collapse where they can be seen.
        edit(query + key.text.replace(/\s+/gu, ' '))
        return
      }
      switch (key.name) {
        case 'up':
          move(-1)
          return
        case 'down':
          move(1)
          return
        case 'right':
          // Disclosure only, as `→` is in `/sessions`. Deliberately not a
          // second way to trigger the register row: that row performs a
          // durable Harness write, and an arrow key is not the gesture for
          // one.
          if (!inSessions) {
            const row = listRows()[listCursor]
            if (row?.kind === 'workspace') enterWorkspace(row.workspace.id)
          }
          return
        case 'left':
          if (inSessions) leaveWorkspace()
          return
        case 'backspace':
          if (inSessions) {
            leaveWorkspace()
            return
          }
          // Code points, not UTF-16 units: one press deletes one character.
          edit([...query].slice(0, -1).join(''))
          return
        case 'ctrl-u':
          if (!inSessions) edit('')
          return
        case 'ctrl-w':
          if (!inSessions) edit(query.replace(/\s*\S*$/u, ''))
          return
        case 'enter':
          confirm()
          return
        case 'escape':
          // Three stages, outermost last, which is what every browser here
          // does: the second view goes back rather than closing, then a typed
          // filter is what a reader most often wants back, and only an empty
          // first view closes. `ctrl-c` below is the one-press way out.
          if (inSessions) {
            leaveWorkspace()
            return
          }
          if (query !== '') {
            edit('')
            return
          }
          close()
          return
        case 'ctrl-c':
          close()
          return
        default:
          return
      }
    },
  }
}

/**
 * The first view's body: heading, workspace rows, and any standing notice.
 * @param spec - the picker's spec, for the listing state.
 * @param rows - the rows the filter left, plus any register row.
 * @param cursor - the highlighted row.
 * @param query - the typed filter.
 * @param notice - a one-row local message, when one is standing.
 * @param inner - the frame's inner width in columns.
 * @param capacity - rows available inside the frame.
 * @returns the body rows, or none when nothing useful fits.
 */
function workspacesBody(
  spec: WorktreesOverlaySpec,
  rows: readonly WorktreeListRow[],
  cursor: number,
  query: string,
  notice: string | undefined,
  inner: number,
  capacity: number,
): string[] {
  if (capacity < 1) return []
  const listing = spec.listing()
  const workspaces = rows.filter(row => row.kind === 'workspace').length
  const heading = headingRow(
    query === '' ? `Worktrees · ${String(workspaces)} known` : `Worktrees · ${String(workspaces)} matches`,
    query === '' ? '' : `filter: ${escapeControls(query)}`,
    inner,
  )
  if (rows.length === 0) {
    const message = listingMessage(listing, query !== '')
    return [
      heading,
      ...capacity >= 3 ? ['', ...wrapped(message, inner, capacity - 2)] : [],
    ]
  }
  const noticeRows = notice === undefined
    ? []
    : ['', paint(truncateToWidth(`· ${escapeControls(notice)}`, inner), 'warning')]
  const listCapacity = capacity - 1 - noticeRows.length
  if (listCapacity < 1) return [heading]
  return [
    heading,
    ...boundedList(rows, cursor, listCapacity, (row, selected) =>
      listRowText(row, selected, rows, spec.home, inner)),
    ...noticeRows,
  ]
}

/**
 * The second view's body: the workspace's identity, its sessions, and a notice.
 * @param spec - the picker's spec, for the current session and the clock.
 * @param selection - the open workspace and its listing.
 * @param rows - the `+ New session` row and the workspace's sessions.
 * @param cursor - the highlighted row.
 * @param notice - a one-row local message, when one is standing.
 * @param inner - the frame's inner width in columns.
 * @param capacity - rows available inside the frame.
 * @returns the body rows, or none when nothing useful fits.
 */
function sessionsBody(
  spec: WorktreesOverlaySpec,
  selection: WorktreeSelection,
  rows: readonly WorktreeSessionRow[],
  cursor: number,
  notice: string | undefined,
  inner: number,
  capacity: number,
): string[] {
  if (capacity < 1) return []
  const workspace = selection.workspace
  const head = [
    paint(truncateToWidth(escapeControls(workspace.title), inner), 'section-heading'),
  ]
  if (capacity >= 3) {
    head.push(paint(truncateToWidth(worktreePath(workspace.path, spec.home), inner), 'path'))
  }
  if (selection.status === 'missing-dir' && capacity >= 4) {
    head.push(paint(truncateToWidth('directory is missing right now', inner), 'warning'))
  }
  const noticeRows = notice === undefined
    ? []
    : ['', paint(truncateToWidth(`· ${escapeControls(notice)}`, inner), 'warning')]
  // Said whenever there is no session row to show, whatever the reason: an
  // unmounted corpus, a read still in flight, a refusal, and a workspace whose
  // first conversation has not happened yet are four different sentences, and
  // `+ New session` above is still usable under all of them.
  const quiet = selection.sessions.kind !== 'ready' || selection.sessions.entries.length === 0
  const emptyRows = quiet
    ? [paint(truncateToWidth(sessionsMessage(selection.sessions), inner), 'muted')]
    : []
  const listCapacity = capacity - head.length - noticeRows.length - emptyRows.length - 1
  if (listCapacity < 1) return head
  return [
    ...head,
    '',
    ...boundedList(rows, cursor, listCapacity, (row, selected) =>
      sessionRowText(row, selected, spec, inner)),
    ...emptyRows,
    ...noticeRows,
  ]
}

/**
 * Draw a list bounded to its capacity with a truthful omission marker.
 *
 * Shared by both views because the window arithmetic is the part that goes
 * wrong: a marker that is drawn without being budgeted for is how a bounded
 * list grows one row past the terminal.
 * @param rows - every row the view has.
 * @param cursor - the highlighted row.
 * @param capacity - rows the list may take, marker included.
 * @param draw - render one row.
 * @returns the rendered rows.
 */
function boundedList<Row>(
  rows: readonly Row[],
  cursor: number,
  capacity: number,
  draw: (row: Row, selected: boolean) => string,
): string[] {
  const marker = rows.length > capacity ? 1 : 0
  const room = Math.max(1, capacity - marker)
  const start = Math.min(Math.max(0, cursor - room + 1), Math.max(0, rows.length - room))
  const shown = rows.slice(start, start + room)
  const drawn = shown.map((row, index) => draw(row, start + index === cursor))
  const omitted = rows.length - (start + shown.length)
  if (omitted > 0) drawn.push(`    ${paint(`… ${String(omitted)} more`, 'muted')}`)
  return drawn
}

/**
 * One first-view row: the mark, the title, the path, and the meta cue.
 * @param row - the row to draw.
 * @param selected - whether this row holds the cursor.
 * @param rows - every row, for the shared title column width.
 * @param home - the user's home directory, for shortening the path.
 * @param inner - the frame's inner width in columns.
 * @returns one safely truncated physical row.
 */
function listRowText(
  row: WorktreeListRow,
  selected: boolean,
  rows: readonly WorktreeListRow[],
  home: string,
  inner: number,
): string {
  const mark = selected ? paint(CURSOR, 'selection-mark') : ' '
  if (row.kind === 'register') {
    const label = `+ Register ${worktreePath(row.path, home)}`
    const text = truncateToWidth(label, Math.max(1, inner - 2))
    return `${mark} ${selected ? paint(text, 'selection') : paint(text, 'muted')}`
  }
  const workspace = row.workspace
  const titleColumn = Math.min(
    TITLE_COLUMN_MAX,
    Math.max(1, ...rows.map(candidate => candidate.kind === 'workspace'
      ? displayWidth(escapeControls(candidate.workspace.title))
      : 1)),
  )
  const title = truncateToWidth(escapeControls(workspace.title), titleColumn)
  const painted = selected ? paint(title, 'selection') : title
  const room = inner - 2 - titleColumn - TITLE_GAP
  if (room < 8) return truncateToWidth(`${mark} ${painted}`, inner)
  const meta = metaCue(workspace)
  const metaWidth = inner >= META_COLUMNS && meta !== '' ? displayWidth(meta) + META_GAP : 0
  const pathRoom = Math.max(1, room - metaWidth)
  const path = truncateToWidth(worktreePath(workspace.path, home), pathRoom)
  const pad = ' '.repeat(Math.max(0, titleColumn - displayWidth(title)) + TITLE_GAP)
  const head = `${mark} ${painted}${pad}${paint(path, 'muted')}`
  if (metaWidth === 0) return head
  const gap = ' '.repeat(Math.max(META_GAP, pathRoom - displayWidth(path) + META_GAP))
  return `${head}${gap}${paint(meta, workspace.current ? 'mode' : 'muted')}`
}

/**
 * The right-hand cue on a workspace row.
 *
 * `current` names the workspace the ATTACHED session is rooted in, and nothing
 * else. It deliberately says nothing about whether another dshline process is
 * live in this directory: `ctx.agents` is process-local, the adopted Harness
 * generation publishes no cross-process ownership contract, and a row claiming
 * "running elsewhere" would be this frontend inventing one.
 * @param workspace - the row's workspace.
 * @returns the cue, or an empty string when there is nothing to say.
 */
function metaCue(workspace: WorktreeRow): string {
  const count = sessionCountLabel(workspace.sessions)
  return workspace.current ? `current · ${count}` : count
}

/**
 * One second-view row: the mark, the label, and the age.
 * @param row - the row to draw.
 * @param selected - whether this row holds the cursor.
 * @param spec - the picker's spec, for the current session and the clock.
 * @param inner - the frame's inner width in columns.
 * @returns one safely truncated physical row.
 */
function sessionRowText(
  row: WorktreeSessionRow,
  selected: boolean,
  spec: WorktreesOverlaySpec,
  inner: number,
): string {
  const mark = selected ? paint(CURSOR, 'selection-mark') : ' '
  if (row.kind === 'new') {
    const text = truncateToWidth('+ New session', Math.max(1, inner - 2))
    return `${mark} ${selected ? paint(text, 'selection') : text}`
  }
  const entry = row.entry
  const meta = [
    ...entry.id === spec.currentSessionId ? ['open'] : [],
    ...entry.origin === 'delegated' ? ['delegated'] : [],
    relativeAge(entry.createdAt, spec.now()),
  ].join(' · ')
  const metaWidth = displayWidth(meta) + META_GAP
  const labelRoom = Math.max(1, inner - 2 - metaWidth)
  const label = truncateToWidth(escapeControls(sessionLabel(entry, spec.currentSessionId)), labelRoom)
  const painted = selected ? paint(label, 'selection') : label
  if (inner < META_COLUMNS) return truncateToWidth(`${mark} ${painted}`, inner)
  const gap = ' '.repeat(Math.max(META_GAP, labelRoom - displayWidth(label) + META_GAP))
  return `${mark} ${painted}${gap}${paint(meta, 'muted')}`
}

/**
 * A heading with an optional right-hand annotation.
 * @param left - the headline; this module's own words.
 * @param right - the annotation, already escaped by the caller.
 * @param inner - the frame's inner width in columns.
 * @returns one row.
 */
function headingRow(left: string, right: string, inner: number): string {
  const heading = paint(truncateToWidth(left, inner), 'overlay-headline')
  if (right === '') return heading
  const room = inner - displayWidth(truncateToWidth(left, inner)) - 1
  if (room < displayWidth(right)) return heading
  return `${heading}${' '.repeat(room - displayWidth(right) + 1)}${paint(right, 'muted')}`
}

/**
 * Wrap one muted sentence into the rows it is allowed.
 * @param message - the sentence; untrusted, so it is escaped here.
 * @param inner - the frame's inner width in columns.
 * @param capacity - rows the sentence may take.
 * @returns the wrapped rows.
 */
function wrapped(message: string, inner: number, capacity: number): string[] {
  return wrapToWidth(escapeControls(message), inner)
    .slice(0, Math.max(1, capacity))
    .map(line => paint(truncateToWidth(line, inner), 'muted'))
}

/**
 * The footer help, least essential first.
 * @param inSessions - whether the second view is in front.
 * @param cursor - the highlighted row.
 * @param total - rows the current view has.
 * @param query - the typed filter.
 * @returns the help text, before it is fitted to the border.
 */
function help(inSessions: boolean, cursor: number, total: number, query: string): string {
  const position = total === 0 ? '' : `${String(cursor + 1)}/${String(total)} · `
  if (inSessions) return `${position}enter open · n new session · ↑↓ select · ← back · ctrl-c close`
  const filter = query === '' ? 'type filter · ' : 'esc clear filter · '
  return `${position}enter open · ↑↓ select · ${filter}esc close`
}

/** Count the physical rows Screen will draw for a candidate live region. */
function physicalRows(lines: readonly string[], columns: number): string[] {
  return lines.flatMap(line => wrapToWidth(line, Math.max(1, columns)))
}

/**
 * A closable answer for a terminal too small to draw the frame.
 * @param spec - the picker's spec, for the listing state.
 * @param selection - the open workspace, when the second view is in front.
 * @param columns - the terminal's width.
 * @param rows - rows available.
 * @returns at most one row.
 */
function compactFallback(
  spec: WorktreesOverlaySpec,
  selection: WorktreeSelection | undefined,
  columns: number,
  rows: number,
): string[] {
  if (rows <= 0) return []
  const listing = spec.listing()
  const identity = selection === undefined
    ? listing.kind === 'ready' && listing.rows.length > 0
      ? `Worktrees · ${String(listing.rows.length)}`
      : 'Worktrees'
    : `Worktrees · ${escapeControls(selection.workspace.title)}`
  const visible = [`${identity} · esc close`, identity, 'esc close', 'esc']
    .find(candidate => displayWidth(candidate) <= columns)
  return visible === undefined ? [] : [paint(visible, 'overlay-headline')]
}

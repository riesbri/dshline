/**
 * The Connect browser: what Harness can be configured to talk to, and how.
 *
 * A bounded overlay, like Sessions, Work, and Todos. The committed transcript
 * under it is never rewritten, and closing it leaves the terminal exactly as it
 * was — which matters more here than elsewhere, because an authorization flow
 * commits its sign-in page and device code into that same scrollback while this
 * is open, and those are the two lines a person is about to select and copy.
 *
 * Two sections, deliberately not one list. `Provider routes` are what
 * configuration can activate, and what `/model` will offer once they are live.
 * `Sign-ins` are the flows Harness can run to obtain a credential. They are
 * related — signing in to a provider is usually why you then activate its route
 * — but Harness publishes no correlation between the two, so the browser shows
 * both and asserts nothing about which belongs to which.
 * @module dshline/connect/overlay
 */

import type { Key } from '@dshline/renderer'
import {
  BOX_CHROME_COLUMNS,
  displayWidth,
  escapeControls,
  paint,
  tailToWidth,
  truncateToWidth,
  wrapToWidth,
} from '@dshline/renderer'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from '../chrome.ts'
import { RowViewport } from '../scroll.ts'
import type { TuiOverlay } from '../slots.ts'
import type { ConnectCapabilities, ConnectCreateRow, ConnectProviderRow, ConnectRow, ConnectSignInRow, ConnectState } from './model.ts'
import {
  filterRows,
  providerDetail,
  providerFacts,
  providerReadiness,
  signInDetail,
  signInFacts,
} from './model.ts'

/** Rows outside the scrolling list: leading blank, two borders, query, spacer. */
const CONNECT_FIXED_ROWS = 5

/**
 * Narrowest terminal that can hold the framed list.
 *
 * A row carries a provider name on the left and its state on the right, and the
 * state is the whole reason the browser exists — so below this the two collide
 * and the frame gives way to the compact answer instead of cutting either.
 */
const CONNECT_MIN_COLUMNS = BOX_CHROME_COLUMNS + 28

/** Columns a name needs before the right-hand facts are worth their space. */
const MIN_NAME_COLUMNS = 18

/** How long a result stays on screen before the list returns. */
const NOTICE_MS = 5_000

/** What the browser needs from its owner. */
export interface ConnectOverlaySpec {
  /** The current reading of Harness's provider configuration. */
  readonly state: () => ConnectState
  /**
   * Text the query box opens with.
   *
   * `/connect openai` narrows to that provider rather than acting on it: naming
   * a route says which one you mean, and what to DO with it is still a choice
   * between storing a key, activating it, and removing it.
   */
  readonly query?: string
  /** Re-read every surface. */
  readonly refresh: () => void
  /**
   * Act on one row.
   *
   * The owner runs the action — it owns the seams, the transcript, and the
   * prompts an action may raise — and hands back a sentence to show over the
   * list. The overlay stays mounted throughout, because a flow's own prompts
   * stack on top of it and the reader returns here when they settle.
   */
  readonly act: (row: ConnectRow) => void
  /** Current time, injected so notice expiry is assertable. */
  readonly now: () => number
  /** Remove this overlay from the live region. */
  readonly close: () => void
  /** Redraw after a move, an edit, or a landed read. */
  readonly invalidate: () => void
}

/** A transient message shown over the list without committing a transcript row. */
interface Notice {
  readonly text: string
  readonly failed: boolean
  readonly expiresAt: number
}

/** One rendered section, and where its selectable rows landed. */
interface Rendered {
  readonly rows: readonly string[]
  readonly selectedRow: number
}

/** The Connect overlay, plus the one thing its owner pushes back into it. */
export interface ConnectOverlay extends TuiOverlay {
  /**
   * Show a result over the list.
   * @param text - the sentence to show.
   * @param failed - whether it reports a refusal.
   */
  report(text: string, failed: boolean): void
}

/**
 * Create the Connect browser overlay.
 * @param spec - the reading, the action authority, and overlay controls.
 * @returns a temporary live-region overlay that never writes the transcript.
 */
export function createConnectOverlay(spec: ConnectOverlaySpec): ConnectOverlay {
  const viewport = new RowViewport()
  let query = spec.query ?? ''
  let selected = 0
  let visible: readonly ConnectRow[] = []
  let closed = false
  let notice: Notice | undefined

  const close = (): void => {
    if (closed) return
    closed = true
    spec.close()
  }
  const currentNotice = (): Notice | undefined => {
    if (notice !== undefined && spec.now() >= notice.expiresAt) notice = undefined
    return notice
  }
  const move = (amount: number): void => {
    if (visible.length === 0) return
    selected = (selected + amount + visible.length) % visible.length
    spec.invalidate()
  }
  const edit = (next: string): void => {
    query = next
    selected = 0
    viewport.first()
    spec.invalidate()
  }

  return {
    report(text, failed) {
      notice = { text, failed, expiresAt: spec.now() + NOTICE_MS }
      spec.invalidate()
    },
    render(columns, terminalRows = 24) {
      const state = spec.state()
      const sections = resolve(state, query)
      visible = sections.flatMap(section => section.rows)
      selected = Math.min(selected, Math.max(0, visible.length - 1))
      const active = currentNotice()
      if (terminalRows <= CONNECT_FIXED_ROWS || columns < CONNECT_MIN_COLUMNS) {
        return compactFallback(state, visible.length, columns, terminalRows, active)
      }
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const capacity = terminalRows - CONNECT_FIXED_ROWS - (active === undefined ? 0 : 1)
      if (capacity <= 0) return compactFallback(state, visible.length, columns, terminalRows, active)
      const rendered = render(state, sections, selected, inner)
      viewport.update(rendered.rows.length, capacity)
      if (rendered.selectedRow < viewport.start) viewport.move(rendered.selectedRow - viewport.start)
      if (rendered.selectedRow >= viewport.end) viewport.move(rendered.selectedRow - viewport.end + 1)
      const frame = [
        '',
        ...rootFrame({
          columns,
          context: paint('Connect', 'overlay-title'),
          body: [
            queryRow(query, counter(state, visible.length, rendered, viewport), inner),
            ...active === undefined
              ? []
              : [paint(truncateToWidth(escapeControls(active.text), inner), active.failed ? 'error' : 'success')],
            '',
            ...rendered.rows.slice(viewport.start, viewport.end),
          ],
          footer: fitFooterHelp(
            help(query, visible.length > 0, footerBudget(columns)),
            footerBudget(columns),
          ),
        }),
      ]
      // The same backstop the Sessions browser keeps, for the same reason: every
      // content row above is already truncated, but a frame one row too tall
      // pushes a line into committed scrollback, and no overlay may do that.
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : compactFallback(state, visible.length, columns, terminalRows, active)
    },
    handleKey(key: Key) {
      if (key.kind === 'text') {
        edit(query + key.text)
        return
      }
      if (key.kind === 'paste') {
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
        case 'home':
        case 'ctrl-a':
          selected = 0
          viewport.first()
          spec.invalidate()
          return
        case 'end':
        case 'ctrl-e':
          selected = Math.max(0, visible.length - 1)
          viewport.last()
          spec.invalidate()
          return
        case 'backspace':
          edit([...query].slice(0, -1).join(''))
          return
        case 'ctrl-u':
          edit('')
          return
        case 'ctrl-w':
          edit(query.replace(/\s*\S*$/u, ''))
          return
        case 'ctrl-r':
          // A settings file edited by hand, or a key stored from the web Models
          // page, changes nothing this frontend can subscribe to yet. The
          // gesture is how a reader asks Harness again rather than restarting.
          spec.refresh()
          return
        case 'enter': {
          const row = visible[selected]
          if (row !== undefined) spec.act(row)
          return
        }
        case 'escape':
          // Two stages, as in Sessions: a typed query is the thing most often
          // taken back, and spending the keystroke on the whole browser would
          // cost the reader the listing as well.
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

/** One titled group of rows, after the query has been applied. */
interface Section {
  /** The group's heading. */
  readonly title: string
  /** The rows that survived the query. */
  readonly rows: readonly ConnectRow[]
  /** What to say when the group is empty. */
  readonly empty: string
}

/**
 * Split a reading into its two sections, filtered.
 * @param state - the current reading.
 * @param query - the typed query.
 * @returns the sections, in reading order.
 */
function resolve(state: ConnectState, query: string): readonly Section[] {
  if (state.kind !== 'ready') return []
  // The create row rides at the foot of the provider list rather than in a
  // section of its own: it is one more thing to do with this list, not a
  // second kind of thing to browse, and Harness reports no target at all once
  // nothing declarable is left to write to.
  const createRow: ConnectCreateRow[] = state.newRouteTargets.length === 0
    ? []
    : [{ kind: 'create', label: 'Add custom provider', targets: state.newRouteTargets }]
  return [
    {
      title: 'Provider routes',
      rows: [...filterRows(state.providers, query), ...filterRows(createRow, query)],
      empty: state.providers.length === 0
        ? 'No mounted adapter declares a configurable provider.'
        : 'No provider route matches that.',
    },
    {
      title: 'Sign-ins',
      rows: filterRows(state.signIns, query),
      empty: state.capabilities.authorization
        ? state.signIns.length === 0
          ? 'No mounted plugin offers a sign-in flow.'
          : 'No sign-in matches that.'
        : 'This profile mounts no authorization service.',
    },
  ]
}

/**
 * Draw a reading's rows at a known width.
 * @param state - the current reading.
 * @param sections - the filtered sections.
 * @param selected - the selected row's index among all selectable rows.
 * @param inner - the frame's inner width in columns.
 * @returns the rows and the selection's row index among them.
 */
function render(
  state: ConnectState,
  sections: readonly Section[],
  selected: number,
  inner: number,
): Rendered {
  if (state.kind === 'loading') return single('Reading provider configuration…', inner)
  if (state.kind === 'failed') return single(`Harness could not be read: ${state.message}`, inner)
  const rows: string[] = []
  const capabilities = state.kind === 'ready' ? state.capabilities : undefined
  let selectedRow = 0
  let index = 0
  sections.forEach((section, position) => {
    if (position > 0) rows.push('')
    rows.push(paint(truncateToWidth(section.title, inner), 'section-heading'))
    if (section.rows.length === 0) {
      rows.push(paint(`  ${truncateToWidth(escapeControls(section.empty), Math.max(1, inner - 2))}`, 'muted'))
      return
    }
    for (const row of section.rows) {
      const active = index === selected
      if (active) selectedRow = rows.length
      rows.push(entryRow(row, active, inner, capabilities))
      if (active) rows.push(detailRow(row, inner))
      index += 1
    }
  })
  return { rows, selectedRow }
}

/**
 * A reading with nothing to select, as one row.
 * @param text - the sentence to show.
 * @param inner - the frame's inner width.
 * @returns the single row.
 */
function single(text: string, inner: number): Rendered {
  return { rows: [paint(truncateToWidth(escapeControls(text), inner), 'muted')], selectedRow: 0 }
}

/**
 * One row: a readiness mark, a name, and the right-hand facts.
 * @param row - the row.
 * @param active - whether it is selected.
 * @param inner - the frame's inner width.
 * @returns the row.
 */
function entryRow(
  row: ConnectRow,
  active: boolean,
  inner: number,
  capabilities: ConnectCapabilities | undefined,
): string {
  const mark = readinessMark(row)
  const right = rightColumn(row, inner, capabilities)
  const rightWidth = Math.min(displayWidth(right), Math.max(0, inner - 10))
  const label = truncateToWidth(
    escapeControls(rowName(row)),
    Math.max(1, inner - 4 - rightWidth - 1),
  )
  const gap = Math.max(1, inner - 4 - displayWidth(label) - rightWidth)
  const plain = `${label}${' '.repeat(gap)}${truncateToWidth(right, rightWidth)}`
  const body = active ? paint(plain, 'selection') : plain
  return `${active ? paint('❯', 'selection') : ' '} ${mark} ${body}`
}

/**
 * The dot in front of a row.
 *
 * Only a confirmed answer earns a colour. A provider authenticating through its
 * library's own discovery, and a deployment with no credential provider to ask,
 * are both unmarked — reporting either as broken would be the frontend deciding
 * something Harness declined to say. Alpha-2's empty deferred catalog is
 * different: the adapter has confirmed that no serviceable model remains.
 * @param row - the row.
 * @returns one column of text.
 */
function readinessMark(row: ConnectRow): string {
  if (row.kind === 'create') return paint('+', 'muted')
  if (row.kind === 'sign-in') {
    if (row.record?.configured === true) return paint('●', 'success')
    return row.inFlight ? paint('◌', 'busy') : paint('·', 'muted')
  }
  switch (providerReadiness(row)) {
    case 'ready':
      return paint('●', 'success')
    case 'missing':
    case 'invalid':
      return paint('●', 'error')
    default:
      return paint('·', 'muted')
  }
}

/**
 * The name a row is identified by.
 *
 * A provider carries both its display name and its route key, because the route
 * key is what `/model` prints and what `settings.yaml` addresses — a row naming
 * only "OpenAI" leaves a reader guessing which of two routes they configured.
 * @param row - the row.
 * @returns the left-hand text.
 */
function rowName(row: ConnectRow): string {
  if (row.kind === 'provider') {
    return row.displayName === row.provider ? row.provider : `${row.displayName}  ${row.provider}`
  }
  return row.label
}

/**
 * The right-hand facts, retained in priority order when the name needs room.
 * @param row - the row.
 * @param inner - the frame's inner width.
 * @param capabilities - mounted seams used to determine truthful provider facts.
 * @returns the right-aligned text.
 */
function rightColumn(row: ConnectRow, inner: number, capabilities: ConnectCapabilities | undefined): string {
  if (row.kind === 'create') return ''
  // Escaped before anything is measured or coloured: these facts carry a
  // credential reference out of the settings document and a source layer name
  // the credential provider chose, neither of which this frontend authored.
  const facts = (row.kind === 'provider' ? providerFacts(row, capabilities) : signInFacts(row)).map(escapeControls)
  // Facts arrive most important first. Keeping a prefix makes "not active"
  // survive before ancillary key provenance when the terminal grows tight.
  for (let count = facts.length; count > 0; count -= 1) {
    const candidate = facts.slice(0, count).join(' · ')
    if (inner - 5 - displayWidth(candidate) >= MIN_NAME_COLUMNS) return candidate
  }
  return ''
}

/**
 * The indented facts shown under the selected row only.
 * @param row - the selected row.
 * @param inner - the frame's inner width.
 * @returns one indented row.
 */
function detailRow(row: ConnectRow, inner: number): string {
  const facts = row.kind === 'create'
    ? row.targets.map(target => target.settingsNs)
    : row.kind === 'provider' ? providerDetail(row) : signInDetail(row)
  return paint(`    ${truncateToWidth(escapeControls(facts.join(' · ')), Math.max(1, inner - 4))}`, 'muted')
}

/**
 * The query line: a prompt, the typed text, a cursor block, and the counter.
 * @param query - the typed query.
 * @param right - the counter text.
 * @param inner - the frame's inner width.
 * @returns one row.
 */
function queryRow(query: string, right: string, inner: number): string {
  const prompt = '⌕ '
  const rightWidth = Math.min(displayWidth(right), Math.max(0, inner - 4))
  const room = Math.max(1, inner - displayWidth(prompt) - rightWidth - 1)
  // The TAIL, so a long query scrolls from the left and the characters being
  // typed stay in view; one column is held back for the cursor block.
  const shown = tailToWidth(escapeControls(query), Math.max(1, room - 1))
  const typed = `${shown}█`
  const gap = Math.max(1, inner - displayWidth(prompt) - displayWidth(typed) - rightWidth)
  return `${paint(prompt, 'prompt-mark')}${typed}${' '.repeat(gap)}${paint(truncateToWidth(right, rightWidth), 'muted')}`
}

/**
 * What the counter says: how many rows, and whether more are below.
 * @param state - the current reading.
 * @param shown - selectable rows after the query.
 * @param rendered - the drawn rows.
 * @param viewport - the scroll position over them.
 * @returns the counter text, empty when there is nothing to count.
 */
function counter(
  state: ConnectState,
  shown: number,
  rendered: Rendered,
  viewport: RowViewport,
): string {
  if (state.kind !== 'ready') return ''
  const total = state.providers.length + state.signIns.length
  const matched = shown === total
    ? `${String(shown)} row${shown === 1 ? '' : 's'}`
    : `${String(shown)} of ${String(total)}`
  const more = viewport.end < rendered.rows.length ? ' · more below' : ''
  return `${matched}${more}`
}

/**
 * The help line, truthful for the current query.
 *
 * Whole segments are dropped rather than the line being cut, for the reason the
 * status line gives up whole segments. The way out is named last and
 * surrendered last.
 * @param query - the typed query.
 * @param selectable - whether any row can be acted on.
 * @param columns - room available for the line.
 * @returns the help text that fits.
 */
function help(query: string, selectable: boolean, columns: number): string {
  const leave = query === '' ? 'esc close' : 'esc clear'
  const parts = [
    ...selectable ? ['↑↓ move'] : [],
    'ctrl-r refresh',
    ...selectable ? ['↵ configure'] : [],
    leave,
  ]
  for (let from = 0; from < parts.length; from += 1) {
    const line = parts.slice(from).join(' · ')
    if (displayWidth(line) <= columns) return line
  }
  return truncateToWidth(leave, columns)
}

/**
 * Count the physical rows Screen will draw for candidate live-region lines.
 * @param lines - the candidate logical lines.
 * @param columns - the terminal's width.
 * @returns the wrapped physical rows.
 */
function physicalRows(lines: readonly string[], columns: number): string[] {
  return lines.flatMap(line => wrapToWidth(line, Math.max(1, columns)))
}

/**
 * A closable answer for a terminal too small to hold the frame.
 * @param state - the current reading.
 * @param shown - selectable rows after the query.
 * @param columns - the terminal's width.
 * @param rows - the terminal's height.
 * @param notice - a pending result, when there is one.
 * @returns at most `rows` lines.
 */
function compactFallback(
  state: ConnectState,
  shown: number,
  columns: number,
  rows: number,
  notice: Notice | undefined,
): string[] {
  if (rows <= 0) return []
  if (notice !== undefined) {
    return [paint(truncateToWidth(escapeControls(notice.text), Math.max(1, columns)), notice.failed ? 'error' : 'success')]
  }
  const summary = state.kind !== 'ready' || shown === 0
    ? 'Connect · esc close'
    : `${String(shown)} rows · ↵ configure · esc close`
  const candidate = [summary, 'esc close', 'esc'].find(option => displayWidth(option) <= columns)
  return candidate === undefined ? [] : [paint(candidate, 'overlay-headline')]
}

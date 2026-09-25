/**
 * The `/plugins` browser: the running agent's Harness preset composition.
 *
 * A bounded overlay, like Connect, Sessions, Work, and Todos: the committed
 * transcript under it is never rewritten, and closing it leaves the terminal
 * exactly as it was. One list, not two sections like Connect — a
 * composition is already one flat, ordered thing once nested groups are
 * flattened by `composition.ts`, so splitting it into categories here would
 * be inventing a grouping Harness's own file does not draw.
 *
 * Everything a keystroke here can do is decided by `model.ts` and carried
 * out by `actions.ts`; this module only draws the state it is handed and
 * reports the intent — `pickPreset`, `makeDefault` — back to its owner
 * (`index.ts`), the same division `connect/overlay.ts` keeps between drawing
 * a row and deciding what pressing something on it means.
 *
 * The composition list is READ-ONLY in the adopted generation, and that is why
 * there is no `space`/`enter` row action left to bind. A preset is a
 * declaration in a Cordis composition and the registry "writes no
 * declarations", so there is no row here this frontend may change; the writes
 * that do exist — choosing a preset, making it the default — are the two
 * whole-composition intents that survive, and they are the only keys drawn in
 * the help line.
 * @module dshline/plugins/overlay
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
import { SurfaceNotice, noticeText } from '../surface.ts'
import type { SurfaceNoticeReading } from '../surface.ts'
import type { CompositionRow } from './composition.ts'
import type { PluginsState } from './catalog.ts'
import { compositionRowFacts, filterCompositionRows, rowMark } from './model.ts'
import { healthFacts, rowHealth, unbackedWhileEnabled } from './health.ts'
import type { HostCapabilities } from './health.ts'

/**
 * Rows outside the scrolling list and outside the header block: the leading
 * blank, the two frame borders, the query line, and the spacer.
 *
 * The header block's own height is measured per render rather than folded in
 * here, because {@link headerRows} grows a row whenever the session runs a
 * different preset than the one being browsed — which is exactly the state
 * this feature's copy-to-customize flow produces. A constant that assumed the
 * shorter form left the built frame one row taller than the terminal, and the
 * `physicalRows` guard below then dropped the reader to {@link compactFallback}
 * whole instead of shedding one list row.
 */
const PLUGINS_FIXED_ROWS = 5

/** Narrowest terminal that can hold the framed list. */
const PLUGINS_MIN_COLUMNS = BOX_CHROME_COLUMNS + 28

/** Columns a name needs before the right-hand facts are worth their space. */
const MIN_NAME_COLUMNS = 18

/**
 * The mark on a row this preset turns on that the Host cannot back.
 *
 * Replaces the enabled dot rather than joining it: the row's own field is
 * genuinely enabled, and drawing that honestly beside a warning would say the
 * contradiction twice while leaving the reader to work out which half matters.
 */
const UNBACKED_MARK = '\u26a0'

/** How long a result stays on screen before the list returns. */
const NOTICE_MS = 5_000

/** What the browser needs from its owner. */
export interface PluginsOverlaySpec {
  /** The current reading of Harness's preset roster and composition. */
  readonly state: () => PluginsState
  /** Re-read every surface. */
  readonly refresh: () => void
  /** Open the agent-preset picker. */
  readonly pickPreset: () => void
  /** Make the browsed preset the default for new sessions. */
  readonly makeDefault: () => void
  /** Current time, injected so notice expiry is assertable. */
  readonly now: () => number
  /** Remove this overlay from the live region. */
  readonly close: () => void
  /** Redraw after a move, an edit, or a landed read. */
  readonly invalidate: () => void
}

/**
 * The drawn document, and where its choices landed among the physical rows.
 *
 * `rows` is exactly what {@link RowViewport} scrolls over, so every entry line
 * and the selected entry's detail line count toward its length. `selectableRows`
 * narrows that down to the entry lines alone, because `more below` answers a
 * question about choices and only these lines are choices.
 */
interface Rendered {
  readonly rows: readonly string[]
  readonly selectedRow: number
  readonly selectableRows: readonly number[]
}

/** The Plugins overlay, plus the one thing its owner pushes back into it. */
export interface PluginsOverlay extends TuiOverlay {
  /**
   * Show a result over the list.
   * @param text - the sentence to show.
   * @param failed - whether it reports a refusal.
   */
  report(text: string, failed: boolean): void
  /**
   * Whether the reader has already closed the browser.
   *
   * An action holds its own awaits — a file write, a Harness re-resolve — and
   * can land after `esc` has come down, so its owner needs to tell "report
   * this where the reader is looking" from "the reader is no longer there".
   * @returns true once this overlay has closed.
   */
  closed(): boolean
}

/**
 * Create the `/plugins` browser overlay.
 * @param spec - the reading, the action intents, and overlay controls.
 * @returns a temporary live-region overlay that never writes the transcript.
 */
export function createPluginsOverlay(spec: PluginsOverlaySpec): PluginsOverlay {
  const viewport = new RowViewport()
  let query = ''
  let selected = 0
  let closed = false
  // The notice owns its own expiry repaint; the surface passes its injected
  // clock so one timeline grades the deadline and arms the timer.
  const notice = new SurfaceNotice(NOTICE_MS, { now: spec.now, invalidate: spec.invalidate })
  // Search is entered explicitly with `/`, unlike every other dshline picker's
  // always-on type-to-filter: `space`, `p`, and `d` are single-key actions
  // here, and a composition row's own id or package name routinely contains
  // all three ("tool-pwsh", "cordis", "delegation") — always-on filtering
  // would make typing a search term indistinguishable from firing a shortcut
  // mid-word. Outside search mode those three keys act; every other typed
  // character is inert. Once `/` is pressed, all text (space included) edits
  // the query until `enter` or `esc` leaves search mode again — the query
  // itself, and the filter it applies, are kept either way.
  let searching = false

  const close = (): void => {
    if (closed) return
    closed = true
    spec.close()
  }
  const currentNotice = (): SurfaceNoticeReading | undefined => notice.read()
  /**
   * The composition rows the CURRENT reading and query leave.
   *
   * Presentation and control both read through this. Search mode edits the
   * query without a repaint, and the coalesced invalidation does not arrive
   * between two keys, so the last frame's array is not an authority for what a
   * gesture means: deriving here keeps `act`, `move`, and End on the rows the
   * filter currently leaves.
   * @param state - the reading to filter.
   * @returns the rows after the query, in the preset's own order.
   */
  const rowsFor = (state: PluginsState): readonly CompositionRow[] =>
    state.kind === 'ready' && state.browsing.kind === 'rows'
      ? filterCompositionRows(state.browsing.tree.rows, query)
      : []
  const move = (amount: number): void => {
    const rows = rowsFor(spec.state())
    if (rows.length === 0) return
    selected = (selected + amount + rows.length) % rows.length
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
      notice.show(text, failed)
      spec.invalidate()
    },
    closed(): boolean {
      return closed
    },
    dispose(): void {
      notice.dispose()
    },
    render(columns, terminalRows = 24) {
      const state = spec.state()
      const visible = rowsFor(state)
      selected = Math.min(selected, Math.max(0, visible.length - 1))
      const active = currentNotice()
      if (columns < PLUGINS_MIN_COLUMNS) {
        return compactFallback(state, visible.length, columns, terminalRows, active)
      }
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const header = headerRows(state, inner)
      const capacity = terminalRows - PLUGINS_FIXED_ROWS - header.length - (active === undefined ? 0 : 1)
      if (capacity <= 0) return compactFallback(state, visible.length, columns, terminalRows, active)
      const rendered = renderRows(state, visible, selected, inner, hostOf(state))
      viewport.update(rendered.rows.length, capacity)
      if (rendered.selectedRow < viewport.start) viewport.move(rendered.selectedRow - viewport.start)
      if (rendered.selectedRow >= viewport.end) viewport.move(rendered.selectedRow - viewport.end + 1)
      const frame = [
        '',
        ...rootFrame({
          columns,
          context: paint('Plugins', 'overlay-title'),
          body: [
            ...header,
            queryRow(query, searching, counter(visible.length, rendered, viewport), inner),
            ...active === undefined
              ? []
              : [paint(truncateToWidth(noticeText(active.text), inner), active.failed ? 'error' : 'success')],
            '',
            ...rendered.rows.slice(viewport.start, viewport.end),
          ],
          footer: fitFooterHelp(
            help(searching, query, visible.length > 0, footerBudget(columns)),
            footerBudget(columns),
          ),
        }),
      ]
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : compactFallback(state, visible.length, columns, terminalRows, active)
    },
    handleKey(key: Key) {
      if (searching) {
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
          case 'backspace':
            edit([...query].slice(0, -1).join(''))
            return
          case 'ctrl-u':
            edit('')
            return
          case 'ctrl-w':
            edit(query.replace(/\s*\S*$/u, ''))
            return
          case 'enter':
          case 'escape':
            // The filter stays active either way; only the mode changes, so
            // `space`/`p`/`d` act again without losing what was typed.
            searching = false
            spec.invalidate()
            return
          case 'ctrl-c':
            close()
            return
          default:
            return
        }
      }
      if (key.kind === 'text') {
        switch (key.text) {
          case '/':
            searching = true
            spec.invalidate()
            return
          case 'p':
            spec.pickPreset()
            return
          case 'd':
            spec.makeDefault()
            return
          default:
            return
        }
      }
      // Pasted text outside search mode names no action; `/` is how a paste
      // meant as a search term gets treated as one.
      if (key.kind === 'paste') return
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
          selected = Math.max(0, rowsFor(spec.state()).length - 1)
          viewport.last()
          spec.invalidate()
          return
        case 'ctrl-r':
          spec.refresh()
          return
        case 'escape':
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
 * What the Host's registries report for this reading, or nothing readable
 * before the first pass lands.
 * @param state - the current reading.
 * @returns the Host capabilities, empty until a pass has landed.
 */
function hostOf(state: PluginsState): HostCapabilities {
  // Coalesced rather than trusted: `host` is required on a ready reading, but
  // a reading assembled by an older caller (or a test double) that omits it
  // would otherwise reach `rowHealth` as `undefined` and throw on the first
  // row that actually declares a provider. "Nothing readable" is the correct
  // answer for a reading that carries no registry facts.
  const host = state.kind === 'ready' ? state.host : undefined
  return host ?? { subagentProviders: undefined }
}

/**
 * The two lines naming which preset is being browsed, its default, and — only
 * when it differs from what is browsed — the session's actual current preset.
 * @param state - the current reading.
 * @param inner - the frame's inner width.
 * @returns zero, one, or two header rows.
 */
function headerRows(state: PluginsState, inner: number): string[] {
  if (state.kind !== 'ready') return []
  const browsingId = state.browsing.presetId
  const browsingName = presetName(state, browsingId)
  const defaultName = presetName(state, state.defaultId)
  const left = `Preset: ${browsingName}`
  const right = `default: ${defaultName}`
  const gap = Math.max(1, inner - displayWidth(left) - displayWidth(right))
  const rows = [truncateToWidth(`${left}${' '.repeat(gap)}${right}`, inner)]
  if (state.sessionPresetId !== undefined && state.sessionPresetId !== browsingId) {
    const sessionName = presetName(state, state.sessionPresetId)
    rows.push(paint(truncateToWidth(`current session: ${sessionName}`, inner), 'subdued'))
  }
  rows.push('')
  return rows
}

/**
 * A preset's display name, falling back to its id when the roster no longer
 * lists it.
 *
 * Escaped here rather than at each of the three header call sites: a preset's
 * `name` is display text read out of a `preset.yml` beside its composition, so
 * it is file content and untrusted exactly like a tool result or a paste. Left
 * raw it is both obeyed by the terminal (a name carrying `ESC[2J` clears the
 * screen from inside the frame) and mis-measured by `displayWidth`, which
 * scores an escape sequence as zero columns and so lets the row overrun its
 * own box. One choke point covers the browsed, default, and session names.
 * @param state - the current reading.
 * @param id - the preset id.
 * @returns the name to show, safe to draw.
 */
function presetName(state: Extract<PluginsState, { kind: 'ready' }>, id: string): string {
  return escapeControls(state.presets.find(preset => preset.id === id)?.name ?? id)
}

/**
 * Draw a reading's rows at a known width.
 * @param state - the current reading.
 * @param rows - the filtered composition rows.
 * @param selected - the selected row's index among them.
 * @param inner - the frame's inner width in columns.
 * @returns the physical rows, the selection's row index among them, and the
 *   physical row of every selectable entry line.
 */
function renderRows(
  state: PluginsState,
  rows: readonly CompositionRow[],
  selected: number,
  inner: number,
  host: HostCapabilities,
): Rendered {
  if (state.kind === 'loading') return single('Reading agent presets…', inner)
  if (state.kind === 'unavailable') return single(state.message, inner)
  if (state.kind === 'failed') return single(`Harness could not be read: ${state.message}`, inner)
  if (state.browsing.kind === 'broken') {
    return single(`This preset's composition cannot be read: ${state.browsing.reason}`, inner)
  }
  if (rows.length === 0) {
    return single(
      state.browsing.tree.rows.length === 0 ? 'No plugin rows in this preset.' : 'No plugin matches that.',
      inner,
    )
  }
  const out: string[] = []
  const selectableRows: number[] = []
  let selectedRow = 0
  rows.forEach((row, index) => {
    const active = index === selected
    if (active) selectedRow = out.length
    // Recorded before the entry and its detail line are pushed, so this is the
    // entry's own physical row. The detail line below it is presentation and is
    // deliberately not recorded: selecting a row is not a second choice.
    selectableRows.push(out.length)
    const health = rowHealth(row, host)
    out.push(entryRow(row, active, inner, unbackedWhileEnabled(row, health)))
    if (active) {
      // Health first: an enabled row the Host cannot back is the one fact that
      // changes what the reader should do next.
      const facts = [...healthFacts(row, health), ...compositionRowFacts(row)]
      if (facts.length > 0) {
        out.push(paint(`    ${truncateToWidth(escapeControls(facts.join(' · ')), Math.max(1, inner - 4))}`, 'muted'))
      }
    }
  })
  return { rows: out, selectedRow, selectableRows }
}

/**
 * A reading with nothing to select, as one row.
 * @param text - the sentence to show.
 * @param inner - the frame's inner width.
 * @returns the single row.
 */
function single(text: string, inner: number): Rendered {
  return {
    rows: [paint(truncateToWidth(escapeControls(text), inner), 'muted')],
    selectedRow: 0,
    selectableRows: [],
  }
}

/**
 * One row: an enabled/disabled mark, the row's id and package indented to
 * its nesting depth, and its right-hand facts.
 * @param row - the composition row.
 * @param active - whether it is selected.
 * @param inner - the frame's inner width.
 * @returns the row.
 */
function entryRow(row: CompositionRow, active: boolean, inner: number, unbacked: boolean): string {
  const indent = '  '.repeat(row.depth)
  const mark = row.group ? ' ' : unbacked ? UNBACKED_MARK : rowMark(row)
  const right = row.group ? '' : rightColumn(row, inner)
  const rightWidth = Math.min(displayWidth(right), Math.max(0, inner - 10))
  const label = truncateToWidth(
    escapeControls(`${indent}${row.id ?? row.name}`),
    Math.max(1, inner - 4 - rightWidth - 1),
  )
  const gap = Math.max(1, inner - 4 - displayWidth(label) - rightWidth)
  const plain = `${label}${' '.repeat(gap)}${truncateToWidth(right, rightWidth)}`
  const body = active ? paint(plain, 'selection') : plain
  return `${active ? paint('❯', 'selection') : ' '} ${mark} ${body}`
}

/**
 * The right-hand facts: the row's package/module name, unless the id-shown
 * label already IS the name (an id-less row), in which case nothing repeats.
 * @param row - the composition row.
 * @param inner - the frame's inner width.
 * @returns the right-aligned text.
 */
function rightColumn(row: CompositionRow, inner: number): string {
  if (row.id === undefined) return ''
  const candidate = escapeControls(row.name)
  return inner - 5 - displayWidth(candidate) >= MIN_NAME_COLUMNS ? candidate : ''
}

/**
 * The query line: a prompt, the typed text, a cursor block, and the counter.
 * @param query - the typed query.
 * @param right - the counter text.
 * @param inner - the frame's inner width.
 * @returns one row.
 */
function queryRow(query: string, searching: boolean, right: string, inner: number): string {
  const prompt = '⌕ '
  const rightWidth = Math.min(displayWidth(right), Math.max(0, inner - 4))
  const room = Math.max(1, inner - displayWidth(prompt) - rightWidth - 1)
  // The cursor block only appears while search mode is actually capturing
  // keystrokes — its absence is how a reader tells "a key acts on a row" from
  // "a key is about to be typed" apart at a glance.
  const hint = '/ to search'
  const plain = searching
    ? `${tailToWidth(escapeControls(query), Math.max(1, room - 1))}█`
    // The typed path is already bounded by `room`; the empty hint was passed
    // through raw, so when the counter left less room than the constant the
    // assembled row overran the frame and the physical backstop collapsed the
    // whole browser to its one-line fallback.
    : query === '' ? truncateToWidth(hint, Math.max(1, room)) : tailToWidth(escapeControls(query), Math.max(1, room))
  const typed = !searching && query === '' ? paint(plain, 'muted') : plain
  const gap = Math.max(1, inner - displayWidth(prompt) - displayWidth(plain) - rightWidth)
  return `${paint(prompt, 'prompt-mark')}${typed}${' '.repeat(gap)}${paint(truncateToWidth(right, rightWidth), 'muted')}`
}

/**
 * What the counter says: how many rows, and whether another choice is below.
 *
 * `more below` means another selectable plugin entry sits outside the viewport,
 * not merely that the selected entry's own detail line was cut off.
 * @param shown - selectable rows after the query.
 * @param rendered - the drawn rows and where their choices landed.
 * @param viewport - the scroll position over them.
 * @returns the counter text.
 */
function counter(shown: number, rendered: Rendered, viewport: RowViewport): string {
  const more = rendered.selectableRows.some(row => row >= viewport.end) ? ' · more below' : ''
  return `${String(shown)} row${shown === 1 ? '' : 's'}${more}`
}

/**
 * The help line, truthful for the current query.
 * @param query - the typed query.
 * @param selectable - whether any row can be acted on.
 * @param columns - room available for the line.
 * @returns the help text that fits.
 */
function help(searching: boolean, query: string, selectable: boolean, columns: number): string {
  const parts = searching
    ? ['type to search', 'enter/esc done']
    : [
        ...selectable ? ['↑↓ navigate'] : [],
        '/ search',
        'p presets',
        'd default',
        query === '' ? 'esc close' : 'esc clear',
      ]
  for (let from = 0; from < parts.length; from += 1) {
    const line = parts.slice(from).join(' · ')
    if (displayWidth(line) <= columns) return line
  }
  return truncateToWidth(parts[parts.length - 1] ?? '', columns)
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
  state: PluginsState,
  shown: number,
  columns: number,
  rows: number,
  notice: SurfaceNoticeReading | undefined,
): string[] {
  if (rows <= 0) return []
  if (notice !== undefined) {
    return [paint(truncateToWidth(noticeText(notice.text), Math.max(1, columns)), notice.failed ? 'error' : 'success')]
  }
  const summary = state.kind !== 'ready' || shown === 0
    ? 'Plugins · esc close'
    : `${String(shown)} rows · esc close`
  const candidate = [summary, 'esc close', 'esc'].find(option => displayWidth(option) <= columns)
  return candidate === undefined ? [] : [paint(candidate, 'overlay-headline')]
}

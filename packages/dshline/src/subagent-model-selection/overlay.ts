/**
 * The subagent-model authorization editor: a bounded overlay owned by `/model`.
 *
 * It follows the same discipline as the `/plugins` browser — a bounded
 * viewport, a search mode its own single-key actions do not collide with,
 * truthful footer help, and no transcript rewriting. It is an auxiliary
 * surface of the `/model` picker, stacked on top of it, so `esc` here returns
 * to the picker rather than closing the command.
 *
 * The overlay draws the reading it is handed and reports intent back to its
 * owner; it never reads `ctx.settings` and never writes one. A refusal or a
 * conflict is drawn from the reading itself rather than a timed notice, so it
 * cannot fade while the reader is deciding what to do about it.
 * @module dshline/subagent-model-selection/overlay
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
import { chromeWidth, footerBudget } from '../chrome.ts'
import { modelRouteKey } from '../model-catalog.ts'
import { RowViewport } from '../scroll.ts'
import type { TuiOverlay } from '../slots.ts'
import { compactRows, frameBounded, SURFACE_FIXED_ROWS } from '../surface.ts'
import { entryLabel } from './model.ts'
import type { SubagentModelEntry, SubagentModelReading } from './model.ts'

/** Narrowest terminal that can hold the framed editor rather than the bare answer. */
const SUBAGENT_MIN_COLUMNS = BOX_CHROME_COLUMNS + 20

/**
 * What the editor says about the setting it edits.
 *
 * The second sentence names the adopted Harness generation's limitation: the
 * Session authorization covers explicit route choices made through the subagent
 * delegation tool, while explicit route choices made inside the `workflow` tool
 * are outside it. Remove that sentence when `HARNESS_TARGET` advances to a
 * released generation whose Session authorization governs those too.
 */
const DESCRIPTION = 'Selection controls which routes the model may explicitly choose through the subagent tool. In this Harness version, explicit workflow child-route choices are outside this list.'

/**
 * The one sentence the editor must not derive from the settings descriptor.
 *
 * Harness samples the setting when a new top-level Session is composed, so a
 * write here reaches the NEXT Session and never the running one. The generic
 * `applies` field reports `live` for this namespace, which understates that,
 * so the truth is written out rather than inferred.
 */
const SESSION_NOTE = 'Applies to new sessions; the current session keeps its recorded policy.'

/**
 * The suffix that marks a retained route list as not currently in force.
 *
 * Harness deliberately permits `enabled: false` with saved routes, so the row
 * must not read as if those routes were authorized now.
 */
const INACTIVE_SUFFIX = ' \u00b7 inactive'

/**
 * The `Allowed` row, worded by whether the routes are currently in force.
 *
 * A disabled setting keeps its saved routes for later; rendering them as
 * authorized would claim a permission the Session does not have.
 * @param count - routes selected in the draft.
 * @param enabled - whether the staged setting would be on.
 * @returns the heading row text.
 */
function allowedRow(count: number, enabled: boolean): string {
  if (!enabled) {
    return count === 0
      ? 'Allowed     no saved models'
      : `Allowed     ${String(count)} saved ${count === 1 ? 'model' : 'models'}${INACTIVE_SUFFIX}`
  }
  return `Allowed     ${String(count)} authorized ${count === 1 ? 'model' : 'models'}`
}

/** What the overlay needs from its owner. */
export interface SubagentModelSelectionOverlaySpec {
  /** The current reading, re-read on every paint and every action. */
  readonly reading: () => SubagentModelReading
  /** Toggle one offered route in the staged draft. */
  readonly toggle: (entry: SubagentModelEntry) => void
  /** Flip the staged enabled flag. */
  readonly flipEnabled: () => void
  /** Persist the staged draft. */
  readonly save: () => void
  /** Re-read the live catalog, preserving the draft. */
  readonly refresh: () => void
  /** Remove this overlay, discarding the draft. */
  readonly close: () => void
  /** Redraw after a move, an edit, or a landed read. */
  readonly invalidate: () => void
}

/** Rendered rows for the list, and where the cursor landed among them. */
interface Rendered {
  readonly rows: readonly string[]
  readonly selectedRow: number
}

/**
 * Create the subagent-model authorization overlay.
 * @param spec - the reading, the action intents, and overlay controls.
 * @returns a temporary live-region overlay that never writes the transcript.
 */
export function createSubagentModelSelectionOverlay(
  spec: SubagentModelSelectionOverlaySpec,
): TuiOverlay {
  const viewport = new RowViewport()
  let query = ''
  let selected = 0
  let searching = false
  /**
   * The rows the current reading and query leave.
   *
   * Derived rather than trusted from the last frame: search mode edits the
   * query without a repaint, and the coalesced invalidation does not arrive
   * between two keys, so the frame's array is not an authority for what a
   * gesture means.
   * @param reading - the reading to filter.
   * @returns the rows after the query, in the editor's order.
   */
  const rowsFor = (reading: SubagentModelReading): readonly SubagentModelEntry[] => {
    if (reading.kind !== 'ready') return []
    const needle = query.trim().toLowerCase()
    return needle === ''
      ? reading.entries
      : reading.entries.filter(entry => entryLabel(entry.route).toLowerCase().includes(needle))
  }
  const move = (amount: number): void => {
    const rows = rowsFor(spec.reading())
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
  const act = (): void => {
    const entry = rowsFor(spec.reading())[selected]
    if (entry !== undefined) spec.toggle(entry)
  }

  return {
    render(columns, terminalRows = 24) {
      const reading = spec.reading()
      const visible = rowsFor(reading)
      selected = Math.min(selected, Math.max(0, visible.length - 1))
      if (columns < SUBAGENT_MIN_COLUMNS || terminalRows <= SURFACE_FIXED_ROWS) {
        return compactFallback(reading, visible.length, columns, terminalRows)
      }
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const heading = headingRows(reading, query, searching, inner)
      const capacity = terminalRows - SURFACE_FIXED_ROWS - heading.length
      if (capacity <= 0) return compactFallback(reading, visible.length, columns, terminalRows)
      const rendered = renderRows(reading, visible, selected, inner)
      viewport.update(rendered.rows.length, capacity)
      if (rendered.selectedRow < viewport.start) viewport.move(rendered.selectedRow - viewport.start)
      if (rendered.selectedRow >= viewport.end) viewport.move(rendered.selectedRow - viewport.end + 1)
      const framed = frameBounded({
        columns,
        rows: terminalRows,
        title: 'Subagent models',
        body: [
          ...heading,
          ...rendered.rows.slice(viewport.start, viewport.end),
        ],
        footer: help(reading, searching, visible.length, query, footerBudget(columns)),
      })
      return framed ?? compactFallback(reading, visible.length, columns, terminalRows)
    },
    handleKey(key: Key) {
      const reading = spec.reading()
      // A write already in flight cannot be cancelled, so the editor refuses
      // to be abandoned while one is: closing here would leave the outcome
      // arriving at a surface that is no longer there. A live catalog read is
      // short and does not get this treatment.
      if (reading.kind === 'ready' && reading.saving) return
      if (reading.kind !== 'ready') {
        // Before the first read lands there is no draft to act on. A retry and
        // the ways out are the only keys that mean anything.
        if (key.kind === 'key' && key.name === 'ctrl-r') { spec.refresh(); return }
        if (key.kind === 'key' && (key.name === 'escape' || key.name === 'ctrl-c')) spec.close()
        return
      }
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
            // `space`/`e`/`s` act again without losing what was typed.
            searching = false
            spec.invalidate()
            return
          case 'ctrl-c':
            spec.close()
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
          case ' ':
            act()
            return
          case 'e':
            spec.flipEnabled()
            return
          case 's':
            spec.save()
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
          selected = Math.max(0, rowsFor(spec.reading()).length - 1)
          viewport.last()
          spec.invalidate()
          return
        case 'enter':
          act()
          return
        case 'ctrl-r':
          spec.refresh()
          return
        case 'escape':
          // Two stages while there is a query, as in every other dshline
          // picker: the query is what a reader most often wants back, and
          // spending the keystroke on the whole editor costs them the list.
          if (query !== '') {
            edit('')
            return
          }
          spec.close()
          return
        case 'ctrl-c':
          spec.close()
          return
        default:
          return
      }
    },
  }
}

/**
 * The rows above the list: what the setting is, whether it is on, how many
 * routes are authorized, when the change applies, any partial or total
 * catalog failure, any refusal, then the query line.
 * @param reading - the current reading.
 * @param query - the typed query.
 * @param searching - whether search mode is capturing text.
 * @param inner - the frame's inner width.
 * @returns the heading rows.
 */
function headingRows(
  reading: SubagentModelReading,
  query: string,
  searching: boolean,
  inner: number,
): string[] {
  const rows: string[] = wrapToWidth(escapeControls(DESCRIPTION), inner)
    .map(row => paint(row, 'subdued'))
  if (reading.kind === 'ready') {
    const count = reading.draft.selected.size
    rows.push(truncateToWidth(`Selection   ${reading.draft.enabled ? 'on' : 'off'}`, inner))
    rows.push(truncateToWidth(allowedRow(count, reading.draft.enabled), inner))
    for (const line of wrapToWidth(escapeControls(SESSION_NOTE), inner)) rows.push(paint(line, 'subdued'))
    if (reading.failedProviders.length > 0) {
      // Partial failure is information, not a refusal: the routes that could
      // not be listed still hold their authorization.
      const failed = escapeControls(`could not list: ${reading.failedProviders.join(', ')}`)
      rows.push(paint(truncateToWidth(failed, inner), 'muted'))
    }
    if (reading.catalogError !== undefined) {
      const error = escapeControls(`live catalog unavailable: ${reading.catalogError}`)
      rows.push(paint(truncateToWidth(error, inner), 'muted'))
    }
    if (reading.refusal !== undefined) {
      // Persistent on purpose: a conflict the reader has to act on must not
      // expire out from under them.
      for (const line of wrapToWidth(escapeControls(reading.refusal), inner)) rows.push(paint(line, 'error'))
    }
    rows.push(queryRow(query, searching, counter(reading, query), inner))
  }
  rows.push('')
  return rows
}

/**
 * Draw the list, or the one message that says why there is none.
 * @param reading - the current reading.
 * @param rows - the rows after the query.
 * @param selected - the selected index among them.
 * @param inner - the frame's inner width.
 * @returns the physical rows and the selection's row index among them.
 */
function renderRows(
  reading: SubagentModelReading,
  rows: readonly SubagentModelEntry[],
  selected: number,
  inner: number,
): Rendered {
  if (reading.kind === 'loading') return single('Reading Host settings and the model catalog…', inner)
  if (reading.kind === 'unavailable') return single(reading.message, inner)
  if (rows.length === 0) {
    return single(reading.entries.length === 0 ? 'No models to authorize yet.' : 'No model matches that.', inner)
  }
  const out: string[] = []
  let selectedRow = 0
  rows.forEach((entry, index) => {
    const active = index === selected
    if (active) selectedRow = out.length
    out.push(entryRow(entry, reading, active, inner))
  })
  return { rows: out, selectedRow }
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
  }
}

/**
 * One row: the checkbox, the exact route, and whether the live catalog still
 * advertises it.
 * @param entry - the row.
 * @param reading - the ready reading carrying the draft.
 * @param active - whether it is selected.
 * @param inner - the frame's inner width.
 * @returns the row.
 */
function entryRow(
  entry: SubagentModelEntry,
  reading: Extract<SubagentModelReading, { kind: 'ready' }>,
  active: boolean,
  inner: number,
): string {
  const key = modelRouteKey(entry.route.provider, entry.route.model)
  const mark = reading.draft.selected.has(key) ? '[x]' : '[ ]'
  const right = entry.available ? '' : 'unavailable'
  const rightWidth = displayWidth(right)
  const prefix = active ? '❯ ' : '  '
  // The label budget holds back one column for the mandatory gap below. Without
  // it a label that fills its budget makes the row `inner + 1` wide, and
  // `frame()` then wraps it into a second physical row the viewport never
  // budgeted — the same pre-fit discipline `select.ts` keeps for its rows.
  const label = truncateToWidth(
    escapeControls(entryLabel(entry.route)),
    Math.max(1, inner - displayWidth(prefix) - 4 - rightWidth - 1),
  )
  const gap = Math.max(1, inner - displayWidth(prefix) - 4 - displayWidth(label) - rightWidth)
  const plain = `${mark} ${label}${' '.repeat(gap)}${right}`
  return `${paint(prefix, active ? 'selection' : 'muted')}${active ? paint(plain, 'selection') : plain}`
}

/**
 * The query line: a prompt, the typed text, a cursor block, and the counter.
 * @param query - the typed query.
 * @param searching - whether search mode is capturing text.
 * @param right - the counter text.
 * @param inner - the frame's inner width.
 * @returns one row.
 */
function queryRow(query: string, searching: boolean, right: string, inner: number): string {
  const prompt = '⌕ '
  const rightWidth = Math.min(displayWidth(right), Math.max(0, inner - 4))
  const room = Math.max(1, inner - displayWidth(prompt) - rightWidth - 1)
  // The cursor block only appears while search mode is capturing keystrokes —
  // its absence is how a reader tells "space toggles" from "space is about to
  // be typed" apart at a glance.
  const hint = '/ to search'
  const plain = searching
    ? `${tailToWidth(escapeControls(query), Math.max(1, room - 1))}█`
    : query === '' ? truncateToWidth(hint, Math.max(1, room)) : tailToWidth(escapeControls(query), Math.max(1, room))
  const typed = !searching && query === '' ? paint(plain, 'muted') : plain
  const gap = Math.max(1, inner - displayWidth(prompt) - displayWidth(plain) - rightWidth)
  return `${paint(prompt, 'prompt-mark')}${typed}${' '.repeat(gap)}${paint(truncateToWidth(right, rightWidth), 'muted')}`
}

/**
 * What the counter says: how many rows the query left, and how many there are.
 * @param reading - the ready reading.
 * @param query - the typed query.
 * @returns the counter text.
 */
function counter(reading: Extract<SubagentModelReading, { kind: 'ready' }>, query: string): string {
  const total = reading.entries.length
  const shown = query.trim() === ''
    ? total
    : reading.entries.filter(entry => entryLabel(entry.route).toLowerCase().includes(query.trim().toLowerCase())).length
  return shown === total
    ? `${String(total)} ${total === 1 ? 'model' : 'models'}`
    : `${String(shown)} of ${String(total)}`
}

/**
 * The help line, truthful for the current mode.
 *
 * Segments are ordered least to most essential, as `frameBounded`'s fitting
 * expects: it drops whole leading segments under width pressure and never cuts
 * one.
 * @param reading - the current reading.
 * @param searching - whether search mode is capturing text.
 * @param shown - rows the query left.
 * @param query - the typed query.
 * @param columns - room available for the line.
 * @returns the help text that fits.
 */
function help(
  reading: SubagentModelReading,
  searching: boolean,
  shown: number,
  query: string,
  columns: number,
): string {
  if (reading.kind === 'ready' && reading.saving) return 'saving…'
  if (reading.kind !== 'ready') return 'ctrl-r retry · esc discard'
  if (searching) return 'type to search · enter/esc done'
  const parts = [
    ...shown > 0 ? ['↑↓ move'] : [],
    ...shown > 0 ? ['space toggle'] : [],
    'e on/off',
    '/ search',
    'ctrl-r refresh',
    's save',
    query === '' ? 'esc discard' : 'esc clear',
  ]
  for (let from = 0; from < parts.length; from += 1) {
    const line = parts.slice(from).join(' · ')
    if (displayWidth(line) <= columns) return line
  }
  return truncateToWidth(parts[parts.length - 1] ?? 'esc', columns)
}

/**
 * A closable answer for a terminal too small to hold the frame.
 * @param reading - the current reading.
 * @param shown - rows the query left.
 * @param columns - the terminal's width.
 * @param rows - the terminal's height.
 * @returns at most `rows` lines.
 */
function compactFallback(
  reading: SubagentModelReading,
  shown: number,
  columns: number,
  rows: number,
): string[] {
  if (rows <= 0 || columns <= 0) return []
  const phrases = reading.kind === 'loading'
    ? ['Subagent models · reading', 'Subagent models']
    : reading.kind === 'unavailable'
      ? ['Subagent models · unavailable', 'Subagent models']
      : reading.saving
        ? ['Subagent models · saving', 'Subagent models']
        : shown === 0
          ? ['Subagent models · no models', 'Subagent models']
          : [`Subagent models · ${String(shown)} rows`, 'Subagent models']
  return compactRows(phrases, columns)
}

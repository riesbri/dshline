/**
 * A bounded lineage browser over one session's known ancestry and descendants.
 * @module dshline/sessions/lineage-overlay
 */

import type { Key } from '@dshline/renderer'
import {
  BOX_CHROME_COLUMNS,
  displayWidth,
  escapeControls,
  paint,
  truncateToWidth,
  wrapToWidth,
} from '@dshline/renderer'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from '../chrome.ts'
import { RowViewport } from '../scroll.ts'
import type { TuiOverlay } from '../slots.ts'
import { SurfaceNotice } from '../surface.ts'
import type { SurfaceNoticeReading } from '../surface.ts'
import type { LineageRow, LineageState } from './model.ts'
import { relativeAge, shortWorkspace, UNTITLED } from './model.ts'

/** Rows outside the viewport: leading blank, two borders, and the body spacer. */
const LINEAGE_FIXED_ROWS = 4

/** Deepest visible tree guide; title text wins once a branch exceeds this. */
const MAX_INDENT_COLUMNS = 12

/** Smallest useful title after the tree guide and right-hand age are paid for. */
const MIN_DEEP_TITLE_COLUMNS = 8

/** The list browser's title-and-age floor, before lineage indentation is added. */
const SESSIONS_MIN_COLUMNS = BOX_CHROME_COLUMNS + 24

/**
 * Narrowest terminal that can show the tree without sacrificing its hierarchy.
 *
 * The list browser needs a title beside an age. Lineage additionally needs its
 * capped tree guide, so the compact answer takes over until both can coexist.
 */
const LINEAGE_MIN_COLUMNS = SESSIONS_MIN_COLUMNS + MAX_INDENT_COLUMNS + 1

/** How long a failed focus stays visible before the tree returns. */
const NOTICE_MS = 4_000

/** Title room protected before the delegated badge is allowed into a row. */
const MIN_TITLE_COLUMNS = 24

/** What the lineage browser needs from its owner. */
export interface LineageOverlaySpec {
  /** The selected session whose lineage this browser shows. */
  readonly target: SessionId | undefined
  /** The selected session's lineage read state. */
  readonly lineage: (sessionId: SessionId) => LineageState
  /** Ask the catalog for the lineage trace of the session this browser opens on. */
  readonly requestLineage: (sessionId: SessionId) => void
  /** User home for workspace shortening. */
  readonly home: string | undefined
  /** Current time, injected so ages and notices are assertable. */
  readonly now: () => number
  /** Ask the parent to select the session in its visible list. */
  readonly focus: (sessionId: SessionId) => boolean
  /** Dismiss this overlay. */
  readonly close: () => void
  /** Redraw after a move or a landed read. */
  readonly invalidate: () => void
}

/** Rendered document rows and the physical span occupied by its selection. */
interface Rendered {
  readonly rows: readonly string[]
  readonly selectedRow: number
  readonly selectedEnd: number
}

/**
 * Create a lineage browser for one session selected in the Sessions list.
 * @param spec - target lineage state, focus authority, and overlay controls.
 * @returns a temporary live-region overlay that never writes scrollback.
 */
export function createLineageOverlay(spec: LineageOverlaySpec): TuiOverlay {
  const viewport = new RowViewport()
  let selected = 0
  let selectionFor: SessionId | undefined
  // The notice owns its own expiry repaint; the surface passes its injected
  // clock so one timeline grades the deadline and arms the timer.
  const notice = new SurfaceNotice(NOTICE_MS, { now: spec.now, invalidate: spec.invalidate })
  let closed = false
  let mounted = false

  const target = spec.target
  const close = (): void => {
    if (closed) return
    closed = true
    spec.close()
  }
  const currentNotice = (): SurfaceNoticeReading | undefined => notice.read()
  const ready = (): Extract<LineageState, { kind: 'ready' }> | undefined => {
    if (target === undefined) return undefined
    const state = spec.lineage(target)
    return state.kind === 'ready' && state.sessionId === target ? state : undefined
  }
  const synchronizeSelection = (state: Extract<LineageState, { kind: 'ready' }>): void => {
    if (selectionFor !== state.sessionId || !selectable(state.rows[selected])) {
      selected = initialSelection(state)
      selectionFor = state.sessionId
    }
  }
  const move = (amount: number): void => {
    const state = ready()
    if (state === undefined) return
    synchronizeSelection(state)
    const choices = selectableRows(state.rows)
    if (choices.length === 0) return
    const at = choices.indexOf(selected)
    const position = at < 0 ? 0 : at
    selected = choices[(position + amount + choices.length) % choices.length] ?? selected
    spec.invalidate()
  }
  const jump = (end: 'first' | 'last'): void => {
    const state = ready()
    if (state === undefined) return
    const choices = selectableRows(state.rows)
    const next = end === 'first' ? choices[0] : choices.at(-1)
    if (next === undefined) return
    selected = next
    selectionFor = state.sessionId
    if (end === 'first') viewport.first()
    else viewport.last()
    spec.invalidate()
  }
  const focus = (): void => {
    const state = ready()
    if (state === undefined) return
    synchronizeSelection(state)
    const row = state.rows[selected]
    if (!selectable(row)) return
    if (spec.focus(row.id)) {
      close()
      return
    }
    notice.show('That session is not in the current list.')
    spec.invalidate()
  }

  return {
    mounted() {
      if (mounted) return
      mounted = true
      if (target === undefined) return
      const state = spec.lineage(target)
      if (state.kind === 'idle' || state.sessionId !== target) spec.requestLineage(target)
    },
    render(columns, terminalRows = 24) {
      const state = lineageState(spec, target)
      if (state.kind === 'ready') synchronizeSelection(state)
      const active = currentNotice()
      if (terminalRows <= LINEAGE_FIXED_ROWS || columns < LINEAGE_MIN_COLUMNS) {
        return compactFallback(state, columns, terminalRows, active)
      }

      const inner = chromeWidth(columns) - BOX_CHROME_COLUMNS
      const capacity = terminalRows - LINEAGE_FIXED_ROWS - (active === undefined ? 0 : 1)
      if (capacity <= 0) return compactFallback(state, columns, terminalRows, active)
      // A selection is a row plus its detail. With only one body row available,
      // following either half would hide the other and make the cursor ambiguous.
      if (state.kind === 'ready' && selectableRows(state.rows).length > 0 && capacity < 2) {
        return compactFallback(state, columns, terminalRows, active)
      }
      const rendered = renderState(state, spec, selected, inner)
      viewport.update(rendered.rows.length, capacity)
      if (rendered.selectedRow < viewport.start) {
        viewport.move(rendered.selectedRow - viewport.start)
      }
      if (rendered.selectedEnd >= viewport.end) {
        viewport.move(rendered.selectedEnd - viewport.end + 1)
      }

      const frame = [
        '',
        ...rootFrame({
          columns,
          context: paint('Sessions · lineage', 'overlay-title'),
          body: [
            ...active === undefined
              ? []
              : [paint(truncateToWidth(escapeControls(active.text), inner), 'error')],
            '',
            ...rendered.rows.slice(viewport.start, viewport.end),
          ],
          footer: fitFooterHelp(
            '↑↓ move · ↵ focus · esc back',
            footerBudget(columns),
          ),
        }),
      ]
      // Every row is fitted before framing. This catches a future omission
      // before one wrapped frame row can push live content into scrollback.
      return physicalRows(frame, columns).length <= terminalRows
        ? frame
        : compactFallback(state, columns, terminalRows, active)
    },
    handleKey(key: Key) {
      if (key.kind !== 'key') return
      switch (key.name) {
        case 'up':
          move(-1)
          return
        case 'down':
          move(1)
          return
        case 'home':
          jump('first')
          return
        case 'end':
          jump('last')
          return
        case 'enter':
          focus()
          return
        case 'escape':
        case 'ctrl-c':
          close()
          return
        default:
          return
      }
    },
    dispose(): void {
      notice.dispose()
    },
  }
}

/**
 * Read only state belonging to this overlay's target.
 * @param spec - the owner's lineage state surface.
 * @param target - the session this overlay opens on.
 * @returns target state, or idle when there is no target or the state is stale.
 */
function lineageState(spec: LineageOverlaySpec, target: SessionId | undefined): LineageState {
  if (target === undefined) return { kind: 'idle' }
  const state = spec.lineage(target)
  return state.kind === 'idle' || state.sessionId === target ? state : { kind: 'idle' }
}

/**
 * Pick the target row, falling back only when malformed state omitted it.
 * @param state - the landed lineage state.
 * @returns a selectable row index, or zero when the state contains none.
 */
function initialSelection(state: Extract<LineageState, { kind: 'ready' }>): number {
  if (selectable(state.rows[state.targetRow])) return state.targetRow
  const target = state.rows.findIndex(row => row.kind === 'target')
  return target >= 0 ? target : (selectableRows(state.rows)[0] ?? 0)
}

/**
 * Find row indices the cursor may land on.
 * @param rows - flattened lineage rows.
 * @returns indices of session rows, excluding pruning markers.
 */
function selectableRows(rows: readonly LineageRow[]): number[] {
  return rows.flatMap((row, index) => selectable(row) ? [index] : [])
}

/**
 * Whether a lineage row represents a focusable session.
 * @param row - a possibly missing flattened row.
 * @returns whether the cursor may select it.
 */
function selectable(row: LineageRow | undefined): row is Exclude<LineageRow, { kind: 'pruned' }> {
  return row !== undefined && row.kind !== 'pruned'
}

/**
 * Render one read state into a viewport-ready physical document.
 * @param state - current target state.
 * @param spec - age and path presentation inputs.
 * @param selected - selected flattened-row index.
 * @param inner - frame body width in display columns.
 * @returns rows plus the selected session's physical span.
 */
function renderState(
  state: LineageState,
  spec: LineageOverlaySpec,
  selected: number,
  inner: number,
): Rendered {
  switch (state.kind) {
    case 'idle':
      return message('No lineage read yet.', inner)
    case 'loading':
      return message('Reading lineage…', inner)
    case 'failed':
      return message(`Lineage failed: ${state.message}`, inner, 'error')
    case 'ready':
      return renderTree(state, spec, selected, inner)
  }
}

/**
 * Render a non-tree state as one safe row.
 * @param text - untrusted or static message.
 * @param inner - frame body width.
 * @param role - visual role for the message.
 * @returns a one-row document with no meaningful selection.
 */
function message(text: string, inner: number, role: 'muted' | 'error' = 'muted'): Rendered {
  return {
    rows: [paint(truncateToWidth(escapeControls(text), inner), role)],
    selectedRow: 0,
    selectedEnd: 0,
  }
}

/**
 * Render the known tree, its unresolved-parent marker, and selected detail.
 * @param state - ready lineage state.
 * @param spec - age and workspace inputs.
 * @param selected - selected flattened-row index.
 * @param inner - frame body width.
 * @returns viewport-ready physical rows.
 */
function renderTree(
  state: Extract<LineageState, { kind: 'ready' }>,
  spec: LineageOverlaySpec,
  selected: number,
  inner: number,
): Rendered {
  const rows: string[] = []
  if (!state.complete) {
    const parent = state.unresolvedParentId === undefined
      ? '— parent is not in the visible corpus'
      : `— parent ${state.unresolvedParentId} is not in the visible corpus`
    rows.push(paint(truncateToWidth(escapeControls(parent), inner), 'subdued'))
  }

  let selectedRow = 0
  let selectedEnd = 0
  state.rows.forEach((row, index) => {
    if (row.kind === 'pruned') {
      rows.push(prunedRow(row, inner))
      return
    }
    const active = index === selected
    if (active) selectedRow = rows.length
    rows.push(sessionRow(row, active, spec, inner))
    if (active) {
      rows.push(detailRow(row, spec, inner))
      selectedEnd = rows.length - 1
    }
  })
  return { rows, selectedRow, selectedEnd: Math.max(selectedRow, selectedEnd) }
}

/**
 * Render a non-selectable pruning marker at its tree depth.
 * @param row - the marker and exact omitted count.
 * @param inner - frame body width.
 * @returns one dimmed, fitted row.
 */
function prunedRow(row: Extract<LineageRow, { kind: 'pruned' }>, inner: number): string {
  const indent = treeIndent(row.depth, inner - 2)
  const label = truncateToWidth(escapeControls(row.label), Math.max(1, inner - 2 - indent.length))
  return paint(`  ${' '.repeat(indent.length)}${label}`, 'subdued')
}

/**
 * Render a session row with tree guide, title, age, and optional delegation.
 * @param row - ancestor, target, or descendant row.
 * @param active - whether the cursor selects it.
 * @param spec - age presentation inputs.
 * @param inner - frame body width.
 * @returns one fitted physical row.
 */
function sessionRow(
  row: Exclude<LineageRow, { kind: 'pruned' }>,
  active: boolean,
  spec: LineageOverlaySpec,
  inner: number,
): string {
  const maximumIndent = treeIndent(row.depth, inner - 2).length
  const right = rightColumn(row, spec, inner, maximumIndent)
  const rightWidth = Math.min(displayWidth(right), Math.max(0, inner - 4))
  const available = Math.max(1, inner - 2 - rightWidth - 1)
  const indentColumns = Math.min(maximumIndent, Math.max(0, available - MIN_DEEP_TITLE_COLUMNS))
  const title = truncateToWidth(
    escapeControls(row.title ?? UNTITLED),
    Math.max(1, available - indentColumns),
  )
  const gap = Math.max(1, inner - 2 - indentColumns - displayWidth(title) - rightWidth)
  const plain = `${' '.repeat(indentColumns)}${title}${' '.repeat(gap)}${truncateToWidth(right, rightWidth)}`
  if (active) return paint(`❯ ${plain}`, 'selection')
  return `  ${row.title === undefined ? paint(plain, 'subdued') : plain}`
}

/**
 * Cap indentation while reserving a readable title floor.
 * @param depth - flattened tree depth.
 * @param available - columns the row can spend after its selection mark.
 * @returns a string whose length is the indentation column count.
 */
function treeIndent(depth: number, available: number): string {
  const wanted = Math.max(0, Math.trunc(depth)) * 2
  return ' '.repeat(Math.min(wanted, MAX_INDENT_COLUMNS, Math.max(0, available - MIN_DEEP_TITLE_COLUMNS)))
}

/**
 * Draw the selected session's shortened workspace and stable id.
 * @param row - the selected session row.
 * @param spec - home directory used to shorten its workspace.
 * @param inner - frame body width.
 * @returns one indented, dimmed detail row.
 */
function detailRow(
  row: Exclude<LineageRow, { kind: 'pruned' }>,
  spec: LineageOverlaySpec,
  inner: number,
): string {
  const facts: string[] = []
  const workspace = shortWorkspace(row.cwd, spec.home)
  if (workspace !== undefined) facts.push(workspace)
  facts.push(row.id)
  return paint(`    ${truncateToWidth(escapeControls(facts.join(' · ')), Math.max(1, inner - 4))}`, 'muted')
}

/**
 * Choose age plus delegation only while the title keeps its minimum room.
 * @param row - the session row.
 * @param spec - current clock.
 * @param inner - frame body width.
 * @param indent - capped tree indentation.
 * @returns the row's right-hand metadata.
 */
function rightColumn(
  row: Exclude<LineageRow, { kind: 'pruned' }>,
  spec: LineageOverlaySpec,
  inner: number,
  indent: number,
): string {
  const age = relativeAge(row.createdAt, spec.now())
  if (row.origin !== 'delegated') return age
  const full = `delegated · ${age}`
  return inner - 3 - indent - displayWidth(full) >= MIN_TITLE_COLUMNS ? full : age
}

/**
 * Count physical rows Screen will draw for candidate live-region lines.
 * @param lines - candidate logical lines.
 * @param columns - terminal width.
 * @returns wrapped physical rows.
 */
function physicalRows(lines: readonly string[], columns: number): string[] {
  return lines.flatMap(line => wrapToWidth(line, Math.max(1, columns)))
}

/**
 * Give a tiny terminal one safe, closable summary row.
 * @param state - current lineage state.
 * @param columns - terminal width.
 * @param rows - terminal height.
 * @param notice - pending focus refusal, which takes precedence.
 * @returns zero or one fitted rows.
 */
function compactFallback(
  state: LineageState,
  columns: number,
  rows: number,
  notice: SurfaceNoticeReading | undefined,
): string[] {
  if (rows <= 0) return []
  if (notice !== undefined) {
    return [paint(truncateToWidth(escapeControls(notice.text), Math.max(1, columns)), 'error')]
  }
  const count = state.kind === 'ready' ? state.rows.length : 0
  const summary = `Lineage · ${String(count)} rows · esc back`
  const shown = [summary, 'esc back', 'esc'].find(candidate => displayWidth(candidate) <= columns)
  return shown === undefined ? [] : [paint(shown, 'overlay-headline')]
}

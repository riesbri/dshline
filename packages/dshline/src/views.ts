/**
 * The chrome: a banner, a framed composer, and a status line.
 *
 * All of it is ordinary slot registrations with no privileged access to the
 * runner, so a deployment that wants different chrome disables these and
 * registers its own.
 * @module dshline/views
 */

import { basename } from 'node:path'
import type { Composer, LiveCursor, Role } from '@dshline/renderer'
import {
  BOX_CHROME_COLUMNS,
  box,
  codePointWidth,
  displayWidth,
  escapeControls,
  formatElapsed,
  formatTokens,
  layoutComposer,
  paint,
  spinnerFrame,
  truncateToWidth,
  wrapToWidth,
} from '@dshline/renderer'
import type { CardDetail } from './cards.ts'
import type { ActivityWord } from './activity.ts'
import type { AttentionNotice } from './attention.ts'
import { CHROME_MIN_COLUMNS, chromeWidth, composerFrameWidth, rootFrame } from './chrome.ts'
import type { BusyEnter } from './delivery.ts'
import { DEFAULT_BUSY_ENTER } from './delivery.ts'
import type { TuiSlotView } from './slots.ts'
import { cursorWindow } from './scroll.ts'
import type { GoalReading } from './goals/model.ts'
import type { PendingUserInput } from './steering.ts'
import { LABEL_UNSAFE_RANGES } from './width-stable-tables.ts'

/** What the status line reports; the runner owns the values. */
export interface StatusState {
  /** Whether the agent is running, which turns the spinner on. */
  busy: boolean
  /** Spinner tick, advanced by the runner's timer while busy. */
  tick: number
  /** Milliseconds since the current turn started, or undefined when idle. */
  elapsedMs: number | undefined
  /** Presentation-only semantic phase or tool activity; the base never drops it. */
  activityWord: ActivityWord
  /**
   * A transient fact replacing the ready/idle reading while a resumed session's
   * transcript is still being replayed into the window. Present only during
   * that replay window, so the status never claims `ready` before the history
   * the reader asked to reopen is actually on screen.
   */
  replay: string | undefined
  /**
   * Whether a model-free maintenance operation is compacting context while the
   * agent itself remains idle. This is separate from `busy`: it must not change
   * what ctrl-c means or claim that a model turn is running.
   */
  compacting?: boolean
  /**
   * The tool calls still awaiting results, when any are outstanding: the newest
   * one's presentation title, and how many others are running beside it.
   */
  activity: { title: string; others: number } | undefined
  /**
   * A short-lived emphasis for a consequential state change that just happened,
   * or undefined when nothing needs attention.
   *
   * While it stands it occupies the ordinary activity position, so the reader
   * sees what changed rather than which tool is running, and it is never drawn
   * beside the activity title. It is presentation only: an authority — a Harness
   * event, the applied selection, or the status line itself — already
   * established the fact, and the notice yields to the busy/ready/compacting
   * base and to plan or goal modes.
   */
  attention: AttentionNotice | undefined
  /**
   * The route-qualified identity of the live selection — `selection.current`,
   * the same mutable ref `/model` writes, and the model selected for subsequent
   * model work. It is deliberately only the selected configuration: the route a
   * model step in progress has privately captured is Harness execution state
   * that this public ref cannot prove atomically, so the footer does not claim
   * it. Route-qualified because two provider routes can advertise the same
   * model id, and a bare id would make them one reading here; one indivisible
   * segment, so the body ladder drops or keeps it whole. The banner's
   * attachment-time identity is deliberately a different fact.
   */
  model: string | undefined
  /** Reasoning level, only when it differs from the route's default. */
  effort: string | undefined
  /**
   * The attached Session's effective Harness permission: the raw
   * `permissions.currentValue`, already one whole segment. A configured preset
   * id, `auto`, or derived `custom` — opaque, so it is painted as-is and never
   * resolved through the process catalog, which answers what is selectable
   * rather than what is in force. Undefined when the optional capability or its
   * projection is absent, which omits the segment entirely.
   */
  permission?: string | undefined
  /**
   * Cumulative session usage, already formatted, or undefined when the reader
   * has switched it off. Pre-formatted because pricing is not a layout concern:
   * this module decides where the segment goes and when to give it up, and knows
   * nothing about tokens costing money.
   */
  usage: string | undefined
  /**
   * Share of the prompt tokens served from the provider's cache, already
   * formatted as one whole segment, or undefined when there is nothing true to
   * report. Folded from its own authority rather than from the totals in
   * {@link StatusState.usage}, so it is not a breakdown of them.
   *
   * Convenience information rather than a status fact: it is the first thing
   * this line gives up, and it is never shortened, because a cut ratio is a
   * different number rather than a smaller one.
   */
  cacheRead: string | undefined
  /** Current context pressure in tokens, when the meter is mounted. */
  tokens: number | undefined
  /** The model's context window, when the adapter reported one. */
  contextWindow: number | undefined
  /** How much of a tool card is drawn, cycled with `ctrl-o`. */
  detail: CardDetail
  /** Active generic Harness work, already formatted as whole count segments. */
  work: string | undefined
  /**
   * User input pending on each of Harness's boundary lists. Zero on both, or
   * undefined, reports nothing.
   */
  pending: PendingUserInput | undefined
  /** Current Harness Todo completion count, as one indivisible segment. */
  todo: string | undefined
  /** Whether plan mode is in force, so the agent will propose rather than act. */
  plan: boolean
  /** One whole goal state/progress segment; `/goal` owns objective inspection. */
  goal: GoalReading | undefined
}

/** The composer's prompt, inside the frame. */
const PROMPT = '› '

/** Gutter for a continuation line, aligning it under the prompt. */
const CONTINUATION = '  '

/** Separator between the empty composer's hint segments, as the status line joins its own. */
const HINT_SEPARATOR = ' · '

/**
 * Rows the composer's content may occupy before it scrolls.
 *
 * The live region is redrawn by climbing rows, so it has to stay shorter than the
 * screen: rows that have already scrolled off cannot be reached or erased, and the
 * next redraw then leaves duplicate composer rows in scrollback and can clear
 * unrelated output. An uncapped composer reaches that on an ordinary action —
 * pasting twenty short lines into a twenty-four-row terminal — so the content
 * scrolls around the cursor instead, which is what any editor does.
 */
const COMPOSER_ROWS = 10

/** Blank separator and two borders outside the composer's content rows. */
const COMPOSER_FIXED_ROWS = 3

/** Cells in the context-pressure bar. */
const BAR_CELLS = 8

/** Glyphs the bar is drawn from. */
const BAR_FULL = '█'
const BAR_EMPTY = '░'

/**
 * Partial cells, one eighth to seven eighths.
 *
 * These are what make the bar usable at all on a million-token window. Whole cells
 * alone need 12.5% of the window before the first one appears — 125k tokens, which
 * almost no session reaches — so the bar a reader was promised was never drawn. At
 * an eighth of a cell each, the same eight columns carry 64 steps, and the first is
 * visible at 1.6%.
 */
const BAR_PARTIAL: readonly string[] = ['\u258f', '\u258e', '\u258d', '\u258c', '\u258b', '\u258a', '\u2589']

/** Steps per cell: the partial glyphs plus the full one. */
const BAR_STEPS = BAR_PARTIAL.length + 1

/** Context fill at which the pressure reading warns. */
const PRESSURE_WARN = 0.7

/** Context fill at which it alarms. */
const PRESSURE_ALARM = 0.9

/** Code points that can start an emoji keycap sequence (`1️⃣`, `#️⃣`, `*️⃣`). */
function isKeycapBase(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || code === 0x23 || code === 0x2a
}

/** Variation selector-15, which asks a terminal for text presentation. */
const VS15 = 0xfe0e

/** Variation selector-16, which asks a terminal for emoji presentation. */
const VS16 = 0xfe0f

/** Combining enclosing keycap, the last code point of a keycap sequence. */
const KEYCAP = 0x20e3

/** Zero-width joiner, which welds several pictographs into one drawn picture. */
const ZWJ = 0x200d

/** First emoji skin-tone modifier. */
const MODIFIER_START = 0x1f3fb

/** Last emoji skin-tone modifier. */
const MODIFIER_END = 0x1f3ff

/**
 * Whether `code` falls inside one of `ranges`, by binary search.
 * @param ranges - sorted inclusive ranges.
 * @param code - the code point to locate.
 * @returns whether a range contains `code`.
 */
function inRanges(ranges: readonly (readonly [number, number])[], code: number): boolean {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const range = ranges[mid]
    if (range === undefined) return false
    if (code < range[0]) high = mid - 1
    else if (code > range[1]) low = mid + 1
    else return true
  }
  return false
}

/**
 * Whether a width-critical label can carry `code` without under-measuring it.
 *
 * The invariant is one-directional: the terminal must never draw MORE cells
 * than the model counts, because a row physically wider than its model wraps
 * onto a row the live-region arithmetic never budgeted. ASCII and a zero- or
 * two-column measurement are safe — a terminal does not draw a nonspacing mark
 * or a wide code point as more than that — while a one-column measurement is
 * safe only when the code point is unambiguously narrow.
 *
 * `LABEL_UNSAFE_RANGES` marks everything else: East Asian Ambiguous code points
 * a terminal in an ambiguous-width mode widens, wide code points a stale
 * renderer table may still measure one, the emoji and pictographic code points
 * a terminal may draw as a two-column picture, and the format characters the
 * renderer deliberately leaves measured one because their advance is disputed
 * or sequence-dependent. That set is a Unicode property, never a list of
 * scripts: Hebrew, Arabic, and Indic letters are East Asian Neutral, which no
 * standard terminal mode widens, so they are kept, while a Latin-1 accented
 * letter, which is genuinely Ambiguous, is not — unless its canonical
 * decomposition is stable, which {@link stableDecomposition} checks.
 *
 * The two-column branch is deliberately reached before the table: a terminal
 * draws a wide code point two columns, whereas a stale renderer measures the
 * same code point one and then the table catches it. That makes the predicate
 * safe against the published renderer as well as this one.
 * @param code - the code point.
 * @returns whether the code point may stay in the label unchanged.
 */
function stableWidth(code: number): boolean {
  if (code < 0x80) return true
  if (codePointWidth(code) !== 1) return true
  return !inRanges(LABEL_UNSAFE_RANGES, code)
}

/**
 * The canonical decomposition of `code`, when every part is width-stable.
 *
 * A precomposed Latin accent such as `é` is East Asian Ambiguous and so is not
 * directly safe. Its canonical decomposition, `e` + U+0301, is: the base is
 * ASCII and the mark is zero-width under the renderer's mark policy, so the
 * pair measures and draws as one cell whether or not the terminal widens
 * Ambiguous characters. Returning the decomposition keeps the accent a reader
 * sees while removing the ambiguity the terminal would otherwise be free to
 * widen. A decomposition is only used when it does not change the measured
 * width and introduces no sequence-forming code point, so a Hangul syllable
 * (whose Jamo parts measure more than the syllable) and an accented Greek
 * letter (whose base is itself Ambiguous) both fall through and are projected
 * instead.
 * @param code - the code point to try to keep.
 * @returns the stable decomposition, or undefined when there is none.
 */
function stableDecomposition(code: number): string | undefined {
  const char = String.fromCodePoint(code)
  const decomposed = char.normalize('NFD')
  if (decomposed === char) return undefined
  if (displayWidth(decomposed) !== codePointWidth(code)) return undefined
  for (const component of decomposed) {
    const componentCode = component.codePointAt(0) ?? 0
    if (
      componentCode === VS15
      || componentCode === VS16
      || componentCode === ZWJ
      || componentCode === KEYCAP
    ) {
      return undefined
    }
    if (!stableWidth(componentCode)) return undefined
  }
  return decomposed
}

/**
 * Project untrusted text to characters whose width a terminal cannot draw wider
 * than the model counts.
 *
 * `displayWidth` follows East Asian Width with Ambiguous code points measured
 * narrow. A terminal in ambiguous-width mode draws them two columns wide, so
 * untrusted text carrying one and placed into width-critical chrome — the
 * composer's frame label above all — makes the measured row shorter than the
 * drawn one, and the border wraps a physical row the redraw arithmetic never
 * counts; the stale border then survives every erase. The invariant here is
 * one-directional: the terminal must not draw MORE than the model counts.
 * Drawing less only shortens the row, which is safe.
 *
 * The alternative, treating every East Asian Ambiguous code point as two columns
 * globally, would move geometry for every terminal that keeps them narrow and for
 * the box drawing and punctuation the chrome cannot give up. So the projection
 * is per code point and only where the width is in doubt: an Ambiguous letter is
 * kept when its canonical decomposition is stable (`café` renders as `cafe` +
 * U+0301), and a narrow script no terminal widens is kept whole. A code point
 * that is Ambiguous with no stable decomposition, a text-default pictograph a
 * terminal may draw as a picture, a format character whose advance the renderer
 * deliberately leaves measured one, and the multi-code-point sequences no
 * per-code-point rule can see — a keycap, a VS15/VS16 presentation, a ZWJ
 * sequence, a skin-tone modifier — are projected to `placeholder`.
 *
 * The label is composed with NFC first, so a canonically decomposed Hangul
 * syllable is drawn as its single wide syllable rather than as a run of Jamo
 * whose widths terminals disagree about. The projection is LOSSY and not
 * injective; identity survives because the committed banner prints the full,
 * unprojected workspace name, and this frame's right title is the only consumer.
 * @param text - plain text; the caller has already neutralized controls.
 * @param placeholder - the width-stable character substituted one for one.
 * @returns text the model can hold to a bounded number of physical cells.
 */
export function widthStableLabel(text: string, placeholder = '?'): string {
  const chars = [...text.normalize('NFC')]
  let out = ''
  for (let index = 0; index < chars.length; index += 1) {
    const code = chars[index]?.codePointAt(0) ?? 0
    const next = chars[index + 1]?.codePointAt(0)
    const afterNext = chars[index + 2]?.codePointAt(0)
    // A keycap is one drawn two-column picture built from an ASCII base, an
    // optional VS16, and U+20E3; per-code-point measurement sees width one and
    // would let the terminal draw two, so the whole sequence is one placeholder.
    if (isKeycapBase(code) && (next === KEYCAP || (next === VS16 && afterNext === KEYCAP))) {
      out += placeholder
      index += next === KEYCAP ? 1 : 2
      continue
    }
    // A presentation selector changes how the terminal draws the base before it.
    // VS16 can present a text-default pictograph — or a keycap base like
    // `1`/`#`/`*`, whose emoji form needs no U+20E3 — as a two-column emoji, and
    // VS15 asks even a wide pictograph to draw as text. ASCII with no
    // pictographic form has an inert selector, so it is kept rather than
    // rewritten. The selector ITSELF is dropped: it is zero-width, and once the
    // base is a placeholder it has nothing left to present.
    if (next === VS15 || next === VS16) {
      out += code >= 0x80 || isKeycapBase(code) ? placeholder : (chars[index] ?? '')
      index += 1
      continue
    }
    // A skin-tone modifier joins the pictograph before it into one drawn
    // picture; the pair measures four columns but may draw as two.
    if (next !== undefined && next >= MODIFIER_START && next <= MODIFIER_END) {
      out += placeholder
      index += 1
      continue
    }
    // A ZWJ sequence is one grapheme the terminal draws as one picture, whose
    // width is unrelated to the sum of its parts. Project the whole run.
    if (next === ZWJ) {
      while (chars[index + 1]?.codePointAt(0) === ZWJ && chars[index + 2] !== undefined) index += 2
      out += placeholder
      continue
    }
    // An orphaned joiner or modifier has no base to join. It is projected rather
    // than kept as a zero-width code point that would attach to whatever follows.
    if (code === ZWJ || (code >= MODIFIER_START && code <= MODIFIER_END)) {
      out += placeholder
      continue
    }
    if (stableWidth(code)) {
      out += chars[index] ?? ''
      continue
    }
    out += stableDecomposition(code) ?? placeholder
  }
  return out
}

/**
 * The framed input line.
 *
 * The cursor is reported relative to this view because the frame means the
 * composer is no longer the region's last row, and the runner should not have to
 * know how tall a border is.
 * @param composer - the buffer being edited.
 * @param workspace - session workspace, whose basename titles the frame.
 * @param rowsBelow - fixed live rows the composer must leave beneath itself.
 * @param hint - what the empty composer should say about right now. Read per
 *   paint, because both halves of it change while the frame stands. The default
 *   is the idle answer, which is what a caller with no agent to ask — every
 *   layout test here — is entitled to.
 * @returns the slot view.
 */
export function createComposerView(
  composer: Composer,
  workspace: string,
  rowsBelow: () => number = () => 1,
  hint: () => ComposerHint = () => ({ busy: false, busyEnter: DEFAULT_BUSY_ENTER }),
): TuiSlotView {
  const label = basename(workspace) === '' ? workspace : basename(workspace)
  // The label names a session folder, so it is untrusted text. It is also drawn
  // inside the frame's top border, whose row arithmetic must be exact: a code
  // point a terminal renders wider than `displayWidth` says makes the border
  // wrap a physical row `Screen` never counts, and the stale border survives
  // every erase. Projecting it to width-stable characters is what keeps the
  // border's geometry true without moving the renderer's global width policy.
  const escapedLabel = widthStableLabel(escapeControls(label))

  /**
   * A layout result kept for one (revision, width) pair.
   *
   * `TuiSlots.compose` asks a view for `render()` and then `cursor()` with the
   * same geometry and the same composer state, and both need the wrapped rows —
   * without this the whole buffer is laid out twice per frame. The key is the
   * COMPOSER'S OWN REVISION rather than its text, and that is a performance
   * property as much as a tidiness one. The key used to be `composer.value`, so
   * asking "did anything change?" cost a full join of the draft on every frame —
   * and once a large paste is folded, the text being joined on each of those
   * frames was mostly content the frame was about to draw as a single short
   * token. A counter answers the question without touching the buffer at all, and
   * because it is bumped by every change to the text, the cursor, or the folds, it
   * cannot report "unchanged" for a frame that would have drawn differently.
   *
   * One entry, because a frame uses one geometry and a map keyed by width would
   * grow without bound across a resize.
   */
  let memo:
    | { revision: number; columns: number; rows: readonly string[]; row: number; column: number }
    | undefined

  /**
   * Every rendered row of the buffer, and which of them holds the cursor.
   *
   * Rows are CHUNKED at the width rather than wrapped at spaces, and that choice is
   * what makes the cursor placeable at all. Chunking is prefix-consistent — the rows
   * for the text before the cursor are the first rows for the whole line — so
   * locating the cursor is a matter of chunking that prefix. Word wrapping has no
   * such property: typing one more character can pull a whole word onto the next
   * row, moving a break that is BEFORE the cursor, so a prefix laid out on its own
   * disagrees with the same prefix inside the finished line and the cursor lands on
   * the wrong row.
   *
   * It is also how a terminal's own line editing behaves: a row breaks where the
   * screen runs out, and a character appears in the column it was typed in.
   *
   * The layout comes from the shared primitive so that `↑`/`↓` movement, which the
   * input router also runs through `layoutComposer`, places the cursor on exactly
   * the rows this renders.
   * @param columns - the terminal's current width.
   * @returns the rows and the cursor's row and column within them.
   */
  const layout = (columns: number): { rows: readonly string[]; row: number; column: number } => {
    const revision = composer.revision
    if (memo !== undefined && memo.revision === revision && memo.columns === columns) {
      return { rows: memo.rows, row: memo.row, column: memo.column }
    }
    const found = layoutComposer(composer, composerInner(columns), line => composerGutter(line, columns))
    memo = { revision, columns, rows: found.rows, row: found.cursorRow, column: found.cursorColumn }
    return { rows: found.rows, row: found.cursorRow, column: found.cursorColumn }
  }

  /**
   * The rows to draw, scrolled so the cursor's row is visible.
   *
   * The policy itself lives in {@link cursorWindow}, shared with the bounded
   * subagent message overlay; this wrapper only supplies the composer's own
   * fixed live-region cap on top of the budget `compose()` granted.
   * @param all - every wrapped row of the buffer.
   * @param row - the cursor's row within them.
   * @param maximum - most content rows the current live-region budget permits.
   * @returns the visible rows, how many were scrolled past above them, and how
   *   many remain below — the two figures the overflow indicator reports.
   */
  const window = (
    all: readonly string[],
    row: number,
    maximum = COMPOSER_ROWS,
  ): { rows: readonly string[]; offset: number; below: number } =>
    cursorWindow(all, row, maximum, COMPOSER_ROWS)

  /**
   * The frame title, with an honest count of what the viewport hides.
   *
   * The old title said only `+37 rows`, which cannot tell a reader whether the
   * cursor is near the start of a paste or stranded at its end — the two cases
   * want opposite directions. A direction is only named when there is something
   * that way, so a draft scrolled to its top reads as the plain workspace name
   * and `^` visibly means history. The string is handed to `rootFrame`, whose
   * border arithmetic truncates from the RIGHT, so `^` is written first: the
   * upward direction is the one that falls through to history, and it is the
   * reading a narrow terminal can least afford to lose. Both are shown whenever
   * they fit.
   *
   * The markers are ASCII on purpose, not the `↑`/`↓` arrows they replaced.
   * Those are East Asian Ambiguous width: Dshline measures each as one column,
   * but a terminal in an ambiguous-width mode advances two, so a title with
   * both made the top border one physical row taller than the live region
   * modeled. `Screen` climbs by the rows it drew, so the wrapped row survived
   * the next erase and every `↑`/`↓` press left another top border behind. A
   * chrome label is not worth changing the renderer's global width policy for
   * box drawing and punctuation, so the presentation chooses glyphs whose
   * width is unambiguous instead.
   * @param hiddenAbove - rows scrolled off the top of the viewport.
   * @param hiddenBelow - rows the viewport does not reach beneath it.
   * @returns the painted title for the frame's top border.
   */
  const frameTitle = (hiddenAbove: number, hiddenBelow: number): string => {
    const label = paint(escapedLabel, 'composer-title')
    const parts: string[] = []
    if (hiddenAbove > 0) parts.push(`^ ${String(hiddenAbove)}`)
    if (hiddenBelow > 0) parts.push(`v ${String(hiddenBelow)}`)
    if (parts.length === 0) return label
    return `${label} ${paint(parts.join(' '), 'muted')}`
  }

  /**
   * Content rows the frame may spend inside the live-region budget, shared by
   * render and cursor.
   *
   * The slice a frame draws and the window its cursor assumes are two projections
   * of one calculation, and keeping them apart put the cursor on chrome below the
   * frame exactly when a short terminal scrolled a tall buffer — the only case
   * where the two windows differ, and therefore the one that has to be tested.
   * @param rows - the budget compose() handed this view, or undefined from a
   *   caller that does not know one; the composer's own cap alone bounds it there.
   * @returns most content rows the frame may draw around its cursor.
   */
  const contentBudget = (rows: number | undefined): number =>
    rows === undefined ? COMPOSER_ROWS : rows - Math.max(0, rowsBelow()) - COMPOSER_FIXED_ROWS

  /**
   * Whether the terminal is tall enough for the framed composer.
   *
   * Only the frame's own fixed rows are required: the rows reserved below it
   * (timing, status) are allowed to yield first, which is the priority under
   * pressure — dropping the input frame instead would cost the one surface
   * every interaction starts from. Below this the unframed fallback draws the
   * input line alone.
   * @param rows - the budget compose() handed this view, or undefined when unbounded.
   * @returns true when the framed branch fits.
   */
  const frameFits = (rows: number | undefined): boolean =>
    rows === undefined || COMPOSER_FIXED_ROWS <= rows

  /**
   * Whether the frame keeps the blank separating it from committed output.
   *
   * An empty buffer cannot scroll like a filled one, so under budget pressure the
   * frame sheds decoration before structure: the separator goes first, the borders
   * never — an input line is how every interaction starts, and on an impossibly
   * small terminal usability outranks the reservation, the same priority the
   * timing panel honours by giving up body rows ahead of its header.
   * @param rows - the budget compose() handed this view, or undefined when unbounded.
   * @returns true when the full frame fits alongside everything reserved below.
   */
  const keepsSeparator = (rows: number | undefined): boolean =>
    rows === undefined || COMPOSER_FIXED_ROWS + 1 <= rows - Math.max(0, rowsBelow())

  /** Row of the frame's first content line, which the separator's presence moves. */
  const contentRowOffset = (rows: number | undefined): number => keepsSeparator(rows) ? 2 : 1

  /**
   * The composer laid out directly against the terminal's width, with no
   * frame around it.
   *
   * `composerInner` already collapses to the physical width below the chrome
   * floor, so this is the same layout the framed branch builds; going through
   * {@link layout} is what shares ONE computation between the fallback's render
   * and its cursor placement instead of laying the buffer out twice.
   * @param columns - the terminal's current width.
   * @returns the rows and the cursor's row and column within them.
   */
  const narrowLayout = layout

  /** Rows outside the composer's own content in the fallback: no borders, just the optional separator. */
  const NARROW_FIXED_ROWS = 1

  /** Content rows the fallback may spend, the same accounting as {@link contentBudget} without the borders. */
  const narrowContentBudget = (rows: number | undefined): number =>
    rows === undefined ? COMPOSER_ROWS : rows - Math.max(0, rowsBelow()) - NARROW_FIXED_ROWS

  /** Whether the fallback keeps the blank separator, by the same rule as {@link keepsSeparator}. */
  const narrowKeepsSeparator = (rows: number | undefined): boolean =>
    rows === undefined || NARROW_FIXED_ROWS + 1 <= rows - Math.max(0, rowsBelow())

  /** Row of the fallback's first content line, which the separator's presence moves. */
  const narrowContentRowOffset = (rows: number | undefined): number => narrowKeepsSeparator(rows) ? 1 : 0

  return {
    // A blank line above separates the frame from whatever the transcript just
    // committed, so a reply and the input box do not read as one block.
    render: (columns, terminalRows = 24) => {
      // Below the shared chrome floor, `rootFrame` would ask for a frame wider
      // than the terminal: `Screen` re-wraps that AFTER this view has already
      // budgeted the live region, which is exactly what invalidates it. There
      // is no width left for chrome at all here, so the fallback draws the
      // composer's own rows directly against `columns`, with no frame and no
      // hint — editable text and a valid cursor are the only things a terminal
      // this narrow is guaranteed to have room for.
      if (columns < CHROME_MIN_COLUMNS || !frameFits(terminalRows)) {
        const { rows, row } = narrowLayout(columns)
        const shown = window(rows, row, narrowContentBudget(terminalRows))
        return narrowKeepsSeparator(terminalRows) ? ['', ...shown.rows] : [...shown.rows]
      }
      if (composer.isEmpty) {
        // One row, chosen to fit — never `chunkToWidth`, which would wrap it and
        // make this the only view in the live region that can outgrow its budget.
        const prompt = rootFrame({
          columns,
          width: composerFrameWidth(columns),
          context: paint(escapedLabel, 'composer-title'),
          body: [composerHintRow(hint(), composerInner(columns))],
        })
        return keepsSeparator(terminalRows) ? ['', ...prompt] : [...prompt]
      }
      const { rows, row } = layout(columns)
      // The timer and status are persistent when enabled, so a tall paste gives
      // up composer history rather than pushing either below the physical screen.
      const shown = window(rows, row, contentBudget(terminalRows))
      const framed = rootFrame({
        width: composerFrameWidth(columns),
        columns,
        context: frameTitle(shown.offset, shown.below),
        body: shown.rows,
      })
      // The same shed rule as the empty frame, so the cursor's own arithmetic in
      // cursor() can share it without either half learning the other's ladder.
      return keepsSeparator(terminalRows) ? ['', ...framed] : [...framed]
    },
    cursor: (columns, rows): LiveCursor => {
      if (columns < CHROME_MIN_COLUMNS || !frameFits(rows)) {
        const { rows: every, row, column } = narrowLayout(columns)
        const shown = window(every, row, narrowContentBudget(rows))
        // No frame is drawn here, so the layout's own column is already the
        // terminal column: it counts the gutter, and adding the framed branch's
        // border would push the caret two cells past a terminal that may not even
        // have two columns.
        return { row: narrowContentRowOffset(rows) + row - shown.offset, column }
      }
      if (composer.isEmpty) return { row: contentRowOffset(rows), column: 2 + displayWidth(PROMPT) }
      const { rows: every, row, column } = layout(columns)
      const shown = window(every, row, contentBudget(rows))
      // Content starts below the separator and the top border, and the placement
      // is relative to the visible window — the SAME window render chose.
      return { row: contentRowOffset(rows) + row - shown.offset, column: 2 + column }
    },
  }
}

/** What the empty composer's hint answers about right now. */
export interface ComposerHint {
  /** Whether a turn is in flight, which is what changes the answer. */
  readonly busy: boolean
  /** What plain `enter` means while one is. */
  readonly busyEnter: BusyEnter
  /** Unsent session-scoped image count, when any are staged. */
  readonly images?: number
  /** Unsent session-scoped generic file count, when any are staged. */
  readonly files?: number
}

/**
 * The empty composer's hint, as ONE row that always fits.
 *
 * Three questions, answered in the order they are asked: can I type here (the
 * prompt, which never goes), what does enter do right now (the first segment),
 * and how do I find more (the second, idle only).
 *
 * This is presentation and nothing else. It is produced from the agent's state
 * at paint time and handed straight to the frame, so it is never in the buffer,
 * the history, the undo stacks, a submission, or a completion's input — the
 * empty branch that draws it cannot reach any of those.
 *
 * **Whole segments, and exactly one row.** Both halves of that matter, and the
 * second is the one that used to be wrong. Segments shed by the status line's
 * rule — `› ask anything · / me` reads as a rendering fault, not as help — but
 * the older code fitted this text with `chunkToWidth`, which WRAPS: below
 * nineteen columns the empty composer already drew five rows instead of four,
 * and on a short terminal that pushed the live region past the screen, where
 * rows that have scrolled off can neither be reached nor erased. The empty
 * branch was the one view in the region that spent none of its own budget, and
 * a longer hint would have moved that cliff into ordinary split-pane widths. So
 * the ladder returns a single row by construction, and the frame is handed one.
 *
 * Nothing here advertises `ctrl-enter`. It is decodable only where the terminal
 * implements an enhanced encoding, is byte-identical to `enter` everywhere else,
 * and cannot be probed for — so naming it would tell most readers to press a key
 * that silently does the other thing. `docs/usage.md` teaches it instead, which
 * is the same call this interface already made about `shift-enter`.
 * @param hint - whether a turn is running, and what enter means while one is.
 * @param inner - the framed composer's content width, from {@link composerInner}.
 *   The narrow unframed fallback does not call this helper.
 * @returns one row, prompt included, painted and ready for the frame.
 */
export function composerHintRow(hint: ComposerHint, inner: number): string {
  // Busy names only what typing means now. Idle adds the way to find everything
  // else — `menu` rather than `commands` because that surface carries local
  // commands, the agent's own, and user-invocable skills, and a skill is not a
  // command.
  // Both staged kinds are ONE segment, not two. The ladder sheds whole segments,
  // and a second segment would mean a second rung to fit — which on a narrow
  // pane is exactly where the staged count, the one thing that changes what
  // pressing enter does, would be the first thing lost.
  const counts = [
    hint.images === undefined || hint.images < 1
      ? undefined
      : `${String(hint.images)} ${hint.images === 1 ? 'image' : 'images'}`,
    hint.files === undefined || hint.files < 1
      ? undefined
      : `${String(hint.files)} ${hint.files === 1 ? 'file' : 'files'}`,
  ].filter((segment): segment is string => segment !== undefined)
  const staged = counts.length === 0 ? undefined : counts.join(' · ')
  const rungs: readonly (readonly string[])[] = hint.busy
    ? staged === undefined
      ? [[`type to ${hint.busyEnter}`], []]
      : [[staged, `type to ${hint.busyEnter}`], [staged], []]
    : staged === undefined
      ? [['ask anything', '/ menu'], ['ask anything'], []]
      : [[staged, 'ask anything', '/ menu'], [staged, 'ask anything'], [staged], []]
  const separator = paint(HINT_SEPARATOR, 'chrome')
  for (const segments of rungs) {
    const width = displayWidth(PROMPT)
      + segments.reduce((total, segment) => total + displayWidth(segment), 0)
      + Math.max(0, segments.length - 1) * displayWidth(HINT_SEPARATOR)
    if (width > inner) continue
    // Painted per segment rather than over the joined string, so the separator
    // keeps the chrome role the status line gives it and each closer is the full
    // reset. The prompt is left unpainted: it is the real input affordance, and
    // `cursor()` places the caret just past it at every rung.
    return `${PROMPT}${segments.map(segment => paint(segment, 'muted')).join(separator)}`
  }
  // Unreachable in the framed branch — the empty rung is two columns and its
  // inner width floors at eight — but a ladder whose last rung could be skipped
  // would return undefined, and the prompt is the one thing that must survive.
  return PROMPT
}

/**
 * Display columns of the composer's content area, including its gutter.
 *
 * The width is shared by the view that draws the cursor and the router that moves
 * it. Below the frame floor it becomes the physical terminal width, because the
 * unframed fallback has no border cells to subtract.
 * @param columns - the terminal's current width.
 * @returns the content width the composer draws and moves within.
 */
export function composerInner(columns: number): number {
  return columns < CHROME_MIN_COLUMNS
    ? Math.max(1, columns)
    : composerFrameWidth(columns) - BOX_CHROME_COLUMNS
}

/**
 * The gutter preceding each logical line of the composer.
 *
 * Line zero carries the prompt; continuation lines an indent of the same width,
 * so the wrapped text lines up under the prompt. The optional terminal width is
 * used by the unframed narrow fallback, where the gutter itself may not fit.
 * @param line - zero-based logical line index.
 * @param columns - the terminal's current width, when the gutter must be bounded.
 * @returns the line's leading gutter.
 */
export function composerGutter(line: number, columns?: number): string {
  const gutter = line === 0 ? PROMPT : CONTINUATION
  return columns === undefined ? gutter : truncateToWidth(gutter, Math.max(0, columns))
}

/**
 * Colour for a context reading: quiet until the window is most of the way full,
 * then warning, then alarm — so the number is ignorable until it matters.
 * @param tokens - current pressure.
 * @param window - the model's context window, when known.
 * @returns the role to apply.
 */
export function pressureStyle(tokens: number, window: number | undefined): Role {
  if (window === undefined || window <= 0) return 'pressure-nominal'
  const fill = tokens / window
  if (fill >= PRESSURE_ALARM) return 'pressure-alarm'
  if (fill >= PRESSURE_WARN) return 'pressure-warn'
  return 'pressure-nominal'
}

/**
 * A bar for context pressure, or nothing when there is nothing to report.
 *
 * Measured in eighths of a cell rather than whole cells, which is what makes it
 * appear at all. A DeepSeek window is a million tokens: in whole cells the first one
 * fills at 12.5%, so a bar drawn that way stayed invisible through every session
 * anyone really has — and a feature nobody ever sees is indistinguishable from one
 * that is broken. In eighths the same eight columns resolve to 64 steps.
 *
 * The scale stays strictly linear — a curve would fill sooner and would misreport
 * proportion — with one rule at each end, both of the same kind: never show a state
 * the reader has not reached. Any use at all rounds UP to the first visible mark,
 * because a bar reading empty while the window is in use is the failure this
 * function exists to avoid. The fill is otherwise rounded DOWN, so the bar is not
 * full until the window is.
 *
 * Nothing is drawn before the first token, when there is genuinely nothing to see.
 * @param tokens - current pressure.
 * @param window - the model's context window, when known.
 * @param cells - width of the bar in columns; the status line's is the default.
 * @returns the styled bar, or undefined when it would carry no information.
 */
export function pressureBar(
  tokens: number,
  window: number | undefined,
  cells: number = BAR_CELLS,
): string | undefined {
  if (window === undefined || window <= 0 || tokens <= 0) return undefined
  const width = Math.max(1, Math.trunc(cells))
  const steps = width * BAR_STEPS
  const filled = Math.min(steps, Math.max(1, Math.floor((tokens / window) * steps)))
  const whole = Math.floor(filled / BAR_STEPS)
  const remainder = filled % BAR_STEPS
  const partial = remainder === 0 ? '' : BAR_PARTIAL[remainder - 1] ?? ''
  const empty = width - whole - (partial === '' ? 0 : 1)
  return paint(
    `${BAR_FULL.repeat(whole)}${partial}${BAR_EMPTY.repeat(Math.max(0, empty))}`,
    pressureStyle(tokens, window),
  )
}

/**
 * The status line under the composer.
 * @param state - a getter for the current values, read at render time.
 * @returns the slot view.
 */
export function createStatusView(state: () => StatusState): TuiSlotView {
  return {
    render(columns, rows = Number.POSITIVE_INFINITY) {
      // The status line's facts are the last thing surrendered, but a row is
      // still a row: when the composition has spent the whole terminal above
      // this view, drawing anyway is what pushed the region past the screen on
      // a short terminal, where the first rows scroll off unreachable.
      if (rows <= 0) return []
      // The old `Math.max(10, ...)` floor gave this line a presentation-only
      // minimum independent of the terminal, so a terminal narrower than 12
      // columns got a budget wider than itself and the two-column indent
      // pushed the drawn row past the real width. `columns - 2` alone is safe
      // at every width down to zero: it is never larger than `columns`, and it
      // matches the old floor exactly once `columns - 2` reaches 10 on its
      // own, so nothing above that width changes.
      const budget = Math.max(0, columns - 2)
      if (budget <= 0) return []
      const current = state()
      const separator = paint(' · ', 'chrome')

      // Facts first, in the order they matter. These are never dropped: a status
      // line that hid whether a turn was running would be worse than a short one.
      const facts: string[] = []
      let bareStatus: string
      if (current.busy) {
        const spinner = paint(spinnerFrame(current.tick), 'busy')
        const activityWord = paint(current.activityWord, 'busy')
        bareStatus = `${spinner}  ${activityWord}`
        const elapsed = current.elapsedMs === undefined
          ? ''
          : paint(` · turn ${formatElapsed(current.elapsedMs)}`, 'subdued')
        facts.push(`${bareStatus}${elapsed}`)
      } else if (current.compacting === true) {
        // Compaction is a model-free maintenance call, so it must not enter the
        // busy branch: ctrl-c still quits an idle agent with no owned work. It
        // does need a visible state, though, because a summarizer can take longer
        // than a local command and the durable start event is intentionally
        // transcript-silent.
        bareStatus = `${paint(spinnerFrame(current.tick), 'busy')}  ${paint('compacting', 'busy')}`
        facts.push(bareStatus)
      } else if (current.replay !== undefined) {
        // A resumed session's transcript is still flooding in: `ready` would be
        // a claim the reader has no history to check yet. The replay fact is the
        // honest reading while the synchronous projection runs.
        bareStatus = paint(`· ${current.replay}`, 'muted')
        facts.push(bareStatus)
      } else {
        bareStatus = `${paint('●', 'ready')}${paint(' ready', 'subdued')}`
        facts.push(bareStatus)
      }
      // Held apart from the other facts because these are the ones that can be
      // dropped. The effort rides WITH the model rather than beside it: it
      // qualifies that name, and a level left on screen after the model it
      // applied to was dropped would read as belonging to whatever came next.
      // What a turn is DOING, beside how long it has been doing it. A fourteen
      // minute `reading` with nothing beside it reads the same whether the read
      // is still outstanding or the session has hung. First of the droppable
      // facts, because it is a convenience reading like `todo` and `work` — it
      // says nothing the transcript above will not eventually say.
      //
      // Its own segment rather than part of the timer, because the elapsed time
      // is the TURN's and not this call's: the harness publishes no per-call
      // duration, and `reading 14m 26s run_shell_command` would claim one. `+2
      // calls` counts the other calls running in parallel — naming one of six
      // would be a smaller number of tools, not a shorter way of saying six.
      const activity = current.busy && current.activity !== undefined
        ? paint(
          `${escapeControls(current.activity.title)}${current.activity.others > 0 ? ` +${String(current.activity.others)} ${current.activity.others === 1 ? 'call' : 'calls'}` : ''}`,
          'subdued',
        )
        : undefined
      // A transient emphasis for a change that matters, painted in the `warning`
      // role because its meaning is "needs attention, not a failure" — how that
      // looks is the palette's decision. It replaces the activity title while it
      // stands rather than joining it, so the line still reads as one account of
      // what is happening.
      const attention = current.attention === undefined
        ? undefined
        : paint(escapeControls(current.attention.text), 'warning')
      // Model, effort, and the route are one painted segment, so the body ladder
      // drops them together. Provider and model ids originate upstream, so they
      // are neutralized before they are styled: escaping after `paint` would
      // destroy the colour, and escaping only one half would let a control
      // through in the other.
      const identity = current.model === undefined
        ? undefined
        : current.effort === undefined ? current.model : `${current.model} (${current.effort})`
      const model = identity === undefined ? undefined : paint(escapeControls(identity), 'subdued')
      // The effective permission is a state fact, not a convenience reading: it
      // gates what a turn may DO. It is still one opaque id, escaped because it
      // originates upstream and painted in the subdued role because dshline
      // infers no risk from an arbitrary deployment-defined id. Mapping it
      // through the catalog would make the footer a second selection authority
      // and would have to invent a label for `custom`.
      const permission = current.permission === undefined
        ? undefined
        : paint(escapeControls(current.permission), 'subdued')
      const usage = current.usage === undefined ? undefined : paint(current.usage, 'subdued')
      // A convenience reading, and the first segment the body gives up: how much
      // of the prompt came from cache is not something anyone needs at a width
      // where the facts are already competing. It sits beside the totals because
      // both are usage, NOT because it is a share of them — the two are folded
      // from different scopes, and it is a cache reading rather than a price.
      // Whole or absent, like every other segment here.
      const cached = current.cacheRead === undefined ? undefined : paint(current.cacheRead, 'subdued')
      let reading: string | undefined
      let readingWithBar: string | undefined
      if (current.tokens !== undefined) {
        const window = current.contextWindow === undefined ? '' : `/${formatTokens(current.contextWindow)}`
        reading = paint(
          `${formatTokens(current.tokens)}${window}`,
          pressureStyle(current.tokens, current.contextWindow),
        )
        const bar = pressureBar(current.tokens, current.contextWindow)
        readingWithBar = bar === undefined ? reading : `${bar} ${reading}`
      }
      // Only the non-default levels are reported: naming the default on every frame
      // spends a column on a fact the user did not ask about.
      const detail = current.detail === 'compact' ? undefined : paint(`tools ${current.detail}`, 'mode-alert')
      // Todo and Work are convenience readings, not new status rows. Their
      // whole segments yield to one another and then to state that changes a turn.
      const todo = current.todo === undefined ? undefined : paint(current.todo, 'mode')
      const work = current.work === undefined ? undefined : paint(current.work, 'mode')
      // Pending user input is the reader's own words parked in Harness's inbox:
      // submitted, accepted by the agent, and not yet taken — exactly the stretch
      // where pressing enter otherwise shows nothing at all, which read as broken
      // input until this said otherwise. A convenience reading like todo and work,
      // but the freshest fact on the line: it exists because of what the reader
      // just did.
      //
      // One segment, three words, because the two lists mean different things and
      // the reader now picks between them. `queued` is work waiting for a turn of
      // its own; `steering` is waiting for the turn already running. A mixture is
      // `pending`, not a sum of two labels: naming both would spend two segments
      // on transient input, and the shedding ladder would then have to rank one
      // above the other — while `2 pending` is exactly as true and stays one
      // indivisible segment, which is the rule everything else on this line
      // follows.
      const pending = current.pending
      const parked = pending === undefined ? 0 : pending.queued + pending.steering
      const pendingWord = pending === undefined || parked < 1
        ? undefined
        : pending.steering === 0 ? 'queued' : pending.queued === 0 ? 'steering' : 'pending'
      const queued = pendingWord === undefined
        ? undefined
        : paint(`${String(parked)} ${pendingWord}`, 'mode')
      // Modes, by the same rule — present only when they are not the ordinary
      // state. Both change what a turn DOES rather than what it says, so neither
      // is given up for width: a session quietly refusing to edit files, or
      // quietly about to take another round on its own, is the case a status line
      // exists to prevent. A goal that will continue by itself is coloured like
      // the working spinner, because that is what it is.
      const plan = current.plan ? paint('plan', 'mode') : undefined
      const goalStyle = (text: string): string =>
        paint(text, current.goal?.running === true ? 'mode-alert' : 'subdued')
      // Goal state is one indivisible mode segment. The objective belongs to the
      // explicit `/goal` surface, so the footer has no alternate goal reading.
      const goal = current.goal === undefined ? undefined : goalStyle(current.goal.label)

      // Hints are dropped WHOLE when the width runs out. Truncating the joined line
      // instead cut one in half — `ctrl-d qui` — which reads as a rendering fault
      // rather than as a hint. `/model` is absent because a slash command announces
      // itself the moment one is typed.
      // Interrupting is the urgent busy action, and quitting is global. Tool-output
      // inspection remains available through its key, but is not a footer action:
      // the status line should reserve its hints for controlling the session.
      const hints = current.busy
        ? ['ctrl-c stop', 'ctrl-d quit']
        : ['alt-enter newline', 'ctrl-d quit']
      // Seven lines, richest first, and the first that fits wins. Each step gives up
      // something the one above it keeps, in order of how little it costs:
      //
      // The CACHE-READ SHARE goes first. It is the only segment here that says
      // nothing about whether the session is working or what it has spent — how
      // much of the prompt was served from cache is interesting, not needed —
      // and it is given up before the picture of the reading for the same
      // reason the picture is given up before the reading itself.
      //
      // The BAR goes next. It is a picture of the numbers printed beside it, so it
      // is the only thing here whose loss costs no information at all.
      //
      // The MODEL NAME goes next, carrying the reasoning level with it. It is the
      // longest fact and the least urgent: it does not change during a session,
      // where the pressure reading does.
      //
      // The SESSION TOTAL goes after that, by the same argument. It accounts
      // for what has already been spent, while the reading governs whether the
      // session still works — so of the two, the reading is the one you cannot be
      // without.
      //
      // The PERMISSION is the last body fact surrendered, after the totals. It
      // gates what a turn may DO, so it outlives the model name and the session
      // total, but it is still a body fact: at a width where even it cannot fit,
      // the context-pressure reading and the base status are the irreducible
      // line.
      //
      // The reading itself is never given up, and neither is whether a turn is
      // running. Dropping whole parts rather than truncating the joined line is the
      // same rule the hints follow — a reading cut to `14k/1.0` reads as a rendering
      // fault, not as a number.
      const status = facts[0] ?? ''
      const noticed = attention === undefined ? [] : [attention]
      const doing = attention !== undefined || activity === undefined ? [] : [activity]
      const named = model === undefined ? [] : [model]
      const permitted = permission === undefined ? [] : [permission]
      const spent = usage === undefined ? [] : [usage]
      const cacheShare = cached === undefined ? [] : [cached]
      const bar = readingWithBar === undefined ? [] : [readingWithBar]
      const plain = reading === undefined ? [] : [reading]
      const planned = plan === undefined ? [] : [plan]
      const goalled = goal === undefined ? [] : [goal]
      const tooled = detail === undefined ? [] : [detail]
      const todoed = todo === undefined ? [] : [todo]
      const worked = work === undefined ? [] : [work]
      const queuedTail = queued === undefined ? [] : [queued]
      // Modes are given up only after everything else has been, and in an order
      // of their own. `tools` goes first: it is a display preference. Then Todo,
      // then Work: observations that change no turn. The pending count surrenders
      // after them — still an observation, but the one that answers what the
      // reader's latest keystroke did, so it outlives the older readings beside
      // it. Plan mode goes after that. A running GOAL is the last thing standing,
      // because it is the only state here that will act on its own while nobody
      // is typing.
      //
      // They are held back this hard because a mode cut in half is the failure
      // this whole line is arranged to avoid: `goal 12/25` is not a smaller truth
      // than `goal 12/256`, it is a different one.
      //
      // The attention notice rides THIS ladder rather than the body ladder,
      // between Work and pending input: a four-second emphasis must never evict
      // the reader's parked words, plan mode, or a goal, but it does outlast the
      // work, Todo, and tool-detail conveniences it outranks. Each rung says
      // whether the notice survives it, and the first rung that fits wins. The
      // notice is still RENDERED just after the base status, so its display
      // position does not follow where the ladder surrenders it.
      const rungs: readonly { readonly attention: boolean; readonly modes: readonly string[] }[] = [
        { attention: true, modes: [...planned, ...goalled, ...queuedTail, ...worked, ...todoed, ...tooled] },
        { attention: true, modes: [...planned, ...goalled, ...queuedTail, ...worked, ...todoed] },
        { attention: true, modes: [...planned, ...goalled, ...queuedTail, ...worked] },
        { attention: true, modes: [...planned, ...goalled, ...queuedTail] },
        { attention: false, modes: [...planned, ...goalled, ...queuedTail] },
        { attention: false, modes: [...planned, ...goalled] },
        { attention: false, modes: [...goalled] },
        { attention: false, modes: [] },
      ]
      // The body ladder carries the droppable facts, and the permission is one
      // of them; the notice is not, so it is surrendered by the rung above
      // instead.
      const bodies = [
        [status, ...doing, ...named, ...permitted, ...spent, ...cacheShare, ...bar],
        [status, ...doing, ...named, ...permitted, ...spent, ...bar],
        [status, ...named, ...permitted, ...spent, ...bar],
        [status, ...named, ...permitted, ...spent, ...plain],
        [status, ...permitted, ...spent, ...plain],
        [status, ...permitted, ...plain],
        [status, ...plain],
      ]

      // Room for one hint is held back from the rung choice, so a richer reading
      // can never be the reason the last hint disappears. The hints are the only
      // place this interface says how to leave it or how to start a new line, and
      // a status line at eighty columns — the width most terminals open at — had
      // exactly enough space for the reading, the model, the totals, and no help
      // at all. A segment is droppable; the way out is not.
      const reserve = hints[0] === undefined ? 0 : displayWidth(separator) + displayWidth(hints[0])
      /**
       * The richest line that fits, giving things up in the order they may be lost.
       *
       * Three nested preferences, outermost strongest. The operating MODES and
       * the notice are surrendered last — the notice before the modes — and the
       * hint reservation is spent inside each level rather than across all of
       * them: reserving room for help at the cost of hiding a running goal would
       * be the reservation outranking the thing it was introduced to sit beside.
       * @returns the joined line, or the barest one when nothing fits.
       */
      const compose = (): string => {
        for (const rung of rungs) {
          for (const spare of [reserve, 0]) {
            for (const body of bodies) {
              // Rendered order is fixed — base status, the notice in the
              // activity position, the body conveniences, then the modes — while
              // the rung decides which of those survive.
              const joined = [
                status,
                ...(rung.attention ? noticed : []),
                ...body.slice(1),
                ...rung.modes,
              ].join(separator)
              if (displayWidth(joined) + spare <= budget) return joined
            }
          }
        }
        // Narrower than every (body, modes) rung. Whole facts yield before the
        // activity word is ever cut: the turn elapsed goes first, then the
        // context reading, and only the bare word survives to be truncated.
        // The full status was already tried above and cannot fit, so the first
        // candidate below is the elapsed-less form, not the richest one.
        if (current.busy || current.compacting === true) {
          // `bareStatus` is one styled segment, not a list of characters:
          // spreading it would interleave separators between every ANSI byte
          // and make the middle rung absurdly wide, skipping straight to the
          // bare word and losing the context reading.
          const withoutElapsed = [bareStatus, ...plain].join(separator)
          if (displayWidth(withoutElapsed) <= budget) return withoutElapsed
          return bareStatus
        }
        // Idle and narrower than every rung. The notice is not carried by any
        // body, so it is already gone, and the modes are surrendered for it:
        // only the context reading and the base status remain. The READING is
        // dropped WHOLE here when even that pair cannot fit, rather than cut to
        // `68k/1.0` — a different number that reads as a rendering fault. The
        // busy branch above already gives the reading up before the bare status
        // and truncates only that; idle has to agree with it instead of
        // truncating the pair.
        return status
      }
      let line = compose()
      for (const hint of hints) {
        const extended = `${line}${separator}${paint(hint, 'muted')}`
        if (displayWidth(extended) > budget) break
        line = extended
      }
      return [`  ${truncateToWidth(line, budget)}`]
    },
  }
}

/**
 * The opening banner, committed once above the live region rather than
 * registered as a slot: it belongs to scrollback, not to the redrawn area.
 * @param workspace - the session workspace.
 * @param model - provider route and model id, when a selection exists.
 * @param version - this bundle's version.
 * @param columns - the terminal's current width.
 * @returns lines to commit.
 */
export function bannerLines(
  workspace: string,
  model: string | undefined,
  version: string,
  columns: number,
): string[] {
  const rows = [
    `${paint('dshline', 'banner')} ${paint(version, 'muted')}`,
    // The workspace is the persisted session header's cwd and the model is a
    // provider route id, so both are untrusted by the same rule as tool output.
    // Escaped BEFORE styling: a cwd carrying an escape sequence would otherwise
    // repaint the frame from inside it, and escaping after `paint` would
    // destroy the colour. The composer's own workspace label is escaped for the
    // same reason; this was the one banner path that was not.
    paint(escapeControls(workspace), 'subdued'),
    paint(escapeControls(model ?? 'no model configured'), 'subdued'),
  ]
  return [...box(rows, { width: chromeWidth(columns), border: text => paint(text, 'chrome') }), '']
}

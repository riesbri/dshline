/**
 * The bounded-surface kernel: the terminal mechanics every live-region
 * inspector shares, kept apart from the capability it presents.
 *
 * An overlay owns feature state — what it is looking at, what a key means — and
 * this module owns what makes that fit a terminal: the fixed chrome rows, the
 * content width and capacity, the physical-row check against Screen's wrapping,
 * the one-row backstop for a terminal too small to frame, an owned temporary
 * notice, and the close handshake with `TuiSlots`.
 *
 * Before this module each of the seventeen bounded surfaces re-derived all of
 * it, so a frame-geometry change had to be made in seventeen files and the
 * notice lifetime had drifted to four values with no owner. Nothing here knows
 * a domain: a surface reads a value and returns rows.
 *
 * This is internal presentation vocabulary, not a plugin SDK. It is deliberately
 * not exported from the package entry, and a surface whose layout is not one of
 * the shapes here stays free to keep its own `render` and use the helpers.
 * @module dshline/surface
 */

import type { Key, Role } from '@dshline/renderer'
import {
  BOX_CHROME_COLUMNS,
  displayWidth,
  escapeControls,
  paint,
  truncateToWidth,
  wrapToWidth,
} from '@dshline/renderer'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from './chrome.ts'
import type { TuiOverlay } from './slots.ts'

/** Rows outside a framed body: the leading blank and the two frame borders. */
export const SURFACE_FIXED_ROWS = 3

/** Narrowest terminal whose framed surface keeps one physical row per fact. */
export const SURFACE_MIN_COLUMNS = BOX_CHROME_COLUMNS + 10

/** The one role a geometry backstop is allowed to use, shared so it stays one decision. */
const COMPACT_ROLE: Role = 'overlay-headline'

/**
 * Count the physical rows `Screen` draws for candidate logical lines.
 *
 * A logical row wider than the terminal is wrapped into several physical rows,
 * and the live region must never exceed the screen — a row scrolled off cannot
 * be climbed back to and erased. Every surface that budgets against height needs
 * this same count, which is why it lives here rather than once per surface.
 * @param lines - candidate logical lines.
 * @param columns - the terminal's width.
 * @returns one entry per physical row.
 */
export function physicalRows(lines: readonly string[], columns: number): string[] {
  return lines.flatMap(line => wrapToWidth(line, Math.max(1, columns)))
}

/**
 * The one-row backstop for a terminal too small to frame.
 *
 * Every candidate is a WHOLE truthful phrase. A cut phrase says something the
 * reader cannot act on — `esc cl` names neither the state nor the way out — so
 * the ladder tries the most specific summary first and falls back to the bare
 * escape. An empty result is the honest answer when not even `esc` fits.
 * @param phrases - summary phrases, most specific first; one phrase is common.
 * @param columns - the terminal's width.
 * @returns at most one painted row.
 */
export function compactRows(phrases: string | readonly string[], columns: number): string[] {
  const ordered = typeof phrases === 'string' ? [phrases] : phrases
  // Phrases are plain text from a presenter: the kernel escapes them before
  // measuring and before styling, so an embedded control cannot add a row or
  // operate the terminal, and the fit is measured against what is displayed.
  const visible = [
    ...ordered.map(phrase => `${phrase} · esc close`),
    'esc close',
    'esc',
  ].map(escapeControls).find(candidate => displayWidth(candidate) <= columns)
  return visible === undefined ? [] : [paint(visible, COMPACT_ROLE)]
}

/** One active temporary outcome. */
export interface SurfaceNoticeReading {
  /** Untrusted message text; escaped when drawn. */
  readonly text: string
  /** Whether the outcome failed, which colours it and lets it win the geometry fallback. */
  readonly failed: boolean
}

/**
 * Draw one notice reading as a bounded row.
 *
 * Escaping happens before styling: a message can quote a path or a provider
 * error, so it is untrusted text that must not add rows or operate the terminal.
 * @param reading - the active reading, or undefined when there is none.
 * @param columns - display columns available.
 * @returns the painted row, or undefined while no notice is active or when the
 *   terminal has no columns to put it in.
 */
export function noticeRow(reading: SurfaceNoticeReading | undefined, columns: number): string | undefined {
  // A zero-column frame has nowhere to put a row: `truncateToWidth` would be
  // asked to invent a column, and even an empty painted string emits an escape.
  // Return nothing rather than a row the terminal cannot show.
  if (reading === undefined || columns <= 0) return undefined
  return paint(
    truncateToWidth(escapeControls(reading.text), columns),
    reading.failed ? 'error' : 'busy',
  )
}

/**
 * A temporary outcome owned by exactly one surface.
 *
 * The lifetime is the surface's own choice rather than a shared constant: a
 * refused compaction and a discovery failure are not the same event, and the
 * copies of `NOTICE_MS` this replaced had already drifted to four values.
 *
 * Expiration is LAZY: an expired notice is retired by the next
 * {@link SurfaceNotice.read}, so clearing one costs no timer. This type
 * therefore does not schedule a redraw, and a surface that shows a notice owns
 * invalidation: it redraws when {@link SurfaceNotice.show} is called and keeps
 * redrawing until {@link SurfaceNotice.read} returns undefined, or the notice
 * simply stays on screen until the next unrelated paint. Context does both
 * through the ticker it already had; no second consumer needs timing today, so
 * no scheduler lives here.
 */
export class SurfaceNotice {
  private state: { reading: SurfaceNoticeReading; expiresAt: number } | undefined

  /**
   * @param lifetimeMs - how long a shown notice stays readable.
   */
  constructor(private readonly lifetimeMs: number) {}

  /**
   * Replace any current notice with a new one, restarting its lifetime.
   * @param text - untrusted message text.
   * @param failed - whether the outcome failed.
   */
  show(text: string, failed = false): void {
    this.state = { reading: { text, failed }, expiresAt: Date.now() + this.lifetimeMs }
  }

  /**
   * Read the active notice, retiring it once its lifetime has passed.
   * @param now - current wall-clock instant; injectable for tests.
   * @returns the active reading, or undefined once retired.
   */
  read(now = Date.now()): SurfaceNoticeReading | undefined {
    if (this.state !== undefined && now >= this.state.expiresAt) this.state = undefined
    return this.state?.reading
  }

  /**
   * One bounded row for the active notice.
   * @param columns - display columns available.
   * @returns the painted row, or undefined while no notice is active.
   */
  row(columns: number): string | undefined {
    return noticeRow(this.read(), columns)
  }
}

/** Inputs one framed bounded surface needs from its presenter. */
export interface BoundedSurfaceSpec<S> {
  /** The presenter's own state, read fresh on every paint. */
  readonly reading: () => S
  /** Right-hand frame label for the current reading. */
  readonly title: (reading: S) => string
  /**
   * Body rows for a reading.
   * @param reading - current state.
   * @param width - display columns inside the frame.
   * @param capacity - body rows the current geometry can show, excluding the
   *   frame's fixed rows and an active notice.
   */
  readonly body: (reading: S, width: number, capacity: number) => readonly string[]
  /** Whole-phrase backstop summaries, most specific first. */
  readonly compact: (reading: S) => string | readonly string[]
  /** Footer help; defaults to `esc close`. */
  readonly footer?: (reading: S) => string
  /**
   * Optional temporary outcome, given its own reserved row while active.
   *
   * The surface redraws only when its owner asks; see {@link SurfaceNotice} for
   * who owns invalidation around expiry.
   */
  readonly notice?: SurfaceNotice
  /**
   * Feature keys, after the shared close handling. The surface owns the
   * keyboard while it is mounted, so a key it does not close on is delivered
   * here whether or not the presenter acts on it.
   * @param key - the decoded keystroke.
   * @param reading - the current reading.
   */
  readonly onKey?: (key: Key, reading: S) => void
  /** Remove this temporary surface. */
  readonly close: () => void
  /** Release presenter-owned resources such as a heartbeat. */
  readonly dispose?: () => void
  /** Rows outside the body; defaults to {@link SURFACE_FIXED_ROWS}. */
  readonly fixedRows?: number
  /** Minimum terminal width; defaults to {@link SURFACE_MIN_COLUMNS}. */
  readonly minColumns?: number
}

/**
 * Frame one bounded body, or report that it does not fit.
 *
 * The frame wraps whatever it is given, so the physical candidate — not the
 * logical row count — decides. A body that does not fit returns `undefined` and
 * the caller substitutes its geometry backstop rather than leaking a row into
 * scrollback.
 *
 * The title and footer are PLAIN, untrusted text and the kernel escapes them
 * before `paint`; passing already-styled text here would lose its colour. Body
 * rows are the presenter's own terminal rows and must already be safe.
 * @param options - terminal geometry, frame title, body rows, and optional footer.
 * @returns the framed rows, or undefined when they do not fit.
 */
export function frameBounded(options: {
  readonly columns: number
  readonly rows: number
  readonly title: string
  readonly body: readonly string[]
  readonly footer?: string
}): string[] | undefined {
  const candidate = [
    '',
    ...rootFrame({
      columns: options.columns,
      context: paint(escapeControls(options.title), 'overlay-title'),
      body: options.body,
      footer: fitFooterHelp(escapeControls(options.footer ?? 'esc close'), footerBudget(options.columns)),
    }),
  ]
  return physicalRows(candidate, options.columns).length <= options.rows ? candidate : undefined
}

/**
 * Create one framed bounded surface over a presenter's reading.
 *
 * The surface owns the close guard, the geometry, the shared escape keys, and
 * the notice row; the presenter owns what the rows say and what its own keys
 * mean. Escape and ctrl-c always close, and nothing else quits.
 * @param spec - the presenter's reading, rows, keys, and close control.
 * @returns a live-region overlay that never writes the transcript.
 */
export function createBoundedSurface<S>(spec: BoundedSurfaceSpec<S>): TuiOverlay {
  const fixedRows = spec.fixedRows ?? SURFACE_FIXED_ROWS
  const minColumns = spec.minColumns ?? SURFACE_MIN_COLUMNS
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    spec.close()
  }
  const overlay: TuiOverlay = {
    render(columns, terminalRows = 24) {
      const reading = spec.reading()
      const activeNotice = spec.notice?.read()
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      // Bound the notice to the frame's inner width, not the terminal's: a
      // notice that wraps would spend a second row the capacity below has not
      // budgeted, and the frame would fall back instead of showing it.
      const boundedNotice = noticeRow(activeNotice, inner)
      const capacity = terminalRows - fixedRows - (boundedNotice === undefined ? 0 : 1)
      const fallback = (): string[] => {
        // A zero-row or zero-column live region must draw nothing at all: even
        // the `esc` backstop would be a row the caller cannot show.
        if (terminalRows <= 0 || columns <= 0) return []
        // The backstop is bounded by the TERMINAL, not by the frame's inner
        // width: on a terminal too narrow to frame, a failed notice still wins
        // over the summary, but only within the columns that exist.
        const failed = activeNotice?.failed === true ? noticeRow(activeNotice, columns) : undefined
        return failed === undefined ? compactRows(spec.compact(reading), columns) : [failed]
      }
      if (terminalRows <= fixedRows || columns < minColumns || capacity <= 0) return fallback()
      return frameBounded({
        columns,
        rows: terminalRows,
        title: spec.title(reading),
        body: [
          ...boundedNotice === undefined ? [] : [boundedNotice],
          ...spec.body(reading, inner, capacity),
        ],
        ...spec.footer === undefined ? {} : { footer: spec.footer(reading) },
      }) ?? fallback()
    },
    handleKey(key: Key) {
      if (closed) return
      if (key.kind === 'key' && (key.name === 'escape' || key.name === 'ctrl-c')) {
        close()
        return
      }
      // Read only when a presenter actually wants the key: a reading can build
      // rows, and a surface with no feature keys should not pay for one.
      if (spec.onKey !== undefined) spec.onKey(key, spec.reading())
    },
  }
  if (spec.dispose !== undefined) overlay.dispose = spec.dispose
  return overlay
}

/**
 * Open one overlay and return its dismisser.
 *
 * A surface closes itself by calling the callback it was handed, but the
 * dismisser only exists after `pushOverlay` returns, and `TuiSlots` calls the
 * overlay's `mounted()` before that. A close requested from `create` or from
 * `mounted()` therefore arrives before there is anything to call, so it is
 * remembered and applied the moment mounting returns. Closing is idempotent:
 * the first request removes the overlay once, and later ones are no-ops.
 * @param slots - the live-region registry that owns the overlay stack.
 * @param create - builds the overlay, given the callback that closes it.
 * @returns a function that removes the overlay; safe to call more than once.
 */
export function openSurface(
  slots: { pushOverlay(overlay: TuiOverlay): () => void },
  create: (close: () => void) => TuiOverlay,
): () => void {
  let disposer: (() => void) | undefined
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    disposer?.()
  }
  const overlay = create(close)
  const remove = slots.pushOverlay(overlay)
  // A close that arrived before this point already set `closed`, so the overlay
  // must come down now instead of being remembered as the disposer.
  if (closed) remove()
  else disposer = remove
  return close
}

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
  // Line breaks are collapsed too: {@link escapeControls} preserves a feed for
  // multi-line layout text, but this backstop is contracted to ONE physical
  // row, and a phrase carrying `\n` would wrap into rows the caller never
  // budgeted.
  const visible = [
    ...ordered.map(phrase => `${phrase} · esc close`),
    'esc close',
    'esc',
  ].map(noticeText).find(candidate => displayWidth(candidate) <= columns)
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
 * Make one untrusted notice message safe to draw in a single physical row.
 *
 * `escapeControls` neutralizes terminal controls but deliberately preserves a
 * line feed, because multi-line layout text is legitimate. A notice is
 * contracted to ONE row, so a message carrying a newline would become physical
 * rows the live region never budgeted: `Screen` wraps them after the budget is
 * fixed, and a region taller than the screen leaves rows in scrollback that can
 * never be erased. Collapsing the breaks before styling keeps the one-row
 * promise without weakening the control-safety the escaping provides.
 * @param text - untrusted message text.
 * @returns escaped text with no line breaks.
 */
export function noticeText(text: string): string {
  return escapeControls(text).replaceAll('\n', ' ')
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
    truncateToWidth(noticeText(reading.text), columns),
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
 * {@link SurfaceNotice.read} retires an expired notice, but that is now backed
 * by one unref'd timer per notice: a notice with a declared lifetime asks its
 * owner for a repaint the moment the lifetime ends. Before this, an idle
 * terminal kept an expired notice on screen until some unrelated paint — a tool
 * result, a spinner beat — happened to arrive, which is exactly when a notice
 * is least useful.
 *
 * The timer is an INVALIDATION mechanism only. It never touches the notice:
 * {@link SurfaceNotice.read} is still the sole state authority, so the deadline
 * stays the only truth and the next render derives it. Showing again cancels
 * the prior deadline, so two timers are never live, and an older callback that
 * somehow fires after a replacement cannot clear the newer notice because it
 * asks for a repaint and nothing more — `read` grades whatever deadline is
 * current when that repaint runs.
 */
export class SurfaceNotice {
  private state: { reading: SurfaceNoticeReading; expiresAt: number } | undefined
  private timer: NodeJS.Timeout | undefined
  private disposed = false

  /**
   * @param lifetimeMs - how long a shown notice stays readable.
   * @param options - the clock that grades the deadline, and the repaint request
   *   the expiry makes. A surface with an injected clock passes it so the timer
   *   and the deadline share one timeline; tests may construct with neither.
   */
  constructor(
    private readonly lifetimeMs: number,
    private readonly options: {
      readonly now?: () => number
      readonly invalidate?: () => void
    } = {},
  ) {}

  /**
   * Replace any current notice with a new one, restarting its lifetime.
   * @param text - untrusted message text.
   * @param failed - whether the outcome failed.
   */
  show(text: string, failed = false): void {
    // A late `show` from an in-flight action must not resurrect a surface the
    // reader already closed.
    if (this.disposed) return
    this.cancel()
    this.state = { reading: { text, failed }, expiresAt: this.now() + this.lifetimeMs }
    this.arm()
  }

  /**
   * Read the active notice, retiring it once its lifetime has passed.
   * @param now - current wall-clock instant; defaults to the injected clock.
   * @returns the active reading, or undefined once retired.
   */
  read(now = this.now()): SurfaceNoticeReading | undefined {
    if (this.state !== undefined && now >= this.state.expiresAt) {
      this.state = undefined
      this.cancel()
    }
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

  /**
   * Cancel the pending expiry and forget the notice. Idempotent, and a later
   * {@link SurfaceNotice.show} is refused.
   */
  dispose(): void {
    this.cancel()
    this.state = undefined
    this.disposed = true
  }

  /** The clock this notice's deadline is graded on. */
  private now(): number {
    // A lambda, not a captured `Date.now`: fake timers replace the global after
    // construction, and a captured function would keep the real clock.
    return this.options.now?.() ?? Date.now()
  }

  /**
   * Arm the one expiry timer for the current notice.
   *
   * Called after every `show`, so a replacement never leaves two deadlines
   * live. The callback only invalidates — it never retires the notice and never
   * touches its state. A Node timer can fire a hair before the deadline it was
   * measured against, and a caller-injected clock can lag Node's; repainting
   * then would render a notice `read` still calls current, and with no timer
   * left there would be no second chance — the stale row this mechanism exists
   * to clear. So the callback waits out the true remainder instead. That is a
   * one-shot retry at the deadline, not a poll: each wait is the exact
   * remaining time, which shrinks to zero as the clock advances.
   */
  private arm(): void {
    if (this.disposed || this.state === undefined) return
    const invalidate = this.options.invalidate
    // No repaint request, no timer: a notice constructed for a test or for a
    // renderer that reads it directly schedules nothing.
    if (invalidate === undefined) return
    const remaining = Math.max(0, this.state.expiresAt - this.now())
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.disposed || this.state === undefined) return
      if (this.now() < this.state.expiresAt) {
        this.arm()
        return
      }
      invalidate()
    }, remaining)
    // A countdown must not keep the process alive on its own; the optional call
    // covers timer implementations without Node's `unref`.
    this.timer.unref?.()
  }

  /** Cancel the pending expiry, if any. */
  private cancel(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
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
   * The presenter constructs it with the repaint request {@link SurfaceNotice}
   * makes when the lifetime ends, and disposes it when the surface comes down.
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

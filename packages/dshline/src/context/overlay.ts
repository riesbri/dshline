/**
 * Bounded live-region inspector for the model's current context.
 *
 * Two stages of one frame, like Work: the overview answers "how full is it,
 * and what is it made of", and an entry answers "what is this thing, and why
 * is it big". Nothing is committed — the transcript underneath stays in the
 * terminal's own scrollback and is never rewritten.
 *
 * Every figure on screen is labelled with the precision its authority claims.
 * Occupancy is upstream's `projectedTokens` — what the next request's prompt
 * would cost — and is labelled `projected`, once, rather than switching a `~`
 * on and off from an equality that cannot prove what it appeared to prove.
 * Composition and per-entry prices are the meter's fixed estimator throughout
 * and are marked `~` always. The two vocabularies are never divided into one
 * another: composition shares divide the composition total, and entry shares
 * divide the measured MESSAGE surface — which is what their labels say.
 * @module dshline/context/overlay
 */

import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Key, Role } from '@dshline/renderer'
import {
  BOX_CHROME_COLUMNS,
  displayWidth,
  escapeControls,
  formatTokens,
  paint,
  SPINNER_INTERVAL_MS,
  spinnerFrame,
  truncateToWidth,
  wrapToWidth,
} from '@dshline/renderer'
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from '../chrome.ts'
import { FocusRing } from '../focus.ts'
import { RowViewport } from '../scroll.ts'
import type { TuiOverlay } from '../slots.ts'
import { pressureBar, pressureStyle } from '../views.ts'
import type { ContextEntry, ContextPreview, ContextReading, ContextSurvey } from './model.ts'

/** Rows outside the listing: leading blank, two borders, and a trailing spacer. */
const CONTEXT_FIXED_ROWS = 4

/** Minimum width whose framed context view keeps one physical row per entry. */
const CONTEXT_MIN_COLUMNS = BOX_CHROME_COLUMNS + 10

/** Columns a row spends on its focus gutter and the space after it. */
const GUTTER_COLUMNS = 2

/** Width of the occupancy bar, in columns; wider than the status line's eight. */
const OCCUPANCY_BAR_CELLS = 32

/** Width of a composition share bar, in columns. */
const SHARE_BAR_CELLS = 12

/** Glyphs a share bar is drawn from. */
const SHARE_FULL = '━'
const SHARE_EMPTY = '─'

/** Columns reserved for an entry row's token figure, so the column lines up. */
const TOKENS_COLUMN = 7

/** Columns reserved for a share percentage. */
const SHARE_COLUMN = 4

/** Widest a fact or composition label is, so figures line up under each other. */
const LABEL_COLUMN = 9

/** How long a refused or failed action stays on screen. */
const NOTICE_MS = 3_000

/** Which stage of the inspector is on screen. */
type Stage =
  | { readonly kind: 'overview' }
  | { readonly kind: 'entry'; readonly seq: SessionSeq }

/** One rendered line, and whether a human can aim at it. */
interface Row {
  /** `row` takes a gutter and may be focused; the others are structure. */
  readonly kind: 'line' | 'blank' | 'row'
  /** Focus identity, present exactly when the row can be aimed at. */
  readonly key?: string
  /** Already-escaped, already-fitted text. */
  readonly text: string
  /** Role for the text when the row is not focused. */
  readonly role: Role
  /**
   * Whether {@link Row.text} is already styled and must be passed through.
   * The shared pressure bar arrives painted by its own role; painting it again
   * would put a reset in front of its colour.
   */
  readonly painted?: true
  /** Stage this row opens on Enter; a row without one ignores Enter. */
  readonly open?: Stage
}

/** A short outcome shown over the view without committing anything. */
interface Notice {
  readonly text: string
  readonly failed: boolean
  readonly expiresAt: number
}

/** Inputs the context inspector needs from its owner. */
export interface ContextOverlaySpec {
  /** The cheap projection reading, read fresh on every paint. */
  readonly reading: () => ContextReading
  /** The expensive per-node survey; the surveyor decides when to remeasure. */
  readonly survey: () => ContextSurvey
  /** One entry's bounded content, asked for only while that entry is open. */
  readonly preview: (seq: SessionSeq) => ContextPreview
  /** The model's context window as the selected route advertises it. */
  readonly capacity: () => number | undefined
  /**
   * Whether the running agent currently has a registered `/compact` command.
   *
   * This stays a getter rather than a snapshot: Harness can register or remove
   * scoped commands while an overlay is open, and the footer must not advertise
   * a control that no longer resolves.
   * @returns whether the command is currently available.
   */
  readonly canCompact: () => boolean
  /**
   * Run the REGISTERED Harness `/compact` command.
   *
   * dshline never registers a `/compact` of its own and never calls
   * `ctx.compaction`: this dispatches the same command a typed line does. The
   * owner returns a problem for the overlay while the command lifecycle remains
   * the durable transcript authority underneath it.
   * @returns a message when the request failed, else nothing.
   */
  readonly compact: () => Promise<string | undefined>
  /** Remove this temporary overlay. */
  readonly close: () => void
  /** Redraw after a keystroke, a spinner tick, or a settled action. */
  readonly invalidate: () => void
}

/**
 * Create the bounded context inspector.
 * @param spec - readings, the optional compaction command, and overlay controls.
 * @returns a live-region overlay that never writes the transcript.
 */
export function createContextOverlay(spec: ContextOverlaySpec): TuiOverlay {
  const viewport = new RowViewport()
  const focus = new FocusRing()
  let stage: Stage = { kind: 'overview' }
  let closed = false
  let notice: Notice | undefined
  let compacting = false
  let ticker: NodeJS.Timeout | undefined
  let tick = 0
  /** Rows of the last paint, so a keystroke resolves against what was shown. */
  let rows: readonly Row[] = []
  /** Whether the last paint was the compact fallback, which shows no cursor. */
  let fellBack = false

  const close = (): void => {
    if (closed) return
    closed = true
    spec.close()
  }
  const currentNotice = (): Notice | undefined => {
    if (notice !== undefined && Date.now() >= notice.expiresAt) notice = undefined
    return notice
  }
  const build = (width: number, retarget: boolean): readonly Row[] => {
    const survey = spec.survey()
    // An entry that left the surface — a compaction shadowed it while it was
    // open — must not keep painting a price the model no longer carries. The
    // stage leaves rather than freezing on a stale reading.
    const current = stage
    if (current.kind === 'entry' && !survey.entries.some(entry => entry.seq === current.seq)) {
      stage = { kind: 'overview' }
      viewport.first()
    }
    const built = stage.kind === 'overview' || current.kind === 'overview'
      ? overviewRows(spec.reading(), survey, spec.capacity(), width, compacting, tick)
      : entryRows(survey, spec.preview, current.seq, width)
    if (stage.kind === 'overview') {
      focus.update(built.flatMap(row => row.key === undefined ? [] : [row.key]), retarget)
    }
    rows = built
    return built
  }
  const focusedRow = (): Row | undefined => {
    const aim = focus.current
    return aim === undefined ? undefined : rows.find(row => row.key === aim)
  }
  const stopTicker = (): void => {
    if (ticker === undefined) return
    clearInterval(ticker)
    ticker = undefined
  }
  /**
   * Run the animation heartbeat only while something is actually animating.
   *
   * An inspector that is merely open has nothing moving on it, so an idle
   * interval would be a timer that exists to do nothing. This one starts when a
   * compaction does and retires itself once neither it nor a notice is left.
   */
  const startTicker = (): void => {
    // Unref'd, so a running spinner never keeps the process alive on its own.
    ticker ??= setInterval(() => {
      tick += 1
      if (!compacting && currentNotice() === undefined) {
        stopTicker()
        return
      }
      spec.invalidate()
    }, SPINNER_INTERVAL_MS).unref()
  }
  const runCompact = (): void => {
    const compact = spec.compact
    // A second press while one is in flight is ignored HERE rather than sent:
    // Harness would answer `busy` correctly, but printing a refusal for a key
    // the reader pressed twice is worse than doing nothing visible.
    if (!spec.canCompact() || compacting) return
    compacting = true
    startTicker()
    spec.invalidate()
    compact().then(problem => {
      compacting = false
      if (problem !== undefined) {
        notice = { text: problem, failed: true, expiresAt: Date.now() + NOTICE_MS }
      }
      spec.invalidate()
    }, () => {
      // The owner reports a rejection into the transcript; the overlay only has
      // to stop claiming a compaction is still running.
      compacting = false
      spec.invalidate()
    })
  }

  return {
    dispose: stopTicker,
    render(columns, terminalRows = 24) {
      const activeNotice = currentNotice()
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      const built = build(inner, true)
      const fallback = (): string[] => {
        fellBack = true
        return compactFallback(
          spec.reading(),
          spec.capacity(),
          columns,
          terminalRows,
          compacting,
          activeNotice,
        )
      }
      if (terminalRows <= CONTEXT_FIXED_ROWS || columns < CONTEXT_MIN_COLUMNS) return fallback()
      const visible = terminalRows - CONTEXT_FIXED_ROWS - (activeNotice === undefined ? 0 : 1)
      if (visible <= 0) return fallback()

      viewport.update(built.length, visible)
      if (stage.kind === 'overview') {
        const focusedAt = built.findIndex(row => row.key !== undefined && row.key === focus.current)
        if (focusedAt >= 0) {
          if (focusedAt < viewport.start) viewport.move(focusedAt - viewport.start)
          if (focusedAt >= viewport.end) viewport.move(focusedAt - viewport.end + 1)
        }
      }
      const candidate = [
        '',
        ...rootFrame({
          columns,
          context: paint(stage.kind === 'overview' ? 'Context' : 'Context entry', 'overlay-title'),
          body: [
            ...activeNotice === undefined ? [] : [paint(
              truncateToWidth(escapeControls(activeNotice.text), inner),
              activeNotice.failed ? 'error' : 'busy',
            )],
            ...built.slice(viewport.start, viewport.end).map(row => paintRow(row, focus.current)),
          ],
          footer: fitFooterHelp(help(stage, focusedRow(), spec.canCompact()), footerBudget(columns)),
        }),
      ]
      // The frame wraps whatever it is given, including state text a caller may
      // not have pre-fitted. Count the rows Screen will actually draw; a
      // too-tall candidate falls back rather than leaking one into scrollback.
      if (physicalRows(candidate, columns).length > terminalRows) return fallback()
      fellBack = false
      return candidate
    },
    handleKey(key: Key) {
      if (closed) return
      // The compact fallback shows no rows and no cursor, so no key may act on
      // an aimed row while it is up. It advertises `esc close`, and that is all
      // it does — closing outright rather than popping an invisible stage.
      if (fellBack) {
        if (key.kind === 'key' && (key.name === 'escape' || key.name === 'ctrl-c')) close()
        return
      }
      // Printable letters stay text input in the renderer's decoder. The overlay
      // owns text entry while it is mounted, so its one letter gesture is
      // recognized here rather than by adding a key name to a generic decoder.
      if (key.kind === 'text' && key.text === 'c') {
        // The footer offers compaction only from the overview. Keeping the
        // gesture there too prevents an undocumented action from firing while
        // a reader is inspecting a single entry.
        if (stage.kind === 'overview' && spec.canCompact()) runCompact()
        return
      }
      if (key.kind !== 'key') return
      // Enter resolves against the rows as they are, WITHOUT retargeting a
      // vanished aim: an entry the surface dropped must refuse rather than open
      // whatever inherited its screen position.
      build(LOGICAL_KEY_WIDTH, key.name !== 'enter')
      switch (key.name) {
        case 'up':
          if (stage.kind === 'entry') viewport.move(-1)
          else focus.move(-1)
          spec.invalidate()
          return
        case 'down':
          if (stage.kind === 'entry') viewport.move(1)
          else focus.move(1)
          spec.invalidate()
          return
        case 'enter': {
          // A focused row does not have to be actionable. Enter on a fact row is
          // a no-op rather than an invented action.
          const next = focusedRow()?.open
          if (next !== undefined) {
            stage = next
            viewport.first()
          }
          spec.invalidate()
          return
        }
        case 'home':
        case 'ctrl-a':
          if (stage.kind === 'overview') focus.first()
          viewport.first()
          spec.invalidate()
          return
        case 'end':
        case 'ctrl-e':
          if (stage.kind === 'overview') focus.last()
          viewport.last()
          spec.invalidate()
          return
        case 'escape':
        case 'ctrl-c':
          if (stage.kind === 'overview') {
            close()
            return
          }
          stage = { kind: 'overview' }
          viewport.first()
          spec.invalidate()
          return
        default:
          return
      }
    },
  }
}

/**
 * Text width used when a keystroke must resolve rows before the next paint.
 *
 * Key handling needs row IDENTITIES, never their pixels, and the terminal's
 * real width belongs to `render`. A generous logical width keeps fitting from
 * dropping a fact a narrower guess would have removed.
 */
const LOGICAL_KEY_WIDTH = 200

/**
 * Build the overview: occupancy, composition, then the largest entries.
 * @param reading - the cheap projection reading.
 * @param survey - the current per-node survey.
 * @param routeCapacity - the selected route's advertised context window.
 * @param width - display columns available inside the frame.
 * @param compacting - whether this overlay has a compaction in flight.
 * @param tick - spinner phase.
 * @returns the stage's rows, in display order.
 */
function overviewRows(
  reading: ContextReading,
  survey: ContextSurvey,
  routeCapacity: number | undefined,
  width: number,
  compacting: boolean,
  tick: number,
): readonly Row[] {
  const rows: Row[] = []
  if (compacting) {
    rows.push(line(`${spinnerFrame(tick)} compacting context…`, width, 'busy'), blank())
  }
  if (!reading.projections) {
    rows.push(line('Session projections are unavailable in this profile.', width, 'muted'))
    return rows
  }
  if (!reading.metered) {
    rows.push(line('The Harness token meter is not mounted in this profile.', width, 'muted'))
    return rows
  }
  rows.push(...occupancyRows(reading, routeCapacity, width))
  rows.push(...compositionRows(reading, width))
  rows.push(...entryListRows(survey, width))
  return rows
}

/**
 * The headline figure and its bar, or an honest absence.
 * @param reading - the cheap projection reading.
 * @param routeCapacity - the selected route's advertised context window.
 * @param width - display columns available inside the frame.
 * @returns the occupancy rows.
 */
function occupancyRows(
  reading: ContextReading,
  routeCapacity: number | undefined,
  width: number,
): Row[] {
  const occupancy = reading.occupancy
  if (occupancy === undefined) {
    return [line('No request has reported a prompt size yet.', width, 'muted'), blank()]
  }
  // The selected route's advertised window is preferred over the projection's
  // last recorded one: after `/model`, the NEXT request is what this figure is
  // about, and the projection's capacity still describes the previous route.
  const capacity = routeCapacity ?? occupancy.capacity
  const total = capacity === undefined ? '' : ` / ${formatTokens(capacity)}`
  // No capacity means no proportion. A percentage invented from an unknown
  // window would be the one figure here that nobody could check.
  const percent = capacity === undefined || capacity <= 0
    ? ''
    : ` · ${String(Math.min(100, Math.round((occupancy.tokens / capacity) * 100)))}%`
  // One word, always, instead of a mark that appears and disappears: the figure
  // is upstream's projection of the NEXT request's prompt, whether or not the
  // surface happens to have netted out to the provider's own last sample.
  const rows: Row[] = [{
    kind: 'line',
    text: truncateToWidth(
      `${formatTokens(occupancy.tokens)}${total}${percent} · projected`,
      Math.max(1, width),
    ),
    role: pressureStyle(occupancy.tokens, capacity),
  }]
  const bar = pressureBar(occupancy.tokens, capacity, Math.min(OCCUPANCY_BAR_CELLS, Math.max(1, width)))
  if (bar !== undefined) rows.push({ kind: 'line', text: bar, role: 'pressure-nominal', painted: true })
  rows.push(blank())
  return rows
}

/**
 * The estimated system/tools/messages split, as shares of their own sum.
 * @param reading - the cheap projection reading.
 * @param width - display columns available inside the frame.
 * @returns the composition rows, or none when the unit has no value.
 */
function compositionRows(reading: ContextReading, width: number): Row[] {
  const composition = reading.composition
  if (composition === undefined) return []
  const rows: Row[] = [heading('Composition · estimated')]
  if (composition.total === 0) {
    rows.push(line('  Nothing has been sent to the model yet.', width, 'muted'), blank())
    return rows
  }
  const parts: readonly { readonly label: string; readonly tokens: number }[] = [
    { label: 'system', tokens: composition.system },
    { label: 'tools', tokens: composition.tools },
    { label: 'messages', tokens: composition.messages },
  ]
  for (const part of parts) {
    const share = part.tokens / composition.total
    const label = part.label.padEnd(LABEL_COLUMN)
    const tokens = `~${formatTokens(part.tokens)}`.padStart(TOKENS_COLUMN)
    const percent = `${String(Math.round(share * 100))}%`.padStart(SHARE_COLUMN)
    rows.push(line(`  ${label} ${tokens}  ${shareBar(share)} ${percent}`, width, 'subdued'))
  }
  rows.push(blank())
  return rows
}

/**
 * The bounded largest-entry list, each row focusable and openable.
 * @param survey - the current per-node survey.
 * @param width - display columns available inside the frame.
 * @returns the heading and its entry rows.
 */
function entryListRows(survey: ContextSurvey, width: number): Row[] {
  if (!survey.available) {
    return [
      heading('Largest entries'),
      line('  Per-entry measurement is unavailable in this profile.', width, 'muted'),
    ]
  }
  if (survey.entries.length === 0) {
    return [heading('Largest entries'), line('  The model carries no conversation yet.', width, 'muted')]
  }
  const counted = `${String(survey.entries.length)} of ${String(survey.nodes)}`
  const rows: Row[] = [heading(`Largest entries · estimated · ${counted}`)]
  for (const entry of survey.entries) rows.push(entryRow(entry, width))
  return rows
}

/**
 * One entry row: its price, its share, and what it is.
 * @param entry - the resolved entry.
 * @param width - display columns available inside the frame.
 * @returns the focusable row.
 */
function entryRow(entry: ContextEntry, width: number): Row {
  const tokens = `~${formatTokens(entry.tokens)}`.padStart(TOKENS_COLUMN)
  const percent = `${String(Math.round(entry.share * 100))}%`.padStart(SHARE_COLUMN)
  return {
    kind: 'row',
    key: entryKey(entry.seq),
    text: truncateToWidth(
      `${tokens} ${percent}  ${entryTitle(entry)}`,
      Math.max(1, width - GUTTER_COLUMNS),
    ),
    role: 'subdued',
    open: { kind: 'entry', seq: entry.seq },
  }
}

/**
 * The focus identity of one entry.
 * @param seq - the entry's durable seq, which nothing else in the log shares.
 * @returns the identity key.
 */
function entryKey(seq: SessionSeq): string {
  return `entry:${String(seq)}`
}

/**
 * What kind of context one entry is, with any name it can prove.
 * @param entry - the resolved entry.
 * @returns escaped display text.
 */
function entryTitle(entry: ContextEntry): string {
  const kind = `${entryKindLabel(entry)}${replacementSuffix(entry)}`
  // The tool's REGISTERED name, paired by call id — so it is either the name
  // Harness has for that call or nothing, never a guess from a neighbour.
  if (entry.tool !== undefined) return `${kind} · ${escapeControls(entry.tool)}`
  if (entry.form !== undefined) return `${kind} · ${escapeControls(entry.form)}`
  return kind
}

/**
 * The words one entry kind reads as.
 * @param entry - the resolved entry.
 * @returns the label.
 */
function entryKindLabel(entry: ContextEntry): string {
  switch (entry.kind) {
    case 'user': return 'your message'
    case 'context': return 'injected context'
    case 'summary': return 'compaction summary'
    case 'assistant': return 'assistant reply'
    case 'tool-result': return 'tool result'
    case 'other': return 'context entry'
  }
}

/**
 * The generic replacement suffix, for a node that stood in for an earlier range.
 *
 * Says only what the surface contract guarantees: this node replaced history.
 * NOT `reduced` — the durable log does not, by itself, prove that a replacement
 * was a reduction, and only a compaction checkpoint proves who wrote one. A
 * `summary` already says both, so it needs no suffix.
 * @param entry - the resolved entry.
 * @returns the suffix, or an empty string.
 */
function replacementSuffix(entry: ContextEntry): string {
  return entry.replaced && entry.kind !== 'summary' ? ' · replaced' : ''
}

/**
 * Build one entry's detail: its facts, then a bounded preview of its content.
 * @param survey - the current per-node survey.
 * @param preview - bounded content reader for one seq.
 * @param seq - the entry being inspected.
 * @param width - display columns available inside the frame.
 * @returns the stage's rows.
 */
function entryRows(
  survey: ContextSurvey,
  preview: (seq: SessionSeq) => ContextPreview,
  seq: SessionSeq,
  width: number,
): readonly Row[] {
  const entry = survey.entries.find(candidate => candidate.seq === seq)
  if (entry === undefined) {
    return [line('This entry is no longer in the model’s context.', width, 'muted')]
  }
  const rows: Row[] = [
    fact('type', `${entryKindLabel(entry)}${replacementSuffix(entry)}`, width),
    ...entry.tool === undefined ? [] : [fact('tool', entry.tool, width)],
    ...entry.form === undefined ? [] : [fact('form', entry.form, width)],
    // Estimated, and said so in the row rather than only in a legend: this is
    // the number a reader would otherwise take for an exact token count.
    fact('context', `~${formatTokens(entry.tokens)} estimated`, width),
    // Named for the denominator it actually divides. `surfaceTokens` prices the
    // conversation only, so calling this a share of "the context" would quietly
    // fold in the system prompt and the tool schemas it never counted.
    fact('share', `${String(Math.round(entry.share * 100))}% of message context`, width),
    fact('position', `${String(entry.position)} of ${String(survey.nodes)}`, width),
    ...entry.turn === undefined ? [] : [fact(
      'turn',
      entry.step === undefined ? String(entry.turn) : `${String(entry.turn)} · step ${String(entry.step)}`,
      width,
    )],
    // Last, and named for what it is. A seq is what a session log is searched
    // by, which makes it useful and also the least readable fact here.
    fact('log entry', `seq ${String(entry.seq)}`, width),
    blank(),
  ]
  const content = preview(seq)
  if (!content.available) {
    rows.push(line('This entry carries no text content.', width, 'muted'))
    return rows
  }
  rows.push(heading('Preview'))
  // Escaped BEFORE it is wrapped and painted: model, tool, and log text must
  // not add rows, operate the terminal, or consume a row's style reset.
  for (const paragraph of escapeControls(content.text).split('\n')) {
    for (const row of wrapToWidth(paragraph, Math.max(1, width))) {
      rows.push({ kind: 'line', text: row, role: 'subdued' })
    }
  }
  if (content.truncated) rows.push(line('… preview truncated', width, 'muted'))
  return rows
}

/**
 * A proportional bar for one composition share, unpainted.
 * @param share - the share, 0 to 1.
 * @returns the bar glyphs.
 */
function shareBar(share: number): string {
  const filled = Math.min(SHARE_BAR_CELLS, Math.max(1, Math.round(share * SHARE_BAR_CELLS)))
  return `${SHARE_FULL.repeat(filled)}${SHARE_EMPTY.repeat(SHARE_BAR_CELLS - filled)}`
}

/**
 * A two-column fact row, non-focusable: there is nothing to do to a fact.
 * @param key - the fact's name.
 * @param value - its value, escaped here.
 * @param width - display columns available inside the frame.
 * @returns the row.
 */
function fact(key: string, value: string, width: number): Row {
  return {
    kind: 'line',
    text: truncateToWidth(`${key.padEnd(LABEL_COLUMN)}  ${escapeControls(value)}`, Math.max(1, width)),
    role: 'subdued',
  }
}

/**
 * A non-focusable section heading.
 * @param text - the heading, already safe.
 * @returns the row.
 */
function heading(text: string): Row {
  return { kind: 'line', text, role: 'section-heading' }
}

/**
 * A non-focusable text line.
 * @param text - the text, already safe.
 * @param width - display columns available inside the frame.
 * @param role - the role to paint it with.
 * @returns the row.
 */
function line(text: string, width: number, role: Role): Row {
  return { kind: 'line', text: truncateToWidth(text, Math.max(1, width)), role }
}

/**
 * A non-focusable spacer.
 * @returns the row.
 */
function blank(): Row {
  return { kind: 'blank', text: '', role: 'muted' }
}

/**
 * Paint one row.
 *
 * One `paint` per row, applied after the gutter mark: colouring a multi-row
 * string in one call leaves every row but the last with colour switched on.
 * @param row - the row to paint.
 * @param focus - the currently aimed identity.
 * @returns the finished physical row.
 */
function paintRow(row: Row, focus: string | undefined): string {
  if (row.kind === 'blank') return ''
  if (row.kind === 'line') return row.painted === true ? row.text : paint(row.text, row.role)
  const focused = row.key !== undefined && row.key === focus
  return focused ? paint(`❯ ${row.text}`, 'selection') : `  ${paint(row.text, row.role)}`
}

/**
 * The help that is true for this stage and this row.
 * @param stage - the stage on screen.
 * @param focused - the aimed row, when there is one.
 * @param canCompact - whether this agent has a registered `/compact`.
 * @returns help segments, least essential first.
 */
function help(stage: Stage, focused: Row | undefined, canCompact: boolean): string {
  if (stage.kind === 'entry') return '↑↓ scroll · esc back'
  const enter = focused?.open === undefined ? '' : ' · ↵ inspect'
  const compact = canCompact ? ' · c compact' : ''
  return `↑↓ select${enter}${compact} · esc close`
}

/**
 * Count the physical rows Screen will draw for a candidate live region.
 * @param lines - candidate logical lines.
 * @param columns - the terminal's width.
 * @returns the physical rows.
 */
function physicalRows(lines: readonly string[], columns: number): string[] {
  return lines.flatMap(candidate => wrapToWidth(candidate, Math.max(1, columns)))
}

/**
 * A closable answer for a terminal too small to hold the frame safely.
 * @param reading - the cheap projection reading.
 * @param routeCapacity - the selected route's advertised context window.
 * @param columns - the terminal's width.
 * @param rows - the terminal's height.
 * @param compacting - whether a compaction is currently running.
 * @param notice - a pending outcome, which takes precedence when it failed.
 * @returns at most one row.
 */
function compactFallback(
  reading: ContextReading,
  routeCapacity: number | undefined,
  columns: number,
  rows: number,
  compacting: boolean,
  notice?: Notice,
): string[] {
  if (rows <= 0) return []
  // A failed action survives the geometry fallback that protects scrollback:
  // clipping its detail beats making a refused compaction invisible.
  if (notice?.failed === true) {
    return [paint(truncateToWidth(escapeControls(notice.text), Math.max(1, columns)), 'error')]
  }
  // The framed view puts this above the listing. Keep the same state visible in
  // the one-row backstop; otherwise resizing during a compaction makes it look
  // idle even though the command is still running.
  const summary = compactSummary(reading, routeCapacity)
  // One row must carry a whole truthful phrase. `esc cl` says neither what is
  // on screen nor how to leave it.
  const visible = [
    ...(compacting ? ['compacting context · esc close'] : []),
    summary,
    'esc close',
    'esc',
  ].find(candidate => displayWidth(candidate) <= columns)
  return visible === undefined ? [] : [paint(visible, 'overlay-headline')]
}

/**
 * The one-row truth about current context.
 * @param reading - the cheap projection reading.
 * @param routeCapacity - the selected route's advertised context window.
 * @returns the summary phrase, including how to leave.
 */
function compactSummary(reading: ContextReading, routeCapacity: number | undefined): string {
  if (!reading.projections) return 'Context unavailable · esc close'
  if (!reading.metered) return 'Context unmetered · esc close'
  const occupancy = reading.occupancy
  if (occupancy === undefined) return 'Context not yet measured · esc close'
  const capacity = routeCapacity ?? occupancy.capacity
  const total = capacity === undefined ? '' : `/${formatTokens(capacity)}`
  return `${formatTokens(occupancy.tokens)}${total} · esc close`
}

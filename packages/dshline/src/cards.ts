/**
 * Tool calls and results, drawn the way the tool asked to be drawn.
 *
 * A tool declares its render intent through `presentCall` and `presentResult`, and
 * those are pure functions of the call's arguments — the harness's contract, so a
 * frontend may call them freely. Reading them is the difference between "a name,
 * its arguments, and six truncated lines" and a diff in red and green, a framed
 * command with its exit status, or a search grouped by file.
 *
 * A tool that declares nothing still renders: every intent is documented to
 * degrade to raw content, so the fallback is the sanctioned path rather than a
 * gap. What a frontend must never do is invent a card for a tool by name.
 *
 * Every string here came from a model or a tool, so every string is escaped
 * before it is returned.
 * @module dshline/cards
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  DiffCallView,
  DiffResultView,
  FileDiff,
  FileLocation,
  ReadResultView,
  SearchResultView,
  TerminalCallView,
  TerminalResultView,
  ToolCallView,
  ToolDefinition,
  ToolResultView,
  WebFetchResultView,
  WebResultView,
  WebSearchResultView,
  WebSource,
} from '@deepseek-ai/dsh-tools'
import { diffRows } from './diff.ts'
import {
  box,
  BOX_CHROME_COLUMNS,
  displayWidth,
  escapeControls,
  hangingIndent,
  paint,
  truncateToWidth,
} from '@dshline/renderer'
import { parseArguments, PendingToolCalls, present } from './tool-pending.ts'
import type { PendingToolEntry } from './tool-pending.ts'

/**
 * How much of a card to draw.
 *
 * Cycled from the keyboard, because the right amount differs by task: reviewing a
 * change wants every diff line, and watching a long agent run wants the titles
 * alone. `hidden` still draws the call, never the body — a tool call that left no
 * trace at all would make the transcript lie about what ran.
 */
export type CardDetail = 'compact' | 'full' | 'hidden'

/** The cycle order for the toggle. */
export const CARD_DETAIL_CYCLE: readonly CardDetail[] = ['compact', 'full', 'hidden']

/** Body rows a `compact` card shows before it elides the rest. */
const COMPACT_ROWS = 6

/** Body rows a `full` card shows; a runaway command must not bury the terminal. */
const FULL_ROWS = 200

/**
 * Body rows the INSPECTOR shows.
 *
 * Far larger than {@link FULL_ROWS} because the two budgets bound different
 * things. A card's rows are committed into scrollback permanently, so its budget
 * is about not burying the terminal under one command. The inspector's rows live
 * in the bounded live region, where `RowViewport` shows a screenful at a time and
 * scrolls the rest — so the only cost of a larger budget is memory, and the only
 * cost of a smaller one is that opening a truncated `full` card would show
 * exactly what the card already did.
 */
const INSPECT_ROWS = 5000

/**
 * How much of a card to draw, for the scrollback render or the inspector.
 *
 * `inspect` is the inspector's detail level: it renders the same semantic card
 * at {@link INSPECT_ROWS}, so inspecting shows more than the card it came from
 * without ever rendering an unbounded stream either. Every budget is resolved
 * through {@link rowBudget}, so the levels cannot drift apart per presentation.
 */
type RenderDetail = CardDetail | 'inspect'

/**
 * The elision marker for a card, advertising the inspector wherever one is armed.
 *
 * Every truncated card in scrollback arms a Ctrl+O opportunity, `full` included:
 * the inspector renders at {@link INSPECT_ROWS} rather than the card's budget, so
 * opening a truncated `full` card shows rows the card did not. The inspector's own
 * `inspect` level is the one exception — it must not offer to open itself.
 */
function elisionMarker(detail: RenderDetail, core: string): string {
  return detail === 'inspect' ? core : `${core} · ctrl+o view`
}

/** Widest a framed card is drawn, so a maximized terminal keeps readable lines. */
const MAX_CARD_COLUMNS = 100

/** Gutter marks, matching the transcript's. */
const MARK = {
  call: '⏺',
  body: '⎿',
} as const

/** Indent of a card body, aligning it under its call mark. */
const BODY_INDENT = '  '

/** Icons by call category, so a glance separates reading from writing. */
const KIND_ICON: Record<string, string> = {
  read: '◇',
  edit: '◆',
  delete: '✕',
  move: '→',
  search: '⌕',
  execute: '❯',
  fetch: '↓',
}

/** A tool call remembered until its result arrives, so the presenter gets its args. */
type PendingCall = PendingToolEntry

/** The parts of a `tool/result` event a card needs. */
export interface ResultInput {
  /** The call this result answers. */
  readonly callId: string
  /** The model-facing result content. */
  readonly content: readonly ContentBlock[]
  /** Whether the call failed. */
  readonly isError: boolean
  /** The tool-private presentation payload, threaded verbatim from the event. */
  readonly meta?: unknown
  /** The harness's failure identity, when the call failed inside the runtime. */
  readonly error?: { readonly code: string; readonly name: string }
}

/**
 * How many truncated cards stay reachable by the inspector.
 *
 * A cap rather than a full history, because an unbounded list of retained call
 * arguments, results, and standalone call-side content is a second transcript —
 * the exact thing this frontend refuses to keep. Twelve is what a reader
 * plausibly scrolled past and still wants back; older than that, the rows are
 * in scrollback and the elision marker beside them is the honest answer.
 */
const INSPECT_HISTORY = 12

/**
 * The semantic inputs of one inspectable result.
 *
 * Retaining the call's arguments and the result lets the card renderer reproduce
 * the SAME presentation the compact card used, at expanded detail, rather than
 * falling back to raw content.
 */
export interface InspectableToolResult {
  readonly kind: 'result'
  /** The tool that produced the result, for its presenter lookup. */
  readonly name: string
  /** The call's parsed arguments, as the presenter expects them. */
  readonly args: unknown
  /** The call-time diff, when the tool declared one, for the proposed path. */
  readonly diffs?: readonly FileDiff[]
  /** The result, verbatim, from the `tool/result` event. */
  readonly input: ResultInput
}

/**
 * A pending call's own `presentCall` content, retained when drawing it elided
 * rows.
 *
 * `presentCall` content is committed into scrollback at call time, before any
 * result exists — `exit_plan_mode` is one caller, echoing its full plan back as
 * a generic card's content. Without this, only RESULT-side truncation was ever
 * reachable by Ctrl+O; call-side content that the same row budget cut was gone
 * the moment its card scrolled off. This closes that gap generically, for any
 * tool whose call declares `content`, rather than special-casing one tool name.
 */
export interface InspectableToolCall {
  readonly kind: 'call'
  /** The tool that made the call, kept for parity with the result shape. */
  readonly name: string
  /** The call's own presented content, verbatim. */
  readonly content: readonly ContentBlock[]
  /**
   * The call's declared follow-along locations, when the view published any.
   * Kept beside the content because either can be the thing a call card's row
   * budget cut, and the inspector re-renders both.
   */
  readonly locations?: readonly FileLocation[]
}

/** Either retained shape the inspector ring holds, newest first. */
export type InspectableCard = InspectableToolResult | InspectableToolCall

/** A rendered card's rows, and whether the budget cut any source material. */
interface Rendered {
  readonly rows: string[]
  /** Whether the detail budget omitted source material (the `of N+` marker). */
  readonly truncated: boolean
}

/**
 * Draws tool cards, remembering each call until its result arrives.
 *
 * The pairing is why this holds state: `presentResult` takes the call's arguments
 * as well as its result, and a `tool/result` event carries only the result. The
 * pending fold itself is shared with the Work child observers through
 * {@link PendingToolCalls}, so the transcript and the live views classify a call
 * the same way.
 */
export class ToolCards extends PendingToolCalls {

  /** How much of a card to draw; the runner cycles this from the keyboard. */
  detail: CardDetail = 'compact'

  /**
   * Cards whose presentation elided rows, newest first and bounded — a
   * completed result's, or a still-pending call's own `presentCall` content.
   *
   * `offered` marks the ones Ctrl+O has already put on screen. Consumption, not
   * eviction, is what keeps the detail cycle reachable: the first Ctrl+O opens
   * the newest unseen card and the next one falls through to
   * `compact → full → hidden`, exactly as a single slot did. Reaching an OLDER
   * card is a deliberate second gesture, made from inside the overlay.
   */
  private readonly inspectables: { item: InspectableCard; offered: boolean }[] = []

  /**
   * @param lookup - resolves a tool definition as the calling agent sees it, so
   *   the card matches the definition that actually executed. A scoped tool can
   *   shadow a global one, and a restricted-away tool reads as absent.
   * @param workspace - the session workspace, which titles a terminal card whose
   *   view left `cwd` to the frontend.
   */
  constructor(
    lookup: (name: string) => ToolDefinition | undefined,
    private readonly workspace: string,
  ) {
    super(lookup)
  }

  /**
   * Draw a pending call.
   * @param call - the logged call: its id, name, and unparsed argument JSON.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback.
   */
  call(call: { callId: string; name: string; arguments: string }, columns: number): string[] {
    const pending = this.handleCall({
      callId: call.callId,
      name: call.name,
      arguments: call.arguments,
    })
    const view = pending.view
    const width = cardWidth(columns)
    // A tool declaring no view has no title either, so its arguments are the only
    // description of the call and are shown at every level but `hidden`.
    if (view === undefined) return this.rawCall(call.name, call.arguments, width, columns)
    switch (view.card) {
      case 'terminal':
        return this.terminalCall(view, width, columns)
      case 'diff': {
        const rendered = this.diffCall(view, columns)
        if (rendered.truncated) this.rememberInspectableCall(call.name, undefined, view.locations)
        return rendered.rows
      }
      case 'generic': {
        const rendered = this.genericCall(view.title, rawInputText(view.rawInput), view.kind, columns, view.locations, view.content)
        // Mirrors the result-side rule in `result()`: a call whose OWN content or
        // location list the row budget cut becomes inspectable, because those
        // rows are committed into scrollback the moment this card's turn ends
        // and are unreachable there. `hidden` never reports truncation (see
        // `body()` and `locationRows()`), so it never arms this either.
        if (rendered.truncated) this.rememberInspectableCall(call.name, view.content, view.locations)
        return rendered.rows
      }
      default:
        // `ToolCallView` is a closed union today, but a harness release may add a
        // card this frontend has never seen. Falling back to the tool's name and
        // arguments is strictly better than drawing nothing.
        return this.rawCall(call.name, call.arguments, width, columns)
    }
  }

  /**
   * A call from a tool that declared no view: its name and its arguments.
   * @param name - the tool name.
   * @param args - the logged arguments string.
   * @param width - the framed width, for the summary's budget.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback.
   */
  private rawCall(name: string, args: string, width: number, columns: number): string[] {
    const rows = hangingIndent(`${paint(MARK.call, 'tool-icon')} `, BODY_INDENT, paint(escapeControls(name), 'tool-name'), columns)
    const summary = summarize(args, width)
    if (summary !== '' && this.detail !== 'hidden') {
      rows.push(...hangingIndent(BODY_INDENT, BODY_INDENT, paint(escapeControls(summary), 'subdued'), columns))
    }
    return ['', ...rows]
  }

  /**
   * Draw a completed call.
   * @param result - the logged result, paired to its call by id.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback.
   */
  result(result: ResultInput, columns: number): string[] {
    const call = this.pending.get(result.callId)
    this.pending.delete(result.callId)
    if (result.error !== undefined) {
      // An error offers nothing to inspect, and it no longer discards what came
      // before it: a card the reader scrolled past is still the card they want
      // back. What used to make discarding necessary — Ctrl+O staying captured
      // by one stale offer — is now handled by marking an offer consumed.
      return [`${BODY_INDENT}${paint(MARK.body, 'chrome')} ${paint(escapeControls(result.error.code), 'error')}`]
    }
    const rendered = this.renderResult(result, call, columns, this.detail)
    // A card that hid rows at ANY detail level becomes inspectable: those rows
    // are already committed into scrollback and unreachable there. A `full` card
    // is included because the inspector renders at INSPECT_ROWS rather than
    // FULL_ROWS, so it has more to show; `hidden` draws no body and so never
    // reports truncation. A result that hid nothing adds nothing and removes
    // nothing — newer output no longer discards an older card's only way back.
    if (call !== undefined && rendered.truncated) {
      this.inspectables.unshift({
        item: {
          kind: 'result',
          name: call.name,
          args: call.args,
          ...call.diffs === undefined ? {} : { diffs: call.diffs },
          input: result,
        },
        offered: false,
      })
      this.inspectables.length = Math.min(this.inspectables.length, INSPECT_HISTORY)
    }
    return rendered.rows
  }

  /**
   * The tool calls still waiting for their results, or nothing.
   *
   * Read by the status line so a long turn says what it is doing rather than only
   * how long it has been doing it — the difference between a slow command and a
   * hung session, which `working 14m 26s` alone cannot express.
   *
   * Reported as a name AND a count because the harness runs concurrency-safe
   * calls in parallel: several are legitimately outstanding at once, and naming
   * one of them alone would say a batch of six is a single tool. `latest` is the
   * most recently started, which is the only ordering a `Map` of pending calls
   * can honestly claim — the harness publishes no per-call progress or duration,
   * and this must not invent either.
   * @returns the newest pending call's presentation title, falling back to its
   *   tool name, and how many others are outstanding,
   *   or undefined when nothing is.
   */
  inFlight(): { title: string; others: number } | undefined {
    let latest: PendingCall | undefined
    for (const call of this.pending.values()) latest = call
    return latest === undefined
      ? undefined
      : { title: latest.title ?? latest.name, others: this.pending.size - 1 }
  }

  /**
   * Retain a call whose own presentation elided rows, newest first and bounded.
   *
   * Both the presented content and the declared locations are kept, because
   * either can be the thing the row budget cut; the inspector re-renders the
   * same sections at its own budget.
   * @param name - the tool that made the call.
   * @param content - the call's presented content, when the view declared any.
   * @param locations - the call's follow-along locations, when the view declared any.
   */
  private rememberInspectableCall(
    name: string,
    content: readonly ContentBlock[] | undefined,
    locations: readonly FileLocation[] | undefined,
  ): void {
    this.inspectables.unshift({
      item: {
        kind: 'call',
        name,
        content: content ?? [],
        ...locations === undefined ? {} : { locations },
      },
      offered: false,
    })
    this.inspectables.length = Math.min(this.inspectables.length, INSPECT_HISTORY)
  }

  /**
   * Consume the inspect opportunity on the NEWEST retained card, if unseen.
   *
   * Only ever index 0. Searching the ring for the newest *unoffered* card would
   * let the outer Ctrl+O walk backwards through history one keystroke at a time:
   * open the newest, close without stepping, and the next Ctrl+O would open the
   * one before it instead of reaching the detail toggle. Older cards are
   * deliberately reachable only from inside the inspector
   * ({@link inspectableOlderThan}), which is what keeps
   * `compact → full → hidden` a single keystroke away — and what this method
   * promises the reader.
   *
   * A new truncated card — a result's, or a call's own content — unshifts onto
   * the front, so it re-arms this without re-offering anything already seen.
   * @returns the newest retained card if it has not been offered, else undefined.
   */
  takeInspectable(): InspectableCard | undefined {
    const entry = this.inspectables[0]
    if (entry === undefined || entry.offered) return undefined
    entry.offered = true
    return entry.item
  }

  /**
   * The retained card one step older than this one.
   *
   * This is the gesture that reaches a card scrolled past: the inspector steps
   * back through the ring rather than the reader losing it to the next tool
   * call. Marking each step offered means walking the history does not leave a
   * queue of cards that Ctrl+O would then re-offer one at a time.
   * @param item - the card currently on screen.
   * @returns the next older retained card, or undefined at the end.
   */
  inspectableOlderThan(item: InspectableCard): InspectableCard | undefined {
    const index = this.inspectables.findIndex(candidate => candidate.item === item)
    const older = index < 0 ? undefined : this.inspectables[index + 1]
    if (older === undefined) return undefined
    older.offered = true
    return older.item
  }

  /**
   * The retained card one step newer than this one.
   *
   * A destination is marked offered even though it was usually already visited:
   * a new truncated card can arrive while the inspector is open, and a card
   * shown by stepping forward must not be offered again by the outer Ctrl+O
   * after the overlay closes.
   * @param item - the card currently on screen.
   * @returns the next newer retained card, or undefined at the front.
   */
  inspectableNewerThan(item: InspectableCard): InspectableCard | undefined {
    const index = this.inspectables.findIndex(candidate => candidate.item === item)
    const newer = index <= 0 ? undefined : this.inspectables[index - 1]
    if (newer === undefined) return undefined
    newer.offered = true
    return newer.item
  }

  /**
   * Where one retained card sits in the history, for the inspector's counter.
   *
   * Stepping is invisible without it: two cards from the same tool can present
   * almost identically, and an overlay that changes with no sign of having moved
   * reads as a redraw rather than as navigation.
   * @param item - the card currently on screen.
   * @returns its 1-based position and the retained total, or undefined.
   */
  inspectableRank(item: InspectableCard): { position: number; total: number } | undefined {
    const index = this.inspectables.findIndex(candidate => candidate.item === item)
    return index < 0 ? undefined : { position: index + 1, total: this.inspectables.length }
  }

  /**
   * Render an inspectable card's full semantic presentation for the inspector.
   *
   * Re-runs the same presenter the compact card used, so a diff stays a diff and a
   * search stays grouped by file, at the full bounded budget. `rows` are exactly
   * the scrollable presentation rows the overlay navigates, so its counter and
   * the viewport stay in one coordinate system; `truncated` says the inspector's
   * own {@link INSPECT_ROWS} cap hid further source material, for the `of N+`
   * marker.
   * @param item - the retained semantic inputs of the card to re-render.
   * @param columns - the terminal's current width.
   * @returns the presentation rows and whether the budget hid source material.
   */
  renderInspect(item: InspectableCard, columns: number): { rows: string[]; truncated: boolean } {
    // A call-shaped entry has no result to re-run `renderResult` against — it is
    // the call's own `presentCall` content, so it re-renders through the same
    // `body()` a generic call used, just at the inspector's budget.
    if (item.kind === 'call') {
      const declared = this.locationRows(item.locations, columns, 'inspect')
      const content = this.body(textOf(item.content), columns, false, 'inspect')
      return { rows: [...declared.rows, ...content.rows], truncated: declared.truncated || content.truncated }
    }
    const call = {
      name: item.name,
      args: item.args,
      ...item.diffs === undefined ? {} : { diffs: item.diffs },
    }
    const { rows, truncated } = this.renderResult(item.input, call, columns, 'inspect')
    return { rows, truncated }
  }

  /**
   * Render a completed call's body at one detail level.
   *
   * Resolving the presenter here keeps the scrollback draw and the inspector on
   * the same code path, so an inspected result is presented exactly as its card
   * was, only with the budget raised. The error branch is handled by the caller,
   * which has no presenter and nothing worth inspecting.
   * @param input - the result.
   * @param call - the paired call, when one was seen.
   * @param columns - the terminal's current width.
   * @param detail - the detail level (compact, full, hidden, or inspect).
   * @returns the rows and how many source rows they were cut from.
   */
  private renderResult(
    input: ResultInput,
    call: Pick<PendingCall, 'name' | 'args' | 'diffs'> | undefined,
    columns: number,
    detail: RenderDetail,
  ): Rendered {
    const view = call === undefined
      ? undefined
      : present(() => this.lookup(call.name)?.presentResult?.(call.args, {
        content: [...input.content],
        isError: input.isError,
        ...input.meta === undefined ? {} : { meta: input.meta as never },
      }))
    const width = cardWidth(columns)
    // A mutation tool that declared a call-time diff but no result-time one leaves
    // the proposal as the only description of what it changed — but ONLY when the
    // call succeeded. Drawing a proposal for a failed call shows a change that
    // never happened as though it had, and suppresses the error that says so.
    const proposed = input.isError ? undefined : call?.diffs
    if (view === undefined) {
      return proposed === undefined
        ? this.body(textOf(input.content), columns, input.isError, detail)
        : this.diffBody(proposed, width, columns, detail)
    }
    switch (view.card) {
      case 'terminal':
        return this.terminalResult(view, width, columns, detail)
      case 'diff':
        return this.diffBody(view.diffs, width, columns, detail)
      case 'search':
        return this.searchResult(view, columns, detail)
      case 'read':
        return this.readResult(view, columns, detail)
      case 'web':
        return this.webResult(view, columns, input, detail)
      case 'generic':
        if (proposed !== undefined) return this.diffBody(proposed, width, columns, detail)
        return this.body(view.content === undefined ? textOf(input.content) : textOf(view.content), columns, input.isError, detail)
      default:
        return this.body(textOf(input.content), columns, input.isError, detail)
    }
  }

  /**
   * A titled call row, optionally with a detail line beneath it.
   * @param title - the call's own title, unescaped.
   * @param detail - the salient input, unescaped; empty for none. Shown only at
   *   `full`, because a view that declares one has already said what the call does
   *   in its title — `grep`'s title names the pattern its `rawInput` repeats.
   * @param kind - the call category, for its icon.
   * @param columns - the terminal's current width.
   * @param locations - the files the view declared the call touches, when any.
   * @param content - extra content blocks the view asked to show.
   * @returns rows to write into scrollback.
   */
  private genericCall(
    title: string,
    detail: string,
    kind: string | undefined,
    columns: number,
    locations?: readonly FileLocation[],
    content?: readonly ContentBlock[],
  ): Rendered {
    const icon = kind === undefined ? MARK.call : KIND_ICON[kind] ?? MARK.call
    const head = paint(escapeControls(title), 'tool-name')
    const rows = hangingIndent(`${paint(icon, 'tool-icon')} `, BODY_INDENT, head, columns)
    // Locations sit directly under the title rather than after the content: they
    // are part of what the call IS (the files it touches), and trailing rows
    // after a long content body would be buried under it.
    const declared = this.locationRows(locations, columns, this.detail)
    rows.push(...declared.rows)
    if (detail !== '' && this.detail === 'full') {
      rows.push(...hangingIndent(BODY_INDENT, BODY_INDENT, paint(escapeControls(detail), 'subdued'), columns))
    }
    let truncated = declared.truncated
    if (content !== undefined && content.length > 0) {
      const body = this.body(textOf(content), columns, false, this.detail)
      rows.push(...body.rows)
      truncated = body.truncated || truncated
    }
    return { rows: ['', ...rows], truncated }
  }

  /**
   * A shell command as a framed card headed by its working directory.
   * @param view - the terminal call view.
   * @param width - the framed width.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback.
   */
  private terminalCall(view: TerminalCallView, width: number, columns: number): string[] {
    const rows = ['']
    if (view.description !== undefined && view.description !== '') {
      rows.push(...hangingIndent(`${paint(KIND_ICON.execute ?? MARK.call, 'tool-icon')} `, BODY_INDENT, paint(escapeControls(view.description), 'tool-name'), columns))
    }
    if (this.detail === 'hidden') {
      // The command itself is not a body: hiding it would leave a card that says
      // a shell ran without saying what it ran.
      rows.push(...hangingIndent(BODY_INDENT, BODY_INDENT, paint(escapeControls(view.title), 'tool-name'), columns))
      return rows
    }
    rows.push(...box([paint(escapeControls(view.title), 'tool-name')], {
      width,
      // A view that omits `cwd` runs in the session workspace; the harness leaves
      // naming it to the frontend, and an untitled frame loses where a command ran.
      title: escapeControls(view.cwd ?? this.workspace),
      border: text => paint(text, 'chrome'),
    }).map(row => `${BODY_INDENT}${row}`))
    return rows
  }

  /**
   * A completed command: its output framed, with an exit status.
   * @param view - the terminal result view.
   * @param width - the framed width.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback.
   */
  private terminalResult(view: TerminalResultView, width: number, columns: number, detail: RenderDetail): Rendered {
    const status = view.signal !== undefined
      ? paint(`killed by ${escapeControls(view.signal)}`, 'error')
      : view.exitCode === undefined || view.exitCode === 0
        ? undefined
        : paint(`exit ${String(view.exitCode)}`, 'error')
    const output = view.output ?? ''
    if (detail === 'hidden') {
      return { rows: status === undefined ? [] : [`${BODY_INDENT}${status}`], truncated: false }
    }
    if (output.trim() === '') {
      return {
        rows: status === undefined ? [`${BODY_INDENT}${paint('no output', 'muted')}`] : [`${BODY_INDENT}${status}`],
        truncated: false,
      }
    }
    // The final newline terminates the last line rather than starting an empty one.
    // Keeping it added a blank row inside the frame, and at the compact boundary it
    // also reported one line as hidden when nothing had been.
    const all = escapeControls(output.replace(/\n$/u, '')).split('\n')
    // Anchored to the END, unlike every other body here. What a command was run to
    // find out is at the bottom of its output — the failure, the summary, the exit
    // line — so keeping the first six rows of `pnpm test` keeps the banner and
    // throws away the answer. The marker leads the body for the same reason: it
    // describes what is above the rows beneath it.
    const { rows, elided } = this.limitTail(all, detail)
    const body = rows.map(row => truncateToWidth(paint(row, 'subdued'), width - BOX_CHROME_COLUMNS))
    if (elided > 0) body.unshift(paint(elisionMarker(detail, `… ${String(elided)} earlier lines`), 'muted'))
    return {
      rows: box(body, {
        width,
        ...status === undefined ? {} : { title: status },
        border: text => paint(text, 'chrome'),
      }).map(row => `${BODY_INDENT}${row}`),
      truncated: elided > 0,
    }
  }

  /**
   * A diff call: its title alone, because the change is drawn once, at result time.
   *
   * Declared locations are the one addition, and they are not the change: they say
   * where a follow-along UI would look (usually `path:line`), which the result-time
   * diff body does not state.
   * @param view - the diff call view.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback, and whether the location budget cut any.
   */
  private diffCall(view: DiffCallView, columns: number): Rendered {
    const rows = [
      '',
      ...hangingIndent(`${paint(KIND_ICON.edit ?? MARK.call, 'tool-icon')} `, BODY_INDENT, paint(escapeControls(view.title), 'tool-name'), columns),
    ]
    const declared = this.locationRows(view.locations, columns, this.detail)
    return { rows: [...rows, ...declared.rows], truncated: declared.truncated }
  }

  /**
   * The files a call declared it touches, one bounded row each.
   *
   * The declared list is the only source: locations are never inferred from
   * arguments or diffs, because a tool that declared none may still have touched
   * files, and a row claiming it did would be the frontend inventing a fact.
   * @param locations - the locations the call view declared, when it did.
   * @param columns - the terminal's current width.
   * @param detail - the detail level being drawn.
   * @returns the location rows and whether the budget cut any.
   */
  private locationRows(locations: readonly FileLocation[] | undefined, columns: number, detail: RenderDetail): Rendered {
    if (detail === 'hidden' || locations === undefined || locations.length === 0) return { rows: [], truncated: false }
    const rows = locations.map(location => truncateToWidth(
      paint(escapeControls(location.line === undefined
        ? location.path
        // The separator matches how a person names a position in an editor, which
        // is also how the harness writes a location's meaning into the contract.
        : `${location.path}:${String(location.line)}`), 'path'),
      Math.max(1, columns - BODY_INDENT.length),
    ))
    const { rows: shown, elided } = this.limit(rows, detail)
    const out = shown.map(row => `${BODY_INDENT}${row}`)
    if (elided > 0) out.push(`${BODY_INDENT}${paint(elisionMarker(detail, `… ${String(elided)} more locations`), 'muted')}`)
    return { rows: out, truncated: elided > 0 }
  }

  /**
   * The changed lines of one or more files, added in green and removed in red.
   * @param diffs - the files' changes.
   * @param width - the framed width.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback.
   */
  private diffBody(diffs: readonly FileDiff[], width: number, columns: number, detail: RenderDetail): Rendered {
    if (detail === 'hidden') return { rows: [], truncated: false }
    const out: string[] = []
    // ONE budget across every file, not one per file. Per-file budgets let a bulk
    // mutation emit six rows plus a header for each of hundreds of files and bury
    // the transcript, which is the opposite of what the cap is for.
    const budget = rowBudget(detail)
    let remaining = budget
    let omitted = 0
    let filesOmitted = 0
    for (const diff of diffs) {
      const changed = diffRows(diff.oldText, diff.newText).filter(row => row.kind !== 'context')
      if (remaining <= 0) {
        filesOmitted += 1
        omitted += changed.length
        continue
      }
      out.push(...hangingIndent(
        `${BODY_INDENT}${paint(MARK.body, 'chrome')} `,
        `${BODY_INDENT}  `,
        paint(escapeControls(diff.path), 'path'),
        columns,
      ))
      const shown = changed.slice(0, remaining)
      omitted += changed.length - shown.length
      remaining -= shown.length
      // An identical before and after leaves nothing marked, which would read as an
      // empty change rather than an unchanged file.
      if (changed.length === 0) out.push(`${BODY_INDENT}  ${paint('(no change)', 'muted')}`)
      for (const row of shown) {
        const marked = row.kind === 'add'
          ? paint(`+ ${escapeControls(row.text)}`, 'diff-add')
          : paint(`- ${escapeControls(row.text)}`, 'diff-remove')
        out.push(`${BODY_INDENT}  ${truncateToWidth(marked, Math.max(10, width - 4))}`)
      }
    }
    if (omitted > 0) {
      const files = filesOmitted > 0 ? ` in ${String(filesOmitted)} more files` : ''
      out.push(`${BODY_INDENT}  ${paint(elisionMarker(detail, `… ${String(omitted)} more changed lines${files}`), 'muted')}`)
    }
    return { rows: out, truncated: omitted > 0 }
  }

  /**
   * A search result: matches grouped by file, or a flat path list.
   * @param view - the search result view.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback.
   */
  private searchResult(view: SearchResultView, columns: number, detail: RenderDetail): Rendered {
    const total = `${String(view.total)}${view.truncated ? '+' : ''}`
    const head = `${BODY_INDENT}${paint(MARK.body, 'chrome')} `
    if (view.shape === 'paths') {
      const summary = `${total} ${view.total === 1 ? 'path' : 'paths'}`
      if (detail === 'hidden') return { rows: [`${head}${paint(summary, 'subdued')}`], truncated: false }
      const { rows, elided } = this.limit(view.paths, detail)
      return {
        rows: [
          `${head}${paint(summary, 'subdued')}`,
          ...rows.map(path => `${BODY_INDENT}  ${truncateToWidth(paint(escapeControls(path), 'path'), columns - 4)}`),
          ...elided > 0 ? [`${BODY_INDENT}  ${paint(elisionMarker(detail, `… ${String(elided)} more`), 'muted')}`] : [],
        ],
        truncated: elided > 0,
      }
    }
    const summary = `${total} ${view.total === 1 ? 'match' : 'matches'} in ${String(view.files.length)} ${view.files.length === 1 ? 'file' : 'files'}`
    if (detail === 'hidden') return { rows: [`${head}${paint(summary, 'subdued')}`], truncated: false }
    const out = [`${head}${paint(summary, 'subdued')}`]
    // Files, then their lines: a flat list of matches loses which file each is in,
    // which is the first thing a reader needs from a search.
    const budget = rowBudget(detail)
    let drawn = 0
    let omitted = 0
    for (const file of view.files) {
      if (drawn >= budget) {
        omitted += 1 + file.matches.length
        continue
      }
      out.push(`${BODY_INDENT}  ${truncateToWidth(paint(escapeControls(file.path), 'path'), columns - 4)}`)
      drawn += 1
      for (const match of file.matches) {
        if (drawn >= budget) {
          omitted += 1
          continue
        }
        const number = paint(`${String(match.lineNumber)}:`, 'muted')
        out.push(`${BODY_INDENT}    ${truncateToWidth(`${number} ${paint(escapeControls(match.line.trim()), 'subdued')}`, columns - 6)}`)
        drawn += 1
      }
    }
    // This budget is the card's own, separate from the tool's `truncated` flag, so
    // without saying so a card could hide matches while reporting a complete result
    // — and the explicitly chosen `full` view would look complete too.
    if (omitted > 0) out.push(`${BODY_INDENT}  ${paint(elisionMarker(detail, `… ${String(omitted)} more rows`), 'muted')}`)
    return { rows: out, truncated: omitted > 0 }
  }

  /**
   * A file read: its lines, numbered as they are in the file.
   * @param view - the read result view.
   * @param columns - the terminal's current width.
   * @returns rows to write into scrollback.
   */
  private readResult(view: ReadResultView, columns: number, detail: RenderDetail): Rendered {
    const shown = view.lines.length
    const summary = `${escapeControls(view.path)} · ${String(shown)} of ${String(view.totalLines)} lines`
    const head = `${BODY_INDENT}${paint(MARK.body, 'chrome')} ${paint(summary, 'subdued')}`
    if (detail === 'hidden') return { rows: [head], truncated: false }
    const { rows, elided } = this.limit(view.lines.map(line => {
      const number = paint(String(line.number).padStart(4), 'muted')
      return `${number} ${paint(escapeControls(line.text), 'subdued')}`
    }), detail)
    return {
      rows: [
        head,
        ...rows.map(row => `${BODY_INDENT}  ${truncateToWidth(row, columns - 4)}`),
        ...elided > 0 ? [`${BODY_INDENT}  ${paint(elisionMarker(detail, `… ${String(elided)} more lines`), 'muted')}`] : [],
      ],
      truncated: elided > 0,
    }
  }

  /**
   * A web retrieval: a search's cited sources with its provider answer, or a
   * fetch's retrieval summary and body.
   * @param view - the web result view.
   * @param columns - the terminal's current width.
   * @param result - the logged result, for the fallback text.
   * @param detail - the detail level being drawn.
   * @returns rows to write into scrollback.
   */
  private webResult(view: WebResultView, columns: number, result: ResultInput, detail: RenderDetail): Rendered {
    // The unions are merge-extensible: an arm this frontend has never seen is
    // checked for explicitly, so it degrades to the raw content instead of
    // reading a field it does not carry.
    if (view.kind === 'fetch') return this.webFetch(view, columns, result, detail)
    if (view.kind !== 'search') return this.body(textOf(result.content), columns, result.isError, detail)
    return this.webSearch(view, columns, detail)
  }

  /**
   * A completed web search: the provider's answer, then its sources in the order
   * the harness listed them.
   *
   * Every field is read from the structured view and nothing else: a snippet is
   * the provider's own, never re-derived from result text, and `publishedAt` is
   * shown exactly as the provider wrote it — reformatting it would claim a
   * precision the string does not carry.
   * @param view - the search result view.
   * @param columns - the terminal's current width.
   * @param detail - the detail level being drawn.
   * @returns rows to write into scrollback.
   */
  private webSearch(view: WebSearchResultView, columns: number, detail: RenderDetail): Rendered {
    // The `+` marks a capped list, exactly as the search card does: without it a
    // truncated set of sources reads as the complete set.
    const count = `${String(view.sources.length)}${view.truncated ? '+' : ''}`
    const summary = `${count} ${view.sources.length === 1 && !view.truncated ? 'source' : 'sources'}`
    const head = `${BODY_INDENT}${paint(MARK.body, 'chrome')} ${paint(summary, 'subdued')}`
    if (detail === 'hidden') return { rows: [head], truncated: false }
    const out = [head]
    // ONE budget across the answer and every source, not one per source — the
    // same rule a bulk diff follows, and for the same reason: a search returning
    // many sources must not bury the transcript under one card.
    let remaining = rowBudget(detail)
    let omitted = 0
    const answer = view.answer === undefined ? '' : view.answer.trim()
    if (answer !== '') {
      const rows = hangingIndent(
        `${BODY_INDENT}${paint(MARK.body, 'chrome')} `,
        `${BODY_INDENT}  `,
        paint(escapeControls(answer), 'subdued'),
        columns,
      )
      const shown = rows.slice(0, remaining)
      omitted += rows.length - shown.length
      remaining -= shown.length
      out.push(...shown)
    }
    for (const source of view.sources) {
      for (const row of webSourceRows(source, columns)) {
        if (remaining <= 0) {
          omitted += 1
          continue
        }
        out.push(`${BODY_INDENT}  ${row}`)
        remaining -= 1
      }
    }
    if (omitted > 0) out.push(`${BODY_INDENT}  ${paint(elisionMarker(detail, `… ${String(omitted)} more rows`), 'muted')}`)
    return { rows: out, truncated: omitted > 0 }
  }

  /**
   * A completed web fetch: a retrieval summary from the structured view, then the
   * fetched body.
   *
   * The summary is composed from the view's own fields, never parsed back out of
   * the result text: the model-facing `Fetched …` envelope renders the same facts
   * for the model, and the view is the authoritative copy for a UI.
   * @param view - the fetch result view.
   * @param columns - the terminal's current width.
   * @param result - the logged result, for the body text.
   * @param detail - the detail level being drawn.
   * @returns rows to write into scrollback.
   */
  private webFetch(view: WebFetchResultView, columns: number, result: ResultInput, detail: RenderDetail): Rendered {
    const separator = paint(' · ', 'muted')
    const tail = [
      separator + paint(String(view.statusCode), 'subdued'),
      // The view's own truncation flag, never a length recomputed here: a body can
      // fit the card entirely and still have been cut upstream, and that fact is
      // not visible in the text.
      ...view.truncated ? [separator + paint('truncated', 'warning')] : [],
    ].join('')
    // The status and the truncation marker are the parts a reader cannot do
    // without, so the URL is what gives way when the row is tight.
    const width = Math.max(1, columns - 4)
    const url = truncateToWidth(paint(escapeControls(view.url), 'link-target'), Math.max(1, width - displayWidth(tail)))
    const head = `${BODY_INDENT}${paint(MARK.body, 'chrome')} ${truncateToWidth(url + tail, width)}`
    const body = this.body(textOf(result.content), columns, result.isError, detail)
    return { rows: [head, ...body.rows], truncated: body.truncated }
  }

  /**
   * Raw result text, the fallback every intent degrades to.
   * @param text - the result text, unescaped.
   * @param columns - the terminal's current width.
   * @param isError - whether the call failed, which colours it.
   * @returns rows to write into scrollback.
   */
  private body(text: string, columns: number, isError: boolean, detail: RenderDetail): Rendered {
    const trimmed = text.trim()
    if (trimmed === '' || detail === 'hidden') return { rows: [], truncated: false }
    const all = escapeControls(trimmed).split('\n')
    const { rows, elided } = this.limit(all, detail)
    const role = isError ? 'error' : 'subdued'
    const out = rows.map((row, index) => (index === 0
      ? `${BODY_INDENT}${paint(MARK.body, 'chrome')} ${truncateToWidth(paint(row, role), columns - 4)}`
      : `${BODY_INDENT}  ${truncateToWidth(paint(row, role), columns - 4)}`))
    if (elided > 0) out.push(`${BODY_INDENT}  ${paint(elisionMarker(detail, `… ${String(elided)} more lines`), 'muted')}`)
    return { rows: out, truncated: elided > 0 }
  }

  /**
   * Cut a body to a detail level's row budget.
   * @param rows - every row the body could show.
   * @param detail - the detail level being drawn.
   * @returns the retained rows and how many were dropped.
   */
  private limit(rows: readonly string[], detail: RenderDetail): { rows: readonly string[]; elided: number } {
    const budget = rowBudget(detail)
    if (rows.length <= budget) return { rows, elided: 0 }
    return { rows: rows.slice(0, budget), elided: rows.length - budget }
  }

  /**
   * Cut a body to a detail level's row budget, keeping its END.
   *
   * A command's answer is its last rows — the summary, the failing assertion, the
   * exit line — so head-anchoring a shell result keeps the banner and drops what
   * was asked for. This is the wrong rule for a file read or a search, where the
   * top IS the answer, which is why it is a second method rather than a flag on
   * {@link limit}.
   * @param rows - every row the body could show.
   * @param detail - the detail level being drawn.
   * @returns the retained trailing rows and how many earlier ones were dropped.
   */
  private limitTail(rows: readonly string[], detail: RenderDetail): { rows: readonly string[]; elided: number } {
    const budget = rowBudget(detail)
    if (rows.length <= budget) return { rows, elided: 0 }
    return { rows: rows.slice(rows.length - budget), elided: rows.length - budget }
  }
}

/**
 * Body rows one detail level may draw.
 * @param detail - the detail level being drawn.
 * @returns the row budget.
 */
function rowBudget(detail: RenderDetail): number {
  if (detail === 'inspect') return INSPECT_ROWS
  return detail === 'full' ? FULL_ROWS : COMPACT_ROWS
}

/**
 * Render a view's salient input.
 * @param rawInput - the value the view chose to surface.
 * @returns the text to show, empty when there is none.
 */
function rawInputText(rawInput: unknown): string {
  if (rawInput === undefined || rawInput === null) return ''
  if (typeof rawInput === 'string') return rawInput
  return JSON.stringify(rawInput) ?? ''
}

/**
 * One web source's rows: its title with its url, then the optional fields
 * beneath, in the order the contract lists them.
 *
 * An untitled source shows its url once: the fallback IS the url row, and a url
 * beside itself carries no information. A field that arrives with an embedded
 * newline is folded to one row rather than split, because the row budget counts
 * rows, and one source field silently becoming several rows would spend budget
 * the reader did not see being spent.
 * @param source - the structured source, exactly as the harness published it.
 * @param columns - the terminal's current width.
 * @returns the source's rows, already truncated to fit.
 */
function webSourceRows(source: WebSource, columns: number): string[] {
  const width = Math.max(1, columns - 4)
  const oneLine = (text: string): string => escapeControls(text).replace(/\n/gu, ' ')
  const rows = [
    source.title === undefined
      ? truncateToWidth(paint(oneLine(source.url), 'link'), width)
      : truncateToWidth(`${paint(oneLine(source.title), 'link')} ${paint(oneLine(source.url), 'link-target')}`, width),
  ]
  if (source.snippet !== undefined && source.snippet.trim() !== '') {
    rows.push(truncateToWidth(paint(oneLine(source.snippet.trim()), 'subdued'), width))
  }
  if (source.publishedAt !== undefined && source.publishedAt.trim() !== '') {
    // The provider's own string, verbatim: parsing it would invent a precision
    // the contract never states.
    rows.push(truncateToWidth(paint(`published ${oneLine(source.publishedAt.trim())}`, 'muted'), width))
  }
  return rows
}

/**
 * A one-line summary of raw arguments, for a tool that declares no call view.
 * @param raw - the logged arguments string.
 * @param columns - width budget.
 * @returns the summary.
 */
function summarize(raw: string, columns: number): string {
  const parsed = parseArguments(raw)
  if (typeof parsed !== 'object' || parsed === null) return truncateToWidth(raw, columns)
  return truncateToWidth(Object.entries(parsed as Record<string, unknown>)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value) ?? ''}`)
    .join(' '), columns)
}

/**
 * Concatenate the text of every text block.
 * @param content - message content blocks.
 * @returns the joined text.
 */
function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * The width a framed card is drawn at.
 * @param columns - the terminal's current width.
 * @returns the frame width, indented under the call mark.
 */
function cardWidth(columns: number): number {
  return Math.max(BOX_CHROME_COLUMNS + 8, Math.min(columns - BODY_INDENT.length, MAX_CARD_COLUMNS))
}

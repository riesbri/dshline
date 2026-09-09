/**
 * Inline completion for `/commands` and `@file` paths.
 *
 * Deliberately NOT an overlay. An overlay owns the keyboard, and completion has to
 * coexist with typing: the list narrows as characters arrive, and every key that
 * is not a completion gesture belongs to the composer. So this is a slot view plus
 * a key filter the runner consults first, and it disappears the moment the text
 * under the cursor stops looking like a completable token.
 *
 * What is completable is decided from the text BEHIND the cursor only. Completing
 * against text ahead of it would rewrite characters the user did not ask about, and
 * a token is not finished until the cursor leaves it.
 * @module dshline/completion
 */

import type { Composer, Key } from '@dshline/renderer'
import { displayWidth, escapeControls, paint, truncateToWidth } from '@dshline/renderer'
import type { TuiSlotView } from './slots.ts'
import { chromeWidth } from './chrome.ts'

/** Rows of the list shown at once, when the terminal has room for them. */
const VISIBLE_ROWS = 6

/**
 * Rows this view spends on its own chrome: the elision marker and the help line.
 *
 * Both are reserved even when the marker will not be drawn. Whether it is drawn
 * depends on how many candidates fit, which is the number being computed — so
 * spending the row unconditionally is what keeps that from being circular, at a
 * cost of one row on a terminal short enough to notice.
 */
const CHROME_ROWS = 2

/** Marker on the highlighted row. */
const CURSOR = '›'

/**
 * A candidate.
 *
 * `replace` is what the token becomes, complete with its sigil, so accepting is a
 * substitution rather than an assembly the caller has to get right.
 */
export interface Candidate {
  /** The full replacement for the typed token. */
  readonly replace: string
  /** What the row shows. */
  readonly label: string
  /** Optional trailing note, dimmed. */
  readonly note?: string
}

/** Where candidates come from, so the engine holds no opinion about the harness. */
export interface CompletionSources {
  /**
   * Commands available right now, for a line that begins with a slash.
   * @returns the command names, without their leading slash, and their summaries.
   */
  commands(): readonly { readonly name: string; readonly description: string }[]
  /**
   * Values one command accepts as its argument, for a line that already names it.
   *
   * Asked of the runner rather than derived here, because what a command accepts
   * is a live fact: which reasoning levels exist depends on the route currently
   * selected, and which models exist depends on what the adapters advertise.
   * @param name - the command, without its leading slash.
   * @returns the offered values, in the order they should be listed.
   * @throws nothing a caller must handle; a command with no arguments yields none.
   */
  commandArguments(name: string): Promise<readonly { readonly value: string; readonly note?: string }[]>
  /**
   * Directory children for a path completion.
   * @param directory - the directory to list, relative to the workspace, or empty
   *   for the workspace root.
   * @returns each child's name and whether it is itself a directory.
   * @throws nothing a caller must handle; an unreadable directory yields no entries.
   */
  paths(directory: string): Promise<readonly { readonly name: string; readonly directory: boolean }[]>
}

/** The token under the cursor, and which kind of completion it wants. */
interface Token {
  readonly kind: 'command' | 'path' | 'argument'
  /** The typed text including its sigil. */
  readonly text: string
  /** The command an argument token belongs to, without its slash. */
  readonly command?: string
}

/**
 * A command name, whitespace, and one unfinished word.
 *
 * The word runs to the END of the line, so a trailing space closes the token:
 * `/reasoning high ` is finished being typed and offers nothing, which is what
 * keeps an accepted value from putting the whole vocabulary straight back on
 * screen.
 *
 * The value may not contain whitespace, which is what keeps this from claiming
 * prose. `/tmp is full` is a sentence about a folder — two words after the name —
 * and stays a message; `/tmp is` reaches a command that offers no values and so
 * shows nothing. Only the single-word case can be a completable argument.
 */
const ARGUMENT = /^\/(?<name>[a-z][a-z0-9_-]*)\s+(?<value>[^\s]*)$/u

/**
 * The completable token behind the cursor, or nothing.
 *
 * A slash completes only as the FIRST thing on its line: `/help` is a command and
 * `see /etc/hosts` is a path, and the difference is the position. An `@` completes
 * anywhere, because a file mention belongs mid-sentence.
 * @param before - the cursor's own line, up to the cursor.
 * @returns the token, or undefined when nothing behind the cursor is completable.
 */
function tokenAt(before: string): Token | undefined {
  if (/^\/[^\s/]*$/u.test(before)) return { kind: 'command', text: before }
  const argument = ARGUMENT.exec(before)
  if (argument?.groups?.name !== undefined) {
    return { kind: 'argument', text: before, command: argument.groups.name }
  }
  const mention = /(?:^|\s)(@[^\s]*)$/u.exec(before)
  if (mention?.[1] !== undefined) return { kind: 'path', text: mention[1] }
  return undefined
}

/**
 * Split a path token into the directory to list and the prefix to match.
 * @param token - the token including its `@`.
 * @returns the directory, and the last segment being typed.
 */
function splitPath(token: string): { directory: string; prefix: string } {
  const path = token.slice(1)
  const cut = path.lastIndexOf('/')
  if (cut < 0) return { directory: '', prefix: path }
  return { directory: path.slice(0, cut), prefix: path.slice(cut + 1) }
}

/** Live completion state for one composer. */
export interface Completion {
  /** The slot view; contributes nothing while no candidates are offered. */
  readonly view: TuiSlotView
  /**
   * Recompute from the composer's current text. Async because a path completion
   * reads a directory.
   * @returns nothing; call the runner's redraw afterwards.
   */
  refresh(): Promise<void>
  /** Whether candidates are being offered, and so whether keys are intercepted. */
  readonly active: boolean
  /**
   * Offer one keystroke to the completion.
   * @param key - the decoded keystroke.
   * @returns whether the completion consumed it.
   */
  handleKey(key: Key): boolean
  /**
   * Abandon any lookup still in flight and stop offering candidates, without
   * recomputing against the composer's current text.
   *
   * Used when the composer is replaced wholesale — a submitted line or a
   * recalled history entry — so a slow directory read cannot revive candidates
   * for text that no longer exists. `refresh()` must run again before anything
   * is offered.
   */
  invalidate(): void
}

/**
 * Wire completion to a composer.
 * @param composer - the buffer being edited; accepting a candidate rewrites it.
 * @param sources - where candidates come from.
 * @param redraw - asks the runner to redraw.
 * @param rowsBelow - fixed live rows the list must leave beneath itself.
 * @returns the live completion state.
 */
export function createCompletion(
  composer: Composer,
  sources: CompletionSources,
  redraw: () => void,
  rowsBelow: () => number = () => 1,
): Completion {
  let candidates: readonly Candidate[] = []
  let token: Token | undefined
  let cursor = 0
  /** Set when the user dismisses, and cleared as soon as the token changes. */
  let dismissedFor: string | undefined
  /**
   * Guards against a slow directory read landing after the text moved on.
   * Without it, typing quickly shows candidates for a prefix already replaced.
   */
  let generation = 0

  const clear = (): void => {
    candidates = []
    token = undefined
    cursor = 0
  }

  const accept = (candidate: Candidate): void => {
    if (token === undefined) return
    composer.replaceBeforeCursor([...token.text].length, candidate.replace)
    clear()
    // A directory is a waypoint rather than an answer, so the list reopens on it
    // and the next segment can be completed without retyping the separator. So is
    // a command name, which reopens onto its own values.
    //
    // An accepted VALUE reopens onto nothing, and does not need a case here to
    // say so: every replacement ends in a space, and neither token rule reaches
    // past one. `/reasoning high ` is not a completable token, and would not be
    // one even if it were read as a finished value — see {@link argumentCandidates}.
    void refresh().then(redraw)
  }

  const refresh = async (): Promise<void> => {
    // Claimed before anything else, so a lookup still in flight cannot land after
    // this one. Doing it per branch left the case where the token DISAPPEARS —
    // whitespace typed, or the cursor moved away — able to be undone by an earlier
    // read resolving and reviving candidates for a token that is no longer there.
    const mine = generation + 1
    generation = mine
    const found = tokenAt(composer.lineBeforeCursor)
    if (found === undefined) {
      dismissedFor = undefined
      clear()
      return
    }
    if (dismissedFor === found.text) return
    dismissedFor = undefined
    // Cleared BEFORE the await, not after it. Candidates left standing during a
    // directory read belong to the previous token, and a `tab` arriving in that
    // window would replace the wrong number of characters — turning `@` plus a
    // typed `p` into `@@packages/`. Nothing flickers: no redraw happens between
    // here and the result, because the caller draws when this resolves.
    clear()
    const next = found.kind === 'command'
      ? commandCandidates(found.text, sources)
      : found.kind === 'argument'
        ? await argumentCandidates(found, sources)
        : await pathCandidates(found.text, sources)
    // A newer refresh started while this one was reading a directory.
    if (generation !== mine) return
    token = next.length === 0 ? undefined : found
    candidates = next
    cursor = 0
  }

  return {
    view: {
      render(columns, terminalRows = 24) {
        if (candidates.length === 0) return []
        // Clamped to the terminal, not merely derived from it. `chromeWidth`
        // floors at the shared chrome minimum, so below that floor it returns a
        // width WIDER than the terminal it was asked about — and every row here
        // is laid out against it. `compose` has already spent the live region's
        // rows by the time `Screen` re-wraps an overlong row into two, so the
        // region grows past the screen and the next redraw leaves root chrome in
        // scrollback. This is the same correction the status line already
        // carries, for the same reason: a presentation-only minimum independent
        // of the terminal is not a narrower list, it is the duplicate-frame bug.
        const width = Math.max(1, Math.min(columns, chromeWidth(columns)))
        // Six rows are what this list WANTS; what is left of the screen decides
        // what it gets. `terminalRows` is already net of the stream and the
        // composer above, so a ten-row prompt shrinks this list rather than
        // pushing the prompt off the top.
        const capacity = Math.min(VISIBLE_ROWS, terminalRows - Math.max(0, rowsBelow()) - CHROME_ROWS)
        // Nothing at all rather than a row or two of chrome. When the composer has
        // taken the screen, the prompt is what the keystrokes are going to and a
        // list that cannot show a single candidate is not worth a row of it — and
        // one row over budget is not a smaller version of this list, it is the
        // duplicate-frame bug. Typing one more character narrows the candidates
        // and, on a short terminal, that is how the list comes back.
        if (capacity < 1) return []
        const start = Math.min(
          Math.max(0, cursor - capacity + 1),
          Math.max(0, candidates.length - capacity),
        )
        const shown = candidates.slice(start, start + capacity)
        const rows = shown.map((candidate, index) => {
          const selected = start + index === cursor
          const mark = selected ? paint(CURSOR, 'selection-mark') : ' '
          const label = selected
            ? paint(escapeControls(candidate.label), 'selection')
            : escapeControls(candidate.label)
          const note = candidate.note === undefined
            ? ''
            : ` ${paint(escapeControls(candidate.note), 'muted')}`
          // `Math.max(1, …)`, never a floor of eight: the four columns of mark
          // and indent are real, so a floor above what is left of the width
          // draws past the right edge instead of drawing a shorter label.
          return `  ${mark} ${truncateToWidth(`${label}${note}`, Math.max(1, width - 4))}`
        })
        // What is BELOW the window, not what the window omits. `candidates.length -
        // shown.length` is the same number at every scroll position — nine of
        // fifteen commands, still nine with the last one highlighted — which reads
        // as a list that never ends. The rows above are accounted for by the
        // position in the help line rather than by a second marker row, because a
        // completion list shares the live region with the composer.
        const below = candidates.length - (start + shown.length)
        // Cut like every other row. This one is the shortest and was the one
        // left unbounded, so it outgrew the terminal first — `… 14 more` is
        // thirteen columns whatever the width happens to be.
        if (below > 0) {
          rows.push(truncateToWidth(`    ${paint(`… ${String(below)} more`, 'muted')}`, width))
        }
        rows.push(truncateToWidth(
          `    ${paint(helpLine(cursor, candidates.length, Math.max(1, width - 4)), 'muted')}`,
          width,
        ))
        return rows
      },
    },
    get active() {
      return candidates.length > 0
    },
    refresh,
    handleKey(key) {
      if (candidates.length === 0 || key.kind !== 'key') return false
      switch (key.name) {
        case 'up':
          cursor = (cursor - 1 + candidates.length) % candidates.length
          return true
        case 'down':
          cursor = (cursor + 1) % candidates.length
          return true
        // Both submitting gestures are adjudicated the same way, because the
        // modifier chooses how a submission is DELIVERED and must not change
        // what is submitted. Handled only here rather than everywhere: this
        // list is not an overlay, it is part of the composer's own input route,
        // and it still claims only the keys it already claimed.
        //
        // Left out, `ctrl-enter` fell past the list to the composer and sent the
        // half-typed token — `/ent` where `enter` would have completed `/enter `
        // — so the two gestures submitted different text. The fall-through below
        // is what keeps them agreeing: where `enter` declines because the token
        // is already complete, `ctrl-enter` declines too and reaches the
        // composer, which is the point at which there is finally something to
        // route.
        case 'ctrl-enter':
        case 'enter': {
          const candidate = candidates[cursor]
          // Tab explicitly accepts, including the separator on an exact token.
          // Enter only completes: otherwise a bare command's own behavior would
          // require a second Enter just because its name remains listed.
          if (
            candidate === undefined ||
            token === undefined ||
            candidate.replace.trimEnd() === token.text
          ) return false
          accept(candidate)
          return true
        }
        case 'tab': {
          const candidate = candidates[cursor]
          if (candidate !== undefined) accept(candidate)
          return true
        }
        case 'escape':
          // Remembered against the token, so dismissing hides the list for THIS
          // word rather than until the next unrelated keystroke reopens it.
          dismissedFor = token?.text
          clear()
          return true
        default:
          // Every other key is the composer's.
          return false
      }
    },
    invalidate() {
      // Advancing the generation is what abandons an in-flight lookup: its
      // resolution checks `generation !== mine` and drops the result. Clearing
      // alone would leave that lookup free to revive candidates afterwards.
      generation += 1
      dismissedFor = undefined
      clear()
    },
  }
}

/**
 * The list's position and its gestures, dropping whole segments when narrow.
 *
 * The position is what tells a reader that rows scrolled off ABOVE the window: the
 * `… N more` marker below can only speak for the rows under it, and a second marker
 * row would cost the composer a line. It leads the line and is the first thing given
 * up, by the rule `select.ts` already follows — the way out of a list outranks
 * knowing where you are in it.
 * @param cursor - the highlighted candidate, zero-based.
 * @param total - how many candidates are offered.
 * @param columns - room available for the line.
 * @returns the help text that fits.
 */
function helpLine(cursor: number, total: number, columns: number): string {
  const position = `${String(cursor + 1)}/${String(total)}`
  // Whole words all the way down, ending at the bare key name. `esc dism` is not
  // a shorter hint, it is a rendering fault — the same rule the status line
  // follows when it drops a hint rather than cutting one.
  const parts = [position, 'tab/enter complete', 'esc dismiss']
  for (let from = 0; from < parts.length; from += 1) {
    const line = parts.slice(from).join(' \u00b7 ')
    if (displayWidth(line) <= columns) return line
  }
  return displayWidth('esc') <= columns ? 'esc' : ''
}

/**
 * Commands whose name starts with what was typed.
 * @param token - the typed token, including its leading slash.
 * @param sources - where commands come from.
 * @returns the matching candidates, in the registry's order.
 */
function commandCandidates(token: string, sources: CompletionSources): Candidate[] {
  const prefix = token.slice(1).toLowerCase()
  return sources.commands()
    .filter(command => command.name.toLowerCase().startsWith(prefix))
    .map(command => ({
      replace: `/${command.name} `,
      label: `/${command.name}`,
      ...command.description === '' ? {} : { note: command.description },
    }))
}

/**
 * Values the named command accepts, matching what has been typed after it.
 *
 * Offered on the trailing space too, with nothing typed yet, which is the point:
 * accepting `/reasoning` from the command list leaves the cursor after a space,
 * and the levels appear there without a second gesture. Choosing from a list is
 * then the same keystrokes as typing the value, rather than an overlay to open.
 * @param token - the argument token, including the command and its slash.
 * @param sources - where values come from.
 * @returns the matching candidates.
 */
async function argumentCandidates(token: Token, sources: CompletionSources): Promise<Candidate[]> {
  const command = token.command
  if (command === undefined) return []
  const typed = ARGUMENT.exec(token.text)?.groups?.value ?? ''
  const lower = typed.toLowerCase()
  const values = await sources.commandArguments(command)
  const matched = values.filter(offered => offered.value.toLowerCase().startsWith(lower))
  // Nothing is offered once the word is already one of them and nothing longer
  // begins with it. `/reasoning high` is a finished instruction, and a list
  // still standing over it is a popup between the user and the enter key —
  // while a value that is merely a PREFIX of another keeps offering the rest.
  if (matched.length === 1 && matched[0]?.value.toLowerCase() === lower) return []
  return matched
    .map(offered => ({
      // The whole token is replaced, name included, so accepting normalizes the
      // spacing rather than appending to whatever whitespace was typed.
      replace: `/${command} ${offered.value} `,
      label: `/${command} ${offered.value}`,
      ...offered.note === undefined ? {} : { note: offered.note },
    }))
}

/**
 * Directory children matching the segment being typed.
 *
 * Directories sort first and keep their separator, so the next segment continues
 * from where the cursor already is. A leading dot is offered only when one was
 * typed: a completion list is not the place to volunteer `.git`.
 * @param token - the typed token, including its leading `@`.
 * @param sources - where paths come from.
 * @returns the matching candidates.
 */
async function pathCandidates(token: string, sources: CompletionSources): Promise<Candidate[]> {
  const { directory, prefix } = splitPath(token)
  const entries = await sources.paths(directory)
  const lower = prefix.toLowerCase()
  const matched = entries.filter(entry => {
    if (!entry.name.toLowerCase().startsWith(lower)) return false
    return !entry.name.startsWith('.') || prefix.startsWith('.')
  })
  const ordered = [...matched].sort((left, right) => {
    if (left.directory !== right.directory) return left.directory ? -1 : 1
    return left.name.localeCompare(right.name)
  })
  return ordered.map(entry => {
    const path = directory === '' ? entry.name : `${directory}/${entry.name}`
    return {
      replace: entry.directory ? `@${path}/` : `@${path} `,
      label: entry.directory ? `${path}/` : path,
    }
  })
}

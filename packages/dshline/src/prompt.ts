/**
 * A single-line text overlay, for the questions a list cannot answer.
 *
 * {@link promptSelect} covers every interaction whose answer is one of a known
 * set. Configuration is where that stops being true: an API key, a pasted
 * device code, and an account name are all values only the person at the
 * keyboard holds, so something has to take typed text without giving the model
 * a turn.
 *
 * `secret` differs from `text` only in presentation, which is exactly the
 * distinction Harness's authorization vocabulary draws: the value is masked on
 * screen and never echoed into the transcript, but it is the same question.
 * @module dshline/prompt
 */

import type { Context } from '@deepseek-ai/cordis'
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
import { chromeWidth, fitFooterHelp, footerBudget, rootFrame } from './chrome.ts'
import type { TuiOverlay } from './slots.ts'

/**
 * Rows outside the title heading and narrative: leading blank, two borders,
 * spacer, and the field row. The title heading is the body's first row and is
 * counted separately, exactly as Select counts its heading.
 */
const PROMPT_FIXED_ROWS = 5

/**
 * Narrative rows the framed form will not open without, when a message exists.
 *
 * Framing a message-bearing prompt with no room for even one narrative row
 * would drop `spec.message` while the compact fallback just below still showed
 * it: a prompt question that disappears when the terminal grows one row is a
 * message gone from an authorization flow, which is the case this overlay
 * exists to serve. The title now wraps to as many rows as it needs, so this
 * floor is met by computing the leftover space from the title's actual height
 * rather than assuming the title occupies exactly one row.
 */
const PROMPT_MIN_NARRATIVE_ROWS = 1

/** How a typed value is shown back while it is being typed. */
export type PromptKind = 'text' | 'secret'

/** How a prompt overlay is built and what it reports. */
export interface PromptSpec {
  /** Headline shown above the field. */
  title: string
  /** Concise identity shown in the shared root chrome. */
  readonly view?: string
  /** The question itself, wrapped above the field. */
  message: string
  /** Optional supporting text under the question. */
  detail?: string
  /** Whether the typed value is masked. */
  kind: PromptKind
  /**
   * Presentation-only prefill for the field. The validator that understands
   * the answer still owns normalization.
   */
  readonly initial?: string
  /** Greyed text shown while the field is empty. */
  placeholder?: string
  /**
   * Called once with the typed value, or with undefined when the user
   * cancelled. The overlay never calls this twice.
   */
  settle(value: string | undefined): void
  /** Asks the runner to redraw after an edit. */
  invalidate(): void
}

/** The glyph a masked field repeats, one per typed character. */
const MASK = '•'

/**
 * Build a text-entry overlay.
 * @param spec - the question, its presentation, and the settlement callback.
 * @returns the overlay to push onto the slot registry.
 */
export function createPromptOverlay(spec: PromptSpec): TuiOverlay {
  let value = spec.initial ?? ''
  let settled = false
  const settle = (answer: string | undefined): void => {
    // Once-only for the reason the select overlay's is: the registry can deliver
    // one more keystroke between the decision and the unmount.
    if (settled) return
    settled = true
    spec.settle(answer)
  }
  const edit = (next: string): void => {
    value = next
    spec.invalidate()
  }
  return {
    render(columns, terminalRows = 24) {
      const width = chromeWidth(columns)
      const inner = width - BOX_CHROME_COLUMNS
      // The title is the body's semantic heading, exactly as Select keeps its
      // prompt above the list: the border carries only the concise `view`
      // identity, and truncating that must never lose "Sign in · ChatGPT" or
      // "API key · opencode". Wrapping it — and painting each physical row on
      // its own — is what keeps a model-authored question whole; the one-row
      // cut this replaces silently dropped the end of every long question.
      const titleRows = wrapToWidth(escapeControls(spec.title), inner)
        .map(row => paint(row, 'overlay-title'))
      const narrative: string[] = []
      for (const line of escapeControls(spec.message).split('\n')) {
        narrative.push(truncateToWidth(line, inner))
      }
      if (spec.detail !== undefined && spec.detail !== '') {
        for (const line of escapeControls(spec.detail).split('\n')) {
          narrative.push(paint(truncateToWidth(line, inner), 'muted'))
        }
      }
      // The title now owns however many rows it wrapped to, so the message's
      // budget is what is left after them. A prompt that carries a message but
      // has no room for even one narrative row falls back rather than opening a
      // frame that hides the message the compact form still shows.
      const requiredNarrative = spec.message === '' ? 0 : PROMPT_MIN_NARRATIVE_ROWS
      const narrativeCapacity = terminalRows - PROMPT_FIXED_ROWS - titleRows.length
      if (width >= columns || narrativeCapacity < requiredNarrative) {
        return compactFallback(value, spec, columns, terminalRows)
      }
      const frame = [
        '',
        ...rootFrame({
          columns,
          context: paint(escapeControls(spec.view ?? spec.title), 'overlay-title'),
          body: [
            ...titleRows,
            ...narrative.slice(0, narrativeCapacity),
            '',
            fieldRow(value, spec, inner),
          ],
          footer: fitFooterHelp('enter confirm · esc cancel', footerBudget(columns)),
        }),
      ]
      return frame.length <= terminalRows
        ? frame
        : compactFallback(value, spec, columns, terminalRows)
    },
    handleKey(key: Key) {
      if (key.kind === 'text') {
        edit(value + key.text)
        return
      }
      if (key.kind === 'paste') {
        // A pasted value is taken VERBATIM apart from its line breaks, which a
        // one-line field cannot hold. Collapsing runs of space or trimming the
        // ends would be this overlay editing an answer it does not understand:
        // it serves Harness's generic `text` and `secret` prompts, where the
        // value could be a passphrase whose spacing is the secret. Normalizing
        // belongs to whoever knows what the value IS — for an API key that is
        // `normalizeApiKey` at the action boundary, which trims and rejects a
        // character no HTTP header can carry.
        edit(value + key.text.replace(/[\r\n]+/gu, ''))
        return
      }
      switch (key.name) {
        case 'enter':
          settle(value)
          return
        case 'backspace':
          // Code points, not UTF-16 units, so one press deletes one character.
          edit([...value].slice(0, -1).join(''))
          return
        case 'ctrl-u':
          edit('')
          return
        case 'ctrl-w':
          edit(value.replace(/\s*\S*$/u, ''))
          return
        case 'escape':
        case 'ctrl-c':
          settle(undefined)
          return
        default:
          return
      }
    },
  }
}

/** A usable unframed prompt for terminals that cannot hold the shared root. */
function compactFallback(value: string, spec: PromptSpec, columns: number, rows: number): string[] {
  if (rows <= 0) return []
  const width = Math.max(1, columns - 1)
  const lines: string[] = []
  if (rows >= 3) {
    // The message is what a person must read to answer; when there is none —
    // an option-less question carries its text in `title` — the semantic title
    // is the context that must survive the fallback, not vanish with the frame.
    const context = spec.message === '' ? spec.title : spec.message
    const budget = Math.max(1, rows - 2)
    for (const row of wrapToWidth(escapeControls(context), width).slice(0, budget)) {
      lines.push(row)
    }
  }
  lines.push(truncateToWidth(fieldRow(value, spec, width), width))
  if (lines.length < rows) {
    const fitted = fitFooterHelp('enter confirm · esc cancel', width)
    const help = fitted.includes('enter confirm') ? 'enter · esc' : fitted === '' ? '' : 'esc'
    if (help !== '' && displayWidth(help) <= width) lines.push(paint(help, 'muted'))
  }
  return lines.slice(0, rows)
}

/**
 * The field row: a prompt mark, the value or its mask, and a cursor block.
 *
 * A masked field shows one glyph per typed character rather than a fixed run,
 * because the length is the only feedback a person typing a secret has that the
 * keystrokes are arriving at all.
 * @param value - the text typed so far.
 * @param spec - the prompt's presentation.
 * @param inner - the frame's inner width in columns.
 * @returns one row.
 */
function fieldRow(value: string, spec: PromptSpec, inner: number): string {
  const mark = '❯ '
  const room = Math.max(1, inner - displayWidth(mark) - 1)
  if (value === '') {
    const hint = spec.placeholder === undefined
      ? ''
      : paint(truncateToWidth(escapeControls(spec.placeholder), room), 'muted')
    return `${paint(mark, 'prompt-mark')}█${hint}`
  }
  const shown = spec.kind === 'secret'
    ? MASK.repeat([...value].length)
    // Display only: a prefilled value can contain a newline (a stored title),
    // and a newline would let Screen expand one logical row into several. The
    // submitted value keeps its newlines; only what is drawn is flattened.
    : escapeControls(value).replaceAll('\n', ' ')
  // The TAIL is kept, not the head. A person watches the characters they are
  // typing, so a long value scrolls from the left and the cursor stays in view;
  // `truncateToWidth` here would hide exactly what was just typed. One column is
  // held back for the cursor block, and given up only once the value fills the
  // field — at which point the tail itself is what shows where typing continues.
  const fitted = tailToWidth(shown, Math.max(1, room - 1))
  return `${paint(mark, 'prompt-mark')}${fitted}█`
}

/**
 * The wording of a session-rename question, shared by both surfaces that ask
 * it: the `/sessions` browser renames any listed session, and the `/session`
 * hub renames the attached one. Only the QUESTION is shared here — authority
 * over the mutation stays with whichever caller owns it.
 */
export interface SessionTitlePromptCopy {
  /** Headline shown above the field. */
  readonly title: string
  /** Question naming the title being replaced, when there is one. */
  readonly message: string
  /** Prefill: the title being edited, or empty when there is none. */
  readonly initial: string
}

/**
 * Compose the one wording for renaming a session.
 *
 * A pure seam on purpose: what the question says is decidable without a
 * terminal, and both the `/sessions` browser and the `/session` hub read the
 * same answer instead of wording it twice.
 * @param currentTitle - the title the session carries now, if any. An empty
 *   string means the same as absent, because a folded browser row with no title
 *   is not a title to quote.
 * @returns the headline, message, and prefill the prompt shows.
 */
export function sessionTitlePrompt(currentTitle?: string): SessionTitlePromptCopy {
  return {
    title: 'Rename session',
    message: currentTitle === undefined || currentTitle === ''
      ? 'Rename this session'
      : `Rename “${escapeControls(currentTitle)}”`,
    initial: currentTitle ?? '',
  }
}

/** What a caller must supply to put the shared session-rename question up. */
export interface SessionTitlePromptSpec {
  /**
   * The title being edited; absent or empty means the empty-state wording.
   *
   * `undefined` is named explicitly because both callers hold `string |
   * undefined` and, under `exactOptionalPropertyTypes`, a bare optional field
   * would force each of them to spread conditionally for no gain.
   */
  readonly currentTitle?: string | undefined
  /** Concise identity shown in the shared root chrome. */
  readonly view: string
  /** Withdraws the question without an answer, as {@link promptText} documents. */
  readonly signal?: AbortSignal
}

/**
 * Ask for a session title, with the wording both rename surfaces share.
 *
 * Deliberately mutation-free: it returns the draft and never touches
 * `ctx.sessionTitle`, because authority over a session belongs to the caller
 * that holds it. The `/sessions` browser renames a listed session through its
 * own `renameTitle`, and the attached-session hub renames its own Session.
 * @param ctx - context carrying the slot registry.
 * @param spec - the current title, the view label, and an optional signal.
 * @returns the draft title, or undefined when the reader cancelled or the
 *   question was withdrawn.
 */
export async function promptSessionTitle(
  ctx: Context,
  spec: SessionTitlePromptSpec,
): Promise<string | undefined> {
  const copy = sessionTitlePrompt(spec.currentTitle)
  return promptText(ctx, {
    ...copy,
    kind: 'text',
    view: spec.view,
    ...(spec.signal === undefined ? {} : { signal: spec.signal }),
  })
}

/**
 * Ask for one line of text and wait for the answer.
 *
 * The twin of {@link promptSelect}: same push-await-dismiss dance, same
 * once-only settlement, so a caller alternating between a list and a field
 * writes the same three lines for both.
 * @param ctx - context carrying the slot registry.
 * @param spec - the question and its presentation; settlement is this
 *   function's. An optional `signal` takes the question down without an answer,
 *   which is how a Harness authorization flow withdraws the losing half of a
 *   race between a typed code and a browser callback.
 * @returns the typed value, or undefined when the user cancelled or the
 *   question was withdrawn.
 */
export async function promptText(
  ctx: Context,
  spec: Omit<PromptSpec, 'settle' | 'invalidate'> & { signal?: AbortSignal },
): Promise<string | undefined> {
  return new Promise<string | undefined>(resolve => {
    let dismiss = (): void => {}
    let settled = false
    const finish = (value: string | undefined): void => {
      if (settled) return
      settled = true
      dismiss()
      resolve(value)
    }
    const overlay = createPromptOverlay({
      ...spec,
      invalidate: () => { ctx.tuiSlots.invalidate() },
      settle: finish,
    })
    dismiss = ctx.tuiSlots.pushOverlay(overlay)
    if (spec.signal?.aborted === true) finish(undefined)
    else spec.signal?.addEventListener('abort', () => { finish(undefined) }, { once: true })
  })
}

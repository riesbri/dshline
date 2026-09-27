/**
 * Session events to terminal lines.
 *
 * The session log is the source of truth for everything the model saw, so the
 * transcript is a projection of it rather than a record the frontend keeps in
 * parallel. Each committed event becomes lines that are written once into
 * scrollback and never revisited; the streaming reply is the only mutable part
 * and lives in the live region until its `assistant/message` commits it.
 *
 * Every string reaching here came from a model, a tool, or a log, so every
 * string is escaped before it is returned.
 * @module dshline/transcript
 */

import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { escapeControls, hangingIndent, paint } from '@dshline/renderer'

/** Bytes in the binary units used for compact attachment metadata. */
const KIBIBYTE = 1_024
const MEBIBYTE = KIBIBYTE * KIBIBYTE

/** Gutter marks, chosen so a glance separates who produced a line. */
const MARK = {
  user: '›',
  error: '✗',
  note: '·',
} as const

/**
 * Concatenate the text of every text block, dropping non-text blocks.
 * @param content - message content blocks.
 * @returns the joined text, empty when the message carries none.
 */
export function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Compact byte count, in whichever unit keeps the number small.
 *
 * Shared by both attachment kinds so an image and a file of the same size are
 * labelled identically — a second formatter would eventually disagree at a
 * boundary and make two rows of one prompt look like two different sizes.
 * @param bytes - the durable reference's exact byte length.
 * @returns the size with its unit, one decimal place above a kibibyte.
 */
function attachmentSize(bytes: number): string {
  return bytes >= MEBIBYTE
    ? `${(bytes / MEBIBYTE).toFixed(1)} MiB`
    : bytes >= KIBIBYTE
      ? `${(bytes / KIBIBYTE).toFixed(1)} KiB`
      : `${String(bytes)} B`
}

/**
 * Compact presentation of one durable image reference.
 *
 * Reference metadata is sufficient for history layout, so transcript rendering
 * never reads binary content and never exposes the opaque id or provider-owned
 * storage location.
 * @param block - durable Harness image content.
 * @returns one unescaped, presentation-only label.
 */
export function imageLine(block: Extract<ContentBlock, { type: 'image' }>): string {
  const { name, width, height, bytes } = block.attachment
  return `image: ${name ?? 'unnamed'} · ${String(width)}×${String(height)} · ${attachmentSize(bytes)}`
}

/**
 * Compact presentation of one durable verbatim file reference.
 *
 * Everything shown is a field the reference publishes: a display name and an
 * exact byte length. The opaque content-addressed id, the provider's storage
 * location, and any host path are all deliberately absent — this is history
 * that anyone sharing the scrollback will read, and none of those three is
 * information a reader can act on.
 * @param block - durable Harness file content.
 * @returns one unescaped, presentation-only label.
 */
export function fileLine(block: Extract<ContentBlock, { type: 'file' }>): string {
  const { name, bytes } = block.attachment
  return `file: ${name === '' ? 'unnamed' : name} · ${attachmentSize(bytes)}`
}

/**
 * One prompt as the ordered lines its durable blocks describe.
 *
 * Order is the point. Grouping every text block first and every attachment after
 * it was accurate while an ordinary prompt could carry images or nothing; it is
 * a lie the moment one prompt carries a text block, an image, and a file in the
 * order the reader staged them, because the terminal would then show a sequence
 * the session log does not contain and a later replay would quietly disagree
 * with what was watched. So the blocks are walked in place: consecutive text
 * joins into one line, and an attachment flushes whatever text came before it.
 * A text block after an attachment stays after it rather than being hoisted.
 *
 * Blocks this transcript has no presentation for are skipped rather than
 * guessed at, for the same reason `projectEvent` never throws on an unfamiliar
 * event: `ContentBlockMap` is merge-extensible, and a plugin's block is not
 * something to invent a line for.
 * @param content - the message's durable content, in its own order.
 * @returns display lines, unescaped, each one a block or a run of text blocks.
 */
export function userContentLines(content: readonly ContentBlock[]): string[] {
  const lines: string[] = []
  let text = ''
  const flush = (): void => {
    const trimmed = text.trim()
    if (trimmed !== '') lines.push(trimmed)
    text = ''
  }
  for (const block of content) {
    if (block.type === 'text') {
      text += block.text
    } else if (block.type === 'image') {
      flush()
      lines.push(imageLine(block))
    } else if (block.type === 'file') {
      flush()
      lines.push(fileLine(block))
    }
  }
  flush()
  return lines
}

/**
 * Prefix the first row with `mark` and indent every later row to match, so a
 * multi-line message reads as one block however wide the terminal is.
 * @param mark - the gutter mark, without its trailing space.
 * @param text - already-escaped text, may contain newlines.
 * @param columns - the terminal's current width.
 * @returns the marked rows.
 */
function marked(mark: string, text: string, columns: number): string[] {
  return text.split('\n').flatMap((line, index) => hangingIndent(index === 0 ? `${mark} ` : '  ', '  ', line, columns))
}

/**
 * Project one committed session event to lines, or nothing when the event has no
 * terminal representation.
 *
 * Unrecognized event types return nothing rather than throwing: `SessionEventMap`
 * is merge-extensible, so any plugin may add a type this frontend has never seen,
 * and a frontend that failed on one would break the moment a deployment mounted
 * an unfamiliar plugin. `system/message` is silent for a stated reason rather
 * than by falling through, so removing that reason has to be a deliberate edit.
 * @param event - the committed event.
 * @param columns - the terminal's current width.
 * @returns lines to commit to scrollback.
 */
export function projectEvent(event: SessionEvent, columns: number): string[] {
  switch (event.type) {
    case 'user/message': {
      // Only direct human prompts are echoed: synthetic injections (file-change
      // notices, skill bodies, nested AGENTS.md) are model-visible context the
      // user did not type, and echoing them buries the conversation.
      const data = event.data as { content: readonly ContentBlock[]; source?: { kind?: string } }
      if (data.source?.kind !== 'user') return []
      const body = userContentLines(data.content)
      // An attachment-only prompt still produces a visible entry: the file rows
      // ARE the message, so an empty result here would leave a submission the
      // reader made with nothing at all in the scrollback.
      if (body.length === 0) return []
      // A rule above each prompt separates exchanges in a long scrollback.
      const rule = paint('─'.repeat(Math.max(4, Math.min(columns - 2, 100))), 'rule')
      return ['', rule, ...marked(paint(MARK.user, 'user'), escapeControls(body.join('\n')), columns)]
    }
    case 'turn/end': {
      const data = event.data as { reason: { kind: string; error?: { code: string; message: string } } }
      switch (data.reason.kind) {
        case 'error': {
          if (data.reason.error === undefined) return []
          const { code, message } = data.reason.error
          return ['', paint(`${MARK.error} ${escapeControls(code)}: ${escapeControls(message)}`, 'error')]
        }
        // `aborted`, not `canceled`: the tag comes from `TurnEndReasonMap`, and a
        // frontend testing for a name the harness never emits reports nothing at
        // all, so a ctrl-c that visibly stopped a reply left no mark saying why.
        case 'aborted':
          return ['', paint(`${MARK.note} interrupted`, 'warning')]
        // The reply hit the output ceiling and stops mid-sentence. Saying so is the
        // difference between a truncated answer and one that looks finished.
        case 'max-tokens':
          return ['', paint(`${MARK.note} reply reached the output limit`, 'warning')]
        case 'blocked':
          return ['', paint(`${MARK.note} blocked before the model was called`, 'warning')]
        default:
          // `completed` needs no note, and the map is merge-extensible: a reason a
          // plugin adds that this frontend has never seen is not an error.
          return []
      }
    }
    // The rendered system prompt is a surface node since Session format V3, so
    // it reaches this projection like any other append. It contributes nothing
    // on purpose: it is the deployment's standing instructions rather than
    // something said in this conversation, and echoing it would open every fresh
    // and every resumed transcript with a wall of prompt nobody typed. It is
    // inspectable in `/context`, where it is named as the surface node it is.
    case 'system/message':
      return []
    default:
      return []
  }
}

/**
 * The echo of a command line the user submitted.
 *
 * Projected from `command/run` rather than written when the line is submitted,
 * because a resumed session has to show the command too: the result alone tells a
 * reader that something happened without saying what was asked for.
 *
 * Marked as the user's line, because it is one — but without the separator rule a
 * prompt gets. A command is not a conversation turn, and drawing a rule for each
 * one would break a transcript into fragments.
 * @param name - the command name, without its slash.
 * @param args - the verbatim text following the name, if the command records it.
 * @param columns - the terminal's current width.
 * @returns lines to commit to scrollback.
 */
export function commandEcho(name: string, args: string | undefined, columns: number): string[] {
  const line = `/${name}${(args ?? '').trimEnd()}`
  return marked(paint(MARK.user, 'user'), escapeControls(line), columns)
}

/**
 * What one settled command contributes to the transcript.
 *
 * A command runs without a model turn, so this is the ONLY thing that says what it
 * did — there is no reply to read and no card to look at. A failure always speaks,
 * because a command that fails silently is indistinguishable from one that is
 * broken. A success with no text of its own is acknowledged by name rather than
 * passed over: `{ kind: 'success' }` alone is a valid outcome, and the commands
 * that return it are exactly the ones whose effect this frontend cannot otherwise
 * show — so silence there is the same defect one layer down.
 *
 * Marked like the rest of the transcript rather than framed: a command's answer is
 * a note about the session, the same weight as `· interrupted`, and multi-line text
 * — the usage `/goal` prints, the preset list `/permission` prints — is indented
 * under its mark so it reads as one block at any width.
 * @param result - the handler's normalized outcome, as `command/done` carries it.
 * @param name - the command's name, paired from its `command/run`; undefined when
 *   the log begins between the two.
 * @param columns - the terminal's current width.
 * @returns lines to commit to scrollback.
 */
export function commandLines(
  result: { readonly kind: 'success' | 'error'; readonly text?: string },
  name: string | undefined,
  columns: number,
): string[] {
  const text = (result.text ?? '').trim()
  const shown = text === ''
    ? `${name === undefined ? 'command' : `/${name}`} done`
    : text
  const mark = result.kind === 'error' ? MARK.error : MARK.note
  // Styled per ROW, and after marking rather than before it. A style applied to
  // multi-line text puts its reset on the last line only, so the rows between
  // would carry an unterminated colour into whatever is drawn beside them — and
  // styling the mark separately would end the row's colour at the inner reset.
  return marked(mark, escapeControls(shown), columns)
    .map(row => paint(row, result.kind === 'error' ? 'error' : 'muted'))
}

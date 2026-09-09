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
  const size = bytes >= MEBIBYTE
    ? `${(bytes / MEBIBYTE).toFixed(1)} MiB`
    : bytes >= KIBIBYTE
      ? `${(bytes / KIBIBYTE).toFixed(1)} KiB`
      : `${String(bytes)} B`
  return `image: ${name ?? 'unnamed'} · ${String(width)}×${String(height)} · ${size}`
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
      const text = textOf(data.content).trim()
      const images = data.content
        .filter((block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image')
        .map(imageLine)
      if (text === '' && images.length === 0) return []
      // A rule above each prompt separates exchanges in a long scrollback.
      const rule = paint('─'.repeat(Math.max(4, Math.min(columns - 2, 100))), 'rule')
      const body = [...(text === '' ? [] : [text]), ...images].join('\n')
      return ['', rule, ...marked(paint(MARK.user, 'user'), escapeControls(body), columns)]
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

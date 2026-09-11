/**
 * Bounded live-region presentation of durable subagent conversations.
 *
 * Three surfaces over the shared kernel, and the stack IS the navigation model:
 * the catalog opens over `/work`, Enter pushes a conversation inspector over
 * the catalog, and `m`/`s` push a small message composer over that. Escape pops
 * exactly one level, so there is no "sometimes back" state anywhere. None of
 * them writes the transcript: native scrollback stays the transcript, and the
 * inspector draws only the bounded window it read.
 *
 * The composer is the renderer's own `Composer` instance, not a second editor:
 * the same buffer, cursor model, undo semantics, and key handling the main
 * input uses, rendered into this surface's bounded body with a block cursor
 * because a live-region overlay cannot own the terminal caret.
 * @module dshline/subagents/overlay
 */

import type { Role } from '@dshline/renderer'
import {
  chunkToWidth,
  Composer,
  displayWidth,
  escapeControls,
  layoutComposer,
  paint,
  truncateToWidth,
} from '@dshline/renderer'
import { FocusRing } from '../focus.ts'
import { RowViewport } from '../scroll.ts'
import type { TuiOverlay } from '../slots.ts'
import { createBoundedSurface, SurfaceNotice } from '../surface.ts'
import type { HumanPromptDelivery, SubagentPromptOutcome } from './control.ts'
import type {
  SubagentCatalogReading,
  SubagentCatalogRow,
  SubagentChildRow,
} from './model.ts'
import {
  diagnosticReasonWord,
  subagentChildFacts,
  subagentRowKey,
  subagentRowLabel,
  subagentRowOpenable,
} from './model.ts'
import type { SubagentTranscriptReading } from './transcript.ts'
import { transcriptRows } from './transcript.ts'

/** Columns a catalog row spends on its focus gutter and mark. */
const GUTTER_COLUMNS = 4

/**
 * Text width used when a keystroke must resolve rows before the next paint.
 *
 * Key handling needs row identities, never their pixels, and the terminal's
 * real width belongs to `render`. A generous logical width keeps fitting from
 * dropping a fact a narrower guess would remove, which could otherwise change
 * what a key resolves to.
 */
const LOGICAL_WIDTH = 200

/** How long a conversation's outcome notice remains readable. */
export const CONVERSATION_NOTICE_MS = 4_000

/** How long a composer's refusal notice remains readable. */
const MESSAGE_NOTICE_MS = 6_000

/** Inputs the durable-child catalog surface needs from its presenter. */
export interface SubagentCatalogOverlaySpec {
  /** The current discovery reading, fresh on every paint. */
  readonly reading: () => SubagentCatalogReading
  /** Open the conversation inspector for one durable child id. */
  readonly inspect: (childId: string) => void
  /** Re-run discovery. */
  readonly refresh: () => void
  /** Remove this temporary surface. */
  readonly close: () => void
  /** Redraw after a keystroke that changed selection. */
  readonly invalidate: () => void
}

/** One catalog line, kept plain so it is painted exactly once. */
interface CatalogLine {
  /** Focus identity, present exactly when the row can be aimed at. */
  readonly key?: string
  /** The row's text, already escaped and fitted. */
  readonly text: string
  /** Role for the text when the row is not focused. */
  readonly role: Role
  /** The leading mark, already chosen from an authoritative fact. */
  readonly mark?: string
  /** Role for the mark alone. */
  readonly markRole?: Role
}

/**
 * Create the bounded durable-child catalog surface.
 * @param spec - discovery reading, inspection opener, and surface controls.
 * @returns a live-region overlay that never writes the transcript.
 */
export function createSubagentCatalogOverlay(spec: SubagentCatalogOverlaySpec): TuiOverlay {
  const focus = new FocusRing()
  const viewport = new RowViewport()
  return createBoundedSurface<SubagentCatalogReading>({
    reading: spec.reading,
    title: () => 'Subagent conversations',
    compact: reading => catalogCompact(reading),
    footer: () => '↑↓ select · ↵ inspect · r refresh · esc back',
    body: (reading, width, capacity) => {
      const lines = catalogLines(reading, width)
      focus.update(lines.flatMap(line => line.key === undefined ? [] : [line.key]), true)
      viewport.update(lines.length, capacity)
      const at = lines.findIndex(line => line.key !== undefined && line.key === focus.current)
      if (at >= 0) {
        if (at < viewport.start) viewport.move(at - viewport.start)
        if (at >= viewport.end) viewport.move(at - viewport.end + 1)
      }
      return lines.slice(viewport.start, viewport.end).map(line => paintCatalogLine(line, focus.current))
    },
    onKey: (key, reading) => {
      if (key.kind === 'text') {
        if (key.text === 'r') spec.refresh()
        return
      }
      if (key.kind !== 'key') return
      // The focus ring must be built from the SAME lines the body draws,
      // diagnostics included, or arrows would skip a row the reader can see.
      const lines = catalogLines(reading, LOGICAL_WIDTH)
      focus.update(lines.flatMap(line => line.key === undefined ? [] : [line.key]), key.name !== 'enter')
      switch (key.name) {
        case 'up':
          focus.move(-1)
          spec.invalidate()
          return
        case 'down':
          focus.move(1)
          spec.invalidate()
          return
        case 'home':
        case 'ctrl-a':
          focus.first()
          viewport.first()
          spec.invalidate()
          return
        case 'end':
        case 'ctrl-e':
          focus.last()
          viewport.last()
          spec.invalidate()
          return
        case 'enter': {
          const row = readyRows(reading).find(candidate => subagentRowKey(candidate) === focus.current)
          if (row !== undefined && subagentRowOpenable(row)) spec.inspect(row.id)
          else spec.invalidate()
          return
        }
        default:
          return
      }
    },
    close: spec.close,
  })
}

/** Inputs the read-only conversation inspector needs from its presenter. */
export interface SubagentConversationOverlaySpec {
  /** The durable child being inspected, read fresh so a refresh updates its facts. */
  readonly child: () => SubagentChildRow
  /** The current transcript reading, fresh on every paint. */
  readonly reading: () => SubagentTranscriptReading
  /** Whether a human queue/steer follow-up is authorized. */
  readonly followUp: boolean
  /** Whether a human steer is authorized. */
  readonly steer: boolean
  /** Whether the child may be interrupted. */
  readonly interruptible: boolean
  /** Read one older page if the child has one. */
  readonly loadOlder: () => void
  /** Re-read the newest page. */
  readonly refresh: () => void
  /** Open the message composer with this delivery. */
  readonly message: (delivery: HumanPromptDelivery) => void
  /** Interrupt the addressed child through the shared Work adapter. */
  readonly interrupt: () => void
  /** The presenter-owned outcome notice. */
  readonly notice: SurfaceNotice
  /** Remove this temporary surface. */
  readonly close: () => void
  /** Redraw after a keystroke that scrolled or acted. */
  readonly invalidate: () => void
}

/**
 * Create the bounded read-only conversation inspector.
 * @param spec - the addressed child, transcript reading, and surface controls.
 * @returns a live-region overlay that never resumes the child or writes scrollback.
 */
export function createSubagentConversationOverlay(spec: SubagentConversationOverlaySpec): TuiOverlay {
  const viewport = new RowViewport()
  return createBoundedSurface<SubagentTranscriptReading>({
    reading: spec.reading,
    title: () => `Subagent · ${subagentRowLabel(spec.child())}`,
    compact: () => `Subagent · ${subagentRowLabel(spec.child())}`,
    notice: spec.notice,
    body: (reading, width, capacity) => {
      const header = conversationHeader(spec.child(), reading, width)
      const remaining = Math.max(0, capacity - header.length)
      const rows = transcriptRows(reading, width)
      viewport.update(rows.length, remaining)
      const end = Math.min(rows.length, viewport.start + remaining)
      return [
        ...header.slice(0, capacity),
        ...remaining === 0 ? [] : rows.slice(viewport.start, end),
      ]
    },
    footer: reading => conversationHelp(spec, reading),
    onKey: key => {
      if (key.kind === 'text') {
        switch (key.text) {
          case 'm':
            if (spec.followUp) spec.message('queue')
            return
          case 's':
            if (spec.steer) spec.message('steer')
            return
          case 'k':
            if (spec.interruptible) spec.interrupt()
            return
          case 'r':
            spec.refresh()
            return
          case '[':
            spec.loadOlder()
            return
          default:
            return
        }
      }
      if (key.kind !== 'key') return
      switch (key.name) {
        case 'up':
          viewport.move(-1)
          spec.invalidate()
          return
        case 'down':
          viewport.move(1)
          spec.invalidate()
          return
        case 'home':
        case 'ctrl-a':
          viewport.first()
          spec.invalidate()
          return
        case 'end':
        case 'ctrl-e':
          viewport.last()
          spec.invalidate()
          return
        default:
          return
      }
    },
    close: spec.close,
  })
}

/** Inputs the bounded message composer needs from its presenter. */
export interface SubagentMessageOverlaySpec {
  /** The addressed child's display name. */
  readonly childLabel: string
  /** Which Harness scheduling this message asks for. */
  readonly delivery: HumanPromptDelivery
  /** Deliver through Harness's human prompt authority. */
  readonly submit: (
    text: string,
    signal: AbortSignal,
  ) => Promise<SubagentPromptOutcome>
  /** Called once with the accepted receipt, before the surface closes. */
  readonly onAccepted: (messageId: string) => void
  /** Remove this temporary surface. */
  readonly close: () => void
  /** Redraw after an edit or a submission edge. */
  readonly invalidate: () => void
}

/**
 * Create the bounded text composer for one human follow-up.
 *
 * The buffer is the renderer's `Composer`. On Enter the composer clears its own
 * buffer, so this surface restores the submitted text while the call is in
 * flight and only leaves it cleared once Harness accepted — a refusal keeps the
 * draft and shows Harness's own reason.
 * @param spec - the addressed child, delivery, submission, and surface controls.
 * @returns a live-region overlay that never writes the transcript.
 */
export function createSubagentMessageOverlay(spec: SubagentMessageOverlaySpec): TuiOverlay {
  const composer = new Composer()
  const controller = new AbortController()
  const notice = new SurfaceNotice(MESSAGE_NOTICE_MS)
  let pending = false
  let closed = false
  return createBoundedSurface<{ readonly pending: boolean }>({
    reading: () => ({ pending }),
    title: () => `${spec.delivery === 'queue' ? 'Follow-up' : 'Steer'} · ${spec.childLabel}`,
    compact: () => spec.delivery === 'queue' ? 'Follow-up' : 'Steer',
    notice,
    footer: () => 'enter send · esc cancel',
    body: (_reading, width, capacity) => composerBody(composer, width, capacity, spec.delivery),
    onKey: key => {
      if (pending) return
      const action = composer.handle(key)
      if (action.kind === 'changed') {
        spec.invalidate()
        return
      }
      if (action.kind === 'ignored') return
      const text = action.text
      // `handle` already cleared the buffer. Restore it while Harness decides so
      // the draft is visibly retained until acceptance, which is the only
      // moment this surface may clear it.
      composer.set(text)
      pending = true
      notice.show('Sending…')
      spec.invalidate()
      void spec.submit(text, controller.signal).then(outcome => {
        if (closed) return
        pending = false
        switch (outcome.kind) {
          case 'accepted':
            composer.clear()
            spec.onAccepted(outcome.messageId)
            spec.close()
            return
          case 'unavailable':
            notice.show('Subagent follow-up is not available in this profile.', true)
            break
          case 'failed':
            notice.show(outcome.message, true)
            break
        }
        spec.invalidate()
      })
    },
    close: spec.close,
    dispose: () => {
      closed = true
      controller.abort()
    },
  })
}

/** Render every catalog line for one reading. */
function catalogLines(reading: SubagentCatalogReading, width: number): CatalogLine[] {
  switch (reading.kind) {
    case 'unavailable':
      return [{ text: 'Subagent discovery is not installed in this profile.', role: 'muted' }]
    case 'loading':
      return [{ text: 'Listing subagent children…', role: 'muted' }]
    case 'failed':
      // The message is untrusted Harness/transport text: it can carry an ESC or
      // OSC sequence and can wrap. Escape it before measuring and bound it to
      // the row's own budget, exactly as the transcript and session panels do.
      return [{
        text: truncateToWidth(
          escapeControls(`Discovery failed: ${reading.message}`),
          Math.max(1, width - GUTTER_COLUMNS),
        ),
        role: 'error',
      }]
    case 'ready':
      if (reading.rows.length === 0) {
        return [{ text: 'No durable subagent children were discovered.', role: 'muted' }]
      }
      return reading.rows.map(row => catalogLine(row, width))
  }
}

/** One catalog row as a plain line, with marks chosen from Harness facts. */
function catalogLine(row: SubagentCatalogRow, width: number): CatalogLine {
  if (row.kind === 'diagnostic') {
    return {
      key: subagentRowKey(row),
      text: fitFacts(subagentRowLabel(row), [diagnosticReasonWord(row.reason)], width - GUTTER_COLUMNS),
      role: 'warning',
      mark: '!',
      markRole: 'warning',
    }
  }
  return {
    key: subagentRowKey(row),
    text: fitFacts(subagentRowLabel(row), subagentChildFacts(row), width - GUTTER_COLUMNS),
    role: 'subdued',
    // A filled mark reports a session-store residency, never execution; the
    // colour stays neutral so the row cannot be read as a running spinner.
    mark: row.residency === 'resident' ? '●' : '·',
    markRole: 'subdued',
  }
}

/** The rows of a ready reading, or none for any other reading. */
function readyRows(reading: SubagentCatalogReading): readonly SubagentCatalogRow[] {
  return reading.kind === 'ready' ? reading.rows : []
}

/** Paint one catalog line; the focused row replaces the mark gutter. */
function paintCatalogLine(line: CatalogLine, focus: string | undefined): string {
  const focused = line.key !== undefined && line.key === focus
  if (focused) return paint(`❯ ${line.text}`, 'selection')
  const body = line.mark === undefined
    ? paint(line.text, line.role)
    : `${paint(line.mark, line.markRole ?? line.role)} ${paint(line.text, line.role)}`
  return `  ${body}`
}

/** Fit a name and its facts by dropping whole facts, never cutting one. */
function fitFacts(name: string, facts: readonly string[], width: number): string {
  const escaped = escapeControls(name)
  const remaining = facts.map(fact => escapeControls(fact))
  const render = (): string => [escaped, ...remaining].join(' · ')
  while (remaining.length > 0 && displayWidth(render()) > width) remaining.pop()
  return truncateToWidth(render(), Math.max(1, width))
}

/** The one-row geometry backstop for the catalog. */
function catalogCompact(reading: SubagentCatalogReading): string {
  switch (reading.kind) {
    case 'unavailable':
      return 'Subagents unavailable'
    case 'loading':
      return 'Loading subagents'
    case 'failed':
      return 'Subagent listing failed'
    case 'ready':
      return reading.rows.length === 0 ? 'No subagent children' : `Subagents ${String(reading.rows.length)}`
  }
}

/** The fixed header rows every conversation inspector shows. */
function conversationHeader(
  child: SubagentChildRow,
  reading: SubagentTranscriptReading,
  width: number,
): string[] {
  const facts = subagentChildFacts(child).join(' · ')
  return [
    paint(truncateToWidth(escapeControls(subagentRowLabel(child)), Math.max(1, width)), 'overlay-title'),
    paint(truncateToWidth(escapeControls(facts), Math.max(1, width)), 'muted'),
    paint(truncateToWidth(`session  ${escapeControls(child.id)}`, Math.max(1, width)), 'subdued'),
    // Staleness is a hint, never an action: a child event arrived after this
    // window was read, and only the reader's explicit refresh re-reads it.
    ...reading.kind === 'ready' && reading.stale
      ? [paint(truncateToWidth('new events · r refresh', Math.max(1, width)), 'warning')]
      : [],
    '',
  ]
}

/** The truthful help for the inspector and its current authority. */
function conversationHelp(spec: SubagentConversationOverlaySpec, reading: SubagentTranscriptReading): string {
  const older = reading.kind === 'ready' && reading.hasOlder ? ['[ older'] : []
  return [
    '↑↓ scroll',
    ...older,
    ...spec.followUp ? ['m message'] : [],
    ...spec.steer ? ['s steer'] : [],
    ...spec.interruptible ? ['k interrupt'] : [],
    'r refresh',
    'esc back',
  ].join(' · ')
}

/** The composer's bounded body: a delivery hint, then the live draft. */
function composerBody(
  composer: Composer,
  width: number,
  capacity: number,
  delivery: HumanPromptDelivery,
): string[] {
  const hint = delivery === 'queue'
    ? 'Queued as the child’s next turn.'
    : 'Steers the nearest step; starts a turn when the child is idle.'
  const layout = layoutComposer(composer, width, () => '❯ ')
  const rows = layout.rows.map((row, index) => index === layout.cursorRow
    ? blockCursor(row, layout.cursorColumn, width)
    : row)
  const body = [
    paint(truncateToWidth(escapeControls(hint), Math.max(1, width)), 'muted'),
    '',
    ...rows.map(row => escapeControls(row)),
  ]
  return body.slice(0, Math.max(0, capacity))
}

/**
 * Draw a block caret at the composer's own cursor column.
 *
 * A live-region overlay cannot place the terminal caret, so the editor's
 * placement is drawn into the row instead. The block is inserted before the
 * character at the cursor and the row is re-clamped to its width, so the frame
 * never gains a wrapped row from the caret itself.
 * @param row - one laid-out composer row, gutter included.
 * @param column - the cursor's display column on that row.
 * @param width - display columns available.
 * @returns the row with a block caret.
 */
function blockCursor(row: string, column: number, width: number): string {
  const left = column <= 0 ? '' : (chunkToWidth(row, column)[0] ?? '')
  const marked = `${left}█${row.slice(left.length)}`
  return displayWidth(marked) <= width ? marked : truncateToWidth(marked, Math.max(1, width))
}

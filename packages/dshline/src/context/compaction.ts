/**
 * Native presentation of Harness compaction.
 *
 * `/compact` stays a REGISTERED Harness command — dshline neither registers a
 * local one nor calls `ctx.compaction` — so what this module adds is
 * presentation. The generic command result already says something ("Compacted
 * 27 history items (~95000 tokens)."), but only for a manual run, and only as
 * prose this frontend would have to parse to do anything with. The
 * `compaction/*` events carry the same facts structurally and are logged for
 * an AUTOMATIC compaction too, which the command lifecycle never sees.
 *
 * So the note is projected from the durable event, and the command's own text
 * is suppressed through the correlation Harness publishes for exactly this
 * purpose: a successful `command/done` names the `sourceEventSeq` whose domain
 * event owns the richer presentation. Nothing here reads the result text.
 * @module dshline/context/compaction
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { formatTokens, hangingIndent, paint } from '@dshline/renderer'
// Type-only: activates the `compaction/*` SessionEventMap merge. The compaction
// backend is an optional per-agent plugin — the shipped `minimal` preset mounts
// none — so this is a devDependency and never a peer, and nothing here imports
// a value from it.
import type {} from '@deepseek-ai/dsh-compaction/types'

/** What one compaction event contributes to the transcript. */
export interface CompactionNote {
  /** Lines to commit; empty when this event is not one a reader needs. */
  readonly lines: readonly string[]
  /**
   * The durable seq whose richer presentation these lines ARE, so a later
   * `command/done` citing it can stay silent instead of repeating it.
   */
  readonly presentedSeq: number | undefined
}

/** Nothing to say about this event. */
const SILENT: CompactionNote = { lines: [], presentedSeq: undefined }

/** What one compaction summary structurally says, independent of presentation. */
export interface CompactionSummaryFact {
  /** How many history entries the summary replaced. */
  readonly entries: number
  /**
   * The replaced content's estimated price, phrased as `~95k replaced`.
   *
   * Shared rather than rebuilt by each caller so the durable note and the
   * transient attention notice cannot drift about what the number means.
   */
  readonly replaced: string
}

/**
 * The structural fact a `compaction/summary` carries.
 *
 * `shadowedTokenCount` is documented as the shadowed content's price under the
 * meter's fixed estimator, not a provider count, so the `~` is part of the
 * fact rather than a rendering choice.
 * @param event - the committed event.
 * @returns the summary fact, or undefined for every other event.
 */
export function compactionSummaryFact(event: SessionEvent): CompactionSummaryFact | undefined {
  if (event.type !== 'compaction/summary') return undefined
  const entries = event.data.shadowedSeqs.length
  return { entries, replaced: `~${formatTokens(event.data.shadowedTokenCount)} replaced` }
}

/**
 * Project one compaction lifecycle event.
 *
 * A summary is the one event worth a permanent row: the model's working
 * context materially changed, older exchanges are no longer in it, and the
 * durable log records that, so a resumed session shows the same row in the
 * same place rather than a transcript that quietly disagrees with the model's
 * history.
 *
 * `compaction/start` and a successful `compaction/end` are deliberately not
 * shown. They bracket a transaction whose only user-visible consequence the
 * summary row already states, and a three-row trace per compaction is the
 * backend's bookkeeping rather than something a reader needs.
 *
 * `compaction/prune` is not shown either. It reduces ONE oversized tool result
 * in place — the surface node stays that tool's result — so it changes no
 * exchange the reader can see, and a row for every oversized tool output would
 * be noise on exactly the sessions that are already busiest. It is still
 * visible where it matters: `/context` marks that entry as `replaced` — which
 * is all the log proves, since a replacement is not by itself a reduction.
 * @param event - the committed event.
 * @param columns - the terminal's current width.
 * @returns lines to commit and the seq they present.
 */
export function compactionNote(event: SessionEvent, columns: number): CompactionNote {
  if (event.type === 'compaction/summary') {
    const fact = compactionSummaryFact(event)
    if (fact === undefined) return SILENT
    const items = `${String(fact.entries)} ${fact.entries === 1 ? 'entry' : 'entries'}`
    // A manual run was asked for and its command line is already echoed above,
    // so it needs no subject; an automatic one arrived unbidden and does.
    const text = event.data.sourceCommandId === undefined
      ? `context compacted automatically · ${items} · ${fact.replaced}`
      : `compacted ${items} · ${fact.replaced}`
    return {
      lines: note(text, columns, 'muted'),
      presentedSeq: event.seq,
    }
  }
  if (event.type === 'compaction/end') {
    // A manual failure is reported by `command/done`, with the backend's own
    // classified reason; repeating it here would print it twice. An AUTOMATIC
    // failure has no such voice, and it matters: pressure the agent tried to
    // relieve is still there.
    if (event.data.error === undefined || event.data.sourceCommandId !== undefined) return SILENT
    return {
      lines: note('automatic context compaction did not complete', columns, 'warning'),
      presentedSeq: undefined,
    }
  }
  return SILENT
}

/** One muted transcript note, marked and indented like every other one. */
function note(text: string, columns: number, role: 'muted' | 'warning'): string[] {
  return hangingIndent('· ', '  ', text, columns).map(row => paint(row, role))
}

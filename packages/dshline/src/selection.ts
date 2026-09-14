/**
 * Remembering a model selection past the end of the session.
 *
 * `/model` and `/reasoning` both write the same mutable ref, which the agent
 * reads per step — that is what makes a switch take effect, and it is entirely
 * in memory. Persisting is a second, separate act: it writes the harness's
 * `agent-default-model` settings section, which is the document every surface in
 * the deployment reads. A model chosen here is therefore the one the web
 * interface opens with, and one chosen there is the one the next terminal
 * session starts on.
 *
 * Kept apart from both commands because it belongs to neither: the selection is
 * one fact with two commands editing different halves of it, and the whole of it
 * is what gets stored.
 * @module dshline/selection
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { escapeControls } from '@dshline/renderer'

/**
 * How one selection command ended, in words the transcript can carry.
 *
 * `/model` and `/reasoning` used to return a bare string for both an applied
 * change and a refused instruction, so a caller could not choose an error mark
 * without reading the sentence. The producer knows which happened, so it says
 * so. `undefined` still means the picker was dismissed: that is no outcome at
 * all, not a third kind.
 *
 * The distinction is about the live selection alone. A `done` whose message
 * notes that the default could not be saved is still `done`: the write to the
 * ref already happened, so the next turn uses the new selection, and the note
 * is about a later session. Persistence is deliberately not part of this
 * verdict.
 */
export interface SelectionOutcome {
  /** Whether the requested change reached the live selection. */
  readonly kind: 'done' | 'failed'
  /** What happened, already worded for a reader. */
  readonly message: string
}

/**
 * Store a selection as the default for sessions that come after this one.
 *
 * Never throws, and deliberately never undoes the in-memory switch on failure.
 * The two are independent: the model HAS changed for this session by the time
 * this runs, and a settings document that could not be written is a reason to
 * say so, not a reason to pretend the turn will use the old model.
 *
 * The note is claimed only when a settings provider is mounted to receive the
 * write. Without one the service keeps its composition entry and resolves
 * anyway, so announcing a saved default would be announcing something that will
 * not survive the process.
 * @param ctx - context carrying the default-model service, when one is mounted.
 * @param selection - the complete selection to store, route and effort together.
 * @returns a phrase to append to the command's own report, or undefined when
 *   there is nothing worth adding.
 */
export async function rememberSelection(
  ctx: Context,
  selection: ModelSelection,
): Promise<string | undefined> {
  const defaults = ctx.get('agentDefaultModel')
  if (defaults === undefined) return undefined
  try {
    await defaults.saveSelection(selection)
  } catch (error: unknown) {
    // The message can carry a filesystem path, so it is made safe like any other
    // text this frontend did not compose itself.
    const reason = error instanceof Error ? error.message : String(error)
    return `could not save it as the default: ${escapeControls(reason)}`
  }
  return ctx.get('settings') === undefined ? undefined : 'also the default for new sessions'
}

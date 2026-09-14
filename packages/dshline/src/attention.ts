/**
 * Transient emphasis for the status line.
 *
 * Every change this highlights already has an authoritative record. Compaction
 * and permission changes are Harness-backed durable Session events that replay
 * with the session; a model or reasoning change is applied to the local
 * selection and acknowledged in committed native scrollback for this window. In
 * every case a busy agent can scroll the acknowledgement away within seconds, so
 * the change can happen off-screen. This module adds a short-lived reading that
 * borrows the status line's activity segment for a few seconds and then yields
 * it back — emphasis, never a second record.
 *
 * Three rules keep it from becoming something else:
 *
 * - A notice only ever describes a fact an authoritative source already
 *   established. It is derived from a Harness session event or from the
 *   before/after of a selection the frontend actually applied, never from
 *   command-result prose.
 * - Event-derived notices are read ONLY from the live `session/event` path.
 *   The shared history projector stays pure, so replaying an old compaction or
 *   permission switch never claims it just happened.
 * - There is one slot. A newer notice replaces the older one outright and gets
 *   a fresh lifetime; nothing queues, and nothing is resurrected.
 * @module dshline/attention
 */

import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: activates the `permission/preset` SessionEventMap merge. The
// permission-preset backend is an optional per-agent plugin — the shipped
// `minimal` preset mounts none — so this is a devDependency and never a peer,
// and nothing here imports a value from it.
import type {} from '@deepseek-ai/dsh-permission-presets'
import { compactionSummaryFact } from './context/compaction.ts'

/**
 * One status-line emphasis.
 *
 * Presentation data only: the text is composed here, the renderer decides how
 * to style it, and nothing persists or replays it.
 */
export interface AttentionNotice {
  /** The complete segment to draw, already phrased for a reader. */
  readonly text: string
}

/**
 * How long a notice occupies the status line.
 *
 * Long enough to read one short phrase after looking up from the transcript,
 * short enough that it cannot be mistaken for a persistent mode. Deliberately
 * not configurable: a setting for four seconds of transient chrome would cost
 * more attention than it saves.
 */
export const ATTENTION_DURATION_MS = 4_000

/** The attachment-scoped owner of the single attention slot. */
export interface AttentionController {
  /** The notice to draw right now, read fresh on every status frame. */
  current(): AttentionNotice | undefined
  /**
   * Replace the current notice, restarting the lifetime. `undefined` is
   * ignored rather than clearing, so a caller may pass a helper's result
   * directly.
   * @param notice - the notice to show.
   */
  show(notice: AttentionNotice | undefined): void
  /** Cancel the pending deadline and forget the notice. Idempotent. */
  dispose(): void
}

/**
 * Create the one notice slot for an attachment.
 *
 * The slot owns a single timeout, never a scheduler: showing cancels the prior
 * deadline and starts a fresh one, so an older callback cannot fire and retire
 * the notice that replaced it. The deadline is unref'd so a countdown never
 * keeps the process alive on its own.
 * @param draw - request a live-region repaint; called on show and on expiry.
 * @returns the controller the attachment registers with its session scope.
 */
export function createAttentionController(draw: () => void): AttentionController {
  let notice: AttentionNotice | undefined
  let timer: NodeJS.Timeout | undefined
  let closed = false

  // Cancelling the prior deadline is what makes latest-wins safe: an older
  // callback never runs, so it cannot retire the notice that replaced it. There
  // is no queue and no second slot to reconcile.
  const clear = (): void => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  return {
    current: () => notice,
    show: next => {
      if (next === undefined || closed) return
      clear()
      notice = next
      draw()
      timer = setTimeout(() => {
        timer = undefined
        if (closed) return
        notice = undefined
        draw()
      }, ATTENTION_DURATION_MS)
      // The optional call is for timer implementations without Node's `unref`;
      // where it exists, a countdown must not keep the process alive.
      timer.unref?.()
    },
    dispose: () => {
      closed = true
      clear()
      notice = undefined
    },
  }
}

/**
 * The notice a model-route change earns, if the route actually moved.
 *
 * Provider and model are compared, and nothing else: the reasoning effort
 * travels with the route but is not itself a route change, and a `done` from
 * the picker is a successful operation rather than a state transition. A first
 * selection, where there was no route before, is a change too.
 * @param before - the route in force before the selection ran.
 * @param after - the route in force after it.
 * @returns the notice, or undefined when the route is unchanged.
 */
export function modelRouteAttention(
  before: ModelSelectionRef['current'],
  after: ModelSelectionRef['current'],
): AttentionNotice | undefined {
  if (after === undefined) return undefined
  if (
    before !== undefined &&
    before.provider === after.provider &&
    before.model === after.model
  ) {
    return undefined
  }
  return { text: `model → ${after.provider}/${after.model}` }
}

/**
 * The notice a reasoning-effort change earns, if the stored effort moved.
 *
 * The comparison is the stored selection, not the adapter's advertised default:
 * an absent effort and the provider's own default are distinct facts, and only
 * the stored one changing is a state transition worth showing.
 * @param before - the effort stored before the instruction.
 * @param after - the effort stored after it.
 * @returns the notice, or undefined when the stored effort is unchanged.
 */
export function reasoningAttention(
  before: string | undefined,
  after: string | undefined,
): AttentionNotice | undefined {
  if (before === after) return undefined
  // An absent effort is not `off` or any advertised level: it restores whatever
  // the provider does when nothing is set, which is what the phrase names.
  return { text: `reasoning → ${after ?? 'provider default'}` }
}

/**
 * The notice one LIVE session event earns, or undefined for every other event.
 *
 * Called only from the attachment's `session/event` listener. The shared
 * history projector must never call it, because a resumed session replays old
 * compactions and permission switches through that projector and must not
 * flash them as if they had just happened.
 *
 * Two structured domains, deliberately not a registry: a compaction summary is
 * the model's working context materially changing, and a `permission/preset` is
 * the one durable event Harness publishes precisely to carry the user's chosen
 * preset. The knob events that follow a preset switch are ignored — they are
 * the same user change, and one change gets one notice.
 * @param event - one committed event delivered on the live path.
 * @returns the notice, or undefined when this event earns none.
 */
export function liveSessionAttention(event: SessionEvent): AttentionNotice | undefined {
  if (event.type === 'permission/preset') {
    return { text: `permission → ${event.data.preset}` }
  }
  const compaction = compactionSummaryFact(event)
  return compaction === undefined ? undefined : { text: `context compacted · ${compaction.replaced}` }
}

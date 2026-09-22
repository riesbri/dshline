/**
 * Pure vocabulary for the current-session hub.
 *
 * The hub receives its current reading from its owner. It neither opens a
 * Session nor derives facts from a log: that keeps this presentation reusable
 * for attached sessions and for capability-limited launch states.
 * @module dshline/session/model
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionFact } from '../sessions/model.ts'

/** The current session reading supplied fresh by the owning attachment. */
export type CurrentSessionReading =
  /** An attachment is active and can identify the session for child views. */
  | {
    /** The current session's stable identity. */
    readonly sessionId: SessionId
    /** Folded or otherwise authoritative title, when there is one. */
    readonly title?: string
    /**
     * Facts already supplied by the owner, in its chosen display order.
     *
     * The shared {@link SessionFact} vocabulary rather than a hub-only copy:
     * the label/value shape is the same presentation fact the Sessions detail
     * surface draws, and a second spelling would be free to drift.
     */
    readonly facts?: readonly SessionFact[]
  }
  /** No attachment currently supplies a current session. */
  | { readonly sessionId: undefined }

/** Capability state the owner has already established for the current window. */
export interface CurrentSessionHubCapabilities {
  /** Within-session event search is available and suitable for human use. */
  readonly findConversation: boolean
  /** The owner can open the authoritative current-session turns surface. */
  readonly turns: boolean
  /** The current session's lineage can be read and presented. */
  readonly lineage: boolean
  /** The owner can collect and submit a replacement title. */
  readonly rename: boolean
}

/** A user-visible action offered by the current-session hub. */
export interface CurrentSessionHubAction {
  /** Stable identity used by selection and accelerator routing. */
  readonly kind: 'find' | 'turns' | 'lineage' | 'rename'
  /** The direct accelerator shown to the reader. */
  readonly accelerator: 'f' | 't' | 'l' | 'r'
  /** The action's complete human-facing label. */
  readonly label: 'Find in conversation' | 'Turns' | 'Lineage' | 'Rename'
}

/** Static definitions ordered by the menu's information hierarchy. */
const ACTIONS: readonly CurrentSessionHubAction[] = [
  { kind: 'find', accelerator: 'f', label: 'Find in conversation' },
  { kind: 'turns', accelerator: 't', label: 'Turns' },
  { kind: 'lineage', accelerator: 'l', label: 'Lineage' },
  { kind: 'rename', accelerator: 'r', label: 'Rename' },
]

/**
 * Return only actions that this window can honestly offer.
 * @param capabilities - capability state owned by the caller.
 * @returns enabled actions in stable menu order.
 */
export function currentSessionHubActions(
  capabilities: CurrentSessionHubCapabilities,
): readonly CurrentSessionHubAction[] {
  return ACTIONS.filter(action => capabilities[
    action.kind === 'find'
      ? 'findConversation'
      : action.kind
  ])
}

/**
 * Find one currently offered action by its accelerator or stable identity.
 * @param actions - enabled actions in display order.
 * @param value - a key name or accelerator.
 * @returns the matching action, when currently enabled.
 */
export function currentSessionHubAction(
  actions: readonly CurrentSessionHubAction[],
  value: CurrentSessionHubAction['kind'] | CurrentSessionHubAction['accelerator'],
): CurrentSessionHubAction | undefined {
  return actions.find(action => action.kind === value || action.accelerator === value)
}

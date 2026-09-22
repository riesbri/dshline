/**
 * Pure vocabulary for the current-session hub.
 *
 * The hub receives its current reading from its owner. It neither opens a
 * Session nor derives facts from a log: that keeps this presentation reusable
 * for attached sessions and for capability-limited launch states.
 * @module dshline/session/model
 */

import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionFact } from '../sessions/model.ts'
import { relativeAge, shortWorkspace } from '../sessions/model.ts'

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

/**
 * Everything {@link currentSessionReading} reads, already resolved by the owner.
 *
 * Every value here is an authoritative answer the owning attachment has
 * established — a projection's stats, the title service's fold, the user's
 * home directory, the clock. This module deliberately receives none of those
 * services: it must stay usable by any owner (attached, launch state, tests)
 * without importing Context, Agent lifecycle, projections, or overlays.
 */
export interface CurrentSessionReadingInput {
  /** The open session: only its identity and immutable header are read. */
  readonly session: Pick<Session, 'id' | 'header'>
  /** Folded or otherwise authoritative title, when there is one. */
  readonly title: string | undefined
  /** Authoritative turn/step totals, once a projection has produced them. */
  readonly stats: { readonly turns: number; readonly steps: number } | undefined
  /** The user's home directory, for shortening the workspace path. */
  readonly home: string | undefined
  /** Current time in milliseconds, for the relative age. */
  readonly now: number
}

/**
 * Build the current-session reading from values the owner already resolved.
 *
 * Pure: nothing here opens a session, counts events, or asks a service, so the
 * facts are exactly the answers that were handed in. A fact that was not
 * answered disappears rather than reading `unknown`, and the Workspace fact
 * comes only from `header.cwd` — the process's own working directory is never
 * a substitute for a header that records none (a legacy session has no cwd,
 * and showing the folder this process happened to start in would claim a
 * workspace the session never had).
 *
 * Order is fixed because a short terminal keeps a prefix of it: workspace and
 * times are how a person recognises a session, the id is what they quote
 * elsewhere, so the session id is always last.
 * @param input - the resolved session, title, stats, home directory, and clock.
 * @returns the reading, with `title` omitted when undefined and facts always present.
 */
export function currentSessionReading(input: CurrentSessionReadingInput): CurrentSessionReading {
  const header = input.session.header
  return {
    sessionId: input.session.id,
    ...(input.title === undefined ? {} : { title: input.title }),
    facts: [
      // `?? header.cwd`: shortWorkspace only returns undefined for an empty
      // path, and an empty recorded cwd is still what the header says.
      ...(header.cwd === undefined
        ? []
        : [{ label: 'Workspace', value: shortWorkspace(header.cwd, input.home) ?? header.cwd }]),
      { label: 'Created', value: relativeAge(header.createdAt, input.now) },
      ...(header.agentPreset === undefined
        ? []
        : [{ label: 'Preset', value: header.agentPreset }]),
      ...(input.stats === undefined
        ? []
        : [{
          label: 'Activity',
          value: `${String(input.stats.turns)} turns · ${String(input.stats.steps)} steps`,
        }]),
      ...(header.parentSession === undefined
        ? []
        : [{ label: 'Parent', value: String(header.parentSession) }]),
      { label: 'Session', value: String(input.session.id) },
    ],
  }
}

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

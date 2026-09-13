/**
 * Presentation-facing vocabulary for durable subagent conversations.
 *
 * Every fact here comes from Harness discovery (`SubagentListEntry`) or from a
 * child's own durable session log. Nothing infers a state: a missing activity
 * read is not completion, persistence residency is not "running", and
 * resumability is exactly Harness's descriptor mode. The one identity this
 * module keeps is the durable child session id, which survives the end of a
 * lifecycle epoch — the whole reason a separate catalog exists beside Work's
 * active-epoch projection.
 *
 * This is deliberately NOT part of `work/model.ts`. Work owns lifecycle
 * authority (open epochs keyed by `runId`); this owns durable conversations
 * keyed by child id, and merging them would make a settled child look like
 * active work that blocks retiring the session.
 * @module dshline/subagents/model
 */

import type { SubagentListEntry } from '@deepseek-ai/dsh-subagent'

/**
 * Durable session-store residency, in the wording Work already established.
 *
 * Harness `activity: 'running'` means the logical record is resident in the
 * session store; `'inactive'` means it exists only in persistence. Neither is a
 * claim that a model turn is executing, so the presentation never says
 * "running" for either.
 */
export type SubagentResidency = 'resident' | 'stored'

/** One durable direct child, from Harness discovery. */
export interface SubagentChildRow {
  /** Discriminant for the row union. */
  readonly kind: 'child'
  /** Durable child session id; stable across Activations. */
  readonly id: string
  /** Durable creation label, when the descriptor carried one. */
  readonly label?: string
  /** Harness's descriptor mode: a terminal one-shot run or a resumable conversation. */
  readonly mode: 'one-shot' | 'continuable'
  /** Durable session-store residency, never a model-turn claim. */
  readonly residency: SubagentResidency
  /** Whether a direct descendant has durable `origin: 'subagent'`. */
  readonly hasChildren: boolean
}

/**
 * One candidate Harness could not interpret, kept rather than dropped.
 *
 * A diagnostic is a first-class row so a corrupt or unreadable child degrades
 * honestly instead of vanishing from the catalog.
 */
export interface SubagentDiagnosticRow {
  /** Discriminant for the row union. */
  readonly kind: 'diagnostic'
  /** The candidate's session id. */
  readonly id: string
  /** Why Harness produced no child identity for it. */
  readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
}

/** One catalog row: a durable child or an honest diagnostic. */
export type SubagentCatalogRow = SubagentChildRow | SubagentDiagnosticRow

/**
 * What the catalog can truthfully present.
 *
 * The absences are distinct on purpose: a missing service, an in-flight read,
 * and a failed read are three different facts, and collapsing them into an
 * empty list would report "no subagents" for a profile that has many.
 */
export type SubagentCatalogReading =
  /** No `ctx.subagents` is mounted in this profile. */
  | { readonly kind: 'unavailable' }
  /** A discovery read is in flight. */
  | { readonly kind: 'loading' }
  /** Discovery failed; the message is Harness's or the transport's. */
  | { readonly kind: 'failed'; readonly message: string }
  /** Discovery answered, possibly with zero rows. */
  | { readonly kind: 'ready'; readonly rows: readonly SubagentCatalogRow[] }

/**
 * Stable selection identity for one catalog row.
 *
 * The durable child id is the identity, never the live `runId`: a continuable
 * child that settles and later resumes keeps one catalog row across both
 * epochs, which is exactly what the active-epoch projection cannot do.
 * @param row - the row to key.
 * @returns a kind-scoped key stable across refresh and reordering.
 */
export function subagentRowKey(row: SubagentCatalogRow): string {
  return `${row.kind}:${row.id}`
}

/**
 * The leading name a row shows.
 *
 * Harness's durable label wins; a one-shot child may legitimately have none, in
 * which case its durable id is the truthful name rather than an invented one.
 * @param row - the row to name.
 * @returns raw, untrusted label text (the overlay escapes it before drawing).
 */
export function subagentRowLabel(row: SubagentCatalogRow): string {
  if (row.kind === 'diagnostic') return row.id
  return row.label === undefined || row.label === '' ? row.id : row.label
}

/**
 * Whether a row can open a conversation inspector.
 *
 * Only a resolved child has a durable session to read; a diagnostic has no
 * identity to read, so it is listed but not openable.
 * @param row - the row under the cursor.
 * @returns whether Enter may open the inspector.
 */
export function subagentRowOpenable(row: SubagentCatalogRow): boolean {
  return row.kind === 'child'
}

/**
 * Whether a row may receive a human queue/steer follow-up.
 *
 * Two independent authorities must agree: Harness's descriptor must say
 * `continuable`, and the human prompt operation must be mounted. A one-shot
 * child is inspectable and read-only.
 * @param row - the row under the cursor.
 * @param promptAvailable - whether `ctx.subagents.prompt` is mounted.
 * @returns whether the follow-up/steer actions are offered.
 */
export function subagentRowFollowUp(row: SubagentCatalogRow, promptAvailable: boolean): boolean {
  return row.kind === 'child' && row.mode === 'continuable' && promptAvailable
}

/**
 * The one-line durability facts a catalog row shows.
 *
 * Order is deliberate: mode is what makes the row actionable, residency is a
 * store fact, and child presence is a lineage fact. No field is inferred.
 * @param row - the child row.
 * @returns whole segments, joined for display by the overlay.
 */
export function subagentChildFacts(row: SubagentChildRow): readonly string[] {
  return [
    row.mode,
    row.residency,
    ...row.hasChildren ? ['has children'] : [],
  ]
}

/**
 * The honest wording for one diagnostic reason.
 *
 * The three reasons are distinct Harness outcomes and must not collapse:
 * `corrupt` is deterministic data damage, `unavailable` is transient and
 * retried on the next listing, and `unsupported` is kept in the union for
 * consumers that route on it.
 * @param reason - Harness's diagnostic reason.
 * @returns a short human phrase.
 */
export function diagnosticReasonWord(reason: SubagentDiagnosticRow['reason']): string {
  switch (reason) {
    case 'corrupt':
      return 'unreadable record'
    case 'unavailable':
      return 'temporarily unreadable'
    case 'unsupported':
      return 'unsupported record'
  }
}

/**
 * Map Harness discovery entries into the catalog reading.
 *
 * The mapping only renames facts: `activity` becomes residency wording, and a
 * diagnostic keeps its own reason. Order is Harness's (`createdAt`, ties on id)
 * and is preserved so the listing is the authority on order.
 * @param entries - Harness's discovery result.
 * @returns a ready reading over the same rows.
 */
export function catalogReading(entries: readonly SubagentListEntry[]): SubagentCatalogReading {
  return { kind: 'ready', rows: entries.map(catalogRow) }
}

/**
 * Convert one Harness entry to a presentation row.
 * @param entry - one discovery entry.
 * @returns the child or diagnostic row.
 */
function catalogRow(entry: SubagentListEntry): SubagentCatalogRow {
  if (entry.kind === 'diagnostic') {
    return { kind: 'diagnostic', id: String(entry.id), reason: entry.reason }
  }
  return {
    kind: 'child',
    id: String(entry.id),
    mode: entry.mode,
    residency: entry.activity === 'running' ? 'resident' : 'stored',
    hasChildren: entry.hasChildren,
    ...entry.label === undefined || entry.label === '' ? {} : { label: entry.label },
  }
}

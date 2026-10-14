/**
 * The four writes Connect performs, each through the seam that owns it.
 *
 * Two rules shape every one of them. A secret is written through
 * `ctx.credentials` and never through `ctx.settings`, so the settings document
 * keeps carrying references rather than values and stays safe to sync and to
 * render. And a settings write is a path op carrying the revision the row was
 * read at, so a concurrent edit — a second terminal, the web Models page, or a
 * hand-edited `settings.yaml` — is refused instead of being overwritten.
 *
 * Nothing here decides whether an action should be OFFERED; {@link rowActions}
 * does, from the same facts. These functions assume the offer was made and
 * report what Harness answered.
 * @module dshline/connect/actions
 */

import { normalizeApiKey } from '@deepseek-ai/dsh-llm'
import type { ConnectSeams } from './harness.ts'
import { messageOf } from './catalog.ts'
import type { ConnectProviderRow, ConnectSignInRow } from './model.ts'
import { derivedCredentialRef } from './model.ts'

/** How one action ended, in words the transcript can carry. */
export interface ConnectActionOutcome {
  /** Whether Harness accepted the change. */
  readonly kind: 'done' | 'failed'
  /** What happened, already worded for a reader. */
  readonly message: string
}

/**
 * Store an API key for one route, recording its reference when there is none.
 *
 * Two writes in a fixed order, and the order is the point. The settings write
 * lands first because a stored secret whose reference nothing records is a
 * secret no adapter will ever read; if the credential write then fails, the
 * route is left naming a reference that is merely unset, which the browser
 * reports and the reader can retry. The reverse order would leave a stored key
 * that looks like nothing happened.
 * @param seams - the Harness seams.
 * @param row - the route being configured.
 * @param raw - the key exactly as typed.
 * @returns what Harness answered.
 */
export async function setApiKey(
  seams: ConnectSeams,
  row: ConnectProviderRow,
  raw: string,
  signal?: AbortSignal,
): Promise<ConnectActionOutcome> {
  const { credentials, settings } = seams
  // A retired browser admits no new mutation: this write would belong to a
  // gesture nobody is still making, and its report has no transcript to land
  // in. Checked again below, because storing the reference is itself an await.
  if (retired(signal)) return { kind: 'done', message: `${row.provider}: withdrawn before writing` }
  if (credentials === undefined) return failed('this profile mounts no credential provider')
  // The same judgement every adapter applies before putting a key in a header,
  // taken from the LLM seam rather than restated: a value no HTTP header can
  // carry must be refused here, where the field is still on screen, instead of
  // surfacing later as an opaque transport failure.
  const checked = normalizeApiKey(raw)
  if (!checked.ok) {
    return failed(checked.reason === 'empty'
      ? 'no key was typed'
      : 'that key contains characters no HTTP header can carry')
  }
  const ref = row.credential.ref ?? derivedCredentialRef(row.provider)
  if (ref === undefined) return failed(`no credential reference can be derived from "${row.provider}"`)
  if (row.credential.ref === undefined) {
    const field = row.credential.field
    if (field === undefined) return failed(`nothing in ${row.settingsNs} names a credential reference`)
    if (settings === undefined) return failed('this profile mounts no settings provider')
    try {
      // One op creates the profile and records the reference together: `mutate`
      // builds the intermediate objects a path needs, so a dormant route becomes
      // a configured one in the same write that says where its key lives.
      await settings.mutate(row.settingsNs, [{ op: 'set', path: [...row.settingsPath, field], value: ref }],
        row.revision)
    } catch (error) {
      return failed(`${row.settingsNs} refused the reference: ${messageOf(error)}`)
    }
  }
  // The reference write above was already submitted and is left alone; the key
  // is a SECOND write, and a retired browser admits none.
  if (retired(signal)) return { kind: 'done', message: `${row.provider}: withdrawn after recording the reference` }
  try {
    await credentials.set(ref, checked.value)
  } catch (error) {
    return failed(`the key could not be stored behind ${ref}: ${messageOf(error)}`)
  }
  return { kind: 'done', message: `${row.provider}: key stored behind ${ref}` }
}

/**
 * Forget the value behind one route's credential reference.
 *
 * The reference itself stays in the profile. Removing it too would change how
 * the route authenticates — a profile naming no reference defers to the
 * provider's own ambient discovery — and that is a different decision from
 * clearing a key.
 * @param seams - the Harness seams.
 * @param row - the route whose key is being forgotten.
 * @returns what Harness answered.
 */
export async function clearApiKey(
  seams: ConnectSeams,
  row: ConnectProviderRow,
  signal?: AbortSignal,
): Promise<ConnectActionOutcome> {
  const { credentials } = seams
  const ref = row.credential.ref
  if (retired(signal)) return { kind: 'done', message: `${row.provider}: withdrawn before writing` }
  if (credentials === undefined) return failed('this profile mounts no credential provider')
  if (ref === undefined) return failed(`${row.provider} names no credential reference`)
  try {
    await credentials.unset(ref)
  } catch (error) {
    return failed(`${ref} could not be cleared: ${messageOf(error)}`)
  }
  return { kind: 'done', message: `${row.provider}: ${ref} cleared` }
}

/**
 * Write a minimal profile so the owning adapter registers the route.
 *
 * An empty profile is the whole activation for a route the adapter already
 * describes: it inherits that route's endpoint, protocol, and catalog, and the
 * adapter registers it on the next settings commit. A route the adapter ships
 * nothing about needs fields this browser does not edit, and its own settings
 * document remains the place to declare it.
 * @param seams - the Harness seams.
 * @param row - the dormant route being activated.
 * @returns what Harness answered.
 */
export async function activateRoute(
  seams: ConnectSeams,
  row: ConnectProviderRow,
  signal?: AbortSignal,
): Promise<ConnectActionOutcome> {
  const { settings } = seams
  if (retired(signal)) return { kind: 'done', message: `${row.provider}: withdrawn before writing` }
  if (settings === undefined) return failed('this profile mounts no settings provider')
  // An empty path means the whole section IS the profile, so "activating" it
  // would replace every field the namespace holds. That is a bigger action than
  // the row describes, and such a namespace is registered by its composition
  // rather than by a row here.
  if (row.settingsPath.length === 0) {
    return failed(`${row.settingsNs} configures this route as its whole section; edit it in settings`)
  }
  try {
    await settings.mutate(row.settingsNs, [{ op: 'set', path: row.settingsPath, value: {} }], row.revision)
  } catch (error) {
    return failed(`${row.settingsNs} refused the profile: ${messageOf(error)}`)
  }
  return { kind: 'done', message: `${row.provider}: route activated in ${row.settingsNs}` }
}

/**
 * Remove the user layer's profile for one route.
 *
 * Only the user layer. A composition-declared route survives this and reverts
 * to what `cordis.yml` says, which is the whole reason the settings seam
 * separates the layers.
 * @param seams - the Harness seams.
 * @param row - the route being removed.
 * @returns what Harness answered.
 */
export async function deactivateRoute(
  seams: ConnectSeams,
  row: ConnectProviderRow,
  signal?: AbortSignal,
): Promise<ConnectActionOutcome> {
  const { settings } = seams
  if (retired(signal)) return { kind: 'done', message: `${row.provider}: withdrawn before writing` }
  if (settings === undefined) return failed('this profile mounts no settings provider')
  if (row.settingsPath.length === 0) {
    return failed(`${row.settingsNs} configures this route as its whole section; edit it in settings`)
  }
  try {
    await settings.mutate(row.settingsNs, [{ op: 'unset', path: row.settingsPath }], row.revision)
  } catch (error) {
    return failed(`${row.settingsNs} refused the removal: ${messageOf(error)}`)
  }
  return { kind: 'done', message: `${row.provider}: profile removed from your ${row.settingsNs} settings` }
}

/**
 * Delete the credential record one authorization flow wrote.
 *
 * Local only. Harness has no place for a provider to declare a server-side
 * revoke, so this forgets the grant here and the issuer is never told — which
 * the offered action says, because a reader who believes they revoked access
 * has been misinformed by the word "sign out".
 * @param seams - the Harness seams.
 * @param row - the sign-in being forgotten.
 * @returns what Harness answered.
 */
export async function forgetSignIn(
  seams: ConnectSeams,
  row: ConnectSignInRow,
  signal?: AbortSignal,
): Promise<ConnectActionOutcome> {
  const { credentials } = seams
  if (retired(signal)) return { kind: 'done', message: `${row.label}: withdrawn before writing` }
  if (credentials === undefined) return failed('this profile mounts no credential provider')
  try {
    await credentials.deleteRecord(row.key)
  } catch (error) {
    return failed(`${row.key} could not be deleted: ${messageOf(error)}`)
  }
  return { kind: 'done', message: `${row.label}: local sign-in forgotten (the issuer was not told)` }
}

/**
 * A refused action, worded the same way as an accepted one.
 * @param message - why it was refused.
 * @returns the outcome.
 */
/**
 * Whether the browser that asked for this write has already closed.
 *
 * Read through a call rather than a captured boolean, deliberately: the signal
 * can be aborted during any await below, and a value read once would still say
 * "open" at the second guard — the one that matters, because it sits between a
 * submitted reference write and the credential write that follows it.
 * @param signal - the browser lifetime, when the caller supplied one.
 * @returns true when the write must not be admitted.
 */
function retired(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

function failed(message: string): ConnectActionOutcome {
  return { kind: 'failed', message }
}

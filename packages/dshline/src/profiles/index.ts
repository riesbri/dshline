/**
 * `/profiles`: Harness's own profiles and bundle layers, from a terminal.
 *
 * The layer above `/plugins`. A PROFILE is what `dsh --profile <name>` boots:
 * a directory whose `dsh.profile.bundles` list names the npm packages whose
 * patch layers compose the Host. A PRESET (`/plugins`) chooses which of the
 * capabilities that Host provides one agent may see. Profiles provide;
 * presets expose.
 *
 * Ownership, as everywhere else in this frontend: Harness owns profile
 * discovery (`$DSH_HOME/profiles`, read through its own `dshHomePath`
 * service), the manifest format, bundle module resolution, and — through
 * `dsh plugin` — the entire package lifecycle including pnpm invocation and
 * `dsh.profile.bundles` reconciliation. This module owns rows, keys, prompts,
 * and one honest sentence about restarting. It writes no manifest, resolves no
 * package, and installs nothing itself.
 *
 * The restart boundary is what this browser exists to make visible. Harness may
 * change a mounted composition at runtime (the adopted generation's HMR service
 * and plugin manager), so a process's startup state is not proof that the files
 * on disk still match it; and replacing an installed package's module
 * generation still needs a fresh process. dshline drives `dsh plugin` in a
 * subprocess and observes none of that, so it states the scope of the operation
 * it ran: a landed operation on the CURRENT profile says restart required, one
 * on any other profile says which command picks it up, and switching profiles
 * is not offered at all — this browser re-links no layers itself, and building
 * that would be the competing lifecycle it refuses to own.
 * @module dshline/profiles
 */

import type { Context } from '@deepseek-ai/cordis'
import { escapeControls, paint } from '@dshline/renderer'
import type { BundleRow, PlainDependencyRow, ProfileRow } from './harness.ts'
import { dshHomePathOf } from './harness.ts'
import { ProfilesCatalog } from './catalog.ts'
import type { ProfilesCatalogSpec } from './catalog.ts'
import {
  bootCommand,
  displayArgument,
  plausiblePackageSpec,
  removeEligibility,
  resolveOperation,
  restartNote,
  updateAllEligibility,
  updateEligibility,
  validProfileName,
} from './model.ts'
import type { ResolvedOperation } from './model.ts'
import type { ProfileActionOutcome, ProfileOperationSpec } from './actions.ts'
import { runProfileOperation } from './actions.ts'
import {
  operationInFlight,
  profilesActivity,
  queueRestart,
  runExclusively,
  watchProfilesActivity,
} from './runtime.ts'
import { createProfilesOverlay } from './overlay.ts'
import type { ProfilesOverlay } from './overlay.ts'
import { promptSelect } from '../select.ts'
import { promptText } from '../prompt.ts'

export type { BundleRow, PlainDependencyRow, ProfileRow, ProfilesReading } from './harness.ts'
export { currentProfileName, readProfiles } from './harness.ts'
export type { ProfilesState, ProfilesCatalogSpec } from './catalog.ts'
export { ProfilesCatalog } from './catalog.ts'
export type { ProfileOperation, ResolvedOperation, OperationRefusal } from './model.ts'
export {
  bootCommand,
  bundleFacts,
  bundleMark,
  filterProfileRows,
  plainDependencyFacts,
  plausiblePackageSpec,
  profileMark,
  profileTags,
  removeEligibility,
  resolveOperation,
  restartNote,
  updateEligibility,
  validProfileName,
} from './model.ts'
export type { ProfileActionOutcome, ProfileOperationSpec, ChildResult, ChildTimings } from './actions.ts'
export {
  failureReason,
  pendingDecision,
  pluginCommand,
  redactOutputLine,
  runProfileOperation,
  spawnCaptured,
} from './actions.ts'
export type { ProfilesActivityView, RunningOperation } from './runtime.ts'
export {
  operationInFlight,
  profilesActivity,
  queueRestart,
  resetProfilesRuntime,
  runExclusively,
  watchProfilesActivity,
} from './runtime.ts'
export type { ProfilesOverlay, ProfilesOverlaySpec, ProfilesSelection } from './overlay.ts'
export { createProfilesOverlay, selectableRows } from './overlay.ts'

/** What opening the browser needs from the window it opens over. */
export interface ProfilesSpec {
  /** Context carrying `dshHomePath`, the Loader base URL, and the slot registry. */
  readonly ctx: Context
  /** Write finished rows into the terminal's own scrollback. */
  readonly commit: (lines: readonly string[]) => void
  /** Current time; injected so notice expiry is assertable. */
  readonly now?: () => number
  /**
   * Run one `dsh plugin` invocation; injected so tests drive the whole
   * orchestration without a launcher on PATH or a real pnpm.
   */
  readonly run?: typeof runProfileOperation
  /**
   * Read the roster; injected for the same reason, so orchestration can be
   * driven against a fixed roster rather than a real Harness home.
   */
  readonly read?: ProfilesCatalogSpec['read']
}

/**
 * Show the Profiles browser and stay until the reader closes it.
 * @param spec - the context and where transcript rows go.
 * @returns when the browser is closed.
 */
export async function openProfiles(spec: ProfilesSpec): Promise<void> {
  const { ctx, commit } = spec
  const catalogSpec: ProfilesCatalogSpec = {
    ctx,
    invalidate: () => { ctx.tuiSlots.invalidate() },
    ...spec.read === undefined ? {} : { read: spec.read },
  }
  const catalog = new ProfilesCatalog(catalogSpec)
  catalog.refresh()
  // A view hears about work it did not start, and about work that finishes
  // after the view that started it has gone: re-read the roster and repaint on
  // every edge, which is what makes a freshly opened browser correct without a
  // `ctrl-r`.
  const unwatch = watchProfilesActivity(() => {
    catalog.refresh()
    ctx.tuiSlots.invalidate()
  })
  let overlay!: ProfilesOverlay
  let closed = false
  try {
    await new Promise<void>(resolve => {
      let dismiss = (): void => {}
      const settle = (): void => {
        if (closed) return
        closed = true
        dismiss()
        resolve()
      }
      // No gate of its own. A prompt is a modal overlay ABOVE this one, so the
      // slot stack already routes every key to it and a second prompt cannot
      // stack underneath the first. The previous flag instead stayed set for
      // the whole pnpm run, which silently swallowed every subsequent key —
      // `a`, `u`, `r` and `n` all appeared to be dead for the minutes an
      // install takes. Mutual exclusion that genuinely matters is per PROFILE
      // and lives in `withProfileLock`, outside this browser's lifetime.
      const run = (task: () => Promise<void>): void => {
        void task().catch((error: unknown) => {
          const message = `the operation could not be completed: ${messageOf(error)}`
          try {
            if (!overlay.closed()) overlay.report(message, true)
            commit(outcomeLines({ kind: 'failed', message, output: [] }))
          } catch {
            // Drawing is the only channel; see `plugins/index.ts` for why a
            // failure here is swallowed rather than allowed to reject.
          }
        })
      }
      overlay = createProfilesOverlay({
        state: () => catalog.state(),
        activity: profilesActivity,
        refresh: () => { catalog.refresh() },
        addBundle: profile => { run(() => performAdd(spec, catalog, overlay, profile)) },
        updateBundle: (profile, bundle) => { run(() => performUpdate(spec, catalog, overlay, profile, bundle)) },
        removeBundle: (profile, bundle) => { run(() => performRemove(spec, catalog, overlay, profile, bundle)) },
        removeDependency: (profile, dependency) => {
          run(() => performRemoveDependency(spec, catalog, overlay, profile, dependency))
        },
        createProfile: () => { run(() => performCreate(spec, catalog, overlay)) },
        explainBoot: profile => {
          // Also names how to delete it. A profile directory is not a
          // Harness-owned lifecycle object: `dsh plugin` forwards pnpm
          // arguments and nothing upstream removes a profile, so there is no
          // seam to invoke and no external Harness mechanism to borrow.
          // Deleting the directory from here would be this frontend inventing
          // profile lifecycle, which is exactly what it does not own — so it
          // says where the directory is and leaves the removal to the reader.
          overlay.report(profile.current
            ? `${profile.name} is the profile this Host booted; its directory is ${profile.dir}`
            : `to use ${profile.name}, start a new Host: ${bootCommand(profile)} — to delete it, remove ${profile.dir}`,
          false)
        },
        now: spec.now ?? ((): number => Date.now()),
        close: () => {
          // Committed BEFORE the overlay comes down, and only for work that is
          // genuinely still going: closing the browser does not stop a pnpm run,
          // and leaving that to be inferred from silence is how a reader
          // concludes their install was cancelled.
          const activity = profilesActivity()
          for (const entry of activity.running) {
            commit([paint(escapeControls(`· profiles: ${entry.profile}: ${entry.what} — still running; it continues in the background`), 'muted')])
          }
          for (const profile of activity.restartQueued) {
            commit([paint(escapeControls(`· profiles: ${profile} is waiting on a restart to pick up its new composition`), 'muted')])
          }
          settle()
        },
        invalidate: () => { ctx.tuiSlots.invalidate() },
      })
      dismiss = ctx.tuiSlots.pushOverlay(overlay)
    })
  } finally {
    unwatch()
    catalog.dispose()
  }
}

/**
 * A message for a failure, without leaking an object's shape into the UI.
 * @param error - whatever was thrown.
 * @returns the sentence to show.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One outcome as transcript rows: the sentence, then the child's own tail.
 *
 * The child's output is committed rather than only shown, because a failed
 * pnpm invocation is the one case where the reader needs text this browser did
 * not write — and a bounded overlay is exactly where such text would be lost.
 * @param outcome - what the invocation answered.
 * @returns the lines to commit.
 */
function outcomeLines(outcome: ProfileActionOutcome): string[] {
  const mark = outcome.kind === 'failed' ? '✗' : '·'
  return [
    paint(escapeControls(`${mark} profiles: ${outcome.message}`), outcome.kind === 'failed' ? 'error' : 'muted'),
    ...outcome.output.map(line => paint(escapeControls(`    ${line}`), 'muted')),
  ]
}

/**
 * Report and commit one outcome, then re-read the roster.
 *
 * The transcript row is committed even after the browser closes, for the same
 * reason `/plugins` commits one: the invocation changed a profile directory on
 * disk, and this row is the only durable evidence of it.
 * @param spec - the context and where transcript rows go.
 * @param catalog - the catalog to refresh after.
 * @param overlay - the overlay to report into.
 * @param outcome - what the invocation answered.
 */
function land(
  spec: ProfilesSpec,
  catalog: ProfilesCatalog,
  overlay: ProfilesOverlay,
  outcome: ProfileActionOutcome,
): void {
  spec.commit(outcomeLines(outcome))
  if (overlay.closed()) return
  overlay.report(outcome.message, outcome.kind === 'failed')
  catalog.refresh()
}

/**
 * Run one resolved operation and report it, restart note included.
 * @param spec - the context and where transcript rows go.
 * @param catalog - the catalog to refresh after.
 * @param overlay - the overlay to report into.
 * @param profile - the profile the operation targets.
 * @param resolved - the operation to run.
 */
async function perform(
  spec: ProfilesSpec,
  catalog: ProfilesCatalog,
  overlay: ProfilesOverlay,
  profile: ProfileRow,
  resolved: ResolvedOperation,
): Promise<void> {
  await performOn(spec, catalog, overlay, profile.name, resolved, profile)
}

/**
 * Run one operation against a profile NAME, under that profile's lock.
 *
 * Addressed by name rather than by row because creation has no row yet. The
 * lock is held across the whole invocation and is not this browser's to
 * release early: a second overlay opened over the same profile is refused here
 * rather than allowed to start a competing pnpm run.
 * @param spec - the context and where transcript rows go.
 * @param catalog - the catalog to refresh after.
 * @param overlay - the overlay to report into.
 * @param profileName - the profile the operation is addressed to.
 * @param resolved - the operation to run.
 * @param profile - the profile's row, when it already has one (for the restart note).
 * @returns when the operation has landed or been refused.
 */
async function performOn(
  spec: ProfilesSpec,
  catalog: ProfilesCatalog,
  overlay: ProfilesOverlay,
  profileName: string,
  resolved: ResolvedOperation,
  profile: ProfileRow | undefined,
  successNote?: string,
): Promise<void> {
  if (operationInFlight(profileName)) {
    overlay.report(`${profileName} already has an operation running; wait for it to finish`, true)
    return
  }
  overlay.report(`${profileName}: ${resolved.running}…`, false)
  // The runtime holds the lock AND the running row, so both edges reach every
  // open view rather than only this one.
  const subprocess = subprocessOf(spec.ctx)
  const dshHomePath = dshHomePathOf(spec.ctx)
  const outcome = await runExclusively(profileName, resolved.running, async () =>
    (spec.run ?? runProfileOperation)({
      profile: profileName,
      resolved,
      ...subprocess === undefined ? {} : { subprocess },
      ...dshHomePath === undefined ? {} : { dshHome: dshHomePath() },
    }))
  if (outcome === undefined) {
    // Lost the race to another overlay between the check above and the lock.
    overlay.report(`${profileName} already has an operation running; wait for it to finish`, true)
    return
  }
  if (outcome.kind === 'failed') {
    land(spec, catalog, overlay, outcome)
    return
  }
  if (resolved.restartRequired && (profile === undefined || profile.current)) {
    // Only the profile this Host booted is waiting on a restart; a change to
    // any other takes effect the next time that one is launched.
    queueRestart(profileName)
  }
  const note = profile === undefined ? successNote : restartNote(resolved, profile)
  land(spec, catalog, overlay, note === undefined
    ? outcome
    : { ...outcome, message: `${outcome.message} — ${note}` })
}

/**
 * Read Harness's process capability without making an incomplete Host fail at boot.
 * @param ctx - the plugin context.
 * @returns the process seam, or undefined when this deployment has none.
 */
function subprocessOf(ctx: Context): ProfileOperationSpec['subprocess'] {
  return ctx.get('subprocess') as ProfileOperationSpec['subprocess']
}

/**
 * Handle `a`: ask for a package spec, then install it into the profile.
 * @param spec - the context and where transcript rows go.
 * @param catalog - the catalog to refresh after.
 * @param overlay - the overlay to report into.
 * @param profile - the profile to install into.
 */
async function performAdd(
  spec: ProfilesSpec,
  catalog: ProfilesCatalog,
  overlay: ProfilesOverlay,
  profile: ProfileRow,
): Promise<void> {
  const typed = await promptText(spec.ctx, {
    title: 'Add a bundle',
    view: 'Add bundle',
    message: `Install into profile ${profile.name}:`,
    // Says outright that this is not a search. It is one field forwarded to
    // `pnpm add` verbatim, so a partial or misremembered name is a failed
    // install rather than a list of candidates — and a reader who expected
    // completion would reasonably read that failure as a bug.
    detail: 'exact package name, forwarded to pnpm add — not a search',
    kind: 'text',
    // No example spec: naming one would put a particular provider's package
    // in a published runtime surface, which this repo's own containment test
    // refuses (see `work.spec.ts`) — and rightly, since a placeholder is a
    // recommendation whether or not it means to be.
    placeholder: 'exact package name or spec',
  })
  if (typed === undefined) return
  const packageSpec = typed.trim()
  if (!plausiblePackageSpec(packageSpec)) {
    overlay.report('that is not a package spec pnpm could install', true)
    return
  }
  // Named before the attempt, because the commonest failure here is a name that
  // is nearly right, and a reader who did not realise this field is literal
  // needs to see the literal thing that was tried.
  overlay.report(`installing ${displayArgument(packageSpec)} into ${profile.name}…`, false)
  await perform(spec, catalog, overlay, profile, resolveOperation('add', packageSpec))
}

/**
 * Handle `u` and `U`: update one bundle, or every bundle.
 * @param spec - the context and where transcript rows go.
 * @param catalog - the catalog to refresh after.
 * @param overlay - the overlay to report into.
 * @param profile - the profile to update in.
 * @param bundle - the bundle to update, or undefined for all of them.
 */
async function performUpdate(
  spec: ProfilesSpec,
  catalog: ProfilesCatalog,
  overlay: ProfilesOverlay,
  profile: ProfileRow,
  bundle: BundleRow | undefined,
): Promise<void> {
  if (bundle === undefined) {
    const all = updateAllEligibility(profile)
    if (all.kind === 'refused') {
      overlay.report(all.reason, true)
      return
    }
    await perform(spec, catalog, overlay, profile, all.resolved)
    return
  }
  const eligibility = updateEligibility(bundle)
  if (eligibility.kind === 'refused') {
    overlay.report(eligibility.reason, true)
    return
  }
  await perform(spec, catalog, overlay, profile, eligibility.resolved)
}

/**
 * Handle `r`: remove one bundle from the profile.
 * @param spec - the context and where transcript rows go.
 * @param catalog - the catalog to refresh after.
 * @param overlay - the overlay to report into.
 * @param profile - the profile to remove from.
 * @param bundle - the bundle to remove.
 */
async function performRemove(
  spec: ProfilesSpec,
  catalog: ProfilesCatalog,
  overlay: ProfilesOverlay,
  profile: ProfileRow,
  bundle: BundleRow,
): Promise<void> {
  const eligibility = removeEligibility(bundle)
  if (eligibility.kind === 'refused') {
    overlay.report(eligibility.reason, true)
    return
  }
  // Confirmed, unlike add and update: removing a layer takes a capability away
  // from every future session of this profile, and `r` sits one key from `u`.
  const confirmed = await promptSelect(spec.ctx, {
    title: `Remove ${bundle.packageName}?`,
    view: 'Confirm',
    detail: `It stops being a layer of ${profile.name} for every session started after this.`,
    choices: [
      { value: 'cancel', label: 'Cancel' },
      { value: 'remove', label: `Remove from ${profile.name}` },
    ],
  })
  if (confirmed !== 'remove') return
  await perform(spec, catalog, overlay, profile, eligibility.resolved)
}

/**
 * Handle `r` on a dependency that is not a layer.
 *
 * Always allowed, unlike a bundle: this IS a dependency by definition, so
 * `dsh plugin remove` will act on it. Confirmed all the same, for the same
 * reason a bundle removal is — `r` sits one key from `u`.
 * @param spec - the context and where transcript rows go.
 * @param catalog - the catalog to refresh after.
 * @param overlay - the overlay to report into.
 * @param activity - the running/queued state to record into.
 * @param profile - the profile to remove from.
 * @param dependency - the dependency to remove.
 */
async function performRemoveDependency(
  spec: ProfilesSpec,
  catalog: ProfilesCatalog,
  overlay: ProfilesOverlay,
  profile: ProfileRow,
  dependency: PlainDependencyRow,
): Promise<void> {
  const confirmed = await promptSelect(spec.ctx, {
    title: `Remove ${dependency.packageName}?`,
    view: 'Confirm',
    detail: dependency.declaresBundle === true
      ? `It declares dsh.bundle, so it would become a layer of ${profile.name} on the next dsh plugin run.`
      : `It is a dependency of ${profile.name} and composes nothing.`,
    choices: [
      { value: 'cancel', label: 'Cancel' },
      { value: 'remove', label: `Remove from ${profile.name}` },
    ],
  })
  if (confirmed !== 'remove') return
  // `remove-plain`, not `remove`: identical `dsh plugin` arguments, and no
  // restart claim, because nothing composed changed.
  await perform(spec, catalog, overlay, profile, resolveOperation('remove-plain', dependency.packageName))
}

/**
 * Handle `n`: ask for a name, then let `dsh plugin` initialize the profile.
 *
 * The directory is created by Harness's own `dsh plugin`, which initializes an
 * uninitialized profile before forwarding to pnpm — so a bare `install` is
 * both the creation and the reconciliation, and no template lives here.
 * @param spec - the context and where transcript rows go.
 * @param catalog - the catalog to refresh after.
 * @param overlay - the overlay to report into.
 */
async function performCreate(
  spec: ProfilesSpec,
  catalog: ProfilesCatalog,
  overlay: ProfilesOverlay,
): Promise<void> {
  const typed = await promptText(spec.ctx, {
    title: 'New profile',
    view: 'New profile',
    message: 'Profile name:',
    detail: 'dsh plugin creates it from its own template',
    kind: 'text',
    placeholder: 'my-profile',
  })
  if (typed === undefined) return
  // Trimmed at the EDGES only, and this is input handling rather than a
  // narrowing of what Harness accepts: a leading or trailing space is
  // invisible in a prompt, so it is never a choice a reader can see they made,
  // and a profile called `foo ` sitting next to `foo` is a trap. Interior
  // whitespace survives — `my profile` is a name Harness accepts and this
  // creates. `validProfileName` then applies Harness's own rule, unchanged, to
  // the trimmed result.
  const name = typed.trim()
  if (!validProfileName(name)) {
    overlay.report(`"${name}" is not a usable profile name`, true)
    return
  }
  const state = catalog.state()
  if (state.kind === 'ready' && state.reading.profiles.some(profile => profile.name === name)) {
    overlay.report(`${name} already exists`, true)
    return
  }
  await performOn(
    spec, catalog, overlay, name, resolveOperation('init'), undefined,
    `boot it with ${bootCommand({ name } as ProfileRow)}`,
  )
}

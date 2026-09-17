/**
 * What `/profiles` knows, as rows and decisions a terminal can draw.
 *
 * The one judgement this module makes that the filesystem does not is about
 * RESTART. A profile's bundle layers are composed when a Host boots; Harness
 * may re-apply a profile or bundle patch to a running Host at runtime (the
 * adopted generation's HMR service), while replacing an installed package's
 * module generation still needs a fresh process. This module owns no part of
 * that lifecycle: it drives `dsh plugin` in a subprocess and observes no
 * reload. What it knows is the scope of the operation it ran — a landed
 * mutation changes what the NEXT Host composes those files into — so it reports
 * each profile's restart claim from that scope rather than asserting what the
 * running process did or did not pick up.
 *
 * Switching profiles is not offered at all. A profile is chosen by the
 * launcher before any of this exists, and the composed tree that results is
 * what the running process serves; dshline builds no re-linking of its own on
 * top of whatever Harness reloads, which would be exactly the competing
 * lifecycle this frontend does not build. Another profile is presented, and the
 * command that boots it is named.
 * @module dshline/profiles/model
 */

import type { BundleRow, PlainDependencyRow, ProfileRow } from './harness.ts'

/**
 * Whether a package spec could carry a secret.
 *
 * A registry name cannot; a URL can, and `pnpm add` accepts URLs. Userinfo in
 * a URL (`https://x-access-token:ghp_…@host/…`) and a query string (`?token=…`)
 * are the two shapes that actually appear.
 */
const SPEC_WITH_URL = /:\/\/|^git\+|^https?:|@[^/]*:/u

/**
 * One argument as it is safe to SHOW.
 *
 * Redaction is display-only: the launcher receives the argument verbatim, as
 * one argv element, because that is what the user asked to install. What is
 * not safe is writing it into the transcript, which outlives the overlay and
 * is exactly where a token pasted into a prompt would otherwise be preserved.
 * @param argument - the argument as typed.
 * @returns the argument, or a placeholder naming what was withheld.
 */
export function displayArgument(argument: string): string {
  return SPEC_WITH_URL.test(argument) ? '<url spec withheld>' : argument
}

/** Whether one argument is safe to paste into a shell unquoted. */
const SHELL_SAFE = /^[A-Za-z0-9@._/=+:-]+$/u

/**
 * Single-quote one argument unless it plainly needs no quoting.
 * @param argument - the argument to render.
 * @returns the shell-safe rendering.
 */
export function shellQuote(argument: string): string {
  if (argument !== '' && SHELL_SAFE.test(argument)) return argument
  return `'${argument.replace(/'/gu, `'\\''`)}'`
}

/** The mark a profile row earns. */
export type ProfileMark = '●' | '○'

/**
 * The glyph for one profile: filled for the profile this Host booted.
 * @param row - the profile row.
 * @returns the mark.
 */
export function profileMark(row: ProfileRow): ProfileMark {
  return row.current ? '●' : '○'
}

/**
 * The tags after a profile's name: which one is running, and whether it can
 * be read at all.
 * @param row - the profile row.
 * @returns the tags, most important first.
 */
export function profileTags(row: ProfileRow): string[] {
  const tags: string[] = []
  if (row.current) tags.push('current')
  if (row.broken !== undefined) tags.push('unreadable')
  // Tagged rather than left for the failing operation to reveal: this state
  // blocks every operation on the profile, so a reader deserves to see it
  // before they press a key rather than after.
  if (row.pendingBuilds.length > 0) tags.push('builds pending')
  return tags
}

/**
 * What to do about a profile whose operations pnpm is holding.
 *
 * The instruction, not the decision. Allowing a build script runs arbitrary
 * install-time code from a dependency, so this names the file, the packages,
 * and the two values — and stops there. Harness does not answer it either: it
 * seeds `pnpm-workspace.yaml` when a profile is created and never touches it
 * again.
 * @param row - the profile row.
 * @returns the instruction lines, or empty when nothing is pending.
 */
export function pendingBuildInstructions(row: ProfileRow): string[] {
  if (row.pendingBuilds.length === 0) return []
  // The path is profile-relative because the frame's own header already names
  // the profiles root two lines above, and the absolute form truncated at a
  // normal width — losing the filename, which is the only actionable part of
  // the sentence. `enter` on the profile still reports the full directory.
  return [
    `pnpm is waiting on a build decision for ${row.pendingBuilds.join(', ')}`,
    `set each allowBuilds entry to true or false in ${row.name}/pnpm-workspace.yaml`,
  ]
}

/** The mark a bundle row earns from its installed state. */
export type BundleMark = '✓' | '·' | '⚠'

/**
 * The glyph for one bundle layer.
 *
 * Three states, and the third is the one worth a mark: a package the profile
 * composes as a layer but whose installed copy declares no `dsh.bundle`
 * contributes no patches, and Harness's own reconciliation drops it from the
 * layer list on the next `dsh plugin` run. A bundle with no manifest found is
 * neither confirmed nor broken — an in-box template bundle is not a
 * dependency and a never-installed profile has no `node_modules` — so it gets
 * the neutral mark rather than a warning it has not earned.
 * @param row - the bundle row.
 * @returns the mark.
 */
export function bundleMark(row: BundleRow): BundleMark {
  if (row.declaresBundle === false) return '⚠'
  return row.declaresBundle === true ? '✓' : '·'
}

/**
 * The right-hand facts for one bundle: its version, and anything unusual.
 * @param row - the bundle row.
 * @returns the facts, most useful first.
 */
export function bundleFacts(row: BundleRow): string[] {
  const facts: string[] = []
  if (row.version !== undefined) facts.push(row.version)
  if (row.declaresBundle === false) facts.push('installed copy declares no dsh.bundle')
  // An unresolved bundle is exactly that: no manifest was found in either
  // directory a bundle can live in. For a managed one that means the
  // dependency is not installed, which IS observed. For an unmanaged one it is
  // NOT evidence the package came from the installation — that would be a
  // claim about a source nothing here looked at; all that is known is that no
  // version could be read.
  else if (row.declaresBundle === undefined) {
    // A managed bundle with no manifest genuinely is not installed. An
    // unmanaged one only failed to resolve here; where it came from is not
    // something this read observed.
    facts.push(row.managed ? 'not installed' : 'version unavailable')
  }
  return facts
}

/**
 * The facts for one dependency that is not a bundle layer.
 *
 * Says what it IS rather than only what it is not: the common case is a package
 * that simply declares no `dsh.bundle`, which is a fact about that package and
 * not a mistake this browser should scold. The uncommon case — it DOES declare
 * one, so the layer list is stale — is the one worth pointing at, because
 * Harness reconciles on its next run and skips that when pnpm fails.
 * @param row - the dependency row.
 * @returns the facts, most useful first.
 */
export function plainDependencyFacts(row: PlainDependencyRow): string[] {
  const facts: string[] = []
  if (row.version !== undefined) facts.push(row.version)
  if (row.declaresBundle === true) facts.push('declares dsh.bundle — run any dsh plugin command to activate it')
  else if (row.declaresBundle === false) facts.push('not a bundle')
  else facts.push('not installed')
  return facts
}

/** Which `dsh plugin` operation a keystroke asks for. */
export type ProfileOperation = 'add' | 'update' | 'update-all' | 'remove' | 'remove-plain' | 'init'

/**
 * One operation, resolved into the `dsh plugin` arguments that perform it.
 *
 * These are pnpm's own subcommands, forwarded verbatim — `dsh plugin` is
 * documented as "a thin pnpm forwarder", and the reconciliation of
 * `dsh.profile.bundles` happens on ITS side afterwards. Nothing here invents
 * an install step, a version resolution rule, or a lockfile touch.
 */
export interface ResolvedOperation {
  /** The operation asked for. */
  readonly operation: ProfileOperation
  /**
   * Arguments after `dsh plugin --profile <name>`, RAW.
   *
   * The only field carrying a package spec verbatim, because the launcher must
   * receive exactly what the reader asked to install. Nothing displays this
   * directly: `pluginCommand` runs it through `displayArgument` and
   * `shellQuote` first.
   */
  readonly args: readonly string[]
  /**
   * What to say while it runs — SAFE to display and to keep.
   *
   * Built through {@link displayArgument}, never from the raw spec, because
   * this string is the one that travels: it reaches the persistent activity
   * row, the success and failure messages, and the transcript row committed
   * when the browser closes over running work. A raw URL spec placed here
   * would bypass every other redaction in this domain by being a label rather
   * than an argument.
   */
  readonly running: string
  /** Whether success means the running Host is now out of date. */
  readonly restartRequired: boolean
}

/**
 * Resolve one operation into its `dsh plugin` arguments.
 *
 * `init` is `install` deliberately: `dsh plugin` initializes a profile
 * directory on first use for ANY invocation, so the way to create a profile is
 * to run a harmless command against it. There is no separate `init`
 * subcommand to call, and writing the manifest here instead would be a second
 * profile creator with its own idea of the template.
 * @param operation - the operation asked for.
 * @param packageName - the bundle it targets, where one applies.
 * @returns the resolved operation.
 */
export function resolveOperation(
  operation: ProfileOperation,
  packageName?: string,
  bundles: readonly string[] = [],
): ResolvedOperation {
  switch (operation) {
    case 'add':
      return {
        operation,
        args: ['add', packageName ?? ''],
        running: `installing ${displayArgument(packageName ?? '')}`,
        restartRequired: true,
      }
    case 'remove':
      return {
        operation,
        args: ['remove', packageName ?? ''],
        running: `removing ${displayArgument(packageName ?? '')}`,
        restartRequired: true,
      }
    case 'remove-plain':
      // The same Harness-owned command as `remove`, and deliberately not the
      // same restart claim. A plain dependency is BY DEFINITION one that
      // composes nothing, so removing it changes no layer of the running Host —
      // telling a reader to restart for it would be asking them to act on a
      // change that cannot reach them.
      return {
        operation,
        args: ['remove', packageName ?? ''],
        running: `removing ${displayArgument(packageName ?? '')}`,
        restartRequired: false,
      }
    case 'update':
      return {
        operation,
        args: ['update', packageName ?? ''],
        running: `updating ${displayArgument(packageName ?? '')}`,
        restartRequired: true,
      }
    case 'update-all':
      // Named packages, never a bare `pnpm update`. `dsh plugin` forwards
      // verbatim, and bare `update` updates every dependency of the profile —
      // including plain libraries that are not bundle layers and are not shown
      // here. Calling that "updating every bundle" would be a false label on a
      // wider mutation than the reader asked for, so the visible
      // dependency-managed bundles are listed explicitly.
      return {
        operation,
        args: ['update', ...bundles],
        running: bundles.length === 1
          ? `updating ${displayArgument(bundles.join(''))}`
          : `updating ${String(bundles.length)} bundles`,
        restartRequired: true,
      }
    case 'init':
      // `install` with no package: pnpm reconciles the existing manifest and
      // `dsh plugin` initializes the directory first if it is new. A brand-new
      // profile composes nothing for THIS Host either way, so nothing about
      // the running process changes.
      return { operation, args: ['install'], running: 'initializing', restartRequired: false }
  }
}

/** Why an operation cannot be offered on a given row. */
export type OperationRefusal =
  /** It can be performed. */
  | { readonly kind: 'allowed'; readonly resolved: ResolvedOperation }
  /** It cannot, and this is what to say. */
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * Whether removing one bundle is an operation Harness would actually perform.
 *
 * `dsh plugin`'s reconciliation only removes a layer whose package was a
 * DEPENDENCY: "template bundles (dsh-base and friends) are not dependencies".
 * Offering `remove @deepseek-ai/dsh-base` would run pnpm, succeed at removing
 * nothing, and leave the layer exactly where it was — a button that reports
 * success and changes nothing is worse than one that explains itself.
 * @param row - the bundle row.
 * @returns whether removal applies, or why it does not.
 */
export function removeEligibility(row: BundleRow): OperationRefusal {
  if (!row.managed) {
    // Worded from what was observed: `managed` is "the profile's `dependencies`
    // name this package", so its absence proves only that. It does NOT prove
    // the package is a shipped template or came from the dsh installation —
    // that is a claim about a source nothing here looked at.
    return {
      kind: 'refused',
      reason: `${row.packageName} is not dependency-managed by this profile, so dsh plugin will not remove `
        + "this layer — disable its rows in the profile's cordis.patch.yml instead",
    }
  }
  return { kind: 'allowed', resolved: resolveOperation('remove', row.packageName) }
}

/**
 * Whether updating one bundle applies.
 *
 * Same dependency rule as removal: pnpm updates what the manifest depends on,
 * and an in-box bundle moves when the dsh installation does.
 * @param row - the bundle row.
 * @returns whether an update applies, or why it does not.
 */
export function updateEligibility(row: BundleRow): OperationRefusal {
  if (!row.managed) {
    // Same rule, same reason as removal: not dependency-managed is all that was
    // observed, so it is all that is claimed.
    return {
      kind: 'refused',
      reason: `${row.packageName} is not dependency-managed by this profile, so dsh plugin will not update `
        + 'this layer',
    }
  }
  return { kind: 'allowed', resolved: resolveOperation('update', row.packageName) }
}

/**
 * Whether "update every bundle" has anything to update.
 *
 * Only dependency-managed bundles can be updated by pnpm at all — an in-box
 * one moves when the dsh installation does — so the set this offers is exactly
 * the visible managed layers. An empty set is refused rather than turned into a
 * bare `pnpm update`, which would quietly widen the operation to every
 * dependency the profile has.
 * @param profile - the profile whose bundles to update.
 * @returns the operation, or why there is nothing to do.
 */
export function updateAllEligibility(profile: ProfileRow): OperationRefusal {
  const managed = profile.bundles.filter(row => row.managed).map(row => row.packageName)
  if (managed.length === 0) {
    return {
      kind: 'refused',
      reason: `${profile.name} has no dependency-managed bundle layers to update`,
    }
  }
  return { kind: 'allowed', resolved: resolveOperation('update-all', undefined, managed) }
}

/**
 * Whether an operation on this profile can be performed at all right now.
 *
 * A non-current profile is fully operable: `dsh plugin --profile <name>` is
 * addressed by name and never touches the running Host, which is exactly why
 * the restart note below talks about the NEXT boot rather than this one. What
 * is refused is naming no profile at all.
 * @param profile - the profile the operation targets, when one is selected.
 * @returns whether operations apply, or why they do not.
 */
export function profileOperable(profile: ProfileRow | undefined): { readonly ok: boolean; readonly reason: string } {
  if (profile === undefined) return { ok: false, reason: 'no profile is selected' }
  return { ok: true, reason: '' }
}

/**
 * How a landed operation affects the running Host.
 *
 * Named per profile, because the answer genuinely differs: a change to the
 * profile this Host booted means the process is now composing something older
 * than the file says, while a change to any other profile has no bearing on it
 * whatsoever. Reporting "restart required" for the second would be theatre.
 * @param resolved - the operation that landed.
 * @param profile - the profile it was performed on.
 * @returns the sentence to append, or undefined when nothing needs saying.
 */
export function restartNote(resolved: ResolvedOperation, profile: ProfileRow): string | undefined {
  if (!resolved.restartRequired) return undefined
  return profile.current
    // Short on purpose. The frame already carries a persistent `↻` row while
    // the browser is open, and repeating the whole explanation in the result
    // line said the same thing twice, the second time at length. The committed
    // transcript row still needs the fact, because it outlives the row — so it
    // keeps the three words that ARE the fact and drops the lecture.
    ? 'restart required'
    // The same helper, not a second hand-written copy: profile names may carry
    // whitespace, and an unquoted `dsh --profile my profile` names a different
    // profile than the row it came from.
    : `takes effect the next time you run ${bootCommand(profile)}`
}

/**
 * The command that boots one profile, for a reader who wants to switch.
 *
 * The honest answer to "make this profile current". A composed Host cannot
 * swap its bundle layers, so this is not a fallback for a switch that failed —
 * it is what switching profiles IS.
 * @param row - the profile to boot.
 * @returns the command line.
 */
export function bootCommand(row: ProfileRow): string {
  // Quoted, because Harness accepts a profile name with whitespace in it and
  // this string is offered as something to run. An unquoted `dsh --profile my
  // profile` would name a different profile than the row it came from.
  return `dsh --profile ${shellQuote(row.name)}`
}

/**
 * Normalize text for matching: case-folded, with runs of space collapsed.
 * @param value - raw text.
 * @returns the comparable form.
 */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, ' ')
}

/**
 * Whether a typed name could be a new profile directory.
 *
 * The same containment rule `resolveProfileDir` enforces, for the same reason
 * it gives: the name becomes a path segment, so a separator or a dot-segment
 * would place the profile outside the root the deployment authorized.
 * `node_modules` is refused because the launcher's own flat module fallback
 * occupies that sibling name.
 * Judges the name as given. Callers that read one from a prompt trim its edges
 * first — see `performCreate` for why invisible leading and trailing spaces are
 * input handling rather than a narrowing of this rule.
 * @param name - the candidate profile name.
 * @returns whether Harness would accept it.
 */
export function validProfileName(name: string): boolean {
  // Exactly `resolveProfileDir`'s rule and nothing more. An earlier version
  // also refused whitespace, on the grounds that the boot command this browser
  // prints would need quoting — which was solving a presentation problem by
  // narrowing what Harness accepts, and would have refused a name a person
  // could create with `dsh plugin` a moment later. `bootCommand` quotes
  // instead, which is where that problem actually lived.
  if (name === '' || name === '.' || name === '..' || name === 'node_modules') return false
  return !name.includes('/') && !name.includes('\\')
}

/**
 * Whether a typed string could be a package spec `dsh plugin add` would accept.
 *
 * Deliberately permissive: pnpm accepts registry names, versioned names,
 * tarball URLs, git specs, and filesystem paths, and re-deciding that grammar
 * here would be a second package resolver that disagrees with the real one on
 * its first edge case. What is refused is only what cannot be an argument at
 * all — empty, or a leading dash that pnpm would read as a flag.
 * @param spec - the typed package spec.
 * @returns whether it is worth forwarding.
 */
export function plausiblePackageSpec(spec: string): boolean {
  const trimmed = spec.trim()
  return trimmed !== '' && !trimmed.startsWith('-')
}

/**
 * Apply a query to profile rows, preserving name order.
 * @param rows - the profile rows.
 * @param query - raw query text.
 * @returns the matching rows.
 */
export function filterProfileRows(rows: readonly ProfileRow[], query: string): readonly ProfileRow[] {
  const needle = normalize(query)
  if (needle === '') return rows
  // Plain dependencies are searched too, because they are drawn: a reader who
  // can see a package name in the list and cannot find it by typing that name
  // is being told the filter is broken.
  return rows.filter(row => normalize(row.name).includes(needle)
    || row.bundles.some(bundle => normalize(bundle.packageName).includes(needle))
    || row.plain.some(dependency => normalize(dependency.packageName).includes(needle)))
}

/**
 * The one owner of this frontend's Harness settings namespace.
 *
 * Harness owns the document, the layering, the validation, and the change feed.
 * This module owns one namespace — `dshline` — and turns what Harness publishes
 * into what each consumer needs: what a preference is now, when it changed, and
 * a way to store the reader's choice.
 *
 * `dshline` is the profile ENTRY ID the settings service addresses, not a
 * section this frontend hands it. There is no registration call left to make:
 * the service derives one form per active profile entry from that entry's own
 * `Config`, keeps only its `.volatile()` fields editable, and addresses it by
 * the id the bundle patch inserts. The three keys' schema therefore belongs to
 * this row's configuration and not to this module, and the values in force are
 * the ones Harness committed into the running row.
 *
 * Layering is still Harness's, not this frontend's: schema default, then this
 * row's own composed config, then the profile patch a write lands in. There is
 * no second document, no parser, and no state machine.
 *
 * **One owner, because the row is one.** A profile entry is addressed by a
 * single id, so its keys have a single resolved source and a single writer; a
 * second registration would have been a competing section for the same
 * namespace, with two sources, two change fans, and two schemas each
 * validating away the other's key. So the row has exactly one owner here, and
 * consumers receive narrow per-key facets rather than a settings object they
 * could reach past. That is the whole of the abstraction: no key registry, no
 * dynamic schema, no generic settings framework for two preferences.
 * @module dshline/settings
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
// Carries the Context merge naming `ctx.settings` and the `settings/document-updated`
// change feed this row's facets republish on.
import type {} from '@deepseek-ai/dsh-settings'
import { escapeControls } from '@dshline/renderer'
import type { BusyEnter } from './delivery.ts'
import { DEFAULT_BUSY_ENTER } from './delivery.ts'
import { FALLBACK_THEME } from './themes/builtin.ts'

/**
 * The namespace this frontend owns. Matches the row id its bundle inserts.
 *
 * A plain literal: the service addresses a namespace by comparing it to
 * `entry.options.id`, so there is no brand to assert and the row id this
 * frontend already publishes is the only value that can be right.
 */
const NAMESPACE = 'dshline'

/** The key holding the reader's palette. */
const THEME_KEY = 'theme'

/** The key holding what plain `enter` means while a turn is running. */
const BUSY_ENTER_KEY = 'busyEnter'

/** The key controlling whether this frontend emits terminal BEL for live interaction. */
const ATTENTION_BELL_KEY = 'attentionBell'

/**
 * The reader preferences this row's own configuration carries, as Harness
 * hands them to the row.
 *
 * `Volatile` references rather than values, and that is what keeps `/theme`,
 * `/enter` and the attention bell writable without a remount: Harness commits a
 * stored value by mutating the live reference in place, so reading through
 * `.get()` is the whole change feed on the read side. A plain value here would
 * freeze the preference at mount and make persistence a launch-time-only fact.
 */
export interface DshlinePreferences {
  readonly theme: Volatile<string> | undefined
  readonly busyEnter: Volatile<BusyEnter> | undefined
  readonly attentionBell: Volatile<boolean> | undefined
}

/** One preference's resolved value set, as a consumer reads it. */
export interface DshlineSection {
  /** The theme id currently in force. */
  readonly theme: string
  /** What plain `enter` means while a turn is running. */
  readonly busyEnter: BusyEnter
  /** Whether this frontend emits terminal BEL for live human interaction. */
  readonly attentionBell: boolean
}

/**
 * One preference, as its consumer sees it.
 *
 * Narrow on purpose: a facet can read and store its own key and cannot reach the
 * namespace, the provider, or another key. The window takes the theme facet and
 * still has no way to write the input preference through it.
 */
export interface PreferenceSetting<T> {
  /** The value in force right now, across every layer Harness resolves. */
  readonly current: () => T
  /**
   * Observe a committed change to THIS preference, from any source — including
   * `settings.yaml` edited by hand while the session runs.
   *
   * Scoped to the key, not to the document. The namespace is one section, so
   * Harness reports one change for a write to any of its keys, and republishing
   * that to every facet was a correctness bug rather than a nuisance: both
   * preferences deliberately keep a live choice whose write FAILED, so an
   * unrelated key's successful write would wake this facet, resolve the value
   * still on disk, and silently roll the reader's live choice back. Each facet
   * therefore remembers what it last published and stays quiet unless its own
   * resolved value actually moved.
   * @param listener - called after this preference's resolved value changes.
   * @returns the disposer removing this listener.
   */
  readonly watch: (listener: () => void) => () => void
  /**
   * Store a choice in the user layer.
   *
   * A path op rather than a whole-section write, so a key this frontend does not
   * know about — one a newer version added — is never deleted by an older one,
   * and neither facet can clobber the other's key.
   * @param value - the value to store.
   * @returns a phrase to append to the command's report, or nothing to add.
   */
  readonly save: (value: T) => Promise<string | undefined>
}

/** The facets this namespace publishes. */
export interface DshlineSettings {
  /** The palette this frontend draws with. */
  readonly theme: PreferenceSetting<string>
  /** What plain `enter` means while a turn is running. */
  readonly busyEnter: PreferenceSetting<BusyEnter>
  /** Whether this frontend emits terminal BEL for live human interaction. */
  readonly attentionBell: PreferenceSetting<boolean>
}

/**
 * Expose one facet per key of this row's own configuration.
 * @param ctx - the plugin context owning the registration.
 * @param entry - this row's own live configuration references, the layer below anything stored.
 * @returns the readers and writers this frontend's consumers use.
 */
export function installDshlineSettings(ctx: Context, entry: DshlinePreferences): DshlineSettings {
  // The composed row is the answer in every profile, including one that mounts
  // no settings service at all. A stored value only exists for a row whose own
  // configuration declares the key editable, and a write to a row that does not
  // is refused by Harness rather than silently dropped here.
  // Read through the reference every time rather than capturing a value at
  // mount: a reference whose identity survives a `_commitVolatile` is the live
  // channel, and a snapshot taken once would make a stored choice apply only to
  // the NEXT window.
  const source = (): DshlineSection => ({
    theme: entry.theme?.get() ?? FALLBACK_THEME.id,
    busyEnter: entry.busyEnter?.get() ?? DEFAULT_BUSY_ENTER,
    attentionBell: entry.attentionBell?.get() ?? true,
  })
  /**
   * Republish to one key's watchers, but only when that key's value moved.
   *
   * Each facet contributes one of these and one row-level notification runs all
   * of them, which is what turns Harness's single per-entry notice into a
   * per-preference feed. Comparison is by value because every key here holds a
   * scalar; a key whose value were ever a structure would need its own
   * comparison rather than a deeper default one nobody had chosen.
   */
  const publishers: (() => void)[] = []
  /**
   * Build one key's facet over the shared source, feed, and writer.
   * @param read - projects the resolved section onto this key.
   * @param key - the path this facet writes.
   * @returns the facet its consumer receives.
   */
  const facet = <T>(read: (section: DshlineSection) => T, key: string): PreferenceSetting<T> => {
    const watchers = new Set<() => void>()
    // What this facet has already told its watchers, seeded from the layer in
    // force when the window opened, so a change Harness commits afterwards is
    // the difference between that and the next value rather than the first
    // value this facet ever saw.
    let published = read(source())
    publishers.push(() => {
      const next = read(source())
      if (next === published) return
      published = next
      for (const watcher of watchers) watcher()
    })
    return {
      current: () => read(source()),
      watch: listener => {
        watchers.add(listener)
        return () => { watchers.delete(listener) }
      },
      save: async value => {
        const settings = ctx.get('settings')
        // Nothing to write to. Saying so beats a switch the reader believes was
        // stored when it will last exactly as long as the process.
        if (settings === undefined) return 'not saved: this profile mounts no settings provider'
        try {
          // A path op, not a whole-section patch: the service validates a write
          // against the row's complete `Config`, and a patch rebuilt from what
          // this frontend read would fail that check — and silently delete any
          // editable key a newer version added — the moment the row grows one.
          await settings.mutate(NAMESPACE, [{ op: 'set', path: [key], value }])
        } catch (error: unknown) {
          // Escaped before it is styled, like any other text this frontend did
          // not compose: a provider message can carry a filesystem path, and a
          // schema rejection quotes the value that failed.
          const reason = error instanceof Error ? error.message : String(error)
          return `could not save it: ${escapeControls(reason)}`
        }
        return undefined
      },
    }
  }
  const settings: DshlineSettings = {
    theme: facet(section => section.theme, THEME_KEY),
    busyEnter: facet(section => section.busyEnter, BUSY_ENTER_KEY),
    attentionBell: facet(section => section.attentionBell, ATTENTION_BELL_KEY),
  }
  // Subscribed AFTER the facets exist, so a change Harness commits in the same
  // tick this row mounts cannot run the feed against an empty publisher list.
  //
  // This is the row's own change feed and the only one: the service announces
  // per entry, and an entry that never changes cannot wake a watcher for a key
  // whose value did not move. `ctx.on` rather than `ctx.inject`, because a
  // notification is not a registration — there is nothing to install, and
  // nothing to tear down beyond the listener this row already owns.
  ctx.on('settings/document-updated', ns => {
    if (String(ns) !== NAMESPACE) return
    for (const publish of publishers) publish()
  })
  return settings
}

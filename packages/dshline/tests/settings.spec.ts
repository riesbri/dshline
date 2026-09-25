/**
 * The `dshline` settings namespace, against the real settings service.
 *
 * The adopted generation took the consumer-side registration away. There is no
 * `register()` and no `installSection()`: a namespace is the Loader ENTRY ID of a
 * row whose own `static Config` declares its fields, only `.volatile()` fields
 * are writable, and the change feed is `settings/document-updated` — an entry
 * change, not a value-gated commit. So this file mounts the real `SettingsForms`
 * over one profile entry whose schema is dshline's OWN exported `Config`, and
 * installs the row's facets against it. That is the only arrangement in which
 * the interesting questions have answers: which refusals `save()` has to
 * surface, what a stored write does to the live references, and how one
 * entry-level notice is narrowed to the one key that moved.
 *
 * Exactly one thing here is a double: the configuration editor, which owns the
 * profile patch and commits volatile values into the live references. It stands
 * in for the Loader row dshline does not depend on, and it is deliberately thin
 * — the next raw section is whatever the SERVICE computed, and the refusal
 * texts are the service's own. Everything dshline decides is decided by dshline.
 * @module dshline/tests/settings
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, resolveConfig } from '@deepseek-ai/cordis'
import type { Fiber, Volatile, VolatileSnapshot } from '@deepseek-ai/cordis'
import { SettingsForms } from '@deepseek-ai/dsh-settings'
import { describe, expect, it } from 'vitest'
import type { BusyEnter } from '../src/delivery.ts'
import { DEFAULT_BUSY_ENTER } from '../src/delivery.ts'
import { Config as RowSchema, type Config as RowConfig } from '../src/index.ts'
import { installDshlineSettings } from '../src/settings.ts'
import type { DshlineSettings, PreferenceSetting } from '../src/settings.ts'
import { FALLBACK_THEME } from '../src/themes/builtin.ts'

/** The namespace this frontend owns: the profile entry id its bundle inserts. */
const NS = 'dshline'

/** Some other row's id, for the notice dshline's facets must ignore. */
const OTHER_NS = 'another-plugin'

/**
 * One live configuration field: the reference a consumer reads, and the only
 * move this fixture may make to it.
 *
 * A `Volatile` field is exactly `{ get() }` — there is no setter, because Harness
 * mutates the reference IN PLACE and the identity is the point: a consumer that
 * captured the reference at mount sees every later commit, which is what makes a
 * stored `/theme` apply to the running window rather than the next launch. A
 * cordis reference cannot be written from outside the Loader, so the closure
 * below is this file's stand-in for that in-place commit.
 */
interface Field<T> {
  /** The reference handed to the row, and the one a write commits into. */
  readonly reference: Volatile<T>
  /** Move the committed value, exactly as a persisted write would. */
  write(value: VolatileSnapshot<T>): void
}

/** The row's three live fields, addressed by the key each facet writes. */
interface Fields {
  readonly theme: Field<string>
  readonly busyEnter: Field<BusyEnter>
  readonly attentionBell: Field<boolean>
}

/**
 * The symbol the shared volatile protocol is keyed by.
 *
 * `Symbol.for`, not a local constant, because that symbol IS the protocol: it is
 * how the settings service's `plainConfig` recognises a reference as one, across
 * an ESM and a CJS copy of the runtime alike. A stand-in carrying only `get()`
 * would be a plain object of one function, and the service would project it into
 * a form verbatim instead of reading the value out of it.
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * One field of the row under test.
 * @param initial - the value the row's own schema and composition resolved to.
 * @returns the reference and the in-place write.
 */
function field<T>(initial: VolatileSnapshot<T>): Field<T> {
  let current: VolatileSnapshot<T> = initial
  return {
    reference: {
      get: () => current,
      [VOLATILE_WRITE]: (value: VolatileSnapshot<T>): void => { current = value },
    },
    write: value => { current = value },
  }
}

/**
 * The row under test: a real cordis fiber carrying dshline's OWN `Config`, with
 * an `apply` that does nothing.
 *
 * The schema is the whole point. The service derives a namespace's form from
 * `entry.fiber.runtime.Config` and nothing else, so mounting dshline's exported
 * schema is what makes `dshline` a configurable entry at all. A mistake there —
 * a reader preference left ordinary, a composition-time field marked volatile —
 * shows up here as a refused write or a missing key rather than as a passing
 * assertion.
 */
const ROW = { Config: RowSchema, apply: () => {} }

/** One profile entry, as far as the settings service reads it. */
interface ProfileEntry {
  readonly id: string
  readonly options: { readonly id: string; readonly name: string; config: Record<string, unknown> }
  /** Real, because the service reads the uid, state, runtime and context off it. */
  readonly fiber: Fiber
}

/**
 * The configuration editor, as the settings service calls it.
 *
 * Two jobs and only two: persist the raw section the SERVICE computed, and
 * commit the volatile values into the row's live references. Both belong to the
 * Loader. The service reaches neither, so a fixture that let it would stop
 * proving anything about the service.
 */
interface ConfigurationEditor {
  readonly documentPath: string
  entries(): ProfileEntry[]
  configuration(): {
    entry: ProfileEntry
    inherited: Record<string, unknown>
    override: Record<string, unknown>
  }[]
  edit(
    entry: ProfileEntry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

/** What a case drives. */
interface Mounted {
  readonly ctx: Context
  /** The facets dshline's row publishes, and the three it narrows them to. */
  readonly settings: DshlineSettings
  readonly theme: PreferenceSetting<string>
  readonly busyEnter: PreferenceSetting<BusyEnter>
  readonly attentionBell: PreferenceSetting<boolean>
  /** Raw sections the editor was asked to persist, in order. */
  readonly persisted: Record<string, unknown>[]
  /** The editor's own storage, so a case can make a write fail. */
  readonly storage: { reason: string | undefined }
  /** Mount the settings service now, as a profile that adds it later would. */
  mountService(): Promise<void>
}

/** What a case sets up before the row is installed. */
interface MountOptions {
  /** Whether to mount the settings service; absent models a profile without it. */
  readonly service?: boolean
  /**
   * Whether the row is a configurable entry at all.
   *
   * A profile that never inserted dshline's row, or disabled it, leaves the
   * service with no entry to address — and Harness refuses a write by name
   * rather than storing it nowhere.
   */
  readonly configurable?: boolean
  /** The row's own composed values; an omitted key falls to the schema default. */
  readonly composed?: { theme?: string; busyEnter?: BusyEnter; attentionBell?: boolean }
  /** The raw profile section the entry starts from. */
  readonly patch?: Record<string, unknown>
}

/**
 * Mount the real settings service over one profile entry, and install the row.
 * @param options - which services to mount, and the layers the row starts from.
 * @returns the context, the facets, and the editor's records.
 */
async function mount(options: MountOptions = {}): Promise<Mounted> {
  const ctx = new Context()
  // The service waits on the Loader and reads the profile home for the document
  // it imports from a previous generation. A fresh temporary home has no such
  // document, so the import is a no-op rather than a rewrite of someone's home.
  const home = mkdtempSync(join(tmpdir(), 'dshline-settings-'))
  ctx.provide('loader', { await: () => Promise.resolve() })
  ctx.provide('profileContext', {
    name: 'dshline-test', home, dir: home, cwd: home, overlays: [], startedBundles: [],
    patchPath: join(home, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
  })

  const composed = options.composed ?? {}
  const row = await ctx.plugin(ROW, composed)
  // The runtime is the plugin module the fiber was created from; a null here
  // would mean the row never loaded, which the await above already rules out.
  if (row.runtime === null) throw new Error('the dshline test row mounted without a runtime')
  const runtime = row.runtime
  /**
   * The values the row's own schema declares, as the Loader resolved them.
   *
   * Read off the mounted row rather than written out here, so a changed default
   * in the schema moves this fixture with it and the assertions below keep
   * meaning "the default this row declares".
   */
  const declared: RowConfig = row.config
  const live: Fields = {
    theme: field(declared.theme?.get() ?? FALLBACK_THEME.id),
    busyEnter: field(declared.busyEnter?.get() ?? DEFAULT_BUSY_ENTER),
    attentionBell: field(declared.attentionBell?.get() ?? true),
  }
  // The row's resolved config IS where Harness keeps a volatile field, so
  // pointing it at the live references is what makes the service's own
  // `describe()` agree with what a consumer reads.
  row.config = {
    theme: live.theme.reference,
    busyEnter: live.busyEnter.reference,
    attentionBell: live.attentionBell.reference,
  }

  const entry: ProfileEntry = {
    id: NS,
    options: { id: NS, name: 'dshline', config: options.patch ?? {} },
    fiber: row,
  }
  /**
   * A second row, so a notice for somebody else's entry is a REAL one.
   *
   * The service announces the entry that changed, and a test cannot mint a
   * branded namespace id to hand it. Mounting another entry that declares the
   * same schema lets the service itself produce that notice, which is the whole
   * point: what dshline's facets must ignore is a genuine announcement, not a
   * synthesised one.
   */
  const other = await ctx.plugin(ROW, {})
  other.config = { theme: live.theme.reference }
  const otherEntry: ProfileEntry = {
    id: OTHER_NS,
    options: { id: OTHER_NS, name: 'another-plugin', config: {} },
    fiber: other,
  }
  const active = options.configurable ?? true
  const entries = active ? [entry, otherEntry] : []
  const persisted: Record<string, unknown>[] = []
  const storage: { reason: string | undefined } = { reason: undefined }
  /**
   * Commit a written section onto the row's live fields.
   *
   * The values arrive as a raw document, which the types cannot police — the
   * same boundary the in-memory provider this file replaced had, and the same
   * answer: Harness's schema, not this fixture, is what says a value is a valid
   * `BusyEnter`. A case that stores an invalid one is asserting the refusal.
   */
  const commit = (section: Record<string, unknown>): void => {
    const { theme, busyEnter, attentionBell } = section
    if (theme !== undefined) live.theme.write(String(theme))
    if (busyEnter !== undefined) live.busyEnter.write(String(busyEnter) as BusyEnter)
    if (attentionBell !== undefined) live.attentionBell.write(Boolean(attentionBell))
  }
  const editor: ConfigurationEditor = {
    documentPath: join(home, 'cordis.patch.yml'),
    entries: () => entries,
    configuration: () => entries.map(row => ({
      entry: row, inherited: row === entry ? composed : {}, override: row.options.config,
    })),
    edit: async (target, change) => {
      if (storage.reason !== undefined) throw new Error(storage.reason)
      const next = change(target.options.config, target === entry ? composed : {})
      /**
       * The Loader's half of a write, and the reason a bad VALUE is refused
       * here rather than by the settings service: the service checks which
       * fields a form may edit, and a value is judged when the profile patch
       * is applied, by the row's own `Config` through cordis's own validation.
       */
      resolveConfig(runtime, next)
      target.options.config = next
      if (target === entry) {
        persisted.push(next)
        commit(next)
      }
    },
  }
  ctx.provide('configEditor', editor)
  const mountService = async (): Promise<void> => { await ctx.plugin(SettingsForms) }
  if (options.service ?? true) await mountService()

  const settings = installDshlineSettings(ctx, {
    theme: live.theme.reference,
    busyEnter: live.busyEnter.reference,
    attentionBell: live.attentionBell.reference,
  })
  return {
    ctx, settings, persisted, storage, mountService,
    theme: settings.theme,
    busyEnter: settings.busyEnter,
    attentionBell: settings.attentionBell,
  }
}

describe('the theme key', () => {
  it('resolves the schema default when nothing is composed or stored', async () => {
    const { theme } = await mount()
    expect(theme.current()).toBe(FALLBACK_THEME.id)
  })

  it('takes the composition entry as the layer below the user', async () => {
    const { theme } = await mount({ composed: { theme: 'ember' } })
    expect(theme.current()).toBe('ember')
  })

  it('lets a stored user section override the composed default', async () => {
    // The whole point of the layering: a deployment composes `ember`, the
    // reader picks `tide`, and the reader wins.
    const { theme, persisted } = await mount({ composed: { theme: 'ember' } })
    expect(await theme.save('tide')).toBeUndefined()
    expect(theme.current()).toBe('tide')
    expect(persisted).toStrictEqual([{ theme: 'tide' }])
  })
})

describe('without a settings service', () => {
  it('still resolves the composed theme rather than failing', async () => {
    // A profile that mounts no settings service must still run. The row's own
    // references are the answer, and they do not depend on one existing.
    const { theme } = await mount({ service: false, composed: { theme: 'paper' } })
    expect(theme.current()).toBe('paper')
  })

  it('falls back to the shipped default when the row declares nothing either', async () => {
    // A row composed before this key existed declares no reference at all, and
    // the window still has a palette to draw with.
    const { theme } = installDshlineSettings(new Context(), {
      theme: undefined, busyEnter: undefined, attentionBell: undefined,
    })
    expect(theme.current()).toBe(FALLBACK_THEME.id)
  })

  it('reports that a choice cannot be stored, instead of throwing', async () => {
    const { theme } = await mount({ service: false })
    expect(await theme.save('ember')).toContain('mounts no settings provider')
  })

  it('still stores a choice through a service mounted after the row', async () => {
    // Nothing is registered at install any more, so a late mount changes no read
    // and the only thing `save()` needs is `ctx.get('settings')` at the moment
    // it writes.
    const { theme, persisted, mountService } = await mount({ service: false, composed: { theme: 'ember' } })
    expect(theme.current()).toBe('ember')
    await mountService()
    expect(await theme.save('tide')).toBeUndefined()
    expect(persisted).toStrictEqual([{ theme: 'tide' }])
    expect(theme.current()).toBe('tide')
  })
})

describe('storing a choice', () => {
  it('leaves keys it does not know about alone', async () => {
    // A path op rather than a section replace, so an older build cannot delete
    // a key a newer one wrote.
    const { theme, persisted } = await mount({ patch: { theme: 'ember', future: 42 } })
    await theme.save('paper')
    expect(persisted[0]).toStrictEqual({ theme: 'paper', future: 42 })
  })

  it('surfaces a storage failure as a phrase rather than a throw', async () => {
    const { theme, storage, persisted } = await mount()
    storage.reason = 'storage is read-only here'
    const note = await theme.save('ember')
    expect(note).toContain('could not save it')
    expect(note).toContain('read-only')
    expect(persisted).toStrictEqual([])
  })

  it('accepts any id the row’s schema declares, and says nothing about palettes', async () => {
    // The previous generation's section enumerated the shipped palettes, so a
    // typo was refused here. The row's own `Config` is a plain string now, and
    // whether an id names a palette is `findTheme`'s question at draw time — a
    // second schema in the settings layer would only be a second opinion about a
    // list this package already owns.
    const { theme, persisted } = await mount()
    expect(await theme.save('dracula')).toBeUndefined()
    expect(persisted).toStrictEqual([{ theme: 'dracula' }])
  })

  it('surfaces the service’s refusal when the row is not a configurable entry', async () => {
    // No entry answers to `dshline`, so there is nothing to address. Harness says
    // so by name, and the reader is told rather than left believing in a switch
    // that will last exactly as long as the process.
    const { theme, persisted } = await mount({ configurable: false })
    const note = await theme.save('ember')
    expect(note).toContain('could not save it')
    expect(note).toContain(`No configurable plugin entry "${NS}"`)
    expect(persisted).toStrictEqual([])
  })
})

describe('what the row’s own Config makes editable', () => {
  it('exposes exactly the three reader preferences', async () => {
    // The form is derived from this row's `Config` and nothing else, so this is
    // the assertion that `theme`, `busyEnter` and `attentionBell` are the
    // volatile ones and that no composition-time field leaked in.
    const { ctx } = await mount()
    const [descriptor] = ctx.settings.describe()
    expect(descriptor?.ns).toBe(NS)
    expect(descriptor?.value).toStrictEqual({
      theme: FALLBACK_THEME.id, busyEnter: DEFAULT_BUSY_ENTER, attentionBell: true,
    })
  })

  it('refuses a price, which committing would remount the row', async () => {
    // `pricing` and `peakHoursUtc` are read once at mount; a volatile field is
    // the only kind whose write is honest. This is asserted against the service
    // rather than through a facet, because a facet cannot address a key the row
    // does not declare — which is exactly the property being pinned.
    const { ctx } = await mount()
    await expect(ctx.settings.mutate(NS, [
      { op: 'set', path: ['pricing'], value: { 'deepseek-official/v4': { input: 1 } } },
    ])).rejects.toThrow('Config field "pricing" is not volatile')
  })
})

describe('live changes', () => {
  it('notifies a watcher when the resolved value commits', async () => {
    const { theme } = await mount()
    const seen: string[] = []
    theme.watch(() => { seen.push(theme.current()) })
    await theme.save('tide')
    expect(seen).toStrictEqual(['tide'])
  })

  it('stops notifying after the watcher is disposed', async () => {
    const { theme } = await mount()
    let count = 0
    const stop = theme.watch(() => { count += 1 })
    await theme.save('tide')
    const afterFirst = count
    stop()
    await theme.save('ember')
    expect(count).toBe(afterFirst)
    expect(theme.current()).toBe('ember')
  })

  it('ignores another row’s notice, and answers its own', async () => {
    // The feed announces an ENTRY change and names the entry. A notice for a
    // different row is not evidence about this one, and waking a facet on it
    // would turn any other plugin's edit into a redraw here. Both notices below
    // are the service's own, produced by two real rows' real writes; what differs
    // is only which entry changed.
    const { ctx, theme } = await mount()
    const seen: string[] = []
    theme.watch(() => { seen.push(theme.current()) })

    await ctx.settings.mutate(OTHER_NS, [{ op: 'set', path: ['theme'], value: 'tide' }])
    expect(seen).toStrictEqual([])
    // The same theme value, stored on OUR row this time, is the same number and
    // does publish — so the filter is the namespace, not the value.
    await ctx.settings.mutate(NS, [{ op: 'set', path: ['theme'], value: 'tide' }])
    expect(seen).toStrictEqual(['tide'])
  })

  it('publishes only for the key of this row that actually moved', async () => {
    // One notice, three keys, one answer: the entry-level feed says nothing
    // about WHICH key committed, so each facet has to compare its own resolved
    // value against the one it last published.
    const { ctx, theme, busyEnter } = await mount()
    const themeSeen: string[] = []
    const busySeen: string[] = []
    theme.watch(() => { themeSeen.push(theme.current()) })
    busyEnter.watch(() => { busySeen.push(busyEnter.current()) })

    // A write to this row's OWN `busyEnter`, which is the only key that moves:
    // the entry notice names the row and nothing about the key.
    await ctx.settings.mutate(NS, [{ op: 'set', path: ['busyEnter'], value: 'steer' }])
    expect(busySeen).toStrictEqual(['steer'])
    expect(themeSeen).toStrictEqual([])
  })
})

describe('the busyEnter key', () => {
  it('resolves the schema default when nothing is composed or stored', async () => {
    const { busyEnter } = await mount()
    expect(busyEnter.current()).toBe(DEFAULT_BUSY_ENTER)
  })

  it('takes the composition entry as the layer below the user', async () => {
    const { busyEnter } = await mount({ composed: { busyEnter: 'steer' } })
    expect(busyEnter.current()).toBe('steer')
  })

  it('lets a stored user section override the composed default', async () => {
    const { busyEnter } = await mount({ composed: { busyEnter: 'steer' } })
    expect(await busyEnter.save('queue')).toBeUndefined()
    expect(busyEnter.current()).toBe('queue')
  })

  it('refuses a value neither word names, through the row’s own schema', async () => {
    // The settings service does not judge values — it judges which fields a
    // form may edit — so the refusal arrives from the config commit the write
    // triggers, carrying the row's own schema's wording. Cast because the point
    // is a section edited by hand, which the types cannot police.
    const { busyEnter, persisted } = await mount()
    const note = await busyEnter.save('yolo' as BusyEnter)
    expect(note).toContain('could not save it')
    expect(persisted).toStrictEqual([])
    expect(busyEnter.current()).toBe(DEFAULT_BUSY_ENTER)
  })

  it('still works, and says it cannot store, with no service mounted', async () => {
    const { busyEnter } = await mount({ service: false, composed: { busyEnter: 'steer' } })
    expect(busyEnter.current()).toBe('steer')
    expect(await busyEnter.save('queue')).toContain('mounts no settings provider')
  })
})

describe('the attentionBell key', () => {
  it('resolves enabled by default, but lets the user override the composition default', async () => {
    const { attentionBell, persisted } = await mount()
    expect(attentionBell.current()).toBe(true)

    const composed = await mount({ composed: { attentionBell: true } })
    expect(await composed.attentionBell.save(false)).toBeUndefined()
    expect(composed.persisted).toStrictEqual([{ attentionBell: false }])
    expect(composed.attentionBell.current()).toBe(false)
  })

  it('uses the composed value when no settings service is mounted', async () => {
    const { attentionBell } = await mount({ service: false, composed: { attentionBell: false } })
    expect(attentionBell.current()).toBe(false)
  })

  it('rejects a non-boolean value through the row’s own schema', async () => {
    const { attentionBell, persisted } = await mount()
    // A value read back out of a hand-edited profile patch, which is JSON of a
    // shape the types cannot police: the row's own `Config` is what refuses it.
    const loud: boolean = JSON.parse('"loud"')
    const note = await attentionBell.save(loud)
    expect(note).toContain('could not save it')
    expect(note).toContain('expected boolean')
    expect(persisted).toStrictEqual([])
    expect(attentionBell.current()).toBe(true)
  })
})

describe('one owner of the namespace', () => {
  it('writes one key without deleting the other', async () => {
    // Each facet writes a path op, so the keys cannot clobber each other even
    // though they share one row and one section. The section grows: each write
    // lands in the same profile patch beside the key already there.
    const { theme, busyEnter, persisted } = await mount()
    await theme.save('ember')
    expect(persisted.at(-1)).toStrictEqual({ theme: 'ember' })
    await busyEnter.save('steer')
    expect(persisted.at(-1)).toStrictEqual({ theme: 'ember', busyEnter: 'steer' })
    await theme.save('paper')
    expect(persisted.at(-1)).toStrictEqual({ theme: 'paper', busyEnter: 'steer' })
    expect(theme.current()).toBe('paper')
    expect(busyEnter.current()).toBe('steer')
  })

  it('lets each facet reach only its own key', async () => {
    // Narrow by construction: the window is handed the theme facet and still
    // has no way to write the input preference through it.
    const { settings } = await mount()
    expect(Object.keys(settings).sort()).toStrictEqual(['attentionBell', 'busyEnter', 'theme'])
    expect(Object.keys(settings.theme).sort()).toStrictEqual(['current', 'save', 'watch'])
  })

  it('does not notify one key\'s watchers when only the other key commits', async () => {
    // The service reports one change for the whole row, so this has to be
    // narrowed here rather than by every consumer. Publishing it to both facets
    // is not merely noisy: see the two divergence tests below, where it silently
    // rolls a live choice back to what is on disk.
    const { theme, busyEnter } = await mount()
    const themeSeen: string[] = []
    const busySeen: string[] = []
    theme.watch(() => { themeSeen.push(theme.current()) })
    busyEnter.watch(() => { busySeen.push(busyEnter.current()) })

    await busyEnter.save('steer')
    expect(busySeen).toStrictEqual(['steer'])
    expect(themeSeen).toStrictEqual([])

    await theme.save('tide')
    expect(themeSeen).toStrictEqual(['tide'])
    expect(busySeen).toStrictEqual(['steer'])
  })

  it('reports a value that changes away and back as two changes, and a no-op as none', async () => {
    const { theme } = await mount()
    const seen: string[] = []
    theme.watch(() => { seen.push(theme.current()) })
    await theme.save('tide')
    await theme.save(FALLBACK_THEME.id)
    expect(seen).toStrictEqual(['tide', FALLBACK_THEME.id])
    // Storing the value already in force moved nothing, so there is nothing to
    // publish — the guard is on the resolved value, not on the write happening.
    await theme.save(FALLBACK_THEME.id)
    expect(seen).toStrictEqual(['tide', FALLBACK_THEME.id])
  })

  it('notifies every watcher on the key, and none after one is disposed', async () => {
    const { theme } = await mount()
    const first: string[] = []
    const second: string[] = []
    const stop = theme.watch(() => { first.push(theme.current()) })
    theme.watch(() => { second.push(theme.current()) })
    await theme.save('tide')
    expect(first).toStrictEqual(['tide'])
    expect(second).toStrictEqual(['tide'])
    stop()
    await theme.save('ember')
    expect(first).toStrictEqual(['tide'])
    expect(second).toStrictEqual(['tide', 'ember'])
  })
})

describe('a live choice whose write failed', () => {
  it('is not rolled back when an unrelated key is stored successfully', async () => {
    // The failure this narrowing exists to prevent, in the direction that
    // matters most: `/enter steer` applies live, its write fails and is reported
    // rather than reverted, and a later successful `/theme` must not wake the
    // busyEnter facet and put the reader back on the persisted `queue`.
    const { theme, busyEnter, storage } = await mount()

    // What the window does: hold the live choice itself, seeded from settings
    // and re-seeded only when this key's own resolved value moves.
    let live = busyEnter.current()
    busyEnter.watch(() => { live = busyEnter.current() })
    expect(live).toBe(DEFAULT_BUSY_ENTER)

    live = 'steer'
    storage.reason = 'storage is read-only here'
    expect(await busyEnter.save('steer')).toContain('could not save it')
    storage.reason = undefined

    // An unrelated, successful write to the same row.
    expect(await theme.save('tide')).toBeUndefined()

    expect(live).toBe('steer')
    // And the persisted value genuinely is still the old one, so this is a real
    // divergence rather than a write that quietly succeeded.
    expect(busyEnter.current()).toBe(DEFAULT_BUSY_ENTER)
  })

  it('holds in the other direction too, for the palette', async () => {
    const { theme, busyEnter, storage } = await mount()

    let live = theme.current()
    theme.watch(() => { live = theme.current() })
    expect(live).toBe(FALLBACK_THEME.id)

    live = 'ember'
    storage.reason = 'storage is read-only here'
    expect(await theme.save('ember')).toContain('could not save it')
    storage.reason = undefined

    expect(await busyEnter.save('steer')).toBeUndefined()

    expect(live).toBe('ember')
    expect(theme.current()).toBe(FALLBACK_THEME.id)
  })
})

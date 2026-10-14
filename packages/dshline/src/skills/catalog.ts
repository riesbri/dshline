/**
 * The live view of `ctx.skills` for one attached session.
 *
 * One object, read by three surfaces — the slash menu, the submit
 * adjudication, and the `/skills` inspector — so none of them fetches,
 * filters, or caches on its own. It holds no skill body, performs no
 * discovery, and resolves no duplicate: it observes the catalog Harness has
 * already resolved for THIS agent, at THIS session's cwd, and remembers the
 * last observation that was authoritative.
 *
 * Skills are an optional capability. The registry is reached through
 * `ctx.inject(['skills'], …)` rather than a one-shot `ctx.get`, so a profile
 * that mounts the service later, drops it, or mounts it again is followed
 * rather than sampled once at attach time.
 * @module dshline/skills/catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-working-directory'
// Type-only: the `ctx.skills` service merge, the `skills/change` event merge,
// and the summary shape read below. Never a runtime import — a profile that
// composes no skills must not have to resolve the package, and this frontend
// must never construct, mount, or call into one.
import type { SkillRegistry, SkillSummary } from '@deepseek-ai/dsh-skill'
import type { SkillView } from './model.ts'

/** What the catalog can currently say about the skills of this session. */
export type SkillCatalogReading =
  /** No skill registry is mounted in this composition. */
  | { readonly kind: 'unavailable' }
  /** A registry is mounted and no authoritative observation has arrived yet. */
  | { readonly kind: 'loading' }
  /**
   * Discovery settled without completing and there is no last-good catalog to
   * fall back on. Whatever the incomplete observation did carry is shown, and
   * is never trusted for a negative answer.
   */
  | { readonly kind: 'incomplete'; readonly skills: readonly SkillView[] }
  /** A complete observation, possibly superseded by a change not yet refetched. */
  | {
    readonly kind: 'ready'
    readonly skills: readonly SkillView[]
    /** An invalidation arrived after this catalog was collected. */
    readonly stale: boolean
    /** A refresh is in flight right now. */
    readonly refreshing: boolean
  }

/** What one leading `/name` submission turns out to be. */
export type SkillVerdict =
  /** A user-invocable skill: the line belongs to Harness, unchanged. */
  | { readonly kind: 'user-invocable'; readonly skill: SkillView }
  /** A known skill no human gesture may invoke. Costs no model turn. */
  | { readonly kind: 'not-user-invocable'; readonly skill: SkillView }
  /** An authoritative miss: the existing unknown-command protection applies. */
  | { readonly kind: 'unknown' }
  /** Discovery could not be completed, so nothing may be declared about the name. */
  | { readonly kind: 'unverifiable' }

/** What the catalog needs from the attachment that owns it. */
export interface SkillCatalogSpec {
  /** Context carrying the optional skill registry. */
  readonly ctx: Context
  /**
   * The viewing scope: the attached Agent, which is its own Harness scope key.
   *
   * Omitting it would read the global layer alone and silently hide every
   * skill a preset's own composition contributes.
   */
  readonly scope: object
  /** The attached Session whose committed execution directory selects providers. */
  readonly session: Session
  /** Original project fallback for compositions without working-directory capability. */
  readonly cwd: string
  /** Ask the runner to redraw, and recompute anything already on screen. */
  readonly changed: () => void
}

/**
 * The one Harness skill surface this frontend reads.
 *
 * `snapshot` rather than `list`, because `complete` is the whole difference
 * between "this agent has no such skill" and "discovery did not finish", and
 * only the first of those may deny a submitted line.
 */
export class SkillCatalog {
  private readonly spec: SkillCatalogSpec
  private readonly lifetime = new AbortController()
  private service: SkillRegistry | undefined
  /** The newest COMPLETE observation. Never overwritten by an incomplete one. */
  private complete: readonly SkillView[] | undefined
  /** The newest incomplete observation, shown only while there is no last-good. */
  private partial: readonly SkillView[] | undefined
  /** An invalidation arrived after {@link complete} was collected. */
  private dirty = false
  private refreshing = false
  /** Whether any refresh has settled, so `loading` can end without a catalog. */
  private settled = false
  /** Bumped by every invalidation, so a refresh can tell if it was overtaken. */
  private changes = 0
  /** Bumped by every refresh and every service transition; guards late results. */
  private generation = 0
  private disposed = false

  /** @param spec - the context, the viewing scope, the cwd, and the redraw sink. */
  constructor(spec: SkillCatalogSpec) {
    this.spec = spec
  }

  /**
   * Follow the optional registry for as long as this catalog lives.
   *
   * The injected fiber is what makes mount, unmount, and remount ordinary
   * lifecycle rather than three cases to detect: its body runs once per
   * mount, and its effect's disposer runs on unmount.
   * @returns a disposer that stops following and abandons work in flight.
   */
  install(): () => void {
    const offDirectory = this.spec.ctx.on('session/event', (session, event) => {
      if (session.id !== this.spec.session.id || event.type !== 'working-directory/change') return
      // Last-good is meaningful within one directory, not across projects. An
      // incomplete refresh in the new directory must not advertise the old one.
      this.complete = undefined
      this.partial = undefined
      this.settled = false
      this.invalidate()
    })
    const fiber = this.spec.ctx.inject(['skills'], skillCtx => {
      skillCtx.effect(() => {
        this.attach(skillCtx.skills)
        // The registry's invalidation carries no diff on purpose: it says the
        // catalog MAY have changed, and each consumer refetches with its own
        // lookup options. This one's are the attached agent and its cwd.
        const off = skillCtx.on('skills/change', () => { this.invalidate() })
        return () => {
          off()
          this.detach()
        }
      }, 'skills: catalog')
    })
    return () => {
      offDirectory()
      this.disposed = true
      this.generation += 1
      this.lifetime.abort()
      void fiber.dispose()
    }
  }

  /** What this catalog can currently say. */
  reading(): SkillCatalogReading {
    if (this.service === undefined) return { kind: 'unavailable' }
    if (this.complete !== undefined) {
      return { kind: 'ready', skills: this.complete, stale: this.dirty, refreshing: this.refreshing }
    }
    if (!this.settled) return { kind: 'loading' }
    return { kind: 'incomplete', skills: this.partial ?? [] }
  }

  /**
   * The skills to offer right now, without waiting for anything.
   *
   * The slash menu is rebuilt on every keystroke and cannot await discovery,
   * so it reads whatever the last observation left — which is exactly the
   * behavior a stale POSITIVE is safe for: Harness re-resolves the name at the
   * invocation boundary regardless of what was offered.
   * @returns the last observed skills, or none.
   */
  skills(): readonly SkillView[] {
    const reading = this.reading()
    return reading.kind === 'ready' || reading.kind === 'incomplete' ? reading.skills : []
  }

  /**
   * Decide what a leading `/name` submission is, refetching when the answer
   * would otherwise rest on an observation that may already be wrong.
   *
   * A stale positive is safe; a stale NEGATIVE is not, because a skill added a
   * moment ago would be reported as a typo. So an untrusted catalog is
   * refreshed before anything is denied, and a refresh that still cannot
   * complete yields `unverifiable` rather than a verdict.
   * @param name - the leading token, without its slash.
   * @param signal - bounds the refresh this may have to wait for, so a provider
   *   that never settles cannot leave a submitted line in limbo. An aborted
   *   refresh simply fails to complete, which is already `unverifiable`.
   * @returns what the name turned out to be.
   */
  async verify(name: string, signal?: AbortSignal): Promise<SkillVerdict> {
    if (this.service === undefined) return { kind: 'unknown' }
    if (!this.trusted()) await this.refresh(signal)
    // Re-read after the await: the service can have gone away underneath it,
    // and a catalog collected under a composition that is no longer mounted
    // may not answer for the one that is.
    if (this.service === undefined) return { kind: 'unknown' }
    const found = (this.complete ?? this.partial)?.find(skill => skill.name === name)
    if (found !== undefined) {
      return found.userInvocable
        ? { kind: 'user-invocable', skill: found }
        : { kind: 'not-user-invocable', skill: found }
    }
    return this.trusted() ? { kind: 'unknown' } : { kind: 'unverifiable' }
  }

  /**
   * Refetch the catalog for this agent and cwd.
   *
   * Every call starts its own snapshot and claims a generation: an older
   * observation that resolves late finds the generation moved and drops its
   * result rather than overwriting a newer one.
   * @param signal - an optional caller deadline, honoured alongside this
   *   catalog's own lifetime.
   * @returns when this refresh has settled or been superseded.
   */
  async refresh(signal?: AbortSignal): Promise<void> {
    const service = this.service
    if (service === undefined || this.disposed) return
    const mine = this.generation + 1
    this.generation = mine
    const at = this.changes
    this.refreshing = true
    this.spec.changed()
    let observed: { skills: readonly SkillSummary[]; complete: boolean }
    try {
      observed = await service.snapshot({
        cwd: this.spec.ctx.get('workingDirectory')?.get(this.spec.session) ?? this.spec.cwd,
        scope: this.spec.scope,
        signal: signal === undefined
          ? this.lifetime.signal
          : AbortSignal.any([this.lifetime.signal, signal]),
      })
    } catch {
      // A provider that rejected is a transient failure, not an empty agent:
      // the last-good catalog stands and the next boundary retries. Nothing is
      // reported here — a slash menu is not the place to surface it.
      if (!this.current(mine, service)) return
      this.refreshing = false
      this.settled = true
      this.spec.changed()
      return
    }
    if (!this.current(mine, service)) return
    this.refreshing = false
    this.settled = true
    if (observed.complete) {
      this.complete = observed.skills.map(toView)
      this.partial = undefined
      // An invalidation that landed WHILE this snapshot was collected makes it
      // last-good rather than current: it is still the best answer available,
      // and still not one a denial may rest on.
      this.dirty = this.changes !== at
    } else if (this.complete === undefined) {
      this.partial = observed.skills.map(toView)
    }
    this.spec.changed()
  }

  /**
   * Declare the catalog possibly changed and refetch it.
   *
   * Called by `skills/change` and by the one lifecycle event that changes the
   * effective catalog without a registry mutation: re-parenting this agent's
   * scope onto another preset's composition, or changing its execution directory.
   */
  invalidate(): void {
    this.changes += 1
    this.dirty = true
    this.spec.changed()
    // Failures are already contained inside `refresh`; this call is the
    // fire-and-forget half that keeps the menu current without a poll.
    void this.refresh()
  }

  /** Whether the current catalog may answer a NEGATIVE question. */
  private trusted(): boolean {
    return this.service !== undefined && this.complete !== undefined && !this.dirty
  }

  /**
   * Whether a settled snapshot is still the newest one for the same service.
   * @param generation - the generation the refresh claimed.
   * @param service - the registry the refresh was issued against.
   * @returns whether its result may be applied.
   */
  private current(generation: number, service: SkillRegistry): boolean {
    return !this.disposed && this.generation === generation && this.service === service
  }

  /**
   * Start following a newly mounted registry.
   * @param service - the registry this composition just published.
   */
  private attach(service: SkillRegistry): void {
    this.service = service
    this.generation += 1
    // Nothing to clear: a mount is either the first one or is preceded by
    // {@link detach}, which is where a departing registry's answers are
    // forgotten. Duplicating that here would be a second place to get the
    // ownership rule right.
    this.settled = false
    this.spec.changed()
    void this.refresh()
  }

  /** Stop following a registry that has gone away, and forget what it said. */
  private detach(): void {
    this.service = undefined
    this.generation += 1
    // The answers go with the service that gave them. Reporting `unavailable`
    // already hides them from every reader, so this is the invariant rather
    // than the guard: nothing retains one composition's catalog across the
    // mount of another.
    this.complete = undefined
    this.partial = undefined
    this.refreshing = false
    this.settled = false
    this.dirty = false
    this.spec.changed()
  }
}

/**
 * Copy the facts this frontend presents out of one resolved summary.
 *
 * Provider name, rank, locator, and resource base are deliberately dropped:
 * they are registry implementation, and a terminal that showed them would be
 * making promises about precedence Harness alone resolves.
 * @param summary - one effective skill summary.
 * @returns the presentation view.
 */
function toView(summary: SkillSummary): SkillView {
  return {
    name: summary.name,
    description: summary.description,
    ...summary.whenToUse === undefined ? {} : { whenToUse: summary.whenToUse },
    userInvocable: summary.invocation.userInvocable,
    modelInvocable: summary.invocation.modelInvocable,
    source: summary.source,
  }
}

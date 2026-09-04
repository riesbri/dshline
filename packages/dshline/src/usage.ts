/**
 * What the session has spent: cumulative tokens, and the money they cost.
 *
 * The numbers come from the adapter's own accounting, folded out of
 * `assistant/message` events rather than counted here, so what the status line
 * reports is what the provider billed. Folding happens in the runner's shared
 * projection, which means a resumed session recovers its totals by replaying its
 * log — there is no second restore path that could disagree with the live one.
 *
 * Nothing in this module knows about a terminal, a Context, or an agent, so all
 * of it is testable directly.
 * @module dshline/usage
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
// Type-only, and through the client-safe subpath: it carries the token meter's
// `SessionProjectionMap` keys without the host service's Context merge. The
// meter is an optional plugin, so this is a devDependency and never a peer.
import type {} from '@deepseek-ai/dsh-token-meter/client'
import { formatTokens } from '@dshline/renderer'
import type { SessionPerformance } from './performance.ts'
import { sessionPerformance } from './performance.ts'

/**
 * Prices for one route, in dollars per million tokens.
 *
 * Cached reads are their own rate because providers charge them at a small
 * fraction of an uncached one — DeepSeek bills a cache hit at a thirtieth of a
 * miss — and a session that reuses a long prompt is mostly cache hits. Pricing
 * those as misses would overstate a working day by most of it.
 */
export interface RateSet {
  /** Uncached input, which DeepSeek's price list calls a cache MISS. */
  input: number
  /** Cache reads, its cache HIT; falls back to {@link RateSet.input}. */
  cachedInput?: number
  /**
   * Cache writes.
   *
   * Falls back to {@link RateSet.input} rather than to the cached rate, because
   * on DeepSeek a write IS a miss — the tokens are being read for the first time
   * and stored on the way past — so the miss rate is the right one, not a
   * cheaper one that happens to have `cache` in its name.
   */
  cachedWrite?: number
  /** Output, reasoning included; the adapter reports reasoning inside it. */
  output: number
}

/**
 * One route's prices, and how they change with the clock.
 *
 * The bare fields are the rate that applies most of the day, and `peak` is the
 * exception. That is the way round it is because DeepSeek's peak is the narrow
 * window — a few hours of the morning — so the common case reads as the plain
 * one, and a table written without a `peak` block simply prices the same all day
 * rather than silently picking one column of a two-column price list.
 */
export interface ModelRates extends RateSet {
  /** Prices during a peak window; the bare fields apply outside one. */
  peak?: RateSet
}

/** Rates by route, as {@link pricingKey} builds the key. */
export type PricingTable = ReadonlyMap<string, ModelRates>

/** Minutes past midnight UTC, as a half-open range. */
export interface PeakWindow {
  /** First minute of the window. */
  from: number
  /** First minute after it. */
  to: number
}

/** Tokens are priced per million, which is how every provider publishes rates. */
const TOKENS_PER_PRICED_UNIT = 1_000_000

/** Dollar amounts at or above this read naturally with two decimals. */
const CENTS_PRECISION_FROM = 1

/** Below a dollar, three decimals; below this, a session's first turns read `$0.00`. */
const MILLS_PRECISION_FROM = 0.01

/** Decimals a cache-read share keeps, so 99.8% cannot read as 100%. */
const SHARE_DECIMALS = 1

/**
 * What a share below the printable resolution reads as, and what one above it reads as.
 *
 * Both state that resolution as a BOUND rather than as a value: `<0.1%` is true
 * of every share in the gap above zero, where `0.1%` would be a different number
 * from the one measured, and `>99.9%` is true of every share below the whole.
 */
const SHARE_BELOW_RESOLUTION = '<0.1%'
const SHARE_ABOVE_RESOLUTION = '>99.9%'

/** Minutes in an hour and in a day, for reading a clock time off a timestamp. */
const MINUTES_PER_HOUR = 60
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR

/**
 * When DeepSeek charges its standard rate; every other hour is discounted.
 *
 * Two windows rather than one, and stated as the PEAK rather than as the
 * discount, because that is the shape of the published list: the standard price
 * applies 01:00–04:00 and 06:00–10:00 UTC, and the rest of the day — most of it —
 * is off-peak. A deployment on a different schedule overrides this in config.
 */
const DEFAULT_PEAK_WINDOWS: readonly PeakWindow[] = [
  { from: 1 * MINUTES_PER_HOUR, to: 4 * MINUTES_PER_HOUR },
  { from: 6 * MINUTES_PER_HOUR, to: 10 * MINUTES_PER_HOUR },
]

/**
 * DeepSeek's published list, per model.
 *
 * Dollars per million tokens, off-peak in the bare fields and standard under
 * `peak`. Written once here and attached below to each route billed this way, so
 * a rate change is one edit rather than one per route.
 */
const DEEPSEEK_RATES: Readonly<Record<string, ModelRates>> = {
  'deepseek-v4-flash': {
    input: 0.22,
    cachedInput: 0.007,
    output: 0.66,
    peak: { input: 0.44, cachedInput: 0.014, output: 1.32 },
  },
  'deepseek-v4-pro': {
    input: 0.66,
    cachedInput: 0.022,
    output: 1.98,
    peak: { input: 1.32, cachedInput: 0.044, output: 3.96 },
  },
}

/**
 * Routes this interface prices at {@link DEEPSEEK_RATES}.
 *
 * Naming the routes is the point, rather than pricing the model ids wherever they
 * turn up. A model reached through a gateway is billed by the gateway, on its own
 * terms, so a bare-model default would quietly put one company's price list
 * against another's invoice — a route not named here shows tokens and no money
 * until it is given rates of its own.
 *
 * `opencode` and `opencode-go` are the two OpenCode routes the installed catalog
 * carries — `opencode` for OpenCode Zen and `opencode-go` for OpenCode Go — the
 * payer this interface is built to run against. Both share one set of numbers:
 * DeepSeek's own list, the accounting OpenCode matches for its DeepSeek models.
 * A route that bills differently is one config entry to correct, and an entry
 * replaces the shipped one outright rather than merging into it; see
 * {@link pricingFrom}.
 */
const DEEPSEEK_BILLED_ROUTES: readonly string[] = ['deepseek-official', 'opencode', 'opencode-go']

/** Published rates for the routes this interface is built against. */
const DEFAULT_PRICING: PricingTable = new Map<string, ModelRates>(
  DEEPSEEK_BILLED_ROUTES.flatMap(route => Object.entries(DEEPSEEK_RATES)
    .map(([model, rates]): [string, ModelRates] => [pricingKey(route, model), rates])),
)

/**
 * The lookup key for one route.
 * @param provider - provider route key.
 * @param model - provider-owned model id.
 * @returns the key a {@link PricingTable} is indexed by.
 */
export function pricingKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/**
 * Whether a configured rate is usable.
 *
 * A negative or non-finite rate is not a cheaper price, it is a broken one, and
 * arithmetic on it would put `NaN` or a credit in the status line.
 * @param value - the configured value.
 * @returns whether it can be multiplied by a token count.
 */
function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * One set of rates from configuration, or nothing when it is incomplete.
 *
 * Both required rates must be present together: an entry naming only one of them
 * would price half the traffic and silently understate the rest, which is worse
 * than reporting no price at all.
 * @param raw - the configured value, of any shape.
 * @returns the rates, or undefined.
 */
function parseRates(raw: unknown): RateSet | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { input, cachedInput, cachedWrite, output } = raw as Record<string, unknown>
  if (!isRate(input) || !isRate(output)) return undefined
  return {
    input,
    output,
    ...isRate(cachedInput) ? { cachedInput } : {},
    ...isRate(cachedWrite) ? { cachedWrite } : {},
  }
}

/**
 * Read a pricing table out of plugin configuration.
 *
 * Deliberately total: an entry that does not describe a price is dropped rather
 * than thrown over. Prices are a convenience on a status line, and a typo in a
 * machine-local config file must not be the reason a terminal refuses to start.
 * @param raw - the `pricing` value from the plugin's config, of any shape.
 * @returns the entries that were complete and usable.
 */
export function parsePricing(raw: unknown): PricingTable {
  const table = new Map<string, ModelRates>()
  if (typeof raw !== 'object' || raw === null) return table
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const base = parseRates(value)
    if (base === undefined) continue
    const peak = parseRates((value as Record<string, unknown>).peak)
    table.set(key, { ...base, ...peak === undefined ? {} : { peak } })
  }
  return table
}

/**
 * The published rates, with configuration layered over them.
 *
 * A configured entry REPLACES the shipped one for that key rather than merging
 * field by field. Half a correction is the dangerous shape: someone fixing an
 * output price would not expect the input price beside it to stay at whatever
 * this release was built with.
 * @param raw - the `pricing` value from the plugin's config, of any shape.
 * @returns every route this session can price.
 */
export function pricingFrom(raw: unknown): PricingTable {
  return new Map([...DEFAULT_PRICING, ...parsePricing(raw)])
}

/**
 * One clock time from configuration, as minutes past midnight.
 * @param raw - a `HH:MM` string.
 * @returns the minute, or undefined when it does not read as a time.
 */
function parseClock(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined
  const match = /^(?<hour>\d{1,2}):(?<minute>\d{2})$/u.exec(raw.trim())
  const hour = Number(match?.groups?.hour)
  const minute = Number(match?.groups?.minute)
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined
  if (hour > 23 || minute > 59) return undefined
  return hour * MINUTES_PER_HOUR + minute
}

/**
 * Read peak windows out of plugin configuration.
 *
 * An unreadable list falls back to the published windows rather than to none.
 * Falling back to none would price a whole session off-peak, which is the
 * cheaper answer and therefore the one nobody notices is wrong.
 * @param raw - the `peakHoursUtc` value from the plugin's config, of any shape.
 * @returns the windows to charge the standard rate in.
 */
export function parsePeakWindows(raw: unknown): readonly PeakWindow[] {
  if (!Array.isArray(raw)) return DEFAULT_PEAK_WINDOWS
  const windows: PeakWindow[] = []
  for (const entry of raw as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue
    const from = parseClock((entry as Record<string, unknown>).from)
    const to = parseClock((entry as Record<string, unknown>).to)
    if (from === undefined || to === undefined || from === to) continue
    windows.push({ from, to })
  }
  return windows.length === 0 ? DEFAULT_PEAK_WINDOWS : windows
}

/**
 * Whether a moment falls in a peak window.
 *
 * Windows are read in UTC because that is the timezone a provider publishes its
 * schedule in; reading them in the machine's zone would move everyone's prices
 * by their offset. A window whose end is before its start wraps midnight.
 * @param at - unix epoch milliseconds.
 * @param windows - the peak windows.
 * @returns whether the standard rate applies.
 */
export function isPeak(at: number, windows: readonly PeakWindow[]): boolean {
  const date = new Date(at)
  const minute = (date.getUTCHours() * MINUTES_PER_HOUR + date.getUTCMinutes()) % MINUTES_PER_DAY
  return windows.some(window => window.from < window.to
    ? minute >= window.from && minute < window.to
    : minute >= window.from || minute < window.to)
}

/** Cumulative session usage as the status line reports it. */
export interface UsageReading {
  /** Every prompt token sent: uncached, cache reads, and cache writes together. */
  inputTokens: number
  /** Every token generated, reasoning included. */
  outputTokens: number
  /** Dollars spent, or undefined when no observed message had a known rate. */
  costUsd: number | undefined
  /**
   * Whether some observed usage could not be priced, so {@link UsageReading.costUsd}
   * is a floor rather than the total.
   */
  partial: boolean
}

/**
 * Running totals for one session.
 *
 * Cost is accrued per message, at the rate of the model that produced *that*
 * message and the rate in force at the moment it ran. Totalling the tokens first
 * and pricing them once at the end would bill the whole session at whichever
 * model happened to be selected last, on whichever side of the peak boundary the
 * reader happened to look.
 */
export class SessionUsage {
  private inputTokens = 0
  private outputTokens = 0
  private costUsd = 0
  private priced = false
  private unpriced = false

  /**
   * @param pricing - rates by route, usually from plugin configuration.
   * @param peakWindows - when the standard rate applies.
   */
  constructor(
    private readonly pricing: PricingTable,
    private readonly peakWindows: readonly PeakWindow[] = DEFAULT_PEAK_WINDOWS,
  ) {}

  /**
   * The rates for one route, if any are known.
   *
   * An exact route is preferred, then the model on its own. The fallback is what
   * lets one entry cover a model wherever it is served, and it is deliberately
   * only reachable from configuration: nothing shipped is keyed that way, so a
   * gateway never inherits the direct provider's price list by accident.
   * @param provider - the route.
   * @param model - the model id.
   * @returns the rates, or undefined.
   */
  private ratesFor(provider: string, model: string): ModelRates | undefined {
    return this.pricing.get(pricingKey(provider, model)) ?? this.pricing.get(model)
  }

  /**
   * Fold one message's accounting into the totals.
   *
   * The buckets are disjoint: `inputTokens` counts uncached input ONLY, with cache
   * reads and writes reported beside it, and `reasoningTokens` is already inside
   * `outputTokens`. Adding reasoning again is the mistake this comment exists to
   * name — it would inflate output on exactly the models people run it for.
   * @param usage - the adapter's accounting for one assistant message.
   * @param provider - the route that produced it, when known.
   * @param model - the model that produced it, when known.
   * @param at - when the message was logged, in unix epoch milliseconds.
   */
  observe(usage: TokenUsage, provider: string | undefined, model: string | undefined, at: number): void {
    const cacheRead = usage.cacheReadTokens ?? 0
    const cacheWrite = usage.cacheWriteTokens ?? 0
    this.inputTokens += usage.inputTokens + cacheRead + cacheWrite
    this.outputTokens += usage.outputTokens

    const known = provider === undefined || model === undefined
      ? undefined
      : this.ratesFor(provider, model)
    if (known === undefined) {
      // Remembered rather than ignored: a total that quietly omits some traffic
      // reads as the whole bill, and the reader has no way to tell.
      this.unpriced = true
      return
    }
    const rates = isPeak(at, this.peakWindows) && known.peak !== undefined ? known.peak : known
    this.priced = true
    this.costUsd += (
      usage.inputTokens * rates.input
      + cacheRead * (rates.cachedInput ?? rates.input)
      + cacheWrite * (rates.cachedWrite ?? rates.input)
      + usage.outputTokens * rates.output
    ) / TOKENS_PER_PRICED_UNIT
  }

  /** The totals so far. */
  get reading(): UsageReading {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.priced ? this.costUsd : undefined,
      partial: this.priced && this.unpriced,
    }
  }
}

/**
 * Provider-reported cumulative usage, in the four disjoint buckets Harness
 * publishes.
 *
 * These come from the `tokenUsage` session projection, whose scope is the
 * agent's own model requests: it folds one usage sample per durable Assistant
 * settlement — `assistant/message` and the `assistant/attempt` a failed or
 * cancelled call leaves — across the complete durable log, replacing a repeated
 * sample for one attempt and re-counting after `llm/retry-started`.
 * Compaction and surface replacement do not erase earlier billing, so a request
 * whose messages were later summarized away is still counted.
 *
 * An AUXILIARY provider call is not. A compaction's summarizer reports its own
 * usage on the `compaction/summary` event, which this projection does not fold —
 * confirmed against upstream's own projection test, which appends that event and
 * asserts the buckets do not move.
 *
 * This scope is Harness's, and dshline does not restate it as its own: the
 * pricing fold in {@link SessionUsage} observes finalized `assistant/message`
 * usage only, because it also needs the route and the moment to price by. The
 * two folds can therefore differ — an attempt that reported usage in a chunk and
 * then failed is counted here and nowhere else. See {@link usageInspection}.
 */
export interface UsageBuckets {
  /** Prompt tokens the provider billed as a cache miss. */
  readonly uncachedInput: number
  /** Prompt tokens served from the provider's cache. */
  readonly cacheRead: number
  /** Prompt tokens written into it on the way past. */
  readonly cacheWrite: number
  /** The three prompt buckets together. */
  readonly input: number
  /** Generated tokens, reasoning included. */
  readonly output: number
}

/** Everything the `/usage` inspector can truthfully report. */
export interface UsageInspection {
  /** Whether this profile mounted the generic projection infrastructure. */
  readonly projections: boolean
  /** Harness's own cumulative buckets, when its usage unit is registered. */
  readonly buckets: UsageBuckets | undefined
  /** dshline's own pricing fold: the tokens it priced, and the money. */
  readonly reading: UsageReading
  /** Share of prompt tokens served from cache; see {@link cacheReadShare}. */
  readonly cacheReadShare: number | undefined
  /**
   * How the session ran, from Harness's `sessionStats` projection.
   *
   * Part of this reading rather than a separate one because it comes from the
   * SAME projection cut as {@link UsageInspection.buckets}: the two
   * projection-backed halves of the report cannot describe two different
   * moments. {@link UsageInspection.reading} is the exception and stays one —
   * it is dshline's own pricing fold, not a value in that snapshot.
   */
  readonly performance: SessionPerformance
}

/**
 * Read cumulative usage from Harness's projection and dshline's own fold.
 *
 * Both, on purpose, because their scopes differ and neither subsumes the other.
 * Harness's `tokenUsage` is the authority on what the provider reported for the
 * agent's requests across the whole durable log. dshline's {@link SessionUsage}
 * exists for the one thing that projection cannot retain: cost, which depends on
 * the route each message ran on and the price in force at the moment it ran. The
 * buckets are therefore reported from Harness and the money from dshline.
 *
 * The two are NOT claimed to share one scope, and on an ordinary session they
 * need not. Harness folds every durable Assistant settlement, the
 * `assistant/attempt` of a failed or cancelled call included, replacing a
 * repeated sample for one attempt and re-counting after `llm/retry-started`;
 * dshline's pricing fold sees finalized `assistant/message` usage only, because
 * pricing needs the route and the moment beside the tokens.
 * A retried request therefore counts an attempt in the buckets that the money
 * never priced. Each figure is reported as what its own authority says, and
 * neither is divided into the other.
 *
 * When the projection is absent, the inspector falls back to dshline's own
 * totals rather than leaving a hole — without the cache split, and without
 * claiming it is the same accounting.
 *
 * Performance comes from the same cut, and has no dshline fold behind it at all
 * — see {@link SessionPerformance}. A profile without the `sessionStats` unit
 * reports no performance figures rather than reconstructed ones.
 * @param snapshot - the authoritative projection cut, or undefined when the profile mounts no registry.
 * @param reading - dshline's current fold.
 * @returns the inspector's reading.
 */
export function usageInspection(
  snapshot: ProjectionSnapshot | undefined,
  reading: UsageReading,
): UsageInspection {
  const buckets = usageBuckets(snapshot)
  return {
    projections: snapshot !== undefined,
    buckets,
    reading,
    cacheReadShare: cacheReadShare(buckets),
    // One cut read once, so the two projection-backed halves of the report
    // describe one moment. The money beside them is a separate fold.
    performance: sessionPerformance(snapshot),
  }
}

/**
 * Harness's cumulative buckets for one projection cut, in dshline's shape.
 *
 * The single place the projection's four numbers are read, so the inspector and
 * the status line cannot end up disagreeing about what the same cut said. The
 * projection is the authority; nothing here counts a token.
 * @param snapshot - the authoritative projection cut, or undefined when the profile mounts no registry.
 * @returns the buckets, or undefined when the profile's usage unit is not registered.
 */
export function usageBuckets(snapshot: ProjectionSnapshot | undefined): UsageBuckets | undefined {
  const totals = snapshot?.values.tokenUsage
  if (totals === undefined) return undefined
  return {
    uncachedInput: totals.uncachedInputTokens,
    cacheRead: totals.cacheReadTokens,
    cacheWrite: totals.cacheWriteTokens,
    input: totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
    output: totals.outputTokens,
  }
}

/**
 * Share of prompt tokens the provider served from cache, 0 to 1.
 *
 * `cacheRead / (uncachedInput + cacheRead + cacheWrite)` over Harness's
 * cumulative model-request usage, derived from {@link usageBuckets} and nothing
 * else — so it is a share of THAT accounting, and not of the totals dshline
 * priced. Deliberately NOT a provider-reported hit rate either: Harness
 * publishes token buckets, and naming a ratio after a metric nobody reported
 * would invite it to be compared with one.
 *
 * A cut with no prompt tokens at all has NO share rather than `0%`: there is no
 * denominator, and reporting zero would claim a cold cache for a session that
 * has not asked anything yet.
 * @param buckets - one cut's buckets, or undefined.
 * @returns the ratio, or undefined when there is nothing to divide.
 */
export function cacheReadShare(buckets: UsageBuckets | undefined): number | undefined {
  if (buckets === undefined || buckets.input <= 0) return undefined
  return buckets.cacheRead / buckets.input
}

/**
 * A cache-read share as a percentage, at one decimal.
 *
 * One decimal because the interesting range is the top of it: a long session
 * reusing one prompt sits at ninety-nine-point-something, and whole percents
 * report every one of those as `100%` — a figure that reads as "nothing was
 * missed" when a fifth of a percent was. A round value still prints without a
 * trailing `.0`, which says the same thing in fewer columns.
 *
 * `0%` and `100%` are reported only for a share that really is none or all of
 * the prompt. A share between an endpoint and the printable resolution is
 * reported as a bound — {@link SHARE_BELOW_RESOLUTION},
 * {@link SHARE_ABOVE_RESOLUTION} — rather than moved to the nearest printable
 * number: the display's precision is allowed to run out, but the value is not
 * allowed to change on the way to the screen.
 * @param share - the ratio, 0 to 1, or undefined when there is no denominator.
 * @returns e.g. `99.8%`, `>99.9%`, `100%`, or undefined when there is nothing true to report.
 */
export function formatCacheShare(share: number | undefined): string | undefined {
  if (share === undefined || !Number.isFinite(share)) return undefined
  if (share <= 0) return '0%'
  if (share >= 1) return '100%'
  const percent = Number((share * 100).toFixed(SHARE_DECIMALS))
  if (percent <= 0) return SHARE_BELOW_RESOLUTION
  if (percent >= 100) return SHARE_ABOVE_RESOLUTION
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(SHARE_DECIMALS)}%`
}

/**
 * The status line's cache-read segment.
 *
 * Labelled `CR` because the line is measured in columns and the figure is a
 * convenience reading; the inspector spells the same fact out in full. It
 * follows the reader's usage preference, since `off` asks for the status line to
 * be left to the context reading rather than for one usage figure of three.
 *
 * It reports Harness's own cumulative model-request usage, which is not the
 * accounting behind the `↑`/`↓` totals beside it — see {@link usageInspection} —
 * and it says how much of the prompt came from cache, not what that cost: how
 * much a cache read saves is a route's own pricing question.
 * @param share - the ratio, or undefined when there is no denominator.
 * @param mode - how much of the usage reading the reader wants.
 * @returns e.g. `CR 99.8%`, `CR >99.9%`, or undefined when there is nothing to report.
 */
export function formatCacheRead(share: number | undefined, mode: UsageMode): string | undefined {
  if (mode === 'off') return undefined
  const percent = formatCacheShare(share)
  return percent === undefined ? undefined : `CR ${percent}`
}

/**
 * A dollar amount for the inspector, at the same precision the status line uses.
 * @param value - dollars.
 * @returns e.g. `$0.0018`, `$1.24`.
 */
export function usageCost(value: number): string {
  return formatCost(value)
}

/** How much of the usage reading the status line carries. */
export type UsageMode = 'cost' | 'tokens' | 'off'

/** The modes `/usage` offers, in the order the picker lists them. */
export const USAGE_MODES: readonly { id: UsageMode; name: string; description: string }[] = [
  { id: 'cost', name: 'Tokens and cost', description: 'What was sent, what came back, and what it cost' },
  { id: 'tokens', name: 'Tokens only', description: 'The counts without the money' },
  { id: 'off', name: 'Off', description: 'Leave the status line to the context reading' },
]

/**
 * The mode an argument names, if any.
 * @param argument - the text after the command name.
 * @returns the matching mode, or undefined when nothing matched.
 */
export function resolveUsageMode(argument: string): UsageMode | undefined {
  const wanted = argument.trim().toLowerCase()
  return USAGE_MODES.find(mode => mode.id === wanted)?.id
}

/**
 * A dollar amount with enough digits to be non-zero.
 *
 * Two decimals is the natural form for money, and it is also useless here: a
 * session's first several turns cost fractions of a cent, and a meter that reads
 * `$0.00` for the first twenty minutes is one the reader stops looking at. The
 * precision therefore follows the magnitude.
 * @param value - dollars.
 * @returns e.g. `$0.0018`, `$0.018`, `$1.24`.
 */
function formatCost(value: number): string {
  if (value >= CENTS_PRECISION_FROM) return `$${value.toFixed(2)}`
  if (value >= MILLS_PRECISION_FROM) return `$${value.toFixed(3)}`
  return `$${value.toFixed(4)}`
}

/**
 * The status line's usage segment.
 *
 * The cost is omitted entirely when no rate is configured for the models that
 * ran, rather than shown as zero: the same rule the context bar follows, where
 * nothing is drawn before there is something true to draw. A `~` marks a total
 * that is a floor because part of the session had no rates.
 * @param reading - the current totals.
 * @param mode - how much of it to report.
 * @returns e.g. `↑8.8k ↓1.6k $0.018`, or undefined when the mode is `off`.
 */
export function formatUsage(reading: UsageReading, mode: UsageMode): string | undefined {
  if (mode === 'off') return undefined
  const tokens = `↑${formatTokens(reading.inputTokens)} ↓${formatTokens(reading.outputTokens)}`
  if (mode === 'tokens' || reading.costUsd === undefined) return tokens
  return `${tokens} ${reading.partial ? '~' : ''}${formatCost(reading.costUsd)}`
}

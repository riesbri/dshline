import { describe, expect, it } from 'vitest'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { PeakWindow } from '../src/usage.ts'
import {
  formatUsage,
  isPeak,
  parsePeakWindows,
  parsePricing,
  pricingFrom,
  resolveUsageMode,
  SessionUsage,
  USAGE_MODES,
} from '../src/usage.ts'

/** The route the shipped rates are keyed to. */
const PROVIDER = 'deepseek-official'

/** The OpenCode route ids the shipped rates key alongside the direct one. */
const OPENCODE_ROUTES = ['opencode', 'opencode-go']

/** A table with one priced route, at rates chosen to make the arithmetic legible. */
const RATES = parsePricing({
  [`${PROVIDER}/deepseek-v4-flash`]: { input: 1, cachedInput: 0.1, output: 2 },
})

/** A moment inside a peak window, and one outside every window. */
const PEAK = Date.UTC(2026, 7, 18, 2, 0)
const OFF_PEAK = Date.UTC(2026, 7, 18, 12, 0)

/**
 * One adapter accounting record, with the optional buckets left off by default.
 * @param buckets - the buckets this record reports.
 * @returns the record.
 */
function usage(buckets: Partial<TokenUsage>): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, ...buckets }
}

describe('parsePricing()', () => {
  it('keeps an entry that names both required rates', () => {
    expect(parsePricing({ 'a/b': { input: 1, output: 2 } }).get('a/b')?.rates).toEqual({ input: 1, output: 2 })
  })

  it('reads a configured entry as the route’s own billing', () => {
    // Configuration states what a route charges, so its money reads as `cost`
    // rather than as a public-API equivalent.
    expect(parsePricing({ 'a/b': { input: 1, output: 2 } }).get('a/b')?.basis).toBe('billed')
  })

  it('carries the optional cache rates through', () => {
    const table = parsePricing({ 'a/b': { input: 1, output: 2, cachedInput: 0.1, cachedWrite: 1.25 } })
    expect(table.get('a/b')?.rates).toEqual({ input: 1, output: 2, cachedInput: 0.1, cachedWrite: 1.25 })
  })

  it('reads a peak override beside the everyday rates', () => {
    const table = parsePricing({ 'a/b': { input: 1, output: 2, peak: { input: 2, output: 4 } } })
    expect(table.get('a/b')?.rates.peak).toEqual({ input: 2, output: 4 })
  })

  it('drops a peak override that is not itself a complete price', () => {
    // Half a peak block would charge the standard rate on one bucket and the
    // discount on the next, which is not a price either column ever named.
    const table = parsePricing({ 'a/b': { input: 1, output: 2, peak: { input: 2 } } })
    expect(table.get('a/b')?.rates).toEqual({ input: 1, output: 2 })
  })

  it('carries a complete rate tier through', () => {
    const table = parsePricing({
      'a/b': { input: 1, output: 2, tier: { inputTokensAbove: 272_000, input: 2, output: 4, cachedInput: 0.5 } },
    })
    expect(table.get('a/b')?.rates.tier).toEqual({
      inputTokensAbove: 272_000,
      rates: { input: 2, output: 4, cachedInput: 0.5 },
    })
  })

  it('drops a tier that is not itself a complete price', () => {
    const table = parsePricing({ 'a/b': { input: 1, output: 2, tier: { inputTokensAbove: 272_000, input: 2 } } })
    expect(table.get('a/b')?.rates.tier).toBeUndefined()
    expect(table.get('a/b')?.rates).toEqual({ input: 1, output: 2 })
  })

  it('drops an entry priced on only one side', () => {
    expect(parsePricing({ 'a/b': { input: 1 } }).size).toBe(0)
    expect(parsePricing({ 'a/b': { output: 2 } }).size).toBe(0)
  })

  it('drops a rate that cannot be multiplied by a token count', () => {
    expect(parsePricing({ 'a/b': { input: -1, output: 2 } }).size).toBe(0)
    expect(parsePricing({ 'a/b': { input: Number.NaN, output: 2 } }).size).toBe(0)
    expect(parsePricing({ 'a/b': { input: '1', output: 2 } }).size).toBe(0)
  })

  it('survives configuration that is not a table at all', () => {
    // A typo in a machine-local config file must not be why a terminal refuses
    // to start, so every one of these is a table with nothing in it.
    expect(parsePricing(undefined).size).toBe(0)
    expect(parsePricing(null).size).toBe(0)
    expect(parsePricing('deepseek').size).toBe(0)
    expect(parsePricing({ 'a/b': null }).size).toBe(0)
  })
})

describe('the shipped rates', () => {
  it('prices the routes this interface is built against', () => {
    const table = pricingFrom(undefined)
    for (const route of [PROVIDER, ...OPENCODE_ROUTES]) {
      expect(table.get(`${route}/deepseek-v4-flash`), route).toBeDefined()
      expect(table.get(`${route}/deepseek-v4-pro`), route).toBeDefined()
    }
  })

  it('prices OpenCode Zen and OpenCode Go at the same per-model rates', () => {
    // This interface runs against OpenCode and against DeepSeek directly, serving
    // the same two models, so both OpenCode routes — `opencode` for Zen and
    // `opencode-go` for Go — are named rather than only the direct one. The
    // numbers are DeepSeek's; correcting them is a config entry.
    const session = new SessionUsage(pricingFrom(undefined))
    session.observe(usage({ inputTokens: 1_000_000 }), 'opencode', 'deepseek-v4-pro', OFF_PEAK)
    session.observe(usage({ inputTokens: 1_000_000 }), 'opencode-go', 'deepseek-v4-pro', OFF_PEAK)
    expect(session.reading.costUsd).toBeCloseTo(1.32, 10)
  })

  it('prices the opencode-go route this interface actually runs on', () => {
    // The payer here is registered under `opencode-go` (OpenCode Go), not the
    // plain `opencode` id OpenCode Zen uses, and a message from it was reported
    // as tokens with no money until the shipped table named the id. The money
    // must round-trip off-peak exactly like the direct route's does.
    const session = new SessionUsage(pricingFrom(undefined))
    session.observe(usage({ inputTokens: 1_000_000 }), 'opencode-go', 'deepseek-v4-flash', OFF_PEAK)
    expect(session.reading.costUsd).toBeCloseTo(0.22, 10)
    expect(session.reading.partial).toBe(false)
  })

  it('prices a session that spanned the direct route and OpenCode Go', () => {
    // A `/model` switch from the direct API to OpenCode Go must not drop the money
    // for either half: with both routes named, the whole session is priced and the
    // total is not marked as a floor.
    const session = new SessionUsage(pricingFrom(undefined))
    session.observe(usage({ inputTokens: 1_000_000 }), PROVIDER, 'deepseek-v4-flash', OFF_PEAK)
    session.observe(usage({ inputTokens: 1_000_000 }), 'opencode-go', 'deepseek-v4-flash', OFF_PEAK)
    expect(session.reading.costUsd).toBeCloseTo(0.44, 10)
    expect(session.reading.partial).toBe(false)
  })

  it('prices only the routes it names, never a model id on its own', () => {
    // A model reached through some other gateway is billed by that gateway, so a
    // bare-model default would put one company's price list against another's
    // invoice. Every shipped entry is qualified by a route.
    const table = pricingFrom(undefined)
    expect(table.get('deepseek-v4-flash')).toBeUndefined()
    expect(table.get('deepseek-v4-pro')).toBeUndefined()

    const session = new SessionUsage(table)
    session.observe(usage({ inputTokens: 1_000_000 }), 'some-other-gateway', 'deepseek-v4-pro', OFF_PEAK)
    expect(session.reading.costUsd).toBeUndefined()
  })

  it('lets one route be corrected without touching the other', () => {
    // The rates are written once and attached to each route, so the thing worth
    // pinning is that they stay separable afterwards.
    const table = pricingFrom({ 'opencode/deepseek-v4-pro': { input: 9, output: 9 } })
    expect(table.get('opencode/deepseek-v4-pro')?.rates).toEqual({ input: 9, output: 9 })
    expect(table.get(`${PROVIDER}/deepseek-v4-pro`)?.rates.input).toBeCloseTo(0.66, 10)
  })

  it('charges a v4-flash cache miss at the published pair', () => {
    const session = new SessionUsage(pricingFrom(undefined))
    session.observe(usage({ inputTokens: 1_000_000 }), PROVIDER, 'deepseek-v4-flash', OFF_PEAK)
    expect(session.reading.costUsd).toBeCloseTo(0.22, 10)

    const peak = new SessionUsage(pricingFrom(undefined))
    peak.observe(usage({ inputTokens: 1_000_000 }), PROVIDER, 'deepseek-v4-flash', PEAK)
    expect(peak.reading.costUsd).toBeCloseTo(0.44, 10)
  })

  it('charges v4-pro output at the published pair', () => {
    const session = new SessionUsage(pricingFrom(undefined))
    session.observe(usage({ outputTokens: 1_000_000 }), PROVIDER, 'deepseek-v4-pro', OFF_PEAK)
    expect(session.reading.costUsd).toBeCloseTo(1.98, 10)

    const peak = new SessionUsage(pricingFrom(undefined))
    peak.observe(usage({ outputTokens: 1_000_000 }), PROVIDER, 'deepseek-v4-pro', PEAK)
    expect(peak.reading.costUsd).toBeCloseTo(3.96, 10)
  })

  it('lets configuration replace a shipped entry outright', () => {
    // Replaced, not merged field by field: someone correcting an output price
    // would not expect the input price beside it to stay at whatever this
    // release was built with.
    const table = pricingFrom({ [`${PROVIDER}/deepseek-v4-flash`]: { input: 9, output: 9 } })
    expect(table.get(`${PROVIDER}/deepseek-v4-flash`)?.rates).toEqual({ input: 9, output: 9 })
  })
})

describe('the shipped API-equivalent pricing', () => {
  it('prices the OAuth Codex route at the OpenAI public API rates', () => {
    // `openai-codex` is the route a ChatGPT sign-in serves, recorded by that
    // exact id; its money is the public API equivalent — the prices on
    // developers.openai.com — never a subscription charge. gpt-5.5 official:
    // $5 input / $0.50 cached / $30 output, short context (200k request input).
    const session = new SessionUsage(pricingFrom(undefined))
    session.observe(usage({ inputTokens: 200_000 }), 'openai-codex', 'gpt-5.5', OFF_PEAK)
    expect(session.reading.apiEquivalentUsd).toBeCloseTo(1, 10)
    expect(session.reading.billedUsd).toBeUndefined()
    expect(session.reading.costUsd).toBeCloseTo(1, 10)
    expect(session.reading.partial).toBe(false)
  })

  it('prices Codex cache reads and writes at their own published rates', () => {
    // gpt-5.6-luna official: $0.20 uncached / $0.02 cached read / $1.20 output,
    // and cache writes at 1.25x uncached input ($0.25). Total request input is
    // 150k, below the 272k tier.
    const session = new SessionUsage(pricingFrom(undefined))
    session.observe(usage({
      inputTokens: 50_000, cacheReadTokens: 50_000, cacheWriteTokens: 50_000, outputTokens: 50_000,
    }), 'openai-codex', 'gpt-5.6-luna', OFF_PEAK)
    expect(session.reading.apiEquivalentUsd).toBeCloseTo(0.0835, 10)
  })

  it('prices an OpenAI cache write at the model’s explicit rate, never as a miss', () => {
    // gpt-5.4/gpt-5.4-mini/gpt-5.5 publish NO cache-write rate, so their shipped
    // `cachedWrite` is an explicit zero — a written token costs nothing — while
    // the gpt-5.6 family bills writes at 1.25x on every tier. Neither inherits
    // the DeepSeek rule that a write IS a miss.
    const table = pricingFrom(undefined)
    expect(table.get('openai-codex/gpt-5.5')?.rates.cachedWrite).toBe(0)
    expect(table.get('openai-codex/gpt-5.4')?.rates.cachedWrite).toBe(0)
    expect(table.get('openai-codex/gpt-5.4-mini')?.rates.cachedWrite).toBe(0)
    expect(table.get('openai-codex/gpt-5.6-luna')?.rates.cachedWrite).toBe(0.25)
    expect(table.get('openai-codex/gpt-5.6-luna')?.rates.tier?.rates.cachedWrite).toBe(0.5)

    const session = new SessionUsage(table)
    session.observe(usage({ inputTokens: 100_000, cacheWriteTokens: 100_000 }), 'openai-codex', 'gpt-5.5', OFF_PEAK)
    expect(session.reading.apiEquivalentUsd).toBeCloseTo(0.5, 10)
  })

  it('prices a request at the long-context tier only once its input crosses the bound', () => {
    // gpt-5.4 official: short $2.50/$0.25/$15.00, long (input above 272k)
    // $5/$0.50/$22.50 for the whole request. Exactly at the bound is still
    // short; one token past it is long.
    const short = new SessionUsage(pricingFrom(undefined))
    short.observe(usage({ inputTokens: 272_000 }), 'openai-codex', 'gpt-5.4', OFF_PEAK)
    expect(short.reading.apiEquivalentUsd).toBeCloseTo(0.68, 10)

    const long = new SessionUsage(pricingFrom(undefined))
    long.observe(usage({ inputTokens: 272_001 }), 'openai-codex', 'gpt-5.4', OFF_PEAK)
    expect(long.reading.apiEquivalentUsd).toBeCloseTo(1.360_005, 10)
  })

  it('applies the long-context tier to the whole request, cache buckets included', () => {
    // A 300k-total request — 100k uncached plus 200k served from cache — is
    // long on gpt-5.5 ($10 uncached / $1 cached), and every token prices at
    // the tier, not just the tokens past the bound.
    const session = new SessionUsage(pricingFrom(undefined))
    session.observe(usage({ inputTokens: 100_000, cacheReadTokens: 200_000 }), 'openai-codex', 'gpt-5.5', OFF_PEAK)
    expect(session.reading.apiEquivalentUsd).toBeCloseTo(1.2, 10)
  })

  it('keeps a model with no published tier at its everyday rates', () => {
    // gpt-5.4-mini has no >272k pricing tier on the official table, so a
    // request past the threshold is still priced at its published rates.
    const session = new SessionUsage(pricingFrom(undefined))
    session.observe(usage({ inputTokens: 300_000 }), 'openai-codex', 'gpt-5.4-mini', OFF_PEAK)
    expect(session.reading.apiEquivalentUsd).toBeCloseTo(0.225, 10)
  })

  it('prices a long gpt-5.6 request at the tier’s cache-write rate', () => {
    // gpt-5.6-luna long tier: $0.40/$0.04/$1.80 with writes at $0.50; a
    // 3M-token request prices every bucket at the tier.
    const session = new SessionUsage(pricingFrom(undefined))
    session.observe(usage({
      inputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000,
    }), 'openai-codex', 'gpt-5.6-luna', OFF_PEAK)
    expect(session.reading.apiEquivalentUsd).toBeCloseTo(2.74, 10)
  })

  it('labels the shipped Codex entries api-equivalent and the DeepSeek ones billed', () => {
    const table = pricingFrom(undefined)
    expect(table.get('openai-codex/gpt-5.5')?.basis).toBe('api-equivalent')
    expect(table.get('deepseek-official/deepseek-v4-flash')?.basis).toBe('billed')
  })

  it('never prices a model id through a route that does not name it', () => {
    // gpt-5.5 is shipped only as `openai-codex/gpt-5.5`; the same id on another
    // gateway is that gateway's business, and nothing shipped keys a model bare.
    const table = pricingFrom(undefined)
    expect(table.get('openai-codex/gpt-5.5')).toBeDefined()
    expect(table.get('openai/gpt-5.5')).toBeUndefined()
    expect(table.get('gpt-5.5')).toBeUndefined()

    const session = new SessionUsage(table)
    session.observe(usage({ inputTokens: 1_000_000 }), 'some-gateway', 'gpt-5.5', OFF_PEAK)
    expect(session.reading.costUsd).toBeUndefined()
  })

  it('keeps an OAuth model with no public API equivalent unpriced', () => {
    // gpt-5.3-codex-spark is a ChatGPT Pro OAuth-only research preview with no
    // public API price, so there is no reference to map it to.
    const table = pricingFrom(undefined)
    expect(table.get('openai-codex/gpt-5.3-codex-spark')).toBeUndefined()

    const session = new SessionUsage(table)
    session.observe(usage({ inputTokens: 1_000_000 }), 'openai-codex', 'gpt-5.3-codex-spark', OFF_PEAK)
    expect(session.reading.costUsd).toBeUndefined()
  })

  it('leaves sign-in routes that can also bill on an API key unpriced', () => {
    // `xai` and `anthropic` ship both an API-key path and an OAuth login, and
    // the session fold records only the route, not which side it ran on — so
    // no single basis would be truthful about the total. Their catalog models
    // have public API prices; they are not shipped until the fold can tell
    // the two apart.
    const table = pricingFrom(undefined)
    expect(table.get('xai/grok-4.5')).toBeUndefined()
    expect(table.get('anthropic/claude-opus-5')).toBeUndefined()

    const session = new SessionUsage(table)
    session.observe(usage({ inputTokens: 1_000_000 }), 'xai', 'grok-4.5', OFF_PEAK)
    session.observe(usage({ inputTokens: 1_000_000 }), 'anthropic', 'claude-opus-5', OFF_PEAK)
    expect(session.reading.costUsd).toBeUndefined()
  })

  it('keeps a mixed billed/API-equivalent session in separate truthful totals', () => {
    const session = new SessionUsage(pricingFrom(undefined))
    session.observe(usage({ inputTokens: 1_000_000 }), PROVIDER, 'deepseek-v4-flash', OFF_PEAK)
    session.observe(usage({ inputTokens: 200_000 }), 'openai-codex', 'gpt-5.5', OFF_PEAK)
    const reading = session.reading
    expect(reading.billedUsd).toBeCloseTo(0.22, 10)
    expect(reading.apiEquivalentUsd).toBeCloseTo(1, 10)
    expect(reading.costUsd).toBeCloseTo(1.22, 10)
    // The aggregate is derived: it must always equal the sum of the two
    // basis subtotals rather than drift independently of them.
    expect(reading.costUsd).toBeCloseTo(reading.billedUsd! + reading.apiEquivalentUsd!, 10)
  })

  it('marks a mixed session that also hit an unpriced route as a floor', () => {
    const session = new SessionUsage(pricingFrom(undefined))
    session.observe(usage({ inputTokens: 200_000 }), 'openai-codex', 'gpt-5.5', OFF_PEAK)
    session.observe(usage({ inputTokens: 1_000_000 }), 'other', 'mystery', OFF_PEAK)
    expect(session.reading.costUsd).toBeCloseTo(1, 10)
    expect(session.reading.apiEquivalentUsd).toBeCloseTo(1, 10)
    expect(session.reading.billedUsd).toBeUndefined()
    expect(session.reading.partial).toBe(true)
  })

  it('keeps the shipped api-equivalent basis when its rates are corrected', () => {
    // Correcting a stale public API rate does not turn an OAuth route into
    // pay-as-you-go: the replacement keeps reading `API-equivalent cost`.
    const table = pricingFrom({ 'openai-codex/gpt-5.5': { input: 5.5, output: 33 } })
    expect(table.get('openai-codex/gpt-5.5')?.basis).toBe('api-equivalent')
    expect(table.get('openai-codex/gpt-5.5')?.rates.input).toBeCloseTo(5.5, 10)
  })

  it('reads a route dshline does not ship as the reader’s own billing', () => {
    const table = pricingFrom({ 'my-gateway/gpt-5.5': { input: 5.5, output: 33 } })
    expect(table.get('my-gateway/gpt-5.5')?.basis).toBe('billed')
  })
})

describe('peak windows', () => {
  it('charges the standard rate only inside a published window', () => {
    const windows = parsePeakWindows(undefined)
    expect(isPeak(Date.UTC(2026, 7, 18, 2, 0), windows)).toBe(true)
    expect(isPeak(Date.UTC(2026, 7, 18, 7, 30), windows)).toBe(true)
    // Between the two windows, and well outside both.
    expect(isPeak(Date.UTC(2026, 7, 18, 5, 0), windows)).toBe(false)
    expect(isPeak(Date.UTC(2026, 7, 18, 12, 0), windows)).toBe(false)
    expect(isPeak(Date.UTC(2026, 7, 18, 0, 30), windows)).toBe(false)
  })

  it('treats a window as half-open, so its end hour is already off-peak', () => {
    const windows = parsePeakWindows(undefined)
    expect(isPeak(Date.UTC(2026, 7, 18, 1, 0), windows)).toBe(true)
    expect(isPeak(Date.UTC(2026, 7, 18, 4, 0), windows)).toBe(false)
    expect(isPeak(Date.UTC(2026, 7, 18, 10, 0), windows)).toBe(false)
  })

  it('reads the clock in UTC, not in the machine’s zone', () => {
    // A provider publishes its schedule in one timezone. Reading it in the local
    // one would move every user's prices by their own offset.
    const windows: readonly PeakWindow[] = parsePeakWindows([{ from: '02:00', to: '03:00' }])
    expect(isPeak(Date.parse('2026-08-18T02:30:00Z'), windows)).toBe(true)
    expect(isPeak(Date.parse('2026-08-18T02:30:00+05:00'), windows)).toBe(false)
  })

  it('handles a window that wraps midnight', () => {
    const windows = parsePeakWindows([{ from: '22:00', to: '02:00' }])
    expect(isPeak(Date.UTC(2026, 7, 18, 23, 0), windows)).toBe(true)
    expect(isPeak(Date.UTC(2026, 7, 18, 1, 0), windows)).toBe(true)
    expect(isPeak(Date.UTC(2026, 7, 18, 12, 0), windows)).toBe(false)
  })

  it('falls back to the published schedule rather than to no peak at all', () => {
    // No peak is the cheaper answer, which is exactly why nobody would notice it
    // was wrong. A configuration that does not parse keeps the shipped windows.
    for (const raw of [undefined, 'evenings', [], [{ from: 'nine', to: '10:00' }], [{ from: '25:00', to: '02:00' }]]) {
      expect(isPeak(Date.UTC(2026, 7, 18, 2, 0), parsePeakWindows(raw)), JSON.stringify(raw)).toBe(true)
    }
  })

  it('keeps the readable windows from a partly broken list', () => {
    const windows = parsePeakWindows([{ from: '02:00', to: '03:00' }, { from: 'noon', to: '13:00' }])
    expect(windows).toEqual([{ from: 120, to: 180 }])
  })
})

describe('SessionUsage', () => {
  it('counts every prompt token as input, cached or not', () => {
    const session = new SessionUsage(RATES)
    session.observe(
      usage({ inputTokens: 1_000, cacheReadTokens: 7_000, cacheWriteTokens: 800, outputTokens: 1_600 }),
      PROVIDER,
      'deepseek-v4-flash',
      OFF_PEAK,
    )
    expect(session.reading.inputTokens).toBe(8_800)
    expect(session.reading.outputTokens).toBe(1_600)
  })

  it('does not count reasoning tokens a second time', () => {
    // The adapter reports reasoning INSIDE the output total. Adding it again
    // inflates output on exactly the models people turn reasoning on for.
    const session = new SessionUsage(RATES)
    session.observe(usage({ outputTokens: 1_600, reasoningTokens: 1_200 }), PROVIDER, 'deepseek-v4-flash', OFF_PEAK)
    expect(session.reading.outputTokens).toBe(1_600)
  })

  it('prices a cache read at the cache rate, not the uncached one', () => {
    const session = new SessionUsage(RATES)
    session.observe(usage({ cacheReadTokens: 1_000_000 }), PROVIDER, 'deepseek-v4-flash', OFF_PEAK)
    expect(session.reading.costUsd).toBeCloseTo(0.1, 10)
  })

  it('prices a cache write as a miss, which is what it is', () => {
    // The tokens are being read for the first time and stored on the way past,
    // so the miss rate is the right one — not the cheaper rate whose name also
    // happens to contain the word cache.
    const session = new SessionUsage(RATES)
    session.observe(usage({ cacheWriteTokens: 1_000_000 }), PROVIDER, 'deepseek-v4-flash', OFF_PEAK)
    expect(session.reading.costUsd).toBeCloseTo(1, 10)
  })

  it('adds the buckets up at their own rates', () => {
    const session = new SessionUsage(RATES)
    session.observe(
      usage({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 }),
      PROVIDER,
      'deepseek-v4-flash',
      OFF_PEAK,
    )
    expect(session.reading.costUsd).toBeCloseTo(3.1, 10)
  })

  it('prices each message by the clock it actually ran on', () => {
    // Peak and off-peak differ by half, so pricing a whole session at the moment
    // someone reopened it would bill a night's work at the morning rate.
    const table = pricingFrom({ 'a/b': { input: 1, output: 1, peak: { input: 10, output: 10 } } })
    const session = new SessionUsage(table)
    session.observe(usage({ inputTokens: 1_000_000 }), 'a', 'b', OFF_PEAK)
    session.observe(usage({ inputTokens: 1_000_000 }), 'a', 'b', PEAK)
    expect(session.reading.costUsd).toBeCloseTo(11, 10)
  })

  it('prices each message at the model that produced it', () => {
    // A `/model` switch mid-session must not reprice everything before it at
    // whichever route the session happens to end on.
    const table = parsePricing({
      'deepseek-official/cheap': { input: 1, output: 1 },
      'deepseek-official/dear': { input: 10, output: 10 },
    })
    const session = new SessionUsage(table)
    session.observe(usage({ inputTokens: 1_000_000 }), PROVIDER, 'cheap', OFF_PEAK)
    session.observe(usage({ inputTokens: 1_000_000 }), PROVIDER, 'dear', OFF_PEAK)
    expect(session.reading.costUsd).toBeCloseTo(11, 10)
  })

  it('lets a bare model key cover whatever route serves it', () => {
    // The way to price a model the same through a gateway as direct, and the
    // reason nothing shipped is keyed this way: it has to be asked for.
    const session = new SessionUsage(parsePricing({ 'deepseek-v4-flash': { input: 1, output: 1 } }))
    session.observe(usage({ inputTokens: 1_000_000 }), 'some-gateway', 'deepseek-v4-flash', OFF_PEAK)
    expect(session.reading.costUsd).toBeCloseTo(1, 10)
  })

  it('prefers the exact route over the bare model', () => {
    const session = new SessionUsage(parsePricing({
      'deepseek-v4-flash': { input: 1, output: 1 },
      'some-gateway/deepseek-v4-flash': { input: 5, output: 5 },
    }))
    session.observe(usage({ inputTokens: 1_000_000 }), 'some-gateway', 'deepseek-v4-flash', OFF_PEAK)
    expect(session.reading.costUsd).toBeCloseTo(5, 10)
  })

  it('reports no cost at all for a route with no rates', () => {
    const session = new SessionUsage(RATES)
    session.observe(usage({ inputTokens: 8_800, outputTokens: 1_600 }), 'other', 'mystery', OFF_PEAK)
    expect(session.reading.costUsd).toBeUndefined()
    expect(session.reading.partial).toBe(false)
    expect(session.reading.inputTokens).toBe(8_800)
  })

  it('marks a total that is only a floor', () => {
    const session = new SessionUsage(RATES)
    session.observe(usage({ inputTokens: 1_000_000 }), PROVIDER, 'deepseek-v4-flash', OFF_PEAK)
    session.observe(usage({ inputTokens: 1_000_000 }), 'other', 'mystery', OFF_PEAK)
    expect(session.reading.costUsd).toBeCloseTo(1, 10)
    expect(session.reading.partial).toBe(true)
  })

  it('recovers the same totals when a session is replayed', () => {
    // A resumed session re-observes its `assistant/message` events through a
    // fresh SessionUsage, so the fold must be a pure function of the events,
    // the registry, and the clock — one run and a replay agree exactly, basis
    // included.
    const events = [
      { usage: usage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 }), provider: PROVIDER, model: 'deepseek-v4-flash', at: OFF_PEAK },
      { usage: usage({ inputTokens: 50, outputTokens: 10, cacheReadTokens: 400 }), provider: 'openai-codex', model: 'gpt-5.5', at: OFF_PEAK },
    ]
    const first = new SessionUsage(pricingFrom(undefined))
    const replay = new SessionUsage(pricingFrom(undefined))
    for (const event of events) {
      first.observe(event.usage, event.provider, event.model, event.at)
      replay.observe(event.usage, event.provider, event.model, event.at)
    }
    expect(replay.reading).toEqual(first.reading)
  })
})

describe('usage modes', () => {
  it('names each mode by the word its argument takes', () => {
    expect(USAGE_MODES.map(mode => mode.id)).toEqual(['cost', 'tokens', 'off'])
  })

  it('matches an argument whatever case it was typed in', () => {
    expect(resolveUsageMode('Tokens')).toBe('tokens')
    expect(resolveUsageMode('  off ')).toBe('off')
    expect(resolveUsageMode('everything')).toBeUndefined()
    expect(resolveUsageMode('')).toBeUndefined()
  })
})

describe('formatUsage()', () => {
  /** A reading with the totals given, priced on the billed side like the shipped routes. */
  const reading = (costUsd: number | undefined, partial = false): Parameters<typeof formatUsage>[0] =>
    ({ inputTokens: 8_800, outputTokens: 1_600, costUsd, partial, billedUsd: costUsd, apiEquivalentUsd: undefined })

  it('reports both directions and the money', () => {
    expect(formatUsage(reading(0.018), 'cost')).toBe('↑8.8k ↓1.6k $0.018')
  })

  it('leaves the money out on request', () => {
    expect(formatUsage(reading(0.018), 'tokens')).toBe('↑8.8k ↓1.6k')
  })

  it('reports nothing at all when switched off', () => {
    expect(formatUsage(reading(0.018), 'off')).toBeUndefined()
  })

  it('omits the money when nothing could be priced', () => {
    // The same rule the context bar follows: nothing is drawn before there is
    // something true to draw, and `$0.00` is not it.
    expect(formatUsage(reading(undefined), 'cost')).toBe('↑8.8k ↓1.6k')
  })

  it('marks a partial total so it does not read as the whole bill', () => {
    expect(formatUsage(reading(0.018, true), 'cost')).toBe('↑8.8k ↓1.6k ~$0.018')
  })

  it('keeps enough digits to be non-zero early in a session', () => {
    // A meter reading `$0.00` for the first twenty minutes is one nobody looks at.
    expect(formatUsage(reading(0.0018), 'cost')).toContain('$0.0018')
    expect(formatUsage(reading(0.018), 'cost')).toContain('$0.018')
    expect(formatUsage(reading(1.238), 'cost')).toContain('$1.24')
  })
})

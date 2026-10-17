# Follow-up protocol for PR #303

## Frozen regression repeat

The original 30-per-arm study is exploratory. Do not pool it with this confirmatory repeat. No production changes are included in the repeat: stock `8b91e0e` versus the Screen candidate at `8194c58`, with compiled module identities verified before and after collection. Only `screen.js` may differ.

Fixed plan: **500 attempted turns per arm for each of Latin, CJK and styled** (3,000 measured attempts), plus six excluded warm-ups. Seed 303 shuffles workload order within each round; adjacent pairs alternate AB/BA by round. No interim significance testing, early stopping on significance, selective reruns or discarded failures. Failures remain in the raw record and invalidate a claimed complete 500-per-cell admission. Long-line controls and input/cancellation experiments follow separately; this repeat targets the reported regressions.

The initial planning estimate was 400 per arm. Before confirmatory collection this was increased to 500: at n=400 a two-sided conservative 95% difference CI for population p99 can still require an infinite endpoint. With two 97.5% marginal quantile CIs, each upper tail gets 1.25%; 0.99^n must be below 0.0125 (n>=437) before the sample maximum can bound it. Five hundred provides finite order-statistic endpoints, not narrow/stable production p99 estimates.

Primary endpoints: CJK whole-turn median, CJK whole-turn p95 and p99, Latin whole-turn p99, styled whole-turn p95. Report paired-block bootstrap percentile 95% CIs, variance, and conservative distribution-free 95% quantile-difference bounds. These are **pointwise**, not simultaneous family-wise 95% claims. Report all endpoints, including increases. A CI spanning zero is **inconclusive**, not proof of noise/equivalence. The interval can reject an original-sized effect without establishing exactly zero effect. Local exchangeability/stationarity assumptions and one-host/provider limitations remain explicit.

Renderer totals and per-call/height-change costs, provider-await excluding renderer overlap, first-feedback output, first-content output and chunk-to-Screen eligibility are separate measurements. Auxiliary `ctx.llm.stream` calls retain purpose, timestamps and waits; an unfinished title call is right-censored at the main measurement endpoint, never treated as completed. No title policy is disabled or changed. No physical-paint claim is made. Input typing/interrupt requires its own active PTY probes, not frame-time substitution.

## Preliminary evidence (not repeat results)

The original CJK median difference is +353 ms; paired bootstrap 95% CI [-11,+913] ms (2,000 resamples, seed 303). Every reported whole-turn tail regression also spans zero; exact small-sample p95/p99 bounds can be unbounded. These do not establish noise. The committed `confidence.json` retains all estimates and variance.

Harness `dsh-session-title` already calls `startPending` through a deferred asynchronous callback; it does not await the title from the main request. The two new CJK admission warm-ups directly observed title calls starting about 6 ms after main-call entry and finishing while the main call was still streaming (about 1.94 s and 2.51 s title spans). This rejects the hypothesis of a sequential blocking title request in those two pilots, but does not quantify shared provider contention or establish fleet behavior. No title lifecycle patch is justified by those observations.

## Remaining work

Collect and verify the frozen repeat; publish raw records, PTY captures, identities, intervals and per-regression verdicts. Diagnose genuine local regressions with matched work, retaining live/replay distinctions. Evaluate feedback, smoothness, input/cancel and byte amplification; implement only evidenced improvements in TypeScript with focused emulator tests and mutation checks. Keep the PR draft, public API/dependencies unchanged, and require exact-head CI. No merge/release is authorized.

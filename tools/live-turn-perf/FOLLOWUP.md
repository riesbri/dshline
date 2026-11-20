# Follow-up protocol for PR #303

## Frozen regression repeat

The original 30-per-arm study is exploratory. Do not pool it with this confirmatory repeat. No production changes are included in the repeat: stock `8b91e0e` versus the Screen candidate at `8194c58`, with compiled module identities verified before and after collection. Only `screen.js` may differ.

Fixed plan: **500 attempted turns per arm for each of Latin, CJK and styled** (3,000 measured attempts), plus six excluded warm-ups. Seed 303 shuffles workload order within each round; adjacent pairs alternate AB/BA by round. No interim significance testing, early stopping on significance, selective reruns or discarded failures. Failures remain in the raw record and invalidate a claimed complete 500-per-cell admission. This repeat targets the reported regressions. User-facing responsiveness experiments are outside this session’s scope.

The initial planning estimate was 400 per arm. Before confirmatory collection this was increased to 500: at n=400 a two-sided conservative 95% difference CI for population p99 can still require an infinite endpoint. With two 97.5% marginal quantile CIs, each upper tail gets 1.25%; 0.99^n must be below 0.0125 (n>=437) before the sample maximum can bound it. Five hundred provides finite order-statistic endpoints, not narrow/stable production p99 estimates.

Primary endpoints: CJK whole-turn median, CJK whole-turn p95 and p99, Latin whole-turn p99, styled whole-turn p95. Report paired-block bootstrap percentile 95% CIs, variance, and conservative distribution-free 95% quantile-difference bounds. These are **pointwise**, not simultaneous family-wise 95% claims. Report all endpoints, including increases. A CI spanning zero is **inconclusive**, not proof of noise/equivalence. The interval can reject an original-sized effect without establishing exactly zero effect. Local exchangeability/stationarity assumptions and one-host/provider limitations remain explicit.

Renderer totals and per-call/height-change costs, provider-await excluding renderer overlap, first-feedback output, first-content output and chunk-to-Screen eligibility are separate measurements. Auxiliary `ctx.llm.stream` calls retain purpose, timestamps and waits; an unfinished title call is right-censored at the main measurement endpoint, never treated as completed. No title policy is disabled or changed. No physical-paint claim is made. Input typing/interrupt requires its own active PTY probes, not frame-time substitution.

## Preliminary evidence (not repeat results)

The original CJK median difference is +353 ms; paired bootstrap 95% CI [-11,+913] ms (2,000 resamples, seed 303). Every reported whole-turn tail regression also spans zero; exact small-sample p95/p99 bounds can be unbounded. These do not establish noise. The committed `confidence.json` retains all estimates and variance.

Harness `dsh-session-title` already calls `startPending` through a deferred asynchronous callback; it does not await the title from the main request. The two new CJK admission warm-ups directly observed title calls starting about 6 ms after main-call entry and finishing while the main call was still streaming (about 1.94 s and 2.51 s title spans). This rejects the hypothesis of a sequential blocking title request in those two pilots, but does not quantify shared provider contention or establish fleet behavior. No title lifecycle patch is justified by those observations.

## Remaining work

Collect and verify the frozen repeat; publish raw records, PTY captures, identities, intervals and per-regression verdicts for CJK median/p95/p99, Latin p99 and styled p95. Diagnose CJK Screen tails, height changes, cache overhead and write batching with matched work if needed, retaining live/replay distinctions. Fix only evidenced Part 1 regressions in TypeScript with focused tests and mutation checks. Keep the PR draft, public API/dependencies unchanged, and require exact-head CI. No merge/release is authorized.

## Scope handoff (2026-10-17)

Part 2 is delegated to a separate session on `perf/renderer-ux-fast-path`, worktree `/home/richi/deepseek/dshline-renderer-ux-fast-path`. Do not measure or implement first-feedback/first-token, active-PTY typing/interrupt, streaming smoothness, paced redraws or byte-amplification improvements here, and do not push Part 2 work. Existing frozen observer fields remain unchanged for experiment integrity. The running collection must finish exactly as planned; do not interrupt or restart it. Note this handoff in the final report.

## Quota amendment (2026-10-17, 11:33 UTC)

Explicit quota-driven instruction supersedes the three-workload completion plan above. Keep CJK at **500 attempted samples per arm**; retain Latin already collected, with no further Latin calls; drop styled from the final analysis. Styled is not absent from the historical archive: 69 pairs had already run under the shuffled schedule before the amendment. Those records stay untouched for audit, but the planned 500-per-arm styled cell is intentionally abandoned and excluded from analysis. No conclusion about styled is made.

The mixed runner was interrupted during `latin-069-stock` after 69 complete Latin pairs and one additional candidate observation. That stock attempt has no completed capture and is explicitly missing, not silently replaced. All 139 completed Latin records remain; paired CIs use 69 pairs. Latin p99's conservative distribution-free interval is necessarily unbounded at this sample size. CJK had 69 attempts per arm saved; identity-checked `--resume --workloads cjk` skips every saved attempt (including failures), the saved CJK warmups, and collects only remaining indices through 499. No significance-based stopping or sample replacement is allowed. Workload order changes from interleaved to CJK-only; time/provider regime and reduced external validity must be disclosed.

`quota-amendment.json` preserves intervention counts and the interruption; original `metadata.json` stays unchanged, with the new segment recorded in `resume-metadata.json`. Use `summarize.py --archive --exclude-workloads styled`, `confidence.py --replicates 10000`, and `verify.py`: verification admits the exact amended cell counts while still checking **all** archived observations and PTY bytes. Analysis excludes styled but archive does not. Part 2 remains handed off, and Part 1 still requires the CJK Screen-tail diagnosis after collection.

## Permanent quota stop — final amendment (2026-10-17)

All collection is permanently halted by explicit user instruction. Do not restart or resume; zero further provider/model calls. This supersedes all completion/resume instructions above. Frozen measured counts: CJK 84/84, Latin 69 stock / 70 candidate (69 pairs), styled 69/69 retained for exploratory audit only after its planned workload was dropped. The 500/arm confirmatory plan is incomplete by design, not completed. Final expected counts are stored in `results/frozen-20261017/quota-amendment.json.finalStop.expectedCounts`; metadata preserves the original plan separately from the frozen admission counts. See [PART1-REPORT.md](PART1-REPORT.md) for final statistics, limitations, matched local Screen-stage replay, and Part 2 handoff.

# PR #303 — frozen Part 1 findings

## Verdict

**No whole-turn regression is statistically confirmed.** CJK median/p95/p99 and Latin p99 remain **inconclusive**, not proven noise or equivalent. The original CJK +7.4% median increase did not replicate as significant: the frozen repeat is +3.81%, with a pointwise paired-bootstrap 95% delta interval of −324 to +497 ms. That interval still includes the original +353 ms effect; this study cannot rule it out.

The renderer improves descriptively across all retained workloads. CJK whole-turn extremes are dominated by provider-iterator await outside renderer intervals, not by measured Screen CPU. This accounting does not isolate server inference, networking, shared-provider contention, or host scheduling and is not a causal provider diagnosis. No production fix is justified by the frozen evidence.

## Frozen cells and protocol deviations

| Workload | Stock | Candidate | Complete pairs | Status |
| --- | ---: | ---: | ---: | --- |
| CJK | 84 | 84 | 84 | Frozen complete observed cells; planned 500/arm **not completed** |
| Latin | 69 | 70 | 69 | Saved data retained; unmatched candidate in descriptive arm statistics only |
| Styled | 69 | 69 | 69 | Planned confirmatory workload intentionally dropped for quota; saved observations are exploratory audit evidence only |
| Long | 0 | 0 | 0 | Absent from this repeat |

There are 445 measured records plus six excluded warm-ups. Collection was permanently halted by the user for quota; **never restart/resume it**. No new provider/model calls were made for this report or replay. The original 30/arm exploratory study is not pooled with this repeat.

Original plan: 500 attempted turns per arm/workload, seed 303, shuffled workload order, alternating adjacent AB/BA pairs. At 69 saved pairs per workload, the quota amendment stopped Latin/styled; one in-flight Latin stock observation has no completed capture and is explicitly absent. The remaining CJK segment ran alone through index 83 before permanent stop. The quota stop was not based on significance. The changed time/provider regime and reduced sample size weaken confirmatory interpretation. Original plan metadata is preserved; `metadata.json.frozenDataset` and `quota-amendment.json.finalStop.expectedCounts` state the final admission counts. The historical pre-resume `provenance-final.json` is not evidence of a completed 500/arm run; `frozen-build-verification.json` independently rechecks all 163 compiled module hashes per arm after permanent stop.

## Whole-turn intervals

Milliseconds, candidate minus stock. Quantiles below use **complete pairs** (including Latin, n=69); the extra Latin candidate is retained in `summary.json` but not resampling. 10,000 adjacent-pair bootstrap resamples, seed 303; linear `(n−1)p` sample quantiles. These are pointwise 95% percentile intervals, without family-wise adjustment. Exchangeability/local stationarity is assumed, not demonstrated.

| Workload | Endpoint | Stock → candidate | Delta | Bootstrap 95% delta CI | Verdict |
| --- | --- | ---: | ---: | --- | --- |
| cjk | median | 4,934.7 → 5,122.6 | +187.9 (+3.81%) | [-324.2, +496.8] | inconclusive |
| cjk | p95 | 7,626.5 → 9,580.9 | +1,954.4 (+25.63%) | [-3,560.4, +7,147.7] | inconclusive |
| cjk | p99 | 13,435.3 → 15,254.0 | +1,818.7 (+13.54%) | [-3,804.5, +8,246.2] | inconclusive |
| latin | median | 3,857.7 → 3,829.5 | -28.1 (-0.73%) | [-279.3, +261.6] | inconclusive |
| latin | p95 | 5,306.4 → 6,987.0 | +1,680.7 (+31.67%) | [-2,817.1, +3,635.7] | inconclusive |
| latin | p99 | 9,495.7 → 9,671.6 | +175.9 (+1.85%) | [-3,033.5, +5,712.6] | inconclusive |
| styled | median | 8,721.2 → 8,688.0 | -33.2 (-0.38%) | [-925.6, +818.7] | inconclusive |
| styled | p95 | 16,249.5 → 13,904.6 | -2,344.8 (-14.43%) | [-5,305.0, +1,640.9] | inconclusive |
| styled | p99 | 17,247.8 → 14,626.1 | -2,621.7 (-15.20%) | [-3,462.0, -348.7] | nominal improvement (exploratory) |

Styled p95, an original flagged endpoint, is inconclusive. Styled p99 has a nominal bootstrap interval below zero, but it is a **post-drop exploratory** endpoint, not a completed confirmatory improvement claim. Conservative distribution-free population p95 and p99 difference bounds are unbounded in every retained cell. CJK median conservative 95% difference bounds are [−707, +819] ms. A finite empirical bootstrap tail interval does not overcome this small-sample population-tail limit.

## Variance and renderer split

Descriptive arm statistics use every retained observation (Latin candidate n=70). Sample SD is in ms; sample variance is ms². Components form a disjoint per-turn accounting split; component medians/quantiles do not add.

| Workload | Whole-turn SD, stock → candidate | Whole-turn variance | Renderer median | Renderer p99 | Renderer SD |
| --- | ---: | ---: | ---: | ---: | ---: |
| cjk | 1,635.0 → 2,201.1 | 2,673,338.2 → 4,844,789.0 | 366.7 → 358.2 | 1,230.5 → 713.3 | 352.0 → 107.6 |
| latin | 1,200.9 → 1,439.8 | 1,442,201.0 → 2,073,021.5 | 282.6 → 252.8 | 478.2 → 421.6 | 59.4 → 56.3 |
| styled | 2,720.3 → 2,230.3 | 7,400,181.7 → 4,974,360.3 | 734.2 → 674.8 | 1,478.1 → 1,167.2 | 211.6 → 166.2 |

CJK Screen-only median/p99/SD: **70.6 / 162.7 / 27.9 → 45.7 / 161.4 / 26.1 ms**. Renderer = Screen + composition. CJK renderer variance falls **123,873 → 11,588 ms²**, whereas provider-await-outside-renderer variance rises **2,561,149 → 4,604,918 ms²**. Provider-await-outside-renderer median/p99 rise **4,423 / 12,713 → 4,623 / 14,445 ms**. These are different live responses, not matched token streams.

## CJK tail attribution from saved live evidence

The five longest CJK turns in each arm spend **90.3–95.2%** of whole-turn time in provider-iterator await after subtracting renderer overlap. Their complete disjoint accounting is retained in `tail-attribution.json`.

| Longest captured turn | Whole turn | Screen | Renderer + composition | Await excluding rendering | Residual |
| --- | ---: | ---: | ---: | ---: | ---: |
| stock cjk-065 | 13,776.9 | 85.8 | 477.7 | 13,110.0 | 189.2 |
| candidate cjk-026 | 16,597.0 | 73.2 | 660.2 | 15,783.2 | 153.6 |

The slowest candidate has only 4.5 ms of changed-height Screen work. Its measured Screen CPU is lower than the slowest stock turn, while its non-renderer await is 2.67 seconds longer. Across the frozen set, CJK pooled Screen-call p99 improves **1.991 → 1.290 ms**; whole-turn Screen p99 is nearly flat. Thus the original pooled Screen-tail regression is not reproduced descriptively. Pooled calls are correlated within turns, not independent population samples.

### Height changes, caches, and batching

Stable-height `setLive`: 16,841 stock versus 17,833 candidate calls; pooled median **0.266 → 0.156 ms**, p99 **2.119 → 1.284 ms** (floor-order descriptive p99). Changed-height calls: 805 versus 912; median **0.280 → 0.194 ms**, p99 **1.743 → 1.687 ms**. Candidate median changed-height count is higher (6 → 8 per turn), and its changed-height per-turn p99 is slightly higher (10.15 → 10.71 ms), but this is millisecond-scale work, not the seconds-scale whole-turn tail. The geometry-changing full-redraw fallback remains reachable; it is not evidence of a CJK-specific performance defect.

Two caches must not be conflated: Screen’s one-frame wrap cache is local CPU work; provider prefix-cache tokens are usage metadata. Both arms have variable provider prefix-cache reads (median 0, upper observations 512 tokens); the study does not randomize/flush/control that provider state. Title calls overlap the main call rather than running sequentially, but shared provider contention remains unmeasured.

### Matched local Screen-stage replay (separate from live)

Reconstructed the already-wrapped rows, cursor placements and commits from the 84 saved **stock** CJK PTY streams, using each recorded Screen byte range and height. Both arms receive identical reconstructed operations. Original logical lines and pre-measurement Screen state were not recorded, so replay starts a fresh Screen and cannot reproduce the exact original wrapping inputs/cadence. This is a reduced **Screen-stage** experiment, not a full production scheduler/streaming-buffer replay, model turn, or new PTY measurement.

All **20,707 intermediate operations** pass stock/candidate xterm text, width, colours, bold/italic/underline/inverse flags, cursor, viewport and scrollback-state parity. Every retained ablation emits identical byte hashes to its intended reference (no-cache and split sink = candidate; full redraw = stock). Screen hashes match frozen build metadata. Three warm-up sequences per variant; four passes over each of 84 sequences, alternating/reversing variant order; no simultaneous builds/tests. A SHA-256/Buffer sink approximates observer hash work but has no PTY backpressure. Wrap-call counting is instrumented equally. 336 sequence-pass observations per arm are correlated repeats of 84 sequences, **not 336 independent live turns**.

| Screen variant | Sequence median ms | p95 ms | p99 ms | SD ms | Median wrap calls | Median stable-height ms | Median changed-height ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| stock | 16.59 | 32.70 | 47.16 | 7.94 | 1214.5 | 15.07 | 0.62 |
| candidate | 3.51 | 7.33 | 15.05 | 2.24 | 239.0 | 2.52 | 0.28 |
| noCache | 17.11 | 36.22 | 57.68 | 9.11 | 1214.5 | 15.34 | 0.70 |
| fullRedraw | 4.14 | 10.11 | 18.81 | 2.77 | 239.0 | 3.19 | 0.26 |
| splitSink | 3.53 | 6.87 | 12.53 | 1.77 | 239.0 | 2.50 | 0.28 |

- **Wrap cache:** disabling previous-frame/intra-frame reuse (while retaining map construction) raises matched median 3.51 → 17.11 ms and wrap calls 239 → 1,214.5. Reuse is beneficial in these reconstructed frames; a cache-induced CJK-tail mechanism is not supported. This does not isolate map bookkeeping cost itself or prove arbitrary cache workloads.
- **Row damage / height:** forcing full redraw while retaining cache raises median 3.51 → 4.14 ms. Candidate changed-height median is 0.28 ms per reconstructed sequence, not the dominant cost. The known full redraw on height change does not explain seconds-scale live tails.
- **Batching:** stock and candidate both make one target write per emitted Screen update (median 218 per sequence here); no cross-update batching policy was changed. Splitting candidate strings into 128-code-unit hash-sink writes raises median writes 218 → 486 while median CPU is 3.51 → 3.53 ms. This is only sink-call sensitivity, not a real syscall/PTY batching test or Part 2 byte-amplification probe. No batching defect is demonstrated.
- Replay stage p99 improves descriptively 47.16 → 15.05 ms. The measured replay savings are **not live whole-turn savings** and cannot be subtracted from differing provider turns. Occasional GC/host-scheduler outliers remain in every raw pass; no observation was removed.

**Tail diagnosis:** the saved live whole-turn extremes are non-renderer/provider-await dominated; matched reconstruction shows a Screen win, useful wrap reuse, and no height/cache/batch mechanism supporting a renderer-caused whole-turn regression. Pure provider causality and a small renderer-tail regression remain unproved. Retain the inconclusive whole-turn verdict; do not label it noise or patch speculative mechanisms.

## Power limits and unmeasured work

- CJK n=84 and Latin/styled n=69–70 are far short of planned 500/arm. p99 is driven by roughly one extreme observation per arm; descriptive tails and bootstrap signs are not stable production-tail estimates. Even p95 conservative population-difference bounds are unbounded at these n.
- One Linux/aarch64 Cortex-A76 host, four cores, Node 24.18.0, one provider/model route (`opencode-go/deepseek-v4.1-flash`), fixed 90×24 PTY, fresh processes, instrumented observer/hash sink. Host contention, GC, observer overhead, differing reasoning/chunks/tokens, cache state and time drift remain potential contributors.
- Not established: causal server/network latency; equivalence/no-regression; original-sized-effect exclusion; cross-host/platform/load results; clean uninstrumented performance; original logical-line matched replay; startup or physical display paint.
- **Part 2 is handed off** to `perf/renderer-ux-fast-path` at `/home/richi/deepseek/dshline-renderer-ux-fast-path`. No first-feedback/token, active-PTY typing/interrupt, smoothness, paced-redraw or byte-amplification improvement probes were performed or pushed here. Observer fields preserved in old captures are not Part 2 validation.

## Reproduce locally (zero provider calls)

From the repository root:

```sh
python3 tools/live-turn-perf/summarize.py tools/live-turn-perf/results/frozen-20261017
python3 tools/live-turn-perf/confidence.py tools/live-turn-perf/results/frozen-20261017 --replicates 10000
python3 tools/live-turn-perf/verify.py tools/live-turn-perf/results/frozen-20261017
node tools/live-turn-perf/replay-screen.mjs tools/live-turn-perf/results/frozen-20261017
```

Replay requires the original compiled arm roots named in metadata (or identical-hash local copies); no provider/profile is loaded. The retained raw and PTY archives are sufficient for the statistics/verifier independent of those build roots. Frozen source identities and replay-stage hashes are retained alongside raw replay samples.

## Validation and delivery

Archive verifier: all **451 records / 445 measured** pass real-PTY geometry, provider route/EOF, exit status, renderer reachability, exact PTY byte hashes and independent overlap/accounting checks. Deliberate corrupt-byte, zero-renderer and wrong-frozen-count mutations are rejected. This verifies the **frozen observed dataset**, not completion of the original plan.

PR #303 remains **draft**, with no merge/release. No production changes, Rust/FFI, dependencies, or API changes are included in this follow-up. Exact-head CI and local check results are reported in the delivery message, not inferred from earlier green revisions.

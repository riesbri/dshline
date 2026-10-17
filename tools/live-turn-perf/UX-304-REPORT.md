# PR #304 — byte amplification and bounded pacing experiment

## Phase 1 — quota-free frozen capture audit

No provider calls. `byte-amplification.py` reads the saved JSON and original
PTY captures, applies `verify_record` to every measured observation, and records
PTY SHA-256s, canonical record digests and archive hashes without modifying the frozen dataset. Capture source:
`/tmp/dshline-followup-repeat-303/`; source identities remain its metadata's
stock `8b91e0e` and candidate `43f0ff0`, not the newer UX branch.

Per-turn medians, emitted bytes and producing writes during the active turn:

| Workload | n stock/candidate | Bytes stock → candidate | Writes stock → candidate | Candidate amplification (text+reasoning UTF-8) | Candidate commit bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Latin | 69/70 | 170,602 → 63,999 | 168 → 164 | 24.38× | 39,909 |
| CJK | 84/84 | 221,268 → 73,986 | 219 → 226 | 23.81× | 41,044 |
| Styled | 69/69 | 447,056 → 155,359 | 437 → 416 | 35.56× | 49,220 |

Styled remains exploratory evidence from an abandoned confirmatory workload;
this audit does not revive that study. All samples are retained, including the
unmatched Latin candidate. Write counts include the one zero-byte flush invocation per turn; the detailed
report also separates positive-byte writes. Byte totals are not normalized cross-arm matched
outputs; replies and chunk counts vary. Amplification denominators count raw
model text and reasoning bytes, not visible terminal cells or escape overhead.

There is still material terminal traffic to reduce. The existing damage path
already reduces median emitted bytes by about 62.5%, 66.6%, and 65.2% while
not materially reducing write count. Whether further reductions improve live
latency is not established by byte volume. Commits synchronously redraw the
bounded region, so capping ordinary paints alone cannot cap all writes.

A fixed 16 ms bucket opportunity model preserves commits and hypothetically
retains only the last setLive per bucket. Median removable calls are 30.5,
47, and 99; removed observed bytes are 7.9%, 9.6%, and 16.6% of each candidate
turn, respectively. These are **not predicted scheduler savings or bounds**:
changed damage baselines alter future output, and delaying state changes can
cross commit boundaries. Discarding captured incremental ANSI writes is invalid.
The saved data lacks original logical Screen arguments and scheduler/input
state, so it cannot prove 16 ms production pacing safety or input latency.
The existing reconstructed Screen-stage replay is unpaced and explicitly does
not answer that scheduler question. No live replay result is claimed.

Detailed medians, p95/p99, mean, SD, sample variance, per-turn observations and
input hashes: `results/ux-304/byte-amplification.json`. Quantiles interpolate
at `(n−1)p`; small-sample p99 is near a maximum, not a bounded population tail.

## Phase 2 — predeclared bounded design

Current compiled TS in both arms, with a private observer-only trailing 16 ms
scheduler in candidate. It delays ordinary request dispatch, retains synchronous
commits and immediate reset/teardown, and bypasses pacing for synchronous stdin
handling. No production imports, API, dependencies, installed profiles or runtime
selection change. Six excluded warm-ups, then 30 measured turns per arm/workload
(Latin, CJK, styled), seed 303 shuffled workloads and adjacent AB/BA arm order.
Separate interrupt probes: one per arm/workload; these are behavioral pilots,
not a defensible interrupt tail distribution. Maximum 192 main requests and up
to 192 ancillary title requests. Stop on an admission failure or runaway cost.

Each ordinary turn types `UXPROBE304` without Enter after the first answer delta.
Record PTY send, process input receipt, composer-containing setLive, and master
receipt covering that complete write. Interrupt probes send legacy Ctrl-C at
the same active-stream boundary, record actual Agent.cancel and settlement.
Natural EOF is required for ordinary turns; interruption observations must be
separate, since cancelling a real stream cannot also demand natural EOF.
Provider route: opencode-go/deepseek-v4.1-flash, real Harness CLI and controlling
90×24 PTY, private homes only. Count and hash producing bytes versus receipts;
require exit zero. Renderer and provider-await remain separate. Endpoint is PTY
receipt, never physical paint. Independent live replies do not establish causal
whole-turn improvements. Small n cannot bound population p95/p99; report
observed quantiles and SD/variance with those limits.

## Phase 2 results — private prototype, not a default change

**Keep production check-phase scheduling unchanged.** The trailing 16 ms private
prototype reduces local renderer work and output traffic, but adds roughly
16 ms to the chunk-to-next-Screen output-eligibility proxy. Whole-turn and
first-content differences remain inconclusive. Neither a physical smoothness
win nor a production-ready pacing policy was established. This private policy
delays all ordinary requests, not just stream invalidations, and has no explicit
first-delta exemption. Active stdin bypass is measured; idle typing, resize/reset
and full lifecycle parity for a production priority policy are not newly proved.
Do not promote this monkey patch to production based on these results.

### Admission, host and protocol deviation

- 180 planned measured IDs: **179 valid natural-EOF turns**, plus one incomplete
  CJK stock attempt. Six normal warm-ups are excluded. Six separate legacy
  Ctrl-C pilots are not ordinary turn samples.
- The foreground tool transport killed collection at its 600,000 ms limit after
  69 completed samples, during `cjk-011-stock`. No completed capture exists for
  that attempt. Its marker is retained under `failures/`, never replaced.
  Resume verified compiled and observer identities, skipped all saved IDs and
  warm-ups, and completed only remaining original IDs. CJK stock n=29;
  every other cell n=30. CJK paired inference uses 29 complete pairs, retaining
  the unmatched candidate descriptively. The time-order gap weakens stationarity.
- New dataset only; the permanently stopped Part 1 dataset was never resumed.
  All 185 admitted ordinary captures (including warm-ups) passed exact producing
  versus PTY-received byte count/SHA-256, positive real renderer counters, real
  provider iterator EOF, text-only/no-tools, fixed controlling PTY and exit-zero
  gates. Independent endpoint-sweep attribution recomputation passed.
- All 185 ordinary captures passed emulator checks: actual composer marker cells,
  cursor immediately after the marker, and no unsubmitted marker in scrollback.
  All 179 measured typing probes arrived before the main provider iterator EOF.
- Host: pi5richi, Linux 6.12.93+rpt-rpi-2712, arm64, four Cortex-A76 cores;
  Node 24.18.0, Harness/adapter 0.2.0-rc.2, existing pi-ai 0.99.1 resolution.
  Model/provider: **opencode-go/deepseek-v4.1-flash**. PTY 90×24,
  TERM=xterm-256color, truecolor, private-slave OPOST disabled only.
- Both arms use compiled production source `d471c2d`; only the private observer's
  scheduler policy differs at runtime. All 163 compiled-module hashes per arm matched before,
  across resume and after collection. Runtime classes are observed through
  Harness's loader graph. Source/tool identities and raw captures are retained.
- Maximum budget: 192 main attempted requests including warm-ups, interrupts and
  the interrupted ID; up to 192 concurrent title requests. No replacement turns,
  extra warm-ups, model fallback, profile install, production change, merge or
  release. Generated private credential copies were removed, including the
  orphan left by transport termination. No credentials are archived.

### Per-cell distributions

All timings below are **milliseconds**, bytes/writes otherwise labelled.
`stock` here means **current TS / check-phase scheduler**, not Part 1's historical
8b91e0e stock. `candidate` means the same production modules plus the private
16 ms trailing scheduler and active-input bypass. Per-turn distributions use
linear `(n−1)p` quantiles, sample SD and sample variance; no outliers removed.
The p99 values are near-maxima, not stable or bounded population estimates.

#### Whole turn: submit → final PTY frame receipt

| Workload | Arm | n | Median | p95 | p99 | SD | Variance |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| latin | stock | 30 | 3,815.995 | 5,070.585 | 6,769.618 | 819.455 | 671,506.270 |
| latin | candidate | 30 | 4,000.335 | 6,345.124 | 7,651.667 | 1,041.903 | 1,085,562.527 |
| cjk | stock | 29 | 5,059.522 | 7,302.957 | 8,316.631 | 1,122.023 | 1,258,935.582 |
| cjk | candidate | 30 | 4,990.618 | 8,713.264 | 11,367.293 | 1,788.817 | 3,199,865.833 |
| styled | stock | 30 | 9,027.684 | 12,763.749 | 15,787.572 | 2,441.735 | 5,962,069.453 |
| styled | candidate | 30 | 8,522.952 | 14,276.283 | 16,135.494 | 2,379.406 | 5,661,571.756 |

#### Renderer-only: disjoint Screen + composition intervals

| Workload | Arm | n | Median | p95 | p99 | SD | Variance |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| latin | stock | 30 | 252.510 | 352.515 | 375.064 | 53.895 | 2,904.638 |
| latin | candidate | 30 | 166.517 | 223.509 | 237.804 | 24.505 | 600.483 |
| cjk | stock | 29 | 349.888 | 413.755 | 415.091 | 37.395 | 1,398.422 |
| cjk | candidate | 30 | 224.792 | 325.017 | 404.369 | 56.213 | 3,159.875 |
| styled | stock | 30 | 632.897 | 1,161.321 | 1,542.466 | 263.813 | 69,597.269 |
| styled | candidate | 30 | 394.700 | 562.108 | 606.463 | 92.340 | 8,526.754 |

#### Provider-await excluding renderer overlap

| Workload | Arm | n | Median | p95 | p99 | SD | Variance |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| latin | stock | 30 | 3,434.668 | 4,624.927 | 6,306.839 | 820.497 | 673,215.672 |
| latin | candidate | 30 | 3,688.341 | 6,003.684 | 7,307.699 | 1,030.578 | 1,062,091.460 |
| cjk | stock | 29 | 4,556.998 | 6,768.794 | 7,826.287 | 1,143.352 | 1,307,254.167 |
| cjk | candidate | 30 | 4,615.958 | 8,193.253 | 10,830.217 | 1,738.161 | 3,021,203.273 |
| styled | stock | 30 | 8,089.121 | 11,498.380 | 15,048.397 | 2,366.133 | 5,598,584.995 |
| styled | candidate | 30 | 7,968.378 | 13,601.081 | 15,379.663 | 2,300.931 | 5,294,284.076 |

#### Typing: PTY send → receipt covering composer echo

| Workload | Arm | n | Median | p95 | p99 | SD | Variance |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| latin | stock | 30 | 7.205 | 13.836 | 15.676 | 2.952 | 8.712 |
| latin | candidate | 30 | 4.913 | 7.138 | 11.916 | 1.814 | 3.289 |
| cjk | stock | 29 | 7.425 | 14.665 | 25.245 | 4.610 | 21.250 |
| cjk | candidate | 30 | 4.925 | 9.965 | 12.292 | 2.128 | 4.527 |
| styled | stock | 30 | 7.405 | 11.954 | 13.013 | 2.049 | 4.197 |
| styled | candidate | 30 | 5.559 | 7.648 | 8.546 | 1.267 | 1.606 |

#### Active-turn emitted bytes

| Workload | Arm | n | Median | p95 | p99 | SD | Variance |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| latin | stock | 30 | 64,708.000 | 82,249.750 | 85,507.450 | 8,808.994 | 77,598,376.447 |
| latin | candidate | 30 | 57,096.500 | 68,386.900 | 70,017.790 | 5,518.863 | 30,457,843.454 |
| cjk | stock | 29 | 72,898.000 | 85,035.400 | 90,774.520 | 6,389.174 | 40,821,540.167 |
| cjk | candidate | 30 | 63,281.500 | 71,111.350 | 84,579.170 | 6,312.897 | 39,852,665.775 |
| styled | stock | 30 | 128,757.000 | 268,705.900 | 350,498.510 | 62,305.759 | 3,882,007,622.971 |
| styled | candidate | 30 | 116,173.000 | 191,962.650 | 237,207.510 | 36,728.563 | 1,348,987,331.316 |

#### Active-turn write invocations (includes zero-byte flush)

| Workload | Arm | n | Median | p95 | p99 | SD | Variance |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| latin | stock | 30 | 163.000 | 237.650 | 242.550 | 32.499 | 1,056.202 |
| latin | candidate | 30 | 115.000 | 139.500 | 148.260 | 13.701 | 187.706 |
| cjk | stock | 29 | 221.000 | 271.200 | 301.760 | 26.049 | 678.530 |
| cjk | candidate | 30 | 146.500 | 179.000 | 230.120 | 26.161 | 684.395 |
| styled | stock | 30 | 392.500 | 840.350 | 1,119.280 | 199.971 | 39,988.368 |
| styled | candidate | 30 | 250.000 | 372.450 | 403.260 | 58.124 | 3,378.395 |

#### Submit → first text/reasoning-content output proxy

| Workload | Arm | n | Median | p95 | p99 | SD | Variance |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| latin | stock | 30 | 2,028.078 | 2,599.972 | 4,791.211 | 718.204 | 515,817.026 |
| latin | candidate | 30 | 2,075.523 | 4,089.820 | 4,922.614 | 803.608 | 645,786.422 |
| cjk | stock | 29 | 2,140.825 | 4,449.567 | 5,279.327 | 904.370 | 817,884.400 |
| cjk | candidate | 30 | 2,073.485 | 4,819.977 | 5,135.216 | 1,005.361 | 1,010,750.977 |
| styled | stock | 30 | 2,308.722 | 7,304.787 | 10,328.789 | 2,212.908 | 4,896,960.741 |
| styled | candidate | 30 | 2,235.522 | 8,394.141 | 10,227.272 | 2,124.911 | 4,515,247.432 |

#### Submit → first feedback output

| Workload | Arm | n | Median | p95 | p99 | SD | Variance |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| latin | stock | 30 | 22.249 | 36.737 | 39.977 | 5.336 | 28.476 |
| latin | candidate | 30 | 23.913 | 28.504 | 40.668 | 4.270 | 18.236 |
| cjk | stock | 29 | 23.067 | 34.433 | 47.347 | 6.635 | 44.030 |
| cjk | candidate | 30 | 23.493 | 54.047 | 93.987 | 17.282 | 298.684 |
| styled | stock | 30 | 22.866 | 37.611 | 45.496 | 6.208 | 38.534 |
| styled | candidate | 30 | 23.461 | 34.516 | 57.121 | 8.139 | 66.235 |

#### Per-turn p95 chunk → subsequent Screen output proxy

| Workload | Arm | n | Median | p95 | p99 | SD | Variance |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| latin | stock | 30 | 2.421 | 4.652 | 5.842 | 1.051 | 1.106 |
| latin | candidate | 30 | 18.098 | 18.518 | 18.552 | 0.271 | 0.074 |
| cjk | stock | 29 | 2.329 | 4.287 | 6.621 | 1.139 | 1.297 |
| cjk | candidate | 30 | 18.274 | 18.543 | 18.708 | 0.330 | 0.109 |
| styled | stock | 30 | 2.212 | 3.690 | 5.480 | 0.853 | 0.728 |
| styled | candidate | 30 | 18.249 | 18.569 | 18.789 | 0.233 | 0.054 |

Renderer elapsed time includes output-sensitive byte/hash observation overhead;
it is not uninstrumented CPU time. Provider-await includes adapter/scheduling
work, not pure remote inference or network time. The remaining local/transport
residual completes a disjoint per-turn whole-time accounting split. Component
medians do not add to the median whole turn. Fresh-process warm-ups do not warm
a persistent renderer JIT. Replies, reasoning, chunk grouping, token/cache
usage and other host activity vary; cross-arm output equality is not assumed.
All raw responses, usage, lengths and counts remain in the archives.

The chunk proxy is each nonempty text/reasoning delta's time to the first
subsequent complete Screen write, then its per-turn p95. It does not prove every
delta was visible in that write. The table is a distribution of per-turn p95s,
not a pooled population p95. Candidate medians of per-turn chunk p99 are
18.65–19.05 ms versus 3.40–4.07 ms; styled candidate's observed tail of those
per-turn p99s reaches p99=85.51 ms (SD=16.98), versus 16.28 ms (SD=3.28).
These delays must not be hidden behind the lower renderer CPU totals.
Synchronous commits remain unpaced, and the median per-turn p95 frame gap stays
about 100 ms in both arms because provider waits/spinner cadence remain. This
is not a fixed 60 FPS presentation experiment or a measured smoothness win.

### Paired intervals and interpretation

10,000 adjacent AB/BA-pair block bootstrap replicates, seed 303. Percentile
95% pointwise intervals, no multiplicity correction; exchangeability and local
stationarity are assumptions, not proved. The interrupted pair is omitted from
paired inference only. Quantile intervals cannot manufacture unseen tail data:
conservative distribution-free population p95/p99 difference bounds are
unbounded here. Sample variance and variance-difference bootstrap intervals are
retained in `confidence.json` and `delivery-confidence.json`.

Candidate minus current TS, paired median bootstrap 95% intervals:

| Workload | Renderer (ms) | Emitted bytes | Typing echo (ms) | Whole turn (ms) | Chunk p95 proxy (ms) |
| --- | --- | --- | --- | --- | --- |
| latin | [-112.93, -64.04] | [-11,551.51, -4,028.45] | [-3.75, -1.63] | [-165.66, 588.05] | [15.22, 15.98] |
| cjk | [-161.60, -93.96] | [-12,637.00, -6,180.00] | [-3.20, -1.35] | [-528.69, 343.48] | [15.53, 16.21] |
| styled | [-283.51, -135.53] | [-42,097.80, 8,283.50] | [-3.89, -1.00] | [-1,423.94, 945.39] | [15.88, 16.19] |

Renderer median and typing-echo median intervals favor the prototype in all
three workloads; byte median intervals favor it for Latin/CJK, while styled
bytes remain inconclusive. These are instrumented experimental associations,
not equal-output causal whole-turn estimates. All whole-turn median/p95/p99
bootstrap intervals cross zero. **Inconclusive is not equivalence or noise.**
All observed whole-turn p95/p99 values increase in candidate; CJK p99 increases
8,316.6 → 11,367.3 ms and Latin median increases 3,816.0 → 4,000.3 ms.
Those regressions remain visible even though no whole-turn difference is
statistically resolved by this small sample. First-content median and tail
intervals are also inconclusive. The deliberate chunk-eligibility delay remains
a concrete tradeoff; urgent typing bypass does not remove it.

### Separate interrupt pilots

One observation per arm/workload, legacy Ctrl-C after the first answer delta.
Each reached the actual Agent.cancel before provider EOF, settled through the
real Harness, matched producing/received bytes and hashes, and exited zero.
Natural EOF is intentionally not required after cancellation. These pilot IDs
retain the runner's `warmup` naming, but are analyzed only in the separate
interrupt archive. **n=1 per cell cannot support SD or tail inference**; the
numbers below are observations, not medians/p95/p99 population claims. No extra
quota was spent to inflate this into an interrupt-tail study. Enhanced Ctrl-C
ordering remains covered by the focused emulator tests, not a new live sample.

| Workload | Arm | n | Send → cancel (ms) | Input receipt → cancel (ms) | Send → settlement (ms) | Send → final PTY drain (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| latin | stock | 1 | 6.943 | 0.844 | 20.134 | 25.998 |
| latin | candidate | 1 | 4.383 | 0.787 | 12.633 | 17.454 |
| cjk | stock | 1 | 4.219 | 0.670 | 15.552 | 21.170 |
| cjk | candidate | 1 | 1.277 | 0.710 | 9.238 | 15.245 |
| styled | stock | 1 | 3.697 | 0.688 | 12.268 | 18.045 |
| styled | candidate | 1 | 1.964 | 1.400 | 30.434 | 39.140 |

Ordinary captures trace 185 title requests; 9 are right-censored at final PTY frame receipt. Titles remain concurrent and enabled. No pure provider-contention attribution is claimed.

## Verification and reproduction

- `pnpm build` passed before collection; no builds/tests ran alongside live turns.
- Focused assistant-stream/redraw/streaming-frames/stream-chunking: **42 passed**.
- Confidence interval tests: **3 passed**, including binomial coverage,
  unsupported tails remaining unbounded, and zero quantile/variance delta for
  identical paired arms. Deliberate fault results are recorded below.
- Existing parity/golden expectations are unchanged; no production sources changed.
- Exact-head CI status is reported separately in the draft PR and final handoff.

Recompute from the published archive alone, without credentials/provider calls:

```sh
python3 tools/live-turn-perf/byte-amplification.py tools/live-turn-perf/results/frozen-20261017 --output /tmp/byte-amplification-304.json
python3 tools/live-turn-perf/summarize.py tools/live-turn-perf/results/ux-304
python3 tools/live-turn-perf/ux-analyze.py tools/live-turn-perf/results/ux-304
python3 tools/live-turn-perf/ux-archive-verify.py tools/live-turn-perf/results/ux-304
node tools/live-turn-perf/ux-verify.mjs tools/live-turn-perf/results/ux-304
python3 tools/live-turn-perf/ux-analyze.py tools/live-turn-perf/results/ux-304/interrupt --interrupt
```

The confidence CLI accepts `--summary ux-summary.json --metrics <comma-list>`;
the complete original metrics and input/cadence endpoints are retained in
`confidence.json`. The two chunk-eligibility endpoints use the same `analyze`
function with 10,000 replicates and seed 303 in `delivery-confidence.json`.
`tool-identities.json`, raw archives, intervention/failed-attempt records,
verification results and recursive SHA256SUMS bind the evidence.

To collect a **new explicitly budgeted** experiment, use `ux-run.py` with both
`--stock` and `--candidate` pointing to the same built TS checkout, three
workloads, `--samples 30`, and a new output directory. `--pilot` collects only
the six excluded warm-ups; resume skips saved IDs/warm-ups and verifies compiled
and observer identities. `--interrupt-probes --pilot` uses a separate directory
for the six interrupt pilots. Run in background with a retained process handle:
a foreground tool transport is not suitable for the full collection duration.
Never resume the frozen Part 1 study or silently replace failed attempts.

### Deliberate faults

Corrupt PTY bytes, missing renderer reachability and pipe-only execution were
rejected by archive admission. Replacing an unsupported quantile bound with the
sample maximum and breaking paired variance deltas failed their named interval
assertions. Corrupting the composer marker failed the actual-cell visibility
assertion. Every source mutation was restored, and all three interval tests
passed again. Results: `fault-verification.json` and `verification.json`.

Archive-only recomputation reproduced statistics, attribution, actual cells,
quantile/variance intervals and the frozen Part 1 audit exactly. See
`archive-recomputation.json` and `analysis-recipe.json` for the checked endpoints
and exact metric lists. Documentation verification passed (nine existing
bilingual pairs consistent); `git diff --check` passed.

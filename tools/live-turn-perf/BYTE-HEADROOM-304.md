# PR #304 — emitted-byte headroom follow-up

## Scope and fixed live protocol

This follows the completed pacing experiment, but **does not use pacing**.
Compare unchanged production source `2393f1f` against the compact-padding TS
candidate. Public APIs, dependencies, Unicode widths, logical rows, synchronous
commits and production scheduling remain unchanged. No merge, release or working
profile installation is authorized or performed.

Before any provider calls: audit the frozen archives, implement one encoding
factor, check deterministic terminal parity and focused regressions. Then collect
six excluded warm-ups and exactly 30 attempted measured turns per arm per workload
(Latin, CJK, styled): 186 maximum main requests, plus up to 186 ancillary title
requests. No separate live pilots or interrupt turns, replacements, sample-size
extension or sampling until significance. A warm-up is also a reachability gate;
stop immediately on admission failure or runaway resource cost. Same real Harness,
provider `opencode-go/deepseek-v4.1-flash`, controlling 90×24 PTY and seed 303
workload rotation/adjacent alternating AB/BA as before. Type `UXPROBE304` during
the stream, without Enter; input-cell/cursor/scrollback validation is retained.

Use `ux-run.py --unpaced --workloads latin,cjk,styled --samples 30` so both arms
retain real production scheduling. Private source-linked profiles/homes only;
compiled modules and observers are hashed before and after. Archive all attempts;
failures are not admitted or silently replaced. No builds or tests during live
collection. Whole turn ends at the final measured PTY receipt, not at provider EOF
or Screen return. Renderer/composition intervals, provider-await overlap and the
disjoint accounting split are independently verified. Provider await includes
adapter, scheduling and local rendering overlap, not just remote inference.

Report per-cell n, median, p95, p99, sample SD/variance, output/chunk/token volumes,
renderer-only and provider-await separately, exact producing/received byte lengths
and SHA-256, observed first-content/input delay and paired intervals. Quantiles
interpolate at `(n−1)p`; n=30 p99 is near a maximum, not a stable population tail.
Independent replies and a single host do not establish a causal latency gain.

## Quota-free frozen byte partition

Source: unchanged `results/frozen-20261017/{raw.jsonl.gz,pty.tar.gz}`; historical
stock `8b91e0e`, candidate `43f0ff0`. These are not current-head live measurements.
`byte-classes.py` verifies admission and SHA-256 before classifying each original
Screen byte span. It streams records and spools PTY members to bound RAM.

Disjoint classes within each Screen method: printable UTF-8, CR/LF, SGR, erase,
synchronized-output brackets, cursor/other sequences. Commit printable bytes are
further divided at original clear-line row boundaries into newly committed rows
and repeated live rows. Model text/reasoning UTF-8 is a separate denominator,
not a subset of emitted bytes; repeated text and chrome are real printable bytes.
Component medians need not sum to the median total. Detailed distributions,
per-turn partitions and original input hashes are in
`results/byte-headroom-304/frozen-byte-classes.json`.

Per-turn medians (bytes):

| Workload | Arm | n | Active total | Commit total | New commit printable | Commit live repaint printable | setLive printable |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Latin | historical stock | 69 | 170,602 | 39,956 | 3,060 | 26,401 | 93,448 |
| Latin | historical candidate | 70 | 63,999 | 39,909 | 3,076 | 26,444 | 11,630 |
| CJK | historical stock | 84 | 221,268 | 41,042 | 3,524 | 27,014 | 129,698 |
| CJK | historical candidate | 84 | 73,986 | 41,044 | 3,570 | 27,028 | 15,684 |
| Styled | historical stock | 69 | 447,056 | 49,820 | 4,513 | 30,677 | 284,033 |
| Styled | historical candidate | 69 | 155,359 | 49,220 | 4,518 | 30,271 | 63,288 |

All-method byte classes, medians stock → candidate:

| Workload | Printable | SGR | Cursor/other | Erase | Sync brackets | CR/LF |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Latin | 123,842 → 41,272 | 32,113 → 12,740 | 4,676 → 4,094 | 4,896 → 1,918 | 2,672 → 2,608 | 2,106 → 869 |
| CJK | 160,942 → 46,961 | 41,693 → 14,364 | 6,104 → 5,578 | 6,342 → 2,188 | 3,488 → 3,592 | 2,733 → 1,001 |
| Styled | 319,853 → 95,890 | 89,575 → 34,519 | 12,208 → 10,372 | 12,904 → 4,720 | 6,976 → 6,640 | 5,580 → 2,137 |

Styled remains exploratory from the abandoned confirmatory workload. Unequal n
and original arm identities are preserved; the unmatched Latin candidate is not
discarded. The detailed JSON also gives raw model text/reasoning UTF-8 bytes.

The largest apparent encoding class was repeated spaces plus horizontal border
runs: about 18–20 KB/turn in commits and 3.5–30.9 KB/turn in setLive. **Reject the
border variant:** xterm parity passed, but actual tmux 3.3a failed Unicode REP.
The final candidate compresses ASCII spaces only; Unicode borders stay literal.
The smaller retained per-turn median opportunity is:

| Workload | Commit padding bytes | setLive padding bytes |
| --- | ---: | ---: |
| latin | 2,304 | 494 |
| cjk | 2,304 | 558 |
| styled | 2,496 | 4,014 |

This is an encoding-only opportunity, not scheduler replay or predicted live
savings. No incremental writes are removed or reordered. General commit
suppression, moving old terminal rows or delaying commits were not introduced:
those would change the lifecycle/scrollback contract for a much larger experiment.

## One-factor implementation and parity

`Screen` encodes already-wrapped rows only at its terminal sink. Seven or more
identical ASCII spaces use one literal seed, REP for the interior, then a
literal last glyph. No cursor motion, erase, commit timing, row contents, SGR
reset or scheduler ownership changes. Unicode borders and other characters remain literal. The original rows remain the
frame-equality/damage baseline; encoded strings are cached for only the current
frame and reused by synchronous commit repaints. Other glyphs, short runs and
rows with controls other than recognized SGR retain the literal path. No package
API, dependency, formatter or golden is changed.

The final literal glyph matters: a bare REP clears xterm's preceding-character
state and loses a following combining mark. An initial prototype failed that
regression and was corrected before any live collection. A deliberate off-by-one
REP count causes named cell/scrollback, encoding and combining-mark tests to fail;
the source is restored. Tests cover padding/borders, unchanged-frame skips,
commit repaint encoding, explicit/hidden cursor, right margin, styles/background,
scrollback and unknown/incomplete escape payloads.

ECMA-48 REP is an additional terminal output primitive. Emulator and tmux coverage
are evidence for the tested implementations, not a claim that every terminal
implements REP correctly. Physical display timing is not measured.

## Offline verification

- Six frozen traces (two per workload), **1,636 operations**: baseline versus
  candidate full buffer cells, attributes, wrap flags and cursor match after
  every reconstructed operation. Final padding-only emitted bytes fall 3.8–4.7%; this is deterministic
  Screen evidence, not a live latency claim. See `screen-replay.json`.
- Final focused Screen/rendered/streaming tests: 74 passed. Deliberate count fault: three named failures;
  bare-REP combining fault also reproduced and restored.
- Build, typecheck, bilingual docs pairing pass. Initial full suite (before
  narrowing Unicode compression back to literal borders): 5,550 passed,
  26 skipped, three launcher prerequisite failures. All three reproduce at
  unchanged baseline: local `/usr/bin/pnpm` violates those tests' assumption
  that `/bin:/usr/bin` contains no pnpm. No unrelated launcher change is made.
- Stock and candidate unmodified tmux acceptance both fail during daemon startup,
  before the fixture runs, on this host's tmux 3.3a. The failure is isolated to `set -g window-size manual` before session creation.
  A private harness copy omitting that one setting passes **18/18** checks,
  including actual Unicode border cells and REP-space placement. The rejected
  Unicode-REP variant fails the border check in that same harness. No host
  configuration or repository acceptance rule is weakened; the repository
  fixture gains the two REP-specific checks.

## Live results — fixed budget completed

**Bytes down modestly; no established whole-turn or responsiveness gain.**
All 180 measured attempts completed and were admitted, n=30 per arm/workload,
plus six excluded warm-ups. No failures, retries, replacements, extra pilots or
sample extension. Exactly 186 main calls and
186 observed concurrent title calls including warm-ups;
1 titles were right-censored at the measured endpoint.
No further provider calls after collection closed. Started `2026-10-18T01:43:34Z`;
finished `2026-10-18T02:07:56Z`.

- Host: Pi 5 `pi5richi`, Linux 6.12.93+rpt-rpi-2712, aarch64, four Cortex-A76
  cores; Node v24.18.0, Harness/adapter 0.2.0-rc.2, existing pi-ai resolution.
  Controlling **90×24 PTY**, TERM=xterm-256color, truecolor, private-slave OPOST
  disabled only. No physical-display timing claim.
- Baseline `2393f1f`; producing candidate **`2240303`**. All 163 compiled modules
  per arm match before and after collection. Only `packages/renderer/lib/screen.js`
  differs between arms. Current Screen source matches the producing commit
  exactly after deliberate mutations were restored. No production pacing,
  public API, dependency, formatter, palette or golden changes.
- All **186 captures** pass byte-count/SHA-256 equality of the complete producing
  output and actual PTY receipts, fixed TTY geometry, exit zero, one real main
  provider iterator reaching natural EOF, positive actual Screen/composition/frame
  counters, text-only/no-tools and real Harness settlement. The observer classes
  are loaded through Harness's module graph. Model route is exactly
  `opencode-go/deepseek-v4.1-flash`.
- All 186 captures pass actual emulator marker cells, cursor and no-marker-in-
  scrollback checks. All 180 measured input probes arrived before provider EOF.
  Independent endpoint-sweep overlap agrees with renderer + nonrenderer-await +
  residual accounting. Corrupt-byte, pipe-only and zero-renderer faults fail.
- Private benchmark homes used existing credential resolution. All generated
  credential copies are removed; none are archived. No working-profile install,
  merge, release, model switch or host configuration change.

### Whole turn: submission → final measured PTY receipt

Units: milliseconds. Per-turn distributions.

| Workload | Arm | n | Median | p95 | p99 | SD |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| latin | stock | 30 | 3,487.47 | 6,072.40 | 7,256.73 | 1,093.06 |
| latin | candidate | 30 | 3,495.94 | 5,119.50 | 6,570.24 | 792.70 |
| cjk | stock | 30 | 4,410.19 | 7,116.74 | 7,658.09 | 1,100.15 |
| cjk | candidate | 30 | 4,265.32 | 5,432.22 | 7,371.40 | 836.81 |
| styled | stock | 30 | 6,742.58 | 10,231.02 | 18,427.56 | 2,961.62 |
| styled | candidate | 30 | 6,499.32 | 12,268.55 | 15,247.94 | 2,441.21 |

### Active-turn emitted bytes

These cross-arm observations include varying reasoning, chunk counts and, for
styled, varying output lengths. They are not equal-output paired reruns. Bytes
exclude startup and teardown; complete-transcript hashes still cover startup.

Units: bytes. Per-turn distributions.

| Workload | Arm | n | Median | p95 | p99 | SD |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| latin | stock | 30 | 63,521.50 | 85,895.55 | 92,453.56 | 10,897.78 |
| latin | candidate | 30 | 59,035.00 | 70,108.30 | 73,454.25 | 5,408.76 |
| cjk | stock | 30 | 72,587.50 | 94,223.15 | 97,700.16 | 9,658.81 |
| cjk | candidate | 30 | 69,995.50 | 95,407.10 | 121,538.88 | 15,936.09 |
| styled | stock | 30 | 135,172.50 | 176,891.10 | 181,395.89 | 32,255.60 |
| styled | candidate | 30 | 126,125.00 | 206,563.45 | 264,243.86 | 43,330.47 |

CJK and styled candidate byte tails **increase**, despite lower observed medians.
For example, CJK chunk p99 is 264.36 → 954.23 and styled chunk p99 is
498.88 → 667.88; retain those differing work volumes rather than hiding them.
Latin and CJK answer-character counts are constant within workloads; styled
answer lengths and reasoning/chunk cadence remain variable. Raw per-turn lengths,
reasoning, tokens/cache, chunks, frames and write counts remain in the archive
and summary. Fewer calls/writes are not the optimization endpoint.

### Direct encoding effect within each actual candidate output

`padding-effect.py` expands only validated ASCII-space REP with literal endpoints
inside each captured Screen write. The literal-equivalent keeps the same actual
operations, replies and boundaries, so this identifies bytes avoided by encoding
without attributing provider/work-volume differences to the renderer. It is not
a live rerun, scheduler replay, or latency counterfactual.

| Workload | n | Avoided bytes median | p95 | p99 | SD | Median avoided fraction | Commit bytes avoided median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| latin | 30 | 2,985.00 | 3,577.50 | 3,632.18 | 255.38 | 4.86% | 2,400.00 |
| cjk | 30 | 3,113.00 | 4,404.05 | 5,941.74 | 802.36 | 4.30% | 2,400.00 |
| styled | 30 | 5,598.50 | 8,690.05 | 11,236.64 | 1,952.76 | 4.09% | 2,720.00 |

Observed active-byte medians are 63,521.5 → 59,035 (Latin), 72,587.5 → 69,995.5
(CJK), and 135,172.5 → 126,125 (styled). Those cross-arm changes must not be
substituted for the exact, smaller encoding-only effect above. The bulk of the
original border/commit-repaint headroom remains; the unsafe Unicode-REP route
is rejected, not counted as delivered savings.

### Renderer-only intervals: Screen + composition, disjoint

Units: milliseconds. Per-turn distributions.

| Workload | Arm | n | Median | p95 | p99 | SD |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| latin | stock | 30 | 230.14 | 391.41 | 1,114.58 | 218.33 |
| latin | candidate | 30 | 222.83 | 308.30 | 347.04 | 40.54 |
| cjk | stock | 30 | 343.78 | 474.83 | 511.13 | 70.14 |
| cjk | candidate | 30 | 334.36 | 547.59 | 582.73 | 92.17 |
| styled | stock | 30 | 601.14 | 902.18 | 924.06 | 136.67 |
| styled | candidate | 30 | 591.60 | 865.80 | 1,104.69 | 186.46 |

CJK renderer p95/p99 and styled renderer p99 increase. These remain observed
tails, not explained away by lower medians or called proven noise. Baseline Latin
also retains its large renderer outlier. The extra encoding and observer work
can affect output-sensitive cost; single-host timings do not prove kernel or
cross-platform speedups.

### Provider-await with renderer overlap removed

The following is the disjoint nonrenderer-await accounting component, not pure
network/inference time. Raw iterator-await medians remain about 3.34–6.55 seconds
and are separately retained alongside overlap and residual. Component medians
need not sum to whole-turn medians.

Units: milliseconds. Per-turn distributions.

| Workload | Arm | n | Median | p95 | p99 | SD |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| latin | stock | 30 | 3,128.75 | 5,590.54 | 5,986.29 | 927.64 |
| latin | candidate | 30 | 3,130.82 | 4,651.28 | 6,112.43 | 768.19 |
| cjk | stock | 30 | 3,900.08 | 6,473.69 | 7,112.33 | 1,046.70 |
| cjk | candidate | 30 | 3,760.47 | 4,861.90 | 6,713.29 | 778.48 |
| styled | stock | 30 | 5,921.80 | 9,220.16 | 17,398.32 | 2,886.29 |
| styled | candidate | 30 | 5,705.81 | 11,182.95 | 12,448.80 | 2,027.31 |

### First-content output proxy

First complete Screen write after a nonempty content delta, then the PTY receipt
covering its cumulative byte offset. This is not proof of physical display paint.

Units: milliseconds. Per-turn distributions.

| Workload | Arm | n | Median | p95 | p99 | SD |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| latin | stock | 30 | 1,927.73 | 3,263.37 | 4,332.84 | 625.95 |
| latin | candidate | 30 | 1,986.79 | 3,417.84 | 4,900.03 | 715.94 |
| cjk | stock | 30 | 2,006.44 | 3,128.19 | 4,751.03 | 728.98 |
| cjk | candidate | 30 | 1,878.38 | 2,256.17 | 2,808.74 | 330.58 |
| styled | stock | 30 | 2,031.38 | 2,367.47 | 13,704.49 | 3,013.17 |
| styled | candidate | 30 | 1,984.28 | 2,474.80 | 2,974.63 | 332.45 |

### Active typing: send → PTY receipt containing composer echo

Units: milliseconds. Per-turn distributions.

| Workload | Arm | n | Median | p95 | p99 | SD |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| latin | stock | 30 | 6.87 | 10.48 | 13.22 | 1.69 |
| latin | candidate | 30 | 6.90 | 11.58 | 14.29 | 2.18 |
| cjk | stock | 30 | 7.32 | 12.75 | 15.36 | 2.44 |
| cjk | candidate | 30 | 7.26 | 11.13 | 13.00 | 1.82 |
| styled | stock | 30 | 6.63 | 12.62 | 36.43 | 7.29 |
| styled | candidate | 30 | 7.37 | 10.22 | 10.61 | 1.62 |

Styled typing median increases by about 0.74 ms; its paired interval crosses
zero. No measured input/smoothness improvement is established. The median of
per-turn p95 chunk→next-Screen-output proxies stays about 2.0–2.3 ms in both arms;
no 16 ms pacing delay is introduced. All delivery median bootstrap intervals,
including first feedback, cross zero. Full tails/SD/variance for these proxies
are in `live/ux-summary.json` and `live/delivery-confidence.json`.

### Paired uncertainty and verdict

Adjacent AB/BA pair-block bootstrap, 3,000 replicates, seed 303, pointwise 95%
percentile intervals; no multiplicity adjustment. All whole-turn median, p95 and
p99 difference intervals cross zero. Whole-turn median candidate−baseline:

| Workload | Delta ms | Bootstrap 95% interval ms |
| --- | ---: | ---: |
| latin | 8.47 | [-340.57, 229.80] |
| cjk | -144.87 | [-592.82, 324.19] |
| styled | -243.26 | [-957.61, 1,141.28] |

Styled whole-turn p95 worsens **10,231 → 12,269 ms** (about +20%). Do not advertise
its lower median or p99 as a latency win. Distribution-free population p95/p99
bounds remain unbounded at n=30; the sample p99s are near-maxima. Local stationarity
and exchangeability are assumptions, not proved. No causal latency claim follows
from fresh independent provider replies, pointwise intervals, instrumentation,
provider sharing, or one host/terminal.

**Verdict:** a validated small ASCII-padding bandwidth cleanup, not a latency
optimization. Keep the larger border variant rejected and production scheduling
unchanged. No whole-turn, typing or smoothness win is established. The candidate
stays on the draft branch; nothing is merged, released or installed into the
working profile. More aggressive commit/row-state changes are outside this bounded
experiment, not silently delivered as untested optimizations.

### Evidence and offline reproduction

Final focused tests: **74 passed**, including the six/seven-space boundary.
Three deliberate semantic faults (wrong repeat count, missing final literal,
lost control-payload guard) are rejected for assertion failures, with the exact
producing source restored. See `fault-verification.json`. The initial full-suite
local prerequisite exceptions and private tmux workaround are disclosed above;
source commit `2240303` passes all exact-head GitHub CI, including all three Core
lanes and the unmodified terminal acceptance harness with its two added checks.
The final evidence-only head receives its own CI verdict before closeout.

All per-cell medians/p95/p99/SD/sample variance, output/chunk/token volumes,
auxiliary lifetimes, byte counters and original captures are retained under
`results/byte-headroom-304/live/`. Archive-only recomputation compares summary,
UX metrics, exact byte effects, input cells, admission/attribution and both
interval reports. It requires neither original per-turn files nor a provider:

```sh
python3 tools/live-turn-perf/byte-archive-recompute.py tools/live-turn-perf/results/byte-headroom-304/live
```

`SHA256SUMS`, `tool-identities.json`, `build-verification.json` and
`archive-recomputation.json` bind the retained data and tooling. Archived module
hash maps preserve the producing commits; later report/test-only commits do not
relabel the measured sources.

Provenance SHA-256 entries next to module names containing `keys` are verified
compiled digests, not credentials. Scanner exceptions are restricted to four
exact historical finding fingerprints; no file or rule is excluded.

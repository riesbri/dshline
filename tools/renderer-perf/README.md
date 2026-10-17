# TypeScript live-region performance investigation

## Scope and decision

Keep the append-and-live-region architecture and the production `RedrawScheduler`.
Reuse the previous live frame's pure wrap results, keyed by exact styled text and
terminal width. When width and rendered height are unchanged and the frame is
current, replace only damaged rows, then restore the requested cursor. Startup,
resize, stale frames, height changes, and commits retain the full drawing path.
The cache retains only the last written live frame, not transcript history.

No Rust, FFI, runtime dependencies, alternate screen, public API change, timer cap,
or character-prefix slicing. A full changed row remains the atomic damage unit:
SGR state, wide characters, combining marks and terminal pending-wrap state make
arbitrary suffix-only painting a larger correctness commitment.

### Research order

Read the repository architecture, design, renderer README and contribution rules;
inspect Screen, StreamBuffer, TuiSlots, views and RedrawScheduler. Check existing
solutions: Screen already supplies bounded native scrollback and the identical-frame
skip; replacing it with a framework conflicts with the documented product model
and dependency-free renderer contract. Extend its existing primitives instead.

Profile stock TypeScript first, including a paced replay. Measure row damage alone,
then add last-frame wrap reuse after width/wrap dominates the stock profile. A
compact width table, growing-prefix memoization and a time cap remain unimplemented
candidates, not claimed wins. In particular, StreamBuffer already bounds its visible
source tail, and this profile identifies repeated chrome wrapping as removable work.
A cap would add latency to every input echo; neither the baseline nor the selected
changes require that trade-off.

## Reproduce

Run from the repository root, on Node 22.19+ or 24+:

```sh
pnpm install --frozen-lockfile
pnpm build
mkdir -p private/renderer-perf
node --cpu-prof --cpu-prof-dir=private/renderer-perf --cpu-prof-name=baseline.cpuprofile tools/renderer-perf.mjs --baseline-ref=8b91e0e --repetitions=7 > private/renderer-perf/baseline.json
node --cpu-prof --cpu-prof-dir=private/renderer-perf --cpu-prof-name=candidate.cpuprofile tools/renderer-perf.mjs --repetitions=7 > private/renderer-perf/candidate.json
node tools/renderer-profile.mjs private/renderer-perf/baseline.cpuprofile private/renderer-perf/baseline.json
node tools/renderer-profile.mjs private/renderer-perf/candidate.cpuprofile private/renderer-perf/candidate.json
node tools/renderer-perf.mjs --baseline-ref=8b91e0e --cadence=16 --lines=40 --repetitions=3 > private/renderer-perf/baseline-paced.json
node tools/renderer-perf.mjs --cadence=16 --lines=40 --repetitions=3 > private/renderer-perf/candidate-paced.json
```

`--baseline-ref` extracts only Screen from that git commit, transforms it with
Node's built-in TypeScript support, and imports it alongside the candidate. Other
modules are identical in both arms: width, StreamBuffer, views and the scheduler
are unchanged in this PR. Thus this is a stock TypeScript baseline, not a native
comparison or a reconstructed baseline algorithm. The generated baseline module
and raw profiles stay under ignored `private/renderer-perf/`.

The replay uses real compiled StreamBuffer.push/settle/live, TuiSlots.compose,
createComposerView, createStatusView, RedrawScheduler and Screen, with the shipping
frontend palette explicitly installed at depth 4. Status tick is fixed to isolate
streaming damage; capability projection reads and animation ticks are not replayed. Every delta asks
for two invalidations in the same turn; the real scheduler coalesces them. Commits
remain synchronous. The emitter delivers 37 UTF-16-unit chunks through event-loop
turns; the paced arm waits 16 ms between deliveries (provider-like cadence, not a
captured network trace). Workloads are Latin prose, Chinese prose, inline markdown,
and a long no-newline URL-like payload. Each arm warms up once per workload.

`@xterm/headless` consumes every terminal write asynchronously. The measured turn
ends only after the terminal has parsed the final bytes. Final fingerprints cover
scrollback text, foreground/background, bold/italic/underline cells, cursor and
scroll position. Input generation, setup, warm-up, fingerprinting and teardown are
outside measured turn spans. Output reports every measured run and medians; tail
columns are the median of each run's p95/p99, not a pooled percentile.

`renderer-profile.mjs` attributes each sample to its nearest owning stack frame,
using the recorded monotonic turn boundaries to exclude startup and warm-up. Idle
and GC remain explicit buckets. This is sampled elapsed time, not exact CPU counters.
The width bucket includes measurement, tokenization and wrapping; stage timings
`composeMs` and `screenMs` are inclusive, and `writeMs` is enqueue work nested inside
Screen/commit. `pushMs` includes synchronous commit and is not a pure StreamBuffer
self-time. `drainMs` is only the final outstanding emulator tail: parsing also runs
between deliveries, so it must not be called total emulator cost.

### Limits

This is a deterministic production-render-path turn replay, **not** a real model or
full Harness attachment benchmark. The Harness/cordis profile bucket is fixture
context/service access and event dispatch; LLM requests, real session persistence,
projection providers, networking, OS PTY throughput and a physical terminal are
unmeasured. No installed profile is launched or changed. Consequently these results
do not establish the prior real-terminal 67–94% drain claim or predict a user's
end-to-end model turn speedup. The draft PR's remaining acceptance gap is a live
Harness/PTY CPU capture if that is required beyond this production-scheduler replay.

The host is shared. Runs are separate processes, not interleaved randomized arms;
short tail differences and wall-time variation should not be overinterpreted.
The final shipping-palette arms run sequentially; repository checks and unrelated
processes can still run on this shared machine. Bytes and exact terminal parity are deterministic;
latency tails are evidence of this host run, not a latency guarantee.

## Results

Measured 2026-10-17 on Node 24.18.0, Linux arm64 (4-core Cortex-A76),
90 columns by 24 rows. Seven measured unpaced turns per workload; the paced
workloads use 40 source lines and three measured turns after warm-up.
The checked-in JSON contains per-run observations and profile attribution.

### Production-path turn medians (unpaced, seven turns)

| Workload | Turn ms, stock → candidate | Change | Bytes, stock → candidate | Change | Screen ms, stock → candidate | Frame p95 ms, stock → candidate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| latin | 607.8 → 492.5 | -19.0% | 2,269,516 → 1,461,162 | -35.6% | 164.6 → 57.4 | 0.243 → 0.206 |
| cjk | 237.1 → 185.2 | -21.9% | 1,118,439 → 1,068,203 | -4.5% | 60.9 → 19.8 | 0.224 → 0.154 |
| styled | 648.9 → 466.6 | -28.1% | 2,405,823 → 1,480,869 | -38.4% | 177.0 → 52.5 | 0.261 → 0.179 |
| long | 794.1 → 609.6 | -23.2% | 2,507,035 → 958,163 | -61.8% | 227.9 → 121.2 | 0.329 → 0.272 |

Exact final terminal fingerprints agree in every workload and arm, as do frame
and write counts. These are reductions in work per frame, not fewer redraws.
The worst output amplification remains high: Latin is 32.2× → 20.8× input bytes.
The earlier 8.3× figure is not transferable to this workload/real composition.

### CPU samples inside the measured turns

Seven measured turns × four workloads; milliseconds of sampled time, including
explicit idle/GC, excluding import/setup/warm-up/snapshot/teardown:

| Owner | Stock ms (%) | Candidate ms (%) |
| --- | ---: | ---: |
| width/wrap | 7661.4 (46.7%) | 4462.1 (35.4%) |
| emulator | 2277.0 (13.9%) | 1378.3 (10.9%) |
| fixture Harness/cordis | 1914.5 (11.7%) | 1817.6 (14.4%) |
| StreamBuffer | 1457.1 (8.9%) | 1399.6 (11.1%) |
| compose/views | 1265.0 (7.7%) | 1370.0 (10.9%) |
| Screen | 482.7 (2.9%) | 901.1 (7.2%) |
| startup/runtime/other | 449.4 (2.7%) | 485.1 (3.8%) |
| replay driver | 356.5 (2.2%) | 284.7 (2.3%) |
| GC | 268.3 (1.6%) | 252.9 (2.0%) |
| idle | 154.3 (0.9%) | 153.9 (1.2%) |
| write/enqueue | 126.6 (0.8%) | 98.0 (0.8%) |

The Screen **self** bucket increases (map/damage bookkeeping); inclusive Screen
stage time drops by 47–70%. Composition is not optimized here and its samples can
rise. Emulator parsing falls in absolute sampled time, but is not the dominant
bucket on this replay. Do not extrapolate a native-leaf microbenchmark to the
user-visible budget.

### 16 ms delivery cadence (three shorter turns)

Wall time includes the deliberately paced emitter, so it is not a throughput score.
Latency is delta arrival through production scheduler/compose/Screen completion;
delivered p95 additionally waits for xterm parsing, not a physical display.

| Workload | Turn ms, stock → candidate | Frame p95 ms | Request p95 ms | Request p99 ms | Delivered p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| latin | 3861.8 → 3874.5 | 0.376 → 0.328 | 0.596 → 0.586 | 1.821 → 1.241 | 1.987 → 1.899 |
| cjk | 1465.7 → 1491.6 | 0.397 → 0.442 | 0.846 → 1.031 | 16.621 → 17.089 | 4.225 → 3.783 |
| styled | 3980.9 → 4075.8 | 0.453 → 0.613 | 0.667 → 1.445 | 1.217 → 4.879 | 1.867 → 3.891 |
| long | 4000.4 → 3999.6 | 0.503 → 0.408 | 0.729 → 0.586 | 1.136 → 1.004 | 2.206 → 1.787 |

Paced wall-time differences are not a product speedup: the source timer dominates,
and host contention affects tails (especially the stock CJK p99). There is no new
frame-rate cap or added intentional input delay. There are real non-wins in this run: styled request p95 regresses from 0.667 to
1.445 ms (p99 1.217 to 4.879 ms), and CJK request p95 from 0.846 to 1.031 ms.
These shared-host measurements do not establish whether the candidate or concurrent
resource pressure caused those tails; they must not be presented as a latency win.
The long-line and Latin paced tails improve, but no responsiveness guarantee is
claimed. Recheck the paced regressions on a quiet host before considering a merge.

### Staging and non-wins

The initial renderer-default-palette exploration measured row damage alone before
wrap reuse: bytes fell 35% Latin, 37% styled, 59% long-line, but only 4% CJK.
Turn-time improvements were only 2–12%; less output is not an equal wall-time win.
Those exploratory medians are separately labelled in `results.json`, not mixed
with the shipping-theme comparison. Their fingerprints were text/cursor-only;
final arms add cell attributes and explicitly install the frontend palette.

CJK often changes the live region's height, so it still takes the full redraw path.
Commits still erase and redraw live chrome, and changed rows still transmit their
whole content. Prefix/suffix writes, reducing commit redraws, width tables and
redraw throttling are not implemented or advertised as solved here.

## Verification

- Eight focused Screen tests: bandwidth, cursor-only damage, styled/wide/combining
  replacement, pending right-margin wrap, stale fallback, bounded wrapping cache,
  resize/reorder/close invalidation, and 48 mixed frames against full redraw cells.
- The existing terminal oracle now requires full erase only when geometry or
  validity changes; it still independently checks content, cursor, scrollback,
  duplicate/stale rows and ordered commits after every operation.
- Stock Screen fails the four new damage/cache work-bound assertions by name.
- Disabling cache reuse fails both reuse tests. Omitting per-row CLEAR_LINE fails
  the new styled-row and mixed-frame checks **and** the existing terminal oracle.
- Build, typecheck/capability typecheck, dependency audit, workflow lint, bilingual
  documentation verification: passed.
- The unrestricted suite was attempted; the bounded full run initially found two
  oracle assumptions corrected above plus three existing host-dependent launcher
  failures. The same three reproduce with stock Screen: the fixture assumes
  `/bin:/usr/bin` has no pnpm, but this machine has `/usr/bin/pnpm` via Corepack.
  Launcher production code and fixtures are unchanged. Subsequent resource-related
  terminations are not counted as passing checks.

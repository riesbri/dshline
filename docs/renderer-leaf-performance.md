# Native-leaf lookup implementation

English | [中文](renderer-leaf-performance.zh.md)

> **Follow-up:** The measurements below are historical, before the additional regression guards. [The follow-up report](renderer-leaf-followup.md) records TS-by-default selection, runtime/compiled Unicode coupling, same-run regression reproduction and real PTY streamed-turn timing.

## Scope

This implements the lookup-only and cycle-free native-leaf proposal from
[research PR 301](https://github.com/riesbri/dshline/pull/301), against the reviewed
renderer baseline `5e48b70`. It does not adopt the rejected two-pass tail or
ASCII wrapper, widen native admission, or move host ownership into Rust.

`native-primitives.ts` owns the existing optional loader, process renderer mode
and guarded direct operations, depending only on the unchanged TS width policy
and Node's module loader. `backend.ts` reuses that selection for composite and
markdown dispatch. Screen and box/frame internals import the primitive seam;
there is no import back into the composite layer and the runtime graph is tested
for cycles. TypeScript still owns callbacks, mutable objects, palettes, document
state, terminal writes, scrollback and lifecycle. Harness owns all agent state.

## Derived lookup

The generator reads only the committed Unicode width policy, without a network
or build dependency. It produces 4352 one-byte indexes and 108 unique 256-byte
pages: **32000 data bytes**, smaller than the research prototype's two-byte
indexes. A future policy needing more than 256 pages fails generation rather
than truncating indexes. The original Rust ranges remain an independent test
oracle, and every Unicode code point is compared exhaustively. ANSI scanning,
control precedence, lone surrogates and out-of-domain library behavior remain
unchanged. Build and CI reject stale generated data.

The first production-path run exposed a compiler-shape regression: a small
lookup was automatically inlined into the display scanner, and plain ASCII
width/fit slowed by 10–25% on Linux ARM64. Keeping `code_point_width` out of line
restored baseline ASCII and late-CJK behavior in focused probes while retaining
the large Unicode gain. A split-helper variant improved some token transforms
but regressed fit, so it was not retained. Final repeated measurements below evaluate this control on each platform;
original results stay labeled initial/pre-fit rather than being overwritten.

## Bounded fit follow-up

The first Intel rerun restored ASCII width but exposed a long-row `fit` regression.
The retained follow-up reuses the existing truncator's exact measured prefix
width for padding. For inputs longer than four times the column budget it avoids
scanning a suffix that will be discarded; short/already-fitted rows retain one
width scan and clone. Zero columns preserve an entirely zero-width source, while
negative budgets remain empty. This changes no API, admission or host ownership.

A separate oracle check reproduced representation-dependent TS widths for sliced
strings ending in a lone high surrogate on local Node 24.18. The scanner now
derives the code point from the same bounded UTF-16 units used for its token span,
rather than reading it separately with `codePointAt`. This preserves the intended
code-point-sum policy and lossless malformed units; it is not a new Unicode policy.
A real-process sliced-versus-flat regression test rejects the old scanner, and a
wrong-padding mutation fails the new Rust semantic test. No upstream engine cause
or general Node vulnerability is established here.

## Correctness and admission

The existing auto thresholds, 2048-unit input ceiling and ±256-column budget
remain unchanged. Missing artifacts and unsupported host values select TS before
execution. Auto recovers admitted backend/panic failures once under TS-only
selection; caller resource/input errors and all forced-rust errors still propagate
without retry ([policy](renderer-auto-recovery.md)). Explicit TS mode
never calls the addon, including inside Screen/frame. Forced Rust still permits
host callbacks, but their admitted scalar leaf work now reaches the same native
selector rather than a separate host implementation.

Verified reference snapshots explicitly select TS before loading host modules,
including the existing benchmark, soak and native-boundary test references.
This avoids silently comparing native host paths against themselves. Declaration
snapshots include transitive re-exported modules. All 86 golden inputs and outputs
remain unchanged; only their source/build identities are refreshed.

Actual-addon tests count host-native calls and compare exact writes, callback
observation, emulator cells, cursor, color, stale/shrink/resize behavior and no-op
redraws in auto/rust/TS modes. Resource-error probes prove no retry, and tiny,
oversized and narrow inputs prove pre-admission fallback.

## Final measurements

Measured runtime commit: `accff9c9cf2ea3cb155b852ca536a531ef0f38a4`.
Comparison: separately built reviewed native baseline `5e48b70`, **not TS-only**.
Both sides use the same toolchain within each run: Rust 1.99.0 / LLVM 23.1.1;
Node 24.18 on local Linux Cortex-A76, 24.20 on hosted Apple M1 (Virtual), and
24.19 on hosted Intel i7-8700B. These machines are not compared against each other.

Below are **microseconds, baseline public auto → new public auto (speedup)**.
Each value is the median of three per-pass medians of five calibrated batch means,
not a per-call percentile. Fits use 40 columns; frames/Screen use an 80-column
initial terminal and Screen also exercises shrink/resize, commit and no-op redraw.

| 2048-unit workload | Linux ARM64 | macOS M1 | macOS Intel |
| --- | ---: | ---: | ---: |
| displayWidth ascii | 3.31 → 3.31 (1.00×) | 2.46 → 2.38 (1.03×) | 2.12 → 2.02 (1.05×) |
| displayWidth cjk | 49.40 → 8.38 (5.90×) | 25.56 → 6.30 (4.06×) | 26.56 → 10.31 (2.58×) |
| fitToWidth ascii | 4.70 → 1.94 (2.43×) | 2.59 → 0.90 (2.87×) | 4.27 → 2.28 (1.87×) |
| fitToWidth cjk | 51.03 → 1.60 (31.94×) | 34.62 → 0.88 (39.43×) | 28.85 → 1.90 (15.19×) |
| frame ascii | 270.73 → 95.73 (2.83×) | 108.56 → 60.35 (1.80×) | 219.86 → 139.25 (1.58×) |
| screen ascii | 691.03 → 224.09 (3.08×) | 356.87 → 123.76 (2.88×) | 517.22 → 252.48 (2.05×) |
| screen cjk | 1221.50 → 289.87 (4.21×) | 572.84 → 156.26 (3.67×) | 862.54 → 378.25 (2.28×) |
| screen ansi | 598.85 → 198.16 (3.02×) | 282.91 → 136.16 (2.08×) | 426.49 → 246.21 (1.73×) |

The largest measured kernel win comes from avoiding discarded suffix scans in
long bounded fits, while native-leaf routing makes existing Rust wrapping reach
real host call paths. Trace recipes record zero baseline host-native calls versus
current frame wrapping/width and three Screen wrapping calls. This is stronger
than timing an unreachable export, but still only synthetic CPU evidence.

### Regressions and rejected tuning

This is **not uniformly faster**. Of 120 workloads, observed public-auto medians
were more than 10% slower in 1 Linux, 30 M1 and 11 Intel cases. All raw samples are
retained; those counts do not establish statistical significance. Examples:

- Linux 24-unit ASCII callback frame: 4.93 → 5.52 µs (12% slower).
- M1 24-unit CJK wrap: 2.30 → 4.18 µs; 96-unit emoji chunk: 3.01 → 5.32 µs.
  These auto paths remain TS under the existing thresholds. The M1 2048-unit
  late-CJK width case also worsened: 1.73 → 2.06 µs (19%).
- Intel 512-unit wrap at 256 columns: 12.19 → 15.79 µs (29% slower); some tail,
  small fit and ANSI wrap cases also regress.

Hosted samples show substantial pass-to-pass variation. Treat these as observed
trade-offs, not an all-input or live-session latency guarantee. Admission is not
widened or retuned to hide slower cases.

Scratch-only ThinLTO plus one codegen unit passed exhaustive width and 10,680
bounded transform comparisons per Mac, but exceeded the untuned new build's
medians by more than 10% in **39/120 M1** and **31/120 Intel** workloads. It is
**not adopted**. Panic unwinding, portable CPU defaults and the deployment floor
remain unchanged. The two-pass tail and ASCII wrapper remain rejected.

## Reproduction and evidence

`tools/renderer-upgrade-bench.mjs --baseline-root <checkout> --output <json>`
requires the exact separately built baseline, verifies emitted TS graphs and
addon source/binary provenance, exhaustively checks every code point through both
release addons, and traces native reachability before timing. It keeps eight
varying inputs per workload, 500 warmups, calibrated ≥5 ms batches, three rotated
passes, and rechecks identities afterward. Do not run concurrent builds/tests.
The reference snapshot explicitly selects TS before host imports.

For real Mac experiments, dispatch the existing `ci.yml` workflow on this branch.
Only `workflow_dispatch` runs the extra same-toolchain baseline/ThinLTO benchmarks;
normal PRs still require every native build and parity gate, without the expensive
performance step. The Mac jobs upload `renderer-upgrade-darwin-arm64` and
`renderer-upgrade-darwin-x64`. No tuned binary replaces a packaged addon.

- [Linux ARM64 raw results](../benchmarks/renderer-leaf-linux-arm64.json),
  [M1 raw results](../benchmarks/renderer-leaf-darwin-arm64.json),
  [Intel raw results](../benchmarks/renderer-leaf-darwin-x64.json).
- [Summary, all observed >10% regressions, source identities and packed-byte proof](../benchmarks/renderer-leaf-summary.json).
- [Balanced direct-addon soak](../benchmarks/renderer-leaf-soak-linux-arm64.json):
  **2,701,224 comparisons**, 300,000 randomized plus 136 boundary cases, eight
  budgets with exactly 37,517 cases each. It cannot succeed via auto fallback.
- Initial lookup measurements and noinline/pre-fit reruns remain in the same
  directory under `*-initial.json` and `*-pre-fit.json`. Do not pool these builds.
- [Full source-validation CI including both Mac measurements](https://github.com/riesbri/dshline/actions/runs/38888234341)
  passed. [Six-platform PR artifacts](https://github.com/riesbri/dshline/actions/runs/38888221013)
  were validated in their actual synthetic merge checkout
  `118ec4b9175db1cbd4607ce8b0ac19ccfbb89e9c`, whose full tree equals measured head.
  All six original proofs and packed bytes pass; no provenance was relabeled.

Shared native-input SHA-256:
`16b6a3c17a0d75e2895729845826e95536de4e9357629f8cc6df783a1d8e34f4`.
All three measured TS source/build/config identities match exactly.

## Verification and limits

The source-validation run passes all six native targets, Core Node 22.19/24/26,
Harness adopted source and packed consumer, Windows launcher, tmux and docs.
Core has 5,585 passing / 26 skipped on Node 24/26 and 5,583 / 28 on Node 22.19,
plus required actual-addon checks. [Source security/CodeQL](https://github.com/riesbri/dshline/actions/runs/38888220985)
passes. The parallel PR consumer hit its existing 10-minute plugin-add timeout
(after pnpm printed done); the same runtime commit passed that lane in the full
manual source run. No cause beyond the observed timeout is established and no
timeout was widened. Final-head CI reruns that contract.
Local build/typecheck/security/docs pass; the full
local suite has **5,582 passing / 26 skipped** and the same three launcher-pnpm
prerequisite failures reproduced on unmodified baseline on this host. No new
local failures are hidden. Actual-addon focused tooling has 25 passing tests;
Rust has the exhaustive width unit test and 12 semantic tests. All 86 golden
inputs/outputs remain unchanged. Deliberate wrong lookup, bypassed Screen leaf,
old sliced scanner and wrong measured-prefix/padding mutations fail output checks.

The host emulator checks exact ordered writes, cells/colors/cursor and callback
observations. Timed host recipes use an in-memory sink: no PTY/terminal-I/O,
whole-turn speedup, leak/sanitizer, or real-Mac interactive profiling claim is made.
This was self-reviewed, **not independently reviewed**; draft status is retained.
Final report-head check status is visible on [PR 302](https://github.com/riesbri/dshline/pull/302).

The next useful macOS investigation is a real interactive Instruments profile,
not a blanket CPU-specific prebuild or another policy migration. See Apple's
[CPU profiling guidance](https://developer.apple.com/videos/play/wwdc2025/308/),
[Rust Apple targets](https://doc.rust-lang.org/rustc/platform-support/apple-darwin.html)
and [compiler options](https://doc.rust-lang.org/rustc/codegen-options/index.html#target-cpu).
The portable boundary stays intact; this task changes no working profile,
Harness/model policy, merge or release.

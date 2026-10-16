# Native-leaf follow-up: admission and terminal budget

English | [中文](renderer-leaf-followup.zh.md)

## Boundary

TypeScript is now the default in both the standalone renderer and dshline's
composition/window entry points. `auto` is an explicit opt-in to admitted native
leaves; it does not move StreamBuffer, Screen, callbacks, terminal writes,
markdown or Harness state to Rust. Existing `rust` selection remains a diagnostic
forced mode, but cannot override Unicode compatibility. No merge, release,
profile installation, dependency, CPU-target, panic-policy or ThinLTO change.

The original input ceiling (2048 UTF-16 units), ±256-column admission and auto
thresholds remain unchanged. New exclusions narrow automatic admission. TS is
selected before calling native; errors from admitted execution still propagate
without retry.

## 1. ASCII regression families

The original **30/120 M1 and 11/120 Intel** figures count all public regressions,
not just ASCII. Together they contain **29 ASCII/ANSI/sparse-CJK observations**
(including repeated cases on the two machines). The remaining 12 observations
are CJK/emoji or tiny host cases that already select TS. They are not native
regressions that can be repaired by a Rust lookup change.

The following named guards keep the losing families on TS in `auto`. They are
portable exclusions, not platform-specific code or a whitelist of exact fixture
strings. Historical inputs, eight varying endings, and other members of these
families all retain TS semantics.

| Guard | Additional automatic-native exclusion |
| --- | --- |
| `ascii-short-width` | ASCII code units, including ANSI escapes, at ≤512 units for width |
| `ascii-dominant-width` | Width with one non-ASCII code point amid ASCII (short text, or a late Unicode suffix in long text) |
| `ascii-tail` | ASCII/ANSI tail inputs at ≥512 units |
| `ascii-chunk` | ASCII/ANSI chunking |
| `ascii-wrap` | ASCII/ANSI wrapping at ≤512 units, ≥256 columns, or with escapes |

Existing thresholds also exclude small, narrow and below-threshold chunk cases.
Long unstyled ASCII fits/width and ordinary-budget long Screen recipes stay
eligible; so do the dense CJK/lookup workloads. The gates are a routing remedy,
**not a claim that TS beats the reviewed native baseline**: falling back can be
slower than that baseline. Raw before/after medians retain that cost.

The new test derives the exact historical losing inputs from the committed raw
archives, independently anchors all 29 observations, and counts native execution.
Removing the regression guards deliberately makes the test fail. Explicit TS
also stays TS with a valid addon present.

## 2. Unicode coupling

The width-table generator emits `WIDTH_UNICODE_VERSION`; the Rust lookup
generator derives its version from that committed policy and rejects a missing
or inconsistent release. The addon exposes `unicodeVersion()` from the actual
compiled lookup, not the build machine. Before any public native execution,
Node's `process.versions.unicode`, the TS table release and the compiled lookup
must agree. Missing metadata, an older addon or runtime mismatch selects TS,
even in forced mode. Current tables are Unicode 17.0. This conservative gate is
required even though width policy itself is fixed; runtime Unicode properties
also affect scanner/formatter behavior.

Actual-addon subprocess tests exercise matching, mismatching and absent runtime
versions crossed with actual, mismatching and absent compiled metadata. They
compare exact outputs for width, tail, fit, wrap, chunk, scalar lookup, frame and
markdown. A matching runtime reaches actual Rust; every mismatch executes zero
native transformations. Disabling the runtime guard deliberately fails the
call-count assertion. Full-domain lookup freshness/exhaustive checks remain.

## 3. Real PTY streamed turns

The benchmark reuses the existing consumer-smoke `script(1)` PTY approach and
installed xterm emulator rather than adding node-pty or another dependency.
It opens two actual 80×24 controlling-terminal sessions, one explicit TS and one
opt-in `auto` (admitted Rust leaves only). Production dshline `StreamBuffer`,
renderer `Screen` and the composer frame consume a complete deterministic reply:
**65,536 UTF-16 units, 32 long logical lines, 512 deltas** of 128 units, live
redraws, scrollback commits, assembled-message reconciliation and final cleanup.

There is one warmup followed by five paired whole turns per workload, rotating
TS/Rust order without concurrent local builds/tests. Completion is timed from
sending terminal input until output crosses the PTY and drains into the emulator.
Every pair must have identical input, ordered terminal bytes, full emulator
scrollback/cursor and zero TS native calls; the Rust-enabled turn must actually
reach native leaves and must never call native JSON composites. Raw records
include first-byte latency, inner rendering time, PTY-drained latency, complete
emulator-drained latency, throughput and per-operation native call counts.

These are real PTY **presentation-turn** budgets, not in-memory microbenchmarks,
physical display paint, Harness session startup or provider/model response time.
No credential or network/model call is needed or included. The emulator and
terminal transport can dominate the user-visible budget; kernel gains must not
be reported as whole-model-turn gains.

## Reproduction

Build the current source and required addon, and separately build reviewed
baseline `5e48b70` and pre-guard candidate `af3459e` with the same toolchain:

```sh
pnpm build
node tools/build-renderer-native.mjs --required
node tools/renderer-upgrade-bench.mjs --baseline-root /path/to/5e48b70 --previous-root /path/to/af3459e --output public.json
node tools/renderer-pty-bench.mjs --output pty.json
```

The public tool compares reviewed baseline, pre-guard, new automatic dispatch,
explicit TS and both direct addons in the same run, records native calls and
named guards, checks parity before timing, and verifies source/build/binary
identities again afterward. It retains the existing eight variants, calibrated
batches and three rotated passes. Medians are batch-average statistics, not
per-call tail latencies. The PTY tool requires a compatible runtime and actual
addon, and fails rather than recording fallback as Rust. `--smoke` exercises
the same PTY protocol on shorter turns, without making a full-budget claim.

Manual `ci.yml` dispatch runs the public and PTY measurements on both real Macs;
ordinary PR jobs continue to require native correctness on all six targets.
The previous scratch ThinLTO experiment is not rerun or adopted.

## Rejected controls and testbed checks

The first guard implementation introduced its own long-ASCII width regression
on M1: reviewed baseline 2.09 µs, pre-guard 1.94 µs, guarded 9.65 µs.
That build is rejected, not pooled with final results. A first-non-ASCII search
alone still added a full scan on Linux; the final guard checks the long sparse
suffix before considering a scan. Ordinary long ASCII therefore does not pay a
second JS text traversal. Initial raw measurements remain explicitly labeled
`*-initial.json`.

The first corrected Mac PTY attempts failed strict CJK output equality: M1
803,311 versus 803,309 bytes; Intel 803,310 versus 803,309 bytes. Those timings
are rejected. Diagnostic tooling now records the producing Screen-write identity
separately from the PTY transcript and preserves exact failing bytes/context.
It does not waive parity, retry through TS, or change production admission.
A deliberate auto-only `CORRUPT` write fails the PTY assertion; running the worker
without an actual PTY also fails. Native artifacts may upload only after their
parity gate passed, while failed performance evidence remains available.

The diagnostic M1 failure had identical producing-write SHA-256
`541b48eea21c0c6fb5788a3baece71a42c11976736fd2645f4d30d427556beda`
and identical emulator state in both modes. The first differing byte was at
90,047: one transcript contained an extra CR before an otherwise identical CRLF.
The complete streams become identical after removing CR, but **no such
normalization is used by the benchmark**. Since Screen already emits explicit
CRLF, the benchmark disables OPOST only on its private slave after entering raw
input mode. It then requires each received stream's exact count and hash to equal
its producing Screen writes, as well as matching the other backend. Failed raw
streams and context are retained in
[the rejected PTY evidence](../benchmarks/renderer-pty-darwin-arm64-rejected/evidence.json).
The production terminal configuration is not changed.

On Intel, the original nine-process Unicode test once took 5.855 seconds under a
single five-second Vitest budget. The nine combinations are now nine separately
reported tests, retaining the same five-second limit and all assertions rather
than widening a timeout or reducing coverage.

## Final evidence and medians

Measured source/tool commit: `2c74b500ca4d511ff620f311f558be75d6b322a7`.
Production renderer source last changed at `f5a2616`; later changes are testbed,
test-fixture setup, documentation and evidence only. Original provenance is
preserved, not relabeled as the final report commit. Each platform used Rust
1.99.0 / LLVM 23.1.1 for all three source checkouts and Node Unicode 17.0:
Linux Cortex-A76 / Node 24.18, M1 (Virtual) / Node 24.20, Intel i7-8700B /
Node 24.19. Do not compare hardware rankings across these environments.

All **41 originally flagged observations now execute zero native
transformations in auto**. That includes **20 M1 + 9 Intel ASCII-family
observations** and the 12 non-ASCII/tiny host observations already on TS.
The same-run pre-guard reproduction exceeded the reviewed baseline by >10% in
**5/20 M1 and 4/9 Intel ASCII-family cases**; the other original flags did not
repeat at that cutoff. They remain conservatively gated. This reproduces every
original input, not a claim that every original regression is stable.

### Every original ASCII-family observation

All values are **µs**, same run: reviewed native baseline → pre-guard candidate →
new guarded auto. The last column names the effective TS exclusion; the JSON
also records matching named guards when an existing threshold fires first.
`op/kind/units/columns` identifies the exact public workload. These rows are
**gated, not uniformly accelerated**—some deliberately pay a large TS cost.

| Platform | Workload | Reviewed | Before guard | After guard (TS) | TS exclusion |
| --- | --- | ---: | ---: | ---: | --- |
| darwin-arm64 | displayWidth/ascii/96/40 | 0.26 | 0.27 | 1.02 | ascii-short-width |
| darwin-arm64 | displayWidth/ansi/96/40 | 0.28 | 0.27 | 1.10 | ascii-short-width |
| darwin-arm64 | displayWidth/ansi/512/40 | 0.63 | 0.69 | 5.57 | ascii-short-width |
| darwin-arm64 | tailToWidth/ascii/2048/40 | 7.97 | 9.40 | 29.89 | ascii-tail |
| darwin-arm64 | tailToWidth/ansi/2048/40 | 7.01 | 7.55 | 26.10 | ascii-tail |
| darwin-arm64 | wrapToWidth/ascii/96/40 | 2.09 | 2.44 | 4.11 | ascii-wrap |
| darwin-arm64 | wrapToWidth/ascii/512/40 | 10.62 | 10.84 | 19.82 | ascii-wrap |
| darwin-arm64 | chunkToWidth/ascii/512/40 | 8.26 | 6.47 | 8.29 | existing narrow-row threshold |
| darwin-arm64 | chunkToWidth/ascii/2048/40 | 32.53 | 25.93 | 31.38 | existing narrow-row threshold |
| darwin-arm64 | chunkToWidth/ansi/24/40 | 0.55 | 0.55 | 0.51 | existing minimum length |
| darwin-arm64 | chunkToWidth/ansi/96/40 | 1.64 | 1.52 | 1.72 | existing minimum length |
| darwin-arm64 | chunkToWidth/ansi/2048/40 | 33.73 | 28.03 | 33.64 | existing narrow-row threshold |
| darwin-arm64 | wrapToWidth/narrow/512/32 | 11.73 | 13.79 | 20.91 | ascii-wrap |
| darwin-arm64 | wrapToWidth/narrow/512/256 | 5.55 | 5.85 | 18.97 | ascii-wrap |
| darwin-arm64 | chunkToWidth/narrow/512/8 | 9.82 | 7.59 | 9.71 | existing narrow-row threshold |
| darwin-arm64 | chunkToWidth/narrow/512/120 | 4.33 | 4.90 | 8.18 | ascii-chunk |
| darwin-arm64 | chunkToWidth/narrow/512/256 | 4.10 | 4.81 | 8.46 | ascii-chunk |
| darwin-arm64 | displayWidth/lateCjk/64/40 | 0.27 | 0.27 | 1.09 | ascii-dominant-width |
| darwin-arm64 | displayWidth/lateCjk/2048/40 | 1.84 | 1.92 | 27.90 | ascii-dominant-width |
| darwin-arm64 | frame/ansi/24/80 | 2.05 | 1.85 | 1.98 | existing TS host thresholds |
| darwin-x64 | displayWidth/ansi/24/40 | 0.64 | 0.47 | 0.69 | existing minimum length |
| darwin-x64 | tailToWidth/ascii/512/40 | 6.48 | 7.98 | 13.69 | ascii-tail |
| darwin-x64 | wrapToWidth/ascii/24/40 | 2.71 | 2.46 | 2.82 | existing minimum length |
| darwin-x64 | wrapToWidth/ascii/96/40 | 6.81 | 8.03 | 11.39 | ascii-wrap |
| darwin-x64 | wrapToWidth/ansi/2048/40 | 116.81 | 152.99 | 213.42 | ascii-wrap |
| darwin-x64 | chunkToWidth/ansi/96/40 | 7.51 | 3.57 | 6.65 | existing minimum length |
| darwin-x64 | wrapToWidth/narrow/512/32 | 36.74 | 43.27 | 43.85 | ascii-wrap |
| darwin-x64 | wrapToWidth/narrow/512/256 | 15.24 | 14.21 | 46.55 | ascii-wrap |
| darwin-x64 | displayWidth/lateCjk/512/40 | 1.10 | 1.08 | 12.68 | ascii-dominant-width |

### Long controls and retained lookup wins

2048-unit workloads, **µs**. Fits use 40 columns; Screen recipes remain synthetic
CPU controls, not the real PTY turn below. Every listed auto control reaches
native. Dense CJK lookup and fit gains remain on all three platforms.

| Platform | Workload | Reviewed | Before guard | Guarded auto | Reviewed speedup |
| --- | --- | ---: | ---: | ---: | ---: |
| linux-arm64 | displayWidth/ascii | 3.34 | 3.38 | 3.40 | 0.98× |
| linux-arm64 | displayWidth/cjk | 49.29 | 8.44 | 8.69 | 5.67× |
| linux-arm64 | fitToWidth/ascii | 4.69 | 2.00 | 2.00 | 2.35× |
| linux-arm64 | fitToWidth/cjk | 51.05 | 1.61 | 1.62 | 31.49× |
| linux-arm64 | screen/ascii | 718.59 | 231.19 | 230.33 | 3.12× |
| linux-arm64 | screen/cjk | 1209.10 | 303.27 | 291.03 | 4.15× |
| darwin-arm64 | displayWidth/ascii | 1.70 | 1.80 | 1.78 | 0.96× |
| darwin-arm64 | displayWidth/cjk | 23.94 | 4.66 | 4.95 | 4.84× |
| darwin-arm64 | fitToWidth/ascii | 2.21 | 0.76 | 0.79 | 2.79× |
| darwin-arm64 | fitToWidth/cjk | 22.96 | 0.60 | 0.61 | 37.64× |
| darwin-arm64 | screen/ascii | 287.62 | 104.44 | 114.22 | 2.52× |
| darwin-arm64 | screen/cjk | 586.10 | 148.03 | 138.93 | 4.22× |
| darwin-x64 | displayWidth/ascii | 2.47 | 2.94 | 2.32 | 1.06× |
| darwin-x64 | displayWidth/cjk | 40.21 | 14.82 | 14.26 | 2.82× |
| darwin-x64 | fitToWidth/ascii | 5.11 | 3.19 | 3.65 | 1.40× |
| darwin-x64 | fitToWidth/cjk | 35.67 | 2.32 | 2.28 | 15.67× |
| darwin-x64 | screen/ascii | 636.92 | 321.62 | 327.12 | 1.95× |
| darwin-x64 | screen/cjk | 1342.77 | 552.17 | 615.84 | 2.18× |

Intel shows substantial pass drift. For example, the CJK Screen pre-guard
pass medians were 641.5/417.4/552.2 µs and guarded medians 637.5/376.2/615.8 µs:
the ratio of aggregate medians is 11.5% slower than pre-guard, but two of three
paired passes improve (median paired ratio 0.994). This is not evidence of a
stable kernel regression; neither is it a uniform no-regression guarantee.
The reviewed-baseline CJK Screen gain remains 2.18×. No significance claim is
made. All current >10% slower public cases, including new TS fallback costs,
remain enumerated in the summary (30/120 observations on each platform).

### Whole-turn terminal budget

Each entry is **TS → opt-in admitted Rust**. Latencies are **ms**; throughput is
**thousands of input UTF-16 units/s**. Each full turn is 65,536 units and includes
the terminal input/PTY transport/production streaming path. The visible proxy
also drains the headless emulator, not a physical display. All **60 measured
turns**, plus warmups, pass exact producing-write, received-byte and emulator
state equality. No native composite/markdown operation is used.

| Platform | Workload | PTY-drained ms | Emulator-drained ms | k units/s |
| --- | --- | ---: | ---: | ---: |
| linux-arm64 | ascii | 129.0 → 118.8 | 537.3 → 550.1 | 122.0 → 119.1 |
| linux-arm64 | cjk | 185.2 → 126.4 | 540.7 → 524.0 | 121.2 → 125.1 |
| darwin-arm64 | ascii | 91.8 → 74.0 | 762.2 → 798.0 | 86.0 → 82.1 |
| darwin-arm64 | cjk | 103.1 → 91.0 | 1489.9 → 1374.7 | 44.0 → 47.7 |
| darwin-x64 | ascii | 123.9 → 111.8 | 735.6 → 717.9 | 89.1 → 91.3 |
| darwin-x64 | cjk | 241.5 → 228.9 | 1367.2 → 1342.3 | 47.9 → 48.8 |

The emulator/transport budget dominates. CJK full-turn completion improves about
2–8%, not the kernel's multi-fold speedup. ASCII is about 2–5% slower on Linux/M1
and about 2% faster on Intel. The inner renderer and PTY-drained samples are kept
separate; they cannot stand in for user-visible completion. These results are
why TS stays default and the leaf path remains explicit and conservative.

### Checks and raw records

- **43 focused tests pass**, including all nine independently reported runtime/
  compiled Unicode combinations, the 29-observation routing check, exact API,
  emulator and actual-addon checks. The historical callback-frame test uses
  the real array/options/border-callback shape, as the benchmark does.
- Latest full local production-source run: **5,584 pass / 26 skip**, with the
  same **three baseline launcher-pnpm prerequisite failures**. The later test
  split adds eight independently reported cases without reducing coverage;
  focused checks pass after that test-only change. An earlier clock-bound
  activity-word assertion passed its focused recheck and the full rerun.
- Build, typecheck, security/workflow checks, generated-table regeneration and
  Rust exhaustive width plus 12 semantic tests pass. All 86 golden inputs and
  outputs remain unchanged. Guard-removal, Unicode-mismatch and terminal-byte
  corruption controls fail their named assertions.
- [Full measured-source CI, including both Mac public and PTY runs](https://github.com/riesbri/dshline/actions/runs/38922097262)
  is the source-validation record. Final report-head status is recorded on
  [draft PR 302](https://github.com/riesbri/dshline/pull/302).
- Public raw data: [Linux](../benchmarks/renderer-guard-linux-arm64.json),
  [M1](../benchmarks/renderer-guard-darwin-arm64.json),
  [Intel](../benchmarks/renderer-guard-darwin-x64.json).
- Full PTY records: [Linux](../benchmarks/renderer-pty-linux-arm64.json),
  [M1](../benchmarks/renderer-pty-darwin-arm64.json),
  [Intel](../benchmarks/renderer-pty-darwin-x64.json).
- [Machine-readable summary](../benchmarks/renderer-guard-summary.json) retains
  all 41 original observations, all current >10% public regressions, routes,
  environment/source/build/addon identities, selected controls and PTY budgets.
  Initial guard measurements and rejected CR diagnostics remain separately
  labeled. Old non-byte-preserving PTY timings are superseded, not pooled.

This is self-reviewed, not independent review. The branch stays stacked on
untouched #300 (`5e48b70`), draft and unmerged. No release, profile installation,
model change, target-CPU/panic-policy change or ThinLTO adoption.

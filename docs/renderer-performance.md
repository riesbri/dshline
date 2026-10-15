# Rust renderer performance investigation

English | [中文](renderer-performance.zh.md)

## What was wrong

The first release addon was not faster merely because it was Rust. Width
measurement allocated a vector and UTF-16 buffer per character. Most other
operations additionally built numeric arrays in JavaScript, serialized JSON,
parsed and cloned a serde value, then serialized and decoded the result. Native
streaming also rendered each committed line fully in both languages. Palette
snapshots were copied even in forced TypeScript mode.

## Approaches compared

| Approach | Finding | Decision |
| --- | --- | --- |
| Original JSON-per-call backend | Large boundary overhead; picker tests timed out | Keep only for verification and forced composite operations |
| Borrowed token spans and allocation-free width | Removes per-character ownership/allocation; prefix scans stop early | Adopt |
| Direct UTF-16 napi methods | Avoids numeric-array and JSON conversions; preserves lone surrogates | Adopt for supported bounded transforms |
| All-native auto selection | Tiny lookups, prefix cuts and narrow row arrays can be slower | Reject blanket selection |
| Hybrid auto selector | Cheap size/budget checks select measured wins | Adopt conservative thresholds |
| Cached palette snapshot | Caller-owned SGR arrays may change after installation | Reject stale caching; create snapshots lazily |
| Full TypeScript streaming shadow | Duplicates successful native rendering | Replace with lazy restoration from explicit fence state |

## Historical optimization measurements

Measurements use release builds on Linux arm64, Raspberry Pi 5/Cortex-A76,
Node 24.18.0, Unicode 17.0. They are CPU-sensitive local microbenchmarks, not
cross-platform guarantees or proof that a whole model turn becomes faster.
The original direct addon and compiled TS were frozen before optimization.

Representative raw direct comparisons from the independent investigation:

| Workload | Reference TS (µs) | Optimized direct Rust (µs) |
| --- | ---: | ---: |
| Width, ASCII 2048 units | 26.43 | 3.13 |
| Width, CJK 2048 units | 187.93 | 49.02 |
| Tail, ASCII 2048 units / 40 columns | 75.56 | 16.52 |
| Wrap, ASCII 2048 units / 40 columns | 244.13 | 86.33 |
| Prefix truncate, ASCII 2048 / 40 columns | 0.76 | 1.55 |
| Strip ANSI, plain ASCII 2048 | 1.39 | 8.46 |

The last two rows are intentionally included: forced Rust is not universally
faster. Narrow chunking at one column was up to seven times slower through napi
because it creates many JavaScript strings. Auto keeps those paths in TS.

The checked-in [public-path measurement artifact](../benchmarks/renderer-arm64-2026-10-15.json)
compares the original public auto backend, optimized public auto, explicit TS,
direct Rust and the independent TS implementation. Eight varying inputs per main transform corpus
case (narrow-width and streaming probes repeat one input) prevent a one-key cache from masquerading as a general improvement. Exact
outputs are asserted before timing. Missing native code is a hard error.
The environment includes current native and source digests. The historical
baseline records its addon digest but does not independently verify the old TS
source/build provenance; retain this comparison as an exploratory historical
experiment, not final exact-source readiness evidence. Previous baseline snapshots
must contain matching compiled `lib/` and `native/` files.

Public-path comparison (ASCII inputs; streaming uses styled bilingual prose):

| Operation / UTF-16 units | Original auto (µs) | Optimized auto (µs) |
| --- | ---: | ---: |
| displayWidth / 2048 | 28.35 | 3.21 |
| tailToWidth / 2048 | 111.30 | 18.75 |
| wrapToWidth / 192 | 101.16 | 9.02 |
| stream.line / 104 | 128.30 | 10.05 |
| stream.partial / 104 | 108.50 | 10.43 |

## Current auto policy

| Operation | Native subset |
| --- | --- |
| Display width, tail, fit | Text 64–2048 units; fit/tail column budgets within ±256 |
| Wrap | Text 64–2048 units, 32–256 columns |
| Chunk | Text 512–2048 units, 64–256 columns |
| Code-point width, prefix truncate, strip, escape, sanitize | TypeScript |
| Composite boxes/frames/SGR and Markdown | TypeScript; JSON Rust remains explicitly forceable within admission |

A short-circuit to TypeScript occurs before reading unsupported host objects or
calling native code. Once admitted native work fails, it is not retried through
an unbounded fallback. Required-rust mode forces admitted pure work, not host-only
callbacks or public values outside the bounded native subset; those select TS
before admission. Broader native use needs new boundary measurements, not
an assumption that a faster isolated kernel wins end to end. Screen, terminal
writes, composer, keyboard and Harness integration stay TypeScript.

## Reproduce and verify

Build the addon in release mode and compile TS before measuring. The migration
notes describe the currently separate native artifact; the Phase 5 optional contributor
build script is documented in CONTRIBUTING. These measurements alone do not
establish cross-platform packaging readiness.
Do not run CPU benchmarks alongside a full test suite.

```sh
pnpm build
node tools/build-renderer-native.mjs --required
node tools/renderer-bench.mjs --output /tmp/renderer-bench.json
node tools/renderer-bench.mjs --baseline /path/to/previous-renderer-package --output /tmp/renderer-compare.json
node tools/renderer-soak.mjs 10000
```

Each benchmark uses warmup, calibrated batches, then the median and maximum of
five batch averages. The `maxBatchMeanNsPerCall` field is the maximum of five averages,
not a measured individual-call p95 latency. No timing assertions gate correctness.
The direct-addon soak requires clean exact-commit addon provenance, is seeded,
and reports observed width/UTF-16 length coverage and exact comparison counts.
It binds TS source/build/compiler, native inputs, original binary proof and tool
hashes, rejecting identities that change during execution. It does not claim coverage instrumentation, sanitizers, production
traffic or an indefinitely long memory-leak test.

Verification for this optimization includes all 86 native goldens, 90,000 seeded
direct transformation comparisons, the independent exhaustive check of all
1,114,112 Unicode code-point widths, plus independent malformed-string and
state-transition probes. Full-suite results: 5560 passed, 26 skipped, three
pre-existing host-dependent launcher prerequisite failures. The earlier native
picker timeouts disappeared without adjusting test limits. This is not a claim
that every CI platform is green; six-platform builds remain independently gated.

## Final source-bound evidence (2026-10-16)

The [fresh 230-case benchmark](../benchmarks/renderer-final-arm64-2026-10-16.json)
uses the clean hosted Linux ARM64 release addon and verified current compiled TS,
without the historical baseline. Its source/build identity matches the branch;
[distribution evidence](../benchmarks/renderer-final-evidence-2026-10-16.json)
retains CI's actual merge commit `82d25b11` and verifies its tree equals head
`740e406`, without rewriting artifact provenance. The six-platform archive,
generated declarations, license notices and all archived binary hashes validate.

| Operation / UTF-16 units | Current TS comparison (µs) | Auto (µs) |
| --- | ---: | ---: |
| displayWidth / 2048 | 26.85 | 3.19 |
| tailToWidth / 2048 | 66.84 | 17.41 |
| wrapToWidth / 192 | 18.88 | 8.68 |
| stream.line / 104 | 10.74 | 9.70 |
| stream.partial / 104 | 9.78 | 10.15 |

The first three compare public explicit-TS against public auto; streaming compares
the standalone TS renderer against public auto. These are independent batch
medians, not precise universal speed ratios. Streaming remains TS in auto; the
slightly slower partial row is retained to avoid a blanket speedup claim. Across
this run, no native-selected auto case regressed against public TS; tiny TS-only
wrappers still show measurement/dispatch overhead. Only this Linux ARM64 host
was benchmarked; six-platform correctness does not imply equal performance.

The [corrected final soak](../benchmarks/renderer-final-soak-arm64-2026-10-16.json)
passes 2701224 actual-addon comparisons: 300000 random plus 136 explicit boundary
cases, nine transforms each. Every budget (-256, -1, 0, 1, 8, 40, 120, 256) has
37517 cases. All eight budgets cross 17 exact UTF-16 boundary sizes through 2048,
including both sides of dispatch thresholds. Regression tests independently
anchor required sizes and reject collapsed-budget and missing-2048 mutations.
The old generator's low-bit correlation selected width 1 almost exclusively;
earlier 90000/900000 counts are historical comparisons, not balanced coverage.
The corrected run reports and rechecks source/build/native/tool identities.

Hosted Core passes at `740e406`: Node 24/26 each 5575 passed, 26 skipped;
Node 22.19 has 5573 passed, 28 skipped. Required actual-addon parity also passes
on all six OS/architecture targets. Harness source, packed consumer, Windows
launcher, tmux, docs and security pass. Two new generator regression tests pass
locally and will run with the final tooling commit's CI. Final review does not
authorize merge or release; latest-head PR checks remain authoritative. No model
turn, private profile, cross-platform timing, instrumented fuzzing, per-call tail
latency or memory-leak certification is claimed.

# Native-leaf lookup implementation

English | [中文](renderer-leaf-performance.zh.md)

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
but regressed fit, so it was not retained. Final repeated measurements must
evaluate this control on each measured platform; original results stay labeled
initial rather than being silently overwritten.

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
execution; admitted native errors propagate without TS retry. Explicit TS mode
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

## Measurement

`tools/renderer-upgrade-bench.mjs` requires a separately built exact baseline
checkout, verifies both emitted TS graphs and addon source/binary provenance,
counts native host calls, then compares public auto, direct Rust and explicit TS.
It retains eight varying inputs per workload, three rotated passes and five
calibrated batch averages per pass. It rechecks source/native identities after
timing. Host recipes use an in-memory sink: they are synthetic CPU measurements,
not PTY, terminal-I/O, live-session, per-call tail-latency or whole-turn claims.

## macOS investigation

Both Apple Silicon and Intel hosted runners build the exact baseline with the
same Rust/Node toolchains, then run this public/host comparison. A separate
scratch-only ThinLTO/one-codegen-unit build retains panic unwinding and the
portable target CPU default. It passes exhaustive widths and additional bounded
transform parity before timing. Its functions are temporarily selected only in
the benchmark process; no tuned binary replaces a packaged addon. Raw results
are uploaded as `renderer-upgrade-darwin-arm64` and `renderer-upgrade-darwin-x64`.
These measurements are pending until the corresponding run finishes.

The [Rust Apple target](https://doc.rust-lang.org/rustc/platform-support/apple-darwin.html)
and [compiler options](https://doc.rust-lang.org/rustc/codegen-options/index.html#target-cpu)
remain the portability boundary. Do not distribute build-host-specific CPU
instructions or raise the macOS deployment floor to chase a local result.
Apple's [Instruments guidance](https://developer.apple.com/videos/play/wwdc2025/308/)
is a useful next profiling step on a real Mac; a faster Linux ARM64 result is not
evidence of an Apple Silicon or Intel macOS gain.

## Review status

Implementation and local behavioral checks are under self-review. Exact-head
hosted correctness, macOS timing and final results remain pending. No merge,
release, model turn, user-profile or service-policy change is authorized here.

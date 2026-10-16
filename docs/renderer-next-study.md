# Further Rust performance study

English | [中文](renderer-next-study.zh.md)

## Verdict

**PARTIAL: promising measured prototypes, not a production change.** The best
next direction is a compact Unicode lookup and narrow native-leaf integration
below the existing TypeScript hosts. Investigate ASCII wrapping separately until
its collateral regressions are resolved. Keep terminal and Harness ownership
unchanged. The existing renderer PR is neither modified nor replaced by this
investigation.

## Method and evidence

The [runnable study](../spikes/001-rust-performance/README.md) starts from the
reviewed renderer source at `5e48b70`. It copies crates and compiled modules to
scratch; production package source, configuration, profile and dependencies
remain untouched. Rust 1.99.0, Node 24.18.0 and Linux ARM64/Cortex-A76 are the
only measured environment. Local locked/offline builds are not hosted release
artifacts, and this report does not extend six-platform correctness approval to
the prototypes.

[Initial timings](../spikes/001-rust-performance/results/phase1-bench.json)
compare five builds over 135 workloads and three rotated passes. Every workload
uses eight varying inputs and exact TS comparisons before timing. Each pass
retains five calibrated batch averages. Ratios are local CPU measurements, not
whole-turn speedups or individual-call latency percentiles.

The [reduced-candidate rerun](../spikes/001-rust-performance/results/bench.json)
again measures 135 workloads over three passes, comparing baseline, lookup-only,
the lookup/ASCII-wrap candidate and standalone TS. Representative 2048-unit
results, in microseconds (median of the three pass medians):

| Direct addon operation | Current Rust | Lookup only | Combined candidate |
| --- | ---: | ---: | ---: |
| Width / CJK | 49.08 | 6.78 | 6.78 |
| Width / emoji | 25.62 | 5.27 | 5.28 |
| Tail / CJK / 40 columns | 61.45 | 17.60 | 17.80 |
| Fit / CJK / 40 columns | 51.02 | 7.75 | 7.72 |
| Wrap / ASCII / 40 columns | 89.65 | 90.39 | 46.49 |
| Width / ASCII | 3.15 | 3.21 | 3.95 |
| Fit / ASCII / 40 columns | 4.37 | 4.50 | 5.24 |

The last two rows matter: the reduced bundle still regresses some ASCII paths
by 10–25%, consistently across the three passes. Its performance is therefore
**not production-ready**. The cause of these collateral regressions is not
established by this study; do not explain them away as noise or silently omit
them. Prefer the lookup-only step first; isolate and resolve collateral effects
before combining changes.

## What survived investigation

| Alternative | Finding | Decision |
| --- | --- | --- |
| Deduplicated Unicode pages | Two indexed reads replace range searches; identical project widths for all code points | Advance |
| Printable-ASCII source-span wrapping | Faster wrapping, but the reduced bundle regresses other ASCII operations | Investigate separately behind its strict guard |
| General source-span wrapping | Dropped zero-width tokens beside skipped spaces in the first prototype | Reject; retain original Unicode/ANSI kernel |
| Two-pass allocation-light tail | Regressed long CJK tails from about 61 to 108 µs without the lookup; also lost against lookup-only tails | Reject |
| ThinLTO plus one codegen unit | Smaller combined binary, mixed timings including slower wrapping | Do not enable as a blanket speed policy |
| Native leaf integration | Reaches TS-owned frame/Screen work without moving ownership | Advance as a separate implementation |

The lookup has 4352 two-byte page indexes and 108 unique 256-byte pages:
**36352 bytes** of table data. It derives only from the repository's existing
Unicode policy. This does not mean the binary grows by exactly that amount;
section layout and alignment also matter. Width still sums code points, keeps
lone surrogate units, ignores recognized ANSI and gives controls their original
width. No grapheme-policy replacement, normalization, cache or new dependency is
introduced.

The surviving wrapper admits only printable ASCII and newlines. All other text
preselects the original pure Rust kernel. The rejected broad prototype failed at
seed `2810499053`, budget `-256`; the study retains this regression probe.
Allocation reduction alone is not a performance guarantee: the rejected tail
needs an extra full scan, which outweighed its saved token vector.

## The important integration finding

The public backend exports are not the same as internal dispatch. `screen.ts`
and `box.ts` import `width.ts` directly; auto callback frames and ordinary Screen
work therefore bypass the native width/wrap selector. The observed original
trace has one native call for public wrapping and zero for the callback frame or
Screen recipe. Faster kernels cannot accelerate call sites that never use them.

The scratch experiment replaces only bounded width/wrap leaf functions in a
copied module graph. Original TypeScript still evaluates border callbacks, owns
Screen state, commits scrollback and orders every write. Tests compare exact
write arrays, including cursor, stale redraw, shrink and changed terminal width.
Synthetic host measurements show a meaningful benefit even with the existing
addon; they do not prove a live-session or PTY performance claim.

The [host rerun](../spikes/001-rust-performance/results/host.json) includes 18
synthetic cases, three rotated passes and exact-write comparisons. Representative
2048-unit results, in microseconds:

| TS-owned workload | Current auto | Leaf routing, current addon | Leaf routing, candidate |
| --- | ---: | ---: | ---: |
| Callback frame / ASCII | 259.66 | 88.57 | 63.26 |
| Screen recipe / ASCII | 470.36 | 156.82 | 94.97 |
| Callback frame / CJK | 576.91 | 336.89 | 285.18 |
| Screen recipe / CJK | 758.37 | 301.69 | 201.20 |
| Screen recipe / ANSI | 390.05 | 125.59 | 127.33 |

Routing alone already improves these workloads. The ANSI row also shows that
the candidate is not always faster than routing the current addon. These are
bounded synthetic CPU recipes with an in-memory sink, not terminal-I/O timings.

The [checks](../spikes/001-rust-performance/results/checks.json) cover six builds:
6684672 exhaustive code-point comparisons, 1675848 direct exact transform
comparisons, 516 golden replays, resource-limit rejection and separate balanced
ASCII coverage. [Mutation checks](../spikes/001-rust-performance/results/mutations.json)
reject both an incorrect CJK width and removal of the ASCII wrapper guard.

A production implementation should introduce a cycle-free primitive-selection
seam, not import `backend.ts` into modules it already imports. Reuse the current
guarded optional loader, explicit modes, length/column limits and native output
validation. Missing/unsupported input must select TS before execution; admitted
native errors must still propagate without a TS retry. Keep callback/proxy/getter
handling, palette observation and streaming-document ownership unchanged.

## Existing alternatives and deferred work

The existing napi-rs binding remains adequate. Node-API string extraction copies
UTF-16 into a caller buffer; [its contract](https://nodejs.org/api/n-api.html#napi_get_value_string_utf16)
does not justify treating arbitrary JavaScript string storage as a borrowed Rust
slice. Avoid raw V8 access or a new unsafe zero-copy path merely to save a small
bounded copy.

[unicode-width](https://docs.rs/unicode-width/latest/unicode_width/) includes
string/sequence width behavior that is not this project's code-point-sum
contract. [memchr](https://docs.rs/memchr/latest/memchr/) searches byte slices;
it is not a drop-in UTF-16 width scanner. Neither replaces the current policy.
Handwritten SIMD and PGO remain unvalidated follow-ups, not promised gains.
Portable compiler vectorization can be measured before adding platform-specific
unsafe intrinsics.

[Cargo profiles](https://doc.rust-lang.org/cargo/reference/profiles.html)
make LTO/codegen-unit trade-offs measurable. Retain `panic = "unwind"`: abort
would terminate the embedding Harness process instead of letting the existing
panic guard return an error. Do not distribute `target-cpu=native` builds as
portable prebuilds; [rustc](https://doc.rust-lang.org/rustc/codegen-options/index.html#target-cpu)
defines that setting in terms of the build host CPU.

## Recommended production sequence

1. Implement the derived lookup with deterministic freshness checks, exhaustive
   width parity and the existing six-platform native gates.
2. Add a cycle-free native-leaf selector to selected TS hosts. Verify real
   emulator cells, cursor/BCE, callback observation and no-op redraws as well as
   exact writes. Repeat synthetic and PTY measurements before changing rollout.
3. Investigate the guarded ASCII wrapper separately and resolve collateral
   regressions before adopting it; retain dedicated ASCII, malformed-input and
   zero-width/skipped-space regression coverage.
4. Keep tiny calls and narrow arrays in TS unless new whole-boundary measurements
   justify selection. Defer batching/direct composite ABIs until profiling shows
   boundary cost is still material; never pass Harness/domain objects to Rust.

No merge, release, live model turn, profile mutation, terminal-state migration,
sanitizer/coverage-instrumented fuzzing or leak certification is part of this
study. It is self-reviewed; no independent reviewer or subagent was used.

# Bounded ASCII guard probes

English | [中文](renderer-guard-fix.zh.md)

Follow-up to [guard review finding 1](renderer-guard-review.md), implemented in
guard probe commit `4ba66c1` and allocation-only leaf commit `79948df` on draft
[PR #302](https://github.com/riesbri/dshline/pull/302). This fixes guard cost,
not admission policy: **TS remains default; all five exclusions, old thresholds,
bounds, Unicode checks, fallback and compiler policy are unchanged.** Rust stays
an explicitly opted-in, admitted pure leaf. No merge/release/profile installation.

## What changed, and why decisions cannot change

- ASCII membership uses `/[^\x00-\x7f]/` **without `u`**. `search` still returns
  the first non-ASCII UTF-16 offset; `test` still reports whether any non-ASCII
  unit exists. No code point can be non-ASCII while all its units are ASCII, and
  a paired or lone surrogate has non-ASCII units in either regex mode.
- The existing explicit high/low-surrogate check still consumes exactly the
  first code point. A suffix-edge non-ASCII unit at or after that point's end
  necessarily belongs to another point, so width can return undefined immediately,
  exactly as the old suffix test would. It does not count the first pair twice.
- The all-ASCII predicate rejects a non-ASCII first/last unit immediately;
  empty text still counts as ASCII. Otherwise the same membership test runs.
- The old long-width two-ASCII-ending-unit shortcut remains. Nothing changed
  in dispatch selection, `AUTO_MIN_UNITS`, narrow-row rules,2048-unit/±256 bounds,
  defaults, Unicode-version negotiation, admitted-error handling or Rust width/
  scanning policy. The additional chunk allocation change is explained below.

The four defect inputs now perform **zero suffix slices and zero regex tests**;
only the two width calls search, each finding its first CJK at offset1. Width
needs at most four individual code-unit probes, tail/chunk two. General ASCII
classification may still require an unavoidable linear scan, but dispatched
inputs are bounded to2048 units and the scan is no longer Unicode-mode matching.
This is not a claim of O(1) classification for every possible string.

| Platform | Actual CPU | Node |
| --- | --- | --- |
| Linux ARM64 | Cortex-A76 | v24.18.0 |
| M1 | Apple M1 (Virtual) | v24.20.0 |
| Intel x64 | Intel(R) Core(TM) i7-8700B CPU @ 3.20GHz | v24.19.0 |

## Decision equivalence and fault detection

The frozen oracle comes from `25a2501`. The audit freshly compiles that actual
immutable tree and checks its guard function against the frozen test oracle;
the compiled before identity also matches the original review's retained identity.

**16,796,982 identical decisions per machine; zero mismatches:**

- All1,114,112 code-point/surrogate values, including all valid supplementary
  pairs and all2048 isolated surrogate units, in three contexts across five
  operations: **16,711,680** comparisons.
- **677** positional UTF-16/ANSI/control strings ×14 column budgets ×9 operations:
  **85,302** comparisons. Lengths0/1/2/3/63/64/65/511/512/513/2047/2048/2049;
  budgets−257/−256/−1/0/1/31/32/33/63/64/65/255/256/257. Raw predicate testing
  includes values outside dispatch admission to prove those decisions also match.

All three machines independently pass the unmodified historical routing test,
then **each of the five individual guard removals fails** through the forbidden
native transformation:15 rejected guard mutants, not one combined removal.
On Linux, the new tests also reject restored Unicode regex mode, broken surrogate-pair length,
and deletion of the suffix-edge short-circuit. The structural no-suffix-scan test
fails even when a lost shortcut would still produce the correct guard decision.

The public API/declarations/schema are unchanged. All86 golden requests/outputs
and non-reference metadata are unchanged; only
source/build identity metadata was refreshed. The new frozen test module is
included in both native-input hashing and the builder's dirty-input inspection.
The new Rust row-capacity test also covers style replay, combining marks, lone
surrogates, empty rows and huge direct-library budgets; removing style replay
fails that named test. Width lookup and all13 Rust semantic tests pass.

## Controlled before / fixed / no-guards / TS timing

All numbers below are µs/call: median of eleven pass medians, each from
five interleaved batch means,500 warmups and eight varying flattened inputs.
Calibration uses the median of three batches to target≥10ms, capped at4194304
calls. Variant order rotates after every batch, not only between whole passes.
All26 sparse/dense/ASCII workloads are retained. These are boundary CPU timings,
not individual-call tail percentiles or end-to-end latency claims.

“Before” is the freshly compiled **actual25a2501** renderer, not the earlier
5e48 baseline or a rewritten reference. Fixed and benchmark-only no-guards share
the current addon; explicit TS never transforms through it. **Before builds the actual
original25a2501 addon with its own clean source-input proof**. Both use the same
pinned compiler policy. No-guards removes only the regression-guard function, retaining
bounds/minima/version checks. Every defect case stays admitted: eight actual
native calls per eight inputs in before/fixed/no-guards, zero in explicit TS.
Width2048/512 is `'a中' + 'a'.repeat(n - 3) + '中'`; tail/chunk use
`'a'.repeat(2047) + '中'` at80 columns (the corpus varies the first ASCII unit).

| Platform / defect | Before guarded | Fixed guarded | No guards | Explicit TS |
| --- | ---: | ---: | ---: | ---: |
| Linux ARM64 / width2048 | 21.456 | 3.408 | 3.185 | 14.770 |
| Linux ARM64 / width512 | 5.753 | 1.237 | 1.048 | 3.835 |
| Linux ARM64 / tail2048/80 | 35.628 | 19.124 | 19.067 | 62.465 |
| Linux ARM64 / chunk2048/80 | 66.469 | 36.266 | 36.221 | 57.508 |
| M1 / width2048 | 10.405 | 1.813 | 1.705 | 6.191 |
| M1 / width512 | 2.507 | 0.543 | 0.473 | 1.393 |
| M1 / tail2048/80 | 15.804 | 7.775 | 7.862 | 21.920 |
| M1 / chunk2048/80 | 26.376 | 13.884 | 13.867 | 20.646 |
| Intel x64 / width2048 | 14.596 | 1.733 | 1.593 | 12.440 |
| Intel x64 / width512 | 3.980 | 0.795 | 0.683 | 3.276 |
| Intel x64 / tail2048/80 | 30.077 | 19.095 | 18.935 | 36.998 |
| Intel x64 / chunk2048/80 | 67.622 | 43.104 | 43.447 | 43.155 |

**All12 cells pass: fixed guarded≤TS, with unchanged native admission.**
Intel chunk is **effectively tied**:43.104 versus43.155µs (about0.12%). This is an
observed median-budget pass, **not a statistically established win or SLO**.

### Guard probe cost and scan bound

| Platform | Width2048 probe, before→fixed | Width512 probe | Tail probe | Chunk probe |
| --- | ---: | ---: | ---: | ---: |
| Linux ARM64 | 18.160→0.174 | 4.649→0.150 | 18.084→0.040 | 18.049→0.033 |
| M1 | 8.621→0.087 | 1.982→0.067 | 7.974→0.016 | 7.770→0.010 |
| Intel x64 | 12.866→0.116 | 3.331→0.101 | 13.590→0.027 | 12.826→0.021 |

For the two distant-CJK width lengths, fixed probe cost stays close rather than
scaling with the long suffix. Tail/chunk read the two edges, not the intervening
2046 units. Structural assertions, not timing alone, establish zero suffix
slice/test calls. Small guarded/no-guard differences can be calibration/CPU
drift; no negative-overhead or statistical-significance claim is made.

### ASCII and dense controls

| Control | Linux before→fixed | M1 before→fixed | Intel before→fixed |
| --- | ---: | ---: | ---: |
| ASCII width2048 | 3.202→3.262 | 1.789→1.794 | 1.611→1.654 |
| CJK width2048 | 8.450→8.464 | 4.697→4.875 | 6.541→7.610 |
| CJK width512 | 2.479→2.490 | 1.421→1.437 | 2.006→2.295 |
| CJK tail2048/80 | 19.257→19.781 | 8.827→8.851 | 15.625→18.810 |
| CJK chunk2048/80 | 60.414→45.402 | 23.453→16.790 | 67.624→50.149 |
| ASCII wrap2048/80 | 62.285→62.128 | 27.567→27.336 | 61.776→65.419 |
| CJK wrap2048/80 | 84.731→86.874 | 36.171→36.156 | 88.974→91.979 |
| ASCII fit2048/80 | 2.565→2.569 | 1.029→1.028 | 2.590→2.670 |

Retained >10% slower non-defect controls (all26 cases inspected, not just the table):

| Platform / case | Before | Fixed | Ratio-of-medians change | Median paired change |
| --- | ---: | ---: | ---: | ---: |
| Intel x64 / width-dense-cjk | 6.541 | 7.610 | 16.346% | 16.519% |
| Intel x64 / width-short-dense-cjk | 2.006 | 2.295 | 14.370% | 14.036% |
| Intel x64 / tail-below-guard | 5.349 | 6.119 | 14.397% | 14.676% |
| Intel x64 / tail-dense-cjk | 15.625 | 18.810 | 20.390% | 20.403% |

These observations are not removed or relabeled as passes. Rotated-pass samples show substantial drift, but do not establish its cause. No across-the-board speedup or zero-regression claim is made.
The Intel dense-width/tail controls above are about14–20% slower against25a2501;
they remain explicit review caveats, not dismissed as proven noise. The separate
same-run original reviewed5e48 comparison still retains CJK width **4.83× M1 /
3.12× Intel**, and fit **37.41× /16.69×**, with actual Rust calls and exhaustive
release-addon code-point parity. Both public archives are retained as
`renderer-guard-fix-public-{darwin-arm64,darwin-x64}.json`.

All26 cases retain identical guard labels and transformation counts versus
before. Conservative gates still reject native-winning inputs; the zero-budget
admission limitation from review finding3 also remains. Neither was hidden by
new thresholds or additional TS gates.

### Retained initial failure and declared repeat

The initial five-pass runs are retained under `*-initial.json`, including the
[initial summary](../benchmarks/renderer-guard-fix-summary-initial.json), whose
acceptance is **false (11/12)**. Intel chunk was72.687µs guarded /68.806 no-guards /
62.012TS. Its five guarded samples were53.841/72.687/329.546/59.279/103.168µs;
TS was62.012/78.034/45.298/61.672/150.482µs. Four paired passes won, but the
reported median did not. We did **not** switch to paired ratios to label it a pass.
Three >10% slower M1 ASCII controls and all other initial samples remain too.

Before repeating, commitad4a81f declared batch-level interleaving, eleven passes,
longer calibration and repetition of **all three machines/all26 workloads**,
without filtering samples or changing the acceptance metric. Guard-only production
source remained exactly4ba66c1: no Rust/kernel/admission/threshold/compiler change
was made to obtain that repeat. This addresses measurement drift; it does not make
the initial losing observation disappear or establish a universal latency SLO.

That repeat also failed **11/12**: Intel chunk was **74.685 guarded /69.785
no-guards /62.793TS µs**, although its predicate was only **0.030µs**. Its
[entire matrix](../benchmarks/renderer-guard-fix-summary-guard-only.json) and all
raw records remain. The guard scan was gone, but existing chunk allocation still
missed the requested Intel budget; we did not repeat again merely to seek a pass.

### Allocation-only existing-leaf correction

Commit79948df reserves each chunk row from `min(paragraph UTF-16 length,
existing clamped budget)` rather than repeatedly growing from zero after every
break. Existing open-style bytes add to the next row's capacity hint and are
copied exactly as before. Rows can still grow for zero-width text/style replay;
huge direct-library budgets never reserve beyond input just because the budget
is huge. This changes allocations only: scanner, widths, line breaks, reset
policy, bounds, all five guards and admission are untouched.

The final experiment keeps the **same eleven-pass interleaved protocol and
acceptance metric**, now with this explicit capacity correction. It freshly
builds the original25a2501 Rust/TS tree in an owned detached worktree, rather than
silently substituting the optimized kernel into the before graph. Current
guarded/no-guards share current bytes; before has a separately verified old
addon/proof. The scope extension and both earlier failures are explicit.

## Evidence and checks

The final hosted M1/Intel run uses79948df (guard fix plus explicit capacity-only
correction), not reanalysis of old review runs. The guard-only repeat usedad4a81f
with the unchanged4ba66c1 implementation.
Final run: [CI39008218827](https://github.com/riesbri/dshline/actions/runs/39008218827).
The initial measurements came from
[manual CI39005270464](https://github.com/riesbri/dshline/actions/runs/39005270464).
Its first Intel performance upload failed `CreateArtifact: ETIMEDOUT` after all
checks completed; an unchanged-source job retry supplied the retained initial
Intel data. No unavailable first-attempt timing values are mixed into results.
Local Linux uses the same committed source and clean native-input proof.
Source/build/compiler identities, tool hashes, native proofs, guard decisions,
actual calls and exact outputs are checked before/after timing.

- [Linux raw](../benchmarks/renderer-guard-fix-linux-arm64.json),
  [M1 raw](../benchmarks/renderer-guard-fix-darwin-arm64.json),
  [Intel raw](../benchmarks/renderer-guard-fix-darwin-x64.json).
- [Recomputed summary and acceptance](../benchmarks/renderer-guard-fix-summary.json)
  and [additional test mutations](../benchmarks/renderer-guard-fix-test-mutations.json).
- [Clean exact-source soak](../benchmarks/renderer-guard-fix-capacity-soak.json):
  **2,701,224 direct-addon comparisons**,37,517 cases at each of eight budgets.
  [Lost-style replay mutation](../benchmarks/renderer-guard-fix-row-replay-mutation.json)
  fails the new Rust semantic test.
- Fresh strict PTY integration runs on all three machines retain producing-write /
  received-byte / full emulator snapshot/cursor identity, TS zero transformations,
  admitted Rust reachability and zero native composites. These are presentation
  checks, not provider/model timing; no physical-display or uniform whole-turn
  speedup is claimed. Raw files: `renderer-pty-guard-fix-{linux-arm64,darwin-arm64,darwin-x64}.json`.
- Build, typecheck/capability checks, **62 focused tests**, security and bilingual
  pairing pass. Full local suite: **5611 pass,26 skip**, with the same three
  launcher-pnpm-prerequisite failures previously reproduced on the unmodified
  reviewed baseline; launcher/tests are unchanged. Initial guard-source hosted
  [required CI](https://github.com/riesbri/dshline/actions/runs/39005274155) and
  [security](https://github.com/riesbri/dshline/actions/runs/39005274156) are green.
  The complete79948df manual run, including its consumer lane, passed. A parallel PR consumer attempt hung
  after pnpm printed completion, as seen previously; no timeout was widened.

```sh
pnpm build
node tools/build-renderer-native.mjs --required
node tools/renderer-guard-audit.mjs benchmarks/renderer-guard-fix-linux-arm64.json --interleaved
node tools/renderer-guard-fix-report.mjs
```

The audit requires the pinned25a2501 Git object and a clean-input proven addon.
Do not overlap its temporary compiled-emission mutations or timing with builds /
tests. Copy the two hosted records before running the three-platform report.
The report asserts all12 defect cells stay native-admitted and guarded≤TS.
Only documentation/evidence may change after the repeat measurement freeze;
retained proofs are not relabeled to later report commits.

# ASCII admission guard review

English | [中文](renderer-guard-review.zh.md)

Follow-up: [bounded guard fix and three-platform evidence](renderer-guard-fix.md).
The historical findings below describe the reviewed tree, not the later fix.

Review target: draft [PR #302](https://github.com/riesbri/dshline/pull/302),
`6928a8ba32452bfa09144fba656dfa4c432cef2d`, stacked on #300. This is an
adversarial self-review, not independent review or approval to land. **No
production fix was applied.** Defaults, thresholds, fallback, Unicode admission,
compiler policy and package sources are unchanged.

## Findings and proposed decisions

### 1. Sparse-Unicode guard scans can erase the leaf win (performance defect)

The long-ASCII two-code-unit probe fixes the earlier M1 9.65 µs all-ASCII
regression, but does not bound the expensive `/[^\x00-\x7f]/u` searches on
two-byte strings. A second distant non-ASCII character makes the width guard
scan the whole suffix **and then admit Rust anyway**. Tail/chunk do the same
full scan when their final character is non-ASCII.

Minimal reproductions, after `pnpm build`, with the compatible actual addon:

```js
import * as r from './packages/renderer/lib/index.js'
r.setRendererBackend('auto')
r.displayWidth('a中' + 'a'.repeat(2045) + '中') // guard returns undefined
r.tailToWidth('a'.repeat(2047) + '中', 80)     // guard returns undefined
r.chunkToWidth('a'.repeat(2047) + '中', 80)    // guard returns undefined
```

Controlled Linux ARM64 medians, µs/call; five rotated passes, each five
calibrated batch means, eight varying flattened strings. “No guards” is a
**private counterfactual graph**, identical except the guard function returns
undefined; all old bounds, minima, versions and actual addon bytes remain.

| Case | Guard probe alone | Guarded auto | No guards | Explicit TS |
| --- | ---: | ---: | ---: | ---: |
| Width, two distant CJK, 2048 units | 18.092 | 21.601 | 3.388 | 14.971 |
| Width, two distant CJK, 512 units | 4.643 | 5.963 | 1.252 | 3.983 |
| Tail, late CJK, 2048 units / 80 columns | 18.006 | 34.766 | 16.704 | 65.992 |
| Chunk, late CJK, 2048 units / 80 columns | 18.027 | 62.762 | 44.668 | 57.184 |

The admitted 2048-unit width case is **6.38× slower** than the same native
dispatch without guards and slower than TS. Chunk also loses to TS; tail
retains a TS win but more than doubles the counterfactual cost. All outputs
match exactly and all admitted variants call the real addon. These are fresh
**Linux-only** guard-cost measurements, not newly measured Mac costs.

**Proposed fix, not applied:** evaluate an ASCII **code-unit** predicate without
Unicode regex mode, or another bounded inexpensive scan. These sites only use
`search`'s start offset / `test`'s boolean; explicit surrogate-pair accounting
already handles the one-code-point exclusion. Require identical guard decisions
for paired/lone surrogates, ANSI and boundaries, individual guard mutations,
and fresh sparse/dense/ASCII timing on all three machines before accepting it.
Do not widen native admission or change thresholds to mask this defect.

### 2. Conservative gates exclude native winners; routing is not remediation of latency

Each gate can reject a winner. Current Linux controlled medians (guarded auto
→ no-guard native, µs) include width ASCII512 **4.680→1.245**, one late CJK
width2048 **32.945→3.412**, tail ASCII2048/80 **69.713→16.756**, chunk
ASCII512/64 **14.602→12.172**, and wrap ASCII512/80 **45.842→16.253**.
These are counterexamples to “TS is the faster choice”, not output defects.
The gates were designed to avoid native use on historically regressed families,
not to choose the fastest backend for every input.

The retained Mac data already exposes this cost for one late CJK width2048:
M1 reviewed/pre-guard/guarded/TS medians are **1.842/1.915/27.896/19.164 µs**;
Intel **2.468/2.065/46.754/38.851 µs**. The guard itself also adds work to
fallback. Those are separate public benchmark medians, not a controlled
subtraction that isolates guard cost.

**Proposed decision:** explicitly accept conservative exclusions, or commission
evidence-based narrowing after the scan-cost defect is addressed. No gate was
removed or narrowed in this review. A test proving TS routing is not a speed test.

### 3. Admission is not a universal guarantee against losers

No admitted pure-ASCII/ANSI case in the retained 120-case runs is >10% slower
than reviewed native or explicit TS. That finite corpus is not a proof over
all strings/budgets. The sparse cases above are counterexamples. A separate
zero-budget example, `tailToWidth('中'.repeat(2048), 0)`, remains admitted:
**0.835 µs auto vs 0.175 µs TS** on Linux. Most of that cost is the existing
boundary, not the five guards. Intel's retained sparse-CJK `fitToWidth`,
64 units / 40 columns, is **3.014 vs 2.702 µs** reviewed native (+11.55%);
none of the five guards applies to `fitToWidth`.

**Proposed decision:** keep these as explicit admission limitations; decide
separately whether they warrant another bounded exclusion. Do not silently
retune the old zero/narrow/minimum thresholds in this review.

## Exact excluded sets and costs on inputs not excluded

Let `n` be UTF-16 length and **A** mean every code unit is in 0–127, including
C0 controls, DEL, line breaks and ANSI bytes—not just printable ASCII. Sets below
are the **effective** guards in `auto`, after existing input/column bounds and
minima. Native also needs runtime/policy/addon Unicode agreement. Default
`typescript` short-circuits before every guard; explicit `rust` bypasses these
performance guards but keeps its existing bounds/version checks.

| Guard | Exactly what it excludes | Work on inputs it does NOT exclude / misfires |
| --- | --- | --- |
| `ascii-short-width` | `displayWidth`, A, **64≤n≤512** | Shares the width search with the next guard. Short dense CJK costs **0.127 µs**; two distant CJK at512 costs **4.643 µs** before admitting. Long ASCII avoids regex: two final code-unit probes, **0.025 µs**. Rejects native-winning ASCII512. |
| `ascii-dominant-width` | `displayWidth`, **64≤n≤2048**, exactly one non-ASCII code point (a valid surrogate pair counts once; a lone surrogate also counts), and either **n≤512** or at least one of the final two code units is non-ASCII | First search, two `charCodeAt`s, surrogate check, suffix slice and second regex test. Worst-case linear scan, even when it ultimately admits. Long dense CJK **0.130 µs**; two distant CJK **18.092 µs**. A single CJK in the middle of a long string with two ASCII ending units bypasses the guard (**0.026 µs**); the same point near the end is excluded despite winning natively. This positional rule is deliberate, not a count of overall ASCII dominance. |
| `ascii-tail` | `tailToWidth`, A, **512≤n≤2048**, any bounded integer column budget | Below512 only comparisons (**0.023 µs** at511); otherwise one ASCII regex test. Dense CJK stops immediately (**0.054 µs**); late CJK costs **18.006 µs**, then Rust scans again. Excludes native-winning long ASCII and admits the zero-budget loser. |
| `ascii-chunk` | `chunkToWidth`, A, **512≤n≤2048**, **64≤columns≤256** | One ASCII regex test on every eligible call. Dense CJK **0.053 µs**; late CJK **18.027 µs**. Excludes the ASCII512/64 native winner; admits a late-CJK input now slower than TS. |
| `ascii-wrap` | `wrapToWidth`, A, **64≤n≤2048**, **32≤columns≤256**, and **n≤512 OR columns=256 OR an ESC anywhere** | Short/widest-budget input runs the ASCII regex; other long inputs first search for ESC even if already dense CJK. Long ASCII/80 **0.121 µs**; dense CJK/80 **0.212 µs**; CJK with late ESC **0.249 µs**. No ESC on a long input skips the ASCII regex. Rejects short/widest/ESC ASCII winners; admits ordinary long ASCII and CJK. This is not an all-ASCII-to-TS policy. |

These guard-only costs include the call/loop overhead: an empty probe measures
about **0.017 µs**. They are batch-average medians, not per-call tail latency;
small public-dispatch differences can be noise. Width's two named guards share
one implementation, so their scan costs cannot be independently subtracted.
`fitToWidth` reaches the guard function but matches none of its branches
(**0.021 µs** probe in the long-ASCII control).

For incompatible Unicode runtimes, budgeted dispatch short-circuits before
guards; unary dispatch checks runtime compatibility **after** the guard.
Missing addons are checked after guards too. Thus opt-in auto can pay scan cost
even when native cannot run. Proposed follow-up: reorder only redundant
pre-admission work, preserving fallback/error semantics; **not applied**.

### Shadowing and mutation coverage

Bounds reject >2048 units / noninteger or >256 absolute columns before guards.
Existing minima shadow width/wrap <64, tail <64 and chunk <512; narrow-row rules
shadow chunk columns<64 and wrap columns<32 (including negative budgets).
There is no overlap between the five effective sets: operations differ, and
the two width sets require zero versus exactly one non-ASCII point.

Of the historical **29** ASCII-family observations (20 M1 +9 Intel), **19**
actually exercise named exclusions: short-width3, dominant-width3, tail3,
chunk2, wrap8. The other **10** already stay TS via old short/narrow/host paths.
In particular, the many chunk40/8 rows cannot prove `ascii-chunk`; only the
512-unit chunk120/256 observations do. Standalone `regressionGuard(...)`
labels in benchmark JSON do **not** mean dispatch reached that guard.

The existing test `defaults to TS even with an available addon, and gates every
recorded ASCII regression in auto` was run unmodified (**pass**), then once for
each **individual** guard return replaced by `undefined` (**five failures**):

| Removed guard | An unshadowed historical witness | Result |
| --- | --- | --- |
| short-width | width ASCII96 | Forbidden native call → `BACKEND_FAILURE` |
| dominant-width | width late-CJK64 | Same |
| tail | tail ASCII2048 /40 | Same |
| chunk | chunk ASCII512 /120 | Same |
| wrap | wrap ASCII96 /40 | Same |

No guard is dead, and no missing per-guard removal coverage was found, so no
redundant unit tests were added. The existing test proves routing, **not** that
guard scans are cheap. Mutation changed only untracked compiled emission,
restored in `finally`; source/build identities and addon hashes were verified
afterward. This was not an “all guards removed” test or a build/load failure.

## Three-platform PTY presentation-turn verification

“Before→after” here means **explicit TS→opt-in auto admitted Rust**, not
pre-guard auto→guarded auto: no such PTY pair was measured. Production
StreamBuffer + frame + Screen, real private80×24 PTYs, 65,536 UTF-16 units,
512 deltas,32 long logical rows, reconciliation/scrollback/close; one warmup and
five alternating pairs per kind/machine. Completion includes PTY and headless
xterm drain, not provider/model time, Harness startup or physical display paint.

| Platform / workload | PTY-drained ms, TS→auto | Emulator-drained ms, TS→auto | k UTF-16 units/s, TS→auto |
| --- | ---: | ---: | ---: |
| Linux ARM64 / ASCII, retained | 129.035→118.817 | 537.337→550.054 | 121.965→119.145 |
| Linux ARM64 / CJK, retained | 185.240→126.399 | 540.741→524.016 | 121.197→125.065 |
| M1 / ASCII, retained hosted | 91.765→74.031 | 762.205→798.003 | 85.982→82.125 |
| M1 / CJK, retained hosted | 103.148→90.954 | 1489.853→1374.740 | 43.988→47.672 |
| Intel x64 / ASCII, retained hosted | 123.924→111.760 | 735.580→717.909 | 89.094→91.287 |
| Intel x64 / CJK, retained hosted | 241.506→228.884 | 1367.192→1342.251 | 47.935→48.825 |
| Linux ARM64 / ASCII, fresh review replication | 128.973→122.408 | 560.559→541.076 | 116.912→121.122 |
| Linux ARM64 / CJK, fresh review replication | 166.823→131.398 | 571.371→503.295 | 114.700→130.214 |

**Cross-platform verdict:**

- Historical ASCII-family TS exclusions hold on **all three**: all41 original
  observations (29 ASCII-family +12 others) call zero native transformations in
  each platform's120-case archive (**123** checks). This does **not** mean all
  ASCII is gated: each ASCII PTY turn still calls native wrap1958/width32 times.
- CJK Rust reachability and reviewed-baseline long width/fit wins hold on all
  three: width **5.67× /4.84× /2.82×**, fit **31.49× /37.64× /15.67×**
  (Linux/M1/Intel). Dense controls survive; the sparse guard defect still exists.
- CJK presentation completion medians improve **3.09% /7.73% /1.82%** in the
  retained runs; fresh Linux **11.91%**. **No uniform ASCII completion win**:
  retained Linux/M1 are **2.37% /4.70% slower**, Intel **2.40% faster**;
  fresh Linux is **3.48% faster**, flipping the earlier sign. Five pairs with
  overlapping ranges do not prove statistical significance or a latency SLO.

The Mac records were **downloaded again and compared byte-for-byte** with
artifacts12054597967/12055467287 from the successful
[measured-source CI run](https://github.com/riesbri/dshline/actions/runs/38922097262)
at `2c74b50`; logs confirm both machines completed all PTY passes. They are
revalidated retained measurements, **not fresh Mac reruns**. Fresh Linux is
bound to review target6928a8b. All four records match the current compiler-verified
source/build/config identity and unchanged PTY-tool hash. All80 measured turns
pass producing-write→received byte/hash equality, cross-backend full emulator
snapshot/cursor equality, input identity, TS zero calls, positive Rust calls and
zero composite `execute` calls. No bytes were normalized to pass.

## Reproduce and review artifacts

```sh
pnpm build
node tools/renderer-pty-bench.mjs --output benchmarks/renderer-pty-linux-arm64-review.json
node tools/renderer-guard-audit.mjs benchmarks/renderer-guard-audit-linux-arm64.json
node tools/renderer-guard-evidence-review.mjs
pnpm exec vitest run tools/renderer-leaf.spec.mjs tools/renderer-native.spec.mjs tools/renderer-lookup.spec.mjs tools/renderer-spec.spec.mjs
```

Do not overlap the audit's temporary emission mutations with tests/builds or
timing. It requires the existing, clean-input-proven actual addon, not fallback.
Raw batch means, transformation counts, individual mutation witnesses and tool /
source / addon identities: [guard audit](../benchmarks/renderer-guard-audit-linux-arm64.json).
Recomputed medians, sample ranges,123 gate checks and80 PTY turn checks:
[validation](../benchmarks/renderer-guard-review-validation.json).
Downloaded-artifact hashes: [hosted verification](../benchmarks/renderer-guard-review-hosted.json).
Fresh20-turn replication: [Linux PTY](../benchmarks/renderer-pty-linux-arm64-review.json).

Local checks: build, typecheck/capability typecheck, **43 focused tests**, security
and EN/ZH pairing. No package/Rust/CI/threshold/default/compiler changes, no
merge/release/profile installation. The scan-cost fix and any admission-policy
change are left to the reviewer; the PR remains draft.

# One-shot auto recovery after a native failure

English | [中文](renderer-auto-recovery.zh.md)

Follow-up to independent review finding M1 on draft [PR #302](https://github.com/riesbri/dshline/pull/302).
Here M1 is the review finding identifier, not an Apple Silicon-only behavior.
TS stays the default. Native admission, all five guards, Unicode negotiation,
thresholds, compiler policy and forced-rust selection are unchanged.

## Classification and modes

Classification lives in `nativeFailure` in `packages/renderer/src/native-primitives.ts`.
An exact `RESOURCE_LIMIT` or `INVALID_INPUT` code takes precedence, followed by
an exact terminal error message (napi-rs supplies `code: GenericFailure` with our
code in its message). Literal terminal-code throws are preserved too. Other
native throws, including caught panic errors and explicit `BACKEND_FAILURE`,
normalize to `BACKEND_FAILURE`; invalid native return shapes already use that
class. Unknown native errors are backend failures, not inferred caller errors.
No substring matching or native error payload is exposed.

| Failure after admission | auto | forced rust |
| --- | --- | --- |
| `BACKEND_FAILURE` (including caught panic / invalid response) | One TS oracle attempt | Throw |
| `RESOURCE_LIMIT` | Throw; no TS retry | Throw |
| `INVALID_INPUT` | Throw; no TS retry | Throw |
| TS oracle throws during recovery | Propagate that exact TS error; no further retry | Not applicable |

`recover` applies this policy only around admitted direct native invocations in
`unary` and `cut`. Composites and code-point lookup are not newly admitted in
auto. Missing addons/methods, unsupported values and Unicode incompatibility
retain their existing pre-execution TS selection. Forced rust still throws:
the caller explicitly requested native execution, so a hidden post-admission
backend substitution would violate that choice. Its existing pre-admission
host/Unicode fallback remains unchanged.

## Exactly one native attempt, then the original TS oracle

There is no retry loop and no second native attempt for the failed operation.
Only normalized `BACKEND_FAILURE` in auto enters the recovery helper. It calls
the existing reference function with the original string/budget, without
coercion, truncation, alternate width rules or a new implementation.

Recovery temporarily pins selection to `typescript` for that entire synchronous
oracle call and restores the previous selection in `finally`, including when
the oracle throws. This matters for `fitToWidth`: its TS implementation calls
mode-aware width leaves. Without the scoped selection, a naive reference retry
can re-enter the failing native backend and is not a plain TS oracle anymore.
No callbacks, asynchronous work or terminal writes cross this pure leaf boundary.
Screen/frame stay TS hosts; only their individual pure leaf failures recover.
The native addon is not permanently disabled after one failure.

The normalized raw ABI/tooling envelope and surfaced errors still carry
`fallbackEligible: false`. That protocol is not widened: auto consumes its
specific internal backend-failure class before surfacing an error. Normalized
request rejection, caller errors and forced-rust execution are never retried.

## Tests and evidence

- Three new boundary tests fail on the old implementation: all five admitted
  operations × four failure forms return exactly TS in auto, but still throw
  in forced rust; counters prove one native attempt; a counted reference oracle
  proves one TS attempt and restoration even on an exact TS sentinel throw.
- Both terminal codes, napi-style messages, typed errors and literal throws are
  checked across all five operations in auto and forced rust (60 assertions).
- A fourth test compares Screen writes, callback-frame output and callback order
  exactly against explicit TS while native leaves throw backend failures.
- The historical guard test now has an explicit forbidden-native-call assertion
  outside the native throw. Recovery cannot hide a removed guard. The audit
  checks that witness, rather than requiring propagation of a backend error.
- `tools/renderer-recovery-audit.mjs` independently removes recovery, TS-only
  scope, terminal exclusion and forced-rust exclusion, then each of five guards.
  Each faulty build must fail its named behavioral assertion. Only disposable
  compiled copies are mutated; scratch is removed in `finally`.

Fault injection uses a mock addon at the real JS loader boundary, not an actual
Rust panic or a new compiler/panic policy. Existing actual-addon parity and
cross-platform CI remain required. All 86 golden requests/outputs and public
API signatures are unchanged; fixture source/build identities are refreshed.
Earlier performance records remain tied to their original measured commits;
this correctness fix does not relabel them or claim fresh timing results.

```sh
pnpm build
node tools/build-renderer-native.mjs --required
pnpm exec vitest run tools/renderer-native.spec.mjs tools/renderer-leaf.spec.mjs tools/renderer-lookup.spec.mjs
node tools/renderer-recovery-audit.mjs benchmarks/renderer-auto-recovery-audit.json
```

The test-only `DSHLINE_TEST_RENDERER_LIB` seam supplies those private copies;
the verified root build remains byte-identical. Do not overlap the audit with
builds, tests or timing.
PR remains draft; no merge, release or profile installation.

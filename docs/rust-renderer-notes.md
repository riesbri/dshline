# Rust renderer migration notes

English | [中文](rust-renderer-notes.zh.md)

## Architecture decision

Rust is a pure normalized-presentation backend, not a second frontend or Harness runtime. Existing TypeScript exports, wrappers and behavior remain the reference and fallback. [Renderer reference contract](renderer-spec.md) defines the boundary; its machine-readable sibling snapshots the exact current API. Phase 1 introduces no native dispatch or runtime dependencies. User-requested Zod is a root development dependency only, needed to validate capture inputs and emit a JSON Schema without hand-maintaining a second schema. The renderer package remains dependency-free.

Existing-solutions preflight considered maintained napi-rs bindings and unicode-width. They may provide transport or implementation components, but neither owns the semantic contract: unicode-width's grapheme handling differs from the current code-point sum, and native string conversion must not lose malformed UTF-16. Reuse repository width tables and emulator utilities. No custom terminal emulator, parser semantics replacement or agent runtime is justified.

## Sequential gates

1. Spec/schema/capture: exact public declarations, normalized Zod schema, deterministic live-call capture and architecture decisions. Independent review must approve this phase before proceeding.
2. Corpus/differential harness: only after phase 1 approval; expand consented/synthetic inputs and terminal-cell evidence. No corpus/harness is introduced in phase 1.
3. Pure Rust renderer crate: only after phase 2 approval; no bindings; implement pure transformations and pass every golden parity test, then obtain independent approval.
4. napi-rs bindings and TS integration: only after phase 3 approval; add the auto/rust/typescript selector and dshline configuration flag, preserve TS host I/O, then obtain independent approval.
5. CI/prebuilds and documentation: only after phase 4 approval; cover Linux, Darwin and Windows on x64 and arm64, update documentation and CONTRIBUTING, then obtain independent approval.
6. Benchmarks, soak and final readiness: only after phase 5 approval (the subsequent explicit optimization request brings exploratory measurements and direct-FFI soak into phase 4, not final readiness); benchmark, add a soak script and report final branch readiness. Each phase author self-reviews; the parent owns commits, push and draft PR on feat/rust-renderer. Rebase when main changes; no merge or release is authorized.

## Current status and gaps

Phases 1–5 are independently approved. Required hosted builds and actual-addon parity now pass on Linux, macOS and Windows, each on x64 and ARM64. The [successful CI run](https://github.com/riesbri/dshline/actions/runs/38818222630) also passes Core on Node 22.19/24/26, the adopted Harness source, packed published consumer, Windows launcher, tmux and documentation checks; security passes separately. [Final evidence](../benchmarks/renderer-final-evidence-2026-10-16.json) binds source, CI checkout, native binaries, package validation and current measurements. This is a reviewable draft, not authorization to merge or release. TypeScript remains the reference and permanent fallback; no private session/profile or model turn was used for acceptance.

## Reproducible checks

Build first so captures and declaration snapshots use current source. The focused tooling tests check schema rejection, full Unicode code-point admission, preloaded ESM-cache isolation after a valid behavioral rebuild, exact API/schema drift, deterministic actual calls, ANSI, malformed UTF-16 and Screen no-op writes. A deliberate schema mutation accepting unknown fields must fail the named domain-object rejection test. Existing renderer tests remain unchanged, including real terminal-emulator checks. The reviewer must evaluate semantic completeness as well as passing automation; a structurally valid bilingual pair does not prove translation accuracy.

```sh
pnpm build
node tools/renderer-spec.mjs
pnpm exec vitest run --project repo tools/renderer-spec.spec.mjs
pnpm run verify-docs docs/renderer-spec.md docs/rust-renderer-notes.md
```

## Phase 2 parity harness

`pnpm build && pnpm test:renderer-parity` validates 82 synthetic and 4 observed startup presentation
fixtures against freshly verified TypeScript artifacts. Each fixture records its
own provenance, source/build/compiler digests and effective resolved palette;
one case per capture keeps the existing conservative admission unchanged.
Before replay, the validator compares every complete normalized request against
the canonical corpus, including parameters, effective palette and provenance;
duplicate, missing and unintended stale fixtures fail. Same-ID input edits
require explicitly re-recording goldens.
`node tools/renderer-parity.mjs --record` deliberately refreshes goldens for the recorded normalized corpus
from actual calls, never guessed goldens or private session discovery.
The oracle loads implementation modules directly from the verified snapshot,
not a future public backend selector. No native code or production dispatch is
introduced here.

The future command is a **host adapter**, not a Rust crate ABI. It must retain
Screen state/writes and markdown sequence ownership in unchanged TS, injecting
Rust only for admitted pure transforms. Screen/markdown sequences count as
`hostAdapterCases`, not native pure cases; Rust must not implement Screen state.
The command protocol is one normalized capture JSON object on stdin and
one `{ok:true,value:{cases:[{id,output}]}}` JSON object on stdout, with case order
preserved. Invoke with `--require-rust --backend '["path/to/renderer-command"]'`;
argv is never interpreted by a shell. Outputs compare exact JSON values and
UTF-16 strings, including ANSI, write boundaries and malformed surrogate units;
there is no ANSI stripping or UTF-8 conversion of rendered strings. Missing
native code reports **PENDING**, with zero native cases, and required-native
mode fails. Reference-only CI is not evidence of Rust parity.

The corpus spans all 20 normalized operation tags, width edge budgets, CJK,
combining marks, emoji/ZWJ, lone surrogates, malformed ANSI and model controls,
frame geometry, fenced/partial markdown, resolved depths 0/4/8/24 and missing
roles, plus ordered Screen commit/resize/stale/close calls. Headless xterm checks
characters, colors, host-rendition BCE and cursor positions. Named deliberate
reset/surrogate/write-boundary/backend mutations must fail exact comparison.
The four observed inputs came from an isolated packed-plugin startup at 80×24
with Harness 0.2.0-rc.2, reaching the ready composer and exiting via Ctrl-D;
no model turn ran. `tools/renderer-parity-session/` preserves the normalized
inputs, observation-only hook and evidence. Reproduce with an absolute
`NODE_OPTIONS=--import=/path/to/observe.mjs`, `RENDERER_OBSERVED_OUTPUT` set to
a scratch file, and `node tools/consumer-smoke.mjs --launcher-version 0.2.0-rc.2`.
Scratch-path calls were excluded. Streaming and hostile-input fixtures remain
synthetic; no synthetic fixture is represented as a real session. Phase 3 still requires
independent approval.

File admission reads at most 1048577 bytes from one opened file handle before
JSON parsing, rejecting the extra byte. It does not trust a prior path stat, so
file replacement or growth cannot bypass the 1048576-byte cap.


## Phase 3 pure Rust verification

The pure `crates/dshline-renderer` library and bounded CLI implement normalized
presentation transforms without Node, Cordis, Harness or terminal I/O. Text is
`Vec<u16>` throughout: the verification transport uses numeric UTF-16 arrays,
including palette IDs and role keys. Palette roles cross as key/parameter pairs,
not JSON object keys; lone surrogates therefore never pass through a lossy Rust
UTF-8 string. Operation names and fixed enum tags remain ordinary JSON strings.
Input and output admission is enforced; errors are bounded typed envelopes.

`tools/renderer-rust-host.mjs` is verification tooling, not production dispatch.
It invokes the real Rust executable for every pure transform and reports native
call counts. For Screen recipes it loads the unchanged verified TS Screen with
only wrapping replaced by the native operation. Markdown sequence state remains
in the TS host, invoking pure Rust transitions with explicit incoming/outgoing
fence state. No Screen, composer, keyboard or agent state machine moves to Rust.

Current verification: all 86 goldens match (83 pure native cases and three TS-host
sequence cases), plus 442 additional deterministic adversarial comparisons and a
separate lone-surrogate palette metadata check. These are not exhaustive Unicode
or markdown conformance claims. Independent Phase 3 review approved this implementation and matched 1000 additional adversarial requests.

```sh
cargo test --manifest-path crates/dshline-renderer/Cargo.toml
cargo build --manifest-path crates/dshline-renderer/Cargo.toml
node tools/renderer-parity.mjs --require-rust --backend '["node","tools/renderer-rust-host.mjs"]'
```

Width/zero-width ranges are copied from the project's Unicode 17 tables rather
than substituting different grapheme or ANSI-parser policies. Markdown L/N word
properties are generated with Node v24.18.0, Unicode 17.0; the generator requires
Unicode 17.0. Other supported Node releases may use different property tables.
Phase 4 now guards native markdown compatibility on the host's Unicode version;
width operations remain governed by the project's fixed width tables.

Two cargo-fuzz targets cover malformed ANSI/UTF-16 and bounded JSON admission.
Seeded stable libFuzzer smoke runs completed 10000 executions per target; those
runs did not enable coverage instrumentation or sanitizers. Instrumented nightly
fuzzing remains an additional check, not a completed coverage claim.


## Phase 4 native binding and selection

The separate `crates/dshline-renderer-node` napi-rs crate depends on the pure
renderer, never the other way around. Bounded `execute` JSON transport remains
for verification and forced Rust composite operations. Direct width, stripping,
escaping, sanitization, truncation, tail, fit, chunk and wrap methods avoid JSON
and numeric-array transport. Inputs are checked before allocating an owned Rust
copy; direct text is capped at 2048 UTF-16 units and column budgets at ±256.
Output expansion for these single-input transforms is bounded by those limits.
Each FFI operation is panic-guarded. Generated napi compiler metadata owns
`native/index.d.ts`. `JsStringUtf16` includes a C terminator in its slice; the
binding slices to the measured JavaScript length, preserving real trailing NULs
and lone surrogates without accidentally rendering the sentinel.

The pure scanner borrows token spans instead of allocating a vector per
character. Width measurement allocates no tokens and handles printable ASCII
without a Unicode table lookup. Prefix truncation stops scanning when its budget
is exhausted. Reverse-tail selection retains borrowed token spans where a
forward ANSI scan is necessary.

The public renderer keeps previous signatures and adds `setRendererBackend`
and `rendererBackend`. `auto` is intentionally hybrid: measured direct operations
use native code only for text lengths 64–2048 (chunk: 512–2048); wrap requires 32–256 columns and chunk 64–256. Width, tail and fit are the other native candidates.
Individual code-point lookups, prefix truncation, stripping, escaping,
sanitization and JSON-backed composite/markdown operations stay TypeScript in
auto because their complete boundary cost did not demonstrate a general win.
Thresholds are conservative local measurements, not cross-platform guarantees.
Native output errors never trigger an unbounded TypeScript retry.

Missing/corrupt artifacts and public inputs outside auto admission use original
TypeScript semantics before native execution. Sparse arrays, callbacks, getters,
unknown option fields and caller-owned objects are not traversed by an alternate
native path. `rust` requires an addon and uses it for every admitted pure
operation, irrespective of the auto performance thresholds. Public host-only
features, inputs outside the bounded native subset and Unicode-incompatible
operations select unchanged TS before normalization/admission, even in rust mode.
Raw normalized/native rejection remains strict and is never retried. This is
necessary for ordinary dshline callback frames and full-theme streaming to work
with the same public API. Rust is not a promise that every operation is faster.
`typescript` never invokes native operations. Every native operation now requires agreement between the host runtime Unicode
version, the generated TS width policy and the compiled addon lookup release.
Missing or mismatching version metadata selects TS, including in forced mode.
The current tables are Unicode 17.0; see the [follow-up report](renderer-leaf-followup.md).
Arbitrary border callbacks remain a TS-only host feature.

Streaming markdown keeps explicit native fence state in TypeScript and lazily
constructs a reference renderer from that fence on fallback. It no longer fully
renders every committed line twice. A committed TS fallback owns the remainder
of that document even if selection later changes to rust; no state is guessed.
Partial fallback does not commit state. Palette snapshots are created only for
native markdown work. They are not cached: existing caller-owned SGR arrays may
mutate, and original TS behavior observes those mutations. Descriptor-safe checks
preselect TS for proxy/accessor/custom-iterator arrays before cloning: an unused
role must not execute behavior that the original formatter never reads.

The dshline composition-time `renderer` field accepts `auto`, `rust` or
`typescript`, defaulting to `typescript`. `auto` is an explicit opt-in to admitted
leaf acceleration; the additional named regression exclusions and existing
thresholds remain in effect. The reviewer approved only the existing argument/option plumbing
through `run` into `createWindow`; inject dependencies, callbacks, error handling
and ownership are unchanged. Selection is disposed with the window and is not a
volatile setting or Harness capability.

```yaml
- id: dshline
  config:
    renderer: auto
```

The actual addon passes all 86 differential fixtures, including TS-host recipes
with counted native calls. Tests cover direct malformed UTF-16/ANSI/NUL outputs,
missing/corrupt artifacts, typed failures without retry, streaming fallback state,
mutable palettes, sparse arrays and ignored host getters. The optimized full
suite reports 5560 passed, 26 skipped and only the three previously observed
launcher-prerequisite failures on this host (its `/usr/bin` contains pnpm).
Native-induced picker timeouts are gone without changing test timeouts.
Cross-platform prebuild packaging remains the next gated phase. Phase 4
was independently approved at `97f2001`.

## Optimization experiments and reproduction

The original release build allocated a text buffer for every token and paid
numeric UTF-16 arrays plus JSON on most public calls. Measurements compared that
implementation, an allocation-free scan, direct napi methods and the final
hybrid public selector. Narrow-column tests also rejected a tempting native
policy: returning hundreds of one-character rows made native chunking up to
seven times slower than TS despite its faster scan.

The reproducible tools assert exact output before timing; they fail when native
code is missing rather than benchmarking a TS fallback as Rust. The benchmark
records the environment, addon digest, median and maximum of five calibrated
batch averages. Those maxima are not per-call p95 tail latencies. A previous
package snapshot may be supplied with `--baseline`; it must include its matching
`lib/` and `native/` artifacts. No repeated-input cache is used.

```sh
pnpm build
node tools/renderer-bench.mjs --output /tmp/renderer-bench.json
node tools/renderer-soak.mjs 10000
```

The soak is deterministic direct-addon differential testing, not a
coverage-instrumented or sanitizer fuzzing claim. Independent review additionally
checks every Unicode code-point width, malformed UTF-16 and palette/backend
transitions. [Performance results](renderer-performance.md) distinguish raw
kernel/FFI improvements from public-path measurements and record limitations.

## Phase 5 optional build and distribution

`node tools/build-renderer-native.mjs` is an opt-in contributor build; absent
Cargo produces a clear successful skip. `--required` fails without the toolchain.
Neither path installs Rust or edits a contributor's shell/profile. CI alone
installs and selects Rust 1.99.0 on the six hosted OS/architecture targets.
Generated napi declarations are compared in scratch before changing artifacts.
The verified TS oracle invokes the actual compiler JS entry through Node, not
platform-specific package-manager shell shims.

Each required target must run the pure Rust semantic tests and actual-addon
parity, not an auto fallback. Per-platform provenance binds the binary digest,
commit and actual source inputs; release assembly rejects missing, stale or
modified artifacts before writing the aggregate manifest and packing the npm
renderer. Build/pack jobs remain read-only and have no publishing identity.
The existing separate OIDC publisher still consumes only validated tarballs.
The packed-payload checker verifies archived bytes against the native manifest,
with bounded 64 MiB extraction and a 2 MiB synthetic regression fixture.
The renderer ships optional binaries directly, with no npm runtime dependency
or install-time downloader/compiler. License texts cover the locked native
dependency graph and Rust standard library, with a freshness check.

Windows source checkout and TypeScript emission use LF for reproducible source
and build identities. Explicit compiler configuration changes provenance, not
semantics: all 86 golden outputs are unchanged after re-recording identities.
The fuzz-only `r-efi` 6.0.0 MIT license alternative has an exact-version license
exception because the deny-list action also matches its unused LGPL option;
advisory checks and the general deny list are unchanged.

All six required hosted jobs now pass at head `740e406`. Intel macOS needed the
Node-backed pnpm npm package with a committed integrity lock: pinning the setup
action's requested version alone still took its unsupported standalone self-update
path. Integrity, frozen installs and dependency trust policy remain unchanged.
The previous consumer-install timeout did not recur; no timeout was relaxed.

The final public-mode acceptance runs compiled package resolution in a separate
Node process (no Vitest source aliases): five shipped themes at four depths,
20 normal callback frames and 120 streaming lines match TypeScript in required
Rust mode. Public out-of-subset values preselect the host; admitted native
failures still propagate. The larger seeded soak matched 900000 direct-addon
transformations. These checks do not substitute for all-platform CI.

## Phase 6 final evidence

The final 230-case benchmark and corrected direct-addon soak use the downloaded
clean CI Linux ARM64 addon, not the earlier locally dirty-built binary. GitHub
checks out PR merge `82d25b11`; its complete tree matches branch head `740e406`.
The isolated validation checkout retains that exact merge identity and original
six provenance records. Source-input digests, the complete native manifest and
packed archive bytes validate before the benchmark or soak.

Independent review found that the old soak's correlated low PRNG bits selected
width 1 almost exclusively. Earlier comparison counts remain historical results,
not evidence of balanced width/size coverage. The corrected generator explicitly
crosses eight budgets with 17 UTF-16 boundary lengths, then balances all random
budgets; regression tests detect both collapsed budgets and a missing 2048-unit
boundary. A final 300136 cases / 2701224 direct-addon comparisons pass, with 37517
cases per budget. Results bind TS source/build/compiler, native inputs, original
artifact proof and tool hashes, and reject identity changes during the run.

The six-artifact archive passes packed-byte verification; compiled required-Rust
acceptance matches 20 composer frames and 120 streaming lines across five themes
and four color depths. [Performance results](renderer-performance.md) distinguish
fresh source-bound measurements from historical baseline experiments. Timings are
local microbenchmarks, not cross-platform speed or whole-model-turn guarantees;
soak is not sanitizer/coverage-instrumented fuzzing or a memory-leak certification.
Live latest-head PR checks remain the merge-readiness authority. No merge,
publishing, user-profile change or service/model configuration change is included.

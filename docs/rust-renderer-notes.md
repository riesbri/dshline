# Rust renderer migration notes

English | [中文](rust-renderer-notes.zh.md)

## Architecture decision

Rust is a pure normalized-presentation backend, not a second frontend or Harness runtime. Existing TypeScript exports, wrappers and behavior remain the reference and fallback. [Renderer reference contract](renderer-spec.md) defines the boundary; its machine-readable sibling snapshots the exact current API. Phase 1 introduces no native dispatch or runtime dependencies. User-requested Zod is a root development dependency only, needed to validate capture inputs and emit a JSON Schema without hand-maintaining a second schema. The renderer package remains dependency-free.

Existing-solutions preflight considered maintained napi-rs bindings and unicode-width. They may provide transport or implementation components, but neither owns the semantic contract: unicode-width's grapheme handling differs from the current code-point sum, and native string conversion must not lose malformed UTF-16. Reuse repository width tables and emulator utilities. No custom terminal emulator, parser semantics replacement or agent runtime is justified.

## Sequential gates

1. Spec/schema/capture: current phase; exact public declarations, normalized Zod schema, deterministic live-call capture and architecture decisions. Independent review must approve this phase before proceeding.
2. Corpus/differential harness: only after phase 1 approval; expand consented/synthetic inputs and terminal-cell evidence. No corpus/harness is introduced in phase 1.
3. Pure Rust renderer crate: only after phase 2 approval; no bindings; implement pure transformations and pass every golden parity test, then obtain independent approval.
4. napi-rs bindings and TS integration: only after phase 3 approval; add the auto/rust/typescript selector and dshline configuration flag, preserve TS host I/O, then obtain independent approval.
5. CI/prebuilds and documentation: only after phase 4 approval; cover Linux, Darwin and Windows on x64 and arm64, update documentation and CONTRIBUTING, then obtain independent approval.
6. Benchmarks, soak and final readiness: only after phase 5 approval; benchmark, add a soak script and report final branch readiness. Each phase author self-reviews; the parent owns commits, push and draft PR on feat/rust-renderer. Rebase when main changes; no merge or release is authorized.

## Current status and gaps

Phase 1 is independently approved after three review rounds; exact execution provenance, full Unicode code-point admission and aggregate resource limits are verified. Phase 2 implementation is complete and awaiting independent approval: 82 synthetic and 4 observed isolated-startup fixtures, an exact differential harness and a reference-only CI hook are now present. This is not an exhaustive or live-model production-session corpus. No private session/profile is accessed. No Rust crate, bindings, native/prebuild CI or dshline runtime integration is added. The spec records bounded-integer normalized admission and prohibits unchecked fallback of rejected work; direct public TS semantics remain unchanged; resolved palette snapshots and the pure markdown transition ABI are specified now; exhaustive edge cases and benchmarks remain later gated work. Native packaging must reconcile optional transport with the renderer's no-runtime-dependency rule before integration; phase 1 grants no exception.

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

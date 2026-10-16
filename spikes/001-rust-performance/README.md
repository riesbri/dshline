# Further Rust performance study

Research artifacts only: none of these files is imported by a package, included
in the addon build, or selected by production dispatch. Do not copy a spike into
production without a normal implementation and its compatibility gates.

## Questions

1. Does a deduplicated Unicode width lookup beat two binary searches without
   changing any project width semantics?
2. Can source spans reduce tail/wrap allocation without changing UTF-16, ANSI,
   combining-mark or word-break behavior?
3. Does ThinLTO with one codegen unit help while retaining panic unwinding and
   portable CPU targets?
4. Do those wins reach real TypeScript-owned frame/Screen work, or does import
   topology leave the Rust kernels unused?

## Reproduce

Use Node 24, the pinned pnpm, and Rust 1.99.0 on PATH. No toolchain installer,
profile mutation, runtime dependency or user-profile access is part of the study.
Cargo dependencies must already be cached; builds are locked and offline.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
study_parent=$(mktemp -d)
study_dir="$study_parent/study"
node spikes/001-rust-performance/prepare.mjs "$study_dir"
node spikes/001-rust-performance/check.mjs "$study_dir" 30000
node spikes/001-rust-performance/bench.mjs "$study_dir" 3 baseline lookup candidate
node spikes/001-rust-performance/host.mjs "$study_dir"
node spikes/001-rust-performance/mutations.mjs "$study_dir"
node spikes/001-rust-performance/collect.mjs "$study_dir"
```

The committed initial-phase artifacts are historical observations. On a fresh
scratch directory, `collect.mjs` also expects `results/phase1-*.json` from this
checkout; it verifies their retained identities and does not regenerate them.
To repeat the five-way timing comparison, pass `baseline lookup spans combined
thin-lto` after the pass count. Extra pure-crate semantic checks used in this
study can be repeated for each variant with `cargo test --release --offline
--locked --manifest-path "$study_dir/<variant>/crates/dshline-renderer/Cargo.toml"`.

Preparation refuses an existing requested directory and creates it with mode
0700. With no directory argument it uses a fresh `mkdtemp` path and prints it.
Other entry points require that explicit private path, verify ownership and
permissions on POSIX, and reject a symlink leaf. This replaces the original
predictable shared temporary default. The committed measurements retain hashes
from `b07d423`; the later scratch-path repair does not relabel them as reruns.

Run CPU measurements sequentially, without builds/tests alongside them. The
six builds share a Cargo target cache but each addon is copied to its own path.
Build durations therefore describe this run's cache state, not clean-build
comparisons. `builds.json` binds crate input hashes, compiler identity and addon
hashes; `checks.json` records actual direct-native coverage. `bench.json` retains
all batch samples and independent passes, and `host.json` records reachability
counts and exact synthetic host workload comparisons. These are local research
builds, not clean-CI release/provenance evidence for a changed production addon.

The first broad source-span wrapper failed a differential check at seed
2810499053, budget -256: zero-width tokens preceding a skipped space were lost.
The retained wrapper only specializes printable ASCII/newlines and preselects
the original kernel otherwise. The tail experiment retains general UTF-16/ANSI
semantics and uses two scans instead of a token vector. Mixed hostile input
usually bypasses the ASCII specialization, so `check.mjs` separately stresses
4000 printable-ASCII/newline cases with balanced budgets.

The host experiment copies compiled modules to scratch. Only width/wrap leaf
functions are replaced; the original TypeScript Screen/frame implementations
still own state, callback evaluation, sink writes and redraw order. Exact write
arrays must match. It is not a production selector: a production implementation
must reuse the existing guarded loader, explicit backend modes, admission and
no-retry errors, and avoid a box/backend import cycle.

See [the findings](../../docs/renderer-next-study.md) for measurements, caveats
and the recommended production sequence. No speedup in this directory is a
cross-platform, whole-model-turn, per-call-tail-latency or leak-freedom claim.

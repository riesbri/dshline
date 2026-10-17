# Live Harness/provider/PTY turn comparison

This is **not** `tools/renderer-perf.mjs`. Each observation launches the real
`dsh` CLI, loads the real dshline bundle into a real Harness profile, submits a
prompt through a controlling PTY, and consumes a real provider response. There
is no fixture agent, generated token stream, artificial cadence, or replay in
the measured path. No production source, public API, or dependency is changed.

## Reproduction

Requirements: Linux, Python 3 (standard library only), Node 24.18.0, the pinned
pnpm, and `dsh@0.2.0-rc.2`. The installed source profile must resolve
`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2`, and pi-ai
`0.99.1` (this host's existing override). Use an already authorized OpenCode Go
account; no credential values belong in commands or published results.

```sh
git worktree add --detach /tmp/dshline-live-stock 8b91e0e
(cd /tmp/dshline-live-stock && pnpm install --frozen-lockfile && pnpm build)
pnpm install --frozen-lockfile
pnpm build
python3 tools/live-turn-perf/run.py \
  --stock /tmp/dshline-live-stock --candidate "$PWD" \
  --profile "$HOME/.dsh/profiles/dshline" \
  --credential-home "$HOME/.dsh" \
  --samples 30 --timeout 180 --output private/live-turn-results
python3 tools/live-turn-perf/summarize.py private/live-turn-results --archive
```

Do not run builds/tests alongside the timings. The runner never changes the
installed profile. It creates mode-0700 private benchmark homes, copies the
credential store with mode 0600 into them, links the existing adapter dependency
graph, and gives each arm its **own** source-linked dshline/renderer packages.
The exact stock checkout is `8b91e0e`; the measured candidate is `1cde065`.
`metadata.json` records commits, tree IDs, compiled-module SHA-256s, tool identity,
launcher/adapter versions, prompts, and host details. Credentials and session
stores are not published. Remove generated private credential copies after use.

Every observation uses a new process, session, and empty scratch workspace.
After its ready frame, the driver pastes the workload and presses Enter. The
minimal private profile patch is:

```yaml
- id: agent-default-model
  config:
    provider: opencode-go
    model: deepseek-v4.1-flash
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_API_KEY
- id: dshline
  config:
    theme: default
    busyEnter: steer
```

The existing Harness credential seam resolves the reference. No reasoning effort,
temperature, seed, or token cap is forced; the recorded resolved request config
and provider-reported usage are retained. The four exact prompts are in
`run.py` and `metadata.json`: 32 lines of Latin prose, 32 CJK lines, 32 Markdown
lines, and one long repeated URL-like line. Generated replies are not guaranteed
to obey exact counts or to match across arms; lengths, chunks, calls and bytes
are reported, not silently normalized away.

The controlling PTY is 90 columns × 24 rows, `TERM=xterm-256color`, truecolor.
Only its private slave has OPOST disabled, after Node takes raw input mode, so
explicit renderer CRLF is not transformed a second time. Successful exit,
positive real Screen/compose/scheduler counters, a completed real prepared
provider call, no tool calls, and exact producing/received byte counts and
SHA-256s are mandatory. The original installed profile and terminal are untouched.

## Endpoints and attribution

Python `monotonic_ns` and Node `hrtime` share Linux's monotonic clock.

- **Whole turn:** Enter submission → PTY master receipt of every byte produced
  through the final settled frame. Startup and the final ctrl-d teardown are
  outside this span. The worker waits two check phases after idle so the real
  scheduler consumes settlement invalidations, then flushes stdout. The receipt
  timestamp, not arrival of the instrumentation summary, closes the measurement.
- **First-content paint → drain:** first PTY receipt containing a complete Screen
  write after the first text/reasoning delta → final frame receipt. This is a
  first-content output proxy, **not physical display paint**. The separate
  time-to-first-content-paint metric preserves the initial provider wait.
- **Screen:** inclusive synchronous `setLive` and `commit` time: wrapping,
  damage/cache work, and terminal-write enqueue. **Renderer** adds actual
  `TuiSlots.compose` time. These intervals are disjoint; scheduler callbacks
  include them and must not be added again. Frame p95/p99 are retained per turn.
- **Provider span:** the real prepared provider stream entry → iterator EOF.
  A transparent iterator observer records every real `next()` await and its
  delivered chunk type; it does not split, merge, delay, or manufacture chunks.
  The span includes network/provider/adapter work **and local interleaving**.
- **Disjoint accounting:** subtract overlap with measured renderer intervals
  from iterator awaits to report `providerAwaitNonRendererMs`. Together with
  renderer time and the remaining local/transport residual this sums to whole
  turn time. Await time still includes scheduling, other Harness work, adapter
  conversion and any backpressure. It is **not pure remote inference/network
  time**, and subtracting renderer savings from it cannot predict turn savings.

The optional observer is loaded into the CLI before startup for write accounting;
its plugin imports the actual classes through **Harness's own loader graph**.
Native Node imports alone observe a different graph. The profile must resolve its
own packages: a patch `name` asserts the old name and cannot replace a plugin.
The first two exploratory pilots got zero renderer counters for this reason;
those timings are rejected and retained separately. No speed claim uses them.

The instrumentation adds timing/array/hash overhead equally to both arms. This
is an instrumented live measurement, not an overhead-free profile. Screen time
includes the byte-accounting hash hook; its cost depends on output volume, so
no exact overhead correction or overhead-free renderer delta is claimed. Background
Harness title generation remains enabled; only the main Agent's prepared stream
is measured as the provider interval. Ancillary calls and nonrenderer work are
not independently attributed.

## Sampling and limits

One excluded warm-up per arm per workload, then 30 observations per arm,
alternating AB/BA order (240 measured turns). Each measured turn is a fresh
process; the warm-ups warm remote/OS caches, not a persistent renderer JIT.
Provider prefix caches can change during the experiment; recorded usage includes
cache accounting when supplied. Workloads run sequentially, not randomized
across the entire run. This is one shared Linux arm64 host, not a fleet claim.

Statistics are calculated from individual turns, using linearly interpolated
quantiles at `(n-1)*p`, sample standard deviation and sample variance. With only
30 observations per arm/workload, p99 is effectively a near-maximum observation,
not a stable estimate of population p99. Provider output, chunk grouping and
latency vary. Renderer totals also depend on how many updates the provider
actually delivers; normalized per-call values supplement the cumulative totals.
Medians of accounting components do not in general add to the median turn.

No physical terminal, compositor, monitor, emulator completion, remote-host
replication, exact cross-arm token/content parity, pure wire/network time,
server-side inference time, or causal whole-model-turn speedup is measured.
Deterministic text/style/cursor parity remains covered by the renderer tests
and prior replay, not by pretending two live provider responses are identical.

## Live results: 2026-10-17

Host: `pi5richi`, Linux `6.12.93+rpt-rpi-2712`, arm64, four Cortex-A76
cores; Node 24.18.0, Harness/adapter 0.2.0-rc.2, pi-ai 0.99.1,
`opencode-go/deepseek-v4.1-flash`, 90×24 PTY. Collection began
09:12:49 UTC. There are **30 real turns per arm per workload** (240 measured),
plus eight excluded warm-ups in the final archive. Earlier admission pilots
are not samples; four rejected loader pilots are retained separately.

All following timings are **milliseconds, stock → candidate**. SD is sample
standard deviation; exact sample variance (ms²), mean, min/max, per-turn values,
usage, chunk cadence and raw PTY receipts are in the reproducible JSON.
No timing outliers were removed. All 248 final records exited zero and passed
byte-count/hash, renderer-reachability, real provider EOF, route and PTY gates.
After collection, all compiled module hashes still matched their starting
hashes. The **only compiled JS difference between arms was `screen.js`**.


### Whole turn: submit → final PTY frame receipt

| Workload | Median | p95 | p99 | SD |
| --- | ---: | ---: | ---: | ---: |
| latin | 4,000.6 → 3,869.9 | 5,872.2 → 5,581.0 | 9,788.9 → 11,298.8 | 1,496.2 → 1,870.6 |
| cjk | 4,796.6 → 5,149.7 | 6,567.7 → 9,971.6 | 6,677.7 → 14,819.4 | 832.2 → 2,496.0 |
| styled | 7,834.1 → 7,301.2 | 10,993.8 → 12,686.4 | 14,134.2 → 13,948.5 | 2,180.3 → 2,374.7 |
| long | 12,232.1 → 10,312.9 | 26,618.5 → 22,585.1 | 43,242.1 → 29,627.2 | 8,622.7 → 6,200.8 |

### First-content output → final PTY frame receipt

| Workload | Median | p95 | p99 | SD |
| --- | ---: | ---: | ---: | ---: |
| latin | 1,842.9 → 1,754.2 | 2,445.9 → 2,271.5 | 2,904.3 → 2,409.6 | 380.9 → 331.7 |
| cjk | 2,815.7 → 2,740.7 | 4,037.6 → 3,411.2 | 4,514.3 → 4,415.5 | 665.1 → 561.9 |
| styled | 6,059.8 → 5,328.4 | 8,666.9 → 9,008.9 | 9,303.5 → 11,678.2 | 1,563.1 → 2,051.0 |
| long | 10,234.7 → 8,408.1 | 24,817.3 → 20,654.7 | 41,354.0 → 27,856.3 | 8,633.4 → 6,263.1 |

### Instrumented Screen totals per live turn

| Workload | Median | p95 | p99 | SD |
| --- | ---: | ---: | ---: | ---: |
| latin | 58.6 → 34.1 | 85.4 → 51.3 | 90.8 → 53.6 | 14.4 → 8.3 |
| cjk | 66.5 → 49.5 | 87.9 → 89.1 | 102.3 → 142.4 | 12.3 → 24.0 |
| styled | 128.5 → 77.4 | 267.2 → 147.2 | 320.3 → 242.7 | 58.3 → 42.0 |
| long | 208.6 → 117.7 | 601.0 → 275.1 | 1,110.9 → 496.8 | 227.3 → 97.3 |

### Renderer plus composition totals per live turn

| Workload | Median | p95 | p99 | SD |
| --- | ---: | ---: | ---: | ---: |
| latin | 282.0 → 257.6 | 405.7 → 353.2 | 423.2 → 413.2 | 55.8 → 54.7 |
| cjk | 364.5 → 348.0 | 502.1 → 497.4 | 529.2 → 521.4 | 62.9 → 71.3 |
| styled | 738.2 → 602.6 | 1,214.2 → 1,312.2 | 1,635.3 → 1,993.7 | 276.2 → 358.8 |
| long | 1,125.1 → 945.3 | 3,247.2 → 2,266.7 | 6,463.0 → 3,273.1 | 1,327.3 → 667.6 |

### Renderer-only versus whole-turn split

These are measured local elapsed intervals and descriptive arm deltas, not a
causal estimate from equal token streams. Renderer = Screen + composition.
Provider-await excludes overlap with those renderer intervals; it is still not
pure server/network time. Residual contains other local/session/transport work.
The per-turn split sums exactly; **component medians need not sum**.

| Workload | Screen median | Compose median | Renderer median | Provider span median | Await, excluding renderer overlap | Residual median | Whole-turn median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| latin | 58.6 → 34.1 | 226.9 → 218.5 | 282.0 → 257.6 | 3,878.8 → 3,722.8 | 3,546.5 → 3,460.2 | 139.5 → 151.2 | 4,000.6 → 3,869.9 |
| cjk | 66.5 → 49.5 | 301.3 → 298.5 | 364.5 → 348.0 | 4,673.0 → 5,023.3 | 4,240.9 → 4,664.7 | 151.3 → 166.7 | 4,796.6 → 5,149.7 |
| styled | 128.5 → 77.4 | 613.5 → 528.4 | 738.2 → 602.6 | 7,700.8 → 7,147.2 | 6,938.0 → 6,465.6 | 194.7 → 196.8 | 7,834.1 → 7,301.2 |
| long | 208.6 → 117.7 | 895.9 → 833.4 | 1,125.1 → 945.3 | 12,085.3 → 10,176.4 | 10,746.1 → 9,304.1 | 212.8 → 210.1 | 12,232.1 → 10,312.9 |


| Workload | Screen median delta | Renderer+compose median delta | Whole-turn median delta |
| --- | ---: | ---: | ---: |
| latin | -24.5 ms (-41.8%) | -24.4 ms (-8.6%) | -130.8 ms (-3.3%) |
| cjk | -17.0 ms (-25.5%) | -16.5 ms (-4.5%) | +353.1 ms (+7.4%) |
| styled | -51.1 ms (-39.8%) | -135.6 ms (-18.4%) | -532.9 ms (-6.8%) |
| long | -90.9 ms (-43.6%) | -179.8 ms (-16.0%) | -1919.3 ms (-15.7%) |


### Per-update rendering tails

Pooled calls/frames are correlated within turns; these are descriptive sample
quantiles, not thousands of independent whole-turn trials. Scheduler frame time
includes composition + setLive; synchronous commits have separate Screen calls.

| Workload | Screen calls n | Screen median | Screen p95 | Screen p99 | Frame p95 | Frame p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| latin | 5,828 → 5,652 | 0.254 → 0.153 | 0.474 → 0.335 | 1.593 → 0.855 | 2.734 → 2.571 | 4.857 → 4.280 |
| cjk | 7,583 → 7,532 | 0.245 → 0.150 | 0.454 → 0.352 | 0.990 → 2.034 | 2.541 → 2.663 | 3.884 → 5.521 |
| styled | 14,451 → 14,144 | 0.229 → 0.148 | 0.464 → 0.327 | 1.640 → 1.109 | 2.566 → 2.332 | 4.733 → 4.101 |
| long | 30,659 → 22,709 | 0.220 → 0.155 | 0.411 → 0.323 | 1.237 → 1.014 | 2.274 → 2.244 | 3.824 → 3.698 |


### Work delivered by the provider

This is a genuine unconstrained provider turn, including its reasoning. The
visible reply is usually close to the requested size, but the model's reasoning
and chunk grouping vary substantially. In particular, the candidate long-line
arm has fewer median output tokens; its lower whole-turn median cannot be
credited to Screen. Prefix cache reads were reported in both arms (0–512 tokens
for the first three workloads, 0–384 for long); no cache flush/control was used.

| Workload | Text characters median | Text characters min–max, stock / candidate | Reasoning characters median | Output tokens median | Stream chunks median | Screen calls median | Emitted bytes median |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| latin | 2,294 → 2,294 | 2,294–2,294 / 2,175–2,294 | 298 → 268 | 516 → 510 | 106 → 107 | 180 → 180 | 169,884 → 63,919 |
| cjk | 1,014 → 1,014 | 895–1,014 / 895–1,014 | 262 → 262 | 810 → 800 | 156 → 155 | 231 → 238 | 222,357 → 73,940 |
| styled | 3,502 → 3,315 | 2,331–4,046 / 2,359–4,232 | 940 → 758 | 1,216 → 1,154 | 338 → 308 | 454 → 406 | 448,728 → 131,776 |
| long | 2,736 → 2,736 | 2,679–2,736 / 2,736–2,736 | 5,050 → 4,058 | 2,656 → 2,189 | 552 → 549 | 704 → 622 | 745,898 → 211,749 |


### Interpretation and remaining limits

- Screen medians improve in all four live workloads, but the broader renderer
  includes unchanged composition and its variance. The CJK Screen p99 regresses
  **102.3 → 142.4 ms per turn**, and its pooled per-call p99 regresses
  **0.990 → 2.034 ms**. Styled renderer+composition p95/p99 also regress.
- Whole-turn medians improve for Latin, styled and long, but CJK regresses
  **4,796.6 → 5,149.7 ms**. Latin whole-turn p99 regresses
  **9,788.9 → 11,298.8 ms**; CJK p95/p99 regress strongly, and styled p95
  regresses **10,993.8 → 12,686.4 ms**. These are mixed observations, **not a
  whole-model-turn speedup claim**.
- Provider span, iterator waits, reasoning lengths, chunk grouping, prefix caches,
  and shared-host scheduling vary. Alternating adjacent arms does not make the
  responses identical, separate network from inference, or establish causation.
  Hash-hook cost also varies with emitted bytes and is included in Screen time.
- Thirty samples support descriptive medians/variance, but p99 is a near-maximum
  observation, **not a stable production p99 estimate**. This is one host, one
  provider/model, one geometry, fresh processes, and instrumented execution.
- Not measured: physical paint, emulator completion, pure network/server time,
  independently attributed ancillary title requests, an uninstrumented control,
  identical token streams across live arms, cross-host behavior, or startup.

The live Harness/provider/PTY evidence gap is covered at this explicitly bounded
PTY-receipt endpoint. This does not establish general end-to-end latency gains
or remove the tail regressions. **PR #303 remains draft; no merge or release.**

## Evidence and validation

- [`results/20261017`](results/20261017): `metadata.json`, `raw.jsonl.gz`,
  `pty.tar.gz`, `summary.json`, `provenance-final.json`, and periodic host-load
  observations (the load monitor began during the run, not before every sample).
- [`results/rejected-loader-pilots`](results/rejected-loader-pilots): rejected
  exploratory observations and their complete PTY captures.
- Recompute statistics from the archive without extracting it:
  `python3 tools/live-turn-perf/summarize.py tools/live-turn-perf/results/20261017`.
- Verify all captures and the deliberate corrupt-byte/zero-renderer mutations:
  `python3 tools/live-turn-perf/verify.py tools/live-turn-perf/results/20261017`.
- The observer refuses a pipe-only launch before accessing the provider. Every
  raw final record contains the real controlling-terminal geometry and exit code.

The history-wide secret scan matched four provenance digests beside filenames
ending in `keys.js`. Each value was independently recomputed from its compiled
file. The repository's `.gitleaksignore` contains only their exact historical
commit/file/rule/line fingerprints; no file or secret-detection rule is disabled.

Generated credential copies were deleted after collection. The original installed
profile, credentials, working sessions and production sources were not changed.

## Bounded UX follow-up (#304)

[UX-304-REPORT.md](UX-304-REPORT.md) records the quota-free frozen-capture byte
audit followed by a separate, explicitly bounded real-provider pacing/input
experiment. It does not resume or pool the permanently stopped Part 1 study.
The report includes per-cell quantiles/SD/variance, paired intervals, delayed
chunk-output tradeoffs, the retained transport interruption and archive-only
reproduction commands. Production scheduling is unchanged.

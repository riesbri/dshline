# Attachment-admission feedback: restricted dispatch evidence

Date: 2026-10-17. Node v24.18.0; pnpm 11.22.0; Vitest 5.0.3.
Base: PR #303, `781b1cf6406242460271d7b9d69eaee936e46e9b`.
Production implementation: `0d3bf88` (rebased checkpoint `898c448`).
This evidence and the additional regression coverage are committed together.

## Outcome

An idle prompt with staged attachments now shows animated `sending` before
asynchronous reads/publication finish. Attachment-accepting commands retain that
feedback through command settlement. Success, failure and cancellation clear it;
heartbeat ownership follows pending admission and the existing session scope.
A running model's activity retains priority, without a fabricated turn timer.
No Screen, provider, scheduler, title generation or delivery policy changes.
No dependencies or native code were added; production changes are TypeScript.

## Checks actually run

`pnpm install --frozen-lockfile --ignore-scripts` succeeded with the existing lock.
Final focused command (single worker):

```sh
pnpm exec vitest run packages/dshline/tests/file-attachment-flow.spec.ts packages/dshline/tests/image-attachment-flow.spec.ts packages/dshline/tests/views.spec.ts packages/dshline/tests/attachment-async-fencing.spec.ts packages/dshline/tests/attachment-init-failure.spec.ts --maxWorkers=1
```

All **240 tests in five files passed**: file attachment 53, image attachment 28,
views 140, async fencing 8, initialization/teardown 11. `git diff --check` passed.
Held promises establish feedback before completion; fake interval timers verify
three pending-work ticks and no ticks after settlement. These are behavior
checks, not performance samples. The first run exposed a new test's cleanup hang:
the fixture exit callback records exit without resolving the session loop. The
test now clears the restored composer and switches with `/new`; final run passes.

Deliberate mutations (restored before final run):

- Replace admission projection with `sendingAttachments: false`: the named
  `shows sending before a held file read...` and `shows sending through a held
  image command...` tests both fail at the visible `sending` assertion.
- Remove admission from the heartbeat condition: `ticks only while attachment
  admission owns pending work` fails (zero draws instead of three).

## Measurement boundary and remaining gates

The coordinator explicitly limited this dispatch to implementation and focused
local tests. No provider calls, provider-submitting PTY turns, live timing runs,
full build/typecheck, full suite, security audit or documentation matrix ran
locally. No medians/p95/p99 exist for this candidate; neither a renderer CPU gain
nor a provider-latency gain is claimed. Actual terminal presentation latency,
input/interrupt latency during a live turn, title-call contention, streaming
smoothness and byte amplification remain unmeasured. A 16 ms pacing change was
not landed without evidence. Physical display behavior is unverified.

The draft PR targets `perf/renderer-ts-fast-path`; full exact-head CI is a separate
remote gate and must not be inferred from these focused local checks. No merge
or release was performed.


## Continuation: streaming input ordering and byte-path inspection

Baseline: `21f9531af347940e1b89e7ef355dff306a454112` on the same stack.
This continuation changes tests and research evidence only; inspection and the
quota-free checks did not establish a production input/scheduling defect.
No new changeset is needed for this test-only increment.

The existing assistant-stream fixture now optionally uses the production
`RedrawScheduler`, routes decoded terminal bytes to the real attachment handler,
and preserves the composed cursor when writing through unmodified Screen.
Three new cases cover:

- Four bursts of twenty completed streaming lines, interleaved with an UNSENT
  composer marker, backspace and an insertion after moving Left. The marker is
  visible after each check phase; the cursor is on the actual expected cell.
  All eighty lines remain exactly once in native scrollback, including rows no
  longer in the viewport. Neither Agent inbox verb is called.
- Legacy ctrl-c (`03`) and enhanced ctrl-c (`CSI 99;5u`) during a pending stream
  paint. Each calls `agent.cancel({ kind: 'user' })` synchronously, before any
  queued composition. Harness-supplied interrupted settlement then commits
  both completed and partial text once, leaving the unsubmitted draft intact.

These tests use fake Agent publication and a real xterm emulator, not a Harness
provider or a controlling PTY. They establish ordering and cell parity, not an
upper latency bound, poll fairness under an arbitrarily large provider burst,
physical echo timing, or provider cancellation-to-idle time. Native scrollback
is terminal-owned; this does not implement or benchmark an application scroll
handler. The first fixture run timed out because its exit callback does not
resolve the session loop; cleanup now uses the existing local `/new` transition.
The marker is never submitted; cleanup submits only that local command.

### Focused checks actually run

```sh
pnpm exec vitest run packages/dshline/tests/assistant-stream.spec.ts packages/dshline/tests/redraw.spec.ts packages/dshline/tests/streaming-frames.spec.ts packages/dshline/tests/stream-chunking.spec.ts --maxWorkers=1
```

**42 passed in four files**: assistant-stream 14, redraw 9, streaming-frames 9,
stream-chunking 10. Existing parity/golden expectations were not regenerated.
`git diff --check` passed. No full local build/typecheck or suite was run.

Deliberate production faults, tested separately and restored:

- Ignore keys while the Agent is running: the marker/edit test fails at its
  first visible-echo assertion.
- Defer the running-turn cancel with `setImmediate`: both encoding cases fail
  the synchronous cancel assertion before repaint.
- Drop completed text rows from stream commits: the scrollback assertion fails
  for `stream row 00` (zero occurrences instead of one).

### Byte amplification analysis (source, not measurements)

`StreamBuffer.push` returns only newly completed lines; the listener commits
those rows synchronously. `live` renders only the bounded unfinished suffix,
not the accumulated transcript. Window skips empty commits. The check-phase
scheduler already collapses ordinary redraw bursts; Screen already skips
identical frames and writes row damage for stable-height changes.

The remaining obvious amplification is in `Screen.commit`: each nonempty commit
erases/re-emits the cached bounded live region beneath newly completed rows.
Coalescing those commits could reduce repeated chrome bytes, but changes the
immediate-scrollback and interleaved event/settlement contract. A 16 ms cap on
ordinary paints would not cap those synchronous commit writes. Changing Screen
also belongs to the parallel owner. No parity-safe, clearly beneficial change
was established here, so neither batching nor an unused evaluation-only timer
was introduced. No emitted-byte counts or savings are claimed.

Default scheduling, public API, synchronous commits, Screen, first-content and
provider policy remain unchanged. Live input/interrupt/first-content latency,
provider-await attribution, title contention, byte savings and pacing evaluation
remain deferred. No provider calls, live timing, PTY turns, profile changes,
merge or release occurred in this continuation.

## Bounded live follow-up (2026-10-17)

The earlier deferred status above describes the restricted dispatch at that time.
A later explicitly budgeted continuation completed the saved-capture byte audit
and a private 16 ms pacing comparison, with real controlling PTY input/interrupt
probes. See [the full report](../live-turn-perf/UX-304-REPORT.md) and its archived
per-turn observations. There are 179 valid measured ordinary turns, six excluded
warm-ups, six separate interrupt pilots and one retained, unreplaced transport
interruption. All 42 focused tests still pass; goldens and production scheduling
remain unchanged. The private prototype trades lower renderer work/traffic for
about 16 ms more chunk-to-Screen output eligibility delay; no whole-turn or
physical-smoothness win is established. It is not promoted to production.

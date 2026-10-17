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

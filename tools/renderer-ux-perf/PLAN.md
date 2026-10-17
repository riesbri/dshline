# User-facing renderer responsiveness research

Baseline: `8194c581b9465f5c8bca404f6b437ac078e0432f`, PR #303.
Branch: `perf/renderer-ux-fast-path`, stacked on `perf/renderer-ts-fast-path`.
Pure TypeScript production changes; no dependencies, native code, provider-policy
changes, installed-profile changes, merge, or release.

## Pre-measurement findings

- Submit already invalidates the composer before dispatch; ordinary redraws use
  check-phase `setImmediate`, not a fixed delay.
- Live text/reasoning frames already request the same check-phase paint. A
  first-token dead gap is not established by source inspection.
- Attachment admission is a real feedback gap: asynchronous reads/publication
  precede inbox delivery while the idle footer still says `ready`. The candidate
  shows animated `sending`, retaining real model activity priority and existing
  cancellation ownership. Success/failure clear the local state; teardown owns
  its heartbeat. Tests hold actual admission promises rather than sleep.
- Completed streaming lines commit synchronously through Screen, which redraws
  the current live frame. Merely capping scheduler paints cannot cap those
  writes. Do not claim it can, or change scrollback settlement semantics without
  independent parity evidence.
- Title generation is already concurrent. The existing observer only wraps the
  main prepared call and explicitly leaves auxiliary title calls unattributed.
  Overlap alone cannot establish or exclude provider contention.
- Screen height-change/CJK work belongs to the parallel owner. This branch does
  not edit Screen or duplicate that implementation.

## Current dispatch scope (2026-10-17)

The coordinator cleared the host for implementation and focused local tests
only. No live provider timing runs, no provider-submitting PTY turns, and no
full local build/test matrix. The concrete deliverable is attachment-admission
feedback plus deterministic regression evidence, stacked on PR #303 at
`781b1cf6406242460271d7b9d69eaee936e46e9b`.

## Deferred measurement protocol (not run)

The protocol below remains future research, not a requirement or authorization
for this restricted dispatch. No performance improvement is quantified.

1. Build exact baseline and candidate independently and retain compiled hashes.
   Use private scratch homes/workspaces and existing authorized credential
   resolution. Do not modify the installed profile or publish credentials.
2. Admit real controlling PTY geometry, actual Harness-loader module reachability,
   main provider EOF, completed settlement, exit zero, and producing/received
   bytes + SHA-256. Retain failed pilots separately.
3. Extend the observation boundary to auxiliary `ctx.llm.stream` calls, recording
   purpose, start, first chunk, EOF/error, route, and overlap with the main call;
   calls pending at final-frame receipt are right-censored. Preserve titles.
   If causal title contention cannot be isolated without changing owner policy,
   report overlap/association and the limitation, not a causal latency saving.
4. Active input probes must distinguish PTY injection, actual composer echo,
   cancellation receipt/handling, and final idle. Keep a typed marker in the
   unsubmitted composer; never send probe text to the provider. Native terminal
   scrollback is terminal-owned, not a fabricated TUI scrolling benchmark.
5. Record submit-to-feedback, first nonempty delta-to-actual-content output,
   submit-to-first-content, typing-to-echo, interrupt-to-handler/idle, frame gaps,
   emitted bytes and writes, composition, Screen, provider awaits, and whole turn.
   A write after a chunk is only a proxy unless visible content is verified.
6. Evaluate a stream-only ~16 ms pacing candidate with urgent input bypass and
   immediate first-delta eligibility. Keep ordinary scheduler/commit behavior
   unless measured smoothness or input latency improves without content delay.
7. Alternate AB/BA order, exclude declared warm-ups, retain output/token/cache
   counts and every outlier, and run no simultaneous builds/tests. Report n,
   median, p95/p99 (descriptive tails for small n), SD, and limits. Separate live
   provider, deterministic PTY, emulator consumption, and physical display claims.

## Verification and delivery

Run focused held-read/command/cancellation feedback cases and status layout tests;
deliberately remove the candidate feedback and require the named cases to fail.
The current dispatch permits only focused local checks; full build/typecheck,
full tests/security/docs, live PTY and provider measurements were not run locally.
Open a draft PR against the TS fast-path branch and record exact-head CI status
without claiming pending checks have passed. Evidence is recorded in RESULTS.md.

No performance samples or passing test results are claimed by this plan.

## Continuation: quota-free streaming/input verification

Use the existing assistant-stream attachment/emulator fixture with the production
RedrawScheduler and key decoder. Interleave long synthetic stream bursts with
unsubmitted composer edits, then exercise legacy and enhanced ctrl-c before any
queued repaint runs. Assert actual cells/cursor, synchronous cancellation,
no inbox delivery, exactly-once durable settlement and retained native scrollback.
Use deliberate key-dispatch and cancellation deferral faults to prove detection.
These are ordering/parity checks, not a latency benchmark or provider simulation.

Inspect write amplification at the owning boundaries. Keep Screen, synchronous
line commits and default check-phase scheduling unchanged absent a parity-safe
production defect. A 16 ms evaluation path is optional, not evidence of a gain;
do not add unused scheduling machinery solely because timing is deferred.
No provider requests, real timing, profile installs, merge or release.

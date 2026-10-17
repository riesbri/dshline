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

## Measurement protocol (not yet run)

The four-core host is reserved by the parallel latency experiment. Do not
install/build, run timing, or run heavy tests until the coordinator clears it.

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
Then build/typecheck/full tests/security/docs, preserving known baseline-host
exceptions rather than quietly filtering them. Open a draft PR against the TS
fast-path branch, bind evidence to exact sources, and obtain exact-head CI.

No performance samples or passing test results are claimed by this plan.

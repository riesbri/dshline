---
'@dshline/dshline': patch
---

Keep a foreign raw write off the terminal the live region owns, so spawning a
subagent stops printing the root chrome into scrollback a second time.

`Screen` is correct only because it is the sole writer: it remembers the live
region's height and where it left the cursor, and every redraw climbs that
remembered geometry to erase the frame before drawing the next one. A write it
did not issue scrolls the screen out from under that geometry, and from then on
the erase starts below the frame's first rows instead of above them — so the
blank separator and `╭─ dshline ─… ─╮` are never erased again, scroll up as
ordinary output, and stay in native scrollback for good. One more copy lands
with every commit that follows.

A subagent backend in the generation named by `HARNESS_TARGET`
(`@deepseek-ai/dsh-subagent-codex@0.1.5-alpha.1`, `startCodexRun`'s stderr
forward) writes a delegated child process's stderr straight to descriptor 2 —
`writeFileSync(process.stderr.fd, bytes)` — unconditionally, for the whole life
of the run. On an interactive launch descriptor 2 is the terminal dshline draws
on, which is why the duplicate appears the moment a subagent starts and has
nothing to do with whether `/work` is open. Nothing in dshline's runtime names
that backend or branches on a provider: what is contained is a write shape.

**This is a temporary compatibility shim, not a dshline abstraction.** The real
fix is upstream — a delegated child's diagnostics belong on a Host-owned
diagnostic seam, not on a frontend's terminal. `src/stderr.ts` carries the
removal condition in its own header, and the shim is registered in a new root
file, `HARNESS_COMPAT`, so it cannot quietly become permanent.

That register lists each temporary workaround with the generation it was last
confirmed to still be needed against, and `node tools/harness-target.mjs` — the
coherence check the Harness-Sync adoption proposal, the blocking `Harness
target` lane and every release already run — fails while a record names any
generation other than the adopted one. So advancing `HARNESS_TARGET` cannot go
green until the adopter decides, per shim: confirm the upstream behavior is
still there and bump the record deliberately, or delete the shim with its
wiring, its tests and its record. A record whose module no longer exists fails
too, so the register cannot outlive what it describes. The check is a string
comparison between two files in this repository — it parses no upstream source,
so nothing couples a build to a backend's internal layout.

Patching `process.stderr.write` would not catch the forward — it never touches
the stream — but it reads `process.stderr.fd` on every write, so that is what
moves: while the window owns the terminal, the descriptor that property reports
is a writable hole. Whether that is safe depends on two Node behaviours, and
both are now pinned by real child processes rather than by stubs: a raw
`writeFileSync` follows the substituted descriptor, and a socket-backed
`process.stderr` — a pipe in the test, a terminal in production, both writing
through a libuv handle opened once — does not, so the ordinary stream path keeps
reaching the terminal. A FILE-backed `process.stderr` is `SyncWriteStream` and
*does* re-resolve the property on every write, which is recorded as the stronger
reason the shim refuses to hold a stderr that is not a terminal.

That refusal is now a real device-identity test rather than an inference.
`isTTY` on both streams does not establish that stdout and stderr are the same
terminal — the previous version of this check claimed it did — so
`rawStderrReach` stats both descriptors: two handles on one terminal report one
non-zero `rdev`, and two terminals report two. It answers `reaches`,
`cannot-reach`, or `unknown`, and holds on the first and the last. A Windows
console reports an `rdev` of zero and lands in `unknown`, where protecting the
frame is the conservative choice; a proven second terminal, a piped stderr and a
`2>log` run are all left exactly as found.

No capture, tee, or logging sink is added. Harness owns Host diagnostics and
subagent failure reporting, and a second authority over the same bytes in the
frontend would be worse than dropping them: a run's own failure reaches the
transcript through the subagent lifecycle, never through descriptor 2, and the
bytes being dropped were unreadable anyway because they were landing on top of
the frame they corrupted.

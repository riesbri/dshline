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

A subagent backend in the adopted Harness generation forwards a delegated child
process's stderr with `writeFileSync(process.stderr.fd, bytes)` for the whole
life of the delegation. On an interactive launch descriptor 2 is the terminal
dshline draws on, which is why the duplicate appears the moment a subagent
starts and has nothing to do with whether `/work` is open. Patching
`process.stderr.write` would not catch it — the forward never touches the
stream — but it reads `process.stderr.fd` on every write, so that is what moves:
while the window owns the terminal, the descriptor that property reports is a
writable hole rather than the terminal. `process.stderr.write` is left alone, so
dshline's own boot-failure reporting and every ordinary stream writer are
unchanged, and a stderr that is not a terminal (`2>log`) is not touched at all.

The cost is stated rather than hidden: a raw-descriptor writer's bytes are now
dropped instead of overwriting the input frame. That loses no failure reporting
— a backend's run failures reach the transcript through the subagent lifecycle,
not through descriptor 2 — and the bytes being dropped were unreadable anyway.
The real fix belongs upstream, in a backend that should not write to a
frontend's terminal; this keeps the frame correct until it does.

---
'@dshline/dshline': patch
'@dshline/renderer': patch
---

Harden the live region's geometry against defects an adversarial terminal
campaign reproduced deterministically.

**Zero-width characters no longer travel.** `wrapToWidth` and `chunkToWidth`
treated every zero-width token as "styling to reopen", so a combining mark, a
variation selector, or a ZWJ seen before a break was replayed onto the next row
and accented the wrong base. Only escape sequences are carried now, and
`tailToWidth` drops a mark whose base the cut discarded. The same escape
tracking is what a long styled line needed: `open` was never cleared on a full
reset, so every continuation row replayed every escape seen so far and a
100k-character line rendered hundreds of megabytes; it now renders in kilobytes.

**`hangingIndent` honours its own contract.** Its wrap budget was derived from
the continuation indent, so a wider first-row mark pushed that row past the
terminal — which the function promises cannot happen. It reserves the wider of
the two and cuts only when the gutter alone is too wide.

**Untrusted chrome labels are width-stable.** A workspace basename containing
East Asian Ambiguous code points (Cyrillic, accented Latin, `±`, …) is measured
one column by `displayWidth` but drawn two by an ambiguous-width terminal, so
the composer's top border wrapped a physical row `Screen` never counted and
every redraw left the previous frame behind — the same failure the ASCII
direction markers fixed, reached through the label. The new `widthStable`
projects only that untrusted text, keeping ASCII, wide CJK, and zero-width code
points, and leaving the renderer's global width policy alone.

**The erase uses what was actually drawn.** `setLive` now caches the CLAMPED
cursor placement, so an out-of-range requested row can no longer make the next
erase descend below the region and leave its top rows. A redraw that repeats the
same logical lines at a new width is no longer skipped, because the terminal has
reflowed the pixels in between. The region is also bounded to the terminal
height at the composition seam: the stream view now honours the row budget every
other view was given, the status line yields when the composition has spent the
terminal, and the composer falls back to its unframed form rather than drawing
three rows onto a two-row screen.

**Overlay disposal is transactional too.** A disposer that throws no longer
skips the redraw that makes the base UI authoritative, and teardown disposes
every mounted overlay instead of stopping at the first failure and leaking the
rest.

**Streamed output is attempt-scoped.** `agent/assistant-stream` frames now
carry their `attemptId` through the listener: `start` adopts a new attempt and
discards any predecessor's transient text, and a `chunk`/`end` from a different
attempt is ignored. Ordering across attempts is an implementation property of
the loop, not a published guarantee, and a late `end` could otherwise reset the
next attempt's buffer and make the durable settlement re-emit a reply the reader
had already seen.

**A trailing-whitespace boundary is presentation-equivalent on either channel.**
The equivalence added for reasoning now applies to text too: the assembler can
return a block that differs from the joined deltas only by a trailing line break
that the rows trim anyway, and the reasoning-only check let the text channel
reprint the whole reply under already-committed scrollback.

The campaign also confirmed a limitation it could not fix within the
native-scrollback model: a terminal that reflows a narrowed live region into
more rows than the screen can hold strands the overflow, and the terminal's
post-reflow cursor position cannot be derived, so climbing the reflowed count
would erase committed scrollback instead. `Screen` therefore keeps the drawn
geometry, the design document states the achievable contract, and
`tests/live-region-oracle.spec.ts` names the case rather than hiding it.

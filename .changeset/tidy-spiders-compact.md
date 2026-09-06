---
'@dshline/dshline': patch
---

Make compaction feedback visible and honest. The `/context` inspector now
shows the classified text of a failed or refused `/compact` (a busy session,
an unknown command) as a notice instead of hiding it behind the overlay, reads
the command registry live so the `c compact` footer follows a changed
composition, and restricts the `c` gesture to the overview where the footer
offers it. Compaction has a longer dispatch timeout than ordinary commands,
because its handler performs an auxiliary model call, and the status line now
reports a `/compact` it is awaiting with its own spinner while the agent stays
idle — for a typed `/compact` — instead of claiming `ready`. Automatic
compaction belongs to Harness and runs inside a running turn, so its progress
is the turn's own busy presentation.
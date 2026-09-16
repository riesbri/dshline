---
'@dshline/dshline': patch
---

Bounded-surface truthfulness fixes found by an audit of every overlay and the
status/banner chrome. A compact fallback no longer cuts a help line into a
fragment (`esc c`, `esc cl`) in Work and the tool-output inspector, and its one
row is bounded even when a phrase or notice carries a newline. Footers name
Enter only when the current selection has an action: the single-choice picker,
the subagent catalog, `/skills`, `/turns`, `/worktrees`, and the lineage
browser no longer advertise an action Enter refuses on an empty, diagnostic,
model-only, or not-yet-loaded row. `/worktrees` escapes a Harness session
listing failure and keeps an action refusal visible at the narrowest geometry,
and `/cache` escapes the recorded route id before drawing it. The committed
banner escapes the workspace path and model id; the multiselect compact
fallback cuts its row to the terminal; and the idle status line drops the whole
context reading instead of cutting it to a different number.

`/connect`, `/plugins`, and `/profiles` also derive the row a gesture acts on
from the current reading and query instead of keeping the previous frame's
filtered array as an authority. Invalidation is coalesced, so a query typed and
confirmed before the next repaint could previously let Enter act on a row the
filter had already removed.


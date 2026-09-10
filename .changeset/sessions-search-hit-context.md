---
'@dshline/dshline': minor
---

Let Sessions search results open bounded surrounding context through Harness's
native session-query read seam.

`Find in this session` still discovers hits with `searchEvents()`, but `↵` on an
ordinary hit now opens a bounded inspector: the exact target event plus a fixed
number of raw events on each side, read once through `readEvent()`. The target
is marked, its neighbors keep their order, and each event's text is Harness's
own semantic extraction, so structural and unknown events show only their type
and sequence. Rendering or moving through results reads no log, and closing the
inspector restores the search's query, results, selection, and viewport
unchanged.

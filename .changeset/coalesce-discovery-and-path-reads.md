---
'@dshline/dshline': patch
---

Stop repeating asynchronous discovery work that a burst of UI changes makes
redundant. Two paths, both of which asked the same authority the same question
several times over and then threw the extra answers away.

Subagent discovery: a burst of lifecycle edges started one recursive
`listDescendants()` walk per edge, and the generation guard discarded all but the
last — so a twelve-edge burst walked twelve catalogs, and on a slow or remote
session query that is twelve round trips spent on results nobody read. One walk is
now in flight at a time and at most one is owed behind it, so a burst costs two
walks and the one that is applied is still the one that began after the last edge.
Teardown aborts the walk in flight through the signal the seam already documents,
and answers nothing, which is still enrichment failing to enrich.

Path completion: typing `@packages/d`, then `s`, then `h` is three refreshes of
one directory, and each was a `resolve` plus a `listDir` of it. Overlapping lookups
of the same directory now share one read. The entry is removed as soon as that
read settles, on failure as well as success: what is shared is work in flight, and
only work in flight, so a file created between two looks at the same directory is
still offered. Matching, sorting, the hidden-file rule, and the generation guard
are untouched.

Measured: a twelve-edge burst against a 40 ms catalog went from 13 walks to 2, and
three keystrokes in one directory from three resolve/listDir pairs to one. The
coalesced burst's last discovery lands at most one walk later than before (79 ms
against 67 ms for that shape), which is the trade for eleven fewer walks.

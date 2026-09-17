---
'@dshline/dshline': patch
---

Bound the ordinary `/sessions` listing to the rows it keeps. The catalog used to
project every authoritative record into a `SessionEntry` before slicing the
result to its 200-row presentation limit, so a large corpus built a second, full
presentation array whose length was needed only for the exact `truncated`
count.

The origin-all listing (`origin === 'all'`, which may still be workspace/age
filtered by Harness) now works from the retained prefix alone: with no origin
choice there is no presentation predicate, `records.length` is already the exact
authoritative total, and a 10,000-session corpus materializes about 200 rows
instead of 10,000. An origin-filtered listing still reads every authoritative
header, because Harness publishes no origin predicate and the exact total must
count qualifying rows past the limit, but it too materializes at most the
retained limit. In both cases `truncated`, `newest of N`, Harness order, origin
classification, and the single batched title observation are unchanged. An
origin-only browser filter now uses the plain corpus listing rather than calling
`filterSessions` with an empty clause list.

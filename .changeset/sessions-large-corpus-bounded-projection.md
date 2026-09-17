---
'@dshline/dshline': patch
---

Bound the ordinary `/sessions` listing to the rows it keeps. The catalog used to
project every authoritative record into a `SessionEntry` before slicing the
result to its 200-row presentation limit, so a large corpus built a second, full
presentation array whose length was needed only for the exact `truncated`
count. It now scans the authoritative records in Harness order, counts every
qualifying row without materializing it, and projects at most the retained
limit. A 10,000-session corpus allocates about 200 rows instead of 10,000, and
the `truncated` count, `newest of N` reading, Harness order, origin
classification, and the single batched title observation are unchanged. An
origin-only browser filter now uses the plain corpus listing rather than calling
`filterSessions` with an empty clause list.

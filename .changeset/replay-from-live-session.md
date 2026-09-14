---
'@dshline/dshline': patch
---

Resumed conversations now rebuild their terminal transcript directly from the
live Harness Session returned by `agents.resume()`, so history no longer depends
on the optional session-query service or performs a redundant second session
read.

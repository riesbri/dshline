---
'@dshline/dshline': minor
---

`/cache` opens a bounded read-only inspector for this session's provider cache
usage: the cache-read share and the prompt buckets behind it, from the same
Harness accounting `/usage` reports, beside the latest request header Harness
recorded — route, system prompt, tool count — read through
`Session.requestHeader()`.

Figures appear only when the provider reported a cache read, because Harness's
optional cache counts fold to zero when absent and an adapter that reports none
is indistinguishable from a cache that went cold. It observes and changes
nothing, holds no history, and claims no saving, waste, or cause.

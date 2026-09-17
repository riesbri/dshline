---
'@dshline/dshline': minor
---

Page forward through durable subagent conversations with `]`, paired with `[` for
older history. Both directions replace one bounded page within the index captured
on opening or refresh; only `r` refreshes that index and loads newly appended
events. The footer advertises available directions, paging preserves the new-event
hint, and a failed newer read keeps the current page.

---
'@dshline/dshline': patch
---

`/work` now shows a bounded, transient tail of the newest assistant text from a
running locally observable subagent directly in that child's detail view, so a
reader can see what a child is answering without leaving Work. Only streamed
`text-delta` chunks reach the tail; reasoning and tool-call fragments never do.
The tail is transient presentation owned by the existing per-child activity
observer and scoped to one model attempt, so a settled or retried attempt cannot
prefix the next one, and it is discarded on the attempt's end, the child turn's
end, or the child's disposal. A provider-managed child with no locally
observable Agent shows no tail, and the durable conversation remains available
through `/subagents` and the direct `c` navigation.

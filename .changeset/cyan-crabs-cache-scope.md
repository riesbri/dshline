---
'@dshline/dshline': patch
---

`/cache` now says what its accounting is, and `/model` says what a real switch can cost.

The `/cache` inspector gained one scope caption under its figures — "Session
cumulative · includes requests across provider/model changes" — so the session
totals cannot be read as the route named in the header section below. A
provider/model change is a request boundary, not a reset boundary for this
metric, and Harness's `tokenUsage` fold stays the single cumulative authority.

`/model` now emits one informational note on its own second transcript line when
the switch actually moves to a different provider or model: "cache reuse after a
provider/model change is provider-dependent; /cache remains session-cumulative".
The note claims neither outcome — no promise that cache is lost, no promise that
it carries over — and depends on the move alone: re-selecting the active route
says nothing, a pick that applied nothing says nothing, and there is no guard,
confirmation, or automatic routing. It deliberately reads no usage projection,
so no snapshot timing can affect whether it appears.
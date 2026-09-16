---
'@dshline/dshline': patch
---

`/work` now opens the selected subagent's durable conversation directly when
Harness discovery has published the child's complete descriptor, addressing it
by durable child session id rather than by the lifecycle `runId` that keys the
Work row. Work keeps the conversation catalog as the fallback for non-subagent
stages and for a child whose durable facts discovery has not supplied, so `c`
still reaches every durable conversation. The Work footer names the action the
key will actually perform (`c conversation` versus `c conversations`), and the
catalog footer reports `enter inspect` only when the focused row is openable
while distinguishing a root `/subagents` catalog (`esc close`) from one opened
over `/work` (`esc back`).

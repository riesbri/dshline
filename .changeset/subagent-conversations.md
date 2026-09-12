---
'@dshline/dshline': minor
---

Add durable subagent conversations. `/work` now hands off to a separate subagent
conversation view (`c`, or `/subagents`) built on Harness's durable direct-child
discovery rather than active lifecycle epochs, so a continuable child stays
browsable and continuable after its current turn settles. Opening a child reads
its own session log through `ctx.sessionQuery` without resuming it and renders a
bounded conversation that retains one page of full event bodies at a time;
paging older history replaces the window instead of accumulating. A continuable
child can receive a human follow-up (`m`, queued) or steer (`s`), both through
Harness's human prompt operation; the message composer scrolls with its cursor
like the main input. Interrupt stays on `/work`, where an open lifecycle epoch
is the stronger premise — a durable child's residency is not proof of a turn. A one-shot
child is inspectable and read-only, diagnostics are shown honestly, and a profile
without `ctx.subagents` or `ctx.sessionQuery` still boots with the actions
unavailable.

---
'@dshline/dshline': minor
---

Add durable subagent conversations. `/work` now hands off to a separate subagent
conversation view (`c`, or `/subagents`) built on Harness's durable direct-child
discovery rather than active lifecycle epochs, so a continuable child stays
browsable and continuable after its current turn settles. Opening a child reads
its own session log through `ctx.sessionQuery` without resuming it and renders a
bounded, paged conversation. A continuable child can receive a human follow-up
(`m`, queued) or steer (`s`), both through Harness's human prompt operation, and
an interrupt (`k`) through the same adapter `/work` already used. A one-shot
child is inspectable and read-only, diagnostics are shown honestly, and a
profile without `ctx.subagents` or `ctx.sessionQuery` still boots with the
actions unavailable.

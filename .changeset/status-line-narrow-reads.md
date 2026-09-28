---
'@dshline/dshline': patch
---

Make the status line read only what it draws. The footer repaints on every
spinner beat, every streamed delta, and every tool transition, and it was asking
the projection registry for every unit a profile registers — each one folded,
viewed, and validated against its own schema — to use five of them. The read now
names them (`permissions`, `tokenUsage`, `contextPressure`, `todos`, `goal`),
which is a narrower question to the same authority at the same `asOfSeq` position
and not a cache: a unit that moves still drives the same invalidation, and
nothing is remembered. `contextBreakdown` is left out on purpose, because the
footer's token figure is `contextPressure` alone and the composition belongs to
`/context`, which still reads it.

The work segment takes the same shape. A workflow's claim on its own live children now follows the durable member
records rather than the live `workflow/end` report, in both count paths. A run
that has reported its result can still owe a member's ending — child endings are
synthesized while `dispose()` reaches quiescence — and until it does, the
workflow's own row is presenting that child, so counting it as a loose subagent
as well reported one Harness child as two pieces of work.

`workSummary(work.snapshot())` built
fully enriched Work rows — a child activity fold, a `requestHeader()` route
read, a keyed child projection cut, an inherited-event count per live subagent, a
member sort and child join per workflow run, a row per job — and then reduced
them to three numbers. `HarnessWork.summary()` now counts those three straight
from the same authorities, and both paths format through one function so they
cannot disagree. Measured on the real registry, the projection read is 2.2–2.4x
cheaper per repaint at 8–28 registered units; the work segment is 3.2x cheaper
at four live subagents and 6.2x at sixty, since its cost no longer grows with the
children a session has running.

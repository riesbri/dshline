---
'@dshline/dshline': minor
---

Open a bounded read-only goal inspector on a bare `/goal`.

`/goal` previously did nothing visible on its own; `/goal <objective>` went
straight to the Harness command. A semantically bare `/goal` — no argument, and
no staged attachments — now opens a live inspection instead: the durable phase,
the round count against the cap, the revision, the created and updated
timestamps, the full objective, and the blocker while one is set. It reports
whether this process will continue the goal as its own row, so a resumed
session reads `Phase active` and `Continuation disarmed` as the two separate
facts they are. Everything durable comes from the `goal` projection and only
activation comes from `ctx.goals`, both re-read on every paint; a goal edit, a
block, a clear, and a process-local disarm all repaint an open inspector.

The report is read-only: opening it executes no command, appends no
`command/run`, `command/done`, goal, or session event, and mutates nothing. A
long objective scrolls with `↑`/`↓`, and `esc` or `ctrl-c` closes it. Every
argument-bearing form — an objective, `edit`, `pause`, `resume`, `clear` — and
a bare line carrying staged images go to the registered Harness command
unchanged, and an agent-scoped shadow of the name is left for the registry to
resolve rather than being intercepted.

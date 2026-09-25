---
'@dshline/dshline': minor
---

Enrich `/work` Jobs with Harness-native live progress, non-consuming output
inspection, and confirmed human stop controls.

A running job now shows the producer's own progress line, verbatim and never
parsed. `↵` on a job inspects the output it has retained, through the registry
read documented not to move the model cursor, so watching a job's output cannot
take a byte from what the agent is about to be told. That read happens only
while a job's detail is actually open, and the detail keeps its own bounded
retention, so browsing the list costs nothing and a long job does not grow
memory. Where earlier output is unavailable — the registry's retention, a
producer gap, or dshline's own bound — the view says so once per missing
stretch instead of splicing silently.

A running job can be stopped from its detail with two presses of `k`, addressed
by id through the generic registry cancellation, so every job kind gains it at
once. This is safe for a human because the adopted Harness generation moved
model-delivery bookkeeping out of the registry and into `dsh-tool-jobs`: a
human stop leaves the owning agent's ordinary completion notice due, and dshline
claims no delivery and never enters the model's tool path. The arming is bound
to the job's own identity rather than a row position, and the confirming press
re-validates against current authority instead of acting on a successor.

`/work` remains an active-work surface and is deliberately not a job history: a
job that settles leaves the roster immediately and takes any open detail with
it. Nothing is cached to keep a finished job reachable.

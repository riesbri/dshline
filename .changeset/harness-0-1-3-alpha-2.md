---
'@dshline/dshline': minor
---

Adopt DeepSeek Harness `0.1.3-alpha.2`, whose session format v2 splits durable
Assistant history from live Assistant presentation.

The session log no longer carries per-delta `assistant/chunk` events. A model
attempt now settles once: `assistant/message` when it committed a reply (with
`interrupted: true` for a prefix a `ctrl-c` cut short), and the log-only
`assistant/attempt` when it produced no reply at all — each embedding its own
compacted stream. Frame-by-frame output arrives instead on the agent-scoped
`agent/assistant-stream` notification.

dshline consumes both natively and keeps them apart. The `session/event`
projection is now purely the committed transcript, and a session-scoped listener
on the attached Agent's stream frames owns the live region, live reasoning, the
activity word, and the model's reasoning/output timing — measured from the
timestamp each frame carries.

What changes for a reader: a failed or retried model attempt can no longer leave
a partial answer in the scroll history as though the model had said it, and a
new attempt starts from nothing instead of settling against text its predecessor
streamed. The timing panel separates reasoning and output per model attempt, so
a retry's dead time is no longer charged to the model. An interrupted reply
still lands in the transcript, now from its own durable message rather than from
a turn-boundary salvage.

Registered slash commands take the harness's generic attachment admission:
`input.attachments` replaces `input.images`, and image drafts are submitted as
discriminated `{ type: 'image', … }` attachments. Drafts are still kept when a
command cannot accept them or its execution fails, and dshline still authors
only image attachments — command file receipts are the harness's other variant
and no dshline UI stages files.

---
'@dshline/dshline': minor
---

Adopt DeepSeek Harness `0.1.3-alpha.1`, and migrate the transcript, the status
activity word, the turn timer, and Work's per-child activity onto the streaming
contract that generation actually has.

Harness session format v2 stores one durable settlement per model attempt —
`assistant/message`, or `assistant/attempt` when a call failed, retried, or was
cancelled without committing a message — each carrying its own exact timed
stream. The per-delta `assistant/chunk` log event that dshline read streaming
text, reasoning, first-token timing, and the `thinking`/`responding` status word
from no longer exists. Live streaming is now published as transient
`agent/assistant-stream` frames instead, so the frontend reads it from there and
the durable log stays what it always should have been: what a resumed session
replays.

That split deletes rather than adds. The replay filter that had to skip chunk
events is gone — there is nothing left in the log to skip, and an
`assistant/attempt` simply draws nothing. The shared projection no longer
carries a branch the replay could never reach. Turn spans are keyed by attempt
rather than by step, so a step that retried after a stream error no longer
reports the gap between its two attempts as time the model spent producing text.

Command attachments follow the registry's renamed input flag (`input.images` →
`input.attachments`) and its submission envelope, whose image arm now carries an
explicit `type: 'image'` beside a staged-file arm dshline does not produce.
`/image` behaviour is unchanged.

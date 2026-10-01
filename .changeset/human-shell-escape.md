---
'@dshline/dshline': minor
---

Run one-shot human shell commands with a leading `!` in the attached session's workspace through Harness's shell and current sandbox policy. Stream safe local output with exit and interruption status, prioritize the active shell on Ctrl-C, and keep staged attachments and ordinary prompt scheduling independent. Commands and output never enter model context or durable session history; local input history remains available. Cleanup requests stay Harness-owned and do not claim whole-process-range quiescence before a session switch.

---
'@dshline/dshline': minor
---

Run one-shot human shell commands with a leading `!` in the attached session's workspace through Harness's shell and current sandbox policy. Stream safe local output with exit and interruption status, prioritize the active shell on Ctrl-C, and keep staged attachments and ordinary prompt scheduling independent. The composer frame switches to the theme's shell attention color as soon as the draft's first meaningful character is `!`, before anything is submitted, and returns to normal the moment that `!` is gone; the draft itself stays ordinary editable text. The frame stays in that shell state, with a live row naming it in words, while the submitted operation runs, and both return to normal once it settles. Commands and output never enter model context or durable session history; local input history remains available. Cleanup requests stay Harness-owned and do not claim whole-process-range quiescence before a session switch.

---
'@dshline/dshline': patch
---

Tear down a session attachment whose setup fails before the Agent handle is disposed. A session that could not start used to leave its window exit hook, key handler, live rows, listeners and running Agent behind, so a failed start could keep painting, consume keystrokes and run beside the session that replaced it.

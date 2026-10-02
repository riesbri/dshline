---
'@dshline/dshline': patch
---

Stop asynchronous work started by a session from acting after that session has been retired. A submitted command whose skill verification was still in flight could reach the Agent the window had already left and commit to a transcript the next session had taken over.

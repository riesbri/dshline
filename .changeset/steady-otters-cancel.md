---
'@dshline/dshline': patch
---

Make exit cancellation best-effort and unconditional: maintenance activity is interrupted even when the public Agent status is idle, while a synchronous cancellation failure can no longer prevent the Harness shutdown request.

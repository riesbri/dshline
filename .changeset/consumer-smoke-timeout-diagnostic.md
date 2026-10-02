---
'@dshline/dshline': patch
---

Report whether the published-consumer smoke lane failed because a command exited non-zero or because it hung until the timeout. `execFile` raises the same rejection for both and captures the same output, so the two produced byte-identical failure reports and a hang was indistinguishable from an ordinary installer error.

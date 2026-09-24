---
'@dshline/dshline': patch
---

The `/model` → `ctrl-k` Subagent models editor now describes the authorization
the adopted Harness generation actually enforces: the exact `provider/model`
routes are an allowlist for explicit route choices made through the subagent
delegation tool, while a workflow script's own `agent()` child routes are
outside it. A disabled setting with retained routes reads
`N saved models · inactive` instead of implying those routes are currently
authorized, and `/model`'s documentation states the same limitation.

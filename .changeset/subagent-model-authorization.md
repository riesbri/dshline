---
'@dshline/dshline': minor
---

`ctrl-k` on the bare `/model` picker now opens a Subagent models editor that
reads and writes Harness's own `subagent-model-selection` setting through the
generic settings document: an explicit allowlist of exact `provider/model`
routes the driving model may request for a delegated child. It is
authorization, not routing — a delegation that names no route still inherits
the parent's, and the editor never forces a child onto an allowed route. The
change applies to newly composed top-level Sessions; the current Session keeps
its recorded policy. A saved route the live catalog no longer advertises stays
visible, authorized, and removable. Saving writes both fields in one
revision-fenced mutation, a conflict keeps the draft and reports itself, and
`esc` discards without writing. `/model provider/model`, `/setup`, and command
completion are unchanged, and the bare picker's footer now advertises
`ctrl-k subagents`. The shared select overlay gains only a generic,
owner-supplied footer-help list, so it stays unaware of subagents, Harness, and
this key.

---
'@dshline/dshline': patch
'@dshline/renderer': patch
---

Dismissing the launch session browser no longer starts a new session. When you
launch with an explicit resume request (`--resume` or an id), pressing `esc` (or
`ctrl-c`) in the Sessions browser cancels the launch and exits the window
instead of silently creating an unnamed session in the launch directory; the
same applies after a failed resume. Every new session still traces to normal
launch or explicit `/new`, `/clear`, or `/worktrees` intent.

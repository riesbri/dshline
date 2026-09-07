---
'@dshline/dshline': minor
---

Add `/worktrees`: choose the code workspace to work in, then a conversation there or a new one.

The picker is workspace-first, because a worktree is not a session — several
conversations can be rooted in one directory, so selecting a directory opens
that directory's sessions and a `+ New session` row rather than resuming
whichever one is newest. It reads two Harness authorities and joins them on the
canonical path Harness itself stamped: `ctx.workspaceRegistry` for the durable
records over working directories, and the same `ctx.sessionQuery` catalog
`/sessions` already uses, scoped to the selected workspace's exact `cwd`. This
bundle now composes `@deepseek-ai/dsh-workspace` as a host-plane row, as
upstream's own web bundle does; a profile without it says so and offers nothing
else.

A choice becomes one of the two attachment targets that already existed —
`ctx.agents.resume` for a session, `ctx.agents.create` with the selected
workspace's `cwd` for a fresh one — under the same refusals `/sessions` and
`/new` apply, so one dshline window still drives one root Session. A fresh
session's workspace membership is written through `Workspace.attachSession`
after creation succeeded, mirroring Harness's own session controller: a failed
creation leaves no membership behind, and a failed attach is reported rather
than repaired by destroying the session that was created exactly as asked.

Git worktree creation, removal, and state are deliberately absent: the adopted
Harness generation publishes no Git or worktree capability, so a row carries
Harness's title, path, and session count and nothing else, and a Git worktree
that Harness has never been used in does not appear yet.

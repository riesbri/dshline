---
'@dshline/dshline': minor
---

Add `/worktrees`: choose a working directory represented in your Harness session history, then a conversation there or a new one.

`/sessions` answers "which conversation". `/worktrees` answers the question
before it, and reads the same authority to do it: `ctx.sessionQuery`'s logical
corpus, grouped by each session's own immutable `SessionHeader.cwd`. A row IS
"the sessions whose header records exactly this cwd", so it needs no id, no
title, and nothing durable — the grouping key is the definition, it lives only
while the picker is open, and the count in the first view and the rows in the
second are one relationship read twice.

The picker is directory-first, because a working directory is not a session:
several conversations can be rooted in one, so selecting a directory opens that
directory's sessions and a `+ New session` row rather than resuming whichever
is newest. The second view is the same `SessionCatalog` `/sessions` already
uses, scoped to that exact `cwd`.

A choice becomes one of the two attachment targets that already existed —
`ctx.agents.resume({ id })` for a session, `ctx.agents.create` with the
selected `cwd` for a fresh one — under the same refusals `/sessions` and `/new`
apply, so one dshline window still drives one root Session. A fresh session
needs no follow-up write: Harness stamps `cwd` into its header, and that header
is the grouping rule. Nothing is persisted, and no new dependency or
composition row is added.

The session corpus is deliberately the authority rather than Harness's durable
Workspace registry. At the adopted generation the domain storage that registry
sits on is single-process by upstream's own documentation —
`dsh-storage-domain`'s `domain/changed` is in-process and "a second host
process observes no changes", and `dsh-storage-json` has "no cross-process
write locking" with last-completion-wins — so several terminals mutating it
would hold stale state and overwrite each other. Session persistence is the
right shape for this: one artifact per session, one live writer per session,
and a fresh listing on every corpus read.

Limits, stated rather than worked around: a Git worktree Harness has never had
a session in does not appear yet; enumerating, creating, and removing worktrees
stay out because the adopted generation publishes no Git or worktree
capability; and neither `/worktrees` nor `/sessions` can tell whether a
persisted session is already open in another dshline process, because Harness
publishes no cross-process ownership contract — its own live-session refusal
consults this process's store only. The shipped JSONL backend requires one live
writer per session, so the same session must not be driven from two processes
at once.

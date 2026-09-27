---
'@dshline/dshline': minor
---

Show what each turn changed in `/turns`, and open a bounded per-file diff.

A turn Harness recorded workspace changes for now carries a `Δ 8 files · +384
-91` mark in the outline, and `enter` on that turn's inspection view opens its
changed files. `enter` on a file opens Harness's comparison of that file
between the turn's start and its end — hunk headings, added and removed lines,
and surrounding context — in a bounded surface that leaves native scrollback
alone. `esc` returns one level at a time.

Harness owns all of it. `@deepseek-ai/dsh-workspace-changes` snapshots the
working tree around each top-level turn, appends one `workspace/changes` event
naming it, counts the lines, computes the hunks, and serves the summary and each
comparison from the process that recorded them. dshline runs no Git, reads no
file, and keeps no summary, hunk, or changed-file list of its own.

The absences stay honest rather than being smoothed into a tidy list. A turn with
no record carries no column at all, never a fabricated `Δ 0 files`. A binary or
oversized file is labelled with Harness's own refusal instead of an empty
`+0 -0`. A summary Harness truncated says how many files it holds out of how
many changed. A comparison whose line diff timed out upstream is labelled coarse
instead of being presented as an exact hunk. And because Harness keeps each
summary only in the process that captured it, a reopened session says *Changed-
file comparison unavailable in this Host* rather than showing nothing a reader
could mistake for a turn that changed no files — dshline does not rebuild the
comparison from the files now on disk, because what those files hold is not what
that turn wrote.

Comparisons are disclosure-gated. A summary is an in-memory lookup Harness
already made, so the outline reads one per row it actually draws; a comparison
is a Git read, issued only by `enter` on one file, and aborted when its
inspector closes. Every surface, fold, and pending read belongs to the
attachment's session scope, so opening another session leaves none of it alive.

The bundle mounts the recorder as an ordinary host-plane composition row,
beside the two projection rows `/turns` and `/usage` already read, and `/plugins`
can turn it off. A profile that mounts no such row keeps every other `/turns`
behaviour and says in one line that this composition mounts no workspace-change
records.

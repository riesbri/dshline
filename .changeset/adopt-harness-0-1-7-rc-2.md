---
'@dshline/dshline': minor
---

Adopt DeepSeek Harness 0.1.7-rc.2 natively.

Harness replaced the directory-of-preset-files agent preset architecture. The
`@deepseek-ai/dsh-agent-presets` package is gone, and a preset is now an
ordinary `@deepseek-ai/dsh-agent-preset` declaration row in a Cordis
composition, resolved through the new
`@deepseek-ai/dsh-agent-preset-registry` service. The registry neither scans
directories nor accepts preset paths, which removes the fields the old roster
reported and the writes it offered.

`/plugins` is migrated to the native contract. It still browses the roster,
still reads one declaration's composition — now through `readDocument()`, which
renders the declared child list back as entry-list YAML and accepts nothing in
return — still switches a blank session through Harness's own `select()`, and
still makes a preset the default. Setting that default now writes the
`selectedDefault` volatile field of the `agent-preset-registry` entry rather
than an `agent-presets.default` setting in a namespace that no longer exists.

Two `/plugins` capabilities are gone because the architecture withdrew them, not
because dshline narrowed them. The roster no longer reports a `trust` or an
`authorable` root, there is no `copy()` to fork a shipped preset with, and there
is no `path` to write — so the copy-to-customize flow and the `space`/`enter`
row toggle are deleted, and a composition is now read-only in a terminal. A
composition changes through Harness's own profile-patch reconciliation
(`ctx.configEditor`, or a bundle patch installed with `plugin_manager`), and a
second YAML-splicing path beside it would be a second authority over the same
file. `/plugins` keeps the two whole-composition intents that do survive: choose
a preset, and make it the default.

This bundle now ships its own `standard` and `minimal` preset declarations
(`presets/*.patch.yml`), because a preset is no longer something a deployment
finds in a shipped directory. `dsh.bundle.patch` is a list for the same reason
upstream's own web bundle uses one.

Sessions: the projection cache's read is now header-only. The adopted
generation matches a cached checkpoint against the lifecycle identity a header
alone witnesses — `formatVersion`, `createdAt`, `cwd`, `isSeeded` — so a cold
seeded session, which the pinned generation could not serve at all, now gets
the same provisional title hint as an unseeded one. dshline passes the header
and nothing else and never reconstructs an inherited count. The progressive
title hydration it already shipped is unchanged, and `ctx.sessionQuery` gained
no projection-bearing list API, so the metadata-list plus provisional-hint
architecture stays.

Work and Subagents: `JobSnapshot` is `JobView`, the job change feed is the
`ctx.jobs.events` subscription rather than `onJobsChanged`, and job registry
calls take a session id. Both subagent browsers now read
`listDescendants()` filtered to direct children, because `listChildren()` no
longer reports a child's `activity`, whether it has children, or a diagnostic
for a branch whose catalog cannot be read. A branch Harness reports as
unreadable, unsupported, or temporarily unavailable is now shown rather than
dropped.

Settings: a settings namespace is a profile entry id and only volatile fields
are writable; the `settings/updated` event is replaced by
`settings/document-updated`. The `subagent-model-selection` namespace is now the
`subagent-model-selection-settings` entry this bundle inserts.

A `tool/result` message now carries its own `toolCallId` and `isError` rather
than wrapping them in a content block, and a compaction checkpoint is marked by
a dedicated `compact-checkpoint` message source rather than a plugin-named
source plus an out-of-band id.

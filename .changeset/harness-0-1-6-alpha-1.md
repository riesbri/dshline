---
'@dshline/dshline': minor
---

Adopt DeepSeek Harness `0.1.6-alpha.1`, natively.

The generation moves two things dshline consumes, and each one is migrated
forward rather than shimmed:

- **Permission is two authorities, not one.** `PermissionSelect` is gone.
  `PermissionCatalog` is live, process-level selectable state read through
  `permissionPresets.catalog()`; `PermissionSelection` is the durable current
  value the `permissions` session projection now carries alone. The terminal
  picker joins them at the moment it opens and keeps neither, so the catalog is
  re-read per interaction instead of cached — dshline holds no catalog state and
  subscribes to no catalog change. Mutation stays on the `/permission <preset>`
  command seam, so an option withdrawn while a picker was open is refused by
  Harness rather than filtered by dshline. `custom` is reported as a current
  value and offered as nothing, because Harness derives it and lists it in no
  catalog. Picker-originated Full Access keeps its confirmation, and the live
  `auto` review preset gains the same one: Harness publishes no per-option risk
  metadata, so this stays a small explicit frontend policy matching Harness
  Web's human-control model.
- **`agent/session-start` is gone.** `agent/created` absorbs its role and is
  now agent-scoped, serial, awaited, and part of publication. dshline
  subscribes to no agent lifecycle event in production, so this is a probe
  migration: the Goal probe drives the real awaited edge through
  `agentEvents(ctx, agent).serial('agent/created', …)`, and the agents probe
  awaits `announce(agent, 'startup')` — under the new contract a detach
  requested while that dispatch is in flight is deferred until it settles.

The stderr containment shim in `HARNESS_COMPAT` was reconfirmed against this
generation rather than advanced blindly: upstream's
`subagent-codex/src/run.ts` is byte-for-byte unchanged, so the direct
descriptor-2 write it contains is still there.

No compatibility with `0.1.5-rc.2` is retained.

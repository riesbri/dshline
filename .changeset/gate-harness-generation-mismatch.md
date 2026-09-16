---
'@dshline/dshline': patch
---

Stop startup on a confirmed Harness generation mismatch.

dshline supports one adopted Harness generation at a time, but a Host built for
a different one was only warned about and then allowed to open a session. The
report's `⚠` already named both exact versions and the deterministic recovery
command, and the session that followed could still reach generation-specific
APIs that the installed Host does not have — `/permission` failed with
`ctx.get(...)?.catalog is not a function` on `0.1.5-rc.2`, because that release
registers `permissionPresets` without the `catalog()` the adopted
`0.1.6-alpha.1` API provides.

A confirmed mismatch now prints that same report and refuses to open a session,
leaving `ctrl-d` as the only way out and the report's
`npm install -g @deepseek-ai/dsh@<adopted>` as the way forward. The gate reuses
the one generation comparison the report already trusts, so only a confirmed
`mismatch` blocks: a version that cannot be read stays the `·` diagnostic it
has always been. This is not compatibility with an older Harness — nothing
falls back, feature-detects, or widens a peer range.

---
'@dshline/dshline': patch
---

Remove two obsolete `cordis.patch.yml` rows.

The adopted Harness generation's `dsh-base` no longer mounts
`tool-str-replace-editor` or `workflow-worker-thread`, so the disables dshline
carried for them matched no row and the Loader printed
`patch: entry "..." not found` on every load, including
`dsh --profile dshline --dump-config`. Both entries are deleted with the rows
they named; every row still present in the composition is unchanged.

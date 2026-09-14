---
'@dshline/dshline': patch
---

Important live state changes such as context compaction, model or reasoning
changes, and permission-preset switches are now highlighted briefly in the
status line. The emphasis keeps the applied change visible while output
continues, without replacing the record it already has: compaction and
permission changes are Harness-backed durable events, while local model and
reasoning changes keep their committed scrollback acknowledgement.

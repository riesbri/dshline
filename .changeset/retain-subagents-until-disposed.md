---
'@dshline/dshline': minor
---

Keep subagent rows visible as `stopping` after `subagent/end` until DeepSeek Harness
publishes `subagent/disposed`, so `/work` and idle `ctrl-c` reflect authoritative
resource ownership without preserving execution activity or interrupt authority.

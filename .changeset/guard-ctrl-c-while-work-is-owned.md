---
'@dshline/dshline': patch
---

Keep idle `ctrl-c` from closing dshline while Harness still publishes a Job or
subagent owned by the current session.

One-shot `subagent/end` reports `run.result` settlement, not completion of the
consumer-owned `run.dispose()` teardown. The standard background tool path keeps
that interval visible through its nonterminal Job, while foreground work keeps
the parent Agent running until disposal returns. The terminal now reads the
generic Work snapshot before treating idle `ctrl-c` as quit; explicit `ctrl-d`
remains the unconditional exit boundary.

---
'@dshline/dshline': patch
---

Let the row you have selected in `/sessions` reach its title before rows you scrolled past. Title reads stay deduplicated and bounded — an id already queued is reordered, never read twice, and an id already being read is left alone.
---
'@dshline/dshline': patch
---

Make `/sessions` and `dshline --resume` publish their metadata listing before
exact title hydration. Visible and selected rows are hydrated in bounded
batches, unresolved/provisional titles are represented honestly, incomplete
title filtering is reported as incomplete, and closing or replacing the picker
abandons obsolete title work. This avoids opening hundreds of cold session logs
just to make the picker interactive.

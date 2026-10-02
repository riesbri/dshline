---
'@dshline/renderer': patch
---

Preserve wide characters and mixed styling when word wrapping retains a suffix. Recheck the continuation's column capacity before appending another glyph, and close/reopen styling at the selected word boundary so boxes neither lose content nor render continuation characters under the wrong style.

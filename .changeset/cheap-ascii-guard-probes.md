---
"@dshline/renderer": patch
"@dshline/dshline": patch
---

Avoid expensive Unicode-regex scans in opt-in native leaf admission guards and repeated chunk-row reallocations, preserving exactly the existing TS exclusions, defaults, width policy and fallback.

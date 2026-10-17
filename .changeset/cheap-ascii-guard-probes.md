---
"@dshline/renderer": patch
"@dshline/dshline": patch
---

Avoid expensive Unicode-regex scans in opt-in native leaf admission guards, preserving exactly the existing TS exclusions, defaults and fallback.

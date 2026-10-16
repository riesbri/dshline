---
'@dshline/renderer': patch
'@dshline/dshline': patch
---

Accelerate Unicode width lookup and route bounded Screen/frame width and wrapping
through the shared optional native primitives. Keep TypeScript host ownership,
reference fallback, malformed UTF-16/ANSI semantics and native error admission.
Reuse measured bounded fit prefixes and make sliced malformed UTF-16 scanning
consistent with identical flat code units.

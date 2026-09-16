---
'@dshline/dshline': patch
---

The status line now names the route the next model step will use as
`provider/model`, so two provider routes advertising the same model id no
longer read as one selection. While a running step was assembled from a
different selection — `/model` or `/reasoning` pressed mid-step — the segment
is prefixed `next` until Harness captures the new selection; the banner still
shows the identity it attached with. Overlay notices that declare a lifetime
now ask for one repaint when it ends, so a result no longer stays on an idle
terminal until some unrelated paint clears it.

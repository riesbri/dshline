---
'@dshline/dshline': patch
---

The status line now names the live selected route as `provider/model`, so two
provider routes advertising the same model id no longer read as one selection.
While the Agent is running and that selection cannot be confirmed against the
selection Harness has published for the active assembly or request — `/model`
or `/reasoning` pressed mid-step, or an assembly still in flight — the segment
is prefixed `selected` until the two agree; the banner still shows the identity
it attached with. Overlay notices that declare a lifetime now ask for one
repaint when it ends, so a result no longer stays on an idle terminal until
some unrelated paint clears it.

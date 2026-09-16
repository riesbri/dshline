---
'@dshline/dshline': patch
---

The status line now names the live selected model as `provider/model`, so two
provider routes advertising the same model id no longer read as one selection.
It reports the selected configuration only: the route a model step in progress
has privately captured is Harness execution state that the public selection ref
cannot prove, so the footer neither infers nor annotates it. The banner still
shows the identity it attached with. Overlay notices that declare a lifetime
now ask for one repaint when it ends, so a result no longer stays on an idle
terminal until some unrelated paint clears it.

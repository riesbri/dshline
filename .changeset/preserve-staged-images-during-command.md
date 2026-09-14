---
'@dshline/dshline': patch
---

Preserve an image staged while a registered Harness command is in flight. A
command now consumes only the image drafts admitted as part of its own
submission: a successful command that received nothing no longer discards a
path the reader staged while it ran, and a command that did receive the staged
batch still consumes exactly that batch.

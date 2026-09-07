---
'@dshline/dshline': patch
---

Make `/exit`, `/quit`, and the equivalent quit gestures cancel active attachment work before requesting shutdown. Exit no longer waits for replay input gating, and image admission and command execution receive attachment-lifetime cancellation.

Improve `/sessions` clarity by labeling delegated child sessions in the list and showing `current` instead of `untitled` for the open session when it has no title.

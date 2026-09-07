---
'@dshline/dshline': patch
---

Make `/exit`, `/quit`, and the equivalent quit gestures cancel active attachment work before requesting shutdown. Exit no longer waits for replay input gating, and image admission and command execution receive attachment-lifetime cancellation.

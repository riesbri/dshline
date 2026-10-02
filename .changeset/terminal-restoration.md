---
'@dshline/dshline': patch
'@dshline/renderer': patch
---

Restore raw mode and release terminal listeners even when setup or shutdown writes fail. Roll back partial acquisition, keep terminal cleanup independent of Screen cleanup, and preserve failures without repeating keyboard-protocol shutdown on duplicate close.

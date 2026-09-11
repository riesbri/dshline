---
'@dshline/dshline': patch
---

Roll back an overlay when its `mounted()` hook throws, so a failed mount no
longer leaves the overlay owning the live region and input with no disposer
returned to the caller.

`TuiSlots.pushOverlay()` now removes the exact overlay by identity, disposes it
once, and invalidates so the previous overlay or the composed slots are
authoritative again before the mount failure propagates. If the rollback
disposal also throws, both errors are carried in an `AggregateError`; the failed
overlay is unregistered either way, and context teardown cannot dispose it a
second time.

---
'@dshline/dshline': patch
---

Roll back a failed overlay registration when its `mounted()` hook throws, so a
failed mount no longer leaves the overlay owning the live region and input with
no disposer returned to the caller.

`TuiSlots.pushOverlay()` now removes the exact overlay by identity, disposes it
once, and invalidates so the remaining overlay stack or the composed slots are
authoritative again before the mount failure propagates. The rollback covers
only the registration `pushOverlay` makes: an overlay the hook pushes itself is
a separate registration with its own lifecycle. If the rollback disposal or
invalidation also throws, the failures are carried together in an
`AggregateError` with the mount failure first; the failed overlay is
unregistered either way, and context teardown cannot dispose it a second time.

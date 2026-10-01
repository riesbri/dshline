---
'@dshline/renderer': minor
'@dshline/dshline': patch
---

The status line now shows work in flight with its activity word alone: every 2.4 s a short band of light crosses the word, then it rests, and nothing else on the line moves (an arc still turns beside it on a terminal with no colour). The arc spinner used by `/work`, `/context`, and Profiles turns through four quarter arcs at the same 600 ms revolution, without the uneven half-circle frames. A typed `/compact` now animates while it runs instead of freezing on its first frame. The renderer exports `paintGlint` and `GLINT_PERIOD_TICKS`, and themes gain a `busy-glint` role.

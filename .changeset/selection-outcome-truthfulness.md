---
'@dshline/dshline': patch
---

`/model` and `/reasoning` now distinguish applied selection changes from
rejected instructions, so invalid model or reasoning choices are shown as errors
instead of muted success-looking acknowledgements. Setup also no longer treats a
rejected model choice as a model change.

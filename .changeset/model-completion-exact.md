---
'@dshline/dshline': patch
---

`/model` completion now inserts the exact `provider/model` route it represents
while still matching bare model-id prefixes, and model catalogs from independent
provider routes are discovered concurrently without changing their displayed
order.

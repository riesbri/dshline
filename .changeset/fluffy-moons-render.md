---
'@dshline/dshline': patch
---

Render more of the structured metadata tools already publish through their presentation views. A call card now lists the files its view declared via `locations` (with `:line` when the view focuses one), bounded by the same row budget as the body and reachable through the inspector when elided. A web search card shows the provider's `answer` above its sources, and each source now carries its `snippet` and `publishedAt` alongside the title and url. A web fetch card opens with a retrieval summary — url, HTTP status, and the view's own `truncated` flag — instead of showing only the fetched text.

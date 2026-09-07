---
'@dshline/dshline': patch
---

Point the dshline package homepage at dshline.xyz, the canonical project website.

npm's package homepage now sends visitors to the product front door instead of
back to the repository README. Nothing else about the package changes:
`repository` and `bugs` still point at GitHub, and source, issues, releases and
every document stay there. `@dshline/renderer` deliberately keeps its GitHub
homepage — it is published as an agent-agnostic renderer, and the website
positions the product, not that package.

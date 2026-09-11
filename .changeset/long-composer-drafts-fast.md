---
'@dshline/dshline': patch
---

Make very large pasted prompts fast and navigable. Laying the composer's draft
out is now a single forward pass over one snapshot of the buffer instead of a
per-line loop that re-derived the whole buffer for every line, which made a
5,000-line draft take seconds per `↑` and seconds more for the redraw. The
composer view also reuses one layout between its `render` and `cursor` calls, so
a frame no longer wraps the draft twice. A draft still grows from one row to the
same hard cap and then scrolls, and the frame title now names the direction of
what is hidden (`^ 27` / `v 4`) instead of a single `+N rows` count. The markers
are ASCII because `↑`/`↓` are East Asian Ambiguous width: a terminal in an
ambiguous-width mode advances two cells for them where Dshline measures one, so
the top border wrapped and each redraw left the previous composer frame behind.

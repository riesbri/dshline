---
'@dshline/dshline': patch
---

Stop re-reading every provider's model list on each `/model` argument
keystroke. Completion asks Harness for `/model`'s values on every edit and
cursor move, and each ask re-ran `listProviders()` plus one `listModels()` per
route. The values are now held in a per-session snapshot that one read
populates and every later keystroke reuses, and Harness-driven events —
`llm/adapters-updated` for a route-set change, `settings/updated` for the
settings an adapter's model list is built from — discard it so the next ask
refetches. The snapshot owns no model state of its own: `/model`'s candidates,
order, labels, and notes are unchanged, and the picker still reads Harness
directly. A reading in which any route failed to list is partial and is not
reused, so that route is retried on the next ask exactly as before.

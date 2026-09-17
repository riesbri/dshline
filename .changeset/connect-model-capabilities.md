---
'@dshline/dshline': minor
---

`/connect` can now edit the high-value `llm-pi-ai` model capabilities from the
terminal. A route's model menu becomes a staged editor — Name, Context window,
Max output tokens, and an Advanced submenu holding Input modalities and
Reasoning capability — and writes nothing until an explicit Save. Input
modalities and reasoning levels are read from the namespace's own serialized
schema rather than a vocabulary baked into dshline, so a future modality or
thinking level needs no change here.

A route that serves no explicit `models` list inherits the installed catalog,
and editing one of its models now writes a single `modelOverrides.<id>` path op:
correcting one model leaves the rest of the catalog untouched, and an override
never carries an `id` or arrives beside a `models` list, both of which the
adapter refuses. A route with an explicit `models` list still writes that whole
array back with every uncurated field, including `compat`, carried through each
entry.

A rejected save no longer closes the editor. The draft is kept on screen, the
descriptor and provider directory are re-read, and a second explicit Save
applies it against the fresh revision; there is no automatic retry. A route
deleted underneath the editor is never resurrected. Harness's own refusal is
shown verbatim — this frontend holds no copy of the reasoning validator — and
`compat`, retry policy, timeouts, image budgets, and transport remain
`settings.yaml` work.

---
'@dshline/dshline': minor
---

`/connect` can now edit the high-value `llm-pi-ai` model capabilities from the
terminal. A route's model menu becomes a staged editor — Name, Context window,
Max output tokens, and an Advanced submenu holding Input modalities and
Reasoning capability — and writes nothing until an explicit Save. Input
modalities, reasoning levels, and each reasoning level's accepted value shape
(string and/or no value) are read from the namespace's own serialized schema
rather than a vocabulary baked into dshline, so a future modality or thinking
level needs no change here. Numeric fields honor the `min`/`step` their schema
declares instead of a fixed positive-integer rule.

A route that serves no explicit `models` list inherits the installed catalog,
and editing one of its models writes only the exact
`modelOverrides.<id>.<field>` paths the reader changed: correcting one model
leaves the rest of the catalog untouched, and a second Save after a conflict
does not carry back a stale copy of a field nobody opened. An override never
carries an `id` or arrives beside a `models` list, both of which the adapter
refuses. A route with an explicit `models` list still writes that whole array
back with every uncurated field, including `compat`, carried through each
entry.

A rejected save no longer closes the editor. The draft is kept on screen, the
descriptor and provider directory are re-read, and a second explicit Save
reapplies exactly the fields the draft changed against the fresh revision;
there is no automatic retry. A route deleted underneath the editor is never
resurrected. Harness's own refusal is shown verbatim — this frontend holds no
copy of the reasoning validator — and `compat`, retry policy, timeouts, image
budgets, and transport remain `settings.yaml` work.

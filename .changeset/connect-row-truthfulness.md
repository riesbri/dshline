---
'@dshline/dshline': patch
---

Setup no longer offers an empty Connect handoff when no provider, sign-in, or
custom-provider entry is available, and Connect's row counter now includes its
`Add custom provider` entry. Both surfaces read the same unfiltered
selectable-row count, so setup cannot open a `/connect` browser with nothing to
select and the counter can no longer print an impossible total such as `3 of 2`
when a route is declarable.

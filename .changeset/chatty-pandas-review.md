---
'@dshline/dshline': minor
---

Signed-in routes now report a cost in `/usage`: the **API-equivalent cost** —
what the exact provider-reported tokens would have cost at the corresponding
public API rates, never your subscription charge or Codex credits. Today that
means the OAuth `openai-codex` route, valued at the OpenAI public API rates
for its same-named models, cache reads and writes at each model's own rate,
and requests whose total input crosses 272k tokens priced at the published
long-context tier (2× input, 1.5× output, whole request). `/usage` labels the
money `API-equivalent cost` so it cannot be read as a bill, and a session that
switched between a billed and a signed-in route shows one labelled row per
basis instead of one total called either. The money comes from a small
reference-pricing registry that replaces the hand-rolled DeepSeek table: one
authoritative rate set per provider/model, explicit route→reference mappings
carrying a semantic basis (`billed` vs `api-equivalent`), separate from
`SessionUsage`. Correcting a shipped entry's rates via `pricing` keeps the
shipped basis — rewriting an `openai-codex/...` price does not turn the OAuth
route into pay-as-you-go — while a route dshline does not ship reads as its
own billing. Everything else — DeepSeek rates and peak windows, the
`pricing`/`peakHoursUtc` configuration surface, per-message replay/resume
folding — behaves exactly as before. Sign-in routes that also ship an API-key
path (`anthropic`, `xai`, `kimi-coding`, `github-copilot`, `openrouter`) stay
unpriced until the harness records which side a session ran on, so no total is
ever labelled with the wrong basis.
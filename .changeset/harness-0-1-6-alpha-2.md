---
'@dshline/dshline': minor
---

Adopt DeepSeek Harness `0.1.6-alpha.2`, natively.

This generation changes little of what dshline consumes, and each change is
migrated forward rather than shimmed:

- **Model discovery reports input modalities.** `LlmDiscoveredModel` gained
  `inputModalities`, and `@deepseek-ai/dsh-llm-pi-ai` now surfaces the installed
  catalog's `Model.input` through `discoverModels()`. `/connect`'s staged model
  editor carries that authoritative list into a fetched candidate's declared
  input — image capability included, and an explicit text-only list preserved as
  a negative image capability — instead of leaving every fetched model looking
  modality-less. An absent or empty list is left undeclared: pi-ai's
  `declaredInput` collapses both to "inherit", so dshline invents no text-only
  declaration the listing never made.
- **A continuable child's capacity is Harness policy.** `SubagentRuntime` now
  installs a `subagent` settings section (`maxActiveSubagents`, `maxDepth`) and
  rejects a cold resume past its live-child cap with
  `subagent/delivery-unavailable`. dshline already maps the seam's typed refusal
  to a failed outcome, so it adds no cap of its own, names no provider, and
  keeps the continuation manager, inbox, and lifecycle Harness's.
- **Runtime plugin resolution and reload live in new Harness services.**
  `@deepseek-ai/dsh-hmr` (`ctx.hmr`) and `@deepseek-ai/dsh-plugin-manager`
  (`ctx.pluginManager`) own reload and profile management at this generation,
  and `app-boot`'s `watchUserPatches`/`patchReload` are gone. dshline consumes
  none of that lifecycle; the stale references to the removed internals are
  corrected so it does not treat a Host's startup composition as permanent.

The stderr containment shim in `HARNESS_COMPAT` was reconfirmed against this
generation rather than advanced blindly: `subagent-codex/src/run.ts` is
byte-for-byte unchanged between the two revisions and still writes a delegated
child's diagnostics straight to `process.stderr.fd`, and alpha.2 publishes no
Host-owned diagnostic seam through which a consumer could route them. The shim
remains a workaround for THIS generation's defect, not support for
`0.1.6-alpha.1`.

No compatibility with `0.1.6-alpha.1` is retained.

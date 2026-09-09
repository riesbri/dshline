---
'@dshline/dshline': minor
---

Adopt DeepSeek Harness `0.1.5-alpha.1`, natively.

The generation moves four things dshline consumes, and each one is migrated
forward rather than shimmed:

- **Agent ownership is explicit.** `Context.agent` is gone; Harness passes the
  unpublished Agent to `setup(agentCtx, agent)`, and `mountAgentPreset` now
  takes it as an argument. No ambient current Agent is reconstructed.
- **Pending work belongs to the Agent.** `Inbox` is a driver-owned contract
  rather than a constructible projection, and `hasPending`/`claim` are no longer
  public. dshline already read `agent.inbox` on every paint and keeps no queue of
  its own; its tests now drive upstream's published Inbox stubs and a production
  AgentLoop Agent instead of constructing one.
- **Session format V3 owns the system prompt.** It is durable conversation
  history — a `system/message` surface node — not `EpochHeader.system`. `/cache`
  therefore stops reporting whether a prompt is attached and reports the route's
  mid-conversation prompt-update mode from `Session.requestContext()` instead;
  `/context` names the prompt as the surface entry it now is; and the transcript
  keeps it out of scrollback on purpose, appends and normalizing replacements
  alike.
- **Surface replacements are addressed by seq.** `SurfaceOp` carries
  `startSeq`/`endSeq`.

No compatibility with `0.1.3-alpha.2` is retained.

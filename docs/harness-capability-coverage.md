# DeepSeek Harness Capability Adoption in dshline

English | [中文](harness-capability-coverage.zh.md)

A source-backed census of the capabilities DeepSeek Harness publishes, and of how completely
dshline — a terminal-native Harness frontend — adopts each one. It is the decision ledger for
dshline's capability work: every classification carries its upstream authority and its dshline
evidence, and every gap carries a decision.

## Executive summary

**Baselines.** dshline's adopted Harness generation is **`0.1.2-rc.1`**, cut from upstream
revision `a66e4702047846cdaa10c66c9d3df3951f5ea70d` (tag `dsh-v0.1.2-rc.1`, published
2026-09-03). That is also the version npm's `latest` dist-tag serves, so dshline releases are
currently unblocked. The newest published generation at the time of writing is
**`0.1.3-alpha.2`**, revision `82a5fd61a7cf5c293cec4bdff68f455398d685e9` (tag
`dsh-v0.1.3-alpha.2`, published 2026-09-07), available on npm only through the `alpha`
dist-tag. Unreleased `master` behavior is labeled `UNRELEASED` wherever it is mentioned and is
never counted as an offered capability. The working branch is `main`, clean, with no
in-progress migration.

**Census size.** 101 capability entries are examined across ten domains. The classification
count at the time of writing:

| Classification | Entries |
| --- | --- |
| FULL | 63 |
| PARTIAL | 6 |
| NONE | 6 |
| INTENTIONAL-NONE | 10 |
| BLOCKED | 5 |
| N/A | 8 |
| PENDING-HARNESS-ADOPTION | 2 |
| EXCLUDED | 1 |

The counts are not a support score. Capabilities differ widely in product relevance, and the
largest class after FULL is deliberate refusal, which is a success of the architecture, not a
deficit.

**Strongest coverage.** Terminal presentation of the session corpus and its query surface
(listing, filtering, full-text search, lineage, titles, rename, statistics); the Work adapter
over `ctx.jobs` / `ctx.subagents` / `workflow` events with its exact control policy; provider
configuration through the four Connect seams (`ctx.llm`, `ctx.settings`, `ctx.credentials`,
`ctx.authorization`); tool-card rendering through the tools presentation contract; agent modes
(plan, goals, todos) through projections; and compaction, token accounting, and context
occupancy through the meter's projections.

**Most consequential partial gaps.** `ask_user_question` answers degrade silently: the
`multiSelect` flag is ignored and the `custom` free-text answer is never produced
(`packages/dshline/src/questions.ts`, `src/select.ts`). Within-session search hits disclose a
snippet and metadata but cannot open the event's context although `readEvent()` publishes a
windowed read. The command registry's `input.hint` argument hint is never rendered.

**Most consequential unsupported-but-implementable gaps.** The three above are implementable
against the adopted generation. So are capability probes naming the `settings`, `credentials`,
and `llm` seams, whose evidence currently lives in Connect specs outside the probe table.

**Major intentional non-support decisions.** No `ctx.jobs.kill()` (model-facing
reported-delivery semantics); no workflow run control (the engine publishes `start()` only);
no one-shot subagent interrupt (holder-owned); no session archive (one-way upstream, not a
corpus fact); no cross-process liveness claims (no ownership contract); no MCP status surface
(no public registry contract exists); no provider-HTTP or secret handling beyond
`ctx.credentials`; no second persistence, projection, or pricing authority anywhere.

**Major upstream blockers.** A skill-gesture readiness seam (whether a composition mounted
`dsh-tool-skill`); a symmetric session archive lifecycle; a transport-independent human queue
control seam (excluded here); an MCP connection-status contract; a runtime Harness version
service.

**Pending Harness adoption.** dshline pins `0.1.2-rc.1`; generation `0.1.3-alpha.2` removes
the `assistant/chunk` event in favor of `agent/assistant-stream` frames plus durable
`assistant/attempt` records — dshline's streaming layer does not compile against it — and adds
generic file attachments, attachment-aware command input (`input.attachments`), and a
handle-based session-persistence API. None of the gaps implemented in this campaign required
that migration, so `HARNESS_TARGET` was deliberately not moved; adoption rides the normal
`harness-sync` pull request.

## Methodology and definitions

**What counts as a Harness capability.** A behavior Harness publishes through a public
contract: a service on the plugin context (`ctx.*`), a scoped event or waterfall, a durable
`SessionEventMap` record, a session projection unit, a command or tool registry entry, or a
settings/credential schema seam. A capability was established from the owning package's
`package.json` `exports` and `src/index.ts` — never from a filename, a private module, or
rendered output.

**What counts as dshline adoption.** dshline presenting or acting on that contract in its
terminal frontend, with the lifecycle and failure states the contract defines handled, replay
semantics correct where the contract is durable, and absence of the capability degrading
honestly. FULL does not require copying a web client's gestures — it requires the part that
belongs in a terminal-native frontend.

**Provider neutrality.** A provider-specific fact (a wire protocol field, an OAuth dialect, an
upload API) is not a generic capability. Where dshline curates one adapter family's fields
(`connect/pi-ai.ts` for `llm-pi-ai`), the study marks the boundary explicitly; a real provider
is acceptance evidence, never a reason to put provider names into production decision logic.

**Terminal relevance.** A capability a terminal cannot meaningfully present — an HTTP route, a
browser view registry, a web RPC plane — classifies as N/A, not as a gap. Terminal relevance
is what separates FULL from N/A, and it is judged against dshline's bounded live region and
committed native scrollback.

**Public contract versus implementation detail.** Exports and context merges are public; file
layout, listener registrations, in-memory maps, and settings.yaml conventions are not. Where
dshline itself documents a convention-based join (pi-ai's `recordKeyFor` identity), the study
notes that the join is a documented-convention, not a Harness contract.

**How generations were compared.** Both published tags were checked out into read-only git
worktrees and their exported surfaces diffed per package; npm dist-tags were queried for
publication state. Classification uses the *adopted* generation unless a row says otherwise;
newest-published-only facts are PENDING-HARNESS-ADOPTION, and unreleased `master` facts are
labeled `UNRELEASED` and excluded from every decision.

**Research method.** Ten independent read-only domain sweeps (sessions/query, agent
lifecycle/modes, work/delegation, LLM/settings/credentials, tools/commands/skills,
permissions/questions, attachments/context/usage, platform/composition, upstream release
delta, and a dshline adoption map) were synthesized and normalized by the primary agent; every
important claim below was checked against the owning source. Upstream file references are
given as paths under the tag they name; dshline references are repository paths.

## Capability matrix

`Authority` names the upstream package and its public symbol. `Evidence` names dshline
production files (under `packages/dshline/src/` unless noted) and tests. Upstream paths link
to the exact tag where the claim is load-bearing.

### Agent lifecycle and execution

| Harness capability | Generation | Upstream authority | Terminal relevance | dshline status | dshline evidence | Gap / decision | Action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Agent create/resume/dispose | 0.1.2-rc.1 | `ctx.agents` (`AgentRegistry`, `AgentHandle`) | core | FULL | `sessions/reopen.ts`, `resume.ts` | — | — |
| Agent status (`agent/status`, idle/running) | 0.1.2-rc.1 | `AgentStatus` | core | FULL | `attachment.ts`, `work/activity.ts`, status view | — | — |
| Cancellation with user cause | 0.1.2-rc.1 | `Agent.cancel(cause)` | core | FULL | `attachment.ts` (ctrl-c), `window.ts` prelude | — | — |
| Agent lifecycle events | 0.1.2-rc.1 | `agent/created`, `agent/disposed` | core | FULL | `work/index.ts`, `work/activity.ts` | — | — |
| Live assistant streaming (`assistant/chunk`) | 0.1.2-rc.1; removed in 0.1.3 | `SessionEventMap` | core | FULL (adopted) | `stream.ts`, `attachment.ts`, `resume.ts`, `work/activity.ts` | 0.1.3 replaces with `agent/assistant-stream` + `assistant/attempt`; dshline does not compile against it | migrate with next `harness-sync` adoption (PENDING-HARNESS-ADOPTION) |
| Failed attempts and retries | 0.1.2-rc.1 | `agent/request-error` waterfall; `turn/end` reason `error` | core | FULL | `transcript.ts` error rows; no retry-policy UI (harness-owned) | 0.1.3 `assistant/attempt` records PENDING-HARNESS-ADOPTION | — |
| Turn/step lifecycle | 0.1.2-rc.1 | `turn/start`, `turn/end`, `step/start`, `step/end` | core | FULL | `timing.ts`, `activity.ts`, `work/activity.ts` | — | — |
| `whenIdle` / `runMaintenance` | 0.1.2-rc.1 | `Agent.whenIdle`, `Agent.runMaintenance` | low | N/A | — (test stubs only) | host-driver concern; no frontend feature needs it | no work |
| Input delivery verbs (followup/steer) | 0.1.2-rc.1 | `Agent.followup`, `Agent.steer`, inbox events | core | FULL | `steering.ts`, `enter.ts`, `views.ts` status counts | queue *controls* are EXCLUDED (separate campaign) | — |
| Per-session model switching | 0.1.2-rc.1 | `ModelSelectionRef`, `installModelSelection` | core | FULL | `model.ts`, `window.ts` | — | — |
| Reasoning effort | 0.1.2-rc.1 | `ctx.llm.resolveCallConfig`, `LlmModelReasoningInfo` | core | FULL | `reasoning.ts` | — | — |
| Durable default model | 0.1.2-rc.1 | `ctx.agentDefaultModel` | core | FULL | `selection.ts` | — | — |

### Agent modes and structured state

| Harness capability | Generation | Upstream authority | Terminal relevance | dshline status | dshline evidence | Gap / decision | Action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Plan mode | 0.1.2-rc.1 | `plan/mode` event; `PlanModeController` | core | FULL | `modes.ts` log fold, `plan-review.ts`, `questions.ts` | writes stay with `/plan` and `exit_plan_mode` | — |
| Goals (durable domain + activation) | 0.1.2-rc.1 | `goal` projection; `ctx.goals.get().activation` | core | FULL | `goals/model.ts`, `attachment.ts`, status view | mutations stay with `/goal` command and goal tools | — |
| Goal automatic round driver | 0.1.2-rc.1 | `goal-round-driver` | N/A | N/A | — | harness-internal automation; dshline renders the resulting turns | no work |
| Todos | 0.1.2-rc.1 | `todos` projection; `todo_write` tool | core | FULL | `todos/model.ts`, `todos/overlay.ts` | writes are model-driven by design | — |
| Agent presets | 0.1.2-rc.1 | `ctx.agentPresets` (roster, mount, select) | core | FULL | `plugins/*`, `window.ts`, `sessions/reopen.ts` | — | — |

### Sessions, query, and persistence

| Harness capability | Generation | Upstream authority | Terminal relevance | dshline status | dshline evidence | Gap / decision | Action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Session corpus listing + folded titles | 0.1.2-rc.1 | `ctx.sessionQuery.listSessions`, `readTitleSnapshots` | core | FULL | `sessions/catalog.ts`, `sessions/filters.ts` | — | — |
| Resume / new / reopen in place | 0.1.2-rc.1 | `ctx.agents.resume` / `.create` | core | FULL | `resume.ts`, `sessions/reopen.ts`, `session-scope.ts` | — | — |
| Fork lineage | 0.1.2-rc.1 | `traceSession` | core | FULL | `sessions/lineage.ts`, `sessions/lineage-overlay.ts` | — | — |
| Full log read | 0.1.2-rc.1 | `readSession`, `listEvents` | core | FULL | `resume.ts`, `sessions/panels.ts` | — | — |
| Corpus full-text search | 0.1.2-rc.1 | `searchSessions` (optional capability) | core | FULL | `sessions/catalog.ts` (`SESSION_QUERY_SEARCH_DISABLED` degrade) | — | — |
| Within-session event search | 0.1.2-rc.1 | `searchEvents` | core | FULL | `sessions/catalog.ts`, `sessions/panels.ts` | — | — |
| Event context reading (`readEvent` window) | 0.1.2-rc.1 | `SessionQueryEngine.readEvent` | core | NONE | `sessions/panels.ts` shows snippet + `type · seq · time` only | a hit's surrounding events are readable through the published windowed API | **implement (P1)** |
| `observeSession` / `readSurface` / `filterEvents` / `traceEvent` | 0.1.2-rc.1 | `SessionQueryEngine` | low | NONE | — | no current surface needs them; live session arrives via `session/event` | no work; revisit if an inspector needs them |
| Session rename | 0.1.2-rc.1 | `ctx.sessionTitle.rename` (user authority) | core | FULL | `sessions/index.ts`, `attachment.ts` | closed persisted sessions: the service wields live objects only — upstream shape, not a dshline gap | upstream blocker (noted) |
| Session archive / delete | 0.1.2-rc.1 | `ctx.workspaceRegistry.archiveSession` | core | BLOCKED | `ROADMAP.md` "Sessions is not archive-aware" | archiving is one-way, no unarchive, and not a `sessionQuery` corpus fact; offering an irreversible hide from the only surface that can resume is wrong | wait for symmetric upstream lifecycle |
| Cross-process session ownership / liveness | 0.1.2-rc.1 | — (none published) | core | BLOCKED | `sessions/catalog.ts` header; `ROADMAP.md` current limitations | no lease, pid owner, or heartbeat contract exists; dshline documents rather than invents | upstream contract required |
| Session statistics | 0.1.2-rc.1 | `sessionStats` projection (dsh-session-stats) | core | FULL | `performance.ts`, `usage.ts`; probe `tests/capability/session-stats.probe.spec.ts` | — | — |
| Whole-log turn outline (`turnOutline`) | 0.1.2-rc.1 | `turnOutline` projection unit (dsh-session-turn-outline) | low | NONE | — | no dshline surface needs a turn outline; the transcript is its own outline | no work; backlog note |
| Persistence / storage / projection cache (direct) | 0.1.2-rc.1 | `ctx.sessionPersistence`, `ctx.storage`, `ctx.sessionProjectionCache` | host-plane | INTENTIONAL-NONE | `sessions/catalog.ts` "no persistence scan" | frontend never scans disk or runs a second store; alpha's handle-based API is a host concern (PENDING-HARNESS-ADOPTION, indirect) | — |
| Workspace registry (`ctx.workspaceRegistry`) | 0.1.2-rc.1 | `WorkspaceRegistry` | low | INTENTIONAL-NONE | `sessions/filters.ts`, `worktrees/*` | domain stack is single-process (`dsh-storage-domain`); cwd grouping over the corpus is the multi-terminal-safe model | — |
| Session log ZIP export | 0.1.2-rc.1 | `session-log-export` HTTP route | none | N/A | — | web-host route; terminal has no HTTP surface | — |
| Model-facing session-query tools | 0.1.2-rc.1 | `tool-session-query` | none | N/A | — | model-side; dshline consumes the same engine for its own UI | — |

### Transcript and conversation presentation

| Harness capability | Generation | Upstream authority | Terminal relevance | dshline status | dshline evidence | Gap / decision | Action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| User / assistant messages, reasoning | 0.1.2-rc.1 | `user/message`, `assistant/message` + `MessageSourceMap` | core | FULL | `transcript.ts`, `stream.ts`, `reasoning.ts` display | — | — |
| Tool call/result cards | 0.1.2-rc.1 | `ToolCallView` / `ToolResultView` presentation contract | core | FULL | `cards.ts`, `tool-pending.ts`, `tool-output.ts` (ctrl-o inspector) | — | — |
| Command echo + results | 0.1.2-rc.1 | `command/run`, `command/done`, `sourceEventSeq` | core | FULL | `transcript.ts`, `history.ts`, `context/compaction.ts` | — | — |
| Compaction notes | 0.1.2-rc.1 | `compaction/summary`, `compaction/end`, `compaction/prune` | core | FULL | `context/compaction.ts` | — | — |
| Turn outcomes (error/aborted/max-tokens/blocked) | 0.1.2-rc.1 | `turn/end` `TurnEndReason` | core | FULL | `transcript.ts` | — | — |
| PTC sub-call events (`tool/code-dispatch`) | 0.1.2-rc.1 | `dsh-tools` PTC records | low | NONE | — | not mounted in the standard bundle; render only when PTC sessions are real | intentional wait |
| Request headers | 0.1.2-rc.1 | `Session.requestHeader()`, `EpochHeader` | core | FULL | `cache/model.ts`, `context/model.ts`, `work/index.ts` | — | — |

### Work and delegation

| Harness capability | Generation | Upstream authority | Terminal relevance | dshline status | dshline evidence | Gap / decision | Action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Jobs observation | 0.1.2-rc.1 | `ctx.jobs.list`, `onJobsChanged` | core | FULL | `work/index.ts`, `work/model.ts`; probe `tests/capability/jobs.probe.spec.ts` | — | — |
| Job kill | 0.1.2-rc.1 | `ctx.jobs.kill` | core | INTENTIONAL-NONE | `work/index.ts` refusal comment; `ROADMAP.md` control rule | kill marks a record `reported`, changing model-delivery semantics | reclassify only if harness publishes a human-safe kill |
| Subagent lifecycle + discovery | 0.1.2-rc.1 | `ctx.subagents` events, `listChildren` | core | FULL | `work/index.ts`; probe `tests/capability/subagents.probe.spec.ts` | — | — |
| Continuable subagent interrupt (human) | 0.1.2-rc.1 | `subagents.interrupt(id, {kind:'user', parentSessionId})` | core | FULL | `work/index.ts` `interrupt()`, `work/overlay.ts` | — | — |
| One-shot subagent interrupt | 0.1.2-rc.1 | — (holder-only by contract) | core | INTENTIONAL-NONE | `work/index.ts` (`interruptible: false`) | no service-level interrupt exists; the holder tool call owns it | — |
| Human start / message to a continuable child | 0.1.2-rc.1 | `subagents.sendMessage` (parent-agent authority) | core | BLOCKED | Correct non-support (below); `ROADMAP.md` Work rows | the seam models the *parent agent's* authority, not a human prompt-to-child seam; driving it from the terminal would conflate human and model authority | upstream contract required |
| Workflow observation | 0.1.2-rc.1 | `workflow/*` events + durable `tool-workflow/*` | core | FULL | `work/workflows.ts`, `work/index.ts`; probe `tests/capability/workflow.probe.spec.ts` | — | — |
| Workflow run control | 0.1.2-rc.1 | `ctx.workflowEngine.start()` only | core | INTENTIONAL-NONE | `work/index.ts` | the engine publishes no cancel/control surface for a frontend | reclassify if upstream publishes one |
| Work telemetry (`subagentTiming`, `tokenUsage`) | 0.1.2-rc.1 | projection units | core | FULL | `work/index.ts` `CHILD_PROJECTION_KEYS`; probe `tests/capability/subagent-telemetry.probe.spec.ts` | — | — |
| Model-facing delegation tools | 0.1.2-rc.1 | `dsh-tool-subagent`, `dsh-tool-jobs`, `dsh-tool-subagent-control` | none | N/A | render via generic tool cards | model-side | — |
| Inbox / queue controls | 0.1.2-rc.1 | `Agent.inbox`, `sessionController.updateQueue` | core | EXCLUDED | `ROADMAP.md` "Pending input can be seen but not managed" | EXCLUDED — separate capability campaign | deferred |

### LLMs, providers, settings, credentials

| Harness capability | Generation | Upstream authority | Terminal relevance | dshline status | dshline evidence | Gap / decision | Action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Provider registry + configurable directory | 0.1.2-rc.1 | `ctx.llm.listProviders`, `listConfigurableProviders` | core | FULL | `model.ts`, `connect/catalog.ts`, `connect/harness.ts` | — | — |
| Model catalog per route | 0.1.2-rc.1 | `ctx.llm.listModels` | core | FULL | `model.ts`, `connect/catalog.ts` | — | — |
| Model capability metadata | 0.1.2-rc.1 | `ctx.llm.resolveModelInfo` (`LlmResolvedModelInfo`) | core | FULL | `window.ts` (context window, modalities), `context/model.ts` | — | — |
| Model discovery on draft endpoints | 0.1.2-rc.1; anthropic protocol added 0.1.3 | `ctx.llm.discoverModels` | core | FULL | `connect/route-editor.ts` | 0.1.3 protocol widening is additive; no dshline change needed | — |
| Route editing (base URL, protocol, headers, catalog) | 0.1.2-rc.1 | `ctx.settings.mutate` path ops; pi-ai schema | core | FULL | `connect/route-editor.ts`, `connect/header-editor.ts`, `connect/pi-ai.ts` | — | — |
| Compat profile / retry policy / per-model reasoning maps | 0.1.2-rc.1 | pi-ai `compatProfile`, `RetryPolicySchema`, `PiAiReasoningEfforts` | low | INTENTIONAL-NONE | `connect/pi-ai.ts` curation note; `ROADMAP.md` Connect limits | advanced fields stay in `settings.yaml`; the terminal curates what a reader can *reach* | — |
| Settings describe / revisioned mutate | 0.1.2-rc.1 | `ctx.settings.describe`, `mutate(ns, ops, expectedRevision)` | core | FULL | `settings.ts`, `connect/harness.ts`, `connect/actions.ts` | probe table has no `settings` row (evidence lives in Connect specs) | **add probe (P2)** |
| Credential records | 0.1.2-rc.1 | `ctx.credentials` (`describeRecord`, `deleteRecord`) | core | FULL | `connect/harness.ts`, `connect/actions.ts` | same probe-table gap | **add probe (P2)** |
| Authorization flows | 0.1.2-rc.1 | `ctx.authorization` (`AuthorizationFlow`, notices, prompts) | core | FULL | `connect/authorize.ts`, `connect/harness.ts`; probe `tests/capability/authorization.probe.spec.ts` | — | — |
| Route activation | 0.1.2-rc.1 | settings watcher + `llm/adapters-updated` | core | FULL | `connect/activation.ts`, `connect/actions.ts` | — | — |
| File content blocks (`FileBlock`, `fileRequestText`) | 0.1.3-alpha.2 | `dsh-llm` types | core | PENDING-HARNESS-ADOPTION | — (absent from adopted dists) | rides the next adoption alongside file attachments | — |
| Provider registry probe | 0.1.2-rc.1 | `ctx.llm` | core | PARTIAL | `connect/*.spec.ts` exist but no probe-table row | seam exercised, not named in `tools/capability-probes.mjs` | **add probe (P2)** |

### Tools, commands, and skills

| Harness capability | Generation | Upstream authority | Terminal relevance | dshline status | dshline evidence | Gap / decision | Action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Tool registry + presentation contract | 0.1.2-rc.1 | `ctx.tools.get`, `ToolCallView`/`ToolResultView` | core | FULL | `cards.ts`, `tool-pending.ts` | — | — |
| Tool registry change feed | 0.1.2-rc.1 | `tools/change` | low | PARTIAL | no listener; presentation resolves lazily per call (`attachment.ts:330`) | no user-facing gap today; a live tool-list UI would need it | no work; revisit |
| Command registry + execution | 0.1.2-rc.1 | `ctx.commands.list`, `execute`, `commands/change` | core | FULL | `attachment.ts`, `completion.ts` | — | — |
| Command argument hint (`input.hint`) | 0.1.2-rc.1 | `CommandDescriptor.input.hint` | core | PARTIAL | `attachment.ts:1089` notes the free-text hint; no UI renders it | a reader typing a hint-only command gets no vocabulary | **implement (P2)** |
| Attachment-aware command input | 0.1.2-rc.1 (images); 0.1.3 generalizes | `input.images` → `input.attachments` | core | FULL (adopted) | `attachment.ts` gate, `image-drafts.ts` | 0.1.3 file receipts PENDING-HARNESS-ADOPTION | — |
| File-reference discovery (`@` grammar) | 0.1.2-rc.1 | `ctx.fileReferences.list` + `activeAtToken`/`formatFileMention` | core | NONE | `attachment.ts:1089` — `@`-completion lists through `ctx.fs` directly | the user-visible behavior exists through another public seam; upstream's own frontend composes `file-reference-local` for this one | backlog (P2): migrate `@`-completion to the shared seam |
| Command result persistence | 0.1.2-rc.1 | `command/run` / `command/done` durable records | core | FULL | `transcript.ts`, `history.ts` | — | — |
| Skills catalog | 0.1.2-rc.1 | `ctx.skills.snapshot`, `skills/change`, `userInvocable` | core | FULL | `skills/catalog.ts`, `skills/overlay.ts`; probe `tests/capability/skills.probe.spec.ts` | — | — |
| Skill gesture readiness | 0.1.2-rc.1 | — (no seam says `dsh-tool-skill` is mounted) | core | BLOCKED | `architecture.md` skills section | readiness is inferable only from implementation, never contract | upstream seam required |
| MCP connection status | 0.1.2-rc.1 | — (mcp-client publishes no registry/status contract) | core | BLOCKED | — (no dshline MCP code exists) | tool names and `tools/change` make state *inferable*, never published; dshline does not infer | upstream contract required |
| Shell / code-runtime seams | 0.1.2-rc.1 | `ctx.shell`, `ctx.codeRuntime` | host-plane | INTENTIONAL-NONE | tool cards already render their output generically | host-side execution; card-level coverage is complete | — |

### Permissions, authorization, and human interaction

| Harness capability | Generation | Upstream authority | Terminal relevance | dshline status | dshline evidence | Gap / decision | Action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Approval answerer | 0.1.2-rc.1 | `approval/request` waterfall, `ApprovalOutcome` | core | FULL | `approval.ts`; tests `approval.spec.ts` | — | — |
| Approval policy knob | 0.1.2-rc.1 | `setApprovalPolicy`, `approval/policy` event | core | FULL | reached through the preset picker (`permission.ts`) — the same surface harness's own clients use | direct knob would duplicate the preset surface | — |
| Permission presets + projection | 0.1.2-rc.1 | `ctx.permissionPresets`, `permissions` projection | core | FULL | `permission.ts`, `attachment.ts`; probe `tests/permission.spec.ts` | — | — |
| Sandbox state read/control | 0.1.2-rc.1 | `ctx.sandbox` (no frontend contract) | low | INTENTIONAL-NONE | — | no projection, no control seam; visibility arrives through presets and escalation denials | — |
| Sandbox escalation approvals | 0.1.2-rc.1 | `sandbox_permissions` → `ctx.approval.request` | core | FULL | `approval.ts` renders the ordinary approval | — | — |
| User questions (single-select) | 0.1.2-rc.1 | `user-questions/request` waterfall | core | FULL | `questions.ts`, `select.ts`; probe `tests/capability/user-questions.probe.spec.ts` | — | — |
| User questions (multi-select + free text) | 0.1.2-rc.1 | `AskUserQuestionItem.multiSelect`, `AnswerItem.custom` | core | PARTIAL | `questions.ts` `askOne` ignores `multiSelect`; `custom` never produced | answers silently degrade to single option labels | **implement (P0)** |
| Plan-review intent | 0.1.2-rc.1 | `AskUserQuestionIntent {kind:'plan-review'}` | core | FULL | `questions.ts`, `plan-review.ts` | — | — |
| Command feedback (`/feedback`) | 0.1.2-rc.1 | `command-feedback` registered command | core | FULL | generic registered-command path (`attachment.ts`) | terminal equivalent provided differently; per-message rating is a web remote — N/A | — |

### Attachments, context, compaction, and usage

| Harness capability | Generation | Upstream authority | Terminal relevance | dshline status | dshline evidence | Gap / decision | Action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Image attachments | 0.1.2-rc.1 | `ctx.attachments.saveImages`, `imageLimits` | core | FULL | `image-drafts.ts`, `attachment.ts`; tests `image-drafts.spec.ts`, `image-attachment-flow.spec.ts` | — | — |
| Image admission errors | 0.1.2-rc.1 | `AttachmentErrorCode` | core | FULL | `attachment.ts` pre-read bounds + store codes | — | — |
| Command image input | 0.1.2-rc.1 | descriptor `input.images` | core | FULL | `image-drafts.ts` `encodeCommandImages` | — | — |
| Generic file attachments | 0.1.3-alpha.2 | `admitEncodedFile`, `FileAttachmentRef`, `FileBlock` | core | PENDING-HARNESS-ADOPTION | `ROADMAP.md` "Still ahead: arbitrary file attachments" | adopted generation exposes images only; `@path` stays the honest gesture | migrate with next adoption |
| Compaction observe + `/compact` | 0.1.2-rc.1 | `compaction/*` events; registered `/compact` | core | FULL | `context/compaction.ts`; probe `tests/capability/compaction.probe.spec.ts` | `ctx.compaction` never called | — |
| Region compaction (`compactRegion`) | 0.1.2-rc.1 | `CompactionEngine.compactRegion` | core | INTENTIONAL-NONE | `architecture.md` compaction section | the human command is argument-free; a range-selection UI would be a control contract upstream has not defined | — |
| Context projections + meter | 0.1.2-rc.1 | `contextPressure`, `contextBreakdown`, `tokenUsage`; `ctx.tokenMeter.measure` | core | FULL | `context/model.ts`, `context/overlay.ts`, `usage.ts` | — | — |
| Per-turn usage (`deriveTurnTokenUsage`) | 0.1.2-rc.1 | `dsh-token-meter/client` | low | PARTIAL | not imported anywhere | cumulative + occupancy surfaces already exist; per-turn figures are polish | backlog (P2), not selected |
| Cache prefix stability | — | — (nothing published in any generation) | core | INTENTIONAL-NONE | `cache/model.ts` header documents the refusal | reconstructing one would make dshline a second historical authority | upstream contract required |

### Plugins, composition, platform

| Harness capability | Generation | Upstream authority | Terminal relevance | dshline status | dshline evidence | Gap / decision | Action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Profile roster + bundle lifecycle | 0.1.2-rc.1 | `ctx.dshHomePath`, `dsh plugin`, `ctx.baseUrl` | core | FULL | `profiles/*` (mutations forwarded, never written) | — | — |
| Bundle composition rows dshline needs | 0.1.2-rc.1 | dshline `cordis.patch.yml` (session-stats, authorization) | core | FULL | `packages/dshline/cordis.patch.yml` | composition, not implementation — the seams stay harness-owned | — |
| Compatibility check | 0.1.2-rc.1 | — (no runtime version service) | core | FULL | `/profiles` reads peer pin + composed `dsh-base` version; refuses unknown marks | harness publishes no `ctx.version`; manifests are the published fact | — |
| Persistent terminals | 0.1.2-rc.1 | `ctx.terminals` | core | NONE | — | real harness capability, zero adoption; bounded live-region design for a PTY is unsolved | backlog (P1), large slice, own design work |
| Scheduled reminders projection | 0.1.2-rc.1 | optional `schedule` projection unit | low | PARTIAL | — | reminders already reach the transcript as follow-up messages; a catalog overlay is polish | backlog (P2), not selected |
| Web plane (client, api, gateway, sdk, acp, webhook, webhost) | 0.1.2-rc.1 | `packages/client`, `packages/api`, … | none | N/A | — | in-process frontend; web RPC/browser machinery is out of scope by architecture | — |
| Experimental packages (agent-team, inspector, python runtime) | experimental | `packages/experimental/*` | none | N/A | — | "not part of any official release"; becomes in-scope only if promoted | — |
| Identity / hooks / e2b / spill / typert / lsp / util | 0.1.2-rc.1 | respective packages | none | N/A | — | host-plane or model-side plumbing; no terminal surface | — |

## Detailed domain sections

### Agent lifecycle, modes, and structured state

**What Harness provides.** The agent plane (`@deepseek-ai/dsh-agent`,
[core/agent](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/core/agent/src/runtime-types.ts))
publishes `ctx.agents` (`create`/`resume` returning an owned `AgentHandle`), an `AgentStatus`
machine with `agent/status`, cancellation with typed causes, lifecycle events scoped by agent,
`whenIdle`/`runMaintenance` for host drivers, and an inbox with `followup`/`steer` delivery
verbs. Model selection is a session header snapshot plus a mutable `ModelSelectionRef`
installed through waterfalls; reasoning effort is validated against adapter-published
`LlmModelReasoningInfo`; the durable default lives in `ctx.agentDefaultModel`. Plan mode,
goals, and todos are structured-state domains: plan flips durably via `plan/mode`; goals split
a durable projection (`goal`: objective, phase, rounds, revision) from process-local
continuation `activation` that is deliberately never persisted; todos are whole-list durable
writes with a projection. Agent presets compose tools, prompt sections, and delegation
backends per agent, joined at `setup(agentCtx)` and switchable only on a blank session.

**What dshline does today.** The window owns key routing and quits; the attachment owns one
agent and folds its log (`session/event`) into transcript, cards, timing, activity, and
work. Reopen uses the owned handle's `dispose()` then `ctx.agents.resume`, refusing states
harness does not define a lifecycle for. Streaming renders text and reasoning live through
`assistant/chunk` and settles on `assistant/message`. The status line joins the `goal`
projection with live `ctx.goals.get(agent).activation` — read live and never cached, because
`disarm()` writes nothing durable — and renders `plan/mode` from a log fold so replay recovers
it. Model and reasoning pickers write the ref first and the durable default second, saying so
in the transcript. `/plugins` presents the preset roster and composition through
`ctx.agentPresets`, copies system presets before editing, and resumes under the session's own
recorded preset.

**What is missing.** Nothing terminal-facing in the adopted generation. The 0.1.3 streaming
replacement (`agent/assistant-stream` frames, `assistant/attempt` records, `assistant/chunk`
removal) is the one consequential PENDING-HARNESS-ADOPTION: five dshline files fold the removed
event and would not compile against `0.1.3-alpha.2`.

**Decision.** No work needed against the adopted generation. The streaming migration belongs
to the next `harness-sync` adoption pull request, not to a feature campaign.

**Evidence.** Upstream: `packages/core/agent/src/runtime-types.ts`,
`packages/core/agent/src/model-selection.ts`, `packages/core/session/src/types.ts`,
`packages/plan/plan-mode/src/index.ts`, `packages/goal/goal/src/{index,types,domain}.ts`,
`packages/preset/agent-presets/src/index.ts` (all at `dsh-v0.1.2-rc.1`). dshline:
`packages/dshline/src/{attachment,session-scope,resume,stream,modes,goals/model,plugins/window
…}` and the probes listed in the matrix.

### Sessions, query, and persistence

**What Harness provides.** `ctx.sessionQuery`
([session-query](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/session-query/session-query/src/index.ts))
publishes the live-preferred logical corpus: `listSessions`, `filterSessions`, full-text
`searchSessions` and `searchEvents` (the engine's only abstract surface, hence optional),
replay-validated `readSession`, `listEvents`, the windowed `readEvent`, `traceSession`
lineage, batched `readTitleSnapshots`, and `readSurface`/`observeSession`/`filterEvents`/
`traceEvent`. Titles are folded by `dsh-session-title`, whose `rename` appends a log-only
`session/title` event with explicit user authority but wields live session objects only.
`ctx.workspaceRegistry` owns durable workspace entities and a one-way `archiveSession`.
Persistence (`dsh-session-persistence`, JSONL backend) is host-plane; cross-process ownership
is documented as a caller requirement, not an enforcement.

**What dshline does today.** `/sessions` and `/worktrees` read exactly one authority — the
corpus — grouping transiently by exact `SessionHeader.cwd`; `/sessions` is picker-first with a
per-session disclosure surface that pays for `listEvents` when opened, `ctrl-f` filters as
harness clauses, lineage navigation through `traceSession`, within-session search through
`searchEvents` with cursor paging, and rename of the session this window drives through
`ctx.sessionTitle.rename`. Resume rebuilds the transcript from `readSession` through the same
code path that drew it live. Content search degrades honestly on
`SESSION_QUERY_SEARCH_DISABLED`.

**What is missing.** A selected event-search hit shows its snippet plus
`type · seq · time` — the surrounding events that `readEvent(sessionId, seq, before, after)`
publishes are unread. `observeSession`, `readSurface`, `filterEvents`, and `traceEvent` have
no consuming surface. Archive is deliberately not offered (BLOCKED: one-way, not a corpus
fact). No cross-process liveness is claimed anywhere.

**Decision.** Implement hit-context inspection through `readEvent` (P1; already named in
`ROADMAP.md` "Still ahead for Sessions"). Everything else: no work or documented upstream
blocker.

**Evidence.** Upstream: `packages/session-query/session-query/src/{index,types}.ts`,
`packages/session/session-title/src/index.ts`, `packages/workspace/workspace/src/index.ts`
(at `dsh-v0.1.2-rc.1`). dshline: `packages/dshline/src/sessions/*`, `src/resume.ts`,
`tests/sessions-query.integration.spec.ts` (the `sessionQuery` probe).

### Transcript presentation

**What Harness provides.** Durable `SessionEventMap` records — `user/message` and
`assistant/message` with `MessageSourceMap` sources, `tool/call`/`tool/result` carrying tool
declared `ToolCallView`/`ToolResultView` presentation intents and tool-private `meta`,
`command/run`/`command/done` with `sourceEventSeq` correlation, `compaction/*`, `turn/end`
reasons, and `request/header` snapshots.

**What dshline does today.** One projection fold draws all of it, identically live and on
replay; the streamed line is the committed path one newline earlier; `ctrl-o` opens a bounded
inspector for elided card output; command results survive resume because they are projected
from the log, never printed at submit time.

**What is missing.** `tool/code-dispatch` sub-call records (PTC) render nothing — PTC is not
mounted in the standard bundle, so no real session produces them.

**Decision.** Intentional wait; render sub-calls only when PTC sessions are real.

**Evidence.** dshline: `packages/dshline/src/{transcript,stream,cards,tool-pending,tool-output,history,context/compaction}.ts`;
layout gates `tests/rendered.spec.ts`-style frame tests and
`packages/dshline/tests/streaming-frames.spec.ts`.

### Work and delegation

**What Harness provides.** `ctx.jobs` (scoped snapshots, `kill` that marks a record
`reported` for model delivery), `ctx.subagents` (lifecycle events, `listChildren` discovery,
`interrupt` with explicit user authority for continuable children, `sendMessage` under
parent-agent authority), and the workflow engine (observe-only events plus durable
`tool-workflow/*` records in the parent session).

**What dshline does today.** `/work` is the generic adapter: three authorities, one projection
layer; workflow runs are owned through this session's own durable records and enriched only
from live events those records proved; members join to subagent rows via harness-published
`childId`. Exactly one control exists — user-authority interrupt of a continuable child — and
every refusal (job kill, one-shot interrupt, workflow control) is named with its reason.

**What is missing.** A human start/message surface for continuable children (BLOCKED: the
public seam models parent-agent authority). Inbox/queue controls are EXCLUDED — separate
campaign.

**Decision.** No work beyond the documented refusals.

**Evidence.** Upstream: `packages/jobs/jobs/src/index.ts`,
`packages/subagent/subagent/src/{index,types,control-types}.ts`,
`packages/workflow/workflow/src/index.ts` (at `dsh-v0.1.2-rc.1`). dshline:
`packages/dshline/src/work/*`, probes `jobs`, `subagents`, `subagent-telemetry`, `workflow`.

### LLMs, providers, settings, credentials

**What Harness provides.** `ctx.llm` (adapter registry, configurable-provider directory,
per-route catalogs, `resolveModelInfo`, reasoning efforts, `discoverModels`), `ctx.settings`
(redacted describe, revisioned mutate with path ops), `ctx.credentials` (record
describe/set/unset/delete by `CredentialKey`), `ctx.authorization` (neutral notice/prompt
flow vocabulary), and the pi-ai adapter's settings schema that makes routes declarable.

**What dshline does today.** `/connect` is the join of the four seams with no provider list,
no field-name knowledge (the `credential-ref` schema role is the contract), and no login
protocol; `connect/pi-ai.ts` is the one module allowed to know pi-ai's curated fields
(`displayName`, `baseURL`, `api`, `headers`, `models`) and its declare-a-route shape; model
discovery is advisory; activation is a separate human consent. `/model` and `/reasoning`
switch the live ref and store the durable default whole.

**What is missing.** Nothing terminal-facing. Advanced pi-ai fields (`compat`, retry policy,
per-model reasoning maps) stay in `settings.yaml` by documented curation policy. The probe
table names no row for these seams even though Connect specs exercise them.

**Decision.** Add probe-table rows for `settings`/`credentials`/`llm` (P2). No product gap.

**Evidence.** Upstream: `packages/llm/llm/src/{index,types}.ts`,
`packages/llm/llm-pi-ai/src/{config,catalog,discovery}.ts`,
`packages/settings/settings/src/index.ts`,
`packages/credentials/credentials/src/index.ts`,
`packages/credentials/authorization/src/index.ts` (at `dsh-v0.1.2-rc.1`). dshline:
`packages/dshline/src/connect/*`, `src/settings.ts`, `src/selection.ts`, `src/reasoning.ts`,
`src/model.ts`.

### Tools, commands, and skills

**What Harness provides.** `ctx.tools` (registration, scoped restriction, presentation
intents, `tools/change`), `ctx.commands` (descriptor with `input.hint`/`input.images`,
execution, durable `command/run`/`command/done`, `commands/change`), `ctx.skills`
(scope-layered catalog with `userInvocable`, `skills/change`), `ctx.fs` (bounded reads),
`dsh-tool-skill` (the `/name` gesture boundary), and an MCP client that publishes no
registry/status contract at all.

**What dshline does today.** Tool cards render whatever the tool declares; completion offers
registered commands and their enumerated argument values; `/skills` presents the effective
per-scope catalog without ever loading a body; path completion reads `ctx.fs`.

**What is missing.** `input.hint` is never rendered (implement, P2). `tools/change` is
unobserved (lazy resolution covers it). Skill gesture readiness and MCP status are upstream
blockers dshline documents rather than infers.

**Decision.** Implement the hint (P2); no work elsewhere.

**Evidence.** Upstream: `packages/core/tools/src/index.ts`,
`packages/interaction/commands/src/{index,types}.ts`, `packages/skill/skill/src/index.ts`,
`packages/mcp/mcp-client/src/index.ts` (at `dsh-v0.1.2-rc.1`). dshline:
`packages/dshline/src/{cards,tool-pending,completion,attachment,skills/*}.ts`.

### Permissions, authorization, and human interaction

**What Harness provides.** The `approval/request` waterfall (one-shot outcomes, fail-closed
when no answerer), durable per-session approval policy and sandbox mode written through
`ctx.permissionPresets` and its `permissions` projection, sandbox escalation resolved through
an approval, and `ctx.userQuestions` — `ask_user_question` requests whose items carry
`options`, `multiSelect`, `detail`, `header`, and a `plan-review` intent, answered with
`{ id, selected: string[], custom?: string }`.

**What dshline does today.** The terminal answerer claims every request, asks questions one
at a time in bounded overlays, keeps dismissal distinct from cancellation (`ASK_CANCELLED`
locally, `ASK_ABORTED` for withdrawal), renders plan review as its own surface, and reaches
the permission knobs through the preset picker exactly as harness's own clients do.

**What is missing.** `multiSelect` is ignored and `custom` is never produced: a multi-select
question answers with one label, and a free-text answer is impossible. Upstream's own web
client offers checkboxes with a companion "Other" field, custom text replacing the selection
in single-select, and a free-text block for optionless questions.

**Decision.** Implement the full answer contract (P0).

**Evidence.** Upstream:
[packages/interaction/user-questions/src/types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/interaction/user-questions/src/types.ts),
`packages/interaction/user-approval/src/index.ts`,
`packages/interaction/permission-presets/src/index.ts`,
`packages/interaction/tool-ask-user/src/index.ts` (at `dsh-v0.1.2-rc.1`). dshline:
`packages/dshline/src/{questions,select,approval,permission,plan-review}.ts`, probes
`user-questions`, `authorization`; projection tests `todos.spec.ts`, `goals.spec.ts`,
`permission.spec.ts`.

### Attachments, context, compaction, and usage

**What Harness provides.** Image attachment admission (`ctx.attachments` with limits and
stable error codes), the compaction engine with durable `compaction/*` events and a
registered `/compact`, the token meter's O(1) projections (`contextPressure`,
`contextBreakdown`, `tokenUsage`) plus O(surface) `measure()`, session statistics, and — in
`0.1.3-alpha.2` only — generic file attachments and attachment-aware metering.

**What dshline does today.** `/image` stages paths without I/O and publishes one durable batch
at send; `/context`, `/usage`, `/cache`, and the status line read only the published
projections, calling `measure()` only from an open inspector and never mixing the two
vocabularies; compaction is presented from its events with reduction owned by the registered
command.

**What is missing.** File attachments (PENDING-HARNESS-ADOPTION). Per-turn usage
(`deriveTurnTokenUsage`) is imported nowhere (backlog polish). Cache prefix stability is
published by no generation (intentional non-support, documented).

**Decision.** No work in this campaign beyond the study itself.

**Evidence.** Upstream: `packages/attachment/attachment/src/{index,types,admission}.ts`,
`packages/compaction/compaction/src/index.ts`, `packages/llm/token-meter/src/*.ts`,
`packages/session/session-stats/src/projection.ts` (at `dsh-v0.1.2-rc.1`). dshline:
`packages/dshline/src/{image-drafts,attachment,context/*,usage,usage-overlay,cache/*,performance}.ts`,
probes `tokenMeter`, `compaction`, `sessionStats`, `requestHeader`.

### Plugins, composition, and platform

**What Harness provides.** Profile composition (`dsh.profile.bundles`, `dsh plugin`, patch
layers), the plugin context surface (~40 `ctx.*` services), agent presets, the host-plane
seams dshline composes (`session-stats`, `authorization` as bundle rows), `ctx.terminals`
(persistent PTYs), an optional schedule-reminder projection, and the web/API/SDK/ACP planes.

**What dshline does today.** `/profiles` presents the roster and forwards every mutation to
`dsh plugin`; `/plugins` presents composition; the bundle patch mounts exactly the host-plane
rows dshline reads; the compatibility check reads manifests because harness publishes no
version service and refuses unknown marks.

**What is missing.** Persistent terminals are a real, adopted-generation capability with zero
dshline adoption (backlog P1 — needs a bounded-row design before any code). The schedule
projection is unconsumed polish (backlog P2). Everything else on the platform list is N/A by
architecture.

**Decision.** No platform work in this campaign.

**Evidence.** Upstream: `packages/bundle/base/cordis.patch.yml`,
`packages/boot/app-boot/README.md`, `packages/terminal/terminal/src/index.ts`,
`packages/schedule/*` (at `dsh-v0.1.2-rc.1`). dshline: `packages/dshline/src/{profiles,plugins,setup,window,startup}.ts`,
`packages/dshline/cordis.patch.yml`.

## Capability gaps worth implementing

Priorities: **P0** high-value, clean current contract · **P1** worthwhile, narrower ·
**P2** polish/completeness · **BLOCKED** requires an upstream contract · **DECLINED**
deliberately not appropriate.

### P0 — full `ask_user_question` answer contract (multi-select + free text)

- **User problem.** The model asks a multi-select question (or expects an "Other" answer) and
  the terminal silently answers with a single option label and never text. The model receives
  a strictly narrower answer than the protocol defines, and the human has no way to say what
  the question offered to ask.
- **Harness authority.** `AskUserQuestionItem.multiSelect`, `AskUserQuestionAnswerItem
  {selected, custom}` — a public, provider-neutral contract at the adopted generation
  (`user-questions/src/types.ts`). Upstream's web client (`QuestionComposer.tsx`) defines the
  intended semantics: multi-select accumulates labels and may accompany custom text; custom
  text replaces the selection in single-select; optionless questions render a free-text block.
- **Why dshline falls short.** `questions.ts` `askOne` maps every item to a single-select
  `promptSelect` and returns `selected: [oneLabel]`; `custom` is never set; optionless
  questions degrade to an OK acknowledge.
- **Proposed terminal interaction.** Extend the select overlay with a multi-select mode:
  `space` toggles a checked row, `enter` confirms the set; an explicit "Other…" row opens the
  existing bounded text prompt (`prompt.ts`), whose result pairs with selections (multi) or
  replaces them (single); optionless questions present the text prompt directly; help segments
  drop whole per the established rule; the compact fallback stays answerable.
- **Files.** `packages/dshline/src/select.ts` (or a sibling overlay), `src/questions.ts`,
  tests.
- **Tests.** Overlay frame tests (checkbox state, toggle/confirm, Other flow, esc = cancel,
  abort = `ASK_ABORTED`), answer-shape tests (multi labels, custom-only, custom+selected,
  single-select custom replacement), and a deliberate-break pass proving each fails by name.
- **Risks.** Overlay geometry on narrow terminals (mitigated by the existing compact
  fallback); regression risk to approvals/model picker sharing `promptSelect` (mitigated by
  leaving single-select behavior byte-identical).
- **Harness adoption required.** No.

### P1 — within-session search hit context via `readEvent()`

- **User problem.** A search hit answers "this session said something like this" but not
  "what was happening around it"; the reader must resume the session and search again by eye.
- **Harness authority.** `SessionQueryEngine.readEvent(request)` → `SessionEventWindow`
  (before/after records), published at the adopted generation; already listed in `ROADMAP.md`
  "Still ahead for Sessions".
- **Why dshline falls short.** `sessions/panels.ts` renders the snippet and `type · seq ·
  time` only; no surface calls `readEvent`.
- **Proposed terminal interaction.** A key on a selected hit (enter) opens a bounded child
  overlay showing the hit's event content with its `before`/`after` neighbors; esc returns to
  the hit list; rendering is one line per event with the same source-kind styling the
  transcript uses; the read is cancelled with the browser.
- **Files.** `src/sessions/catalog.ts` (port), `src/sessions/panels.ts`, `src/sessions/overlay.ts`,
  tests.
- **Tests.** Window shaping (hit centered, boundary clamping), render bounds, cancellation,
  degraded search deployments unchanged.
- **Risks.** Row budget of the child overlay (bounded viewport as elsewhere); read latency on
  cold sessions (one windowed read per open, no prefetch).
- **Harness adoption required.** No.

### P2 — render the command argument hint

- **User problem.** Commands whose descriptor declares `input.hint` (harness-registered
  commands with free-text arguments) give the terminal reader no vocabulary; the web client
  shows the hint at the input.
- **Harness authority.** `CommandDescriptor.input.hint` (public, adopted generation).
- **Why dshline falls short.** `attachment.ts` notes the hint in prose; `completion.ts` offers
  only enumerated argument values and never the hint.
- **Proposed terminal interaction.** When the composer is in argument position for a command
  whose input carries a hint and no value candidates exist (or alongside them, space
  permitting), the hint appears in the completion area as a note row; it drops whole when
  narrow, like every other hint.
- **Files.** `src/completion.ts`, `src/attachment.ts`, tests.
- **Tests.** Hint rendering in argument position; suppression when values exist or width is
  short; no hint for dshline-local commands.
- **Risks.** Completion list height budget (one row).
- **Harness adoption required.** No.

### P2 — capability probes for `settings`, `credentials`, and `llm`

- **User problem.** None directly; the gap is verification. The probe table is the
  repository's radar for upstream contract breaks, and three seams dshline depends on heavily
  are exercised only by Connect specs that the table does not name.
- **Harness authority.** `ctx.settings`, `ctx.credentials`, `ctx.llm` public surfaces.
- **Why dshline falls short.** `tools/capability-probes.mjs` has no rows for them.
- **Proposed interaction.** None (test-only). Add a small probe per seam under
  `packages/dshline/tests/capability/` (or name the strongest existing Connect spec) and add
  the table rows.
- **Files.** `tools/capability-probes.mjs`, new probe specs.
- **Tests.** The probes themselves.
- **Risks.** None beyond suite time.
- **Harness adoption required.** No.

### Backlog (not selected this campaign)

- **Persistent terminals (`ctx.terminals`)** — P1, large; needs a bounded-row design for a PTY
  inside the live region before any code exists.
- **Per-turn usage figures (`deriveTurnTokenUsage`)** — P2 polish for `/usage`.
- **Scheduled reminders catalog** — P2 polish reading the optional schedule projection.
- **`@`-completion over `ctx.fileReferences`** — P2; migrate the composer's `@` listing from
  direct `ctx.fs` reads to the shared file-reference seam (bounded fuzzy discovery, shared
  grammar, `formatFileMention` quoting), composing `file-reference-local` the way dshline
  already composes `session-stats`. Behavior-changing composer work; deserves its own slice.
- **Turn outline (`turnOutline` projection)** — P2; a bounded turn index, if an inspector ever
  wants one.

### BLOCKED (require upstream contracts)

- Session archive lifecycle (symmetric archive/unarchive + a corpus-visible archive fact).
- Cross-process session ownership/liveness (a lease or ownership contract).
- Human prompt-to-child seam for continuable subagents (human-authority messaging).
- Skill gesture readiness seam (whether `dsh-tool-skill` is mounted).
- MCP connection status contract (a registry/status service).
- A runtime Harness version service (the compatibility check reads manifests instead).
- A human-safe job kill (control semantics without model-delivery consequences).

### DECLINED (deliberately not appropriate for dshline)

- Rendering PTC sub-call timelines while no standard profile mounts PTC.
- A direct approval-policy/sandbox-mode knob beside the preset picker the harness's own
  clients use.
- Provider HTTP, secret custody, or a provider registry inside dshline.
- Any frontend-owned persistence, projection store, pricing authority, or session index.
- Web-plane presentation (client, api, gateway, sdk, acp, webhook).

## Correct non-support

The study is not a checklist that assumes every Harness package needs a dshline UI. Deliberate
non-support, each already documented in the repository, is a successful architectural
decision:

- **`ctx.jobs.kill()`** — a job killed by the human marks the record `reported`, silently
  eating the model-facing completion notice. Work observes jobs and refuses human kill.
- **Workflow run control** — the engine publishes `start()` and nothing else; there is no
  authority for a frontend cancel.
- **One-shot subagent interrupt** — only the holder (the model's tool call) owns it.
- **`ctx.compaction` / `compactRegion`** — reduction belongs to the registered `/compact`;
  range selection has no human control contract.
- **Persistence, storage, projection cache, workspace registry** — host-plane or
  single-process state dshline deliberately never touches; the corpus and cwd grouping replace
  them honestly.
- **Archive and cross-process liveness** — refused until upstream publishes symmetric,
  corpus-visible contracts; the refusals are documented in `ROADMAP.md` rather than hidden.
- **MCP, shell, code-runtime, LSP** — model-side or host-side seams whose user-visible output
  already arrives through generic tool cards or that publish no frontend contract at all.
- **Web plane** — client, api, gateway, sdk, acp, webhook, e2b, identity, hooks: an in-process
  terminal frontend is not a browser, and duplicating the web stack would be a second frontend.
- **Experimental packages** — upstream's own README excludes them from releases; adopting one
  would couple dshline to unreleased behavior.
- **Inbox/queue controls** — excluded from this study by decision of the campaign
  (`EXCLUDED — separate capability campaign`), not counted as a dshline defect.

## Upstream-blocked opportunities

Capabilities that become reasonable the moment Harness publishes a narrow contract, with the
minimum seam named:

| Missing seam | Would unlock |
| --- | --- |
| Symmetric archive lifecycle + archive fact on the corpus | an Archive action and archived-filter in `/sessions` |
| Cross-process session ownership (lease/heartbeat) | honest "open elsewhere" state in `/sessions` and `/worktrees` |
| Human-authority child messaging (`prompt-to-continuable-child`) | prompt a continuable child from `/work` |
| Skill readiness seam (`is the gesture boundary mounted`) | honest `/skills` readiness instead of a documented caveat |
| MCP connection registry/status service | an `/mcp` browser with server identity and health |
| Human-safe job cancellation | a Work kill action that preserves model delivery |
| Runtime version/capability service | a compatibility check that reads published facts instead of manifests |
| Transport-independent human queue control | the excluded Inbox/Queue campaign's prerequisite |

No speculative adapters are implemented against any of these.

## Excluded: Inbox / Queue control

All Inbox/Queue control capability work — queued-message browsing, editing, deletion,
individual queue-to-steer promotion, steer-all, pending-message reordering, arbitrary
`Agent.inbox` mutation, root-session and continuable-subagent queue management — is
**EXCLUDED — separate capability campaign**. This study documents only the existing delivery
behavior (queue/steer verbs, status-line counts, `ctrl-c` discard semantics) and the
upstream-blocked prerequisite (`sessionController.updateQueue` is web-bundle-only; the missing
seam is a transport-independent human queue control). The exclusion is not counted as a
dshline defect anywhere in this document.

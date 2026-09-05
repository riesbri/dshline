# Architecture

English | [中文](architecture.zh.md)

## Product boundary

```
DeepSeek Harness
        ↓
capability surfaces and domain state
        ↓
internal dshline presentation adapters
        ↓
bounded TuiSlots / Screen rows
        ↓
native terminal
```

**Harness owns capabilities; dshline owns terminal presentation.** Harness is
where lifecycle, state, persistence, provider selection, authority, and policy
belong. dshline reads the narrowest authoritative surface, turns structured
facts into terminal rows, and does not recreate a runtime, a provider
connection, or a domain state machine.

The renderer package is below that boundary. It knows display widths, control
escaping, keys, boxes, and `Screen`; it must not learn about Harness, agents,
jobs, providers, or a domain such as Todos.

## Native scrollback is the terminal model

`Screen.commit()` writes finished transcript rows into the user's real terminal
scrollback. Those rows are never virtualized, retained as an in-memory screen,
or rewritten. `Screen` redraws only the bounded live region at the bottom: a
streaming line, composer, status, or temporary overlay. Every terminal write
passes through it so that live region stays last.

This is deliberate product architecture, not a temporary implementation choice.
dshline will not replace `Screen` with a reconciler that owns historical
terminal output, or adopt an alternate-screen/full-screen transcript model.
React + Ink can support different terminal trade-offs; dshline keeps normal
terminal scrolling, selection, and copying available for its finished
transcript.

Future view code may become more declarative, but its final output must still
be bounded terminal rows for `TuiSlots` and `Screen`. An overlay may change the
live region while it is open; it must not rewrite committed scrollback.

## Supporting Harness capabilities

Supporting a Harness plugin does not mean copying each plugin or provider into
dshline. The upstream service graph calls some of these surfaces *seams* and
others core services; for presentation, the important distinction is whether
there is a standard authoritative contract dshline can consume.

### 1. Generic capability surfaces

Prefer a standard Harness surface over a concrete package or provider:

| Need | Authority | Presentation consequence |
| --- | --- | --- |
| background work | `ctx.jobs` | Observe generic job snapshots and changes. |
| delegated work | `ctx.subagents` | Observe provider-neutral lifecycle and discovery. |
| orchestrated work | `ctx.workflowEngine` + durable `tool-workflow/*` records | Observe run identity, phases, and members; own no run handle. |
| models | `ctx.llm` | Read registered provider/model metadata, and the configurable-provider directory of routes configuration can activate. |
| user configuration | `ctx.settings` | Read redacted namespace descriptors; write path ops against the revision they were read at. |
| secrets | `ctx.credentials` | Ask whether a reference or record is configured and writable; never hold a value. |
| obtaining a credential | `ctx.authorization` | Render the seam's neutral notice and prompt vocabulary; own no login protocol. |
| human commands | `ctx.commands` | Discover and execute the registered command contract. |
| tools | `ctx.tools` | Render tool-owned presentation intents, not tool-name cases. |
| human answers | `ctx.userQuestions` | Register a terminal answerer; claim a request this frontend can present, never assuming it was addressed only to this frontend. |
| sessions | `ctx.sessionQuery` | Query Harness's live-preferred session corpus; do not build another database. Its full-text methods are abstract, so treat content search as optional. |
| attachments | `ctx.fs` + `ctx.attachments` | Keep paths as session-local drafts; perform bounded reads through the active filesystem and publish durable image references as one batch. Never persist bytes, base64, or host paths. |
| log-derived state | `ctx.sessionProjections` | Consume registered domain snapshots and changes. |
| context occupancy | `ctx.sessionProjections` (`contextPressure`, `contextBreakdown`, `tokenUsage`) | Read the O(1) folds; never count tokens or tokenize. |
| session statistics | `ctx.sessionProjections` (`sessionStats`) | Read the whole-log counts and wall times; derive nothing beyond one division over two published totals. Treat the unit as optional. |
| context composition per entry | `ctx.tokenMeter` | Ask for the per-node measurement only when an inspector needs it; its own contract calls it O(surface). |
| reducing context | `ctx.commands` (`/compact`) | Dispatch the registered command; observe `compaction/*` events. Never call `ctx.compaction`. |
| agent composition | `ctx.agentPresets` | Read the roster, one preset's composition, and which preset a session actually runs; join or switch an agent through the seam, never a private registry. |
| host composition | `ctx.dshHomePath`, `ctx.baseUrl`, `dsh plugin` | Read the profile roster from Harness's own home-path service and the booted profile from the Loader's base URL; mutate only by forwarding to `dsh plugin`, never by writing a profile manifest. |
| skills | `ctx.skills` | Observe the effective per-scope catalog with `snapshot({ cwd, scope: agent })`; offer and inspect the resolved summaries. Never discover, load, or inject a skill body — a leading `/name` line is sent verbatim and `dsh-tool-skill` owns what it means. |
| provider health | `ctx.subagents` | Ask the registry which providers exist before presenting a row that names one as usable; never infer availability from a row being enabled. |

A new subagent provider should appear through `ctx.subagents`; a background
producer through `ctx.jobs`; an LLM adapter through `ctx.llm`; and a command
or tool through its standard registry. The real Codex acceptance has proven
that a provider publishing `ctx.subagents` / `ctx.jobs` is shown by generic
Work, not by Codex-specific dshline code. [Provider acceptance](provider-acceptance.md)
records that evidence and its configuration boundary. If a required fact is
absent from the surface, improve the upstream contract rather than parse text
or connect to a provider privately.

Skills are the current live example of that last rule. `ctx.skills` answers
which skills an agent can see and which of them are `userInvocable`, but the
consumer that actually interprets a human `/name` gesture is a separate
package (`dsh-tool-skill`), and no surface says whether a composition mounted
it. So a hand-built composition can publish a user-invocable skill that no
`/name` line reaches. dshline does not infer readiness — not by parsing preset
YAML, not by inspecting Cordis listener registrations, and not by treating a
model tool named `skill` as proof of a human gesture boundary; every one of
those reads implementation rather than contract. It follows `userInvocable`,
which is the same contract Harness's own Web client follows
(`session-controller`'s skill catalog Remote filters on `isUserInvocable`
alone), and the gap is documented for the user rather than guessed at. An
authoritative readiness seam is upstream work.

### 2. Known projection domains

A domain plugin may publish structured, log-derived state through
`ctx.sessionProjections`. dshline can offer a native presentation adapter for a
known key such as `todos` or `goal`, but the domain and Harness remain the
state authority. The TUI must not parse tool output, fold a second copy of the
session log, or create a competing persistence format.

The projection pattern is:

```
domain plugin
        ↓ registers a projection unit
Harness projection registry drives, caches, and notifies
        ↓ snapshot + change feed
dshline presentation adapter
```

For authoritative projection state, read
`ctx.sessionProjections.snapshot(session)` and subscribe with
`ctx.sessionProjections.onChanged(...)`. The registry drives registered pure
units over committed events, gives `snapshot()` one synchronous consistent cut,
and emits a change only when a unit changes. dshline's internal,
session-scoped observer subscribes once for the exact `Session`, coalesces an
invalidation in a microtask after that synchronous drive settles, and leaves
all values in the registry for adapters to read through `snapshot()`. It is not
a second projection store. Projection-key presence is process-wide, not a
per-session capability signal: a key registered by any composition can appear
in every session snapshot. Interpret the projection value (for example, a Todo
list or `null`) rather than treating the presence of `todos` as proof that this
exact agent has Todos enabled. This is an internal architecture pattern, **not**
a stable public `ProjectionAdapter` interface.

`todos` is the second proof. `@deepseek-ai/dsh-tool-todo` supplies the
model-facing `todo_write` tool, durable whole-list `todo/write` events, and the
optional `todos` projection. dshline presents its current snapshot through a
bounded `/todos` overlay and an optional `todo completed/total` status segment;
it owns no Todo mutation, lifecycle, fold, or persistence. Todo items have only
`content` and `pending`, `in_progress`, or `completed` status; each write
replaces the complete list. The projection is `null` before a write, contains
the latest list, and clears on the next `turn/start`. The intended path is:

```
@deepseek-ai/dsh-tool-todo
        ↓ todo/write and todos projection
ctx.sessionProjections
        ↓
dshline Todo presentation
```

It must not inspect `todo_write` calls or rendered cards to infer state.

Permission selection follows the same boundary: the optional `permissions`
projection supplies the deployment-defined selectable values and current state;
a bare terminal `/permission` only presents that select, while a chosen value
runs the registered Harness `/permission <preset>` command. dshline never folds
permission events or calls the preset service directly, and without the
projection the bare command falls through unchanged.

Context intelligence is the fourth, and it is the one that separates a cheap
authority from an expensive one. `@deepseek-ai/dsh-token-meter` publishes three
projection units — `contextPressure` (the provider's newest prompt sample, the
same sample plus the signed heuristic repricing of the surface since, and the
newest recorded route capacity), `contextBreakdown` (heuristic system/tools/
messages composition), and `tokenUsage` (cumulative provider buckets) — all
O(1) folds. Those are what the status line and `/context`'s headline read.

The same service also exposes `measure(session)`, which prices every node of the
current surface and returns a deep clone; its own documentation states that
measurement is therefore O(surface). That is the per-entry X-ray, and the rule
is that only an open inspector may ask for it. dshline keys a cached measurement
on every input a node price depends on and nothing else: Harness's own surface
revision (node count plus `replaceGeneration`) and the effective pricing route,
read from `session.requestHeader()` because the header's provider and model are
what select the routed adapter's image pricing the meter prices with. So an
inspector left open through a streaming reply measures once, while a landed
compaction or a route change is picked up on the next paint, and the log length —
which moves on every chunk — is deliberately not part of the key. Only a
SUCCESSFUL measurement is cached: an absent or refusing meter is retried, because
the meter can be mounted after an inspector first read and a throw over a
malformed log can be repaired by a later append. No timer exists for any of it.

The two vocabularies are never mixed. Projected occupancy and heuristic
composition are presented side by side and never divided into each other, and
per-entry prices are presented as estimates because the node meter is
route-priced or heuristic rather than a provider's tokenizer. Scaling one into
the other to make a panel add up would be dshline inventing accounting — which
is also why a per-entry share is labelled as a share of the MESSAGE context:
`surfaceTokens` prices the conversation, and the envelope is priced by the other
authority.

Provenance follows the same rule. `contextPressure.projectedTokens` is presented
as a projection, not as a provider figure that occasionally becomes exact:
equality with `pressureTokens` does not prove the surface has not moved, since
several changes can net to zero. A compaction summary is claimed only from
compaction's own durable checkpoint source — the `{ kind: 'plugin', plugin:
'compact' }` marker plus the transaction's `compactionId`, read structurally
rather than through `isCompactCheckpointSource`, which is a value in an optional
package — and any other replacement is reported as `replaced`, because the
surface contract permits a replacement from any producer and does not say a
replacement was a reduction.

`tokenUsage`'s scope is the agent's own model requests. A compaction's summarizer
reports its usage on `compaction/summary`, which the projection does not fold
(upstream's own projection test appends that event and asserts the buckets hold
still). dshline reports that scope rather than adding accounting for it.

Session statistics are the fifth domain, and the first one dshline composes
itself. `@deepseek-ai/dsh-session-stats` publishes a single `sessionStats` unit
— whole-log `turns`, `steps`, `llmMs`, `toolMs`, `ttftMs`, `ttftSteps`,
`decodeMs`, `decodeTokens` — folded over the complete durable log, so a resumed
session reports the whole of itself rather than the part this process watched.
`dsh-base` does not mount it, and upstream's own TUI and headless assemblies
therefore serve no such key, so dshline's bundle patch inserts the row
host-plane, beside the frontend's own rows and **not** behind an agent preset:
the unit registers a pure fold, is model-invisible, and is keyed by session
rather than by agent, so preset ownership would make `/usage`'s performance
figures a function of which preset a session happens to run — and would register the same
unit once per mounted preset. What upstream demonstrates is narrower than that
argument: Harness's own Web bundle mounts this same official package as a
host-level bundle row for the surface that consumes it, its chat stats strip.
This row is that same treatment for a different reader — one bounded `/usage`
section — and the reasoning above is dshline's.

The presentation treats the unit as optional regardless, and that is the part
that matters. Package availability and capability availability are separate
concepts: the shipped frontend brings the plugin its own bundle mounts, as an
ordinary dependency, while a composition remains free to drop the row. A
profile that does boots, runs sessions, and reports its tokens, cache split, and
cost exactly as before; the performance section says in one line that the
profile does not mount Harness session statistics, or is omitted entirely when
there is no projection registry at all, because the section above it has already
said so. There is no fallback implementation: dshline does not recount the
session log, install a timer, replay events, or keep an accumulator of its own,
and the only arithmetic it performs over the projection is two averages —
`ttftMs / ttftSteps` and `decodeTokens / (decodeMs / 1000)`.

Two rules govern what is printed, and they are different rules. A derived figure
with no denominator is absent, because `0 / 0` is not an average. A summed wall
time of zero is also absent, and for a stronger reason: in this unit zero is the
absence of a contribution rather than a measurement of zero. `llmMs` accrues only
over the request wall time from `step/start` to an assembled `assistant/message`,
and `toolMs` only over a `tool/call` matched by its `tool/result`, so a step that
streamed and was then cancelled, and a call whose result never landed, both leave
their total at zero while real work elapsed. `model time 0ms` would therefore
claim a measurement Harness never made. The counts are the exception and stay
unconditional: `turns` and `steps` come from `step/end`, which the agent loop
appends in a `finally`, so a zero there is a real count.

Nothing interpolates between Harness's updates to make a value move more smoothly
than the projection itself does. The section is live because it reads the same
session-scoped observer cut everything else reads, on the redraw a projection
change already causes — and because `sessionStats` and `tokenUsage` are values in
one `ProjectionSnapshot`, the two projection-backed halves of `/usage` cannot
describe two different moments. The money beside them is not in that snapshot:
it stays dshline's own pricing fold, reported alongside rather than within.

Compaction follows the observation/control split. dshline reads the durable
`compaction/start`, `compaction/summary`, `compaction/end`, and
`compaction/prune` events to present what changed, including for an automatic
compaction that has no command lifecycle at all, and correlates a command
result with the event it names through `sourceEventSeq` — honoured only for an
event this frontend actually projects. Reduction itself stays the registered
`/compact` command's, which owns validation, the idle-agent lock, cancellation,
the durable lifecycle, and the persistence checkpoint. `compactRegion` exists on
the service and is deliberately not exposed: the human command is argument-free,
and a range-selection UI would be a control contract upstream has not defined.

Goal is a known projection domain with two authorities, and dshline reads each
from its owner. Everything durable — objective, phase, blocked reason,
`roundsStarted`, `maxGoalRounds`, revision, timestamps — comes from the `goal`
projection, out of the same session-scoped observer cut the status line already
takes for Todo and context occupancy, so Goal adds no second direct dshline
snapshot. `ctx.goals` answers exactly one question, and is asked only where the
answer can change the reading: live, process-local continuation activation, for
a projected goal whose durable phase is `active`. That read is live and never
cached, because `disarm()` is process-local by design — it changes activation
with no `goal/change` event, no revision, and no `goal/changed` notification, so
no projection observer can reconstruct or own it. An activation that cannot be
obtained is never taken for `armed`: a resumed session holding a durably active
goal reports `goal idle` rather than claiming this process will continue it,
which is the one thing neither authority could say on its own.

The service call is a whole-view read because the adopted generation publishes
no activation-only accessor, and `GoalService.get()` resolves its own durable
half through `sessionProjections.stateOf(session, 'goal')` before combining it
with process-local runtime state. That inner read belongs to the service, not to
this frontend, and `.activation` is the only field taken from what it returns —
so the authority split is exact even though it is not yet physically narrow. An
upstream activation-only accessor would remove that service-side `stateOf()`
read and make it both. Plan remains governed by its documented Harness
authority.

### 3. Novel third-party capabilities

A third-party plugin can introduce a domain for which dshline has no native
adapter. That is the reason to eventually offer a small TUI contribution API,
not a reason to promise bespoke UI for every plugin. First we need several
internal adapters to establish authority, lifecycle, and layout rules.

`TuiSlots`, `TuiSlotView`, `TuiSlotName`, and `TuiOverlay` are experimental
pre-1.0 vocabulary. They are not a stable SDK, and no public API package is
committed yet. Persistent extension rows additionally need a global layout
budget; until then, capability UI belongs in bounded overlays.

**Composer and overlays share a visual root, not ownership.** The composer and
every temporary overlay draw through one shared frame — `dshline` on the left,
the workspace or the view's identity on the right, navigation help inside the
bottom border — so a browser reads as the composer expanded rather than as a
detached modal. The sharing is presentation only: while an overlay is mounted it
still replaces the entire live region and owns every keystroke, the composer's
buffer and cursor are not underneath it, and closing it restores the composer
untouched. The shared chrome is a pure helper with no state, no inputs beyond
what it renders, and no lifetime or view of Harness; input and state ownership
are not shared with it.

## Work: the first generic adapter

Harness Work is the first adapter following this model. It presents `ctx.jobs`,
`ctx.subagents`, and Harness workflow runs in separate sections through `/work`
and an optional status summary. It reads job snapshots with `list()` and
observes `onJobsChanged()`; it does not consume the model-facing `read()`
cursor. It observes subagent lifecycle edges and enriches only from
`listChildren()` facts that Harness publishes. It neither merges two authorities
without an authoritative correlation id nor invents labels or active runs that a
provider did not expose.

Three authorities, one projection layer:

```
ctx.jobs                        → Jobs
ctx.subagents                   → Subagents
tool-workflow/* + workflow/*    → Workflows
```

Workflows needed a second ownership rule, and that is why they are a separate
adapter rather than more branches inside the jobs/subagents projection. Job
reads answer per caller and subagent lifecycle edges are scoped to the
delegating parent, but a raw `workflow/*` event carries `{ id, meta }` — a run's
identity and never the Session that asked for it. Subscribing to that feed alone
would show another window's orchestration inside this one.

So ownership comes from the durable side. `dsh-tool-workflow` appends
`tool-workflow/run-start` / `agent-start` / `agent-end` / `run-end` into the
parent Session of a top-level run and nowhere else; a nested run started inside
a subagent records nothing. A run whose `run-start` reached the attached
session's own log is provably this window's, and live `workflow/*` events are
accepted only for a run those records already proved — as enrichment (the
description, the current phase, the newest log line, the terminal stop reason),
never as a second member store. Four of the six `workflow/*` events are
subscribed: `workflow/start` is emitted synchronously inside
`workflowEngine.start()`, so the gate drops it every time, and
`workflow/agent-end` fires only for a call whose `agent-start` already carried
the identical meta. Reconstruction is
live-feed only: a `run-start` left behind by a process that died is not evidence
that a script is executing now, and durable workflow history belongs to the
transcript.

That ownership rule also buys the one correlation Work makes. `WorkflowAgentInfo`
publishes each member's `childId` on the subagent seam, so a workflow member and
a subagent epoch are provably the same child; the member presents that child
under its workflow instead of repeating it in the flat Subagents section, and
navigating from the member reaches the same subagent presentation. No other pair
of records is joined, and a settled member releases the join.

The animation rule follows from the same discipline. The arc spinner means
dshline holds evidence of running computation — a live in-process child Agent
Harness reports as `running`. A Job in `running` is a registry record rather
than an observation, and a provider that publishes no in-process child exposes
no intermediate activity through the generic seam, so both stay static. A
workflow animates only while one of its own members does, because the engine
publishes no execution signal of its own between `agent()` calls. `ctx.workflowEngine`
exposes `start()` and nothing else a UI could reach, so Work observes workflow
runs and offers no control over them.

The manually validated Codex provider is an acceptance proof for these generic
contracts, not a direct dshline integration. Claude Code through
`@deepseek-ai/dsh-subagent-claude-code`, `ctx.subagents`, and `ctx.jobs` is the
logical next target, but has not been manually validated. The required path for
both and future providers is documented in [Provider acceptance](provider-acceptance.md).

## Sessions: one corpus, and two lifetimes

Sessions is the third adapter, and it reads exactly one authority. `ctx.sessionQuery`
already publishes a live-preferred logical corpus that merges `ctx.sessions` with
whatever persistence is mounted, so the browser lists `listSessions()` records and
folds their titles with one batched `readTitleSnapshots()` observation. There is no
sessions-directory scan, no title cache, and no second index; a frontend index
would disagree with the corpus the first time either changed.

Those two reads are the whole cost of browsing, which is a presentation decision
rather than a lucky one. The browser is a PICKER first: a row is the title and
the relative age, because those are the two facts that answer "which session,"
and every other fact competes with the answer. Workspace, origin, availability,
lineage, event count and session id are disclosed for ONE session behind `→`.
That is also where `listEvents()` is read. An event count and a last-activity
time cost a whole log load and surface fold, so a list that shows them has to
take that read every time the cursor moves; the disclosure is the surface that
presents them, so opening it is what pays for them. Filters answer a question
about the corpus rather than about a row, so they are a browser-level `ctrl-f`
— a ctrl gesture because every printable character here is already search input.

Archive is Harness's, and dshline does not present it. `ctx.workspaceRegistry`
owns a durable registry-global archive set and `archiveSession()` adds to it,
but upstream records that archiving is one-way and no unarchive operation exists
yet, and the archive set is not a `ctx.sessionQuery` fact — `SessionRecord`
carries no archive field, `SessionResultFilter` has no archive predicate, and
the only stream of archive changes is the Workspace controller's Remote
`follow()`. Offering Archive would hand a reader an irreversible hide; hiding
archived sessions would take them out of the one surface that can still resume
them, and would require a second corpus authority to know which ones they are.
Both wait for a symmetric upstream lifecycle.

The engine's two full-text methods are its ONLY abstract surface, so content
search is an optional capability rather than a guaranteed one. A deployment whose
backend implements none reports `SESSION_QUERY_SEARCH_DISABLED`, and the browser
keeps filtering the rows it already has while saying that content search is off.
Filtering is not a private index: it matches the text a row already displays.

Sessions also forced a lifetime split the frontend did not previously need:

```
window        terminal, key routing, model route, reader preferences
   ↓ attaches
attachment    one Agent, its log projection, its capability adapters, its views
```

While a launch drove exactly one session for the life of the process, the plugin
fiber and the session were the same lifetime, and `ctx.effect` was the right
owner for everything. Reopening a session in place breaks that identity: the slot
registrations, the log listener, the spinner, and the Work and projection
adapters all describe one session, so they belong to a `SessionScope` that comes
down before its agent handle does. Key routing moved the other way, up to the
window, which is also why `ctrl-d` now quits from the launch browser without that
browser owning a keyboard of its own.

Reopening uses the supported lifecycle and nothing else: the owned
`AgentHandle.dispose()` retires the current agent — the handle is this
frontend's capability because this frontend created the agent — and
`ctx.agents.resume` opens the next one. The transcript is appended into native
scrollback under what is already there; nothing committed is rewritten. A
rejected resume neither ends the process nor substitutes a session: by then the
previous agent is already retired, so the window commits Harness's reason and
asks again through the same browser. Dismissing that is how a reader chooses a
fresh session deliberately.

## Connect: configuration is four seams, not one

Provider configuration is where a frontend is most tempted to grow its own
opinions — a provider list, an OAuth implementation, a file it writes keys to.
Harness already owns all of it, in four separate surfaces that answer four
different questions:

| Question | Authority |
| --- | --- |
| Which provider routes can be configured at all? | `ctx.llm.listConfigurableProviders()` |
| Which are registered right now? | `ctx.llm.listProviders()` |
| How is one configured, and at what revision? | `ctx.settings.describe()` / `mutate()` |
| Is the secret it names present, and writable? | `ctx.credentials.describe()` / `set()` |
| How is a credential *obtained* when it must be asked for? | `ctx.authorization` |

`/connect` is the join of those and nothing else. Three consequences follow, and
each is the reason a shortcut was refused:

**No provider registry.** A route reaches the browser because a mounted adapter
declared it configurable — which a bare-mounted `llm-pi-ai` does for its whole
installed catalog before any route exists. dshline ships no list of provider
names, so an adapter that adds one is presented without a code change here.

**No field-name knowledge.** Storing an API key needs to know which profile
property carries the credential *reference*, and both shipped adapters call it
`apiKeyEnv`. dshline does not: it reads the namespace's serialized schema from
`describe()` and takes the property whose schemastery role is `credential-ref`.
The role is the contract; the name is a coincidence.

**No login protocol.** `ctx.authorization` renders as one notice shape and three
prompt shapes — `text`, `secret`, `select` — which is deliberately smaller than
any provider's own vocabulary. A surface that renders one flow renders all of
them, so OAuth, device code, and a key typed into a provider library's prompt
all arrive here as the same interaction. The terminal-specific decision is only
*where* each half goes: a notice is committed to native scrollback, because a
sign-in URL and a device code are the two things a person most needs to select
and copy, while a prompt is a bounded overlay because it takes the keyboard.

The browser owns the lifetime of what it starts. An authorization attempt can
sit waiting on a browser callback with no prompt mounted, so closing `/connect`
aborts the attempt's signal — the seam settles it as `cancelled`, any mounted
prompt comes down with it, and a later notice or prompt from a flow that has not
yet observed its signal is dropped rather than drawn over an unrelated
transcript.

Because both surfaces write the same namespace and the same reference, a change
made in the terminal is visible on the official web Models page and the other
way round. Neither has a store of its own to disagree from. The
`<ROUTE>_API_KEY` derivation for a route whose profile names no reference yet is
shared for exactly that reason.

`/connect` still does NOT merge its two sections. A configurable-provider
entry is addressed by `settingsNs` plus a route key; an authorization flow is
addressed by a `CredentialKey` whose scope is its owning plugin's registered
name. Harness publishes no contract that the two must correspond in general, so
merging the rows would be the frontend inventing a correlation — the same
refusal Work makes when it keeps jobs and subagents apart. Both are listed,
each under the identity Harness gave it.

What did change is the claim, not the refusal. One adapter family documents the
correspondence for ITSELF, on both sides: `dsh-llm-pi-ai`'s `recordKeyFor`
builds `llm-pi-ai/<providerId>` and calls that id "pi-ai's own provider id,
which is also the harness route key", while its `directoryEntries` publishes
the same id at `providers.<id>` in the same namespace. Reading one family's own
published identity is what `connect/pi-ai.ts` exists to do — it already holds
the curated field names and the declaration target for exactly this reason —
so `piAiSignInRoute` lives there and `connect/model.ts` stays generic, holding
a `route` field a presentation module may fill and deriving nothing. The link
is verified rather than assumed: a key resolves only against routes the
directory actually published, at the address it publishes them at, so a scope
that stops naming this namespace or a namespace that moves its routes both
answer "unknown" and leave the sign-in standing alone.

That link exists because the two writes are genuinely separate and both
required:

```
ctx.credentials   the RECORD an authorization flow commits   llm-pi-ai/openai
ctx.settings      the PROFILE that registers a route         llm-pi-ai.providers.openai
```

`registerPiAiFlows` offers a login for every installed catalog provider
"independent of the route set", while the adapter registers routes only for the
profiles settings supply. Both halves are right, and together they produce the
one failure this frontend most needed to explain: a person signs in, the flow
reports success, and `/model` still has nothing. `connect/activation.ts` is the
missing sentence and nothing more — it offers `Activate this route`, the action
the browser already had, against a FRESH reading, and writes only when a human
picks it. **A successful authentication is not consent to change provider
configuration**, so a dismissal, a `Not now`, and a closed browser all leave
settings untouched; and judging from a stale snapshot would mean writing an
empty profile over a route something else configured in the meantime.

### The authorization seam is a row dshline composes

At the adopted generation no shipped Harness bundle mounts
`@deepseek-ai/dsh-authorization` — not `dsh-base`, not `web-app`, not
`headless`, not `acp-app`, and not the `dsh` app itself. The one package that
registers flows into it scopes that registration to the seam's presence
(`ctx.inject(['authorization'], …)`), so a composition without the row has no
account sign-in for any provider: `/connect`'s Sign-ins section is permanently
empty and an account-authenticated provider is unreachable from a terminal.

dshline's own `cordis.patch.yml` therefore inserts it, exactly as it inserts
`session-stats` and for the same stated reason — a host-plane seam this surface
reads that the base does not carry. That is composition, which is what a bundle
is for; it is not dshline implementing, wrapping, or installing anything. The
seam and every flow remain Harness's.

The alternative was considered and rejected. `dsh-authorization` declares no
`dsh.bundle`, so `dsh plugin add` would install it as a plain dependency that
composes nothing — the "installed but inert" state `/profiles` already reports
— and finishing the job would mean dshline writing a composition row into the
profile's own `cordis.patch.yml`, a patch layer no Harness mutation API owns.
A first-run installer for a capability a bundle can simply compose is a second
lifecycle where none is needed.

Because the row is now dshline's to mount, its shape is dshline's compatibility
problem too: `tests/capability/authorization.probe.spec.ts` mounts the real
service over a real abstract `CredentialProvider` subclass, and
`tools/capability-probes.mjs` names it as the `authorization` seam's evidence.

The seam surfaces themselves are written out structurally in
`connect/harness.ts` rather than depended on as whole services, for the reason
`SessionQueryReads` gives — naming the calls a view makes is more legible than
depending on a whole service. Every import in that file is still type-only, so
Connect carries no Harness code at runtime; three assignments in
`connectSeams` check each narrow view against the real service on every build,
because each service package augments `Context` with its own type.

### Connect 2.0: one route can be a declaration, not only a lookup

`listConfigurableProviders()` says which routes an adapter already knows how
to activate. It says nothing about a route that does not exist yet — a
private gateway, a self-hosted server, a localhost OpenAI-compatible
endpoint — because nothing in `LlmConfigurableProvider` marks "this namespace
accepts a key it has never seen." That gap is real on current Harness: there
is no generic seam a configuration surface can ask "may I declare a brand-new
route here," and the official web Models page closes it the same way this
frontend does — by knowing, specifically, that `llm-pi-ai`'s settings profile
can describe a whole provider route.

A schema shaping a namespace's routes as a `dict` — the shape that means "one
element node describes every key, seen or not" — proves only that arbitrary
keys are structurally accepted there. It does not prove that writing one
declares a new LLM route: a future adapter could publish
`providers: dict<ProviderConfig>` while still only recognizing a fixed set of
keys, and the schema shape alone would say nothing to the contrary. `/connect`
does not let that inference cross into generic code. `connect/model.ts` keeps
`ConnectNewRouteTarget` as a plain data shape — a namespace, a parent path, a
revision — and asserts nothing about which namespaces it is safe to produce
one for; it is never derived there from schema shape alone.

That determination is made once, inside `connect/pi-ai.ts`, which is the one
module allowed to know that `llm-pi-ai` specifically is a domain whose
settings profile can describe a whole provider route.
`piAiDeclarationTarget()` filters the directory to `llm-pi-ai`'s own entries
first, then checks that they agree on where their dict sits, that the schema
there really does shape it as a `dict`, that the curated `baseURL` field is
still reachable, and that a protocol choice can still be derived — the same
schema-shape check `protocolChoices()` makes, because a namespace this module
cannot offer a protocol for is one it cannot safely declare a route into
either. Any one of those failing means the schema drifted from what this
presentation module knows how to read, and `+ Add custom provider` is offered
only when every check passes — never a row that is guaranteed to fail partway
through the wizard, which is the same "no offer known to fail" rule the rest
of Connect already follows for its ordinary actions. If another Harness domain
later published its own declaration seam, `piAiDeclarationTarget()` is the
function to replace, not `connect/model.ts`.

Knowing an address exists is not the same as knowing what to write there. A
curated editor needs field names — "base URL", "protocol", "request headers",
"model catalog" — that no generic seam publishes, so presenting them at all
means knowing one namespace's shape. That knowledge is isolated in
`connect/pi-ai.ts` alongside the declaration check above, and:

- names its five curated fields (`displayName`, `baseURL`, `api`, `headers`,
  `models`) as plain strings, and reads protocol *choices* from the namespace's
  own serialized schema (`z.union` of string consts) rather than a dshline
  constant, so a protocol `dsh-llm-pi-ai` adds later needs no change here. The
  test for which fields earn a terminal form is what a route can REACH, which
  is why `headers` is in — a gateway authenticating with anything but the
  `credential-ref` field is otherwise unreachable from the terminal — and why
  `compat`, retry policy, and per-model reasoning stay out;
- reads the SHAPE of a curated field from the schema even where it hard-codes
  the name: `headers` is offered only while the namespace still describes it as
  a dict of strings, the same fail-closed check that makes an unreadable `api`
  union produce no protocol choices rather than a stale list;
- writes through the same `ctx.settings.mutate()` path ops every other Connect
  action uses — one `set`/`unset` per changed field, never a wholesale
  replace, so `compat`, retry policy, and anything else this pass does not
  render survive an edit untouched;
- never imports `@deepseek-ai/dsh-llm-pi-ai` at runtime, registers no
  provider, parses no model output, and makes no network request. Harness
  still does every one of those.

The create wizard itself fails closed the same way its declaration check
does: if the protocol choices it derives at the moment the wizard opens turn
out empty — schema drift between the row being shown and the wizard actually
starting — it refuses immediately rather than writing a guessed `api: ''`
Harness would reject several steps later with a less useful error. And the
wizard never persists mid-flow: every field, including the model catalog, is
collected into an in-memory draft first, and only an explicit "Create
provider" on a final review — Provider ID and every other field shown back,
the API key only ever as "configured" or "not set" — triggers the first
write. Leaving the model submenu without adopting anything, in particular,
changes nothing: a route that inherits its catalog stays inherited until a
real adoption happens, never becoming a stored `models: []` merely because the
submenu was opened and closed.

`connect/model-editor.ts` and `connect/route-editor.ts` sit on top: the first
is pure draft logic for a model list (adopting a discovered candidate without
overwriting a hand-corrected capacity, telling an inherited catalog apart from
an explicit empty one), and the second sequences the same `promptSelect` /
`promptText` overlays every other Connect action already uses into two small
menu loops — editing an existing declared route, and declaring a new one —
rather than a bespoke form overlay.

Model discovery is advisory, and stays that way by construction:
`ctx.llm.discoverModels()` takes a draft (`provider` for an existing route, so
the owning adapter resolves its own stored credential without this frontend
ever reading one back; a one-shot typed key for a route that does not exist
yet) and answers candidates. A candidate whose id is already in the draft is
left untouched — an endpoint listing carries at best an id, a name, and two
capacities, never more than a row a person already corrected knows — and
nothing fetched is written until the reader explicitly saves.

The result is the shape the acceptance test is built around:

```
custom endpoint
    ↓
Harness settings  (ctx.settings.mutate through connect/pi-ai.ts's path ops)
    ↓
llm-pi-ai         (resolves the declared profile into a live provider)
    ↓
ctx.llm provider route
    ↓
dshline /model
```

never:

```
custom endpoint
    ↓
dshline client
```

dshline performs no provider HTTP request, owns no secret beyond the one-shot
value it hands to `ctx.credentials.set()` after an explicit create, and keeps
no second state store: a created route is addressable, editable, and
removable through the exact same seams every catalog route already goes
through.

## Presets: composition is Harness's, not dshline's

An agent preset is Harness's own answer to "what can this agent do" — a named
composition of tools, prompt sections, and delegation backends, resolved
through `ctx.agentPresets` and joined to an agent at the one supported point
in its lifecycle, `setup(agentCtx)`. `/plugins` is the terminal presentation
of that seam: it lists the roster, shows the rows the running agent's preset
actually composes, and carries out a change through the same authority a
change made from the official web interface would use. It keeps no plugin
registry, no capability list, and no provider-specific branch of its own —
exactly the rule every other adapter in this document follows, applied to
"which tools does this agent have" instead of "which providers can it talk
to."

**System presets are Harness's, and stay read-only here.** A preset shipped
with the deployment carries `system` trust; `/plugins` never edits that file.
Customizing one is Harness's own supported path — copy it to a new, locally
authored preset (`ctx.agentPresets.copy()`) and edit the copy — and pressing
space on a built-in preset's row is the terminal's offer to do exactly that,
never a shortcut around it. A user-authored copy has no narrower Harness
mutation API than its own composition file, so toggling one row there is the
smallest edit that touches only that field and leaves the rest of the file
alone; Harness's own health check on that preset, not a private read of it,
still decides whether the result is usable.

**Session composition is a lifecycle fact, not a setting this frontend
keeps.** A new session composes from the roster's current default. A resumed
session composes from whatever its own log recorded — the preset it was
created with, or a later switch made while it was still blank — never
whatever the default happens to be *today*; a produced session's tool set is
history, and treating it as a live setting would let it drift out from under
a conversation that already happened. Which preset that is, is read from
Harness's own `agentPreset` Session projection, which folds the creation
header with every later selection; dshline reconstructs nothing from the raw
log, so the resume path and `/plugins` cannot disagree about what a session
runs.

**Offering an action and authorizing it are different jobs.** Switching a
session's preset is Harness's whole operation — `ctx.agentPresets.select()`
serializes selections per session, re-reads the authoritative `turnBoundary`
projection inside that queue, refuses a started session, recomposes, and
records the switch only once the recomposition committed. `/plugins` calls it
and reports the answer. What this frontend still decides is only what to put
in front of a reader: a started session is offered the *default for the next
session* instead of a switch it cannot have. That offer reads the same
`turnBoundary` projection Harness re-checks, at the instant it is acted on
rather than from the reading a keystroke was decided against — an action here
holds its own awaits, two prompts a human answers, a file write, a Harness
re-resolve, and a turn beginning across them must move the answer. It is a
presentation decision that happens to agree with the authority, never a
second copy of it.

Where that history cannot be placed exactly, the gap is named rather than
papered over. A session produced before dshline adopted presets recorded no
preset at all, and resumes under the shipped `standard` — the preset built to
mean the exact flat tool set every such session actually ran under. A
deployment shipping no usable `standard` has no honest equivalent, so the
resume falls back to that deployment's own default and reports the
substitution into the transcript. Refusing the resume outright would protect
a composition record by withholding the transcript it belongs to, which is
the wrong trade: the reader can see a caveat, and cannot see a session that
will not open.

This is also why dshline's own composition changed shape to adopt it. Before
presets, dshline mounted `dsh-base`'s full tool set once, for the process —
correct for a frontend with nothing to switch between, but nothing for a
composition-browsing command to browse. Every per-agent row `dsh-base` used to
mount unconditionally now moves behind whichever preset an agent actually
joins, the same "agent plane moves behind agent presets" step Harness's own
Web bundle already took for the identical reason; process-wide services with
no per-session meaning — registries, the sandbox and approval stack, the
token meter — stay exactly where they were.

## Profiles provide; presets expose

Two Harness layers answer two different questions, and conflating them is the
mistake this frontend is built to make visible.

```
profile   what the HOST can do    dsh.profile.bundles → patch layers → the composed tree
preset    what an AGENT may see   agent.cordis.yml rows → one agent's tools and prompt
```

A profile is chosen by the launcher and applied once, at boot. A preset is
chosen per session and can be recomposed while a session is still blank. So
`/profiles` and `/plugins` are not two views of one thing: they sit on either
side of a boundary, and every difference between them follows from it.

**A row being enabled proves only the second half.** The shipped `standard`
preset says so beside its own optional delegation rows — "Install the matching
Bundle in this Profile and restart the Host, then copy this preset and remove
`disabled` from the matching tool row. Host availability alone grants no tool."
The reverse is easier to hit by accident: enabling a row whose bundle was never
installed yields a preset that mounts, a tool the model can see, and a
delegation that fails on first use. `/plugins` closes that gap where it can be
*proven* — a row naming a provider a mounted Host registry does not supply is
marked, and the row's own state is left honest. Where it cannot be proven,
nothing is claimed: the check is a data table of capability modules, so a
module it does not cover, a `!!js` provider it never evaluates, and a registry
this profile does not mount all produce no verdict rather than a guess.

**Restart is part of the boundary, not a caveat about it.** `/profiles`
performs bundle changes through `dsh plugin`, Harness's own package lifecycle,
and then says what it did and did not affect: a change to the running profile
reports `restart required`, a change to any other names the command that picks
it up. Switching profiles is not offered at all, because no seam re-links a
composed Host's bundle layers and inventing one would be exactly the competing
lifecycle this document forbids.

### The launcher's one lifecycle decision

`bin/dshline.mjs` is a launcher wrapper, and a first run is the only moment it
touches lifecycle at all. It asks one question and, when the answer is yes, runs
one Harness command — `dsh plugin --profile dshline add @dshline/dshline` —
through the same launcher an ordinary start uses, then continues into the launch
that was originally asked for. It writes no profile file, never calls pnpm, and
never reads a package's `dsh.bundle` declaration: each of those belongs to
`dsh plugin`, which already initializes a profile on first use and reconciles
`dsh.profile.bundles` against what is actually installed.

The boundary is one file. **Uninitialized** means the profile has no
`package.json` — the same test `dsh plugin` itself applies — and everything else
is an **existing** profile. A profile whose install was interrupted, whose
dependency is missing, whose `node_modules` is empty, or which fails to boot is
therefore launched anyway, and Harness's own loader says what is wrong.
Repairing it here would mean guessing at a diagnosis Harness makes
authoritatively and hiding it behind a package operation nobody asked for. An
explicit `--profile` — including `--profile dshline` — turns the behaviour off
entirely: the caller is using harness profile semantics directly, so the wrapper
adds nothing to them.

**dshline does not serialize or repair Harness profile mutations.** Concurrent
package mutation is Harness's to define; dshline delegates the setup it was given
permission to run and treats the harness's success or failure as authoritative —
a failed setup fails that invocation and launches nothing. So two overlapping
first runs each delegate, rather than one of them deciding the other's install is
finished. That decision has no honest local answer: `dsh plugin` writes the
profile manifest *before* it installs, so the file proves a setup began and never
that one completed, and telling the difference would mean reading dependencies,
node_modules, or bundle state — the profile health the paragraph above leaves to
Harness. A lock under `$DSH_HOME` would be the competing lifecycle this document
forbids.

## Setup: a conductor, not a wizard

Two things stand between installing dshline and sending a turn, and they live
on opposite sides of one boundary. `bin/dshline.mjs` can create the profile and
nothing else — it runs before any Host exists, so `ctx.llm`, `ctx.settings`,
`ctx.credentials`, and `ctx.authorization` are all out of reach, and reaching
for them would make the wrapper a second reader of Harness state outside
Harness. Everything past "the profile has a manifest" therefore belongs to the
plugin, which is where every one of those seams already is.

So `src/setup/` runs inside the composed Host, and `dshline --setup` keeps its
existing meaning (install this package into the profile). The flow opens
automatically before the first attachment, and `/setup` opens it on demand.

**The trigger asks whether this launch could send a turn, not whether a route
exists.** Route registration alone is the wrong question: a registered route is
only what `/model` offers FROM, and the composer opens on whatever
`selection.current` resolved to. So `setupReason` reads two things the window
already holds — `ctx.llm.listProviders()` and the selection ref `/model` writes
— and names one of three states: nothing registered, nothing selected, or a
selection whose route no adapter registered (a remembered default whose
provider has left the profile).

That is two synchronous reads and no I/O. It stops at PROVIDER granularity
deliberately: whether the route still serves that exact model id is a question
only `listModels` can answer, and asking it would put a possible network call
in front of every launch to refine a verdict the picker gives anyway. There is
no first-run marker anywhere — a stored "already set up" flag is duplicated
state that can disagree with the configuration it claims to describe, and
re-asking live state every launch cannot.

What setup contributes is a reading and an ordering, and nothing else. The
ordering leads with whatever is missing: once a route is registered, `Choose a
model` goes first, and when `/connect` closes having produced the first usable
route while the selection is still absent or stale, the conductor opens the
picker itself rather than returning to a checklist that would only say to open
it. The conductor does that, never `/connect` — the browser stays a browser and
knows nothing about setup — and only when the model is the missing piece, since
connecting a second provider is not a request to change a working selection.

Each step hands off to a browser that is already the authority for what it does
— `/connect` to configure and authenticate, `/model` to choose — so there is no
second route editor, no second model catalogue, and no state machine: the loop
re-reads Harness each pass and offers what is true now, which is why backing
out halfway leaves nothing behind and running it twice is the same as running
it once.

The reading is **committed to scrollback rather than drawn in an overlay**,
which is the terminal model doing real work rather than a style choice. Version
numbers and the sentence naming why there is no model are the output most worth
keeping; a bounded live region would scroll them away the moment the next thing
was drawn, and this is precisely the text a person pastes into a bug report.
The only live-region surface it uses is `promptSelect`, which is already
bounded, resize-safe, and tested.

### What a compatibility check may claim

Harness publishes no runtime version service at the adopted generation — no
`ctx.version`, `dsh-brand` is compile-time branding, and
`dsh-plugin-package-inventory-deepseek` builds a package list only as request
metadata for the official API. The evidence is therefore manifests on disk,
read through the machinery `/profiles` already owns: the adopted generation is
this package's own `dsh-*` peer pin (which `tools/harness-target.mjs` proves is
`HARNESS_TARGET.version`), and the installed one is the `@deepseek-ai/dsh-base`
version the running profile composes.

Three rules follow, and each is a refusal:

- **A mark is a claim, so an unknown gets no mark.** Either side unreadable is
  `·` and says so — never "incompatible", never "fine".
- **A mismatch states only the direction it can prove.** Installing the
  generation this build targets is deterministic, because that version is a
  fact the report already holds. Moving dshline instead is not its mirror
  image: `update` fetches whatever the registry serves, and nothing here knows
  whether any released dshline targets the installed generation. That
  direction is therefore offered as a condition, not an instruction —
  establishing it would mean resolving releases against their peer pins.
- **It never refuses to continue.** By the time dshline can compare
  generations, both halves have already booted together far enough to draw the
  comparison; offering "continue anyway" would imply a verdict Harness has
  already disproved by starting. A genuinely incompatible pair fails earlier
  and louder in the Loader, and that diagnosis is Harness's to give.

Node is reported without a verdict for the same reason in miniature: this
process is running on it, so a tick is circular, and turning `engines` into a
pass or a fail means evaluating a semver range.

## Observation is not control

A callable Harness mutation is not automatically a human-safe UI operation.
Before exposing a human action, verify that the owning surface explicitly
provides lifecycle semantics, authorization, scheduling semantics, and the
model-awareness or notification consequences of that action.

Sessions is the case where this rule pointed the other way. `AgentHandle` is
handed to the caller that created the agent, and its documentation says the
disposer is a capability held by that owner — so retiring the agent is authorized
here, and reopening a session is a human action the frontend may take. What
Harness does NOT define is what should happen to a job or a delegated subagent
whose owning agent disappears mid-flight, so the window refuses to reopen while
either is attached, and refuses mid-turn, naming the reason rather than guessing.
Renaming a session is deferred for the mirror-image reason: `ctx.sessionTitle`
models explicit `user` authority, so it will be exposed when the browser has a
text-entry mode, not as a side effect of listing titles.

`ctx.jobs.kill()` is the current counterexample: successful cancellation moves
the job to `stopping` and marks terminal delivery reported, which is a
model-facing control semantic. Work therefore observes jobs but does not offer
human cancellation. `ctx.subagents.interrupt(..., { kind: 'user',
parentSessionId })` is the contrasting case: the seam explicitly models human
authority to stop a live continuable child. This rule applies to every future
capability, not only Work. Likewise, Work presents lifecycle and job state,
not provider reasoning, commands, tool activity, progress, or diffs unless
Harness exposes those facts through a generic contract; it must never scrape
provider output.

## Upstream compatibility

dshline tracks Harness aggressively and supports it narrowly: it targets **one
adopted Harness architecture at a time**, kept close to upstream `master` so it
can use the latest Harness capabilities, performance work, and native APIs.
When Harness changes incompatibly the answer is to migrate dshline forward and
delete the obsolete assumption — not to add a compatibility layer, a runtime
feature test, or a second peer-range arm for an older prerelease. Both projects
are pre-1.0; historical prerelease compatibility is not a goal.

`HARNESS_TARGET` at the repository root is the single source of truth for that
architecture: one upstream commit, and the npm version cut from it. Every
`dsh-*` dependency in both manifests is pinned to that version, so an ordinary
`pnpm install && pnpm typecheck && pnpm test` validates the generation the
project claims to support rather than an older line that merely still resolves.
Every `dsh-*` dependency, devDependency, and peerDependency carries that
version literally — no carets, no `||`. A caret also promises later releases in
the same range, which is a compatibility claim nothing tests, and deciding
whether one still admits the target is exactly what a version compatibility
engine is for; exact versions delete the question instead of answering it.
`tools/harness-target.mjs` is therefore a string comparison, and it fails the
moment any of those specs drifts. `@deepseek-ai/cordis` and
`@deepseek-ai/schemastery` keep ordinary caret ranges: they version on their
own numbering and are not cut from the adopted revision.

The two lines in `HARNESS_TARGET` must describe one generation, and CI proves
it rather than trusting it — `Harness target` reads the checked-out Harness
workspace root's own `version` and fails with both values if it disagrees.
Without that guard a source lane and an npm lane could validate different
generations and both pass. The adopted revision is a release-generation commit
rather than an arbitrary point on `master`, which is what lets the source lane
and the published lane describe the same thing; it is not a claim that anything
older is supported. Advancing those two lines IS the migration, and it is one
commit.

The coverage is three separable questions, all in `.github/workflows/ci.yml`.
**Core** is dshline's own correctness on every supported Node, against the
adopted generation's published packages. **Harness target** checks the adopted
upstream revision out from source at that exact commit, builds it, and links it
with `tools/link-harness.mjs` exactly the way a local checkout is linked for
manual development — typecheck plus the capability probes, not the whole suite
a second time. It is blocking and deterministic: a full commit sha cannot move
between two runs of the same commit of this repository. **Harness published** answers the question source cannot: can
a normal user install this and does it boot, against the real published
launcher pinned to the adopted version.

Core additionally runs `pnpm peers check`, which is not about dshline's own
code at all. The Harness line states floors for packages that are deliberately
NOT pinned to `HARNESS_TARGET.version` — `@deepseek-ai/cordis` and
`@deepseek-ai/schemastery` version on their own numbering — and those floors
move between generations. When one did, nothing noticed for two generations: an
unmet peer is a warning an install prints and a build ignores, and the
source-linked lane cannot see it either, because linking a Harness checkout
substitutes that checkout's own vendored cordis. The check reads the lockfile,
needs no network, states no Harness-specific opinion, and simply refuses to let
the installed graph disagree with itself.

### Proposing the next generation

Nothing watches upstream `master` any more. Following a branch head was the
right instinct aimed at the wrong object: an arbitrary master commit is not
something `HARNESS_TARGET` can record, so the signal was never directly
actionable, and the lane that produced it had to be read and translated by a
human before it meant anything.

`.github/workflows/harness-sync.yml` watches what an adoption actually is
instead. Upstream marks every release generation the same way — a published
GitHub Release whose tag is `dsh-v<version>` — and every revision this project
has ever adopted is exactly the commit one of those tags names. A few times a
day, `tools/harness-sync.mjs` asks whether a newer one exists; if it does, it
resolves the tag to an immutable commit (dereferencing an annotated tag rather
than recording the tag object, and never reading `target_commitish`, which is a
branch name), checks that the commit's own root manifest declares the version
its tag encodes, and proves through upstream that the adopted revision is an
ancestor. Anything it cannot prove fails closed for a human to read.

Only then does it write the mechanical adoption state — the two lines of
`HARNESS_TARGET`, the governed `dsh-*` pins, a refreshed lockfile, and a
one-sentence changeset — and open a pull request.

That distinction is the design. The proposer never decides whether dshline
WORKS against the candidate; it reads no source and assesses no compatibility.
The jobs above do, on that pull request, exactly as they would for any other:

```text
harness-sync   is there a newer generation to propose?
ci             does dshline work against it?
```

Green means the adoption needed no code, and a human merges it. Red means a
real migration, and the answer is to migrate forward against that generation —
never to restore support for the previous one. There is no auto-merge, and
adding one is a separate decision to make after several generations have
actually behaved.

Two refusals are worth naming because both look like failures and are not. If
the candidate's packages are still inside the repository's release-age
quarantine, pnpm refuses to install them and the run reports that and stops —
no pull request, no exclusion, no independent age arithmetic. And an adoption
that is already open is never superseded automatically: it may carry migration
work, and force-pushing a newer candidate over it would discard exactly the
expensive part.

Development compatibility CI does not follow npm dist-tags. `next`, `alpha`,
and `rc` are upstream distribution channels, not dshline architectural
concepts: they change without the architecture changing, and a compatibility
lane keyed on a channel name would need redesigning every time one moved. The
target is an exact commit and an exact version, and the published lane asks
only whether that exact version exists on the registry yet. GitHub source moves
first and npm catches up afterwards; when it has not caught up, that lane says
so and validates nothing. "Not published yet" is a release-channel fact, and
it is never a reason to write compatibility code for an older published
generation.

### The release channel is a separate question

That release-channel fact does eventually decide something, and exactly one
thing: whether a dshline release may become the DEFAULT install. The two
concerns are easy to conflate and must not be, because they have opposite
answers to the same event.

The documented installation is two unqualified names, so both sides resolve
through npm's default tag:

```sh
npm install -g @deepseek-ai/dsh @dshline/dshline
```

`@deepseek-ai/dsh` pins the whole `dsh-*` line to its own generation, so
whichever version that tag serves IS the Harness generation an ordinary install
ends up running. The invariant is therefore about channels, not about code:

> `@dshline/dshline@latest` must never advance to a build whose adopted Harness
> generation differs from what `@deepseek-ai/dsh@latest` serves.

`main` may adopt a Harness release generation before DeepSeek promotes that
generation to npm's default tag, and routinely will — tracking aggressively is
the point. That gap does **not** create an obligation to keep working against
the older default: nothing is widened, no peer range grows a second arm, and no
runtime feature test appears. Publication waits instead. Changesets accumulate
normally, the generated `Version Packages` pull request may sit release-not-
ready for as long as it takes, and ordinary development against the adopted
generation is unaffected throughout.

`tools/check-release-harness.mjs` is that gate, and it compares
`HARNESS_TARGET.version` with `@deepseek-ai/dsh@latest` by exact string
equality. Exactness matters in both directions: dshline supports one
generation, so a default channel that has moved PAST the adopted target fails
too — "newer" is not "supported", and the response there is to migrate
`HARNESS_TARGET` onto whichever generation Harness actually promoted, never to
assume forward compatibility. A registry that cannot be reached fails closed
as well, reported as an unanswered question rather than as a mismatch.

It runs at the three boundaries where the answer could still change something:
on the generated `Version Packages` pull request, so default-install coherence
is visible before a human merges it; in `.github/workflows/version.yml` before the
immutable `v*` tag is created, which is the primary irreversible boundary —
failing there leaves no tag, nothing published, and nothing to clean up; and in
`.github/workflows/publish.yml` before the first package is published, because
the tag can move green to red in between. It is identified by branch and
repository rather than by pull-request title, and holds no write permission and
no secret: it reads one repository file and asks npm one question.

This is a release gate, not a compatibility lane, and none of it changes the
sentence above — a pull request that is not the generated release PR never
resolves a dist-tag, so a pointer DeepSeek moves can still never make unrelated
work unmergeable. Once the two defaults agree, an ordinary unqualified install
resolves a coherent pair again, which is the only thing the gate was ever
protecting.

Each Harness lane additionally runs `tools/capability-report.mjs`, which turns a
seam's real Harness contract — a real `SessionQueryEngine`, a real
`SubagentRuntime`, a real abstract `JobRegistry` subclass, a real
`UserQuestionService`, a real abstract `WorkflowEngine` subclass over a real
`Session`, never a dshline-shaped fake — into a named pass/fail
per capability. Coverage today is initial, not exhaustive: `sessionQuery`,
`jobs`, `subagents`, `sessionProjections`, `workflows`, `userQuestions`,
`tokenMeter` (the real `TokenMeter` over a real `SessionStore`),
`compaction` (a real `CompactionEngine` subclass), and `skills` (the real
scope-layered `SkillRegistry`, plus the real `dsh-tool-skill` pre-step
boundary that turns a typed `/name` line into an injection), chosen because
each already has (or could cheaply gain) a test built against the real class
rather than a hand-typed fake. An upstream change to one of these reads as
`sessionQuery contract changed` rather than only a generic
`pnpm typecheck failed`; a seam not yet in the table still has
`pnpm typecheck`/`pnpm test` as its backstop. `tools/capability-probes.mjs` is
a pointer table, not a second copy of the contract: it names which existing or
purpose-built test already exercises each seam, so growing this coverage means
adding a line to that table (or a small new probe under
`packages/dshline/tests/capability/`), never teaching this module the seam's
shape itself.

`userQuestions` is this radar's first proof against a real break: Harness's
`ctx.userQuestions` registration shape moved, and `packages/dshline/src/questions.ts`
briefly bridged the two shapes with one small runtime check. That bridge was
debt rather than a pattern — it predated the one-adopted-generation rule — and
the adoption that followed deleted it: the module now registers directly on the
scoped `user-questions/request` waterfall. No new bridge like it should be
written. A migration removes the old call, it does not keep both.

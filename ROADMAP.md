# Roadmap

English | [中文](ROADMAP.zh.md)

This is product direction, not a dated feature checklist. dshline is a
**terminal-native frontend for DeepSeek Harness that understands Harness
capabilities instead of reimplementing them.** Its architectural rule is:

> **Harness owns capabilities; dshline owns terminal presentation.**

The proof is simple: install a new Harness provider or plugin; it publishes an
existing standard capability surface; dshline already knows how to present that
surface. A real Codex provider has now passed that acceptance through
`ctx.subagents` and `ctx.jobs` into generic Work, without Codex-specific
dshline integration. Provider CONFIGURATION follows the same rule:
`/connect` presents whatever `ctx.llm`'s configurable-provider directory,
`ctx.settings`, `ctx.credentials`, and `ctx.authorization` publish, with no
provider registry and no login protocol of its own. [Provider acceptance](docs/provider-acceptance.md)
records the evidence, configuration boundary, and the next target. Native
terminal scrollback is the other differentiator. This does not claim that other
TUIs cannot be extensible; it describes the architecture this frontend is
choosing.

## Product principles

- **Native terminal scrollback is an invariant.** Finished transcript rows are
  committed to the user's real terminal and are never virtualized, rewritten,
  or moved to an alternate screen. Only the bounded live region is redrawn, so
  normal terminal selection, copying, and scrollback remain available.
- **The renderer stays Harness-independent and dependency-free.** It knows
  terminal text, widths, keys, boxes, and the append-plus-live-region screen;
  Harness wiring belongs above it.
- **Use standard Harness authority before a product integration.** Prefer
  `ctx.subagents`, `ctx.jobs`, `ctx.llm`, `ctx.commands`, `ctx.tools`,
  `ctx.sessionQuery`, `ctx.attachments`, and `ctx.sessionProjections` over a
  provider connection, parsed output, or duplicated database.
- **Capabilities remain optional.** A profile without a service still starts;
  its related view is unavailable rather than becoming a boot failure.
- **Observation and control are separate contracts.** A callable mutation is
  not automatically a safe human action. Human UI needs explicit lifecycle,
  authorization, scheduling, and model-notification semantics from its owner.
- **No silent degradation.** Show the structured fact Harness exposes; when a
  surface cannot answer a question, say less rather than guess from text.
- **Future abstractions still produce bounded rows.** Declarative view code is
  welcome only when it ultimately serves the existing `Screen` / `TuiSlots`
  terminal model, not a full-screen replacement.

## Capability direction

Areas may progress independently, but the intended order is below.

### 1. Harness Work — merged

The first generic capability adapter presents background jobs from `ctx.jobs`
and delegated activity from `ctx.subagents` through bounded Work UI.

- observe jobs without consuming their output cursor
- observe subagents and preserve Harness's provider-neutral lifecycle facts
- treat real-provider support as an upstream-contract acceptance test, not a
  provider-specific dshline integration
- record the completed Codex acceptance separately from the unvalidated Claude
  Code target; neither requires provider-specific dshline production code

Jobs and subagents remain separate until Harness publishes an authoritative
correlation. The Codex acceptance is complete; Claude Code through
`@deepseek-ai/dsh-subagent-claude-code`, `ctx.subagents`, and `ctx.jobs` is the
next acceptance target, not a manually validated integration. See [Provider
acceptance](docs/provider-acceptance.md). Work also establishes the broader
control rule: it does not expose `ctx.jobs.kill()` because that method has
model-facing reported-delivery semantics; a continuable subagent can expose a
user-authorized interrupt only where `ctx.subagents` explicitly models it.

### 2. Session projections and agent state

`ctx.sessionProjections` is the second proven architecture pattern. Domain plugins
register projection units; Harness owns their log drive, caching, snapshot, and
change feed; dshline consumes the snapshot and changes as presentation input.
Its internal shared observer feeds native adapters instead of making every
feature replay the same session log.

1. **Todos — implemented.** `/todos` and a compact status reading consume the
   `todos` projection provided by `@deepseek-ai/dsh-tool-todo` through one
   internal session-scoped observer. The whole-list `todo/write` state,
   lifecycle, and persistence remain Harness-owned; dshline parses neither
   calls, cards, nor tool output and owns no Todo state machine.
2. **Goal — implemented.** The status line's durable goal reading — objective,
   phase, round count, round cap — comes from the Harness `goal` projection
   through that same observer, on the same snapshot cut Todo uses, so Goal adds
   no second direct dshline snapshot. `ctx.goals` is consulted for one
   process-local fact that no replay can reconstruct, continuation activation,
   and only for a projected goal that is durably active. It is read live and
   never cached, because `disarm()` changes it with no durable event; an
   activation that cannot be read reports `goal idle` rather than a running
   goal. That call reads a whole view because the adopted generation publishes
   no activation-only accessor — `GoalService.get()` consults its own `goal`
   projection state internally — and `.activation` is the only field dshline
   takes from it.
3. **Plan remains Harness-governed.** Its presentation continues to follow the
   authority documented by the plan capability rather than a TUI-owned mirror.

No generic public `ProjectionAdapter` interface is being promised.

### 3. Sessions — merged

The third generic capability adapter presents the Harness session corpus through
`ctx.sessionQuery` alone. `/sessions` and `--resume` open the same bounded
browser: it lists live-preferred records with batched folded titles, filters them
as you type, hands the same words to the engine's full-text surface on `tab`, and
reopens one session in place.

- read the corpus with `listSessions()` and `readTitleSnapshots()`, and one
  session's log with `listEvents()` only when a surface presents it; never scan
  a sessions directory or keep a second index
- treat `searchSessions()` as optional: it is the engine's only abstract
  surface, and a backend reporting `SESSION_QUERY_SEARCH_DISABLED` degrades to
  filtering instead of failing
- reopen through the owned `AgentHandle` disposer and `ctx.agents.resume`, and
  refuse in the states Harness does not define a lifecycle for
- keep the transcript in native scrollback: reopening appends, never rewrites

It also introduced the window/attachment split — a window owns the terminal, key
routing, the model route, and reader preferences, while an attachment owns one
Agent and everything projected from its log. That split is the reusable part; any
future capability that replaces domain state for a whole session needs it.

Still ahead for Sessions:

- inspecting a within-session search hit's context through `readEvent()`
- renaming a closed persisted session, once a narrower Harness mutation surface
  exists — the generic title service wields live session objects only
- a "recent activity" filter, if Harness ever publishes a predicate for it —
  the known-workspaces half is now `/worktrees`, which groups the corpus this
  browser already reads rather than needing a predicate for it
- archiving a session, once upstream publishes a symmetric lifecycle and the
  session corpus can be asked about archive state

Sessions 2.0 shipped the original list through the same seam, with no second
index and no frontend-owned session state:

- corpus filters through `filterSessions()`: workspace (`cwd` exact match) and
  age (`created-at` inclusive windows) become Harness clauses; origin
  (`own`/`delegated`) is applied presentation-only, classified from the
  authoritative observed headers Harness returns — recovered through the batch
  title observation when a search backend's own hit projection omits it —
  because Harness publishes no origin predicate
- lineage navigation through `traceSession()`, projected as a bounded tree
  (ancestors outward, descendants depth-first) with exact pruning counts and
  an honest row when a parent leaves the visible corpus
- within-session search through `searchEvents()` for the selected session
- real cursor-backed paging for both full-text scopes: opaque Harness cursors
  bound to the exact request, an explicit `Load more…` row, and a refresh path
  when the corpus moved under a cursor
- renaming the session this window drives through `ctx.sessionTitle.rename` —
  an explicit `user`-source title that pins the session's title; renaming a
  closed persisted session stays deferred because the generic service only
  wields live session objects

Sessions 3.0 made that same surface a picker first and an inspector second,
which was a deletion rather than a feature:

- an ordinary row is a title and a relative age. Workspace, origin,
  availability, lineage, event count, and session id all moved behind `→`,
  where one session is disclosed with its own facts and its own actions
- the bounded `listEvents()` read now happens when that surface is opened and
  never because the cursor moved, so ordinary browsing costs one listing and
  one batched title observation
- filters left the per-session menu for `ctrl-f`: they narrow the CORPUS, and
  offering them under one row's title said otherwise. A ctrl gesture rather
  than a bare `f` because every printable character is search input here
- archive stayed out, for the upstream reasons under Known limits

### 4. Connect — merged

The fourth generic capability adapter presents provider CONFIGURATION, which is
four Harness surfaces rather than one. `/connect` joins the
configurable-provider directory and registered routes from `ctx.llm`, the
user-settings document through `ctx.settings`, credential presence through
`ctx.credentials`, and the login flows registered on `ctx.authorization`, and
presents them as one bounded browser.

- read the directory with `listConfigurableProviders()`, so a bare-mounted
  adapter's whole installed catalog is offered before any route exists; never
  ship a provider list
- find a profile's credential field by its schemastery `credential-ref` role
  from `describe()`, never by a field name this frontend knows
- write a secret only through `ctx.credentials`, and settings only as a path op
  carrying the revision the row was read at
- render `ctx.authorization`'s neutral notice and prompt vocabulary generically,
  implementing no provider's login; a notice goes to native scrollback because a
  sign-in URL and a device code are made to be copied
- keep the provider and sign-in sections separate, because Harness publishes no
  correlation between a credential record and a provider route — the same
  refusal Work makes for jobs and subagents

Because both surfaces write the same namespace and the same reference, a change
made in the terminal is visible on the official web Models page and the other
way round, and `/model` sees a newly activated route's models with no further
step. `/model` stays what it was: choosing among models that already exist.

Connect 2.0 closed most of that list. `/connect` can now declare a route the
owning adapter ships nothing about — a gateway, a self-hosted server, a
localhost OpenAI-compatible endpoint — through the one namespace whose
settings profile can describe a whole provider route today,
`llm-pi-ai`. That knowledge lives in one small presentation module
(`connect/pi-ai.ts`) which reads the namespace's own serialized schema for its
protocol choices and writes through the same generic `ctx.settings` path ops
every other Connect action uses; it imports no pi-ai runtime code and makes no
network request. Endpoint interrogation goes through
`ctx.llm.discoverModels()` — advisory candidates a reader chooses from, never
written automatically — and Connect converges on `settings/updated`,
`settings/document-updated`, `credentials/reference-updated`, and
`credentials/record-updated` in addition to `llm/adapters-updated`, so an edit
made from the official web Models page or a hand-edited `settings.yaml` no
longer needs `ctrl-r`.

Still ahead for Connect:

- exposing pi-ai's advanced `compat`, retry policy, and per-model reasoning
  fields, which stay in `settings.yaml` for now; Connect curates the fields
  that decide what route/model a reader can reach, not the whole profile.
  `headers` crossed that line and is curated now: a gateway authenticating
  with anything but the `credential-ref` field was otherwise unreachable from
  the terminal at all, which is the same test that admitted endpoint,
  protocol, and catalog
- a second namespace besides `llm-pi-ai` gaining the same declare-a-whole-route
  shape, which would need its own small presentation module rather than a
  generic one — see [Architecture → Connect 2.0](docs/architecture.md#connect-20-one-route-can-be-a-declaration-not-only-a-lookup)
  for why that boundary is drawn where it is

### 5. Agent presets — merged

The fifth generic capability adapter presents agent COMPOSITION: which tools,
prompt sections, and delegation backends the running agent actually has,
through `ctx.agentPresets`. `/plugins` browses the roster and the composition
of whichever preset an agent is joined to, and carries out every change
through the seam that owns it.

- read the roster and one preset's composition through `list()`/`read()`;
  never a private plugin registry, and never inferred from tool names or
  rendered output
- toggle a row only on a locally authored preset — a built-in one is
  copied first (`copy()`), never edited in place — and re-validate the
  result through Harness's own health check, not a private re-parse of it
- join an agent's composition only through `mount()`, and switch it only
  through `select()` — Harness's own whole operation, which re-checks the
  authoritative `turnBoundary` projection inside its own serialized switch,
  refuses a started session, recomposes, and records the choice. dshline
  performs none of those steps itself; a started session's preset is fixed,
  and the terminal offers the default for the *next* session instead
- resume a session under whatever preset Harness's `agentPreset` projection
  reports, never today's roster default — and a session from before this adapter existed,
  which recorded nothing, resumes under the shipped `standard` preset
  rather than an arbitrary current one; a deployment that ships no usable
  `standard` falls back to its own default and says so in the transcript,
  rather than refusing to open its own history
- adopting this meant moving dshline's own previously process-wide tool set
  behind the same preset boundary Harness's Web frontend already uses, the
  same "agent plane moves behind agent presets" step and for the identical
  reason

`/profiles` presents the profile layer above it: the roster under
`$DSH_HOME/profiles` read through Harness's own `dshHomePath` service, the
booted profile read from the Loader's base URL, and each profile's
`dsh.profile.bundles` layers with the installed version wherever pnpm's state
already records one. Its mutations are forwarded to `dsh plugin --profile
<name> …` — Harness's own package lifecycle, pnpm invocation and bundle
reconciliation included — so this adapter adds no installer, resolver, or
lockfile behavior, and `/plugins` still builds no package manager of its own.

Both browsers make the layering explicit rather than implying it:

- a profile PROVIDES capabilities to the Host; a preset EXPOSES them to an
  agent, so an enabled preset row is not evidence that its backing capability
  exists
- where the link can be proven from Harness state — a row naming a provider a
  mounted registry does not supply — `/plugins` marks it; where it cannot, it
  claims nothing
- a bundle change alters what the NEXT Host composes, so `/profiles` reports
  `restart required` on the running profile and names the boot command for any
  other, and never offers to switch a composed Host's bundle layers

Still ahead for Presets:

- richer preset authoring than a narrow per-row toggle, if Harness ever
  exposes one — the current toggle is the smallest safe file edit because no
  narrower Harness seam exists yet
- surfacing a preset's own health/broken state with more than a one-line
  reason, once Harness's diagnostics grow one

### 6. Attachments

Raster image attachment is now Harness-native:

- `/image` stages PNG, JPEG, WebP, and GIF paths without reading them, then the
  active filesystem and `ctx.attachments` own bounded reads, validation, and
  durable admission when the prompt is sent
- transcripts and resumed sessions render metadata from durable `ImageBlock`
  references; dshline stores neither bytes, base64, host paths, nor attachment ids
- registered commands receive images only when their descriptor opts in, and
  explicit text-only model metadata stops admission before I/O

Still ahead: arbitrary file attachments. Harness `0.1.2-rc.1` exposes durable
image attachments but no equivalent file-attachment contract. `@path` therefore
remains the honest textual file-reference gesture rather than implying bytes
were attached.

### 7. Permissions and approvals

Expose the authority Harness defines; do not invent a frontend policy. A useful
human control needs the owning capability's lifecycle, authorization,
scheduling, and model-awareness contract — the same rule demonstrated by Work.

### 8. More asynchronous capabilities

After the relevant upstream contracts are ready, present more Harness-owned
asynchronous work:

- persistent terminals
- workflows — done: `/work` presents Harness workflow runs, their phases, and
  their published members, owned through this session's own durable
  `tool-workflow/*` records
- later, Agent Teams when their upstream contract is mature enough

### 9. TUI extensibility

Only after several internal capability adapters have proven the vocabulary for
lifecycle, authority, and layout should dshline consider a public contribution
API. A possible small `dshline-api` is a future option, not a current
commitment. `TuiSlots` and overlays remain experimental pre-1.0, and persistent
third-party rows need a global live-region layout budget first.

### 10. Worktrees — merged

The fifth generic capability adapter presents the WORKING DIRECTORY, which is
the question `/sessions` never asked. It reads one authority — the same one
`/sessions` reads — and groups it:

```text
ctx.sessionQuery.listSessions()   the logical corpus: a fresh
                                  sessionPersistence.list() merged with this
                                  process's live sessions, newest first
      ↓ group by exact SessionHeader.cwd
worktree rows                     transient; nothing is persisted
      ↓ select one
SessionCatalog { kind: 'cwd', cwd }
```

A row is DEFINED as "the sessions whose header records exactly this cwd", which
is why it needs no id, no title, and no durable record: the key is the
definition.

- directory-first: selecting one opens that directory's sessions rather than
  resuming whichever is newest, because several conversations can be rooted in
  the same place and a directory is not a conversation
- one query path, not two: the second view is the very `SessionCatalog`
  `/sessions` uses, scoped to the selected cwd, so corpus order, filtering,
  title folding, and cancellation stay where they already are — and the first
  view's count and the second view's rows are one relationship read twice
- transitions are the ones that already exist — `ctx.agents.resume({ id })` for
  a session, `ctx.agents.create` with the selected `cwd` for a fresh one — so
  one dshline window still drives one root Session
- a fresh session needs no follow-up write at all: Harness stamps `cwd` into
  its immutable header, and that header IS the grouping rule, so the next
  corpus read places it without dshline recording anything
- no new dependency and no new composition row. The corpus was chosen over the
  durable Workspace registry deliberately: at the adopted generation
  `dsh-storage-domain` documents that `domain/changed` is in-process and that
  "a second host process observes no changes", and `dsh-storage-json`
  documents "no cross-process write locking" with last-completion-wins. A
  feature whose whole point is several simultaneous terminals cannot sit on
  shared mutable state with those properties, while session persistence — one
  artifact per session, one live writer per session, a fresh listing per corpus
  read — already models distinct sessions in distinct directories well

Still ahead for Worktrees, and both wait on upstream:

- **Git worktree facts.** The adopted generation publishes no Git or worktree
  capability at all, so a row carries a path and a session count — not a
  branch, a HEAD, a dirty flag, or a lock state. The presentation model is
  shaped to be reconciled with an optional Harness capability that publishes
  structured worktree metadata; nothing here will read `.git` or shell out to
  fill the gap.
- **Git worktree enumeration and provisioning.** Listing every worktree of a
  repository, and creating or removing one, stay out for the same reason: that
  is Git lifecycle, and no Harness seam owns it. What is missing upstream is a
  runtime capability that publishes worktree facts and accepts add/remove with
  its own authorization and lifecycle — at which point `/worktrees` gains rows
  and actions, and dshline still owns none of the Git.

## Robustness is capability work

Feature count is not worth breaking the terminal model. Ongoing priorities are:

- Windows real-terminal verification
- broader macOS terminal coverage beyond Ghostty
- Linux PTY coverage
- resize torture tests and narrow-terminal behavior
- resume lifecycle correctness
- teardown and terminal restoration
- Unicode, CJK, and wide-character correctness
- compatibility with rapidly moving Harness releases

## Upstream compatibility strategy

Track aggressively, support narrowly: one current Harness architecture at a
time. This is a deliberate rejection of a compatibility matrix. Maximum Harness
version coverage is not the goal; current capabilities, current performance,
native Harness APIs, a small maintenance surface, and fast forward migrations
are.

The adopted architecture is one commit and one version in `HARNESS_TARGET`, and
three signals keep it honest:

1. the **adopted target** — an exact upstream revision, checked out from source
   and blocking, because it is what dshline claims to support;
2. **authoritative release discovery** — Harness-Sync watches upstream's
   official `dsh-v*` GitHub Releases, the only thing `HARNESS_TARGET` can
   record, and opens a pull request proposing the next generation. It reads no
   source and judges no compatibility: the ordinary checks on that pull request
   do. An arbitrary `master` commit is not an adoption unit, so nothing follows
   that branch any more; and
3. the **published npm distribution** — the path a real user installs through,
   which lags GitHub source and is expected to.

When upstream breaks us, the response is to migrate forward and delete the old
assumption in one commit — never a compatibility adapter, a runtime feature
test, or a peer range that promises two generations. What dshline explicitly
does not promise is that any older prerelease generation keeps working.

## Current limitations

- **A theme reaches new rows only.** `/theme` chooses among five shipped palettes and repaints the live region; rows already committed to native scrollback keep the colours they were printed with, because committed output is never rewritten. Applying one is confirmed by a single line drawn in the new palette. User-authored palettes are not supported yet: the role vocabulary a theme is written against is still internal, and publishing it before real palettes have exercised it would freeze a contract nothing has tested.
- **`ctrl-o` affects new output only.** Committed native scrollback is never
  reformatted; a truncated tool card can instead open a bounded inspector, at any
  detail level and with a far larger row budget than the card itself had, and
  `ctrl-o` inside it steps back through the last dozen. Older than that, the
  elision marker beside the committed rows is the only remaining answer.
- **`/connect` can declare custom routes only through Harness's pi-ai
  configuration domain**, matching the scope Harness's own Models UI exposes.
  A gateway, self-hosted server, or localhost OpenAI-compatible endpoint can
  be added from `+ Add custom provider` because `llm-pi-ai`'s settings profile
  can describe a whole route. Other adapter families remain limited to the
  routes their configurable-provider directory already publishes unless they
  gain an equivalent declaration contract.
- **`/connect` curates a route's endpoint, protocol, request headers, and
  model catalog, not its whole settings profile.** Advanced pi-ai fields —
  `compat`, retry policy, per-model reasoning — stay in `settings.yaml`;
  editing what Connect shows never destroys a field it does not render. A
  model fetch carries a route's headers only once the route exists for the
  owning adapter to resolve them from: the discovery request itself names a
  provider, an endpoint, a protocol, and a one-shot key, and nothing else.
- **Forgetting a sign-in is local.** Harness has no place for a provider to
  declare a server-side revoke, so deleting the credential record does not tell
  the issuer.
- **Pending input can be seen but not managed.** The status line reports what is
  parked on Harness's two boundary lists, and `/enter` chooses which list your
  input goes to, but there is no `/queue` browser that edits, removes, or
  promotes a queued message. The reason is rule 15 rather than effort: the
  adopted generation defines human-facing queue edit/remove/steer semantics in
  exactly one place, `SessionCommandController.updateQueue`, reachable only
  through the `sessionController` service that the `web-app` bundle alone mounts
  and that injects the equally web-only workspace registry. Driving
  `Inbox.replace()`/`remove()` directly would make this frontend the author of
  the placement gate, the text-only edit restriction, the steer gate, and the
  subagent-ownership refusal — a control policy Harness owns and may change. What
  is missing is a transport-independent seam carrying that policy; when one
  appears, it gets a capability probe and this becomes a small overlay.
- **`ctrl-enter` depends on the terminal.** It sends a message the opposite way
  for one submission, and a terminal without an enhanced keyboard mode sends the
  same bytes for it as for `enter`, with nothing to query. There it does what
  `enter` does — your `/enter` preference — so nothing is lost or duplicated, and
  the composer never advertises the key.
- **`ctrl-c` discards pending input.** Interrupting clears both of Harness's
  boundary lists along with the turn, because queued work that survived would
  start the agent again by itself once the aborted turn settled. The count is
  reported and `↑` brings a discarded prompt back.
- **`@path` inserts text, not an attachment.** Completion names a path for the
  model to read; `/image` is the explicit gesture that durably attaches supported
  raster content. Harness has no arbitrary-file attachment contract yet.
- **Tool calls are not reviewed by default.** The Harness deployment decides
  sandbox and approval policy; see [Usage → Permissions and the sandbox](docs/usage.md#permissions-and-the-sandbox).
- **A goal can start without a `/goal` command.** `/goal <objective>` starts a
  Harness goal-driver run, and the harness also publishes `create_goal` as a
  model-callable tool that may infer the intent from an ordinary request. Either
  way the status line names the objective for as long as one is live; inspect or
  pause a goal before leaving one running.
- **One session at a time per window.** `/sessions` and `/worktrees` both
  reopen a session in place rather than beside the current one; there are no
  tabs, split panes, or side-by-side agents. Working in two worktrees at once
  is two terminals, each rooted in its own directory — which is what a shell
  already gives, and what a multiplexer inside the frontend would take over
  badly.
- **`/worktrees` shows directories represented in Harness sessions, not every
  Git worktree.** Its rows are a transient grouping of the session corpus by
  each session's stored `cwd`, so a directory appears once Harness has a
  session in it. A Git worktree created and never worked in therefore does not
  appear; starting dshline there puts it on that window's list immediately, and
  once its conversation has persisted, other windows find it through the
  ordinary session listing. dshline runs no `git worktree list`, reads nothing
  under `.git`, and keeps no directory list of its own, because a second
  account of which working directories exist is a second authority to disagree
  with.
- **A worktree row carries no Git state.** No branch, HEAD, dirty flag, lock,
  or prunable marker, because the adopted generation publishes no Git or
  worktree capability to read them from. Enumerating, creating, and removing
  worktrees are out for the same reason.
- **The grouping key is the stored path, not a resolved one.** dshline does not
  `realpath`, join, or normalize a session's `cwd`, so two spellings of one
  directory stay two rows if sessions really were created with two different
  strings. Inventing path identity in the frontend would be worse than showing
  what Harness recorded.
- **No cross-process liveness or takeover, in `/worktrees` or `/sessions`.**
  The persisted corpus includes sessions other dshline processes created, and
  navigating them is the point — but `SessionRecord.live` means live in the
  asking process, `ctx.agents` is process-local, and the adopted generation
  publishes no cross-process ownership contract, so nothing here reports a
  session as idle elsewhere or safe to take over. **dshline cannot tell whether
  a persisted session is currently open in another dshline process.** Harness's
  own refusal is process-local: the persistence coordinator's `prepare()`
  throws for a session that is live, but the fact it consults is
  `ctx.sessions`, this process's store, and its ownership bookkeeping is
  in-memory per backend instance. The shipped JSONL backend states the rest as
  a requirement on callers rather than an enforcement — "another instance or
  process must not write the same session until that owner reaches quiescent
  disposal" — and there is no lease, pid owner, heartbeat, or lock in the
  session or storage packages at this revision. So do not drive one session
  from two dshline processes at once; nothing will stop you.
- **Reopening waits for quiet.** A window refuses to reopen a session while a
  turn is running or while jobs or subagents are attached to the one being left,
  because no generic seam defines what happens to work whose owner is retired.
- **Content search depends on the deployment.** Full-text session search is the
  session-query engine's abstract surface; a backend that implements none leaves
  `tab` reporting that, and filtering still works.
- **Sessions is not archive-aware.** Harness owns session archival in the
  Workspace domain — `ctx.workspaceRegistry.archiveSession()` durably hides a
  session from grouping surfaces — but upstream records that archiving is
  one-way and no unarchive action exists yet. Nor is archive state a fact the
  session corpus publishes: `SessionRecord` carries no archive field,
  `SessionResultFilter` has no archive predicate, and the only stream of archive
  changes is the Workspace controller's Remote `follow()`. So `/sessions`
  neither offers Archive — a one-way hide is not something a terminal should
  hand a reader — nor hides sessions someone archived elsewhere, which would
  make them unreachable from the surface that can still resume them.
- **A started session cannot switch presets live.** Harness refuses it inside
  `agentPresets.select()`; `/plugins` reads the same `turnBoundary` projection
  to avoid offering the impossible, and offers the default for the next
  session instead.
- **`/plugins` edits a preset's composition file directly.** Toggling a row is
  a narrow, lock-coordinated edit to `agent.cordis.yml` because Harness does
  not yet expose a finer-grained mutation contract; conditional (`!!js`) rows
  are never evaluated or toggled, only reported.
- **A pre-preset session's composition can only be approximated.** Sessions
  produced before dshline adopted agent presets recorded no preset, so they
  resume under the shipped `standard` — the preset built to mean exactly the
  flat tool set they actually ran under. On a deployment shipping no usable
  `standard`, the resume falls back to that deployment's default and the
  transcript says the tools may differ from the ones the history was produced
  with. Sessions created since carry their own preset and need no guess.
- **`/profiles` cannot switch the running Host.** A profile's bundle layers are
  composed once, at boot, and Harness exposes no seam that re-links them under
  a live process. Another profile is presented and the command that boots it is
  named; installing, updating, or removing a bundle reports what it changed for
  the next Host rather than pretending to reach this one.
- **Bundle operations need a resolvable `dsh` launcher.** They are forwarded to
  `dsh plugin --profile <name> …` rather than reimplemented, and the launcher is
  found the same four ways `bin/dshline.mjs` finds it (`DSH_BIN`, a
  `DSH_HARNESS` checkout, `PATH`, the installed `@deepseek-ai/dsh`). Where none
  of them resolves one, the exact command is named instead of the operation
  failing silently.
- **Capability health is availability, not installation.** `/plugins` marks an
  enabled row whose named provider a mounted Host registry does not supply, and
  says the provider is unavailable in this Host — which is what the registry
  proves. Whether its package is installed is a different fact this frontend
  does not read.
  A capability module the link table does not cover, a `!!js` provider that is
  never evaluated, and a profile mounting no such registry all produce no
  verdict — the absence of a warning is not a claim that a row will work.
- **Linux and macOS are verified; Windows is not.** The macOS evidence is
  Ghostty, so another macOS terminal is likely fine but unproven, and Windows
  terminal behavior has no real-terminal evidence at all.

## Explicit non-goals

- another agent runtime
- another job runtime
- provider-specific subagent engines
- parsing rendered tool output for structured state
- replacing Harness persistence or session search
- replacing native terminal scrollback
- cloning Claude Code or Codex feature-by-feature
- a stable public TUI SDK before internal adapters prove one
- an npm-style plugin marketplace or package manager (`dsh plugin --profile
  <name> add/remove` already covers that at the profile level)
- owning Git: worktree creation or removal, branch or merge operations, status
  parsing, or a dirty-state policy — Git owns Git, and a Harness capability is
  what would publish it
- cross-process session takeover, agent discovery, or process locks — pid
  files, lock files, heartbeats, and sockets are all a frontend inventing an
  ownership contract Harness has not defined

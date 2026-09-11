# dshline

## 0.22.0

### Minor Changes

- eee8498: Let Sessions search results open bounded surrounding context through Harness's
  native session-query read seam.
  
  `Find in this session` still discovers hits with `searchEvents()`, but `↵` on an
  ordinary hit now opens a bounded inspector: the exact target event plus a fixed
  number of raw events on each side, read once through `readEvent()`. The target
  is marked, its neighbors keep their order, and each event's text is Harness's
  own semantic extraction, so structural and unknown events show only their type
  and sequence. Rendering or moving through results reads no log, and closing the
  inspector restores the search's query, results, selection, and viewport
  unchanged.
- d99ec59: Add `/turns`: a bounded, Harness-native index of this session's turns, read from
  the `turnOutline` session projection. Move the selection with `↑`/`↓`, open a
  read-only inspection of a turn's prompt and response previews with `enter`, walk
  turns with `←`/`→`, filter by turn number or preview text with `/`, and leave
  with `esc`. `/turns <text>` opens pre-filtered. The outline is a view over
  Harness's authoritative fold — no second transcript model, no rewrite of native
  scrollback — and a composition that mounts no turn outline says so instead of
  folding the log itself.

### Patch Changes

- 0f9c23b: Make very large pasted prompts fast and navigable. Laying the composer's draft
  out is now a single forward pass over one snapshot of the buffer instead of a
  per-line loop that re-derived the whole buffer for every line, which made a
  5,000-line draft take seconds per `↑` and seconds more for the redraw. The
  composer view also reuses one layout between its `render` and `cursor` calls, so
  a frame no longer wraps the draft twice. A draft still grows from one row to the
  same hard cap and then scrolls, and the frame title now names the direction of
  what is hidden (`^ 27` / `v 4`) instead of a single `+N rows` count. The markers
  are ASCII because `↑`/`↓` are East Asian Ambiguous width: a terminal in an
  ambiguous-width mode advances two cells for them where Dshline measures one, so
  the top border wrapped and each redraw left the previous composer frame behind.
- 44d06a6: Roll back a failed overlay registration when its `mounted()` hook or the
  initial redraw it triggers throws, so a failed mount no longer leaves the
  overlay owning the live region and input with no disposer returned to the
  caller.
  
  `TuiSlots.pushOverlay()` now removes the exact overlay by identity, disposes it
  once, and invalidates so the remaining overlay stack or the composed slots are
  authoritative again before the failure propagates. The rollback covers only the
  registration `pushOverlay` makes: an overlay the hook pushes itself is a
  separate registration with its own lifecycle. If the rollback disposal or
  invalidation also throws, the failures are carried together in an
  `AggregateError` with the primary failure first; the failed overlay is
  unregistered either way, and context teardown cannot dispose it a second time.
- @dshline/renderer@0.22.0

## 0.21.0

### Minor Changes

- e237c1d: Adopt DeepSeek Harness `0.1.3-alpha.2`, whose session format v2 splits durable
  Assistant history from live Assistant presentation.
  
  The session log no longer carries per-delta `assistant/chunk` events. A model
  attempt now settles once: `assistant/message` when it committed a reply (with
  `interrupted: true` for a prefix a `ctrl-c` cut short), and the log-only
  `assistant/attempt` when it produced no reply at all — each embedding its own
  compacted stream. Frame-by-frame output arrives instead on the agent-scoped
  `agent/assistant-stream` notification.
  
  dshline consumes both natively and keeps them apart. The `session/event`
  projection is now purely the committed transcript, and a session-scoped listener
  on the attached Agent's stream frames owns the live region, live reasoning, the
  activity word, and the model's reasoning/output timing — measured from the
  timestamp each frame carries.
  
  What changes for a reader: a failed or retried model attempt can no longer leave
  a partial answer in the scroll history as though the model had said it, and a
  new attempt starts from nothing instead of settling against text its predecessor
  streamed. The timing panel separates reasoning and output per model attempt, so
  a retry's dead time is no longer charged to the model. An interrupted reply
  still lands in the transcript, now from its own durable message rather than from
  a turn-boundary salvage.
  
  Registered slash commands take the harness's generic attachment admission:
  `input.attachments` replaces `input.images`, and image drafts are submitted as
  discriminated `{ type: 'image', … }` attachments. Drafts are still kept when a
  command cannot accept them or its execution fails, and dshline still authors
  only image attachments — command file receipts are the harness's other variant
  and no dshline UI stages files.
- 0af4363: Adopt DeepSeek Harness `0.1.5-alpha.1`, natively.
  
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
- d9ae108: Adopt DeepSeek Harness `0.1.5-alpha.2`.
- a0fb861: Adopt DeepSeek Harness `0.1.5-rc.1`.

### Patch Changes

- 7d36318: Keep idle `ctrl-c` from closing dshline while Harness still publishes a Job or
  subagent owned by the current session.
  
  One-shot `subagent/end` reports `run.result` settlement, not completion of the
  consumer-owned `run.dispose()` teardown. The standard background tool path keeps
  that interval visible through its nonterminal Job, while foreground work keeps
  the parent Agent running until disposal returns. The terminal now reads the
  generic Work snapshot before treating idle `ctrl-c` as quit; explicit `ctrl-d`
  remains the unconditional exit boundary.
- a797a33: Keep a foreign raw write off the terminal the live region owns, so spawning a
  subagent stops printing the root chrome into scrollback a second time.
  
  `Screen` is correct only because it is the sole writer: it remembers the live
  region's height and where it left the cursor, and every redraw climbs that
  remembered geometry to erase the frame before drawing the next one. A write it
  did not issue scrolls the screen out from under that geometry, and from then on
  the erase starts below the frame's first rows instead of above them — so the
  blank separator and `╭─ dshline ─… ─╮` are never erased again, scroll up as
  ordinary output, and stay in native scrollback for good. One more copy lands
  with every commit that follows.
  
  A subagent backend in the generation named by `HARNESS_TARGET`
  (`@deepseek-ai/dsh-subagent-codex@0.1.5-alpha.1`, `startCodexRun`'s stderr
  forward) writes a delegated child process's stderr straight to descriptor 2 —
  `writeFileSync(process.stderr.fd, bytes)` — unconditionally, for the whole life
  of the run. On an interactive launch descriptor 2 is the terminal dshline draws
  on, which is why the duplicate appears the moment a subagent starts and has
  nothing to do with whether `/work` is open. Nothing in dshline's runtime names
  that backend or branches on a provider: what is contained is a write shape.
  
  **This is a temporary compatibility shim, not a dshline abstraction.** The real
  fix is upstream — a delegated child's diagnostics belong on a Host-owned
  diagnostic seam, not on a frontend's terminal. `src/stderr.ts` carries the
  removal condition in its own header, and the shim is registered in a new root
  file, `HARNESS_COMPAT`, so it cannot quietly become permanent.
  
  That register lists each temporary workaround with the generation it was last
  confirmed to still be needed against, and `node tools/harness-target.mjs` — the
  coherence check the Harness-Sync adoption proposal, the blocking `Harness
  target` lane and every release already run — fails while a record names any
  generation other than the adopted one. So advancing `HARNESS_TARGET` cannot go
  green until the adopter decides, per shim: confirm the upstream behavior is
  still there and bump the record deliberately, or delete the shim with its
  wiring, its tests and its record. A record whose module no longer exists fails
  too, so the register cannot outlive what it describes. The check is a string
  comparison between two files in this repository — it parses no upstream source,
  so nothing couples a build to a backend's internal layout.
  
  Patching `process.stderr.write` would not catch the forward — it never touches
  the stream — but it reads `process.stderr.fd` on every write, so that is what
  moves: while the window owns the terminal, the descriptor that property reports
  is a writable hole. Whether that is safe depends on two Node behaviours, and
  both are now pinned by real child processes rather than by stubs: a raw
  `writeFileSync` follows the substituted descriptor, and a socket-backed
  `process.stderr` — a pipe in the test, a terminal in production, both writing
  through a libuv handle opened once — does not, so the ordinary stream path keeps
  reaching the terminal. A FILE-backed `process.stderr` is `SyncWriteStream` and
  *does* re-resolve the property on every write, which is recorded as the stronger
  reason the shim refuses to hold a stderr that is not a terminal.
  
  That refusal is now a real device-identity test rather than an inference.
  `isTTY` on both streams does not establish that stdout and stderr are the same
  terminal — the previous version of this check claimed it did — so
  `rawStderrReach` stats both descriptors: two handles on one terminal report one
  non-zero `rdev`, and two terminals report two. It answers `reaches`,
  `cannot-reach`, or `unknown`, and holds on the first and the last. A Windows
  console reports an `rdev` of zero and lands in `unknown`, where protecting the
  frame is the conservative choice; a proven second terminal, a piped stderr and a
  `2>log` run are all left exactly as found.
  
  No capture, tee, or logging sink is added. Harness owns Host diagnostics and
  subagent failure reporting, and a second authority over the same bytes in the
  frontend would be worse than dropping them: a run's own failure reaches the
  transcript through the subagent lifecycle, never through descriptor 2, and the
  bytes being dropped were unreadable anyway because they were landing on top of
  the frame they corrupted.
- 85bd4db: Keep the timing panel's measured rows and the completion list's rows inside the
  terminal, so a narrow window cannot leave root chrome in scrollback.
  
  `TuiSlots.compose` budgets the live region in LOGICAL lines and hands each view
  the rows the views above it have not spent. That is only the same thing as the
  physical budget while every row fits the terminal's width: `Screen.wrap`
  re-wraps an overlong row into two AFTER the budgeting is finished, so one row
  wider than the terminal is one row of overflow no view's own accounting can see.
  Once the region is taller than the screen its first rows cannot be climbed back
  to and erased, and the next redraw leaves `╭─ dshline ─… ─╮` in native
  scrollback for good.
  
  Two views could emit such a row, for two different reasons:
  
  - **The completion list** laid its rows out against `chromeWidth(columns)`,
    which floors at the shared chrome minimum and therefore returns a width WIDER
    than the terminal below that floor. Its label budget also carried a floor of
    eight columns independent of the terminal, and its shortest row — the
    `… N more` marker — was not cut at all, so `… 14 more` drew thirteen columns
    at every width. Worse, only the label was ever bounded: every row carries a
    fixed four-column prefix (`  › `) that sat outside the budget entirely, so at
    one to four columns the row was five columns wide no matter what the label was
    cut to. The width is now clamped to the terminal, the prefix is one named
    constant shared by every budget that has to account for it, the WHOLE
    assembled row is cut rather than only its payload, and below a prefix plus one
    column of label the list stands down instead of spending a live row on a
    candidate it cannot name.
  - **The timing panel's measured rows** are budgeted from the DATA as well as
    from the width: the label width, field gap and bar cells are what is left
    after the longest duration's width is subtracted, and the label and gap have
    floors of one. A long-running turn on a narrow terminal therefore produced a
    row wider than the width it was laid out for.
  
    Cutting the row would have bounded it and broken a different rule this file
    already keeps: the duration sits at the right edge, so a plain truncation
    turns `2h 41m` into `2h 4` — not a narrower fact but a different, entirely
    plausible one, which is what the heading's own ladder exists to avoid. So the
    fields are not cut and the FORM is chosen instead, by a ladder from
    `label + bar + duration` through `label + duration`, an indented duration, a
    bare duration, and finally `…` where not even a whole duration fits. The
    widest form that fits is picked once for the panel rather than per row, so a
    narrow panel stays aligned instead of going ragged for a reason no reader
    could see.
  
  Neither is reachable at an ordinary window size, and neither is the cause of the
  duplicate header a subagent produces — that is a foreign writer on descriptor 2,
  fixed separately. These are the same failure class found while probing for it.
  
  The regression test is the property both bugs broke, checked over the real views
  composed together — stream, composer, completion, timing and status at once,
  because the failure only appears in combination and a view that fits alone can
  still be the one that pushes the region over. Six claims per composition: every
  logical row fits the terminal's width, the wrapped physical rows fit its height,
  and the cursor's row and column are each non-negative and inside what was
  actually drawn.
  
  Widths run **exhaustively from one column** to the shared chrome floor — the
  same range `narrow-root.spec.ts` already holds the root chrome to — and then
  across representative ordinary widths to 200, over heights 10–50, with an empty,
  short, thirty-line and two-thousand-character composer, a standing completion
  offer, streaming on and off, and the timing panel on and off. Extending it below
  eight columns is what exposed the completion prefix; the previous sampling
  started at eight and could not see it. Two focused cases name each view
  directly, assert the stand-down policy rather than leaving it to whatever the
  arithmetic happens to do, and check that a duration which appears at all appears
  whole. All three fail without these two changes.
- @dshline/renderer@0.21.0

## 0.20.0

### Minor Changes

- 6110a63: Add `/worktrees`: choose a working directory represented in your Harness session history, then a conversation there or a new one.
  
  `/sessions` answers "which conversation". `/worktrees` answers the question
  before it, and reads the same authority to do it: `ctx.sessionQuery`'s logical
  corpus, grouped by each session's own immutable `SessionHeader.cwd`. A row IS
  "the sessions whose header records exactly this cwd", so it needs no id, no
  title, and nothing durable — the grouping key is the definition, it lives only
  while the picker is open, and the count in the first view and the rows in the
  second are one relationship read twice.
  
  The picker is directory-first, because a working directory is not a session:
  several conversations can be rooted in one, so selecting a directory opens that
  directory's sessions and a `+ New session` row rather than resuming whichever
  is newest. The second view is the same `SessionCatalog` `/sessions` already
  uses, scoped to that exact `cwd`.
  
  A choice becomes one of the two attachment targets that already existed —
  `ctx.agents.resume({ id })` for a session, `ctx.agents.create` with the
  selected `cwd` for a fresh one — under the same refusals `/sessions` and `/new`
  apply, so one dshline window still drives one root Session. A fresh session
  needs no follow-up write: Harness stamps `cwd` into its header, and that header
  is the grouping rule. Nothing is persisted, and no new dependency or
  composition row is added.
  
  The session corpus is deliberately the authority rather than Harness's durable
  Workspace registry. At the adopted generation the domain storage that registry
  sits on is single-process by upstream's own documentation —
  `dsh-storage-domain`'s `domain/changed` is in-process and "a second host
  process observes no changes", and `dsh-storage-json` has "no cross-process
  write locking" with last-completion-wins — so several terminals mutating it
  would hold stale state and overwrite each other. Session persistence is the
  right shape for this: one artifact per session, one live writer per session,
  and a fresh listing on every corpus read.
  
  Limits, stated rather than worked around: a Git worktree Harness has never had
  a session in does not appear yet; enumerating, creating, and removing worktrees
  stay out because the adopted generation publishes no Git or worktree
  capability; and neither `/worktrees` nor `/sessions` can tell whether a
  persisted session is already open in another dshline process, because Harness
  publishes no cross-process ownership contract — its own live-session refusal
  consults this process's store only. The shipped JSONL backend requires one live
  writer per session, so the same session must not be driven from two processes
  at once.
- 94dac80: Ask `ask_user_question` questions with the full Harness answer contract: multi-select questions present a bounded checkbox list (space toggles, enter confirms), every option question gains an `Other…` route into the existing single-line editor, and a question with no options is answered as free text instead of through a stand-in `OK` choice. Custom answers encode exactly as Harness defines them — replacing the selection for single-select, supplementing it for multi-select — and option-less answers arrive as `custom` text.

### Patch Changes

- 926ad41: Keep the status footer focused on session controls, showing stop and quit gestures instead of tool-output inspection, and report goal state without repeating the full objective. The objective remains available through `/goal`.
- e690364: Clarify `/sessions` rows: delegated child sessions now carry a subdued `delegated` cue, and an untitled session that is currently open is labeled `current` instead of `untitled`.
- 3d20c42: `/cache` now says what its accounting is, and `/model` says what a real switch can cost.
  
  The `/cache` inspector gained one scope caption under its figures — "Session
  cumulative · includes requests across provider/model changes" — so the session
  totals cannot be read as the route named in the header section below. A
  provider/model change is a request boundary, not a reset boundary for this
  metric, and Harness's `tokenUsage` fold stays the single cumulative authority.
  
  `/model` now emits one informational note on its own second transcript line when
  the switch actually moves to a different provider or model: "cache reuse after a
  provider/model change is provider-dependent; /cache remains session-cumulative".
  The note claims neither outcome — no promise that cache is lost, no promise that
  it carries over — and depends on the move alone: re-selecting the active route
  says nothing, a pick that applied nothing says nothing, and there is no guard,
  confirmation, or automatic routing. It deliberately reads no usage projection,
  so no snapshot timing can affect whether it appears.
- 7fa08e5: Point the dshline package homepage at dshline.xyz, the canonical project website.
  
  npm's package homepage now sends visitors to the product front door instead of
  back to the repository README. Nothing else about the package changes:
  `repository` and `bugs` still point at GitHub, and source, issues, releases and
  every document stay there. `@dshline/renderer` deliberately keeps its GitHub
  homepage — it is published as an agent-agnostic renderer, and the website
  positions the product, not that package.
- 40a6683: Render more of the structured metadata tools already publish through their presentation views. A call card now lists the files its view declared via `locations` (with `:line` when the view focuses one), bounded by the same row budget as the body and reachable through the inspector when elided. A web search card shows the provider's `answer` above its sources, and each source now carries its `snippet` and `publishedAt` alongside the title and url. A web fetch card opens with a retrieval summary — url, HTTP status, and the view's own `truncated` flag — instead of showing only the fetched text.
- 7328897: Make `/exit`, `/quit`, and the equivalent quit gestures cancel active attachment work before requesting shutdown. Exit no longer waits for replay input gating, and image admission and command execution receive attachment-lifetime cancellation.
- 2b3d7ad: Prevent streamed Codex/OpenAI reasoning from appearing twice when its assembled block omits only the trailing line break emitted by the stream.
- 0ba98a9: Make the Window quit request one-shot across all gestures; interrupt maintenance activity even when the public Agent status is idle, and keep a synchronous Agent cancellation failure from preventing the Harness shutdown request.
- f10fdea: Make compaction feedback visible and honest. The `/context` inspector now
  shows the classified text of a failed or refused `/compact` (a busy session,
  an unknown command) as a notice instead of hiding it behind the overlay, reads
  the command registry live so the `c compact` footer follows a changed
  composition, and restricts the `c` gesture to the overview where the footer
  offers it. Compaction has a longer dispatch timeout than ordinary commands,
  because its handler performs an auxiliary model call, and the status line now
  reports a `/compact` it is awaiting with its own spinner while the agent stays
  idle — for a typed `/compact` — instead of claiming `ready`. Automatic
  compaction belongs to Harness and runs inside a running turn, so its progress
  is the turn's own busy presentation.
- @dshline/renderer@0.20.0

## 0.19.0

### Minor Changes

- 9d40295: Signed-in routes now report a cost in `/usage`: the **API-equivalent cost** —
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

### Patch Changes

- 644f872: Let the composer frame use the terminal's available width while keeping the capped readable policy for overlays and other document-style surfaces.
- @dshline/renderer@0.19.0

## 0.18.0

### Minor Changes

- 600060e: Guide a fresh install from `dshline` to a working model, and close the gap between signing in and having one.
  
  Three changes, all through Harness's own authorities:
  
  - **The authorization seam is now composed.** At the adopted Harness generation no shipped bundle mounts `@deepseek-ai/dsh-authorization`, and `dsh-llm-pi-ai` scopes its sign-in flows to that seam's presence — so account sign-in was unavailable in every stock dshline profile and `/connect`'s Sign-ins section was permanently empty. This bundle's `cordis.patch.yml` now inserts the row, exactly as it already does for `session-stats`.
  - **`/setup`**, which runs by itself on a launch that would otherwise reach the composer without a model it can send to — no registered route, no selection, a selection naming a route nothing registered, or a selected route whose credential Harness reports as absent (the stock first install, where a default model and its route both exist before any key does). Uncertainty never counts: a route naming no credential reference, or a store that cannot answer, leaves the launch alone. It commits a reading of the installation to scrollback — Node, dshline, the Harness generation compared against the one this build targets, the profile, what can configure a provider, and why there is no model — then hands off to `/connect` and, once connecting produces the missing route, straight into `/model`. It re-reads Harness each pass, stores no first-run state, and writes nothing you did not choose.
  - **A successful sign-in now offers to activate the route it authenticates.** A credential record and a settings profile are separate writes, so signing in used to leave `/model` with nothing to offer and no explanation. `/connect` now says which route an account authenticates (for `llm-pi-ai`, which documents that correspondence itself), shows `signed in · <route> route not active`, and asks before activating — against a fresh reading, and never automatically.
- 3466475: `/cache` opens a bounded read-only inspector for this session's provider cache
  usage: the cache-read share and the prompt buckets behind it, from the same
  Harness accounting `/usage` reports, beside the latest request header Harness
  recorded — route, system prompt, tool count — read through
  `Session.requestHeader()`.
  
  Figures appear only when the provider reported a cache read, because Harness's
  optional cache counts fold to zero when absent and an adapter that reports none
  is indistinguishable from a cache that went cold. It observes and changes
  nothing, holds no history, and claims no saving, waste, or cause.

### Patch Changes

- @dshline/renderer@0.18.0

## 0.17.0

### Minor Changes

- f06e8b8: Attach durable Harness-backed raster images with `/image` while keeping `@path` textual.
- 74cc0b5: dshline now emits one terminal BEL when it presents a Harness question or an
  owned approval request. `dshline.attentionBell` defaults to `true` and can be
  set to `false` in Harness settings when the terminal's bell should remain
  available to other programs but not this frontend.

### Patch Changes

- 03d1633: A first run now installs the version of dshline that asked for it. The wrapper
  names its own exact version to `dsh plugin add` and passes dshline's release-age
  window to the harness's pnpm on the command line, instead of asking for the bare
  package name and letting pnpm choose.
  
  The bare name was silently choosing wrong. pnpm 11 carries a built-in
  release-age default, so hours after `0.16.0` reached npm's `latest`, a fresh
  profile still resolved `@dshline/dshline` to `^0.15.0` — and a `0.16.0` wrapper
  booted a frontend one release behind itself against a Harness generation that
  release had never seen. Naming the version fixes which release is installed;
  stating the window is what makes pnpm treat a version that is still too young as
  something to decide about rather than something to quietly exclude from the
  policy: on a terminal it asks before it would proceed, and where there is nobody
  to ask it refuses. Both stop the setup and start nothing, which is the outcome
  the silent downgrade was hiding.
  
  The window itself moves from three hours to two, in `pnpm-workspace.yaml` and in
  the wrapper, which are now checked against each other. `dshline --setup <source>`
  is unchanged: a caller who named a checkout has already chosen what to install.
- Updated dependencies [f06e8b8]
  - @dshline/renderer@0.17.0

## 0.16.0

### Minor Changes

- 98035a1: Expose Harness's Queue and Steer delivery as a reader's choice, and teach the empty composer to say which one is in force.
  
  Pressing `enter` while a turn runs used to call whichever Agent verb the agent's status made available, which was always `steer` — so every busy submission joined the reasoning already under way and a follow-up turn could not be asked for. It is now a preference. `/enter queue` and `/enter steer` set it, bare `/enter` asks, and the default is `queue`, matching the adopted Harness generation's own Web client. `ctrl-enter` sends the other way for one message where the terminal's enhanced keyboard encoding can distinguish it, is adjudicated by the suggestion list exactly as `enter` is so the modifier changes only the delivery and never the submitted text, and does exactly what `enter` does where the terminal cannot send it — so nothing is lost or duplicated, and the composer never advertises the key. The choice is stored in the `dshline` settings namespace beside the theme, so it survives reopening a session; a profile with no settings provider keeps it for the process and says it could not be stored.
  
  The empty composer now reads `ask anything · / menu` when idle and `type to queue` or `type to steer` while a turn runs, shedding whole segments as the terminal narrows. That also fixes a latent overflow: the hint used to be fitted with a wrapping helper, so below nineteen columns the empty composer drew an extra row it had not budgeted for, which on a short terminal pushed the live region past the screen.
  
  The status line's pending-input segment now names which of Harness's two boundary lists is waiting — `1 queued`, `1 steering`, or `2 pending` for a mixture — read live from the agent's inbox rather than counted from submissions. `ctrl-c` still discards pending input along with the turn, and now says how many prompts went with it.
- b9c1588: `/connect` now curates a pi-ai route's request headers, so a gateway that
  authenticates with anything other than the field carrying the `credential-ref`
  role can be declared and repaired from the terminal instead of by hand in
  `settings.yaml`. `Request headers` appears on both the route editor and the
  `+ Add custom provider` review, adds and removes entries, and writes one
  `set`/`unset` op at the route's own `headers` path — every sibling field this
  pass does not render (`compat`, retry policy, per-model reasoning) survives an
  edit untouched, the same way the other curated fields already behaved.
  
  The field name is knowledge this presentation module is allowed to hold; its
  SHAPE is not. `headersCurated()` offers the editor only while the namespace's
  own serialized schema still describes `headers` as a dict of strings — the same
  fail-closed check that makes an unreadable `api` union produce no protocol
  choices rather than a stale list — so a namespace that reshapes the field gets
  no header editor instead of a write `settings.mutate` would refuse. A candidate
  name or value is checked by handing it to the platform `Headers` constructor,
  which is the standard `PiAiProviderProfile.headers` is documented as validated
  against; Harness stays the authority, and a refusal from `settings.mutate` is
  still what a reader is shown.
  
  A header value can be an `Authorization` bearer or a signed gateway token, and
  nothing in the settings seam marks it as one: `headers` carries no
  `credential-ref` role, so `redactSecrets` does not strip it and it is stored in
  `settings.yaml` as ordinary configuration. That places the field outside
  Harness's redaction contract; it does not make what it holds harmless, and this
  frontend cannot tell a token from a tenant tag. So every value is treated as
  sensitive on screen — the route menu lists names alone, and a value appears
  only once a reader has opened `Request headers` and moved onto that header's
  row, which is the one place they asked to see it. The route's own action is now
  called `Edit route` rather than `Edit endpoint and models`, since endpoint and
  models are no longer all it edits; its id and its behaviour are unchanged.
  
  Model discovery is unchanged and still goes through `ctx.llm.discoverModels()`
  alone. `LlmModelDiscoveryRequest` names a provider, an endpoint, a protocol and
  a one-shot key and nothing else, so headers reach an endpoint only through the
  owning adapter's own resolution of the STORED profile. Both places that is
  visible now say so rather than letting a fetch look like an endpoint refusal:
  an unsaved header edit is not sent with a fetch on an existing route, and a
  route still being declared has no stored profile to resolve from at all.
  
  `docs/usage.md` gained the route declaring/editing section it had been missing
  since Connect 2.0 — it still described `/connect` as covering credentials and
  activation only, and pointed at `settings.yaml` for work the terminal has done
  since.
- ce19218: Adopt DeepSeek Harness `0.1.2-alpha.5`, and drop `0.1.1-rc.2`.
  
  dshline supports one Harness architecture at a time and migrates onto the new
  one rather than bridging both, so this release moves the adopted generation in
  `HARNESS_TARGET` from `0.1.1-rc.2` to `0.1.2-alpha.5` and deletes what the old
  one needed. Every `dsh-*` dependency, devDependency, and peerDependency is now
  exactly `0.1.2-alpha.5`.
  
  The `0.1.2` line removes the public `Session.events` array. Each read moved to
  the narrowest native API rather than to a snapshot of the whole log: `/context`
  resolves a node with `eventAt()` and still stops its backward `callId` search
  as soon as every wanted tool call is answered, and `/work` reconstructs a
  child's current activity by scanning back from the end of its log and stopping
  at the fork-inherited prefix — so a subagent's row can no longer be coloured by
  its parent's history, and attaching to a long-running child no longer costs
  that child's whole log.
  
  `/plugins` gives its duplicated preset orchestration back to Harness. Which
  preset a session runs is Harness's own `agentPreset` Session projection, not a
  reverse scan this frontend kept; switching one is `agentPresets.select()`,
  which serializes selections per session, re-checks the authoritative
  `turnBoundary` projection inside that switch, refuses a started session,
  recomposes, and records the choice. dshline no longer checks the lock at the
  write path or appends `agent-preset/selected` itself. The resume path reads the
  same projection, so `/plugins` and a reopened session can no longer disagree
  about what a session runs. Behaviour a reader sees is unchanged, including the
  pre-preset session that still resumes under `standard`.
  
  The `ask_user_question` answerer registers directly on the scoped
  `user-questions/request` waterfall; the runtime detection that also supported
  the older `registerProvider` shape is gone. The Host-plane
  `subagent-model-selection-settings` row likewise loses its resolution probe and
  mounts outright — the subpath it needs is published by the generation this
  bundle now pins.
  
  The command registry is called at its native signature. dshline dispatched
  `/compact` and every typed slash command through a local arity-probing wrapper
  that could call either the pre-attachment `(agent, line, signal)` shape or the
  current `(agent, line, images, signal)` one; only the latter exists in this
  generation, so the wrapper, its `unknown` casts, and its two-signature test are
  deleted and `ctx.commands.execute` is called directly.
  
  The theme settings section registers through `SettingsProvider#installSection`
  alone. The bridge that also called the old free `installSettingsSection` export
  is gone, along with the branded-namespace assertion it needed — this
  generation's registration and write APIs both accept the namespace literal, so
  `'dshline'` is passed as itself.
- 82eaf21: Adopt DeepSeek Harness `0.1.2-rc.1`.
- a549342: Make the Sessions browser a picker first and an inspector second.
  
  The `/sessions` list was answering one question — which session — while drawing
  every fact Harness could state about each row. An ordinary row is now a title
  and a relative age. The only mark that stays on the right is `open`, for the
  session the window is already driving, because that is the row reopening
  refuses. Workspace, origin, availability, lineage, event count, parent, and
  session id moved behind `→`, which discloses one session with its own facts and
  its own actions (find in this session, lineage, and rename where it is valid).
  
  That is also a cost change, not only a visual one. The bounded `listEvents()`
  read behind an event count and a last-activity time used to be taken for the
  selected row, so every arrow press loaded and surface-folded a whole session
  log. It is now taken when the surface that presents those facts is opened.
  Ordinary browsing is one `listSessions()` and one batched `readTitleSnapshots()`
  observation, and nothing else.
  
  Filters left the per-session action menu for `ctrl-f`. They narrow the corpus
  rather than the row under the cursor, and offering them under one row's title
  said otherwise. A ctrl gesture rather than a bare `f` because every printable
  character in this browser is already search input; `ctrl-f` is new to the
  renderer's key vocabulary, in both the legacy and the enhanced encodings.
  
  The keyboard model is now: type to search, `tab` for contents, `ctrl-f` for
  filters, `→` for details, `↵` to reopen. Session archival stays out: Harness
  owns it in the Workspace domain, but `archiveSession()` is one-way with no
  unarchive operation, and archive state is not a fact the session corpus
  publishes — so dshline neither offers an irreversible hide nor hides sessions
  out of the one surface that can still resume them.
- 95de0bb: Adopt Harness's `sessionStats` projection, and give `/usage` a performance section.
  
  `/usage` now answers two questions instead of one. **Usage** is unchanged — the four token buckets, the cache-read share, and the cost. **Performance** is new: `turns`, `steps`, `avg first token`, `avg output tok/s`, `model time`, and `tool time`, over the whole session log rather than over the part still on screen. Reopen a session and the figures come back with it, because none of them were ever this process's to remember.
  
  Every one of them comes from Harness. `@deepseek-ai/dsh-session-stats` is now a dependency of this frontend and a row in its bundle patch, and it publishes one projection unit that folds step boundaries, stream chunks, tool pairs, and assembled assistant messages into whole-log counts and wall times. dshline reports them and does not fold them: the only arithmetic it performs is two divisions over totals Harness already published — `ttftMs / ttftSteps` and `decodeTokens / (decodeMs / 1000)` — which is why both are labelled as averages rather than as a live rate. Nothing interpolates between Harness's updates to make a value move more smoothly than the projection does.
  
  Two rules decide what is printed, and they are different rules. A derived figure with no denominator is absent, because `0 / 0` is not an average. A summed wall time of zero is also absent, and for a stronger reason: in this unit zero means nothing contributed rather than nothing elapsed. `llmMs` accrues only over the request wall time from `step/start` to an assembled `assistant/message`, and `toolMs` only over a `tool/call` matched by its `tool/result`, so an interrupted reply and an unanswered tool call can both have taken real time and still leave their total at zero. `model time 0ms` would claim a measurement Harness never made, so the row is omitted instead. `turns` and `steps` are the exception and are always shown, zero included, because a count of zero is a real count.
  
  The row is host-plane, beside the frontend's own rows, and deliberately not behind an agent preset. A preset composes what one agent contributes to the host registries — its tools, its prompt sections, its delegation backends — and this unit contributes none of those: it registers a pure fold, is model-invisible, and is keyed by session rather than by agent. Preset ownership would make whether `/usage` can report performance a function of which preset a session happens to run, and would register the same unit once per mounted preset. Harness's own Web bundle mounts this same official package as a host-level bundle row for the surface that consumes it, which is the treatment this row copies.
  
  Package availability and capability availability stay separate concepts. The shipped frontend brings the plugin its own bundle mounts, as an ordinary pinned dependency rather than a peer the installing profile is asked to supply. What remains optional is the capability: a composition may drop the row, and then `/usage` boots, runs, and reports its tokens, cache split, and cost exactly as before, with one line saying this profile does not mount Harness session statistics — or, with no projection registry at all, with the section omitted, because the usage section above has already said so. There is no fallback implementation: dshline does not recount the session log, install a timer, replay events, or keep an accumulator of its own.
  
  The report stays live while it stands open through the existing session-scoped projection observer and the overlay's existing per-paint read. `sessionStats` and `tokenUsage` are values in one `ProjectionSnapshot`, so the two projection-backed halves of the report cannot describe two different moments; the money beside them is not in that snapshot and stays dshline's own pricing fold, reported alongside rather than within.
- 3491909: Make `/work` say what each Harness worker is actually doing, and which LLM is powering it.
  
  A subagent row used to lead with its `ctx.subagents` backend — `spawn` first, the task label after it, the activity word almost last — because the backend was once the only identity Harness exposed. That order is now inverted: the child's durable task label leads and never yields, the semantic activity word and its operation target come next, and a narrowing terminal gives up the clock first, then the route, then the target, then the word, always as whole facts. The backend takes overview space only for a child whose work is not observable, where it is the fact that explains the silence.
  
  A live in-process child now reports the LLM route its requests actually use, read from `Session.requestHeader()` — the canonical fold of the child's own `request/header` snapshots — and falling back to the options it was created with only before its first request. A later route change is simply a later envelope, so a delegated model selection shows up without dshline tracking it. The two sources are never mixed field by field: a header that carries no reasoning effort has none. That is also why the detail stage now says `backend  spawn` and `model  openai-codex/…` in two rows instead of calling both of them `provider`; a `spawn` child can be powered by any registered route at all.
  
  The detail stage also gains Harness's own telemetry for a local child: `active time` from the `subagentTiming` projection — completed turns plus an open one, advancing only while the child is genuinely running and freezing at the projection's bound when it is not — and a `tokens` total from the four disjoint `tokenUsage` buckets. Both come from the cheap `ctx.sessionProjections` snapshot, narrowed to those two keys; nothing calls `tokenMeter.measure()`, which prices the whole surface per call. A profile that registers neither unit shows neither fact, and the row keeps the weaker observed `elapsed` clock rather than claiming an active time it cannot prove. Only one clock is ever shown.
  
  The two projections are not attributable on the same terms, so they are not presented on the same terms. `subagentTiming` resets at the child's own `subagent/descriptor`, which is what makes it child-relative; `tokenUsage` folds provider-reported usage over the complete log and has no such reset, so a fork-seeded child's figure includes the parent's completed turns it inherited. The token fact therefore appears only when `Session.inheritedEventCount` is zero — the generic Harness lineage cut, not a backend name and not a Work-local usage fold — and is omitted otherwise. A seeded child can still show `active time`.
  
  Workflow members inherit all of it through the one join Work already made on Harness's published `childId`, so a member whose child is live says what that child is doing and which route executed it — never what the script's `meta.phases` declared it would use.
  
  Provider-managed children degrade honestly and deliberately: a run with no in-process child Agent gets no model row, no token figure and no active-time claim, only its backend, its elapsed time and `activity  provider-managed`. Nothing reads a provider's configuration, auth state, or output to fill that in.

### Patch Changes

- ee60ee8: Make dormant provider activation discoverable and keep Connect visibly waiting while an authorization attempt is still in progress.
- b2e05ef: Defer the Connect and Sessions browser module graphs until they are first opened, reducing dshline's ordinary startup module-evaluation work without changing command or session behavior.
- d6239ed: Read the status line's durable goal state from the Harness `goal` session projection instead of from `ctx.goals`. Objective, phase, round count, and round cap now come out of the same validated snapshot cut the status frame already takes for Todo and context occupancy, through the shared session-scoped projection observer, so Goal adds no second direct dshline snapshot. The goal service is consulted for one process-local fact no replay can reconstruct — continuation activation — and only for a projected goal that is durably active; that read stays live and uncached because `disarm()` changes it with no durable event. An activation that cannot be obtained reports `goal idle` rather than a running goal. The service call reads a whole view because the adopted Harness generation publishes no activation-only accessor, and `GoalService.get()` resolves its own durable half through `sessionProjections.stateOf()` internally; `.activation` is the only field dshline consumes from it. No change to the status wording, ordering, or degradation behavior.
- 1783181: Fix the root composer and status line so they never ask the terminal to draw a row wider than itself below the chrome floor (terminals narrower than 12 columns). Previously the shared root frame's 12-column presentation floor, and the status line's 10-column budget floor, could both exceed a narrower real terminal; `Screen` re-wrapped the overlong logical row into extra physical ones after the live region had already been budgeted in logical rows, which invalidated the live-region height assumptions. Below the floor, the composer now draws its own rows directly against the terminal's width with no frame, keeping an editable buffer and a valid cursor; the status line now bounds its budget to the real width and gives up entirely when there is no room at all. Widths at or above 12 columns are unchanged.
- 304833e: Report the cache-read share to one decimal, and offer it on the status line as `CR`.
  
  `/usage` reported the share in whole percents, so the range it exists for read wrong: a session reusing one prompt sits at ninety-nine-point-something, and every one of those printed as `100%`. It now keeps one decimal. Between an endpoint and that resolution it states a bound rather than moving the value — `>99.9%`, `<0.1%` — so `0%` and `100%` mean exactly none and exactly all of the prompt.
  
  The same figure is available on the status line as one whole `CR 99.8%` segment. It is convenience information, so it is the first thing the body gives up as the terminal narrows — before the graphical context bar — and it is never shortened. It is absent with no `tokenUsage` projection, no prompt tokens, or `/usage off`.
  
  Both readings come from Harness's `tokenUsage` projection through one derivation: `usageBuckets` reads its four numbers, `cacheReadShare` divides two of them, `formatCacheShare` turns the ratio into text. That is deliberately NOT the fold behind the `↑`/`↓` totals, which prices finalized assistant messages because it needs each request's route and time; Harness also counts a retried attempt's usage sample. The two are reported side by side, never divided into each other, and no comment or document claims they agree. `/usage` stays live through the existing projection invalidation and its existing per-paint `inspection()`: no timer, no polling, no refresh key, no second observer, no `tokenMeter.measure()`.
- Updated dependencies [98035a1]
- Updated dependencies [a549342]
  - @dshline/renderer@0.16.0

## 0.15.0

### Minor Changes

- 7fac3cb: `ctrl-z` undoes the last draft edit and `ctrl-y` redoes it, in both keyboard
  formats. Consecutive typing joins into one undo step no matter how the terminal
  delivered it, while a cursor move, a completion acceptance, or a deliberate
  newline starts a fresh one. History keeps its own ownership: a recalled history
  line or a submitted prompt is a new baseline, so `ctrl-z` never walks back
  across history navigation or into a prompt that was already sent. Undo history
  is bounded (fifty steps, with a character budget for very large drafts) and
  lives only in the renderer — nothing is stored in Harness and nothing survives
  a session.
- c19b797: `dshline` now sets itself up on a first run: with no `dshline` profile yet, it asks once and — with a yes — has Harness create and install the profile (`dsh plugin --profile dshline add @dshline/dshline`) before continuing into the launch that was asked for, so `npm install -g @deepseek-ai/dsh @dshline/dshline && dshline` is the whole install. An explicit `--profile` opts out, a profile that already exists is never repaired, and a non-interactive run says to use `dshline --setup` rather than installing packages unasked.
  
  `dshline --version` and `dshline -V` now answer with this package's version, with no harness, profile, or terminal needed. On Windows the launcher npm installs is a `dsh.cmd` shim, which is now run through `cmd.exe` with each argument quoted for it, so a first task keeps its spaces, quotes, and `cmd` metacharacters; an argument containing a line break is refused there with an explanation, because a `cmd` command line cannot carry one.
- daf3573: `ctrl-r` searches what you have sent this session. Type to filter your own prompts and slash commands — a plain case-insensitive substring, newest match first — press `ctrl-r` or `↓` for the next older match and `↑` for a newer one, and `↵` puts the selected line back in the input box **without sending it**, so you can edit it before you commit to it. `esc` leaves the box exactly as it was, cursor included, because the search never writes to it in the first place.
  
  A recalled line keeps its place in the history: `↑` from there continues to the line before it and `↓` walks forward to the half-typed draft you had before searching, and two non-adjacent submissions of the same text stay distinct, because a result is a historical position rather than a string. Long and multiline prompts are previewed around the line that matched rather than by their first line, so a result never appears to match for no visible reason. Pressing `ctrl-r` during a resume says the history is still loading rather than claiming there is none, and resolves whatever you have typed the moment the replay's own seeding lands — no extra read of the session.
  
  Scope is deliberately narrow: this session's submitted input, the same lines `↑` already walks. No cross-session search, no history file, no fuzzy ranking; `/sessions` remains where past conversations are found. The overlay is a bounded live-region surface, so committed scrollback is never rewritten, and `ctrl-r` still belongs to whichever overlay owns input — `/connect` keeps its refresh.
- 69d83d7: Add Harness-native skills: `/skills`, skills in the `/` menu, and a leading `/name` line that actually reaches the agent.
  
  A message beginning with a skill's name after a slash used to be swallowed by the unknown-command guard, so Harness's own human invocation gesture never reached the model. A leading `/name` is now adjudicated in one order — this frontend's commands, the harness's registered commands, then the skills the running agent can see — and a user-invocable skill's line is sent verbatim for `dsh-tool-skill` to interpret. Commands still win a shared name.
  
  `/skills` browses every skill the agent can see, with its description, who may invoke it, its source, and any "when to use" guidance; `enter` puts `/name ` in the prompt without sending it. User-invocable skills also appear in the `/` suggestion list beside the commands. dshline never discovers, loads, injects, or caches a skill body: it observes `ctx.skills.snapshot({ cwd, scope: agent })`, keeps the last complete catalog through a transient provider failure, and refetches on `skills/change` and after a preset recompose. Skills stay an optional capability — a profile that composes no registry says so.

### Patch Changes

- ba1bcbe: `/model` now clears a carried reasoning effort when the target model does not advertise it, preventing model switches from failing with `UNSUPPORTED_REASONING_EFFORT`. `/reasoning default` can also clear a stale effort on models that advertise no reasoning levels.
- 6867404: Narrow the Harness peer ranges to the one adopted Harness generation.
  
  dshline now targets a single Harness architecture at a time, recorded as one
  upstream commit and one npm version in `HARNESS_TARGET`. The `dsh-*` peer
  ranges carried a second `|| ^0.1.2-alpha.2` arm left over from maintaining
  several published Harness lines at once, and that arm promised a generation
  this bundle no longer compiles against — `0.1.2-alpha.4` removes `Session.events`,
  which `packages/dshline/src/questions.ts`, `src/context/model.ts`, and the
  window and activity paths all read. Package metadata is part of the
  compatibility promise, so the range now claims only what CI actually proves.
  
  No runtime behaviour changes. Installing beside a `0.1.1-rc.2` Harness is
  unaffected; installing beside a `0.1.2-alpha.*` Harness now reports a peer
  warning instead of silently claiming support.
- Updated dependencies [7fac3cb]
  - @dshline/renderer@0.15.0

## 0.14.1

### Patch Changes

- 95142f4: Give the active status word the same busy emphasis as the working spinner.
- @dshline/renderer@0.14.1

## 0.14.0

### Minor Changes

- 139be8e: Add `/clear`, which starts a fresh session in the current workspace like `/new` and wipes the visible display once the fresh session is actually created. A refused, failed, or resumed transition leaves the screen untouched.
- 84c7250: `/connect` can now declare a custom Harness route — a self-hosted server, a private gateway, a local endpoint speaking a protocol the mounted adapter supports — through the `llm-pi-ai` configuration domain, matching the scope Harness's own Models web UI exposes. `+ Add custom provider` walks through endpoint, protocol, optional key, and model catalog (fetched via `ctx.llm.discoverModels()` or entered by hand) with an explicit review before anything is written; an existing declared route gains an `Edit endpoint and models` action. Connect now also converges on `settings/updated`, `settings/document-updated`, `credentials/reference-updated`, and `credentials/record-updated`, so an edit made from the web Models page or a hand-edited `settings.yaml` no longer needs `ctrl-r`. No provider runtime, SDK, transport, HTTP client, or secret store in dshline: every write goes through the same `ctx.settings`/`ctx.credentials` seams the rest of Connect already uses, and the one piece of provider-family-specific knowledge (`connect/pi-ai.ts`) only ever reads a namespace's own schema and writes narrow settings paths.
- 259bd04: `/context` inspects what the model is currently carrying: projected context
  occupancy, the estimated system/tools/messages composition, and the largest
  current context entries as a share of message context — each named from the
  session log, with a bounded preview. `/compact` stays Harness-owned; `c` inside `/context` dispatches the
  same registered command, and a compaction is now presented from its own durable
  event, so an automatic one is reported too. Bare `/usage` becomes an inspector
  over Harness's cumulative token buckets and dshline's cost estimate, while
  `/usage cost|tokens|off` still sets the status display immediately. The status
  line no longer runs the token meter's O(surface) measurement on every redraw.
- daa1107: Open a terminal-native picker for a bare Harness `/permission` command. The picker renders the deployment's live permission presets and sends selections through Harness's existing command path.
- efac5fb: The completed-plan review is now a decision surface first: it shows the plan's heading, the choices, and a bounded preview of the plan's start, and advertises `ctrl-o` only when there is more to read. `ctrl-o` opens the full plan as one continuous scrollable document — the same content Harness already sends in the review request, laid out like the tool-output inspector (`↑`/`↓` scroll, `home`/`end` jump, `ctrl-o`/`esc` back). Returning preserves the pending decision and never answers or cancels the review; only `esc`/`ctrl-c` on the review itself still dismisses it to speak.
  
  `ctrl-o` inspection also now generically reaches a tool CALL's own `presentCall` content when that content is what got elided, not only a result's. `exit_plan_mode` is the case that surfaced this — it echoes the plan back as call-time content — but the fix is a property of `ToolCards`, not a special case for that tool name.
- f9f3abe: Add `/thinking` to show or hide model reasoning in the terminal without changing Harness reasoning behavior.
- 9f4097b: `/work` grows a selected-row detail stage: `↵` inspects the curated
  Harness-published facts of one job or subagent (provider/kind, lifecycle,
  live Agent status, semantic activity and operation, mode, durable session
  id, session residency, child sessions, lineage, lifecycle run id, owner,
  interrupt availability) and `esc` returns to the list. The list action reads
  `k interrupt` to match the seam's interrupt semantics rather than a generic
  "stop".
  
  The overview now communicates live work: rows spin with the status line's
  shared arc spinner only while Harness says the work is active (a Job in
  `running`, a subagent whose in-process child Agent is running), and a live
  child can show a semantic activity word plus the running tool's own
  presentation title, folded from the same Harness session events and tool
  presentation the status line uses. A run without an in-process child shows
  no invented activity. Selection in the overlay is identity-based: settling
  rows never move a human interrupt onto the item that inherited the old
  screen position.
- 1f8fa00: `/work` becomes a live execution cockpit with three separate Harness
  authorities: Workflows, Subagents, and Jobs. Harness workflow runs now appear
  with their name, current `phase(...)` narration, open-member count, and started
  count, and entering one shows its description, state, newest log line, and its
  published members grouped under the exact phase each was recorded with — the
  phases members actually recorded, never the script's declared `meta.phases`. A member whose child is still live opens that child's own
  subagent view, carrying its workflow, phase, and member label — the join is
  Harness's own `childId`, never a guess, and that same authority is why the
  child is presented under its workflow instead of a second time in the flat
  Subagents section.
  
  Workflow ownership comes from this session's own durable `tool-workflow/*`
  records, because a raw `workflow/*` event names a run and never the Session
  that asked for it; live workflow events are accepted only for a run those
  records already proved, and only as enrichment. Another window's orchestration
  cannot appear here, and a run's row leaves when the tool closes its durable
  record after the run and its children are quiescent.
  
  Spinner semantics are now honest: the arc spinner means dshline holds evidence
  of running computation — a live in-process child Agent Harness reports as
  `running`. A Job in `running` keeps a quiet `•` (a stopping Job keeps `◐`), a
  subagent whose provider publishes no in-process child keeps `●`, and a workflow
  animates only while one of its own members does. Settlements read `✓`, `✗`,
  and `⊘`.
  
  Detail views are real inspectable lists: `↑`/`↓` move a visible cursor through
  the facts of a workflow, subagent, or job view instead of scrolling underneath
  a stuck highlight, `home`/`end` jump to its ends, and the view scrolls to follow
  the cursor. `↵` on a plain fact does nothing rather than inventing an action,
  `esc` returns exactly one hierarchy level, and an aimed row that disappears
  before a keystroke acts on nobody rather than on its successor. The subagent
  view now leads with what the child is doing; the job view drops the row that
  only announced an action it does not have.

### Patch Changes

- 4860eec: dshline now truthfully supports Harness `0.1.2-alpha.2`, proven by a dedicated `Harness compatibility · Alpha` CI lane (npm `alpha`, alongside Minimum/Released/Edge) rather than inferred from version strings. Peer ranges for the Harness line widen to `^0.1.1-rc.2 || ^0.1.2-alpha.2`; Minimum stays `0.1.1-rc.2`.
  
  The settings seam (`@deepseek-ai/dsh-settings`) moved its registration from a free function to an instance method between these lines; the theme's settings wiring now bridges both shapes at runtime, the same way the existing user-questions bridge does, and preserves the original "an invalid stored value falls back to the composition entry" behaviour under both. `@deepseek-ai/dsh-atomic-write` stays a direct dependency unchanged — it carries no runtime import of cordis or dsh-invariants, so it is not cohort-sensitive.
- 2b31446: A resumed session now paints its composer and status line before the transcript replay finishes, so the window is visible — and a draft can be typed — during the replay instead of holding a blank live region with live key routing behind it. The status reports the replay instead of claiming `ready`, and an enter pressed during the replay keeps the draft and explains that nothing was sent, committed below the history instead of above it. `/plugins` and `/profiles` are imported on demand, so a launch that never opens either pays no module-evaluation cost for them.
- f5f134a: `ask_user_question` now answers correctly against both Harness's older single-provider `ctx.userQuestions.registerProvider()` and its current Agent-scoped waterfall registration, detected at runtime rather than by package version. Presentation is unchanged.
- @dshline/renderer@0.14.0

## 0.13.0

### Minor Changes

- 15280b3: Give the status line a semantic activity word derived from Harness-native seams instead of a hard-coded `working`. The model phase comes from the live session feed (`turn/start`/`step` boundaries, and `assistant/chunk` reasoning/text block starts and deltas → `waiting`/`thinking`/`responding`), and tool activity comes from the tool's own `presentCall` contract resolved for the attached agent (`reading`/`searching`/`fetching`/`editing`/`running`, with `working` only for unknown, mixed, or unpresentable calls) — never from tool-name heuristics, so a scoped or plugin tool classifies by what its definition says, not by what it is called. The spinner separates from the word with two ASCII spaces, the spinner keeps the `busy` accent while the word renders `subdued`, and the turn elapsed is labeled (`· turn 36m 42s`) so a specific word cannot read as the tool's own duration; the elapsed yields as a whole fact before the word is ever cut. The detailed activity segment now prefers the call view's presentation title (`npm test`, `Read src/index.ts`) over the internal tool name. A call's semantic activity is resolved once at `tool/call`, the six arc frames and their 100 ms heartbeat are unchanged, and the renderer package stays Harness-blind.
- bec5094: Deepen the Sessions browser through Harness's own session-query capabilities instead of frontend-owned semantics. `→` opens an action menu over the selected row: corpus filters (workspace and age become exact `filterSessions` clauses; origin stays a presentation-only classification because Harness publishes no origin predicate), lineage navigation from `traceSession` as a bounded tree with honest pruning counts, within-session full-text search via `searchEvents`, and real cursor-backed paging for both full-text scopes — opaque Harness cursors only, an explicit `Load more…` row, and a refresh path when the corpus moved under a cursor. The session this window drives can be renamed through `ctx.sessionTitle`, whose `user`-source title event pins the title; renaming a closed persisted session stays out of scope because the generic service only wields live session objects. Resume preflight, native scrollback, and Harness ownership of the corpus, titles, and cursors are unchanged.
- 6ec3c7c: Give dshline one coherent visual root: the composer and every temporary overlay now draw through a shared frame (`dshline` anchored on the left, the workspace or the view's identity on the right, navigation help integrated into the bottom border), so a browser reads as the composer expanded rather than as a detached modal. The spinner changes from ten Braille frames to six arc frames. The renderer gains a generic `frame()` primitive — left and right top-border labels, an integrated bottom-border footer, and divider rows — while the existing `box()` API stays unchanged. Overlay key ownership, Harness authority, and overlay/Composer state remain fully separate; only presentation is shared.

### Patch Changes

- Updated dependencies [6ec3c7c]
  - @dshline/renderer@0.13.0

## 0.12.0

### Minor Changes

- b96c50d: Show a `queued` count from Harness's live inbox projection, so pending steering is correct immediately on attach or re-attach and stays acknowledged until the agent takes it.
- 97062df: Navigate between retained tool-output cards with the left and right arrow keys while keeping vertical scrolling within the current card.

### Patch Changes

- e3796f0: Coalesce live-region repaints instead of drawing once per request: redraws asked for within the same event-loop turn — streamed deltas, capability feeds invalidating together, a resize storm — now share one compose-and-write at the turn's end, and `Screen.setLive` skips output entirely when the wrapped frame and cursor already match what is on screen. A 300-delta burst measured 90% fewer terminal bytes (325 KB → 32 KB) and an 88% shorter render path; a thousand redundant invalidations with unchanged content now write nothing. Pixels changed behind the screen's back — `ctrl-l`'s display clear (now exposed as the window's `clear`) and terminal resizes — mark the frame stale once and repaint synchronously through the same scheduler, so no commit can land against wiped or reflowed pixels. Input stays same-turn: the collapsed paint still lands before the next poll cycle begins.
- d403603: Clarify snapshot-derived work wording with singular-aware subagent and job counts, and label parallel activity suffixes as calls.
- baf68b1: Run `/profiles` launcher processes through the Harness subprocess capability while keeping their authentication semantics: the child environment restores every variable set in the package managers' own namespaces (`NPM_*`, `PNPM_*`, `COREPACK_*`, `NODE_AUTH_TOKEN`) plus the Host-resolved `DSH_HOME` after the seam's credential scrubbing, so private registries authenticating through `${NPM_TOKEN}`-style `.npmrc` references keep working. A relative `$DSH_BIN` is pinned to an absolute path before the seam verifies the launcher.
- Updated dependencies [e3796f0]
- Updated dependencies [d403603]
  - @dshline/renderer@0.12.0

## 0.11.0

### Minor Changes

- c0e9ff1: Remember the theme in Harness's own settings document.
  
  `/theme` now registers a `dshline` settings namespace and writes the choice into its user layer, so the theme is stored where every other Harness setting is. A deployment composes a default in the `dshline` row of `cordis.patch.yml`, a reader's `settings.yaml` overrides it, and Harness owns the layering, the schema, the validation, and the change feed.
  
  **It applies live.** Editing that section by hand while a session runs repaints the window; rows already committed keep the colours they were printed with, as everything committed does.
  
  A theme id no shipped palette has is refused by the schema rather than stored, so a session cannot reopen on a palette that does not exist. A profile that mounts no settings provider still runs on whatever it was composed with — only saving is unavailable, and the command says so.
  
  Adds `@deepseek-ai/dsh-settings` as a peer dependency and `@deepseek-ai/schemastery` as a dependency, matching how `@deepseek-ai/dsh-agent-presets` consumes the same service.
- 7911fd4: Colour is now chosen by semantic role rather than by name, and `NO_COLOR` is honoured.
  
  Every call site said `style(text, 'red')`, which names an appearance instead of a meaning — written identically for a failed tool and for a removed line of a diff, so no second palette could ever move one without moving the other. `paint(text, 'error')` and a `Palette` of roles replace it throughout. The shipped palette emits exactly the bytes it always did, so there is no visual change.
  
  `NO_COLOR`, `FORCE_COLOR`, `COLORTERM`, and `TERM=dumb` are now respected; none of them was read before. A palette may be authored in 256-colour or 24-bit form, and declares its own sixteen-colour fallback per role rather than being approximated.
  
  New in `@dshline/renderer`: `paint`, `setPalette`, `activePalette`, `MARKDOWN_ROLES`, `sgr`, and the `Role`, `Palette`, `PaletteRoles`, `RoleColor`, `Sgr`, and `ColorDepth` types. `style`, `Style`, and `StyleName` remain exported and unchanged.
- 6e347ef: Add `/theme`, with five shipped palettes.
  
  `default` is unchanged. `high-contrast` avoids the dim attribute and bright black entirely, both of which the default palette leans on and both of which are the first thing to vanish on a washed-out display. `ember` and `tide` are warm and cool palettes for a dark terminal, and `paper` is for a light one.
  
  The last three are authored in 24-bit colour and each declares its own sixteen-colour fallback per role, so a terminal that cannot show one gets a reviewed decision rather than a nearest-colour approximation — and `/theme` names the fallback it used instead of degrading silently.
  
  A theme reaches new rows only: committed scrollback is never rewritten, so rows above the live region keep the colours they were printed with. Applying one is confirmed by a single line drawn in the new palette, and the live region redraws with it.
  
  The palette is a window preference, like the usage meter and the tool detail level — it survives reopening a session. User-authored palettes are not supported yet.

### Patch Changes

- Updated dependencies [7911fd4]
- Updated dependencies [6e347ef]
  - @dshline/renderer@0.11.0

## 0.10.0

### Minor Changes

- 09b6d73: `ctrl-o` reaches truncated tool cards you have already scrolled past.
  
  A compact card commits its elided rows straight into native scrollback, where nothing can recover them, so the inspector was their only way back — and it held exactly one card. The next tool call took the offer over, and a result you scrolled past was gone for good.
  
  The last twelve truncated cards are now retained, newest first. `ctrl-o` still opens the newest unseen card and is still one-shot, which is what keeps the `compact → full → hidden` toggle a single keystroke away; reaching an older card is a deliberate second gesture, made with `ctrl-o` from inside the inspector. The title counts your place (`Tool output 2/6`), the hint advertises the step only while an older card exists, and stepping stops at the oldest rather than wrapping.
  
  A newer short result or an error no longer discards the history. That discarding existed only to stop one stale offer from capturing `ctrl-o` forever, which marking an offer consumed now handles instead.
  
  The retained history is bounded on purpose: an unbounded list of call arguments and results would be a second transcript, which is the thing this frontend refuses to keep. Older than twelve, the elision marker beside the committed rows is the honest answer.

### Patch Changes

- @dshline/renderer@0.10.0

## 0.9.0

### Minor Changes

- 717a2de: Add `/new` to start a fresh session in the current workspace, with the previous conversation available for reopening when Harness session persistence is enabled.
- e45ef55: Add `/plugins`: a terminal browser for the running agent's Harness preset composition — search, toggle a row, create a customizable copy of a built-in preset, switch a blank session's preset live, and set the default for new sessions.
  
  Adopting this required moving the agent plane behind Harness's own agent-presets architecture, the same step deepseek-harness's own Web bundle already took: `dsh-base`'s model-facing tool rows (`tool-bash`, `tool-fs`, `tool-subagent`, `tool-workflow`, and the rest of the per-agent rows a preset also lists) are now disabled in `cordis.patch.yml` and mounted through a preset instead, defaulting to `standard`. A fresh session composes from the roster's default; a resumed one composes from whatever preset its own session log recorded, never today's default — and a session from before this bundle adopted presets, which recorded none, resumes under `standard` specifically rather than whatever the default happens to be today, so old history is never silently rebuilt under a different composition than it actually ran with. A deployment that ships no usable `standard` resumes such a session under its own default and reports the substitution in the transcript, rather than refusing to open its own history.
  
  A profile that mounts no `agentPresets` seam at all leaves the new composition step a no-op — but that only recovers the old flat `dsh-base` tool set for a deployment that never applied this bundle's own agent-plane disable list to begin with. Removing the seam from an otherwise-stock dshline install leaves an agent with no tools at all; `/plugins` itself still degrades cleanly and reports the capability unavailable either way.
- fc28162: Add `/profiles`, a terminal browser over Harness's own profile layer — the roster under `$DSH_HOME/profiles`, which profile this Host booted, and each profile's ordered `dsh.profile.bundles` layers with the installed version wherever pnpm's state already records one. It reads through Harness's own `dshHomePath` service and the Loader's base URL, and forwards every mutation to `dsh plugin --profile <name> …`, so pnpm invocation and `dsh.profile.bundles` reconciliation stay Harness's. No installer, resolver, package registry, or lockfile behavior is added here.
  
  Restart boundaries are stated rather than implied: a bundle change alters what the *next* Host composes, so a change to the running profile reports `restart required` and a change to any other names the command that picks it up. Switching profiles is not offered at all — nothing re-links a composed Host's bundle layers, so `enter` on another profile names the command that boots it.
  
  Bundle operations reach the launcher the same four ways `dshline` itself does (`DSH_BIN`, a `DSH_HARNESS` source checkout, `PATH`, then the installed `@deepseek-ai/dsh`), are serialized per profile for the whole process rather than per overlay, are bounded to completion rather than merely signalled, keep only a rolling tail of pnpm output, withhold URL specs and credentials from the transcript, and confirm before a removal.
  
  While an operation runs, the frame shows it persistently rather than as an expiring notice, and a landed change to the running profile keeps a `restart required` line on screen; closing the browser writes still-running work and any owed restart to the transcript instead of leaving it to be inferred from silence. Keys stay live throughout — a previous gate stayed shut for the whole pnpm run and returned silently, so every button appeared dead for minutes. A failure leads with the reason pnpm gave (`ERR_PNPM_FETCH_404`, git's `fatal:` line) rather than only its exit code, and the add prompt says outright that it takes an exact package name rather than searching.
  
  A dependency that is installed but is not a bundle layer is now listed under `Installed, not a layer` with its version, and can be removed like any other, so a package that composed nothing is visible instead of absent; one whose installed copy does declare `dsh.bundle` is flagged, since the layer list is then stale. Where a failure is a pending decision rather than a mistake — `ERR_PNPM_IGNORED_BUILDS` blocks every operation on a profile until a human answers pnpm's `allowBuilds` placeholders — the profile is tagged `builds pending` before anything is attempted and the file to answer it in is named, never edited. A running operation turns a real spinner and vanishes when it finishes.
  
  `/plugins` now shows capability health where it can be proven from Harness state. A profile PROVIDES capabilities and a preset EXPOSES them, so an enabled row is not evidence that its backing capability exists; a row naming a provider that a mounted Host registry does not supply is marked `⚠` and reported as unavailable in this Host — which is what `ctx.subagents.list()` actually proves, rather than a claim about what is installed. The check is a data table of capability modules read against `ctx.subagents`, not a branch per provider: a module the table does not cover, a `!!js` provider that is never evaluated, and a profile mounting no such registry all produce no verdict rather than a guess.
  
  `enter` now toggles a plugin row exactly as `space` does, outside search mode, where `enter` still means "done typing".
  
  **Breaking for anyone who typed it:** `/profile` is now `/timing`. It only ever toggled the per-turn time breakdown, and a Harness *profile* is the composition a launcher boots — the word now belongs to `/profiles`.
- 75c2770: Replace post-turn timing dumps with a bounded live panel that tracks active turns and tools in real time.

### Patch Changes

- a2e07f2: Ease a newly arrived live bar in over a few working heartbeats instead of flashing straight to full width — the first span is always the longest, so pure measurement drew every arrival at maximum. The ease follows the working spinner's existing heartbeat rather than render counts, so bursts of streamed redraws cannot spend it; it adds no timer and never alters the measured duration beside the bar, and spans that predate the panel appearing draw at full width immediately.
- a2e07f2: Redraw the timing panel's bars as mid-height strokes (`━`) over a dim track (`─`) instead of full blocks whose remainder was left blank. Blank remainders hid where each row's scale ended, and stacked full-height blocks fused rows of near-equal length into one slab that obscured where one span's bar ended and the next began; the stroke keeps whitespace between rows however close their durations are.
- a2e07f2: Name the longest span hidden behind the timing panel's elision row (`… +3 more · max 6.0s`) instead of showing an unlabeled sum. Timing spans overlap, so their sum is work done rather than elapsed time and could exceed the very turn printed in the heading; the maximum answers the same relative question as the rows above it. The figure degrades whole on narrow terminals rather than being cut into a broken duration.
- @dshline/renderer@0.9.0

## 0.8.0

### Minor Changes

- 3447249: Say what the goal is, and what a long turn is doing.
  
  The goal segment read `goal 0/256` — a round cap the reader never chose, against a
  count that had not moved, for an objective it never named. It now leads with the
  objective (`goal armed · ship the release`) and reports the count only once a round
  has actually been taken. This matters because a goal is not always something the user
  set: the harness publishes `create_goal` as a model-callable tool and tells the model
  it may infer a long-running objective without being asked, so a session can acquire
  automatic continuation authority that was never typed. The status line is where that
  becomes visible, and it now says what it is.
  
  The objective is the one part of a mode that may be surrendered on its own as the
  terminal narrows — it is prose, so a shorter one is still true, where a shortened
  round count would be a different number. Everything else about the drop order is
  unchanged.
  
  The working segment also names the tool the turn is waiting on
  (`⠙ working 14m 26s · run_shell_command +2`). Elapsed time alone reads the same whether
  a command is running or the session has hung. The harness dispatches concurrency-safe
  calls in parallel, so the count says how many others are outstanding rather than
  naming one of them as though it were the only one. The elapsed time stays the turn's:
  nothing claims a duration for any single call, because the harness publishes none.
- c5b3b7c: Rename the project, both packages, and the command to `dshline`.
  
  `dsh-tui` named the implementation — a terminal UI — rather than the thing it is:
  the terminal-native frontend for the DeepSeek Harness plugin ecosystem. The
  architecture is unchanged. Harness still owns capabilities, state, runtime,
  persistence, lifecycle, authorization and policy; this project still owns terminal
  presentation and frontend UX, and native terminal scrollback remains the invariant
  every presentation decision answers to.
  
  What consumers must change, because there is no compatibility alias:
  
  - `@riesbri/dsh-tui` is now `@dshline/dshline`, and `@riesbri/dsh-tui-renderer` is
    now `@dshline/renderer`. Both are new registry identities; the version lineage
    continues from 0.7.1 rather than restarting.
  - The command is `dshline`, not `dshtui`.
  - The Harness profile these install into is `dshline`:
    `dsh plugin --profile dshline add @dshline/dshline`, then `dsh --profile dshline`.
  - The bundle's Cordis rows are `dshline` and `dshline-startup`, so a
    `cordis.patch.yml` or `settings.yaml` that configured the `tui` row — pricing,
    for instance — must name `dshline` instead.
  - Sessions this frontend creates are now identified `dshline-<uuid>`.
  
  `TuiSlots`, `TuiOverlay`, `TuiSlotName`, `TuiSlotView` and the `tui/render` event
  keep their names. There, `Tui` is the technical term for a terminal user interface —
  the generic slot vocabulary any frontend of this shape would need — not the old
  product brand, and renaming it would have cost the vocabulary without removing any
  branding.
- 67ea319: Make every truncated tool result reachable, and keep the end of a command's output.
  
  `ctrl-o` armed an inspector only for a truncated **compact** card, so a `full` card
  that hit its own row cap printed `… 3 more lines` with nothing able to open it. The
  inspector now has its own, far larger row budget — its rows live in the windowed live
  region, where a card's are committed into scrollback permanently — so it has more to
  show than any card did, and every truncated card arms it and says so.
  
  Command output is now elided from the TOP rather than the bottom. What `pnpm test` was
  run to find out is the failure and the summary at the end; keeping the first six rows
  kept the banner and threw away the answer. File reads, searches, and diffs are
  unchanged: their first rows are what was asked for.
  
  The status line also lists `ctrl-o output` while a turn is running. A truncated card
  arms a one-shot opportunity that the next result takes away, so a turn is exactly when
  that keystroke needs advertising — and it was the one moment the hint was missing.
  
  Every presentation resolves its budget through one function, so a diff and a search
  are inspected at the inspector's budget too rather than keeping the card's cap. The
  inspector renders once per width instead of once per keystroke: the inspected result
  is a completed log entry, so scrolling a thousand-row body no longer re-runs the
  presenter on every arrow key.

### Patch Changes

- 99ff7a9: Count what the suggestion list is actually hiding, and bound it to the screen.
  
  The `… N more` row reported `candidates.length - shown.length`, which is the same
  number at every scroll position: fifteen commands showed `… 9 more` with the first
  highlighted and still `… 9 more` with the last. It now counts the rows below the
  window, so it reaches zero at the bottom, and the help line carries the position
  (`10/15`) so the rows scrolled off above are accounted for without a second marker.
  
  The list also ignored the height the slot contract passes it, so on a short terminal
  it pushed the composer out of the live region — where `Screen` can no longer erase it,
  and the next redraw left a duplicate frame in scrollback. `TuiSlots.compose()` now
  hands each slot view the rows the views above it have NOT spent, rather than the
  terminal's own height, so a ten-row prompt shrinks the list instead of overflowing the
  screen. Where nothing is left, the list renders nothing rather than chrome with every
  candidate hidden.
- 5d5f7ba: Accept the published Harness `0.1.1-rc` line in the peer ranges, and pin
  development dependencies to the exact currently published Harness versions.
  
  The peers said `^0.1.0-rc.7`, which under npm's prerelease rules rejects every
  `0.1.1-rc.x` package — npm ranges only match prereleases whose
  major.minor.patch tuple appears inside the range itself. The harness now
  publishes its moving line as `0.1.1-rc.x`, so installing this bundle next to a
  current harness produced unmet-peer warnings and ERESOLVE errors even though
  the bundle runs fine, which the compatibility workflow could not see because it
  only typechecked against unreleased master source.
  
  The ranges are now `^0.1.0-rc.7 || ^0.1.1-rc.2`: both lines the full suite has
  been run against, and nothing newer. Development dependencies are pinned to
  the exact authoritative published versions — the harness line under its `next`
  tag, cordis under `latest`, whose stable 4.0.1 is what the whole current line
  builds on — and a daily job re-pins them (`pnpm run sync-harness`), re-verifies
  the peer ranges (`pnpm run check-peers`), and boots the packed plugin beside
  the published launcher, so metadata can no longer drift from reality silently.
- Updated dependencies [c5b3b7c]
  - @dshline/renderer@0.8.0

> Released as `@riesbri/dsh-tui` through 0.7.1. The project was renamed to
> **dshline** after that release; entries below 0.8.0 record the old package
> identity as it was published, and are left as written.

## 0.7.1

### Patch Changes

- 30fb9dd: Bound the shared picker to the terminal, and let it be searched when it is long.
  
  `/model` over a gateway route offers whatever the provider advertises, which for
  OpenRouter or opencode is hundreds of models. The picker drew a row per choice,
  so it handed `Screen` a live region taller than the screen — and rows that have
  scrolled off cannot be reached or erased, which left duplicates in real
  scrollback and could clear output the picker never owned. The list is now a
  viewport over its rows, exactly as Work, Sessions, and Connect are.
  
  Past twelve choices it also grows a query box and filters as you type, with a
  counter that reports what the query left and what was offered separately. Below
  that nothing changes: a three-choice approval spends no row on a search box and
  typed characters stay meaningless there. A terminal too small to hold the frame
  now falls back to the selected choice and its keys rather than an unanswerable
  list, because an approval can arrive in any geometry.
  
  `/model`'s rows are now spelled `provider/model` — the argument the command
  accepts — with the provider's own display name under the selection when it adds
  something beyond the id. Filtering matches the label, so what you type is what
  you can see.
- Updated dependencies [30fb9dd]
  - @riesbri/dsh-tui-renderer@0.7.1

## 0.7.0

### Minor Changes

- e28e676: Add `/connect`, a Harness-native provider configuration browser.
  
  `/model` chooses among models that already exist; `/connect` is how a model comes
  to exist. It joins four Harness surfaces — the configurable-provider directory
  and registered routes from `ctx.llm`, the user-settings document through
  `ctx.settings`, credential presence through `ctx.credentials`, and the login
  flows on `ctx.authorization` — into one bounded overlay, and configures them
  through the seam that owns each.
  
  There is no provider list and no login protocol in this frontend. A route is
  offered because a mounted adapter declared it configurable, a profile's
  credential field is found by its schemastery `credential-ref` role rather than
  by a field name, and an authorization flow is rendered from the seam's neutral
  notice and prompt vocabulary, so a surface that renders one flow renders all of
  them. A sign-in page and device code are committed to native scrollback, where
  they can be selected and copied.
  
  Because both write the same settings namespace and the same credential
  reference, a change made here is visible on the official web Models page and the
  other way round, and `/model` sees a newly activated route's models with no
  further step.
  
  Closing the browser withdraws any sign-in it started, including one waiting on a
  browser callback with no prompt on screen, so nothing from a withdrawn attempt
  surfaces afterwards.
  
  The renderer gains `ctrl-r` in its key tables, which the browser uses to ask
  Harness again, and `tailToWidth`, the suffix twin of `truncateToWidth` that
  keeps an input field's newest characters in view.

### Patch Changes

- Updated dependencies [e28e676]
  - @riesbri/dsh-tui-renderer@0.7.0

## 0.6.0

### Minor Changes

- 786b993: Add a Harness-native Sessions browser. `/sessions` and `--resume` now open the
  same bounded overlay: it lists the `ctx.sessionQuery` corpus newest first with
  batched folded titles, filters as you type over titles, workspaces, and ids, and
  hands the same words to the engine's full-text surface on `tab` to search what
  sessions said — degrading to filtering when a deployment's backend implements no
  content search. The selected row shows its workspace, event count, last activity,
  lineage, and id, and short badges mark the open session, a live one, a delegated
  child, and a fork.
  
  Reopening now works from inside a running window. It retires the current agent
  through the owned `AgentHandle` disposer and resumes the chosen session with
  `ctx.agents.resume`, appending the replayed transcript into native scrollback
  without rewriting anything already committed. It refuses, naming the reason, when
  a turn is running, when jobs or subagents are still attached to the session being
  left, when the target is already live, or when it has no persisted log. A resume
  that fails anyway reports Harness's reason and reopens the browser rather than
  ending the process or substituting a session nobody asked for.

### Patch Changes

- 08a3e1b: Keep streamed reasoning from splitting an unfinished final-answer line.
- @riesbri/dsh-tui-renderer@0.6.0

## 0.5.1

### Patch Changes

- b39d8c6: Align the npm package description with dsh-tui's Harness-native terminal frontend positioning.
- @riesbri/dsh-tui-renderer@0.5.1

## 0.5.0

### Minor Changes

- cd6e737: Refresh dsh-tui's plugin-native project positioning and terminal architecture visuals.

### Patch Changes

- Updated dependencies [cd6e737]
  - @riesbri/dsh-tui-renderer@0.5.0

## 0.4.0

### Minor Changes

- 599129d: Add a bounded `/work` overlay and optional status summary for generic DeepSeek Harness jobs and subagents.
- 2fdf6cd: Present Harness-owned Todo projections through a bounded read-only `/todos` overlay and compact status summary.

### Patch Changes

- Updated dependencies [599129d]
- Updated dependencies [2fdf6cd]
  - @riesbri/dsh-tui-renderer@0.4.0

## 0.3.2

### Patch Changes

- 35de732: Keep exact-width composer navigation, recalled drafts, and review overlays correct at terminal boundaries.
- Updated dependencies [35de732]
  - @riesbri/dsh-tui-renderer@0.3.2

## 0.3.1

### Patch Changes

- a07df8e: Keep the startup banner version synchronized with generated package releases.
- @riesbri/dsh-tui-renderer@0.3.1

## 0.3.0

### Minor Changes

- 069d97c: Improve terminal interactions + CI

### Patch Changes

- Updated dependencies [069d97c]
  - @riesbri/dsh-tui-renderer@0.3.0

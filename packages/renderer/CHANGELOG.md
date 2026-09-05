# dshline-renderer

## 0.18.0

## 0.17.0

### Minor Changes

- f06e8b8: Attach durable Harness-backed raster images with `/image` while keeping `@path` textual.

## 0.16.0

### Minor Changes

- 98035a1: Expose Harness's Queue and Steer delivery as a reader's choice, and teach the empty composer to say which one is in force.
  
  Pressing `enter` while a turn runs used to call whichever Agent verb the agent's status made available, which was always `steer` — so every busy submission joined the reasoning already under way and a follow-up turn could not be asked for. It is now a preference. `/enter queue` and `/enter steer` set it, bare `/enter` asks, and the default is `queue`, matching the adopted Harness generation's own Web client. `ctrl-enter` sends the other way for one message where the terminal's enhanced keyboard encoding can distinguish it, is adjudicated by the suggestion list exactly as `enter` is so the modifier changes only the delivery and never the submitted text, and does exactly what `enter` does where the terminal cannot send it — so nothing is lost or duplicated, and the composer never advertises the key. The choice is stored in the `dshline` settings namespace beside the theme, so it survives reopening a session; a profile with no settings provider keeps it for the process and says it could not be stored.
  
  The empty composer now reads `ask anything · / menu` when idle and `type to queue` or `type to steer` while a turn runs, shedding whole segments as the terminal narrows. That also fixes a latent overflow: the hint used to be fitted with a wrapping helper, so below nineteen columns the empty composer drew an extra row it had not budgeted for, which on a short terminal pushed the live region past the screen.
  
  The status line's pending-input segment now names which of Harness's two boundary lists is waiting — `1 queued`, `1 steering`, or `2 pending` for a mixture — read live from the agent's inbox rather than counted from submissions. `ctrl-c` still discards pending input along with the turn, and now says how many prompts went with it.
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

## 0.14.1

## 0.14.0

## 0.13.0

### Minor Changes

- 6ec3c7c: Give dshline one coherent visual root: the composer and every temporary overlay now draw through a shared frame (`dshline` anchored on the left, the workspace or the view's identity on the right, navigation help integrated into the bottom border), so a browser reads as the composer expanded rather than as a detached modal. The spinner changes from ten Braille frames to six arc frames. The renderer gains a generic `frame()` primitive — left and right top-border labels, an integrated bottom-border footer, and divider rows — while the existing `box()` API stays unchanged. Overlay key ownership, Harness authority, and overlay/Composer state remain fully separate; only presentation is shared.

## 0.12.0

### Patch Changes

- e3796f0: Coalesce live-region repaints instead of drawing once per request: redraws asked for within the same event-loop turn — streamed deltas, capability feeds invalidating together, a resize storm — now share one compose-and-write at the turn's end, and `Screen.setLive` skips output entirely when the wrapped frame and cursor already match what is on screen. A 300-delta burst measured 90% fewer terminal bytes (325 KB → 32 KB) and an 88% shorter render path; a thousand redundant invalidations with unchanged content now write nothing. Pixels changed behind the screen's back — `ctrl-l`'s display clear (now exposed as the window's `clear`) and terminal resizes — mark the frame stale once and repaint synchronously through the same scheduler, so no commit can land against wiped or reflowed pixels. Input stays same-turn: the collapsed paint still lands before the next poll cycle begins.
- d403603: Clarify snapshot-derived work wording with singular-aware subagent and job counts, and label parallel activity suffixes as calls.

## 0.11.0

### Minor Changes

- 7911fd4: Colour is now chosen by semantic role rather than by name, and `NO_COLOR` is honoured.
  
  Every call site said `style(text, 'red')`, which names an appearance instead of a meaning — written identically for a failed tool and for a removed line of a diff, so no second palette could ever move one without moving the other. `paint(text, 'error')` and a `Palette` of roles replace it throughout. The shipped palette emits exactly the bytes it always did, so there is no visual change.
  
  `NO_COLOR`, `FORCE_COLOR`, `COLORTERM`, and `TERM=dumb` are now respected; none of them was read before. A palette may be authored in 256-colour or 24-bit form, and declares its own sixteen-colour fallback per role rather than being approximated.
  
  New in `@dshline/renderer`: `paint`, `setPalette`, `activePalette`, `MARKDOWN_ROLES`, `sgr`, and the `Role`, `Palette`, `PaletteRoles`, `RoleColor`, `Sgr`, and `ColorDepth` types. `style`, `Style`, and `StyleName` remain exported and unchanged.
- 6e347ef: Add `/theme`, with five shipped palettes.
  
  `default` is unchanged. `high-contrast` avoids the dim attribute and bright black entirely, both of which the default palette leans on and both of which are the first thing to vanish on a washed-out display. `ember` and `tide` are warm and cool palettes for a dark terminal, and `paper` is for a light one.
  
  The last three are authored in 24-bit colour and each declares its own sixteen-colour fallback per role, so a terminal that cannot show one gets a reviewed decision rather than a nearest-colour approximation — and `/theme` names the fallback it used instead of degrading silently.
  
  A theme reaches new rows only: committed scrollback is never rewritten, so rows above the live region keep the colours they were printed with. Applying one is confirmed by a single line drawn in the new palette, and the live region redraws with it.
  
  The palette is a window preference, like the usage meter and the tool detail level — it survives reopening a session. User-authored palettes are not supported yet.

## 0.10.0

## 0.9.0

## 0.8.0

### Minor Changes

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

> Released as `@riesbri/dsh-tui-renderer` through 0.7.1. The project was renamed to
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

## 0.6.0

## 0.5.1

## 0.5.0

### Minor Changes

- cd6e737: Refresh dsh-tui's plugin-native project positioning and terminal architecture visuals.

## 0.4.0

### Minor Changes

- 599129d: Add a bounded `/work` overlay and optional status summary for generic DeepSeek Harness jobs and subagents.
- 2fdf6cd: Present Harness-owned Todo projections through a bounded read-only `/todos` overlay and compact status summary.

## 0.3.2

### Patch Changes

- 35de732: Keep exact-width composer navigation, recalled drafts, and review overlays correct at terminal boundaries.

## 0.3.1

## 0.3.0

### Minor Changes

- 069d97c: Improve terminal interactions + CI

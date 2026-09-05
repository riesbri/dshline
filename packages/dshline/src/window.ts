/**
 * The window: one terminal, and however many sessions are opened in it.
 *
 * This split did not have to exist while a launch drove exactly one session for
 * the life of the process — the plugin fiber and the session were the same
 * lifetime, so `ctx.effect` was the right owner for everything. `/sessions` can
 * retire one agent and attach another, which separates the two:
 *
 * ```
 * window       terminal, key routing, model route, reader preferences
 *    ↓ attaches
 * attachment   one Agent, its log projection, its adapters, its views
 * ```
 *
 * Key routing in particular belongs here. `ctrl-d` must quit from everywhere —
 * including the session browser that runs before any agent exists, and the gap
 * between two attachments where no session owns input — and only something
 * outliving the session can promise that. The previous launch picker had to
 * re-implement quitting, painting, and key reading precisely because there was
 * nothing above it to inherit them from.
 * @module dshline/window
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelectionRef, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { LlmModelReasoningInfo, ModelModality } from '@deepseek-ai/dsh-llm'
// Carries the Context merges this module reads but does not otherwise import
// from: the launcher's settlement await and exit request, and the default model
// selection. Neither has to be mounted for the frontend to run.
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { ColorDepth, Key, Palette, Terminal } from '@dshline/renderer'
import { acquireTerminal, escapeControls, paint, Screen, setPalette } from '@dshline/renderer'
import { DEFAULT_PALETTE } from './theme.ts'
import type { BusyEnter } from './delivery.ts'
import { FALLBACK_THEME, findTheme } from './themes/builtin.ts'
import type { DshlineSettings, PreferenceSetting } from './settings.ts'
import type { CardDetail } from './cards.ts'
import { pluginsSeams, sessionFacts } from './plugins/harness.ts'
import type { AgentPresetsSeam } from './plugins/harness.ts'
import { RedrawScheduler } from './redraw.ts'
import type { AttachTarget } from './sessions/reopen.ts'
import type { TuiStartupOptions } from './startup.ts'
import type { PeakWindow, PricingTable, UsageMode } from './usage.ts'

/** Erase the visible screen and home the cursor; scrollback above survives in the terminal. */
const CLEAR_DISPLAY = '\u001b[2J\u001b[H'

/** Terminal BEL: an attention effect with no cursor or screen-state effect. */
const BEL = '\x07'

/**
 * Mutable presentation preferences that outlive one session.
 *
 * The reader's settings are not facts about a session: reopening one should not
 * silently put the usage meter back to cost or re-expand tool cards they had
 * folded away. The model route is not here because it already has an owner —
 * {@link ModelSelectionRef} — which the agent reads per step.
 */
export interface WindowPrefs {
  /** What the status line reports. */
  usageMode: UsageMode
  /** Whether the persistent live timing panel is shown. */
  timing: boolean
  /** How much of a tool card is drawn. */
  cardDetail: CardDetail
  /** Whether model reasoning is shown in this terminal window. */
  reasoningVisible: boolean
  /**
   * What plain `enter` means while a turn is running.
   *
   * The one pref here with an authority behind it. It is seeded from the
   * `dshline` settings namespace and re-seeded from its change feed, so a choice
   * made in `settings.yaml` or by another surface arrives here — but the live
   * value is still held in the window, for the reason the palette is: a profile
   * that mounts no settings provider must still be able to change it for this
   * process, and reading the resolved section per submission would silently
   * refuse that.
   */
  busyEnter: BusyEnter
}

/**
 * Model metadata resolved once per selection, for the views that read it.
 *
 * Held on the window rather than per session because it describes the ROUTE, and
 * the route survives reopening a session. One resolve answers three questions:
 * the context bar's denominator, what `/reasoning` may offer, and whether the
 * status line should name the level at all.
 */
export interface ModelInfo {
  /** The model's context window, when the adapter reported one. */
  contextWindow: number | undefined
  /** The route's reasoning capability, when it has one. */
  reasoning: LlmModelReasoningInfo | undefined
  /** Accepted request modalities; undefined means the adapter does not know. */
  inputModalities: readonly ModelModality[] | undefined
}

/** What a deployment configured, gathered before the window exists. */
export interface WindowOptions {
  /** Rates for the usage meter, already validated. */
  readonly pricing: PricingTable
  /** When those rates charge the standard price. */
  readonly peakHours: readonly PeakWindow[]
  /** Version reported in each attachment's banner. */
  readonly version: string
  /** The settings namespace this frontend registered; the authority for its preferences. */
  readonly settings: DshlineSettings
}

/** One terminal, and the state every session opened in it shares. */
export interface Window {
  /** Context with the slot registry and the harness services. */
  readonly ctx: Context
  /** The terminal this window owns. */
  readonly terminal: Terminal
  /** Emit terminal BEL when the live reader preference permits it. */
  readonly bell: () => void
  /** The launcher's exit request, when it provided one. */
  readonly exit: ((code: number) => void) | undefined
  /** This invocation's parsed arguments. */
  readonly startup: TuiStartupOptions
  /** Rates for the usage meter, already validated. */
  readonly pricing: PricingTable
  /** When those rates charge the standard price. */
  readonly peakHours: readonly PeakWindow[]
  /** Version reported in each attachment's banner. */
  readonly version: string
  /** The route the next turn will use; the agent reads it per step. */
  readonly selection: ModelSelectionRef
  /** Metadata for that route, refreshed when it changes. */
  readonly modelInfo: ModelInfo
  /** Reader preferences that survive reopening a session. */
  readonly prefs: WindowPrefs
  /** The theme facet, for reading the current choice and storing a new one. */
  readonly themeSettings: PreferenceSetting<string>
  /** The busy-`enter` facet, for storing a choice the window already applied. */
  readonly busyEnterSettings: PreferenceSetting<BusyEnter>
  /** What this terminal can actually show, resolved once when it opened. */
  readonly colorDepth: ColorDepth
  /**
   * The palette in force.
   *
   * This is PRESENTATION state — what the renderer is drawing with. The chosen
   * theme itself has one authority, {@link Window.themeSettings}, and the two
   * agree except in the one documented case: a switch whose write failed has
   * already changed the terminal, and is not put back. `/theme` reports that
   * rather than hiding it, and picking the same theme again retries the write.
   */
  readonly palette: () => Palette
  /**
   * Install a palette for this window.
   *
   * Replaces rather than stacks: the previous one is released first, so a
   * reader trying five themes leaves one live registration and not five.
   * @param next - the palette to make current.
   */
  readonly setPalette: (next: Palette) => void
  /**
   * The launch task, consumed by the first attachment.
   *
   * Cleared once submitted: a session reopened from inside the window must not
   * replay the command line's opening prompt.
   */
  pendingTask: string | undefined
  /**
   * Repaint the live region.
   *
   * Requests coalesce: however many arrive in one event-loop turn, one paint
   * runs at the turn's end and reads the state as it then stands, so a burst
   * costs one frame instead of one frame per request. See
   * {@link RedrawScheduler} for why that stays inside the input's own turn.
   */
  readonly draw: () => void
  /**
   * Repaint the live region synchronously, outside the turn's coalescing.
   *
   * The one frame that cannot wait for the check phase: a resumed session's
   * transcript replay reads its log asynchronously — `readTranscript` awaits
   * `sessionQuery.readSession`, which is the window in which input may run —
   * and then projects and commits the flood in one event-loop block behind it.
   * A coalesced paint scheduled around that awaits no guaranteed slot of its
   * own, so this repaint is issued at the moment the replay begins: the
   * composer and status are on screen before the asynchronous read, whatever
   * the read's own internal scheduling turns out to be, and stay behind the
   * flood when it commits.
   */
  readonly paintNow: () => void
  /** Write finished rows into the terminal's own scrollback. */
  readonly commit: (lines: readonly string[]) => void
  /** Clear the display, then redraw the live region into the emptied screen. */
  readonly clear: () => void
  /** Re-resolve {@link ModelInfo} after the route changes. */
  readonly refreshModelInfo: () => void
  /** Route decoded keys to the attached session, or to nothing between two. */
  readonly setDispatch: (handler: ((key: Key) => void) | undefined) => void
}

/**
 * How much colour this terminal can show.
 *
 * Node already decides this, and decides it better than a rule table here
 * would: `getColorDepth` honours `NO_COLOR`, `FORCE_COLOR`, `COLORTERM`, and
 * `TERM`, and also the CI variables and Windows build numbers that a
 * hand-written version forgets. Owning that policy meant maintaining it, and
 * being wrong about it quietly; deferring costs one mapping.
 *
 * Node reports BITS, where 1 means monochrome. The renderer's 0 says the same
 * thing more usefully — it is the depth at which `paint` returns its input
 * untouched — so only that value is translated.
 * @returns the depth to install a palette at.
 */
function terminalColorDepth(): ColorDepth {
  // A non-tty `process.stdout` is a plain stream with no such method. dshline
  // refuses to start without a terminal, so this is belt and braces rather than
  // a path anyone reaches.
  if (typeof process.stdout.getColorDepth !== 'function') return 0
  const bits = process.stdout.getColorDepth()
  return bits === 1 ? 0 : (bits as ColorDepth)
}

/**
 * Take the terminal and wait for the Loader, before any agent exists.
 *
 * The Loader mounts siblings concurrently, so this waits for the whole tree
 * before an attachment creates an Agent — a row that had not activated yet would
 * otherwise be missing from the agent's registries.
 * @param ctx - context with the slot registry available.
 * @param options - deployment configuration for every attachment.
 * @returns the window, ready to attach a session.
 */
export async function createWindow(ctx: Context, options: WindowOptions): Promise<Window> {
  const exit = ctx.get('appExit')
  const startup = ctx.tuiStartup.options
  const terminal = acquireTerminal({ input: process.stdin, output: process.stdout })
  // Installed here, and before the screen exists, because this is the one
  // place already coupled to the real `process` streams — the renderer reads
  // no ambient state of its own, so somebody who legitimately owns the
  // environment has to hand it the answer. The loop awaits `createWindow`
  // before it attaches anything, so no row is ever composed under the wrong
  // palette. It belongs to the WINDOW rather than a session: reopening one
  // must not put the reader’s colours back, exactly as it must not put the
  // usage meter back to cost.
  const colorDepth = terminalColorDepth()
  // Harness resolves the layers; this only maps the id onto a shipped palette.
  // An id the schema let through that names nothing shipped falls back rather
  // than failing a boot over a colour.
  const resolved = (): Palette => findTheme(options.settings.theme.current()) ?? FALLBACK_THEME
  let palette = resolved()
  let releasePalette = setPalette(palette, colorDepth)
  // Released and reinstalled rather than stacked, so a reader who tries five
  // themes leaves one live registration and not five. The disposer is safe to
  // call twice, which is what keeps the teardown below independent of this.
  const installPalette = (next: Palette): void => {
    releasePalette()
    palette = next
    releasePalette = setPalette(next, colorDepth)
  }
  ctx.effect(() => () => { releasePalette() }, 'dshline: palette')
  const screen = new Screen(terminal)
  ctx.effect(() => () => {
    // Before the screen forgets its rows: a paint scheduled for this turn must
    // not write into a terminal that is being closed underneath it.
    redraws.stop()
    screen.close()
    terminal.close()
  }, 'dshline: terminal ownership')

  // Every redraw request funnels here — slot invalidations, session events,
  // the spinner tick, resize — so the scheduler sees each burst whole. One
  // compose-and-write per event-loop turn is the frame a reader can actually
  // see; the requests it collapses were racing to draw superseded pictures.
  const redraws = new RedrawScheduler(() => {
    const { lines, cursor } = ctx.tuiSlots.compose(terminal.columns(), terminal.rows())
    if (cursor === undefined) screen.setLive(lines)
    else screen.setLive(lines, cursor)
  })
  const draw = (): void => { redraws.request() }

  // Every pref but one is a literal, because nothing outside this process has an
  // opinion about it. `busyEnter` is seeded from the resolved settings section
  // instead, so a choice stored by a previous run — or by another surface — is in
  // force on the first submission rather than after the reader re-picks it.
  const prefs: WindowPrefs = {
    usageMode: 'cost',
    timing: false,
    cardDetail: 'compact',
    reasoningVisible: true,
    busyEnter: options.settings.busyEnter.current(),
  }

  // The same live-preference argument as the theme below, with one difference
  // worth stating: this one has no presentation to reinstall, so re-seeding the
  // pref IS the whole effect. Guarded for the same reason — the feed fires for
  // this window's own write too, and a redraw for a value that did not move
  // would repaint the composer's hint over itself.
  ctx.effect(() => options.settings.busyEnter.watch(() => {
    const next = options.settings.busyEnter.current()
    if (next === prefs.busyEnter) return
    prefs.busyEnter = next
    draw()
  }), 'dshline: busy-enter changes')

  // A theme is a live preference: the settings document edited by hand while a
  // session runs repaints this window, without it having to be reopened. Only
  // the live region changes — rows already committed to the terminal keep the
  // colours they were printed with, as everything committed does.
  //
  // Guarded on the id because this fires for our OWN write too, and
  // reinstalling the palette already in force would churn the registration
  // for nothing.
  ctx.effect(() => options.settings.theme.watch(() => {
    const next = resolved()
    if (next.id === palette.id) return
    installPalette(next)
    draw()
  }), 'dshline: theme changes')

  const commit = (lines: readonly string[]): void => {
    if (lines.length === 0) return
    screen.commit(lines)
  }

  // BEL does not move the cursor or change terminal cells, unlike the display
  // clear below. It therefore needs no Screen state update and stays at the
  // window boundary that owns both the terminal and reader preference.
  const bell = (): void => {
    if (options.settings.attentionBell.current()) terminal.write(BEL)
  }

  // The one repaint that cannot wait for the check phase. The wipe above
  // destroyed every pixel, so a commit landing before the turn's paint would
  // erase against rows the screen no longer holds — and until that paint, the
  // reader is looking at a blank transcript. Ordinary requests keep the
  // coalesced path; see RedrawScheduler.now.
  const clear = (): void => {
    terminal.write(CLEAR_DISPLAY)
    screen.markStale()
    redraws.now()
  }

  // One keyboard subscription for the whole window, delegating to whoever owns
  // input now. `ctrl-d` is read here, before any delegate: it means the same
  // thing everywhere, and the places it used to be re-implemented — the launch
  // picker's own key loop — are exactly the places it went missing.
  let dispatch: ((key: Key) => void) | undefined
  ctx.effect(() => terminal.onKey(key => {
    if (key.kind === 'key' && key.name === 'ctrl-d') {
      exit?.(0)
      return
    }
    dispatch?.(key)
  }), 'dshline: input')
  ctx.effect(() => ctx.on('tui/render', draw), 'dshline: redraw on slot change')
  ctx.effect(() => terminal.onResize(() => {
    // Reflow means the frame the screen holds may no longer match the model,
    // so the repair repaints synchronously, as ctrl-l does: while the screen
    // is marked stale, nothing else — a commit above all — should be able to
    // observe that state. The deferred order was measured to converge to the
    // same bytes anyway (the erase arithmetic is cursor-relative, and reflow
    // moves content and cursor together), but that is a property of the math,
    // not of the schedule, so it is pinned rather than assumed. Resize drew
    // synchronously before coalescing existed; this restores that shape.
    screen.markStale()
    redraws.now()
  }), 'dshline: redraw on resize')

  await ctx.get('loader')?.await()
  const selection: ModelSelectionRef = {
    current: ctx.get('agentDefaultModel')?.currentSelection(),
    assembled: undefined,
  }
  const modelInfo: ModelInfo = { contextWindow: undefined, reasoning: undefined, inputModalities: undefined }
  let modelInfoGeneration = 0
  // Resolved once per selection: the context window and the reasoning levels are
  // both model metadata, and asking the adapter on every frame would put an await
  // in the render path.
  const refreshModelInfo = (): void => {
    const generation = ++modelInfoGeneration
    const current = selection.current
    modelInfo.contextWindow = undefined
    modelInfo.reasoning = undefined
    modelInfo.inputModalities = undefined
    if (current === undefined) return
    void ctx.llm.resolveModelInfo(current.provider, current.model)
      .then(info => {
        // Route changes may resolve out of order. Only the latest lookup may
        // describe this window, especially now that modalities gate image I/O.
        if (generation !== modelInfoGeneration) return
        modelInfo.contextWindow = info.context?.contextWindow
        modelInfo.reasoning = info.reasoning
        modelInfo.inputModalities = info.inputModalities
        ctx.tuiSlots.invalidate()
      })
      // An adapter that cannot describe the model leaves the window unknown; the
      // status line then shows pressure without a denominator.
      .catch(() => {})
  }
  refreshModelInfo()
  return {
    ctx,
    terminal,
    bell,
    exit,
    startup,
    pricing: options.pricing,
    peakHours: options.peakHours,
    version: options.version,
    selection,
    modelInfo,
    prefs,
    colorDepth,
    palette: () => palette,
    setPalette: installPalette,
    themeSettings: options.settings.theme,
    busyEnterSettings: options.settings.busyEnter,
    pendingTask: startup.task,
    draw,
    // The synchronous paint is the same scheduler `clear()` uses for a wipe:
    // compose now, write now, never coalesce with a turn that may not come.
    paintNow: () => redraws.now(),
    commit,
    clear,
    refreshModelInfo,
    setDispatch: handler => { dispatch = handler },
  }
}

/**
 * Route and setup for the next agent this window attaches.
 *
 * Read at attach time rather than once, because `/model` writes the selection
 * and the session opened after it must use what is selected now.
 * @param w - the window attaching a session.
 * @returns the per-agent options shared by the create and resume paths.
 */
export function attachOptions(w: Window): Omit<ResumeAgentOptions, 'resumeSessionId'> {
  const current = w.selection.current
  return {
    ...current === undefined ? {} : { agentOptions: { provider: current.provider, model: current.model } },
    setup: async agentCtx => {
      installModelSelection(agentCtx, w.selection)
      await mountAgentPreset(agentCtx, w.commit)
    },
  }
}

/**
 * The preset a session from before this frontend adopted presets resumes
 * under, when its log names none. `standard` specifically, not today's
 * roster default: a produced session's composition is a historical fact,
 * and the deployment's default may have moved to `minimal`, `code`, or a
 * local custom preset since that session last ran. `standard` is what every
 * one of those sessions actually ran under before presets existed here —
 * dshline mounted the full flat `dsh-base` tool set unconditionally, and
 * `standard` is the shipped preset built to mean exactly that set.
 */
const LEGACY_SESSION_PRESET = 'standard'

/**
 * Compose this agent from its resolved Harness preset, when a preset roster
 * is mounted.
 *
 * Three cases, in order:
 *
 * 1. Harness's `agentPreset` Session projection names one — it folds the
 *    creation header with every later `agent-preset/selected` — and that
 *    recorded choice always wins. This is every session created since
 *    presets existed here (a new one's header is stamped before `create`;
 *    see `sessions/reopen.ts`), and any session an explicit `/plugins`
 *    switch touched. The projection is the same authority `/plugins` reads
 *    and `AgentPresets.select` writes, so a resume and a switch can never
 *    disagree about which preset a session runs.
 * 2. Nothing is recorded AND the session has already produced a turn: a
 *    session from before this frontend adopted presets. Resuming it under
 *    TODAY's default would silently rebuild history that was actually
 *    produced under the old flat `dsh-base` composition, so it prefers
 *    {@link LEGACY_SESSION_PRESET} instead — a real preset id, not a
 *    fallback that pretends nothing changed. A non-stock deployment that
 *    ships no usable `standard` falls back to the roster's default and SAYS
 *    so (see {@link legacyPresetId}): refusing the resume outright would
 *    leave that deployment unable to open its own history at all, which
 *    protects a composition record by withholding the transcript it belongs
 *    to.
 * 3. Nothing is recorded and the session is still blank: there is no
 *    history to protect, so the roster's current default applies, exactly
 *    like any other new session.
 *
 * `agentCtx.agent` is set before `setup` runs (dsh-agent-loop mints the
 * Agent, including a resumed session's already-reconstructed log, before
 * calling `setup(prepared.agent.ctx)`), so this reads the real session
 * facts rather than guessing from context.
 *
 * A profile that mounts no `agentPresets` seam at all leaves this a no-op.
 * That restores dshline's old flat behavior only for a composition that
 * never applied dshline's own agent-plane disable list in the first place
 * (a custom deployment mounting dshline's plugin code over its own already-
 * flat host plane) — the STOCK `cordis.patch.yml` disables those `dsh-base`
 * rows unconditionally, so simply removing the `agent-presets` row from an
 * otherwise-stock dshline composition leaves an agent with no tools at all,
 * not the old flat set back.
 * @param agentCtx - the unpublished agent's own scope context.
 * @param report - where to say that a legacy session could not be placed on
 * {@link LEGACY_SESSION_PRESET}; called only after the substitute preset has
 * actually mounted, so a failed resume never claims to have run under one.
 * Omitted stays silent, which is what the unit tests and a headless embedder
 * want.
 */
export async function mountAgentPreset(
  agentCtx: Context,
  report?: (lines: readonly string[]) => void,
): Promise<void> {
  const agentPresets = pluginsSeams(agentCtx).agentPresets
  if (agentPresets === undefined) return
  const facts = sessionFacts(agentCtx, agentCtx.agent?.session)
  const recorded = facts.presetId
  const chosen = recorded !== undefined || !facts.started
    ? { id: recorded ?? agentPresets.defaultId, caveat: [] as readonly string[] }
    : await legacyPreset(agentPresets)
  // Mount BEFORE reporting: `mount` rejecting rolls the whole resume back per
  // `setup`'s own contract, and a caveat emitted first would describe a
  // composition this session never ran under.
  await agentPresets.mount(agentCtx, chosen.id)
  if (chosen.caveat.length > 0) report?.(chosen.caveat)
}

/**
 * The preset an unstamped, already-produced session resumes under, and the
 * caveat that choice owes the reader — decided here, but NOT yet announced.
 *
 * Checked rather than assumed, and reported rather than fatal. `standard` is
 * the honest answer only where it exists: a deployment that ships its own
 * roster may have no `standard` at all, and `resolve()` deliberately succeeds
 * for a BROKEN preset (the roster still needs a row to show and delete), so
 * presence alone is not usability — `mount` would reject a broken one just as
 * it rejects an unknown one. Either way, hard-failing here would make old
 * transcripts unopenable on that deployment, trading a composition record the
 * reader cannot see for a transcript they can. Falling back and naming the
 * substitution keeps both facts: the session opens, and nobody is told its
 * tool set is the one its history was produced under.
 *
 * The caveat is RETURNED rather than emitted because the fallback id can still
 * fail to mount — a default that is itself broken, or a roster that moved
 * between this read and the mount. Announcing "resumed under X" from here
 * would put that sentence in the transcript of a resume that then rolled back
 * and never ran under X at all, which is a worse lie than the silence it was
 * added to break. {@link mountAgentPreset} emits it only once `mount`
 * succeeds.
 * @param agentPresets - the preset roster seam.
 * @returns the preset id to mount, and the lines to report once it has.
 */
async function legacyPreset(
  agentPresets: AgentPresetsSeam,
): Promise<{ readonly id: string; readonly caveat: readonly string[] }> {
  try {
    const legacy = await agentPresets.resolve(LEGACY_SESSION_PRESET)
    if (legacy.broken === undefined) return { id: LEGACY_SESSION_PRESET, caveat: [] }
  } catch {
    // An unknown id and a broken composition are the same answer here: this
    // deployment cannot place the session on the preset its history matches.
  }
  const fallback = agentPresets.defaultId
  return {
    id: fallback,
    caveat: [
      paint(`· this session predates agent presets and no usable "${LEGACY_SESSION_PRESET}" preset is installed`, 'muted'),
      paint(`· resumed under ${escapeControls(fallback)}; its tools may differ from the ones its history was produced with`, 'muted'),
    ],
  }
}

/**
 * Offer the guided first run, while no agent is attached.
 *
 * Placed here rather than inside an attachment for the same reason
 * {@link chooseTarget} is: it runs in the gap where the window holds a
 * terminal and no session owns input, and it is a fact about the WINDOW's
 * environment — which provider routes exist — not about any session.
 *
 * The condition is Harness's own registry plus the selection this window
 * already holds, and nothing else — a launch that can send a turn never sees
 * this, and one that cannot opens on the flow that fixes it rather than a
 * composer that will fail. There is no first-run marker anywhere: the question
 * is re-asked from live state every launch, so configuring a provider and
 * choosing a model is the only thing that stops it appearing, and losing
 * either is enough to bring it back.
 * @param w - the window whose input routing the flow borrows.
 * @returns when the reader has left setup, whether or not anything changed.
 */
export async function offerSetup(w: Window): Promise<void> {
  const { ctx } = w
  // Resolved BEFORE dispatch changes, exactly as `chooseTarget` resolves the
  // session browser first: routing keys at an overlay stack that nothing has
  // pushed onto yet is a window in which keystrokes are silently dropped.
  const { runSetup, setupNeeded } = await import('./setup/index.ts')
  if (!setupNeeded(ctx, w.selection)) return
  w.setDispatch(key => { ctx.tuiSlots.activeOverlay?.handleKey(key) })
  try {
    await runSetup({
      ctx,
      commit: w.commit,
      version: w.version,
      selection: w.selection,
      onModelChanged: w.refreshModelInfo,
    })
  } finally {
    w.setDispatch(undefined)
  }
}

/**
 * Ask which session to open, while no agent is attached.
 *
 * Runs before the first attachment, and again whenever reopening one failed:
 * both are moments where the window holds a terminal and no session, and the
 * useful question is the same one. Nothing for the resume plan to refuse, since
 * there is no session to leave.
 *
 * It needs no keyboard of its own. The window's routing is already installed and
 * already redraws on `tui/render`, so pushing the overlay paints it and `ctrl-d`
 * still leaves.
 * @param w - the window whose input routing the browser borrows.
 * @returns the chosen session, or a fresh one when the reader dismissed it.
 */
export async function chooseTarget(w: Window): Promise<AttachTarget> {
  const { ctx } = w
  // Resolved BEFORE dispatch changes below: routing ordinary keys toward
  // `activeOverlay` before the module that creates it is ready would open a
  // window where delegated keystrokes are dropped. `ctrl-d` remains window-owned.
  const { browseSessions } = await import('./sessions/index.ts')
  w.setDispatch(key => { ctx.tuiSlots.activeOverlay?.handleKey(key) })
  try {
    const chosen = await browseSessions({
      ctx,
      currentSessionId: undefined,
      busy: () => false,
      activeWork: () => 0,
      workspace: w.startup.cwd,
    })
    return chosen === undefined ? { kind: 'new', afterDismissal: true } : { kind: 'resume', id: chosen }
  } finally {
    w.setDispatch(undefined)
  }
}

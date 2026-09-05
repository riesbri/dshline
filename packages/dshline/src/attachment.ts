/**
 * One attached session: an Agent, and everything projected from its log.
 *
 * The other half of the {@link Window} split. Every registration here is owned
 * by a {@link SessionScope} rather than by the plugin fiber, because all of it —
 * the slot views, the log projection, the spinner, the capability adapters —
 * describes THIS session and has to come down when the reader opens another.
 *
 * The scope comes down BEFORE the agent handle: a transcript listener still
 * subscribed while its own agent is torn down would project that teardown into
 * the transcript the reader is leaving.
 * @module dshline/attachment
 */

import { createUserMessage, type ImageBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-agent/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Empty type imports carry the Context merges this module reads but does not
// otherwise import from: the questions seam and the launcher's exit request. The
// command registry is imported for its parser as well as its merge, so this
// frontend decides what a command LINE is by the same rule the registry resolves
// one with.
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-cmdline'
// `plan/mode` is folded below from the `SessionEventMap` merge this carries. Not
// a peer dependency, because it does not have to be MOUNTED for this frontend to
// run — a profile without it simply never reports plan mode.
import type {} from '@deepseek-ai/dsh-plan-mode'
// Optional projection infrastructure and Todo's `SessionProjectionMap` merge.
// dsh-base mounts both, but custom profiles may omit either without stopping TUI.
import type {} from '@deepseek-ai/dsh-session-projection'
// Session titles are optional too: `/sessions` offers rename through the
// service only when the active profile mounts it.
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-tool-todo'
// The goal package publishes both of this frontend's goal authorities: the
// `goal` key of `SessionProjectionMap` (durable, read from the shared snapshot)
// and the `ctx.goals` service type (live activation, read below). Optional in
// the same way — a profile without it reports no goal at all.
import type { GoalActivation } from '@deepseek-ai/dsh-goal'
// `fs` is read optionally for path completion: a profile that mounts no filesystem
// offers none rather than failing, so this carries the type without a hard need.
import type {} from '@deepseek-ai/dsh-fs'
import type { Key, SubmitGesture } from '@dshline/renderer'
import { Composer, escapeControls, paint, SPINNER_INTERVAL_MS } from '@dshline/renderer'
import { CARD_DETAIL_CYCLE, ToolCards } from './cards.ts'
import { chooseDelivery } from './delivery.ts'
import { BUSY_ENTER_CHOICES, runEnterCommand } from './enter.ts'
import { modelPhaseAfter, primaryActivity } from './activity.ts'
import type { ModelPhase } from './activity.ts'
import { installApprovalAnswerer } from './approval.ts'
import { createCompletion } from './completion.ts'
import { historyLines, InputHistory } from './history.ts'
import { HistorySearch } from './history-search.ts'
import { createHistorySearchOverlay } from './history-search-overlay.ts'
import { applyHistorySearch, routeInputKey } from './input.ts'
import { isTranscriptEvent, readTranscript, resumeBanner } from './resume.ts'
import { createToolOutputOverlay } from './tool-output.ts'
import { listModelOptions, pickModel } from './model.ts'
import { installQuestionProvider } from './questions.ts'
import { LocalCommandRegistry } from './local-commands.ts'
import { runThemes, themeValues } from './themes/index.ts'
import type { LocalCommandChoice } from './local-commands.ts'
import { SessionScope } from './session-scope.ts'
import { planNew } from './sessions/plan.ts'
import type { AttachOutcome, AttachTarget } from './sessions/reopen.ts'
import { shouldClearDisplay } from './sessions/reopen.ts'
import { StreamBuffer } from './stream.ts'
import { effortLabel, pickReasoning, reasoningValues } from './reasoning.ts'
import { THINKING_VALUES, pickThinking, thinkingAcknowledgement, validThinkingArgument } from './thinking.ts'
import { createTimingView, TurnTimer } from './timing.ts'
import { planModeAfter } from './modes.ts'
import { commandEcho, commandLines, projectEvent } from './transcript.ts'
import { promptSelect } from './select.ts'
import { confirmPermissionSelection, permissionPicker } from './permission.ts'
import {
  cacheReadShare,
  formatCacheRead,
  formatUsage,
  resolveUsageMode,
  SessionUsage,
  usageBuckets,
  USAGE_MODES,
  usageInspection,
} from './usage.ts'
import { createUsageOverlay } from './usage-overlay.ts'
import { contextPreview, contextReading, ContextSurveyor, contextPressureTokens } from './context/model.ts'
import { createContextOverlay } from './context/overlay.ts'
import { compactionNote } from './context/compaction.ts'
import { bannerLines, composerGutter, composerInner, createComposerView, createStatusView } from './views.ts'
import type { Window } from './window.ts'
import { createHarnessWork } from './work/index.ts'
import { createWorkOverlay } from './work/overlay.ts'
import { activeWorkCount, workSummary } from './work/model.ts'
import { SessionProjectionObserver } from './projections/observer.ts'
import { goalReading } from './goals/model.ts'
import { todoReading, todoSummary } from './todos/model.ts'
import { createTodoOverlay } from './todos/overlay.ts'
import { SkillCatalog } from './skills/catalog.ts'
import { slashCandidates } from './skills/model.ts'
import { pendingUserInput } from './steering.ts'
import { ImageDrafts, encodeCommandImages, readImageDrafts } from './image-drafts.ts'

/** What `/timing` accepts, for completing its argument. */
const TIMING_VALUES: readonly LocalCommandChoice[] = [
  { value: 'on', note: 'Show the live turn timing panel' },
  { value: 'off', note: 'Hide the live turn timing panel' },
]

/** Bounds path resolution, file reads, validation, and durable image commit. */
const IMAGE_ADMISSION_TIMEOUT_MS = 30_000

/**
 * Safe presentation for filesystem errors raised while admitting a local draft.
 *
 * `FsError` messages may spell an absolute user path. A terminal message must
 * explain the recoverable condition without turning that transient path into
 * another disclosure channel; attachment-store failures retain their own
 * Harness-authored diagnostics.
 * @param error - an admission failure.
 * @returns a path-free filesystem message.
 */
function imageFilesystemFailure(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  switch (code) {
    case 'FS_NOT_FOUND': return 'image file no longer exists'
    case 'FS_NOT_REGULAR_FILE': return 'image path is not a regular file'
    case 'FS_TOO_LARGE': return 'image file exceeds this deployment\'s per-image limit'
    case 'IMAGE_BATCH_TOO_LARGE': return 'image batch exceeds this deployment\'s total limit'
    case 'FS_PERMISSION_DENIED':
    case 'FS_SANDBOX_DENIED': return 'image file cannot be read by this profile'
    default: return 'image file could not be read'
  }
}

/** Fixed status row every ordinary live-region composition ends with. */
const STATUS_LIVE_ROWS = 1

/** Minimum row that keeps an enabled timing panel persistently identifiable. */
const TIMING_LIVE_ROWS = 1

/**
 * Largest context entries `/context` resolves.
 *
 * A bound rather than the whole surface: the inspector scrolls within these, and
 * resolving every node of a long session would turn one keystroke into work
 * proportional to the conversation. Deep enough that the list still scrolls on a
 * tall terminal after the composition block above it.
 */
const CONTEXT_ENTRY_LIMIT = 32

/**
 * Budget for a slash command, so a command that never settles cannot wedge the
 * composer. Commands are local operations; a model turn is not one of them.
 */
const COMMAND_TIMEOUT_MS = 120_000

/**
 * Budget for the skill-catalog refresh a submitted `/name` may have to wait for.
 *
 * Far shorter than a command's, because nothing is being executed and nothing is
 * on screen while it runs: the Composer cleared on submit, no turn has started,
 * and the reader is looking at an empty prompt. What is being waited for is one
 * discovery pass — the shipped provider reads a handful of local directories,
 * and the registry answers a warm catalog without asking any provider at all, so
 * this deadline is only reached when discovery is already struggling. Upstream
 * states the caller owns that bound ("cancellation stops the caller's wait but
 * cannot terminate work an uncooperative provider keeps running") and publishes
 * no latency expectation to size it against.
 *
 * So it is set by what a person will sit through in front of a blank prompt
 * rather than by what a pathological provider might need, and a provider that
 * has not answered by then is exactly the "cannot be verified" case the
 * adjudication already has a truthful answer for.
 */
const SKILL_VERIFY_TIMEOUT_MS = 2_500

/**
 * Drive one session until the reader chooses the next attachment target.
 *
 * Everything registered here is owned by a {@link SessionScope} rather than by
 * the plugin fiber, because all of it — the slot views, the log projection, the
 * spinner, the capability adapters — describes THIS session. The scope comes
 * down before the agent handle does: a transcript listener still subscribed
 * while its own agent is torn down would print that teardown into the transcript
 * the reader is leaving.
 * @param w - the window this session is attached to.
 * @param outcome - the agent the loop opened, and the target it came from.
 * @returns the target to attach next, once the reader has asked for it.
 */
export async function attachSession(w: Window, outcome: AttachOutcome): Promise<AttachTarget> {
  const { ctx, terminal, exit, startup, pricing, peakHours, selection, prefs, draw, commit, clear } = w
  const { target, attached } = outcome
  const scope = new SessionScope()
  let imageAdmission: AbortController | undefined
  scope.own(() => {
    imageAdmission?.abort(new Error('Image attachment stopped because the session closed.'))
    imageAdmission = undefined
  })
  // Created before anything can ask for it: a transition requested while the
  // transcript is still replaying must not resolve into a promise that does not
  // exist yet.
  let requestNext: (target: AttachTarget) => void = () => {}
  const switched = new Promise<AttachTarget>(resolve => { requestNext = resolve })
  const { agent, dispose: disposeAgent } = attached.handle

  // Held until after the banner, so the transcript reads in the order it
  // happened rather than opening with a footnote. The window asked which session
  // to open and got no answer; silence would read as the request having been
  // ignored. A reopen that FAILED was already reported before the reader was
  // asked again, so there is nothing to repeat here.
  const resumeNote = target.kind === 'new' && target.afterDismissal === true
    ? [paint('· no session reopened; starting a new one', 'muted')]
    : []

  // A resumed session keeps the workspace it was created in: the header is the
  // authority, and resuming into the directory that happens to be current would
  // silently re-root the conversation.
  const workspace = agent.session.header.cwd ?? startup.cwd

  const composer = new Composer()
  const history = new InputHistory()
  // Jobs, subagents, and workflow runs are optional capability seams. This
  // projection listens through the parent-scoped subagent lifecycle, this
  // session's own durable workflow records, and re-reads authoritative service
  // snapshots; it neither starts work nor owns its output cursor.
  const work = createHarnessWork(ctx, agent, () => { ctx.tuiSlots.invalidate() })
  scope.own(() => { work.dispose() })
  // Reassigned once completion exists: a catalog change has to reach both the
  // frame and any menu already standing over it, and the menu is built below
  // out of this very catalog.
  let skillsChanged = (): void => { ctx.tuiSlots.invalidate() }
  // Always present, never lazy: the slash menu and the submit adjudication
  // both read it, and neither may wait for `/skills` to have been opened
  // once. Scoped to THIS agent — the viewing scope is what makes a preset's
  // own skills visible — and to the session's own workspace.
  const skills = new SkillCatalog({
    ctx,
    scope: agent,
    cwd: workspace,
    changed: () => { skillsChanged() },
  })
  scope.own(skills.install())
  // One generic observer belongs to this exact Session. Domain adapters read its
  // authoritative snapshots; it only coalesces redraws after Harness has driven.
  const projections = new SessionProjectionObserver({
    registry: ctx.get('sessionProjections'),
    session: agent.session,
    invalidate: () => { ctx.tuiSlots.invalidate() },
  })
  scope.own(() => { projections.dispose() })
  // The expensive half of context intelligence, and the reason it is a separate
  // object from the projection observer: `tokenMeter.measure()` prices and
  // clones every node of the current surface, which its own contract calls
  // O(surface). Nothing but an open `/context` may ask for it, and the surveyor
  // answers from its cache until a priced input — the surface or the route the
  // nodes are priced under — actually moves.
  const surveyor = new ContextSurveyor({
    meter: () => ctx.get('tokenMeter'),
    session: agent.session,
    limit: CONTEXT_ENTRY_LIMIT,
  })
  // Completion and the composer budget against the fixed views below them. The
  // timing row is conditional, but while enabled it must survive a tall paste or
  // suggestion list instead of being pushed beyond the physical screen.
  const persistentRowsBelow = (): number =>
    STATUS_LIVE_ROWS + (prefs.timing ? TIMING_LIVE_ROWS : 0)
  // Unsent images belong to this attachment, not the window or text composer:
  // reopening another session disposes the paths, while history and undo remain
  // honest text-only mechanisms. No bytes are read until an ordinary prompt is
  // actually sent.
  const imageDrafts = new ImageDrafts()
  // Read per paint rather than captured: both halves move while the frame
  // stands — the agent starts and stops a turn, and `/enter` rewrites the pref.
  const composerView = createComposerView(composer, workspace, persistentRowsBelow, () => ({
    busy: agent.status === 'running',
    busyEnter: prefs.busyEnter,
    ...imageDrafts.size === 0 ? {} : { images: imageDrafts.size },
  }))
  const stream = new StreamBuffer(prefs.reasoningVisible)
  // Scoped to the agent: a scoped tool shadows a global one, and a restricted-away
  // tool reads as absent, so the card must come from the definition that ran.
  const cards = new ToolCards(name => ctx.tools.get(name, agent), workspace)
  // Seeded from the window: `ctrl-o` is a reader preference, and reopening a
  // session should not silently re-expand cards they had folded away.
  cards.detail = prefs.cardDetail
  // A command's name arrives with `command/run` and its outcome with `command/done`,
  // so the two are paired by id exactly as a tool call is paired to its result —
  // `command/done` carries no name, and a bare `{ kind: 'success' }` has nothing
  // else to identify it by.
  const commandNames = new Map<string, string>()
  // How many command outcomes the projection has reported. `submit` reads it to
  // avoid reporting a failure the lifecycle already printed.
  let commandOutcomes = 0
  // Durable seqs whose own domain event this transcript has already presented.
  // A successful `command/done` names the `sourceEventSeq` that owns the richer
  // presentation, and honouring that is only safe for an event this frontend
  // actually projects — so the set is the evidence, not the field alone.
  const presentedSeqs = new Set<number>()
  let tick = 0
  // Measured from `turn/start`, so the `· turn` label agrees with the timing
  // panel's turn totals instead of including agent startup before the turn.
  let turnStartedAt: number | undefined
  // Cumulative for the session, folded from the log rather than counted here, so
  // the meter reports what the provider billed.
  const usage = new SessionUsage(pricing, peakHours)
  const timer = new TurnTimer()
  // The route the log says was in force, which is not necessarily the one
  // selected NOW: replay walks a history whose messages were produced by whatever
  // was selected then, and pricing them at today's model would bill a session's
  // whole past at whichever route it happens to end on.
  let requestRoute: { provider: string; model: string } | undefined
  // Folded rather than asked for, because the controller keeps no live mirror and
  // says so: UIs observe committed flips through `session/event`. Folding it in
  // the shared projection means a reopened session recovers it from the replay,
  // for the same reason the usage totals do.
  let planActive = false
  let phase: ModelPhase = 'waiting'
  // A resumed session's transcript is still being replayed into the window.
  // While set, the status line reports it instead of `ready` (the history the
  // reader asked to reopen is not on screen yet), and a submit is kept out of
  // the transcript: an enter at this moment must not interleave a new turn
  // ABOVE the historical flood that is about to land. The denied line is
  // parked in `replayNotes` and committed after the flood, in history order.
  let replaying: string | undefined
  const replayNotes: string[] = []

  // Deliberately NOT registered with `ctx.commands`. That registry is shared by
  // every surface in the process, and a web client or automation server has no
  // terminal to leave, picker to open, or status line to switch. The registry
  // still supplies these commands to completion, because `/` should show what a
  // person can type rather than which service happens to answer it.
  const startFreshSession = (command: 'new' | 'clear', rawInput: string): void => {
    if (rawInput.trim() !== '') {
      commit([paint(`\u2717 /${command} takes no argument`, 'error')])
      draw()
      return
    }
    // Both commands retire a live agent exactly like `/sessions` does, so they
    // must pass the same capability checks rather than tearing one down while
    // Harness has not defined the fate of its active work.
    const plan = planNew({
      busy: agent.status === 'running',
      activeWork: activeWorkCount(work.snapshot()),
    })
    if (plan.kind === 'refused') {
      commit([paint(plan.message, 'error')])
      draw()
      return
    }
    commit([paint('· starting a new session…', 'muted')])
    // `/clear` is `/new` plus one piece of presentation intent, carried on the
    // transition rather than executed here: the wipe belongs to the fresh
    // session and happens after create succeeds (`shouldClearDisplay`), so a
    // failed transition never destroys the transcript this attachment is
    // leaving. A plain `/new` keeps today's exact target shape.
    requestNext(command === 'clear'
      ? { kind: 'new', cwd: workspace, clearDisplay: true }
      : { kind: 'new', cwd: workspace })
    draw()
  }

  /**
   * Whether THIS agent has the registered Harness `/compact` command.
   *
   * Agent-scoped, like the `/permission` check below, because compaction is a
   * per-agent composition decision: dshline's bundle moves the backend behind
   * agent presets, and the shipped `minimal` preset composes none. A profile
   * without it must be offered no compaction control rather than one that fails.
   * @returns whether the command is available to this agent.
   */
  const compactRegistered = (): boolean =>
    ctx.commands.list(agent).some(command => command.name === 'compact')

  /**
   * Run the registered `/compact`, exactly as a typed line runs it.
   *
   * Deliberately `ctx.commands` and not `ctx.compaction`: the command owns
   * validation, the idle-agent lock, cancellation, the durable lifecycle, and
   * the persistence checkpoint, and calling the service directly would be a
   * second control path with none of that. Its outcome reaches the transcript
   * through the same `command/run`/`command/done` projection every other
   * command uses, so nothing is printed here.
   *
   * `/compact` does not declare image input, so it is dispatched with no
   * attachment envelope even when this session has staged image drafts.
   * @returns a message when the registry did not accept the line, else nothing.
   */
  const runCompactCommand = async (): Promise<string | undefined> => {
    const outcomesBefore = commandOutcomes
    let execution: Awaited<ReturnType<typeof ctx.commands.execute>>
    try {
      execution = await ctx.commands.execute(agent, '/compact', [], AbortSignal.timeout(COMMAND_TIMEOUT_MS))
    } catch (error: unknown) {
      // A handler that threw has already appended its own `command/done`, which
      // the projection has printed. Only a throw that never reached the
      // lifecycle still needs saying — the same rule the composer's submit uses.
      if (commandOutcomes === outcomesBefore) report(error)
      draw()
      return undefined
    }
    draw()
    // `undefined` means the registry did not resolve the name, which can only
    // happen if the composition changed between the offer and the keystroke.
    return execution === undefined ? 'This profile has no /compact command.' : undefined
  }

  /**
   * Apply a named status-display preference, reporting what it did.
   * @param picked - the word the reader typed or chose.
   */
  const applyUsageMode = (picked: string): void => {
    const chosen = resolveUsageMode(picked)
    if (chosen === undefined) {
      const offered = USAGE_MODES.map(mode => mode.id).join(', ')
      commit([paint(
        `\u2717 no usage setting named ${escapeControls(picked)}; try one of: ${offered}`,
        'error',
      )])
      draw()
      return
    }
    prefs.usageMode = chosen
    // Acknowledged by name, as `ctrl-o` is: switching a segment OFF removes the
    // only evidence the command did anything, so silence would read as failure.
    commit([paint(`\u00b7 usage: ${prefs.usageMode}`, 'muted')])
    draw()
  }

  /** Open the three-choice status-display picker, then report the outcome. */
  const chooseUsageDisplay = (): void => {
    promptSelect(ctx, {
      title: 'What the status line reports',
      view: 'Usage',
      detail: `current: ${prefs.usageMode}`,
      initialValue: prefs.usageMode,
      choices: USAGE_MODES.map(mode => ({
        value: mode.id,
        label: mode.name,
        description: mode.description,
      })),
    }).then(picked => {
      // Dismissed, so nothing changed and there is nothing to report.
      if (picked === undefined) draw()
      else applyUsageMode(picked)
    }).catch(report)
  }

  const localCommands = new LocalCommandRegistry([
    {
      name: 'image',
      description: 'Stage a raster image for the next prompt; @path stays a text mention',
      execute: (rawInput) => {
        // The active submission owns an immutable snapshot. Listing remains
        // useful while it runs, but changing drafts would make its eventual
        // acknowledgement ambiguous.
        if (imageAdmission !== undefined && rawInput.trim() !== '') {
          commit([paint('✗ images are being attached; staged images cannot change yet', 'error')])
          draw()
          return
        }
        if (rawInput.trim() === '--clear') {
          const count = imageDrafts.size
          imageDrafts.clear()
          commit([paint(count === 0 ? '· no images were staged' : `· cleared ${String(count)} staged ${count === 1 ? 'image' : 'images'}`, 'muted')])
          draw()
          return
        }
        const remove = /^\s*--remove\s+(\d+)\s*$/u.exec(rawInput)
        if (remove?.[1] !== undefined) {
          const removed = imageDrafts.remove(Number(remove[1]))
          commit([paint(removed === undefined
            ? '✗ no staged image has that number'
            : `· removed staged image ${escapeControls(removed.name)}`, removed === undefined ? 'error' : 'muted')])
          draw()
          return
        }
        if (rawInput.trim() === '') {
          const listed = imageDrafts.items.map((draft, index) => `${String(index + 1)}. ${escapeControls(draft.name)}`)
          commit(listed.length === 0
            ? [paint('· no images staged · /image path/to/image.png', 'muted')]
            : [paint(`· ${String(listed.length)} staged ${listed.length === 1 ? 'image' : 'images'} · /image --remove N · /image --clear`, 'muted'), ...listed])
          draw()
          return
        }
        const attachments = ctx.get('attachments')
        const fs = ctx.get('fs')
        if (attachments === undefined || fs === undefined) {
          commit([paint('✗ image attachment needs this profile\'s attachment and filesystem services', 'error')])
          draw()
          return
        }
        const result = imageDrafts.stage(rawInput, {
          maxImages: attachments.imageLimits.maxImagesPerMessage,
          mediaTypes: attachments.imageLimits.mediaTypes,
        })
        if (!result.ok) {
          const message = result.reason === 'duplicate'
            ? 'that image is already staged'
            : result.reason === 'too-many'
              ? `this deployment allows ${String(attachments.imageLimits.maxImagesPerMessage)} images per message`
              : result.reason === 'deployment-type'
                ? 'that image type is not accepted by this deployment'
            : result.reason === 'unsupported-type'
              ? 'only PNG, JPEG, WebP, and GIF images can be attached'
            : 'usage: /image path/to/image.png'
          commit([paint(`✗ ${message}`, 'error')])
          draw()
          return
        }
        commit([paint(`· staged image ${escapeControls(result.draft.name)} for the next prompt`, 'muted')])
        draw()
      },
    },
    {
      name: 'model',
      description: 'Choose the provider and model for the next turn',
      complete: async () => (await listModelOptions(ctx))
        .map(option => ({ value: option.model, note: option.provider })),
      execute: async rawInput => {
        const outcome = await pickModel(ctx, selection, rawInput)
        if (outcome !== undefined) {
          w.refreshModelInfo()
          commit([paint(`· ${outcome}`, 'muted')])
        }
        draw()
      },
    },
    {
      // Named `/timing`, not `/profile`: a Harness PROFILE is the composition
      // a launcher boots (`dsh --profile <name>`, browsed by `/profiles`), and
      // one word cannot mean both a per-turn stopwatch and that. This command
      // never had anything to do with profiles.
      name: 'timing',
      description: 'Show a live breakdown of the current or latest turn',
      complete: () => TIMING_VALUES,
      execute: rawInput => {
        const named = rawInput.trim().toLowerCase()
        if (named !== '' && named !== 'on' && named !== 'off') {
          commit([paint('\u2717 /timing takes on or off, or nothing to flip it', 'error')])
          draw()
          return
        }
        // Binary, so a bare gesture flips it rather than opening a list of two.
        prefs.timing = named === '' ? !prefs.timing : named === 'on'
        commit([paint(
          prefs.timing ? '· turn timer: on, in the live area' : '· turn timer: off',
          'muted',
        )])
        draw()
      },
    },
    {
      name: 'thinking',
      description: 'Show or hide model thinking in the terminal',
      complete: () => THINKING_VALUES,
      execute: async rawInput => {
        if (!validThinkingArgument(rawInput)) {
          commit([paint('\u2717 /thinking takes on or off, or nothing to choose visibility', 'error')])
          draw()
          return
        }
        const outcome = await pickThinking(ctx, prefs.reasoningVisible, rawInput, next => {
          prefs.reasoningVisible = next
          stream.setReasoningVisible(next)
        })
        if (outcome !== undefined) commit([paint(thinkingAcknowledgement(outcome), 'muted')])
        draw()
      },
    },
    {
      name: 'reasoning',
      description: 'Set how hard the model thinks, for the next turn',
      complete: () => reasoningValues(w.modelInfo.reasoning),
      execute: async rawInput => {
        // The levels are a short fixed set a person learns by heart, so
        // `/reasoning max` should not cost a picker.
        const outcome = await pickReasoning(ctx, selection, w.modelInfo.reasoning, rawInput)
        if (outcome !== undefined) commit([paint(`· ${outcome}`, 'muted')])
        draw()
      },
    },
    {
      name: 'usage',
      description: 'Inspect what this session has consumed, and set what the status line shows',
      complete: () => USAGE_MODES.map(mode => ({ value: mode.id, note: mode.description })),
      execute: rawInput => {
        // A named argument is the form that should not cost an overlay, and it
        // stays exactly as fast as it was. Bare `/usage` now answers the question
        // the command's name asks — what has this session consumed — instead of
        // opening a three-row menu in front of it. Both paths meet at one
        // resolve, so a typed word and a chosen row cannot drift.
        const named = rawInput.trim()
        if (named !== '') {
          applyUsageMode(named)
          return
        }
        // A bounded live-region overlay like Work and Todos: it disappears on
        // close and never rewrites the transcript underneath it.
        let dismiss = (): void => {}
        const overlay = createUsageOverlay({
          inspection: () => usageInspection(projections.snapshot(), usage.reading),
          mode: () => prefs.usageMode,
          chooseDisplay: () => { chooseUsageDisplay() },
          close: () => dismiss(),
        })
        dismiss = ctx.tuiSlots.pushOverlay(overlay)
      },
    },
    {
      name: 'context',
      description: "Inspect what is occupying the model's context right now",
      execute: () => {
        // Temporary live-region chrome, like Work: the committed transcript
        // under it is never rewritten, and closing leaves scrollback intact.
        let dismiss = (): void => {}
        const overlay = createContextOverlay({
          reading: () => contextReading(projections.snapshot()),
          survey: () => surveyor.read(),
          preview: seq => contextPreview(agent.session, seq),
          // The SELECTED route's window, which is what the next request will be
          // measured against; the projection's own last-recorded capacity is the
          // fallback for a session whose route metadata never resolved.
          capacity: () => w.modelInfo.contextWindow,
          // Offered only when this agent really has the registered command, so
          // the footer never advertises a key that cannot work.
          ...compactRegistered() ? { compact: runCompactCommand } : {},
          close: () => dismiss(),
          invalidate: () => { ctx.tuiSlots.invalidate() },
        })
        dismiss = ctx.tuiSlots.pushOverlay(overlay)
      },
    },
    {
      // Named for the key, unlike every other command here, because the key IS
      // the subject: the question a reader has is "what does enter do right
      // now", and `/submit` or `/keys` would answer a broader one this sets
      // nothing about. The description carries the whole scope, because `/enter`
      // must not read as changing enter everywhere.
      name: 'enter',
      description: 'Choose what plain enter does while a turn is running',
      complete: () => BUSY_ENTER_CHOICES.map(choice => ({ value: choice.value, note: choice.description })),
      execute: async rawInput => {
        await runEnterCommand({
          current: () => prefs.busyEnter,
          // The window owns it, not the session: reopening one must not put the
          // reader's input preference back, for the same reason it must not put
          // the palette or the usage meter back.
          apply: next => { prefs.busyEnter = next },
          commit,
          choose: current => promptSelect(ctx, {
            title: 'What plain enter does while a turn is running',
            view: 'enter',
            choices: BUSY_ENTER_CHOICES.map(choice => ({ ...choice })),
            initialValue: current,
          }),
          remember: value => w.busyEnterSettings.save(value),
        }, rawInput)
        draw()
      },
    },
    {
      name: 'theme',
      description: 'Choose the colour palette this window draws with',
      complete: () => themeValues(),
      execute: async rawInput => {
        await runThemes({
          ctx,
          current: () => w.palette(),
          depth: w.colorDepth,
          // The window owns the palette, not the session: reopening one must
          // not put the reader’s colours back, for the same reason it must not
          // put the usage meter back to cost.
          apply: next => { w.setPalette(next) },
          commit,
          remember: id => w.themeSettings.save(id),
        }, rawInput)
        draw()
      },
    },
    {
      name: 'work',
      description: 'Inspect active Harness workflows, subagents, and jobs',
      execute: () => {
        // Like the tool inspector, Work is temporary live-region chrome. It
        // disappears on close and never rewrites the transcript it covered.
        let dismiss = (): void => {}
        const overlay = createWorkOverlay({
          snapshot: () => work.snapshot(),
          interrupt: item => work.interrupt(item),
          close: () => dismiss(),
          invalidate: () => { ctx.tuiSlots.invalidate() },
        })
        dismiss = ctx.tuiSlots.pushOverlay(overlay)
      },
    },
    {
      name: 'todos',
      description: 'Inspect the current Harness todo list',
      execute: () => {
        // Opening a temporary terminal overlay is frontend-local, not a
        // Harness-wide command or any Todo-domain mutation.
        let dismiss = (): void => {}
        const overlay = createTodoOverlay({
          reading: () => todoReading(projections.snapshot()),
          close: () => dismiss(),
        })
        dismiss = ctx.tuiSlots.pushOverlay(overlay)
      },
    },
    {
      name: 'setup',
      description: 'Check this installation and walk from a provider to a working model',
      execute: async () => {
        // Window-level, like `/connect` and `/profiles`: nothing it does is a
        // fact about this session. It is opened from here for the reason every
        // picker is — the attachment owns the keyboard while a session is up —
        // and the route it may end on is read by the NEXT step's selection.
        //
        // Imported on demand, like the browsers below: its module graph pulls
        // in the profile reader and the whole Connect catalog, which is startup
        // a launch that already has a model should not pay for.
        const { runSetup } = await import('./setup/index.ts')
        await runSetup({
          ctx,
          commit,
          version: w.version,
          selection,
          onModelChanged: () => { w.refreshModelInfo() },
        })
        draw()
      },
    },
    {
      name: 'connect',
      description: 'Configure and authenticate Harness providers',
      // Imported on demand, like `/plugins`, `/profiles`, and `/skills` below:
      // the browser's module graph (catalog, authorization presentation,
      // actions, overlay, schema interpretation, route editor) is one
      // command's UI, and startup cost a profile that never opens `/connect`
      // should not pay.
      complete: async () => {
        const { listConnectTargets } = await import('./connect/index.ts')
        return listConnectTargets(ctx)
      },
      execute: async rawInput => {
        // Configuration is a window-level concern, not a session one, but it is
        // opened from here for the same reason every other picker is: the
        // attachment owns the keyboard while a session is up. Nothing it does
        // touches this session — a route it activates is read by the NEXT step's
        // model selection, which is what `/model` then offers.
        const { openConnect } = await import('./connect/index.ts')
        await openConnect({ ctx, commit, query: rawInput.trim() })
        draw()
      },
    },
    {
      name: 'plugins',
      description: "Browse and customize the running agent's Harness preset composition",
      execute: async () => {
        // Per-agent, unlike Connect: a toggled row, a copied preset, or a
        // recomposed session are all facts about THIS agent's composition,
        // not the window. `agent.ctx` and `agent.session` are exactly the
        // two Harness surfaces this browser reads and writes through.
        //
        // Imported on demand: the browser is one command's UI, and its module
        // graph (the roster reader, the actions, the YAML composition parser)
        // is startup cost a profile that never opens `/plugins` should not pay.
        const { openPlugins } = await import('./plugins/index.ts')
        await openPlugins({
          ctx,
          agent,
          commit,
          // Re-parenting this agent's scope changes which layers a scope-aware
          // registry merges for it, and emits no registry mutation of its own —
          // so the authoritative skill view has to be re-read on the way out
          // rather than waited for.
          recomposed: () => { skills.invalidate() },
        })
        draw()
      },
    },
    {
      name: 'skills',
      description: 'Browse the skills available to the running agent',
      // Local, like every other browser here, and therefore also a shadow over
      // any skill or upstream command that ever takes this name — local
      // dispatch wins first. Harness ships no `/skills` command today; if one
      // appears, the collision needs a deliberate resolution rather than a
      // silent local shadow, exactly as `/clear` above records.
      execute: async () => {
        // An inspector and a Composer launcher, never an executor: Harness
        // owns skill loading and decides what a `/name` line means at its own
        // pre-step boundary. Nothing here reads a skill body.
        //
        // Imported on demand, as `/plugins` is: the browser is one command's
        // UI, while the catalog it reads is already alive above — the slash
        // menu and the submit adjudication need that whether or not this
        // command is ever typed.
        const { openSkills } = await import('./skills/index.ts')
        const picked = await openSkills({
          ctx,
          catalog: skills,
          commandNames: () => [
            ...localCommands.list().map(command => command.name),
            ...ctx.commands.list(agent).map(command => command.name),
          ],
        })
        if (picked !== undefined) {
          // The literal a person could have typed, and nothing else: no
          // submission, no turn, cursor after the space. What that line means
          // is Harness's decision when it is actually sent.
          composer.set(`/${picked} `)
          // The buffer was replaced wholesale, exactly as a recalled history
          // entry replaces it, so a lookup still in flight must not land its
          // candidates over text that is no longer being typed.
          completion.invalidate()
        }
        draw()
      },
    },
    {
      name: 'profiles',
      description: "Browse Harness profiles and the bundles each one composes",
      execute: async () => {
        // Window-level, unlike `/plugins`: a profile composes the HOST, so
        // nothing here is a fact about this agent. It takes `ctx` only, and
        // every change it makes lands on the next boot rather than on this
        // session.
        //
        // Imported on demand for the same reason as `/plugins`: the launcher
        // resolver and the pnpm/YAML readers belong to the command, not to a
        // boot that may never invoke it.
        const { openProfiles } = await import('./profiles/index.ts')
        await openProfiles({ ctx, commit })
        draw()
      },
    },
    {
      name: 'sessions',
      description: 'Browse, search, and reopen past Harness sessions',
      execute: async () => {
        // The browser is temporary live-region chrome like Work and the tool
        // inspector; the committed transcript under it is never rewritten.
        // Reopening is the one thing it can do that outlives it, and the plan
        // that authorizes it reads the conditions at the moment enter is pressed.
        //
        // Imported on demand, like `/plugins`, `/profiles`, and `/connect`
        // above: the browser's module graph (catalog, overlay, panels,
        // lineage) is one command's UI, and `busy`/`activeWork` below are
        // passed as live functions, so the plan below still decides against
        // the conditions AT THE MOMENT the reader chooses a session, not at
        // import time.
        const { browseSessions } = await import('./sessions/index.ts')
        const chosen = await browseSessions({
          ctx,
          currentSessionId: agent.session.id,
          busy: () => agent.status === 'running',
          activeWork: () => activeWorkCount(work.snapshot()),
          // Supplied only when the title service is mounted, so a profile
          // without it omits the action rather than failing when it is used.
          ...(ctx.get('sessionTitle') === undefined
            ? {}
            : {
              renameTitle: async title => {
                const svc = ctx.get('sessionTitle')
                if (svc === undefined) {
                  return { ok: false, message: 'This profile mounts no session-title service.' }
                }
                try {
                  const snapshot = svc.rename(agent.session, title)
                  return { ok: true, title: snapshot.title }
                } catch (error: unknown) {
                  return { ok: false, message: error instanceof Error ? error.message : String(error) }
                }
              },
            }),
          workspace,
        })
        if (chosen !== undefined) requestNext({ kind: 'resume', id: chosen })
        draw()
      },
    },
    {
      name: 'new',
      description: 'Start a fresh session in the current workspace',
      execute: rawInput => { startFreshSession('new', rawInput) },
    },
    {
      name: 'clear',
      description: 'Wipe the screen and start a fresh session in the current workspace',
      // Deliberately local although Harness reserves `clear` as start-source
      // vocabulary (`SessionStartSource`): upstream ships no `/clear` command
      // today, and local dispatch wins before `ctx.commands` anyway. If one
      // ever appears, the collision needs a deliberate resolution, not a
      // silent local shadow.
      execute: rawInput => { startFreshSession('clear', rawInput) },
    },
    {
      name: 'exit',
      description: 'Leave the session, as ctrl-d does',
      execute: () => { exit?.(0) },
    },
    {
      name: 'quit',
      description: 'Leave the session, as ctrl-d does',
      execute: () => { exit?.(0) },
    },
  ])

  // Completion reads the harness through two narrow functions rather than taking a
  // context, so its rules are testable without one. `ctx.fs` is optional: a profile
  // that mounts no filesystem offers no path completion rather than failing.
  const completion = createCompletion(composer, {
    // The frontend's own gestures listed beside the registry's, so `/` shows what
    // can be typed rather than what happens to be registered — and beside the
    // skills a leading `/name` actually reaches, which is the same offer
    // Harness's own Web menu makes. A command wins a shared name and the skill
    // row is dropped rather than shown twice: the submit path resolves the
    // command first, so listing both would promise a gesture one of them never
    // receives.
    commands: () => slashCandidates(
      [...localCommands.list(), ...ctx.commands.list(agent)],
      skills.skills(),
    ),
    // Only this frontend's own commands offer values. A registered command
    // describes its argument as a free-text hint rather than as a list, so there
    // is nothing to enumerate, and inventing candidates for one would suggest a
    // vocabulary the handler never agreed to.
    commandArguments: name => localCommands.arguments(name),
    paths: async directory => {
      const fs = ctx.get('fs')
      if (fs === undefined) return []
      try {
        const target = await fs.resolve(directory === '' ? '.' : directory, { cwd: workspace })
        return (await fs.listDir(target)).map(entry => ({
          name: entry.name,
          directory: entry.type === 'directory',
        }))
      } catch {
        // A path that does not resolve, or a directory the policy refuses, simply
        // offers nothing: a completion list is not the place to report either.
        return []
      }
    },
  }, () => { ctx.tuiSlots.invalidate() }, persistentRowsBelow)

  // A catalog change has to reach a menu that is already standing, not only
  // the next frame: the offer was computed when the token was typed, and
  // recomputing it through completion's own generation guard is what keeps a
  // superseded lookup from reviving over it.
  skillsChanged = (): void => {
    ctx.tuiSlots.invalidate()
    if (completion.active) completion.refresh().then(draw).catch(report)
  }

  /**
   * Live, process-local continuation activation for this agent's goal.
   *
   * The only thing this frontend asks the goal service for. Every durable field
   * — objective, phase, blocked reason, round count, round cap, revision,
   * timestamps — comes from the `goal` projection in the frame's shared
   * snapshot instead, because Harness publishes those generically and the
   * service is not their presentation authority. Activation is the one fact no
   * replay can reconstruct: it is process-local, never persisted, and
   * `disarm()` changes it with no `goal/change` event, no revision, and no
   * `goal/changed` notification. So it is read live on the frame that needs it
   * and never cached.
   *
   * `get()` is the whole read because alpha.5 publishes no activation-only
   * accessor; it resolves its own durable half through
   * `sessionProjections.stateOf(session, 'goal')` before combining it with the
   * process-local runtime state. That inner read is the service's, not a second
   * dshline snapshot, and `.activation` is the only field taken from what it
   * returns.
   * @returns the activation, or undefined when it cannot be obtained.
   */
  const goalActivation = (): GoalActivation | undefined => {
    try {
      return ctx.get('goals')?.get(agent)?.activation
    } catch {
      // An activation that cannot be read is not `armed`. A refusal here — no
      // live agent, a failed goal replay — leaves the durable projection to
      // report the goal as idle rather than claiming this process will continue
      // it, and never takes the whole status line down with it.
      return undefined
    }
  }

  const status = createStatusView(() => {
    // One direct projection snapshot per frame, shared by every consumer below.
    // The registry validates each unit's view on the way out, so reading it
    // twice would pay for that twice on a line redrawn by every spinner beat.
    const projected = projections.snapshot()
    return {
      busy: agent.status === 'running',
      tick,
      elapsedMs: turnStartedAt === undefined ? undefined : Date.now() - turnStartedAt,
      activityWord: primaryActivity(phase, cards.semanticActivity()),
      activity: cards.inFlight(),
      model: selection.current?.model,
      effort: effortLabel(selection.current?.reasoningEffort, w.modelInfo.reasoning),
      usage: formatUsage(usage.reading, prefs.usageMode),
      // Read from the SAME snapshot as the context reading below it, through the
      // buckets `/usage` reports: Harness's `tokenUsage` is the authority, and
      // dshline divides two of its numbers rather than measuring anything. It is
      // NOT a share of the `usage` totals above it — those are the pricing fold,
      // which observes finalized messages only — so the two are reported side by
      // side and never divided into each other.
      cacheRead: formatCacheRead(cacheReadShare(usageBuckets(projected)), prefs.usageMode),
      // The O(1) `contextPressure` projection, NOT `tokenMeter.measure()`. The
      // status line needs one number; `measure()` prices and clones every node of
      // the current surface to produce it, and this line is redrawn on every
      // spinner beat, every streamed delta, and every tool transition — so the
      // old reading did O(surface) work per frame for a figure the projection
      // already maintains. It is also the better number: prompt-side only, so it
      // holds still while a reply streams, and provider-anchored rather than
      // wholly heuristic.
      tokens: contextPressureTokens(contextReading(projected)),
      contextWindow: w.modelInfo.contextWindow,
      detail: cards.detail,
      work: workSummary(work.snapshot()),
      pending: pendingUserInput(agent.inbox),
      todo: todoSummary(todoReading(projected)),
      plan: planActive,
      replay: replaying,
      // Two authorities, joined in the adapter and nowhere else: the durable
      // goal comes out of the same cut as Todo and the context reading, adding
      // no further dshline snapshot, and the service is consulted — lazily,
      // only for an active projected goal — for process-local activation alone.
      goal: goalReading(projected, goalActivation),
    }
  })
  const streamView = { render: (columns: number): string[] => stream.live(columns) }
  const timingView = createTimingView(timer, () => prefs.timing, () => tick)

  scope.own(ctx.tuiSlots.register('stream', streamView))
  scope.own(ctx.tuiSlots.register('status', status))
  scope.own(ctx.tuiSlots.register('composer', composerView))
  scope.own(ctx.tuiSlots.register('completion', completion.view))
  scope.own(ctx.tuiSlots.register('timing', timingView))
  scope.own(installApprovalAnswerer(ctx, () => agent, w.bell))
  scope.own(installQuestionProvider(ctx, w.bell))

  /**
   * Report a failure in the transcript instead of discarding it. A rejected
   * submit is otherwise invisible: the composer clears, nothing happens, and
   * there is no message anywhere to explain why.
   * @param error - the thrown value.
   */
  const report = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    commit([paint(`\u2717 ${escapeControls(message)}`, 'error')])
    draw()
  }

  /**
   * Everything one committed event contributes to the transcript.
   *
   * Shared by the live listener and the resume replay, which is the point: a
   * replayed session has to read exactly like the one that was watched happen, and
   * two projections would drift the first time either changed. The live path
   * commits each return immediately; the replay concatenates them and commits once.
   * @param event - the committed event.
   * @param columns - the terminal's current width.
   * @returns lines to write into scrollback.
   */
  const project = (event: SessionEvent, columns: number): string[] => {
    if (event.type === 'assistant/chunk') {
      const { chunk } = event.data
      // Reasoning is streamed as well as answered text. Dropping it left the
      // screen showing nothing but a spinner for as long as a reasoning model
      // thought, which reads as a hung process rather than a working one.
      if (chunk.type === 'text-delta') return stream.push('text', chunk.text, columns)
      if (chunk.type === 'reasoning-delta') return stream.push('reasoning', chunk.text, columns)
      return []
    }
    // Logged only when the route or its capacity changes, and always before the
    // requests it applies to — so following it here attributes each message's
    // usage to the model that actually produced it, on the live path and on the
    // replay alike.
    if (event.type === 'request/context') {
      requestRoute = { provider: event.data.provider, model: event.data.model }
    }
    planActive = planModeAfter(planActive, event)
    const lines: string[] = []
    if (event.type === 'assistant/message') {
      // Usage is folded HERE, in the projection both paths share, rather than in
      // the live listener: a resumed session replays its `assistant/message`
      // events through this function, so its totals come back on their own. A
      // separate restore path is exactly the second implementation that rule
      // about commands exists to avoid.
      //
      // A compaction REPLACEMENT copy is filtered out of the replay by design, so
      // a session compacted in an earlier run recovers the usage of what it can
      // still show. That is the same history the transcript displays; the two
      // agree, which matters more here than a total nothing on screen accounts for.
      const reported = event.data.usage
      if (reported !== undefined) {
        const route = requestRoute ?? selection.current
        // Priced by the event's OWN timestamp, not by the clock now. Peak and
        // off-peak rates differ by half, so a replayed session priced at the
        // moment it was reopened would bill a night's work at the morning rate.
        usage.observe(reported, route?.provider, route?.model, event.time)
      }
      // The buffer owns assistant output on both paths, so it decides what the
      // assembled message still has to contribute — the unfinished last line
      // after a streamed reply, or all of it from a provider that never streams.
      lines.push(...stream.settle(event.data.message.content, columns))
      stream.reset()
    }
    // An aborted turn can close without an `assistant/message`: the loop may
    // throw on the abort before appending one. (A cancelled turn WITH visible
    // content finalizes an `interrupted: true` message instead, which the
    // branch above settles and resets.) Committing here is what keeps a reply
    // interrupted with ctrl-c in the transcript when no assembled message
    // followed, instead of vanishing from the live region at the moment it
    // was cancelled.
    if (event.type === 'turn/end') {
      lines.push(...stream.finish(columns))
      stream.reset()
      cards.reset()
    }
    // Projected here rather than written when the line is submitted, so a resumed
    // session shows its commands too: both lifecycle events are log-only, which
    // means they survive in the log and pass the replay filter, and this is the one
    // path the live listener and the replay share.
    if (event.type === 'command/run') {
      const { commandId, name: command, args } = event.data
      commandNames.set(commandId, command)
      return commandEcho(command, args, columns)
    }
    if (event.type === 'command/done') {
      const { commandId, kind, text } = event.data
      const command = commandNames.get(commandId)
      commandNames.delete(commandId)
      commandOutcomes += 1
      // `sourceEventSeq` marks a result whose own domain event owns a richer
      // presentation. It is honoured only for an event this transcript has
      // ACTUALLY shown: the field alone would let a command go silent because
      // some event exists somewhere, which is how `/compact` would have printed
      // nothing at all before compaction had a projection of its own.
      const presented = event.data.sourceEventSeq
      if (kind === 'success' && presented !== undefined && presentedSeqs.has(presented)) return []
      return commandLines({ kind, ...text === undefined ? {} : { text } }, command, columns)
    }
    // Compaction is projected from its own durable events rather than from the
    // command result's prose: the facts are structured there, and an AUTOMATIC
    // compaction has no command lifecycle at all. See ./context/compaction.ts.
    const compaction = compactionNote(event, columns)
    if (compaction.lines.length > 0) {
      if (compaction.presentedSeq !== undefined) presentedSeqs.add(compaction.presentedSeq)
      return [...compaction.lines]
    }
    if (event.type === 'tool/call') return cards.call(event.data, columns)
    if (event.type === 'tool/result') {
      const block = event.data.message.content[0]
      return cards.result({
        callId: block.toolCallId,
        content: block.content,
        isError: block.isError === true,
        ...event.data.meta === undefined ? {} : { meta: event.data.meta },
        ...event.data.error === undefined ? {} : { error: event.data.error },
      }, columns)
    }
    lines.push(...projectEvent(event, columns))
    return lines
  }

  // `Inbox.splice` in @deepseek-ai/dsh-agent/inbox and the
  // `agent/inbox/spliced` declaration in @deepseek-ai/dsh-agent/types both say
  // the durable event commits before the live projection mutates, so this
  // synchronous observer sees the pre-splice lists. It only requests a redraw:
  // RedrawScheduler paints in the check phase after the event-loop turn settles,
  // and the status getter then reads the current `agent.inbox` projection directly.
  scope.own(ctx.on('session/event', (session, event: SessionEvent) => {
    if (session !== agent.session) return
    const columns = terminal.columns()
    // Always fold the live feed. Gating observation on the preference made an
    // enable during a turn either blank or partial; the preference owns only
    // presentation, and a fresh attachment still starts without invented data.
    timer.observe(event)
    if (event.type === 'turn/start') turnStartedAt = event.time
    if (event.type === 'turn/end') turnStartedAt = undefined
    // A tool call starts executing the moment the model's request settles, so a
    // phase captured before the first pending invocation is stale: when that
    // call drains, `waiting` is the truth unless stream activity arrived while
    // it ran.
    if (event.type === 'tool/call' && cards.inFlight() === undefined) phase = 'waiting'
    phase = modelPhaseAfter(phase, event)
    commit(project(event, columns))
    // Fed from the LIVE feed and not from `project`, which the replay also runs:
    // the replay carries no `assistant/chunk` events — they are the streamed form
    // of a message the log also stores assembled — so a timer behind it would
    // measure every reopened turn as though the model had thought for no time.
    draw()
  }))

  let ticker: NodeJS.Timeout | undefined
  const stopTicker = (): void => {
    if (ticker === undefined) return
    clearInterval(ticker)
    ticker = undefined
  }
  scope.own(stopTicker)
  scope.own(ctx.on('agent/status', payload => {
    if (payload.agent !== agent) return
    if (payload.status === 'running') {
      // Unref so a spinning timer never keeps the process alive on its own.
      ticker ??= setInterval(() => {
        tick += 1
        draw()
      }, SPINNER_INTERVAL_MS).unref()
    } else {
      stopTicker()
      turnStartedAt = undefined
    }
    draw()
  }))

  /**
   * Handle one submitted line: a local gesture, a registered command, or a
   * prompt for the model.
   * @param text - the submitted line.
   */
  const submit = async (text: string, gesture: SubmitGesture = 'enter'): Promise<void> => {
    const line = text.trim()
    // The composer has already cleared a submitted buffer. Stop here rather than
    // turning spaces or pasted blank lines into an empty model message.
    if (line === '') return
    // This is the reader's choice at the instant of submission. Image admission
    // can wait on storage; its completion must not reinterpret the same key
    // against a later turn state or preference.
    const submittedDelivery = chooseDelivery({
      running: agent.status === 'running',
      preference: prefs.busyEnter,
      gesture,
    })
    // Parsed once, up front: the local gestures and the unknown-command guard below
    // have to agree on what a command line is, and the registry's parser is the
    // authority on that. A second rule written here would drift from it.
    const parsed = parseCommand(line)
    // Local gestures have always entered the window's transient history. They
    // cannot wait for a permission picker that they do not own, so preserve that
    // behavior before the registered-command decoration below.
    if (parsed !== undefined && localCommands.get(parsed.name) !== undefined) {
      history.record(line)
      await localCommands.execute(parsed.name, parsed.rawInput)
      return
    }
    // Record the human's non-local submission before a presentation decoration
    // can cancel. Harness later records its actual argued command lifecycle; a
    // resumed session cannot distinguish that from a directly typed argument.
    history.record(line)
    // Harness owns `/permission`; this is only a terminal presentation for its
    // bare form. Keeping it outside the local registry leaves discovery,
    // completion, validation, and lifecycle events with the registered command.
    let commandLine = line
    if (
      parsed?.name === 'permission' &&
      parsed.rawInput.trim() === '' &&
      ctx.commands.list(agent).some(command => command.name === 'permission')
    ) {
      const picker = permissionPicker(projections.snapshot()?.values.permissions)
      if (picker !== undefined && picker.choices.length > 0) {
        const picked = await promptSelect(ctx, {
          title: 'Permissions',
          view: 'Permissions',
          detail: picker.detail,
          ...picker.currentValue === undefined ? {} : { initialValue: picker.currentValue },
          choices: picker.choices,
        })
        if (
          picked === undefined ||
          picked === picker.currentValue ||
          !await confirmPermissionSelection(ctx, picked)
        ) {
          draw()
          return
        }
        commandLine = `/permission ${picked}`
      }
    }
    // A registered command runs without a model turn, and its `command/run` and
    // `command/done` events are what the transcript shows — projected above, so the
    // live session and a resumed one read identically. Nothing is committed here.
    //
    // `sourceEventSeq` marks a result whose own domain event carries a richer
    // presentation, and is deliberately NOT honoured as a reason to stay silent:
    // this frontend projects no domain events, so deferring to one would keep the
    // command invisible.
    const registeredCommand = parsed === undefined
      ? undefined
      : ctx.commands.list(agent).find(command => command.name === parsed.name)
    if (imageDrafts.size > 0 && registeredCommand !== undefined && registeredCommand.input?.images !== true) {
      commit([paint(`✗ /${parsed?.name ?? 'command'} does not accept image attachments; drafts were kept`, 'error')])
      draw()
      return
    }
    const outcomesBefore = commandOutcomes
    let execution: Awaited<ReturnType<typeof ctx.commands.execute>>
    let admission: AbortController | undefined
    try {
      let commandImages: Parameters<typeof ctx.commands.execute>[2] = []
      if (imageDrafts.size > 0 && registeredCommand?.input?.images === true) {
        const attachments = ctx.get('attachments')
        const fs = ctx.get('fs')
        if (attachments === undefined || fs === undefined) {
          commit([paint('✗ image attachment became unavailable; drafts were kept', 'error')])
          draw()
          return
        }
        if (imageAdmission !== undefined) {
          commit([paint('· images are still being attached; nothing else was sent', 'muted')])
          draw()
          return
        }
        admission = new AbortController()
        imageAdmission = admission
        // The mutable draft collection remains visible for listing, but this
        // command owns precisely the paths present when its admission began.
        const batch = imageDrafts.items
        let inputs
        try {
          inputs = await readImageDrafts(
            batch,
            fs,
            workspace,
            attachments.imageLimits.maxImageBytes,
            attachments.imageLimits.maxMessageImageBytes,
            AbortSignal.any([admission.signal, AbortSignal.timeout(IMAGE_ADMISSION_TIMEOUT_MS)]),
          )
        } catch (error: unknown) {
          if (scope.closed) return
          if (composer.isEmpty) composer.set(line)
          if (admission.signal.aborted) {
            commit([paint('· image attachment cancelled; drafts were kept', 'muted')])
          } else {
            commit([paint(`✗ ${imageFilesystemFailure(error)}; drafts were kept`, 'error')])
          }
          draw()
          return
        }
        if (scope.closed) return
        commandImages = encodeCommandImages(inputs)
      }
      execution = await ctx.commands.execute(
        agent,
        commandLine,
        commandImages,
        admission === undefined
          ? AbortSignal.timeout(COMMAND_TIMEOUT_MS)
          : AbortSignal.any([admission.signal, AbortSignal.timeout(COMMAND_TIMEOUT_MS)]),
      )
    } catch (error: unknown) {
      if (scope.closed) return
      if (imageDrafts.size > 0 && composer.isEmpty) composer.set(line)
      // A handler that THREW has already appended `command/done` with its failure,
      // and that event has just been projected — so reporting the same throw here
      // would print it twice. Only a throw that never reached the lifecycle (an
      // already-aborted signal, a failed `command/run` append) still needs saying.
      if (commandOutcomes === outcomesBefore) {
        report(error)
      }
      draw()
      return
    } finally {
      if (admission !== undefined && imageAdmission === admission) imageAdmission = undefined
    }
    if (execution !== undefined) {
      if (scope.closed) return
      if (execution.result.kind === 'success') imageDrafts.clear()
      else if (imageDrafts.size > 0 && composer.isEmpty) composer.set(line)
      draw()
      return
    }
    // `undefined` means the registry resolved nothing, which is now three
    // different lines rather than two. A name the SKILL catalog knows is
    // Harness's own human gesture — the literal `/name …` its pre-step
    // boundary recognizes — and eating it here is exactly the bug this
    // adjudication fixes: the line has to reach the Agent unchanged. A name
    // nothing knows is still a typo, and sending it on would spend a whole
    // turn having the model answer `/help` as though it were a question.
    //
    // Only the LEADING token is adjudicated, and only the one the command
    // parser already claimed: the parser requires the name to end the line or
    // be followed by whitespace, so `/etc/hosts is missing` is a sentence and
    // `please /review-pr this` is a message whose gesture belongs entirely to
    // Harness. dshline writes no second grammar over human text.
    if (parsed !== undefined) {
      const verdict = await skills.verify(parsed.name, AbortSignal.timeout(SKILL_VERIFY_TIMEOUT_MS))
      if (verdict.kind === 'not-user-invocable') {
        commit([paint(`\u00b7 /${parsed.name} is a skill, but not one a person can invoke directly`, 'muted')])
        draw()
        return
      }
      if (verdict.kind === 'unverifiable') {
        // Neither a denial nor a spent turn. The catalog on hand is not one a
        // miss may rest on — a provider rejected, discovery did not finish, an
        // invalidation landed mid-refresh, or the deadline above expired — so
        // the wording names the state, not any one of its causes. The line is
        // in this session's input history like any other submission, one `↑`
        // away, exactly as a reported unknown command is.
        commit([paint(`\u00b7 could not verify /${parsed.name} against the current skill catalog`, 'muted')])
        draw()
        return
      }
      if (verdict.kind === 'unknown') {
        commit([`${paint(`\u2717 unknown command: /${parsed.name}`, 'error')}${paint(' \u00b7 type / to see what there is', 'muted')}`])
        draw()
        return
      }
      // `user-invocable`: the line goes to the model UNCHANGED, exactly as the
      // reader typed it. dshline neither loads the skill nor injects its body
      // — `dsh-tool-skill` recognizes the same literal at the pre-step
      // boundary and does both.
      //
      // `userInvocable` is a policy, not a readiness signal: a composition can
      // publish one while mounting no consumer that reads the gesture, and no
      // Harness surface says which. Inferring it here would mean reading
      // implementation (preset files, Cordis listeners, a model tool's name)
      // instead of a contract, so this follows the same field Harness's own Web
      // client does and the limit is documented — see docs/architecture.md.
    }
    let images: readonly ImageBlock[] = []
    if (imageDrafts.size > 0) {
      if (imageAdmission !== undefined) {
        if (composer.isEmpty) composer.set(line)
        commit([paint('· images are still being attached; nothing else was sent', 'muted')])
        draw()
        return
      }
      const attachments = ctx.get('attachments')
      const fs = ctx.get('fs')
      if (attachments === undefined || fs === undefined) {
        // A profile can recompose between staging and send. The paths remain in
        // this session and the text returns to the composer; pretending the
        // message went without its images would be silent semantic loss.
        composer.set(line)
        commit([paint('✗ image attachment became unavailable; nothing was sent', 'error')])
        draw()
        return
      }
      if (w.modelInfo.inputModalities !== undefined && !w.modelInfo.inputModalities.includes('image')) {
        if (composer.isEmpty) composer.set(line)
        commit([paint(`✗ model ${selection.current?.model ?? 'selected'} does not support image input; nothing was sent`, 'error')])
        draw()
        return
      }
      const admission = new AbortController()
      imageAdmission = admission
      const batch = imageDrafts.items
      const admissionSignal = AbortSignal.any([admission.signal, AbortSignal.timeout(IMAGE_ADMISSION_TIMEOUT_MS)])
      let inputs
      try {
        inputs = await readImageDrafts(
          batch,
          fs,
          workspace,
          attachments.imageLimits.maxImageBytes,
          attachments.imageLimits.maxMessageImageBytes,
          admissionSignal,
        )
      } catch (error: unknown) {
        if (scope.closed) return
        if (imageAdmission === admission) imageAdmission = undefined
        if (composer.isEmpty) composer.set(line)
        if (admission.signal.aborted) {
          commit([paint('· image attachment cancelled; nothing was sent', 'muted')])
        } else {
          commit([paint(`✗ ${imageFilesystemFailure(error)}; nothing was sent`, 'error')])
        }
        draw()
        return
      }
      if (scope.closed) return
      try {
        const refs = await attachments.saveImages(inputs)
        images = refs.map(attachment => ({ type: 'image', attachment }))
        // The attachment provider publishes atomically but cannot be interrupted.
        // Honour a reader cancellation that arrived while that publication ran
        // before the now-durable refs can reach an Agent inbox.
        admissionSignal.throwIfAborted()
      } catch (error: unknown) {
        if (scope.closed) return
        // Do not overwrite text typed while a slow filesystem/provider was
        // answering. The attempted line is already in session input history;
        // when the composer is still empty, restore it directly as well.
        if (composer.isEmpty) composer.set(line)
        if (admission.signal.aborted) {
          commit([paint('· image attachment cancelled; nothing was sent', 'muted')])
          draw()
        } else report(error)
        return
      } finally {
        if (imageAdmission === admission) imageAdmission = undefined
      }
      // `saveImages` deliberately has no cancellation parameter: durable batch
      // publication may finish after this attachment begins teardown. Never let
      // that stale completion enqueue into the Agent the window has left.
      if (scope.closed) return
    }
    const message = createUserMessage({
      content: [{ type: 'text', text: line }, ...images],
      source: { kind: 'user' },
    })
    // The reader's choice, not the agent's status. Both verbs were always
    // available while a turn ran; picking `steer` because it was the one the
    // status made obvious meant every busy submission joined the turn already in
    // flight, and nothing ever asked for a follow-up. Harness still owns the
    // scheduling and the durability of both — this decides only which of the two
    // the line was meant for, and calls that verb once.
    if (submittedDelivery === 'steer') agent.steer(message)
    else agent.followup(message)
    imageDrafts.clear()
    draw()
  }

  /**
   * Open `ctrl-r` search over this session's submitted input.
   *
   * The composer is left ALONE while the overlay is up. That is what makes `esc`
   * exact rather than approximate: a search that previewed each result into the
   * buffer would have to rebuild the half-typed draft, its cursor position, and
   * whatever history navigation was already under way, and every one of those is
   * a chance to hand back something the reader did not leave.
   *
   * Completion is invalidated on the way in for the reason a submitted line
   * invalidates it: a directory read still in flight would otherwise land its
   * candidates over the query, or after it, for text that is no longer there.
   */
  const openHistorySearch = (): void => {
    completion.invalidate()
    const search = new HistorySearch(history)
    let dismiss = (): void => {}
    const overlay = createHistorySearchOverlay({
      search,
      // A resume seeds history from the log the replay is already reading, so
      // `ctrl-r` during one has to say "still arriving" rather than "nothing here".
      loading: () => replaying !== undefined,
      invalidate: () => { ctx.tuiSlots.invalidate() },
      settle: index => {
        dismiss()
        // Who owns the buffer and the arrows next is the same question
        // `routeInputKey` answers per keystroke, so it is answered in the same
        // place: a recalled line owns the arrows until it is edited or
        // submitted, and completion must not open over it and steal the next
        // press. A cancellation back to an ordinary draft has no such claim.
        const reopen = applyHistorySearch(index, composer, history)
        draw()
        if (!reopen) return
        completion.refresh().then(draw).catch(report)
      },
    })
    dismiss = ctx.tuiSlots.pushOverlay(overlay)
    draw()
  }

  const onKey = (key: Key): void => {
    // `ctrl-d` is handled by the window, before this delegate, because it means
    // the same thing everywhere: leave. `ctrl-c` is deliberately NOT: inside an
    // overlay it means "cancel this one", which is the overlay's own business.
    const overlay = ctx.tuiSlots.activeOverlay
    if (overlay !== undefined) {
      overlay.handleKey(key)
      return
    }
    // Completion, then history, then the composer. The three share the vertical
    // arrows, and this ordering is the whole vertical-routing policy. Completion
    // always wins while it is showing. History traversal deliberately does NOT
    // recompute completion, so a recalled line that would be completable
    // (`/model`) does not steal the next arrow press: the user entered history
    // navigation, and stays there until they edit or submit. At the draft, the
    // composer's own `↑`/`↓` move through the wrapped buffer first, so a long
    // prompt is navigated vertically before `↑` reaches for history.
    const geometry = {
      width: composerInner(terminal.columns()),
      gutter: composerGutter,
    }
    const routed = routeInputKey(key, composer, completion, history, geometry)
    if (routed === 'completion') {
      draw()
      return
    }
    if (routed === 'history') {
      draw()
      return
    }
    if (routed === 'vertical') {
      // The cursor moved through the buffer's rows; history drafts are left
      // untouched, and what is completable changed with the cursor, as it does
      // after any horizontal move.
      draw()
      completion.refresh().then(draw).catch(report)
      return
    }
    const valueBeforeAction = composer.value
    const action = composer.handle(key)
    if (action.kind === 'submit') {
      // Whatever was being completed is gone with the line, and any lookup it
      // had in flight must not land afterwards.
      completion.invalidate()
      if (replaying !== undefined) {
        // The composer has already cleared its buffer. Put the draft back so the
        // enter that could not be honoured costs nothing, and park the reason in
        // the transcript AFTER the replay flood (this window is the one in which
        // a live write would land above the history it belongs under).
        composer.set(action.text)
        replayNotes.push(paint(
          `· still ${replaying} — nothing was sent; press enter again in a moment`,
          'muted',
        ))
        draw()
        return
      }
      draw()
      // The gesture travels with the text rather than being re-derived here: by
      // the time this runs the key is gone, and only the composer knows which of
      // the two submitted. A terminal that cannot distinguish them reports
      // `enter`, which is the reader's own preference — never a third answer.
      submit(action.text, action.gesture).catch(report)
      return
    }
    if (action.kind === 'changed') {
      // Cursor motion and text edits share one composer action. Only an edit
      // abandons history navigation; otherwise Left followed by Up must continue
      // to the older entry, and the saved half-typed draft must remain recoverable.
      const edited = history.resetIfEdited(valueBeforeAction, composer.value)
      draw()
      // A recalled line deliberately owns the arrows until it is edited or
      // submitted. Cursor-only motion must not open completion over that line and
      // let the resulting list steal the next vertical arrow.
      if (history.navigating && !edited) return
      // Recomputed after the edit or cursor move, because what is completable is a
      // function of both the text and the cursor position.
      completion.refresh().then(draw).catch(report)
      return
    }
    if (action.key.kind !== 'key') return
    switch (action.key.name) {
      case 'ctrl-c': {
        if (imageAdmission !== undefined) {
          imageAdmission.abort(new Error('Image attachment cancelled by the reader.'))
          return
        }
        // A press during a turn interrupts it; a press with nothing running
        // quits, which is what a terminal user already expects.
        if (agent.status === 'running') {
          // Read BEFORE the cancel, because cancelling is what destroys it.
          // `Agent.cancel` clears both inbox lists unless it is told to keep
          // them, and this interface deliberately does not: ctrl-c here means
          // stop, and work the reader queued would otherwise start running on
          // its own the moment the aborted turn converged to idle — an interrupt
          // that restarts the agent is not an interrupt.
          //
          // Harness's own Web client makes the other choice, and the difference
          // is a terminal one: there, cancelling is a button beside a visible
          // queue the reader can then edit. So the honest cost of this choice is
          // that the discarded prompts are named, not silently dropped — they
          // are still one `↑` away, because a submitted line is in this window's
          // input history whatever the agent did with it.
          const { queued, steering } = pendingUserInput(agent.inbox)
          const discarded = queued + steering
          agent.cancel({ kind: 'user' })
          if (discarded > 0) {
            commit([paint(
              `· interrupted · ${String(discarded)} pending ${discarded === 1 ? 'prompt' : 'prompts'} discarded · press ↑ to bring one back`,
              'muted',
            )])
            draw()
          }
          return
        }
        exit?.(0)
        return
      }
      case 'ctrl-r':
        openHistorySearch()
        return
      case 'ctrl-l':
        clear()
        return
      case 'ctrl-o': {
        // A compact card that elided rows — a completed result's, or a still-
        // pending call's own presented content — commits those rows into the
        // terminal's own scrollback, where `compact → full → hidden` cannot
        // recover them (that cycle only affects cards drawn from here on). So
        // the very first duty of ctrl-o is to open the inspector for an unseen
        // truncated card — and taking it consumes that one-shot opportunity, so
        // a later ctrl-o returns to the detail cycle rather than reopening the
        // same card. A card the reader has already scrolled past is reached
        // from INSIDE the overlay, where arrows navigate the retained history
        // and ctrl-o remains an older alias: while an overlay is mounted the
        // window routes every key to it, so this handler is not reached again
        // until it closes.
        const inspectable = cards.takeInspectable()
        if (inspectable !== undefined) {
          // The inspector is a live-region overlay: it disappears on dismiss and
          // never rewrites the committed transcript, keeping native scrollback.
          // `current` is the only mutable part: the overlay moves it through the
          // retained history, and every read below follows it.
          let current = inspectable
          let dismiss = (): void => {}
          const overlay = createToolOutputOverlay({
            title: 'Tool output',
            // A retained entry is either a completed result or a still-pending
            // call's own content (see `InspectableCard`): the label follows
            // whichever shape `current` holds right now, by that generic
            // discriminant rather than by which tool made the call.
            label: () => current.kind === 'call' ? 'Tool call' : 'Tool output',
            render: columns => cards.renderInspect(current, columns),
            position: () => cards.inspectableRank(current),
            older: () => {
              const older = cards.inspectableOlderThan(current)
              if (older === undefined) return false
              current = older
              return true
            },
            newer: () => {
              const newer = cards.inspectableNewerThan(current)
              if (newer === undefined) return false
              current = newer
              return true
            },
            close: () => dismiss(),
            invalidate: () => { ctx.tuiSlots.invalidate() },
          })
          dismiss = ctx.tuiSlots.pushOverlay(overlay)
          return
        }
        // Finished cards are in the terminal's own scrollback and are never
        // rewritten, so this sets the level for cards drawn from here on rather
        // than reflowing what is already printed. That is the trade for keeping
        // native scrollback, selection, and copy working.
        const next = CARD_DETAIL_CYCLE[(CARD_DETAIL_CYCLE.indexOf(cards.detail) + 1) % CARD_DETAIL_CYCLE.length]
        cards.detail = next ?? 'compact'
        prefs.cardDetail = cards.detail
        commit([paint(`· tool output: ${cards.detail}`, 'muted')])
        draw()
        return
      }
      default:
        return
    }
  }
  w.setDispatch(onKey)
  scope.own(() => { w.setDispatch(undefined) })

  const model = selection.current === undefined
    ? undefined
    : `${selection.current.provider} / ${selection.current.model}`
  // A `/clear` wipe is the fresh session's first paint, not the old one's
  // last: it happens only now, when create has already succeeded (which is
  // why this attachment exists), so a failed or resumed transition leaves
  // the visible transcript intact.
  if (shouldClearDisplay(outcome.target)) clear()
  commit(bannerLines(workspace, model, w.version, terminal.columns()))
  commit(resumeNote)

  if (attached.reopened && target.kind === 'resume') {
    // The live region is drawn BEFORE the replay begins, and the status line
    // reports the replay while it runs. Replayed through the same projection
    // the live listener uses, so a resumed session reads exactly like the one
    // that was watched happen. Committed in ONE write: an event-by-event commit
    // would redraw the live region thousands of times to produce a screen
    // nobody sees until the end of it.
    //
    // Without the early draw, a reopened session's composer and status stayed
    // invisible — keystroke routing already live — for however long reading and
    // projecting the log took: on a real transcript that is a multi-hundred-
    // millisecond blank screen with a live cursor, and `ready` is a claim the
    // reader has no history to check yet.
    replaying = 'resuming session…'
    // Painted synchronously at the moment the replay begins: the read that
    // follows is an await the frontend does not control (input may run during
    // it), and the projection + flood commit after it are one event-loop
    // block, so a coalesced paint has no guaranteed slot before the flood.
    w.paintNow()
    const events = await readTranscript(ctx, target.id)
    const replayed = events.filter(isTranscriptEvent)
    replaying = replayed.length === 0
      ? 'resuming session…'
      : `replaying ${String(replayed.length)} events…`
    w.paintNow()
    // History is seeded from the same durable events the transcript replays, so
    // a reopened session navigates what was actually submitted — direct prompts
    // and recorded slash commands — rather than only what this process has seen.
    for (const line of historyLines(replayed)) history.record(line)
    const columns = terminal.columns()
    const lines = replayed.flatMap(event => project(event, columns))
    // The buffer is left holding nothing: a log can end mid-reply, and a partial
    // line still owed from history would otherwise be committed on top of the
    // FIRST line of the next turn.
    lines.push(...stream.finish(columns))
    stream.reset()
    cards.reset()
    commit([...lines, ...resumeBanner(replayed.length)])
    // The replay window is over. Anything an enter during it parked in
    // `replayNotes` now lands BELOW the history it belongs under, in the order
    // it was refused — a live write during the flood would have committed above
    // it. The gate is cleared so the status can honestly say `ready`.
    commit(replayNotes)
    replayNotes.length = 0
    replaying = undefined
  }
  draw()

  // Consumed, not read: a session reopened from inside the window must not
  // replay the command line's opening prompt.
  const task = w.pendingTask
  w.pendingTask = undefined
  if (task !== undefined) await submit(task).catch(report)

  const next = await switched
  // Presentation first, then the agent. A log listener still subscribed while
  // its own agent is torn down would project that teardown into the transcript
  // the reader is leaving.
  //
  // Both halves are reported rather than thrown. A rejected teardown would
  // otherwise reach the runner's boot-failure path and end the window over a
  // session the reader has already left; the next attachment drives another
  // target, so it does not collide with whatever failed to come down.
  try {
    scope.dispose()
  } catch (error: unknown) {
    report(error)
  }
  const closing = ctx.tuiSlots.register('status', {
    render: (): string[] => [paint('· switching sessions…', 'muted')],
  })
  draw()
  try {
    await disposeAgent()
  } catch (error: unknown) {
    report(error)
  }
  closing()
  return next
}

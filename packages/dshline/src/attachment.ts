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

import { homedir } from 'node:os'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
// The attachment seam is read through `ctx.get('attachments')` and never
// imported for a value: it is optional, so a profile with no attachment backend
// still starts, and these are the types its optional store satisfies.
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-agent/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Empty type imports carry the Context merges this module reads but does not
// otherwise import from: the questions seam and the launcher's exit request. The
// command registry is imported for its parser as well as its merge, so this
// frontend decides what a command LINE is by the same rule the registry resolves
// one with.
import { CommandDefinitionId, parseCommand } from '@deepseek-ai/dsh-commands'
import type { CommandSubmitAttachment } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-cmdline'
// `plan/mode` is folded below from the `SessionEventMap` merge this carries. Not
// a peer dependency, because it does not have to be MOUNTED for this frontend to
// run — a profile without it simply never reports plan mode.
import type {} from '@deepseek-ai/dsh-plan-mode'
// Optional projection infrastructure and Todo's `SessionProjectionMap` merge.
// dsh-base mounts both, but custom profiles may omit either without stopping TUI.
import type {} from '@deepseek-ai/dsh-session-projection'
// The corpus service is read below for the SUBAGENT inspector only — the
// attached Agent's own log is read from its owned Session. It stays optional in
// the same way: a profile without it browses no child conversations.
import type {} from '@deepseek-ai/dsh-session-query'
// Session titles are optional too: `/sessions` offers rename through the
// service only when the active profile mounts it.
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-tool-todo'
// The goal package publishes both of this frontend's goal authorities: the
// `goal` key of `SessionProjectionMap` (durable, read from the shared snapshot)
// and the `ctx.goals` service type (live activation, read below). Optional in
// the same way — a profile without it reports no goal at all.
import type { GoalActivation } from '@deepseek-ai/dsh-goal'
// Carries both of the bare `/permission` picker's authorities: the
// `permissions` projection key and the `ctx.permissionPresets` service type.
// Optional, like the goal seam above.
import type {} from '@deepseek-ai/dsh-permission-presets'
// `fs` is read optionally for path completion and for generic file admission: a
// profile that mounts no filesystem offers neither rather than failing, so this
// carries the type without a hard need.
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { Key, SubmitGesture } from '@dshline/renderer'
import { Composer, escapeControls, paint, SPINNER_INTERVAL_MS } from '@dshline/renderer'
import { CARD_DETAIL_CYCLE, ToolCards } from './cards.ts'
import { chooseDelivery } from './delivery.ts'
import type { Delivery } from './delivery.ts'
import { BUSY_ENTER_CHOICES, runEnterCommand } from './enter.ts'
import { modelPhaseAfter, modelPhaseAfterFrame, primaryActivity } from './activity.ts'
import type { ModelPhase } from './activity.ts'
import { installApprovalAnswerer } from './approval.ts'
import { AssistantStreamAttemptGate } from './assistant-attempt-gate.ts'
import {
  createAttentionController,
  liveSessionAttention,
  modelRouteAttention,
  reasoningAttention,
} from './attention.ts'
import { createCompletion } from './completion.ts'
import { historyLines, InputHistory } from './history.ts'
import { HistorySearch } from './history-search.ts'
import { createHistorySearchOverlay } from './history-search-overlay.ts'
import { applyHistorySearch, routeInputKey } from './input.ts'
import { transcriptEvents, resumeBanner } from './resume.ts'
import { createToolOutputOverlay } from './tool-output.ts'
import { pickModel } from './model.ts'
import type { PickModelOptions } from './model.ts'
import { installQuestionProvider } from './questions.ts'
import { LocalCommandRegistry } from './local-commands.ts'
import { runThemes, themeValues } from './themes/index.ts'
import type { LocalCommandChoice } from './local-commands.ts'
import { SessionScope } from './session-scope.ts'
import { planNew, planResume } from './sessions/plan.ts'
import type { AttachOutcome, AttachTarget } from './sessions/reopen.ts'
import { shouldClearDisplay } from './sessions/reopen.ts'
import { StreamBuffer } from './stream.ts'
import { effortLabel, pickReasoning, reasoningValues } from './reasoning.ts'
import type { SelectionOutcome } from './selection.ts'
import { THINKING_VALUES, pickThinking, thinkingAcknowledgement, validThinkingArgument } from './thinking.ts'
import { createTimingView, TurnTimer } from './timing.ts'
import { planModeAfter } from './modes.ts'
import { commandEcho, commandLines, projectEvent } from './transcript.ts'
import { promptSelect } from './select.ts'
import { promptSessionTitle } from './prompt.ts'
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
import { cacheTransitionNote } from './cache/model.ts'
import { createCachePresenter } from './cache/presenter.ts'
import { contextReading, ContextSurveyor, contextPressureTokens } from './context/model.ts'
import { createContextPresenter } from './context/presenter.ts'
import { createTurnsPresenter } from './turns/presenter.ts'
import { turnReading } from './turns/model.ts'
import { currentSessionReading } from './session/model.ts'
import { createCurrentSessionHubPresenter } from './session/presenter.ts'
import { observedTitleTraits, SessionNavigator } from './sessions/navigator.ts'
import { compactionNote } from './context/compaction.ts'
import { bannerLines, composerGutter, composerInner, createComposerView, createStatusView } from './views.ts'
import type { Window } from './window.ts'
import { createHarnessWork } from './work/index.ts'
import { createWorkOverlay } from './work/overlay.ts'
import { activeWorkCount, workSummary } from './work/model.ts'
import type { WorkConversationTarget } from './work/model.ts'
import { createSubagentsPresenter } from './subagents/presenter.ts'
import { SessionProjectionObserver } from './projections/observer.ts'
import { openSurface } from './surface.ts'
import { goalInspection, goalReading } from './goals/model.ts'
import { createGoalOverlay } from './goals/overlay.ts'
import { todoReading, todoSummary } from './todos/model.ts'
import { createTodosPresenter } from './todos/presenter.ts'
import { SkillCatalog } from './skills/catalog.ts'
import { slashCandidates } from './skills/model.ts'
import { pendingUserInput } from './steering.ts'
import { AttachmentDrafts, encodeCommandImages, readImageDrafts } from './attachment-drafts.ts'
import type { AttachmentDraft, ImageDraft } from './attachment-drafts.ts'
import { admitFileDraft, attachmentAuthoredMessage, fileAttachmentFailure } from './file-admission.ts'

/** What `/timing` accepts, for completing its argument. */
const TIMING_VALUES: readonly LocalCommandChoice[] = [
  { value: 'on', note: 'Show the live turn timing panel' },
  { value: 'off', note: 'Hide the live turn timing panel' },
]

/**
 * Bounds path resolution, file reads, validation, and durable attachment commit.
 *
 * Generous enough for a large log over a remote filesystem and short enough that
 * a wedged backend cannot hold an admission open until the reader gives up on
 * the session. The same bound covers both kinds: they share one admission, and
 * two timeouts would have been a race between them.
 */
const ATTACHMENT_ADMISSION_TIMEOUT_MS = 30_000

/**
 * The definition id the effective `/goal` command identifies itself with.
 *
 * A definition id rather than a name is what tells the resolved command apart
 * from an agent-scoped shadow of the same name: a different or absent identity
 * goes to the registry unchanged, and a command that declares this same
 * identity is presenting itself as the native command — a trusted registration
 * the registry does not let this frontend see through.
 */
const GOAL_COMMAND_DEFINITION_ID = CommandDefinitionId('@deepseek-ai/dsh-command-goal')

/**
 * Safe presentation for filesystem errors raised while admitting a local image.
 *
 * `FsError` messages may spell an absolute user path. A terminal message must
 * explain the recoverable condition without turning that transient path into
 * another disclosure channel; attachment-store failures the switch has nothing
 * specific to say about keep their own Harness-authored diagnostics, which is
 * why the miss is `undefined` and not a catch-all sentence.
 * @param error - an admission failure.
 * @returns a path-free filesystem message, or undefined for an unfamiliar code.
 */
function imageFilesystemFailure(error: unknown): string | undefined {
  switch (typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined) {
    case 'FS_NOT_FOUND': return 'image file no longer exists'
    case 'FS_NOT_REGULAR_FILE': return 'image path is not a regular file'
    case 'FS_TOO_LARGE': return 'image file exceeds this deployment\'s per-image limit'
    case 'IMAGE_BATCH_TOO_LARGE': return 'image batch exceeds this deployment\'s total limit'
    case 'FS_PERMISSION_DENIED':
    case 'FS_SANDBOX_DENIED': return 'image file cannot be read by this profile'
    case 'ATTACHMENT_FILES_UNSUPPORTED': return 'this profile\'s attachment provider does not support generic files'
    default: return undefined
  }
}

/**
 * One safe sentence for an admission failure, whatever raised it.
 *
 * Three vocabularies, consulted in the order that loses the least: a specific
 * file condition, then a specific image condition, then the attachment
 * capability's own diagnostic, which its error class documents as carrying no
 * bytes and no host paths. Anything left over is a filesystem failure in an
 * unfamiliar shape, and it is answered with this frontend's own words rather
 * than the failure's — an `FsError` message is allowed to spell an absolute
 * user path, and a scrollback is read by whoever opens this terminal.
 * @param error - an admission failure.
 * @returns a sentence safe to commit to scrollback.
 */
function admissionFailure(error: unknown): string {
  const authored = attachmentAuthoredMessage(error)
  // An authored message is a whole sentence and usually ends in a full stop,
  // which the caller's `; nothing was sent` would then double up behind.
  return fileAttachmentFailure(error)
    ?? imageFilesystemFailure(error)
    ?? (authored === undefined ? undefined : authored.trimEnd().replace(/\.$/u, ''))
    ?? 'the attachment could not be read'
}

/**
 * Admit one ordered attachment batch into durable content blocks.
 *
 * The ledger's order is the message's order, so the batch is walked in place
 * and each block is emitted where its draft sat. The two kinds still do their
 * work in separate passes — the image batch is read under its published
 * aggregate byte limit and committed through one `saveImages` call, exactly as
 * it was before generic files existed — and the walk afterwards is what
 * reassembles them without ever grouping images ahead of files. Reads happen
 * first on purpose: a path that is missing or unreadable then costs no durable
 * object at all.
 *
 * ALL OR NOTHING, and that is the caller's contract too: this returns blocks for
 * the whole snapshot or throws, so a message is never sent carrying the
 * attachments that happened to succeed. An object published before a later
 * failure can stay unreachable; that is the provider's retention to collect, and
 * there is no rollback to invent on this side of the seam.
 * @param batch - the immutable snapshot this submission owns.
 * @param fs - the current session's filesystem authority.
 * @param attachments - the current session's durable attachment store.
 * @param workspace - the session workspace, for relative draft paths.
 * @param signal - cancellation shared by every step of the batch.
 * @returns durable blocks in the batch's own order.
 */
async function admitAttachmentBatch(
  batch: readonly AttachmentDraft[],
  fs: FileSystem,
  attachments: AttachmentStore,
  workspace: string,
  signal: AbortSignal,
): Promise<readonly ContentBlock[]> {
  const imageDrafts = batch.filter((draft): draft is ImageDraft => draft.kind === 'image')
  // An empty batch is never sent: `saveImages([])` is a real call, and making
  // one to commit nothing asks the provider to work on a message that has none.
  const imageRefs = imageDrafts.length === 0
    ? []
    : await attachments.saveImages(await readImageDrafts(
      imageDrafts,
      fs,
      workspace,
      attachments.imageLimits.maxImageBytes,
      attachments.imageLimits.maxMessageImageBytes,
      signal,
    ))
  const fileRefs = new Map<string, FileAttachmentRef>()
  for (const draft of batch) {
    if (draft.kind !== 'file') continue
    fileRefs.set(draft.path, await admitFileDraft(draft, fs, attachments, workspace, signal))
  }
  let next = 0
  const blocks: ContentBlock[] = []
  for (const draft of batch) {
    if (draft.kind === 'image') {
      const attachment = imageRefs[next++]
      if (attachment !== undefined) blocks.push({ type: 'image', attachment })
      continue
    }
    const attachment = fileRefs.get(draft.path)
    if (attachment !== undefined) blocks.push({ type: 'file', attachment })
  }
  return blocks
}

/**
 * One selection outcome as a transcript row.
 *
 * Mirrors `outcomeLines` in connect, profiles, and plugins: escaped as a whole
 * before styling, because the message can carry a typed model or effort name
 * and a persistence failure's own words, none of it written by this frontend.
 * The mark and role follow the fact the producer reported, never the sentence:
 * a refused instruction is an error, an applied change is an acknowledgement.
 * @param outcome - what the picker settled.
 * @returns the single line to commit.
 */
function selectionOutcomeLine(outcome: SelectionOutcome): string {
  const mark = outcome.kind === 'failed' ? '\u2717' : '\u00b7'
  return paint(
    escapeControls(`${mark} ${outcome.message}`),
    outcome.kind === 'failed' ? 'error' : 'muted',
  )
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
 * Budget for an ordinary slash command, so a handler that never settles cannot
 * wedge the composer. Commands are local operations; a model turn is not one.
 */
const COMMAND_TIMEOUT_MS = 120_000

/**
 * Compaction is the exception: its registered command performs an auxiliary
 * model call, so it gets a longer caller budget without weakening the bound on
 * ordinary commands.
 */
const COMPACTION_COMMAND_TIMEOUT_MS = 300_000

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
  const attachmentAbort = new AbortController()
  // ONE admission flag for both kinds, deliberately. Two flags would be two
  // independent races over the same ledger: a `/image` staged while a file was
  // being streamed could be consumed by the file submission, or both could
  // decide they owned the draft set and neither would be able to describe what
  // the reader had staged. A submission is a snapshot of everything, and one
  // flag is the only thing that can say so.
  let attachmentAdmission: AbortController | undefined
  const cancelAttachmentWork = (): void => {
    attachmentAbort.abort(new Error('Session attachment stopped because the session closed.'))
    attachmentAdmission?.abort(new Error('Attachment admission stopped because the session closed.'))
    attachmentAdmission = undefined
  }
  // Session switching and process exit share the same cancellation prelude. The
  // scope registration remains the ordinary-switch owner; the explicit call in
  // the exit path makes the ordering visible before presentation teardown.
  scope.own(cancelAttachmentWork)
  // Created before the command handlers that can request a transition: each
  // closes over it, and none may resolve into a promise that does not exist yet.
  let requestNext: (target: AttachTarget) => void = () => {}
  const switched = new Promise<AttachTarget>(resolve => { requestNext = resolve })
  const { agent, dispose: disposeAgent } = attached.handle
  let exitRequested = false
  const requestAttachmentExit = (): void => {
    if (exitRequested) return
    exitRequested = true
    // The launcher's exit request waits for tree disposal. Cancel attachment
    // work first, tear down presentation second, then interrupt any active model
    // request so the same AbortSignal reaches the provider before
    // AgentHandle.dispose() waits for loop convergence. The launcher still owns
    // final shutdown.
    cancelAttachmentWork()
    try {
      scope.dispose()
    } catch {
      // SessionScope contains disposer failures after running every disposer.
      // There is no safe terminal-independent diagnostic surface here; do not
      // replace Harness shutdown with a raw write into the TUI's terminal.
    }
    try {
      agent.cancel({ kind: 'user' })
    } catch {
      // Cancellation is a best-effort prelude. Harness still owns final teardown,
      // so a synchronous Agent failure must not block the launcher's exit request.
    }
    exit?.(0)
  }
  w.setExit(requestAttachmentExit)
  scope.own(() => { w.setExit(undefined) })

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
  // Durable subagent conversations are a SEPARATE presenter from active Work:
  // Work owns open lifecycle epochs keyed by `runId`, while a settled
  // continuable child is still a durable conversation. This presenter reads the
  // generic subagent and session-query seams and inspects/continues; interrupt
  // stays on `/work`, where an open epoch is the stronger premise.
  const subagents = ctx.get('subagents')
  const sessionQuery = ctx.get('sessionQuery')
  const subagentsPresenter = createSubagentsPresenter({
    slots: ctx.tuiSlots,
    parentSessionId: agent.session.id,
    invalidate: () => { ctx.tuiSlots.invalidate() },
    ...subagents === undefined ? {} : { subagents },
    ...sessionQuery === undefined ? {} : { query: sessionQuery },
    // Subscribed only when the feature can actually be used: a profile without
    // `ctx.subagents` has no catalog to refresh and no child to mark stale.
    ...subagents === undefined ? {} : {
      onLifecycle: listener => {
        // `agent.ctx` is the parent-scoped carrier Harness routes lifecycle
        // edges through. A test or an unusual composition may not have attached
        // one, and a missing carrier means no scoped edge to observe.
        const scoped = agent.ctx as typeof agent.ctx | undefined
        if (scoped === undefined) return () => {}
        const offStart = scoped.on('subagent/start', () => { listener() })
        const offEnd = scoped.on('subagent/end', () => { listener() })
        return () => { offStart(); offEnd() }
      },
      onSessionEvent: listener => ctx.on('session/event', session => { listener(String(session.id)) }),
    },
  })
  scope.own(() => { subagentsPresenter.dispose() })
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
  // Activation is process-local: a disarm writes no goal/change, advances no
  // revision, and publishes no projection frame, so the observer above cannot
  // schedule the repaint that turns the footer's `goal armed` into `goal idle`
  // (nor an open inspector's Continuation row with it). This event is the one
  // signal that edge produces, and it is GLOBAL rather than scoped to this
  // attachment, so the exact Session is filtered here. The listener is an
  // invalidation signal only: it never reads the service, derives a value, or
  // retains the payload, so the next paint still takes activation from the one
  // authority that owns it.
  scope.own(ctx.on('goal/activation-changed', payload => {
    if (payload.sessionId === agent.session.id) ctx.tuiSlots.invalidate()
  }))
  // The observer above repaints only when a unit's VALUE changes on a committed
  // event. Live preset availability is a derivation INPUT, so losing it can
  // change what the very next `permissions` snapshot derives while publishing no
  // projection frame and appending no Session event: a withdrawn `auto`
  // contribution leaves the same durable sandbox/approval knobs matching a
  // different id or none. This listener is therefore an invalidation signal
  // only — it never reads the catalog, derives a value, or retains either. The
  // next paint re-reads the authoritative projection snapshot, which recomputes
  // the view from the current availability, so dshline still owns no permission
  // state and the catalog is still only what is selectable.
  if (ctx.get('permissionPresets') !== undefined) {
    scope.own(ctx.on('permission-presets/catalog-changed', () => {
      ctx.tuiSlots.invalidate()
    }))
  }
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
  // Unsent attachments belong to this attachment, not the window or text
  // composer: reopening another session disposes the paths, while history and
  // undo remain honest text-only mechanisms. No bytes are read until an
  // ordinary prompt is actually sent.
  const drafts = new AttachmentDrafts()
  // Read per paint rather than captured: both halves move while the frame
  // stands — the agent starts and stops a turn, and `/enter` rewrites the pref.
  const composerView = createComposerView(composer, workspace, persistentRowsBelow, () => ({
    busy: agent.status === 'running',
    busyEnter: prefs.busyEnter,
    ...drafts.images.length === 0 ? {} : { images: drafts.images.length },
    ...drafts.files.length === 0 ? {} : { files: drafts.files.length },
  }))
  const stream = new StreamBuffer(prefs.reasoningVisible)
  // Attempt identity is a pure gate shared with the Work child observer, so
  // both folds classify a stale frame the same way. Its TSDoc carries the two
  // distinct "no attempt" states; this listener only resets its own buffer when
  // a new attempt begins.
  const attempt = new AssistantStreamAttemptGate()
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
  // Manual compaction is a command rather than a model turn, so the status line
  // cannot infer its progress from `agent.status`. This counter counts exactly
  // the `/compact` executions THIS frontend is currently awaiting. Automatic
  // compaction and its durable lifecycle belong to Harness; the status line
  // does not track them.
  let compactCommandsInFlight = 0
  const compactionActive = (): boolean => compactCommandsInFlight > 0
  // One transient emphasis slot per attachment. It is created here, before the
  // command handlers that show into it, and registered with the session scope so
  // switching sessions clears the deadline rather than letting a stale notice
  // paint into the next attachment.
  const attention = createAttentionController(draw)
  scope.own(attention.dispose)
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
  // A resumed session's transcript is being replayed into the window. Set only
  // across the replay's own synchronous pre-flood paint, so the status line
  // reports the history the reader asked to reopen instead of claiming `ready`
  // before it is on screen. It is never observed by a keystroke: the snapshot,
  // the projection, and the clearing of this value all run in one
  // run-to-completion block, so no input can interleave above the flood.
  let replaying: string | undefined

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
   * @returns a message when dispatch failed, else nothing.
   */
  const runCompactCommand = async (): Promise<string | undefined> => {
    const outcomesBefore = commandOutcomes
    let execution: Awaited<ReturnType<typeof ctx.commands.execute>>
    compactCommandsInFlight += 1
    draw()
    try {
      execution = await ctx.commands.execute(
        agent,
        '/compact',
        [],
        AbortSignal.timeout(COMPACTION_COMMAND_TIMEOUT_MS),
      )
      // `undefined` means the registry did not resolve the name, which can only
      // happen if the composition changed between the offer and the keystroke.
      if (execution === undefined) return 'This profile has no /compact command.'
      // The command lifecycle is committed underneath the overlay. Returning its
      // classified text as well gives the reader a timely notice instead of
      // making them close the overlay to discover a busy or failed compaction.
      return execution.result.kind === 'error' ? execution.result.text : undefined
    } catch (error: unknown) {
      // A handler that threw has already appended its own `command/done`, which
      // the projection has printed. Only a throw that never reached the
      // lifecycle still needs saying — the same rule the composer's submit uses.
      if (commandOutcomes === outcomesBefore) report(error)
      return undefined
    } finally {
      compactCommandsInFlight -= 1
      draw()
    }
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

  // Capability presenters own their command, their bounded surface, and the
  // translation from Harness facts to terminal rows. `attachSession` wires each
  // once and hands it only the readers it needs, so a capability's presentation
  // can change without this function learning anything new.
  const todosPresenter = createTodosPresenter({
    slots: ctx.tuiSlots,
    snapshot: () => projections.snapshot(),
  })
  const cachePresenter = createCachePresenter({
    slots: ctx.tuiSlots,
    session: agent.session,
    snapshot: () => projections.snapshot(),
  })
  const contextPresenter = createContextPresenter({
    slots: ctx.tuiSlots,
    session: agent.session,
    snapshot: () => projections.snapshot(),
    survey: () => surveyor.read(),
    // The SELECTED route's window, which is what the next request will be
    // measured against; the projection's own last-recorded capacity is the
    // fallback for a session whose route metadata never resolved.
    capacity: () => w.modelInfo.contextWindow,
    // A live getter, not a snapshot: a scoped composition change while the
    // overlay is open repaints the footer before the next keystroke.
    canCompact: compactRegistered,
    compact: runCompactCommand,
    invalidate: () => { ctx.tuiSlots.invalidate() },
  })
  // `/turns` reads the same generic projection cut as Context, Cache, and
  // Todos: the Harness `turnOutline` unit owns turn identity and previews, and
  // this presenter only decides what bounded rows a terminal shows of them.
  const turnsPresenter = createTurnsPresenter({
    slots: ctx.tuiSlots,
    snapshot: () => projections.snapshot(),
    invalidate: () => { ctx.tuiSlots.invalidate() },
  })
  const sessionNavigator = sessionQuery === undefined ? undefined : new SessionNavigator({
    query: sessionQuery,
    invalidate: () => { ctx.tuiSlots.invalidate() },
    // Same batched corpus observation `/sessions` uses for lineage titles,
    // through the one shared settlement fold; it runs only inside
    // `requestLineage`, so opening the hub reads nothing.
    observeTitles: async (sessionIds, signal) => observedTitleTraits(
      await sessionQuery.readTitleSnapshots(sessionIds, signal),
    ),
  })
  if (sessionNavigator !== undefined) scope.own(() => { sessionNavigator.dispose() })
  const sessionHub = createCurrentSessionHubPresenter({
    // The attachment supplies only already-resolved authoritative values; the
    // pure model decides their presentation order and omission rules.
    reading: () => currentSessionReading({
      session: agent.session,
      title: ctx.get('sessionTitle')?.get(agent.session)?.title,
      stats: projections.snapshot()?.values.sessionStats,
      home: homedir(),
      now: Date.now(),
    }),
    capabilities: () => ({
      findConversation: sessionNavigator !== undefined,
      turns: (() => {
        const reading = turnReading(projections.snapshot())
        return reading.kind === 'list' || reading.kind === 'none'
      })(),
      lineage: sessionNavigator !== undefined,
      rename: ctx.get('sessionTitle') !== undefined,
    }),
    ...(sessionNavigator === undefined ? {} : {
      navigator: {
        events: () => sessionNavigator.events(),
        searchEvents: (sessionId, query) => { sessionNavigator.searchEvents(sessionId, query) },
        loadMoreEvents: () => { sessionNavigator.loadMoreEvents() },
        requestEventContext: (sessionId, seq) => { sessionNavigator.requestEventContext(sessionId, seq) },
        eventContext: (sessionId, seq) => sessionNavigator.eventContext(sessionId, seq),
        lineage: sessionId => sessionNavigator.lineage(sessionId),
        requestLineage: sessionId => { sessionNavigator.requestLineage(sessionId) },
        cancel: () => { sessionNavigator.abort() },
      },
    }),
    openTurns: () => { turnsPresenter.open() },
    rename: async () => {
      const service = ctx.get('sessionTitle')
      if (service === undefined) return { kind: 'failed', message: 'This profile mounts no session-title service.' }
      // The QUESTION is shared with `/sessions`; the mutation stays here, on the
      // exact attached Session, and the prompt is withdrawn with the attachment.
      const draft = await promptSessionTitle(ctx, {
        currentTitle: service.get(agent.session)?.title,
        view: 'Session',
        signal: attachmentAbort.signal,
      })
      if (draft === undefined) return { kind: 'cancelled' }
      try {
        return { kind: 'renamed', title: service.rename(agent.session, draft).title }
      } catch (error: unknown) {
        return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
      }
    },
    home: homedir(),
    now: () => Date.now(),
    push: overlay => ctx.tuiSlots.pushOverlay(overlay),
    invalidate: () => { ctx.tuiSlots.invalidate() },
  })

  const localCommands = new LocalCommandRegistry([
    {
      name: 'image',
      description: 'Stage a raster image for the next prompt; @path stays a text mention',
      execute: (rawInput) => {
        // The active submission owns an immutable snapshot. Listing remains
        // useful while it runs, but changing drafts would make its eventual
        // acknowledgement ambiguous.
        if (attachmentAdmission !== undefined && rawInput.trim() !== '') {
          commit([paint('✗ attachments are being sent; staged images cannot change yet', 'error')])
          draw()
          return
        }
        if (rawInput.trim() === '--clear') {
          const count = drafts.clearImages()
          commit([paint(count === 0 ? '· no images were staged' : `· cleared ${String(count)} staged ${count === 1 ? 'image' : 'images'}`, 'muted')])
          draw()
          return
        }
        const remove = /^\s*--remove\s+(\d+)\s*$/u.exec(rawInput)
        if (remove?.[1] !== undefined) {
          const removed = drafts.removeImage(Number(remove[1]))
          commit([paint(removed === undefined
            ? '✗ no staged image has that number'
            : `· removed staged image ${escapeControls(removed.name)}`, removed === undefined ? 'error' : 'muted')])
          draw()
          return
        }
        if (rawInput.trim() === '') {
          const staged = drafts.images
          const listed = staged.map((draft, index) => `${String(index + 1)}. ${escapeControls(draft.name)}`)
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
        const result = drafts.stageImage(rawInput, {
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
      name: 'attach',
      description: 'Attach any file verbatim for the next prompt; @path stays a text mention',
      execute: (rawInput) => {
        // One ledger and one admission flag, so this refuses for the same reason
        // `/image` does and with the same words: the in-flight submission owns
        // an immutable snapshot, and a mutation now would make its eventual
        // acknowledgement ambiguous.
        if (attachmentAdmission !== undefined && rawInput.trim() !== '') {
          commit([paint('✗ attachments are being sent; staged files cannot change yet', 'error')])
          draw()
          return
        }
        if (rawInput.trim() === '--clear') {
          const count = drafts.clearFiles()
          commit([paint(count === 0 ? '· no files were staged' : `· cleared ${String(count)} staged ${count === 1 ? 'file' : 'files'}`, 'muted')])
          draw()
          return
        }
        const remove = /^\s*--remove\s+(\d+)\s*$/u.exec(rawInput)
        if (remove?.[1] !== undefined) {
          const removed = drafts.removeFile(Number(remove[1]))
          commit([paint(removed === undefined
            ? '✗ no staged file has that number'
            : `· removed staged file ${escapeControls(removed.name)}`, removed === undefined ? 'error' : 'muted')])
          draw()
          return
        }
        if (rawInput.trim() === '') {
          const staged = drafts.files
          const listed = staged.map((draft, index) => `${String(index + 1)}. ${escapeControls(draft.name)}`)
          commit(listed.length === 0
            ? [paint('· no files staged · /attach path/to/file', 'muted')]
            : [paint(`· ${String(listed.length)} staged ${listed.length === 1 ? 'file' : 'files'} · /attach --remove N · /attach --clear`, 'muted'), ...listed])
          draw()
          return
        }
        // Checked at staging as well as at send, for the same reason `/image`
        // does: a capability that is absent right now will be reported now,
        // where the drafts are being created, instead of at the prompt where
        // the reader has moved on. It is still checked again at admission —
        // a profile can recompose between the two.
        if (ctx.get('attachments') === undefined || ctx.get('fs') === undefined) {
          commit([paint('✗ file attachment needs this profile\'s attachment and filesystem services', 'error')])
          draw()
          return
        }
        const result = drafts.stageFile(rawInput)
        if (!result.ok) {
          commit([paint(`✗ ${result.reason === 'duplicate' ? 'that file is already staged' : 'usage: /attach path/to/file'}`, 'error')])
          draw()
          return
        }
        commit([paint(`· staged file ${escapeControls(result.draft.name)} for the next prompt`, 'muted')])
        draw()
      },
    },
    {
      name: 'model',
      description: 'Choose the provider and model for subsequent model steps',
      // The vocabulary is model-owned: each value is the `provider/model` route
      // the row names, with the bare id an alias for search. Building it here
      // from a bare model list is what once let two rows insert the same
      // ambiguous argument.
      complete: () => w.modelCompletionValues(),
      execute: async rawInput => {
        // The note is decided at this command seam, not inside the model
        // picker: the selection before/after are the only facts it needs, and
        // the picker stays cache-agnostic. No projection cut is captured:
        // deciding "was there prior usage" would need a snapshot that is at
        // once post-picker and pre-new-route while `/model` can run against an
        // in-flight turn, and an informational note is not worth that race, so
        // the note depends on the real provider/model move alone.
        const before = selection.current
        // The editor's module graph belongs to the BARE picker only: a named
        // route must not load it, and it is loaded BEFORE the picker opens so
        // `ctrl-k` can push the editor synchronously. Loading it inside the
        // gesture would let a fast enter settle the picker during the import
        // and leave the editor stranded on the composer.
        let options: PickModelOptions = {}
        if (rawInput.trim() === '') {
          try {
            const { openSubagentModelSelection } = await import('./subagent-model-selection/index.ts')
            // `ctrl-k` on the bare picker opens the subagent authorization
            // editor. That editor reads and writes the Host's own
            // `subagent-model-selection` setting and never touches this Agent's
            // selection, so nothing here can produce a model `SelectionOutcome`.
            options = {
              onSubagentModels: () => {
                void openSubagentModelSelection({ ctx, commit }).catch((error: unknown) => {
                  // The editor reports its own read and write refusals; this is
                  // only for a programming failure, which has nowhere else to go.
                  const reason = error instanceof Error ? error.message : String(error)
                  commit([paint(`\u2717 subagent model authorization unavailable: ${escapeControls(reason)}`, 'error')])
                  draw()
                })
              },
            }
          } catch (error: unknown) {
            // A module that cannot load must not take `/model` down with it:
            // the picker still opens, and only the auxiliary editor is missing.
            const reason = error instanceof Error ? error.message : String(error)
            commit([paint(`\u2717 subagent model authorization unavailable: ${escapeControls(reason)}`, 'error')])
            draw()
          }
        }
        const outcome = await pickModel(ctx, selection, rawInput, options)
        if (outcome === undefined) {
          draw()
          return
        }
        // Only a `done` is a model change, so only a `done` re-resolves metadata
        // or earns a cache note. A refusal is presented from its own kind.
        if (outcome.kind === 'failed') {
          commit([selectionOutcomeLine(outcome)])
          draw()
          return
        }
        w.refreshModelInfo()
        // Decided from the actual route before/after, never from the
        // acknowledgement: `/model` returning `done` on the already-current
        // route is a successful operation but not a state transition, and a
        // refusal never reaches here. A default-persistence failure still earns
        // the notice, because the route really did change for this session.
        attention.show(modelRouteAttention(before, selection.current))
        const lines = [selectionOutcomeLine(outcome)]
        const note = cacheTransitionNote(before, selection.current)
        if (note !== undefined) lines.push(paint(`· ${note}`, 'muted'))
        commit(lines)
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
      description: 'Set reasoning effort for subsequent model steps',
      complete: () => reasoningValues(w.modelInfo.reasoning),
      execute: async rawInput => {
        // The levels are a short fixed set a person learns by heart, so
        // `/reasoning max` should not cost a picker.
        const before = selection.current?.reasoningEffort
        const outcome = await pickReasoning(ctx, selection, w.modelInfo.reasoning, rawInput)
        if (outcome !== undefined) commit([selectionOutcomeLine(outcome)])
        // Only a `done` moved the stored effort: a refusal leaves the selection
        // exactly as it was, and a dismissal changes nothing. Comparing the
        // stored value rather than the adapter's advertised default keeps a
        // reselected level, or clearing an already-absent one, quiet while
        // either real transition speaks.
        if (outcome?.kind === 'done') {
          attention.show(reasoningAttention(before, selection.current?.reasoningEffort))
        }
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
        openSurface(ctx.tuiSlots, close => createUsageOverlay({
          inspection: () => usageInspection(projections.snapshot(), usage.reading),
          mode: () => prefs.usageMode,
          chooseDisplay: () => { chooseUsageDisplay() },
          close,
        }))
      },
    },
    cachePresenter.command,
    contextPresenter.command,
    turnsPresenter.command,
    subagentsPresenter.command,
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
        openSurface(ctx.tuiSlots, close => createWorkOverlay({
          snapshot: () => work.snapshot(),
          // A subagent interrupt and a Job stop stay two methods. They cancel
          // different things under different authority, and one `control(item)`
          // would make the difference something a reader has to infer.
          interruptSubagent: item => work.interruptSubagent(item),
          stopJob: item => work.stopJob(item),
          // Observation is demand-driven, so the overlay asks for it when a Job
          // detail opens and disposes the handle when that stage closes. Mounted
          // with the same optional seam as everything else here.
          observeJob: id => work.observeJob(id),
          // Offered exactly while the generic subagent seam is mounted, so a
          // profile without it never advertises a drawer it cannot open.
          ...subagents === undefined ? {} : {
            conversations: () => { subagentsPresenter.openFromWork() },
            // Contextual typing is lost inside the conditional spread, so the
            // target is annotated rather than inferred from `openChild`.
            conversation: (target: WorkConversationTarget) => {
              subagentsPresenter.openChild({
                kind: 'child',
                id: target.id,
                mode: target.mode,
                residency: target.residency,
                hasChildren: target.hasChildren,
                ...(target.label === undefined ? {} : { label: target.label }),
              })
            },
          },
          close,
          invalidate: () => { ctx.tuiSlots.invalidate() },
        }))
      },
    },
    todosPresenter.command,
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
        // The attachment owns the notice, not Setup: the conductor only says a
        // model change landed through `onModelChanged`, and the comparison
        // against the last route seen here decides whether it was a transition.
        // `seen` advances on every acknowledgement so two successful picks in
        // one pass each compare against their real predecessor.
        let seen = selection.current
        await runSetup({
          ctx,
          commit,
          version: w.version,
          selection,
          onModelChanged: () => {
            w.refreshModelInfo()
            attention.show(modelRouteAttention(seen, selection.current))
            seen = selection.current
          },
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
      // Deliberately local: this is terminal presentation over the attached
      // Session, not a process-wide Harness command. If Harness later ships
      // `/session`, resolve that name collision deliberately rather than making
      // a shared command accidentally select one frontend's view.
      name: 'session',
      description: 'Inspect this Harness session and its session-scoped actions',
      execute: rawInput => {
        if (rawInput.trim() !== '') {
          commit([paint('✗ usage: /session', 'error')])
          draw()
          return
        }
        sessionHub.open()
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
      name: 'worktrees',
      description: 'Choose a working directory, then a conversation in it',
      execute: async () => {
        // Directory-first, and deliberately not `/sessions` with a filter: a
        // working directory is not a session, so choosing one must not resume
        // whichever conversation happens to be newest in it. The second view
        // asks that question separately, and `+ New session` is its first row.
        //
        // Imported on demand, like `/plugins`, `/profiles`, `/connect`, and
        // `/sessions` above: the picker's module graph is one command's UI,
        // and nothing from it is on the boot path.
        //
        // Both plans are the ones `/sessions` and `/new` already use, and both
        // are passed as functions rather than decisions: the picker stays open
        // across turns, so busy and active-work are sampled AT THE MOMENT the
        // reader chooses. Retiring this agent for a worktree is exactly as
        // consequential as retiring it for a session, so it passes the same
        // checks.
        const { openWorktrees } = await import('./worktrees/index.ts')
        const chosen = await openWorktrees({
          ctx,
          currentSessionId: agent.session.id,
          // The header's own cwd, NOT the attachment's effective `workspace`
          // (`header.cwd ?? startup.cwd`). The fallback is right for an
          // operational directory and wrong for this presentation fact: a
          // cwd-less legacy session would otherwise mark whichever group
          // happens to match the launch directory as `current`, claiming the
          // open conversation is rooted where its header never said.
          ...(agent.session.header.cwd === undefined
            ? {}
            : { currentCwd: agent.session.header.cwd }),
          planResume: entry => planResume({
            target: entry,
            currentSessionId: agent.session.id,
            busy: agent.status === 'running',
            activeWork: activeWorkCount(work.snapshot()),
          }),
          planNew: () => planNew({
            busy: agent.status === 'running',
            activeWork: activeWorkCount(work.snapshot()),
          }),
          home: homedir(),
        })
        if (chosen === undefined) {
          draw()
          return
        }
        if (chosen.kind === 'resume') {
          // Silent, exactly as `/sessions` is: the reopened session announces
          // itself with its own resume banner.
          requestNext({ kind: 'resume', id: chosen.id })
        } else {
          // The same acknowledgement `/new` commits, because it is the same
          // act — only the directory differs.
          commit([paint('· starting a new session…', 'muted')])
          requestNext({ kind: 'new', cwd: chosen.cwd })
        }
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
      execute: () => { w.requestExit() },
    },
    {
      name: 'quit',
      description: 'Leave the session, as ctrl-d does',
      execute: () => { w.requestExit() },
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
    const selected = selection.current
    return {
      busy: agent.status === 'running',
      tick,
      elapsedMs: turnStartedAt === undefined ? undefined : Date.now() - turnStartedAt,
      activityWord: primaryActivity(phase, cards.semanticActivity()),
      activity: cards.inFlight(),
      attention: attention.current(),
      // The live selected route, route-qualified. This is the selected model
      // configuration, not a claim about the route a step already in assembly is
      // privately using: Harness captures `current` at `system-prompt/assemble`
      // start and publishes the captured value only after the downstream
      // assembly returns, and the ABA case (current moving away and back while
      // an assembly is paused) makes that private capture unobservable here. So
      // the footer reports only what `current` proves. Two provider routes can
      // advertise the same model id, so the route is named; there is no
      // discovery, no cache, and no parsing a provider from a string.
      model: selected === undefined ? undefined : `${selected.provider}/${selected.model}`,
      effort: effortLabel(selected?.reasoningEffort, w.modelInfo.reasoning),
      // The SAME snapshot one field over. Harness's `permissions` projection is
      // the effective current selection, folded from `permission/preset`,
      // `sandbox/mode`, `approval/policy`, and the composition defaults — not
      // from the preset event alone. The raw `currentValue` is the authority and
      // is opaque (a configured id, `auto`, or derived `custom`), so it is
      // rendered verbatim rather than resolved through the process catalog,
      // which answers only what is currently selectable. Absent when the
      // optional capability is not composed, which omits the segment.
      permission: projected?.values.permissions?.currentValue,
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
      compacting: compactionActive(),
      // Two authorities, joined in the adapter and nowhere else: the durable
      // goal comes out of the same cut as Todo and the context reading, adding
      // no further dshline snapshot, and the service is consulted — lazily,
      // only for an active projected goal — for process-local activation alone.
      goal: goalReading(projected, goalActivation),
    }
  })
  const streamView = { render: (columns: number, rows?: number): string[] => stream.live(columns, rows) }
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
   *
   * Durable only. Streamed assistant output does not arrive here at all — it is
   * process-local presentation carried by `agent/assistant-stream`, whose
   * listener is below — so this projection is exactly the committed transcript
   * and reads identically live and replayed.
   * @param event - the committed event.
   * @param columns - the terminal's current width.
   * @returns lines to write into scrollback.
   */
  const project = (event: SessionEvent, columns: number): string[] => {
    // Log-only, and stated rather than left to the default: one model attempt
    // that settled without committing a model-visible message. Whatever it
    // streamed was transient, so it is not an Assistant reply and gets no
    // transcript line — live or replayed.
    if (event.type === 'assistant/attempt') return []
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
    // The stream buffer is deliberately NOT touched here. A turn boundary used
    // to be the last chance to salvage streamed text, because the old log could
    // end a turn after streamed chunks with no assembled message at all. Every
    // attempt now settles: a visible reply as `assistant/message`, a ctrl-c
    // prefix as the same event with `interrupted: true`, and an attempt that
    // produced no reply as the log-only `assistant/attempt`. Committing at the
    // turn boundary would therefore write a failed attempt into scrollback as
    // though the model had said it.
    if (event.type === 'turn/end') cards.reset()
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
      // The adopted generation puts the call identity and the outcome on the
      // tool-role MESSAGE itself; the per-call `tool-result` content block it
      // used to be wrapped in is gone, so there is no first-block probe left.
      const message = event.data.message
      return cards.result({
        callId: message.toolCallId,
        content: message.content,
        isError: message.isError === true,
        ...event.data.meta === undefined ? {} : { meta: event.data.meta },
        ...event.data.error === undefined ? {} : { error: event.data.error },
      }, columns)
    }
    lines.push(...projectEvent(event, columns))
    return lines
  }

  // The command registry is mutable and scoped. An overlay opened before a
  // preset change must repaint its footer before the next key is interpreted.
  scope.own(ctx.on('commands/change', () => { ctx.tuiSlots.invalidate() }))

  // Every durable event of THIS session, including `agent/inbox/spliced`. The
  // adopted generation applies the committed event to the session-projection
  // registry before `Session.append()` returns and publishes the Inbox's live
  // notifications after that commit, so a synchronous observer here must not
  // read pending state at all: it only requests a redraw. RedrawScheduler paints
  // in the check phase after the event-loop turn settles, and the status getter
  // then re-reads the authoritative `agent.inbox` — which is why this frontend
  // needs no second inbox listener and keeps no pending count of its own.
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
    // Live only. `project` above is also the replay path, so an event-derived
    // notice raised there would flash a resumed session's old compactions and
    // permission switches as if they had just happened. This listener sees only
    // events appended after it attached, which is exactly "just happened".
    attention.show(liveSessionAttention(event))
    draw()
  }))

  // Live assistant presentation, which is a different contract from the log
  // above it: `agent/assistant-stream` frames are process-local and transient,
  // and the loop appends the matching `assistant/message` or `assistant/attempt`
  // BEFORE the terminal frame, so the durable settlement is always already
  // projected by the time an attempt's `end` arrives here.
  //
  // Nothing in here is persisted and nothing here is a second transcript: the
  // frames move the live region and the activity/timing readings, and the only
  // rows they commit to scrollback are the completed lines of a reply the
  // reader is watching arrive.
  //
  // Filtered by the exact attached Agent even though the scoped dispatch
  // already narrows it: a subagent's frames reach this process too, and one
  // window projects one Agent.
  scope.own(ctx.on('agent/assistant-stream', ({ agent: source, frame }) => {
    if (source !== agent) return
    // The gate decides what is current; this listener owns only its own buffer.
    const decision = attempt.accept(frame)
    if (!decision.current) return
    if (decision.reset) stream.reset()
    const columns = terminal.columns()
    timer.observeFrame(frame)
    phase = modelPhaseAfterFrame(phase, frame)
    if (frame.type === 'chunk') {
      const { chunk } = frame
      // Reasoning is streamed as well as answered text. Dropping it left the
      // screen showing nothing but a spinner for as long as a reasoning model
      // thought, which reads as a hung process rather than a working one.
      if (chunk.type === 'text-delta') commit(stream.push('text', chunk.text, columns))
      else if (chunk.type === 'reasoning-delta') commit(stream.push('reasoning', chunk.text, columns))
    } else if (frame.type === 'end') {
      // The buffer belongs to exactly one attempt. A settled `assistant/message`
      // has already emptied it through `project`; every other ending — a failed
      // or retried attempt, a cancellation with nothing visible, an abandoned
      // attempt with no durable record at all — leaves transient text that is
      // not part of any reply, so it is dropped rather than committed. This is
      // also what stops the next attempt from inheriting it and settling against
      // a prefix the model never sent.
      stream.reset()
      attempt.end()
    }
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
   * Deliver one prompt to the attached Agent, admitting staged attachments first.
   *
   * Split out of {@link submit} because an attachment-only submission has no
   * line to adjudicate: an empty line is not a command, cannot name a skill,
   * and must not enter input history, so it reaches this directly while a typed
   * line arrives here only after the command and skill decisions above are done
   * with it.
   * @param line - the already-trimmed prompt text; empty for an attachment-only send.
   * @param submittedDelivery - the verb decided at the instant of submission.
   */
  const sendPrompt = async (line: string, submittedDelivery: Delivery): Promise<void> => {
    let blocks: readonly ContentBlock[] = []
    // The snapshot this submission owns, hoisted so the success path can consume
    // exactly it. `undefined` means nothing was staged, so there is nothing to
    // consume.
    let admitted: readonly AttachmentDraft[] | undefined
    if (drafts.size > 0) {
      if (attachmentAdmission !== undefined) {
        if (composer.isEmpty) composer.set(line)
        commit([paint('· attachments are still being sent; nothing else was sent', 'muted')])
        draw()
        return
      }
      const attachments = ctx.get('attachments')
      const fs = ctx.get('fs')
      if (attachments === undefined || fs === undefined) {
        // A profile can recompose between staging and send. The paths remain in
        // this session and the text returns to the composer; pretending the
        // message went without its attachments would be silent semantic loss.
        composer.set(line)
        commit([paint('✗ attachment became unavailable; nothing was sent', 'error')])
        draw()
        return
      }
      // Only the images have a model-modality question attached to them. A
      // verbatim file is a durable handle the request assembly projects to text
      // whatever route the prompt takes, so a text-only model is not this
      // frontend's call to make.
      if (
        drafts.images.length > 0
        && w.modelInfo.inputModalities !== undefined
        && !w.modelInfo.inputModalities.includes('image')
      ) {
        if (composer.isEmpty) composer.set(line)
        commit([paint(`✗ model ${selection.current?.model ?? 'selected'} does not support image input; nothing was sent`, 'error')])
        draw()
        return
      }
      const admission = new AbortController()
      attachmentAdmission = admission
      // The immutable snapshot, taken before any await. A draft staged after
      // this line is not part of this message and must survive its success.
      const batch = drafts.items
      admitted = batch
      const admissionSignal = AbortSignal.any([
        attachmentAbort.signal,
        admission.signal,
        AbortSignal.timeout(ATTACHMENT_ADMISSION_TIMEOUT_MS),
      ])
      try {
        blocks = await admitAttachmentBatch(batch, fs, attachments, workspace, admissionSignal)
        // Durable publication cannot be interrupted. Honour a reader
        // cancellation that arrived while it ran before any of those blocks can
        // reach an Agent inbox.
        admissionSignal.throwIfAborted()
      } catch (error: unknown) {
        if (scope.closed) return
        // Do not overwrite text typed while a slow filesystem or provider was
        // answering. The attempted line is already in session input history;
        // when the composer is still empty, restore it directly as well.
        if (composer.isEmpty) composer.set(line)
        if (admission.signal.aborted) {
          commit([paint('· attachment cancelled; nothing was sent', 'muted')])
          draw()
        } else {
          commit([paint(`✗ ${admissionFailure(error)}; nothing was sent`, 'error')])
          draw()
        }
        return
      } finally {
        if (attachmentAdmission === admission) attachmentAdmission = undefined
      }
      // Durable publication may finish after this attachment begins teardown.
      // Never let that stale completion enqueue into the Agent the window has
      // left.
      if (scope.closed) return
    }
    // An attachment-only send carries no text block at all. An empty one is not
    // the same message: it would put a blank turn of the reader's own words in
    // front of the attachments, in the log and in every later replay of it.
    const message = createUserMessage({
      content: [...line === '' ? [] : [{ type: 'text' as const, text: line }], ...blocks],
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
    // Consume the snapshot, never the whole ledger. `clear()` was equivalent
    // while the ledger held one kind and nothing could be staged mid-flight, but
    // the admission flag is released in the `finally` above, and a blanket clear
    // would then be a claim about whatever happened to be staged at this exact
    // moment. Naming the batch keeps the ownership local to the submission that
    // earned it.
    if (admitted !== undefined) drafts.consume(admitted)
    draw()
  }

  /**
   * The open inspector's dismisser, or undefined while none stands.
   *
   * One at a time by choice: a second bare `/goal` while the frame is up would
   * otherwise stack an identical overlay, and Esc would have to be pressed once
   * per copy. The flag, not the dismisser, is the guard: `openSurface` may invoke
   * the close callback synchronously while mounting, before the dismisser has
   * been assigned.
   */
  let goalInspectionOpen = false
  let dismissGoalInspection: (() => void) | undefined
  /**
   * Show the read-only goal inspector for this attachment.
   *
   * The reading is a closure, not a captured value: a live projection edit or a
   * process-local disarm repaints from the current authorities rather than from
   * whatever was true when the frame opened.
   */
  const openGoalInspection = (): void => {
    if (goalInspectionOpen) return
    goalInspectionOpen = true
    try {
      dismissGoalInspection = openSurface(ctx.tuiSlots, dismiss => createGoalOverlay({
        reading: () => goalInspection(projections.snapshot(), goalActivation),
        invalidate: () => { ctx.tuiSlots.invalidate() },
        close: () => {
          goalInspectionOpen = false
          dismiss()
        },
      }))
    } catch (error: unknown) {
      // `pushOverlay` can throw after the flag is set — a throwing listener on
      // its initial invalidation — and a latched flag would suppress every later
      // bare `/goal` in this session. The failure still propagates; only the
      // latch is rolled back.
      goalInspectionOpen = false
      throw error
    }
  }
  scope.own(() => { dismissGoalInspection?.() })

  /**
   * Handle one submitted line: a local gesture, a registered command, or a
   * prompt for the model.
   * @param text - the submitted line.
   */
  const submit = async (text: string, gesture: SubmitGesture = 'enter'): Promise<void> => {
    const line = text.trim()
    // The composer has already cleared a submitted buffer. Stop here rather than
    // turning spaces or pasted blank lines into an empty model message — unless
    // attachments are staged, which is a message with content even though nobody
    // typed a word.
    if (line === '' && drafts.size === 0) return
    // This is the reader's choice at the instant of submission. Attachment
    // admission can wait on storage or a slow filesystem; its completion must
    // not reinterpret the same key against a later turn state or preference.
    const submittedDelivery = chooseDelivery({
      running: agent.status === 'running',
      preference: prefs.busyEnter,
      gesture,
    })
    if (line === '') {
      // Attachments and no words: the reader composed this message with the
      // `/image` or `/attach` gesture instead of the keyboard. Nothing below has
      // anything to decide about it — an empty line names no command and no
      // skill, and recording it in input history would put a blank entry under `↑`.
      await sendPrompt(line, submittedDelivery)
      return
    }
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
    // A semantically BARE `/goal` is presented here rather than sent to the
    // registry, because the native show form has no argument and no lifecycle
    // to run: opening a read-only inspector executes nothing and appends no
    // command, goal, or session event. The definition-id gate is load-bearing —
    // it checks that the EFFECTIVE command declares Harness's native goal
    // identity, so an agent-scoped shadow that declares a different or no
    // identity is left for the registry to run. A shadow that declares the SAME
    // identity is presenting itself as the native command; distinguishing that
    // from the Harness package is not something the registry exposes, and
    // registering a command in an agent scope is already a trusted act. Any
    // argument-bearing form falls through too, and so does a bare line carrying
    // staged attachments: native create/edit admit attachments while native show
    // rejects them, and that adjudication is Harness's, not this frontend's.
    if (
      parsed?.name === 'goal'
      && parsed.rawInput.trim() === ''
      && drafts.size === 0
      && ctx.commands.find(agent, parsed.name)?.definitionId === GOAL_COMMAND_DEFINITION_ID
    ) {
      // `pushOverlay` invalidates as it mounts, so this paints through the
      // window's normal `tui/render` path; a second `draw()` here would only
      // request the coalesced redraw twice.
      openGoalInspection()
      return
    }
    // Harness owns `/permission`; this is only a terminal presentation for its
    // bare form. Keeping it outside the local registry leaves discovery,
    // completion, validation, and lifecycle events with the registered command.
    let commandLine = line
    if (
      parsed?.name === 'permission' &&
      parsed.rawInput.trim() === '' &&
      ctx.commands.list(agent).some(command => command.name === 'permission')
    ) {
      // Two reads, here and not earlier, because the catalog is live process
      // state: holding one would make this frontend a second authority on what
      // is selectable. Both seams are optional; missing either, the adapter
      // returns nothing and the bare command goes to Harness unchanged.
      const picker = permissionPicker(
        ctx.get('permissionPresets')?.catalog(),
        projections.snapshot()?.values.permissions,
      )
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
    // The generic admission flag, not an image-specific one: Harness decides
    // whether a command may receive composer attachments at all. dshline still
    // authors only the kind it can author end to end — image drafts — and
    // declines before dispatch rather than letting the registry reject the
    // batch, so the drafts survive for a correction.
    if (drafts.images.length > 0 && registeredCommand !== undefined && registeredCommand.input?.attachments !== true) {
      commit([paint(`✗ /${parsed?.name ?? 'command'} does not accept image attachments; drafts were kept`, 'error')])
      draw()
      return
    }
    // The other half, and deliberately the opposite decision. A command that
    // declares no attachment input has told us it takes none, so the staged
    // files were never going to be part of this invocation either way: running
    // it is what the reader asked for, and the drafts staying staged is the
    // honest outcome. Refusing here — as `/image` must — would make `/attach`
    // block commands a reader has every reason to run.
    if (drafts.files.length > 0 && registeredCommand !== undefined && registeredCommand.input?.attachments === true) {
      // Here the command DID ask for attachments and this frontend has no
      // legitimate way to deliver a generic file. The adopted command contract
      // admits a file only as a staged upload receipt resolved by the Session
      // upload owner, and no such owner is mounted here: taking the slot
      // ourselves would make this terminal the receipt authority for a product
      // boundary Harness owns, and inventing a receipt id would be a fabricated
      // reference. So the invocation is refused out loud, the line stays in input
      // history, and the drafts stay exactly where they were.
      commit([paint(`✗ /${parsed?.name ?? 'command'} needs files uploaded before it can run; staged files were kept`, 'error')])
      draw()
      return
    }
    const outcomesBefore = commandOutcomes
    let execution: Awaited<ReturnType<typeof ctx.commands.execute>>
    let admission: AbortController | undefined
    // The drafts THIS submission admitted, if any. `undefined` means the
    // command received no attachment envelope and therefore owns no drafts: a
    // command that merely happens to be running must not consume what the
    // reader stages while it is in flight. Set before any await, so the success
    // path below reads the submission-owned batch rather than whatever the
    // shared ledger holds when the command settles.
    let admittedImages: readonly ImageDraft[] | undefined
    const isCompactionCommand = registeredCommand?.name === 'compact'
    if (isCompactionCommand) {
      compactCommandsInFlight += 1
      draw()
    }
    try {
      let commandAttachments: readonly CommandSubmitAttachment[] = []
      if (drafts.images.length > 0 && registeredCommand?.input?.attachments === true) {
        const attachments = ctx.get('attachments')
        const fs = ctx.get('fs')
        if (attachments === undefined || fs === undefined) {
          commit([paint('✗ image attachment became unavailable; drafts were kept', 'error')])
          draw()
          return
        }
        if (attachmentAdmission !== undefined) {
          commit([paint('· attachments are still being sent; nothing else was sent', 'muted')])
          draw()
          return
        }
        admission = new AbortController()
        attachmentAdmission = admission
        // The mutable ledger remains visible for listing, but this command owns
        // precisely the paths present when its admission began. Recording that
        // ownership here, before the read and execute awaits, is what lets the
        // success path consume exactly this batch.
        const batch = drafts.images
        admittedImages = batch
        let inputs
        try {
          inputs = await readImageDrafts(
            batch,
            fs,
            workspace,
            attachments.imageLimits.maxImageBytes,
            attachments.imageLimits.maxMessageImageBytes,
            AbortSignal.any([attachmentAbort.signal, admission.signal, AbortSignal.timeout(ATTACHMENT_ADMISSION_TIMEOUT_MS)]),
          )
        } catch (error: unknown) {
          if (scope.closed) return
          if (composer.isEmpty) composer.set(line)
          if (admission.signal.aborted) {
            commit([paint('· image attachment cancelled; drafts were kept', 'muted')])
          } else {
            commit([paint(`✗ ${admissionFailure(error)}; drafts were kept`, 'error')])
          }
          draw()
          return
        }
        if (scope.closed) return
        // The submission envelope is discriminated, and dshline produces the
        // one member it can author. A file receipt is the other variant of
        // `CommandSubmitAttachment`, and staging files is a UI this frontend
        // does not have — so the discriminator is added here rather than making
        // the image helper aware of the commands package.
        commandAttachments = encodeCommandImages(inputs).map(image => ({ type: 'image', ...image }))
      }
      execution = await ctx.commands.execute(
        agent,
        commandLine,
        commandAttachments,
        admission === undefined
          ? AbortSignal.any([
            attachmentAbort.signal,
            AbortSignal.timeout(isCompactionCommand ? COMPACTION_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS),
          ])
          : AbortSignal.any([
            attachmentAbort.signal,
            admission.signal,
            AbortSignal.timeout(COMMAND_TIMEOUT_MS),
          ]),
      )
    } catch (error: unknown) {
      if (scope.closed) return
      if (drafts.size > 0 && composer.isEmpty) composer.set(line)
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
      if (admission !== undefined && attachmentAdmission === admission) attachmentAdmission = undefined
      if (isCompactionCommand) {
        compactCommandsInFlight -= 1
        draw()
      }
    }
    if (execution !== undefined) {
      if (scope.closed) return
      // Consume exactly the batch this submission admitted. A command that
      // admitted nothing owns nothing, so a successful command that ran with
      // no staged images must not clear drafts the reader staged while it was
      // in flight — that global clear was the bug. Staged FILES are never
      // consumed here: the envelope above carries no file member, so this
      // command was handed no file and owns none.
      if (execution.result.kind === 'success') {
        if (admittedImages !== undefined) drafts.consume(admittedImages)
      } else if (drafts.size > 0 && composer.isEmpty) composer.set(line)
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
    await sendPrompt(line, submittedDelivery)
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
   *
   * History is already fully seeded by the time any keystroke can reach here —
   * the replay is synchronous — so the overlay never has to report a corpus that
   * is still arriving.
   */
  const openHistorySearch = (): void => {
    completion.invalidate()
    const search = new HistorySearch(history)
    openSurface(ctx.tuiSlots, close => createHistorySearchOverlay({
      search,
      invalidate: () => { ctx.tuiSlots.invalidate() },
      settle: index => {
        close()
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
    }))
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
    const columns = terminal.columns()
    const geometry = {
      width: composerInner(columns),
      gutter: (line: number): string => composerGutter(line, columns),
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
    // The draft before the action, but ONLY when a recalled history entry is being
    // looked at. Deciding that needs both the old and the new text; deciding
    // anything else does not, and a draft can hold a very large folded paste whose
    // full value is not worth joining twice for every keystroke merely to learn
    // something already known — there is no saved traversal to abandon.
    const wasNavigating = history.navigating
    const valueBeforeAction = wasNavigating ? composer.value : undefined
    const action = composer.handle(key)
    if (action.kind === 'submit') {
      // Whatever was being completed is gone with the line, and any lookup it
      // had in flight must not land afterwards.
      completion.invalidate()
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
      // Outside that traversal there is nothing to compare against and nothing to
      // reset, so the second join of the draft is skipped as well as the first.
      const edited = valueBeforeAction === undefined ? false : history.resetIfEdited(valueBeforeAction, composer.value)
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
      // The composer reports an empty buffer's enter as `ignored` rather than as
      // an empty submit, deliberately: what nothing means is the caller's
      // business, and the renderer holds no Harness vocabulary to decide it.
      // Here it means one thing — staged attachments are a message. The reader
      // composed it with the `/image` gesture instead of the keyboard, and
      // refusing to send it would leave the only way to send an image being to
      // type something beside it.
      case 'enter':
      case 'ctrl-enter': {
        if (drafts.size === 0) return
        completion.invalidate()
        draw()
        submit('', action.key.name === 'ctrl-enter' ? 'accelerated' : 'enter').catch(report)
        return
      }
      case 'ctrl-c': {
        if (attachmentAdmission !== undefined) {
          attachmentAdmission.abort(new Error('Attachment admission cancelled by the reader.'))
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
        // An idle parent can still own a background Job or continuable child.
        // `ctrl-c` is the interrupt-or-quit boundary, not the explicit `ctrl-d`
        // exit boundary, so do not retire the session while Harness still
        // publishes owned work. The Job/subagent snapshot is the generic
        // authority here; never infer ownership from provider processes.
        const snapshot = work.snapshot()
        if (activeWorkCount(snapshot) > 0) {
          const summary = workSummary(snapshot) ?? 'active work'
          commit([paint(`· ${summary} still attached to this session.`, 'muted')])
          draw()
          return
        }
        w.requestExit()
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
          openSurface(ctx.tuiSlots, close => createToolOutputOverlay({
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
            close,
            invalidate: () => { ctx.tuiSlots.invalidate() },
          }))
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

  if (attached.reopened && target.kind === 'resume') {
    // The transcript is rebuilt from the Session the resumed Agent already owns,
    // not from a second read of persistence: `agents.resume` has opened the log,
    // repaired an interrupted final turn, constructed the Session, and published
    // it, so `agent.session` is the exact repaired state this attachment goes on
    // from. The whole block is synchronous, which is what makes one snapshot a
    // fixed boundary: the `session/event` listener above is already registered,
    // so an append after the snapshot is delivered live exactly once, and an
    // event already in the snapshot is one this listener did not deliver.
    // (Constructor-seed events are never published at all; events appended
    // between resume and this listener belong to the snapshot alone.)
    //
    // Replayed through the same projection the live listener uses, so a resumed
    // session reads exactly like the one that was watched happen. Committed in
    // ONE write: an event-by-event commit would redraw the live region thousands
    // of times to produce a screen nobody sees until the end of it.
    //
    // Without the early draw, a reopened session's composer and status stayed
    // invisible — keystroke routing already live — for however long projecting
    // the log took: on a real transcript that is a multi-hundred-millisecond
    // blank screen with a live cursor, and `ready` is a claim the reader has no
    // history to check yet.
    replaying = 'resuming session…'
    // Painted synchronously at the moment the replay begins: the projection and
    // flood commit that follow are one event-loop block, so a coalesced paint
    // has no guaranteed slot before the flood.
    w.paintNow()
    const replayed = transcriptEvents(agent.session)
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
    // Only the cards need clearing. A log can end mid-turn with a call whose
    // result never landed, but it cannot end mid-reply as far as this buffer is
    // concerned: the replay feeds it nothing but settled `assistant/message`
    // events, each of which commits its own remainder and leaves it empty.
    cards.reset()
    commit([...lines, ...resumeBanner(replayed.length)])
    // The replay is over, so the status can honestly say `ready`.
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

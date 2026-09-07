/**
 * The `/worktrees` command: what it needs, and how a choice becomes a transition.
 *
 * The invariant this module protects is that one dshline window drives one
 * root Session. `/worktrees` does not open a tab, a pane, or a second agent —
 * it resolves to exactly the same two attachment targets `/sessions` and
 * `/new` already produce, and hands them to the window's own transition:
 *
 * ```text
 * current attachment
 *     ↓ retire (the owned AgentHandle disposer)
 * next target
 *     ↓
 * ctx.agents.resume({ resumeSessionId })      an existing conversation
 * ctx.agents.create({ meta: { cwd } })        a fresh one in the chosen directory
 *     ↓
 * next attachment
 * ```
 *
 * Nothing else is written. A fresh session becomes a member of the directory's
 * group because Harness stamps `cwd` into its immutable header, which is the
 * grouping rule itself — there is no membership record to update, and no
 * durable state in dshline at all.
 *
 * Parallel work across directories is therefore still several terminals, each
 * rooted in its own — which is what the shell already gives, and what a
 * multiplexer inside the frontend would take over badly.
 * @module dshline/worktrees
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type { SessionEntry } from '../sessions/model.ts'
import type { NewPlan, ResumePlan } from '../sessions/plan.ts'
import { WorktreeCatalog } from './catalog.ts'
import type { WorktreeChoice, WorktreeRow } from './model.ts'
import { createWorktreesOverlay } from './overlay.ts'

export type { WorktreeCatalogSpec } from './catalog.ts'
export { WorktreeCatalog } from './catalog.ts'
export type {
  WorktreeChoice,
  WorktreeListing,
  WorktreeRow,
  WorktreeSelection,
  WorktreeSessionRow,
} from './model.ts'
export {
  listingMessage,
  matchesWorktree,
  sessionCountLabel,
  sessionsMessage,
  worktreeLabel,
  worktreePath,
  worktreeRows,
  worktreeSessionRows,
} from './model.ts'
export type { WorktreesOverlaySpec } from './overlay.ts'
export { createWorktreesOverlay } from './overlay.ts'

/** What opening the picker needs to know about the window it opens over. */
export interface WorktreesSpec {
  /** Context carrying the session corpus and the slot registry. */
  readonly ctx: Context
  /** The session this window is driving. */
  readonly currentSessionId: SessionId
  /**
   * The directory the attached session is rooted in.
   *
   * Its header's own `cwd`. Used only to mark the current row; never to
   * re-root anything.
   */
  readonly currentWorkspace: string
  /**
   * Decide whether reopening one session is safe right now.
   *
   * The whole plan rather than the conditions it reads, and a function rather
   * than a value: the picker stays open across turns, so the busy and
   * active-work facts have to be sampled at the instant `enter` is pressed.
   * It is the same `planResume` `/sessions` uses — retiring this agent for a
   * directory is exactly as consequential as retiring it for a session, and
   * this offers no stronger resume promise than `/sessions` does.
   */
  readonly planResume: (entry: SessionEntry) => ResumePlan
  /** Decide whether retiring this attachment for a fresh session is safe right now. */
  readonly planNew: () => NewPlan
  /** The user's home directory; injected so path shortening is assertable. */
  readonly home: string
  /** Current time; injected so relative ages are assertable. */
  readonly now?: () => number
}

/**
 * Show the `/worktrees` picker and wait for the reader's answer.
 *
 * Resolves with a transition only when the reader chose one AND its plan
 * accepted it, so the caller never re-checks the conditions. Dismissing, or
 * choosing something a plan refused, resolves with undefined.
 * @param spec - the context, the attached session, and the live plans.
 * @returns the attachment transition to request, or undefined.
 */
export async function openWorktrees(spec: WorktreesSpec): Promise<WorktreeChoice | undefined> {
  const { ctx } = spec
  const catalog = new WorktreeCatalog({
    query: ctx.get('sessionQuery'),
    invalidate: () => { ctx.tuiSlots.invalidate() },
    currentWorkspace: spec.currentWorkspace,
    ...(spec.now === undefined ? {} : { now: spec.now }),
  })
  catalog.refresh()
  try {
    return await new Promise<WorktreeChoice | undefined>(resolve => {
      let dismiss = (): void => {}
      let settled = false
      let chosen: WorktreeChoice | undefined
      const settle = (): void => {
        // Once-only, for the reason every overlay here settles once: the slot
        // registry can deliver one more keystroke between the decision and the
        // unmount.
        if (settled) return
        settled = true
        dismiss()
        resolve(chosen)
      }
      const overlay = createWorktreesOverlay({
        listing: () => catalog.listing(),
        selection: () => catalog.selection(),
        open: cwd => { catalog.select(cwd) },
        back: () => { catalog.select(undefined) },
        resume: entry => {
          const plan = spec.planResume(entry)
          // Id alone. A resumed session's own header cwd stays authoritative,
          // so this transition carries no directory of any kind.
          if (plan.kind === 'resume') chosen = { kind: 'resume', id: entry.id }
          return plan
        },
        create: (row: WorktreeRow) => {
          const plan = spec.planNew()
          if (plan.kind === 'new') chosen = { kind: 'new', cwd: row.cwd }
          return plan
        },
        currentSessionId: spec.currentSessionId,
        home: spec.home,
        now: spec.now ?? ((): number => Date.now()),
        close: settle,
        invalidate: () => { ctx.tuiSlots.invalidate() },
      })
      dismiss = ctx.tuiSlots.pushOverlay(overlay)
    })
  } finally {
    // In-flight corpus and session reads are abandoned with the picker: their
    // results would repaint a live region that has moved on.
    catalog.dispose()
  }
}

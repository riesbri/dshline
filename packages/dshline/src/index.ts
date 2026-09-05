/**
 * The interactive terminal runner.
 *
 * A resident, multi-turn version of the one-shot direct driver: wait for the
 * Loader to settle, attach an Agent, then drive it with `followup` while idle and
 * `steer` while running, projecting its session log into the terminal.
 *
 * This file is the plugin and the loop, and nothing else. Two lifetimes carry the
 * work: `./window.ts` owns the terminal, key routing, the model route, and the
 * reader's preferences for as long as the plugin lives, and `./attachment.ts`
 * owns one Agent and everything projected from its log. `/sessions` retires an
 * attachment and asks for the next one, which is the whole reason the second
 * lifetime had to become explicit — and the reason the loop below is a loop.
 *
 * The model-facing tool rows this bundle's own `cordis.patch.yml` disables
 * on `dsh-base`'s layer live on the agent-preset plane instead: `attachOptions`
 * (`window.ts`) composes every agent this loop attaches from its resolved
 * preset — the session's own recorded choice on resume (falling back to
 * `standard` for a session produced before this bundle adopted presets, so
 * old history is never silently rebuilt under today's default, and to the
 * deployment's own default WITH the substitution reported where no usable
 * `standard` exists), the roster's default on a fresh one — inside the one
 * supported `setup(agentCtx)` window. A profile that mounts no `agentPresets` seam at
 * all leaves that step a no-op; it does NOT by itself restore the old flat
 * `dsh-base` tool set, since the disables in `cordis.patch.yml` apply
 * unconditionally. Removing the seam from an otherwise-stock composition
 * leaves an agent with no tools at all — the no-op only matters for a
 * deployment that never applied this bundle's own disable list to begin
 * with.
 * @module dshline
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
// Carries the Context merge for the launcher's exit request, which the boot
// failure path below reports through.
import type {} from '@deepseek-ai/dsh-cmdline'
import { attachSession } from './attachment.ts'
import type { BusyEnter } from './delivery.ts'
import { pluginsSeams } from './plugins/harness.ts'
import type { AttachTarget } from './sessions/reopen.ts'
import { attachTarget, newSessionFailureLines, reopenFailureLines } from './sessions/reopen.ts'
import { installDshlineSettings } from './settings.ts'
import type { DshlineSettings } from './settings.ts'
import { TuiSlots } from './slots.ts'
import type { ModelRates, PeakWindow, PricingTable } from './usage.ts'
import { parsePeakWindows, pricingFrom } from './usage.ts'
import { attachOptions, chooseTarget, createWindow, offerSetup } from './window.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'dshline'

/**
 * The runner needs the invocation, the agent registry, the interaction seams,
 * and the model registry. `tuiStartup` is published only on an interactive
 * launch, so a piped run leaves this row unmounted.
 */
export const inject = ['tuiStartup', 'agents', 'userQuestions', 'commands', 'llm', 'tools']

/** Experimental pre-1.0 slot vocabulary; no stable dshline plugin SDK exists yet. */
export type { TuiOverlay, TuiSlotName, TuiSlotView } from './slots.ts'
/** Experimental pre-1.0 live-region registry; see {@link TuiOverlay}. */
export { TuiSlots } from './slots.ts'

/** Reported in the banner; sync-version.mjs keeps it aligned with the manifest. */
const VERSION = '0.17.0'

/**
 * What a deployment can configure about this frontend.
 *
 * Prices are configuration rather than a shipped table because no rate is true
 * for long, and one baked into a release would keep reporting the number it was
 * built with. A route with no entry shows tokens and no money, which is the
 * honest reading — see {@link parsePricing}.
 */
export interface Config {
  /**
   * Dollars per million tokens, keyed `provider/model` — e.g.
   * `deepseek-official/deepseek-v4-flash` — or by model id alone to cover every
   * route serving it. An entry replaces the shipped rates for that key outright.
   */
  pricing?: Readonly<Record<string, ModelRates>>
  /**
   * UTC windows charged at the standard rate, as `HH:MM` pairs. Every other hour
   * is off-peak. Omitted, the provider's published schedule applies.
   */
  peakHoursUtc?: readonly { from: string; to: string }[]
  /**
   * The palette new windows open with, by id.
   *
   * This is the `base` layer of the `dshline` settings namespace: a deployment
   * composes a default here, and a reader's own `settings.yaml` overrides it.
   * `/theme` writes the user layer, never this one. An id no shipped palette
   * has is refused by that namespace’s schema, not parsed around here.
   */
  theme?: string
  /**
   * What plain `enter` does while a turn is running: `queue` places the line on
   * the agent's next-turn list as a follow-up of its own, `steer` hands it to
   * the running turn at its nearest step boundary.
   *
   * The same `base` layer as {@link Config.theme}, and `/enter` writes the user
   * layer over it. Omitted, new windows open on `queue`, matching the adopted
   * Harness generation's own Web default.
   */
  busyEnter?: BusyEnter
  /**
   * Whether this frontend emits terminal BEL when it presents a live human
   * interaction. This is the `base` layer of the same `dshline` settings
   * namespace as the other reader preferences; omitted, it is enabled.
   */
  attentionBell?: boolean
}

/**
 * Mount the terminal frontend.
 * @param ctx - plugin context carrying the harness services and the invocation.
 * @param config - this row's configuration, when a bundle or patch supplied one.
 */
export function apply(ctx: Context, config?: Config): void {
  // Parsed once, at mount: a malformed price must be reported as a missing price
  // rather than re-examined on every frame the status line draws.
  const pricing = pricingFrom(config?.pricing)
  const peakHours = parsePeakWindows(config?.peakHoursUtc)
  // Registered on the plugin context, so the namespace lives as long as this
  // row does. Harness owns the layering and the validation from here.
  const settings = installDshlineSettings(ctx, {
    ...config?.theme === undefined ? {} : { theme: config.theme },
    ...config?.busyEnter === undefined ? {} : { busyEnter: config.busyEnter },
    ...config?.attentionBell === undefined ? {} : { attentionBell: config.attentionBell },
  })
  ctx.plugin(TuiSlots)
  ctx.inject(['tuiSlots'], hostCtx => {
    // A rejected boot must be reported and exit non-zero. Discarding it would
    // leave the process alive holding a terminal it never painted, which is the
    // same silent-idle failure the non-TTY guard exists to prevent.
    run(hostCtx, pricing, peakHours, settings).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      // Carriage return included: raw mode may already be on, where a bare
      // newline leaves the next line indented to the cursor column.
      process.stderr.write(`dshline: ${message}\r\n`)
      hostCtx.get('appExit')?.(1)
    })
  })
}

/**
 * Own the terminal for the life of this plugin and drive its sessions.
 *
 * Never resolves in normal use: each attachment settles only when the reader
 * chooses the next session, and leaving is `ctx.appExit`. Nothing awaits this
 * promise, which is why an endless loop is the right shape rather than a leak —
 * the alternative, returning after the first session, is what made reopening one
 * impossible.
 *
 * Opening the agent happens HERE rather than inside the attachment, because a
 * failed reopen is a decision about what the WINDOW does next: by the time it
 * fails, the previous agent is already retired, so no session is left to answer
 * for it.
 * @param ctx - context with the slot registry available.
 * @param pricing - rates for the usage meter, already validated.
 * @param peakHours - when those rates charge the standard price.
 * @param settings - the registered `dshline` namespace, read for the window.
 */
async function run(
  ctx: Context,
  pricing: PricingTable,
  peakHours: readonly PeakWindow[],
  settings: DshlineSettings,
): Promise<void> {
  const w = await createWindow(ctx, { pricing, peakHours, version: VERSION, settings })
  // Before the first target, and before any session exists: a window whose
  // Harness registers no provider route cannot send a turn, so the useful
  // thing to open is the flow that fixes that rather than a composer that
  // will fail on submission. It returns immediately when a route is
  // registered, which is every ordinary launch.
  await offerSetup(w)
  // The launch flag decides the FIRST target only. Everything after it is the
  // reader's own choice, made through the session browser or `/new`.
  let target: AttachTarget = w.startup.resume === undefined
    ? { kind: 'new' }
    : w.startup.resume === true
      ? await chooseTarget(w)
      : { kind: 'resume', id: SessionId(w.startup.resume) }
  for (;;) {
    const outcome = await attachTarget({
      agents: ctx.agents,
      newSessionId: () => SessionId(`dshline-${randomUUID()}`),
      cwd: w.startup.cwd,
      // Stamped into the new session's header so a LATER resume recovers the
      // same id even after the roster's default has since changed — a session
      // keeps the preset it was created with, not whatever is current default
      // today. The header is where Harness's own `agentPreset` Session
      // projection starts, and `mountAgentPreset` reads that projection inside
      // `setup(agentCtx)`.
      newSessionPreset: () => pluginsSeams(ctx).agentPresets?.defaultId,
      options: attachOptions(w),
      report: (kind, reason) => {
        w.commit(kind === 'new' ? newSessionFailureLines(reason) : reopenFailureLines(reason))
      },
      ask: () => chooseTarget(w),
    }, target)
    target = await attachSession(w, outcome)
  }
}

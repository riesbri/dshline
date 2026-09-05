/**
 * What dshline can truthfully say about its own installation, and where each
 * answer comes from.
 *
 * Setup exists because a person can reach a working profile and still have no
 * model, and the reasons are spread across surfaces they would otherwise have
 * to know the names of. This module gathers those surfaces once. It reads
 * nothing it does not already have an authority for, and every answer it
 * cannot establish is an explicit "unknown" rather than a default:
 *
 * ```
 * Harness generation    package manifests on disk, via ../profiles/harness.ts
 * the running profile   the same reading (ctx.dshHomePath + ctx.baseUrl)
 * routes, sign-ins,     ../connect/catalog.ts — the SAME pass `/connect` draws
 *   credentials, seams
 * ```
 *
 * The connect reading is deliberately the real `ConnectCatalog` rather than a
 * cheaper summary of its inputs. Setup's whole claim is "here is why `/model`
 * has nothing to offer," and any second, simpler gathering would be a second
 * opinion about it — one that could tell a reader their route was dormant
 * while `/connect`, a keystroke later, said otherwise.
 *
 * ## Why the Harness generation is read off disk
 *
 * Harness publishes no runtime version service at the adopted generation.
 * There is no `ctx.version`, `dsh-brand` carries only compile-time branding,
 * and `dsh-plugin-package-inventory-deepseek` builds a package list solely as
 * request metadata for the official API — nothing a surface can ask. So the
 * only evidence is manifests, which is exactly what `/profiles` already reads
 * and tests: {@link readProfiles} resolves each bundle through the two
 * directories a bundle can live in, in Harness's own documented order.
 *
 * The two sides of the comparison:
 *
 * - **Adopted** — this package's own `peerDependencies`. That is the
 *   repository's real authority and not a copy of one:
 *   `tools/harness-target.mjs` and its spec fail the suite unless every
 *   `dsh-*` spec in this manifest is exactly `HARNESS_TARGET.version`, so
 *   there is no constant here to drift and no example version written down.
 * - **Installed** — the running profile's `@deepseek-ai/dsh-base` version.
 *   Upstream cuts one version across every package in a release commit, so a
 *   bundle's version IS the generation.
 *
 * Node is deliberately reported WITHOUT a verdict. The one thing a check here
 * could add is whether this runtime satisfies `engines`, and answering that
 * means evaluating a semver range — a version-compatibility engine, which is
 * the thing this repository refuses to grow and has no dependency budget for.
 * The version itself is what a bug report asks for, so it is reported as a
 * fact and nothing is claimed about it.
 * @module dshline/setup/harness
 */

import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ConnectCatalog, connectSeams } from '../connect/index.ts'
import type { ConnectState } from '../connect/index.ts'
import { readProfiles } from '../profiles/harness.ts'
import type { ProfileRow } from '../profiles/harness.ts'
import { setupReason } from './model.ts'
import type { SetupReason } from './model.ts'

/**
 * The bundle whose installed version stands for the Harness generation.
 *
 * `dsh-base` specifically: it is the layer every base-backed profile composes
 * — `DEFAULT_PROFILE_BUNDLES` is exactly this one name — so it is present for
 * any profile dshline's own first run created. A profile that composes
 * something else answers "unknown" rather than being probed for some other
 * package whose numbering this comparison has not established.
 */
const GENERATION_BUNDLE = '@deepseek-ai/dsh-base'

/**
 * The peer whose pinned version states the adopted generation.
 *
 * Any `dsh-*` peer would do — `tools/harness-target.mjs` proves by string
 * equality that they all carry the same exact version — so one is named
 * rather than all of them compared, and this is the one seam `/connect`,
 * `/model`, and the window all read.
 */
const GENERATION_PEER = '@deepseek-ai/dsh-llm'

/** How the installed Harness generation compares with the adopted one. */
export type HarnessGeneration =
  /** Both were read and they agree. */
  | { readonly kind: 'match'; readonly version: string }
  /** Both were read and they differ. */
  | { readonly kind: 'mismatch'; readonly adopted: string; readonly installed: string }
  /**
   * At least one side could not be read, so nothing is claimed about either.
   * Whichever side WAS read is still carried, because half an answer is worth
   * printing and is not worth guessing the other half from.
   */
  | { readonly kind: 'unknown'; readonly adopted: string | undefined; readonly installed: string | undefined }

/** Everything one setup pass established. */
export interface SetupFacts {
  /** The Node this process runs on. Reported, never judged; see the module note. */
  readonly node: string
  /** This frontend's version, from the one constant the banner already prints. */
  readonly dshline: string
  /** How the installed Harness generation compares with the adopted one. */
  readonly harness: HarnessGeneration
  /** The profile this Host booted, or undefined when it cannot be determined. */
  readonly profile: string | undefined
  /**
   * The same reading `/connect` draws: routes, sign-ins, mounted seams, and
   * which sign-ins are authorized against a route nothing has registered.
   */
  readonly connect: ConnectState
  /**
   * The selection the next turn would use, read from the window's own ref —
   * the same one `/model` writes — rather than resolved a second time here.
   */
  readonly selected: SetupSelection | undefined
  /**
   * Why this launch cannot send a turn, or undefined when it can. Carried on
   * the facts so the report and the offered steps answer from one judgement
   * instead of each re-deriving it.
   */
  readonly reason: SetupReason | undefined
}

/** The parts of a model selection setup reports and reasons about. */
export type SetupSelection = Pick<ModelSelection, 'provider' | 'model'>

/**
 * The Harness generation this build of dshline adopted.
 *
 * Read from the manifest rather than a constant, because a constant would be a
 * second place for the target to be written down and a third thing for a
 * release check to keep in step. The manifest ships in every published tarball
 * (npm always includes it), and `src/` and `lib/` are siblings, so the same
 * relative path resolves whether this module was loaded from source in a test
 * or from the compiled output in a profile.
 * @returns the version every `dsh-*` peer is pinned to, or undefined when the
 *   manifest cannot be read or pins nothing.
 */
export function adoptedGeneration(): string | undefined {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { peerDependencies?: Record<string, unknown> }
    const pinned = manifest.peerDependencies?.[GENERATION_PEER]
    return typeof pinned === 'string' && pinned !== '' ? pinned : undefined
  } catch {
    // A manifest that cannot be read or parsed is an unknown adopted
    // generation, which the report says. It is never a reason to fail setup:
    // the reader still has every other check and every offered step.
    return undefined
  }
}

/**
 * Compare what is installed against what was adopted.
 * @param adopted - the adopted generation, when it could be read.
 * @param installed - the installed generation, when it could be read.
 * @returns the comparison, with `unknown` whenever either side is missing.
 */
export function compareGenerations(
  adopted: string | undefined,
  installed: string | undefined,
): HarnessGeneration {
  if (adopted === undefined || installed === undefined) return { kind: 'unknown', adopted, installed }
  // String equality, exactly as `tools/harness-target.mjs` compares: dshline
  // adopts ONE generation, so "does this version fall in a supported range" is
  // not a question anything here is entitled to answer.
  if (adopted === installed) return { kind: 'match', version: adopted }
  return { kind: 'mismatch', adopted, installed }
}

/**
 * Read every surface setup reports on, once.
 * @param ctx - the plugin context carrying the Harness seams.
 * @param version - this frontend's version, from the runner's own constant.
 * @param selected - the window's current model selection, when it has one.
 * @returns the facts, with each unreadable one marked rather than defaulted.
 */
export async function gatherSetupFacts(
  ctx: Context,
  version: string,
  selected: SetupSelection | undefined,
): Promise<SetupFacts> {
  // One `ConnectCatalog`, disposed immediately: it holds a rendered snapshot
  // and nothing else, and setup wants the snapshot rather than a live browser.
  // `invalidate` is a no-op because nothing here is on screen — the report is
  // committed to scrollback, not painted into the live region.
  const catalog = new ConnectCatalog({ seams: connectSeams(ctx), invalidate: () => {} })
  let connect: ConnectState
  try {
    connect = await catalog.reread()
  } finally {
    catalog.dispose()
  }
  return {
    node: process.versions.node,
    dshline: version,
    harness: compareGenerations(adoptedGeneration(), await installedGeneration(ctx)),
    profile: await currentProfile(ctx),
    connect,
    selected,
    // Judged from the registry directly rather than from `connect.providers`,
    // so the reason a launch was interrupted and the reason it stays open are
    // the same one sentence of logic.
    reason: setupReason(ctx.llm.listProviders().map(provider => provider.id), selected),
  }
}

/**
 * The Harness generation this profile actually composes.
 * @param ctx - the plugin context.
 * @returns the installed `dsh-base` version, or undefined when the profiles
 *   root, the booted profile, or that bundle's manifest could not be read.
 */
async function installedGeneration(ctx: Context): Promise<string | undefined> {
  const current = await currentProfileRow(ctx)
  return current?.bundles.find(bundle => bundle.packageName === GENERATION_BUNDLE)?.version
}

/**
 * The name of the profile this Host booted.
 * @param ctx - the plugin context.
 * @returns the profile name, or undefined when it cannot be determined.
 */
async function currentProfile(ctx: Context): Promise<string | undefined> {
  return (await currentProfileRow(ctx))?.name
}

/**
 * The booted profile's row from `/profiles`' own reading.
 *
 * Read through {@link readProfiles} rather than by resolving anything here, so
 * setup and `/profiles` can never disagree about which profile is running or
 * what it composes. A failure is swallowed to undefined: a profiles root that
 * cannot be listed is a fact this report states as "unknown", not one worth
 * failing the whole flow over.
 * @param ctx - the plugin context.
 * @returns the row, or undefined when nothing could be read.
 */
async function currentProfileRow(ctx: Context): Promise<ProfileRow | undefined> {
  try {
    const reading = await readProfiles(ctx)
    return reading?.profiles.find(profile => profile.current)
  } catch {
    return undefined
  }
}

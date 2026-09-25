/**
 * Point the workspace's Harness dependency graph at a Harness CHECKOUT
 * instead of the registry — coherently, as one source graph rather than a
 * source/registry mixture.
 *
 * Not needed for ordinary work: the manifests pin every harness dependency to
 * the adopted target's exact version (tools/harness-target.mjs keeps them
 * there), so a clone typechecks against real registry types with nothing else
 * installed. This is for developing against harness source — the adopted
 * revision itself, a local branch, or a fix not yet published — where the
 * registry is behind. The `Harness target` job in
 * .github/workflows/ci.yml uses this tool exactly the way a person does.
 *
 * A linked package's manifest still carries its raw `workspace:^`
 * dependency/peerDependency specifiers — a checkout has not been through
 * Harness's publish step, which is what rewrites those into real registry
 * ranges. Naming only the packages dshline imports directly is not enough:
 * pnpm still resolves every specifier it finds while walking those packages'
 * own dependencies and peers, and a `workspace:^` edge to a package that
 * is not itself linked sends pnpm to the registry looking for a version the
 * registry may not carry yet. So this tool computes the full closure of
 * `@deepseek-ai/*` packages reachable from what the workspace actually
 * depends on (see tools/harness-graph.mjs) and redirects every one of them —
 * via a single `overrides` block in `pnpm-workspace.yaml`, which is the
 * pnpm-native way to force a resolution target without touching any
 * package's declared dependency ranges (tools/harness-target.mjs is still the
 * boundary that owns those). No manifest is edited: every
 * package.json keeps naming the registry versions it always did, and the
 * override simply wins while it's present. (pnpm 11 stopped reading
 * `overrides` from a package.json's `pnpm` field — see pnpm.io/settings —
 * which is why this lives in pnpm-workspace.yaml, the same file Harness's
 * own workspace uses for exactly this.)
 *
 * `--restore` deletes that override block, which is the entire link — no
 * dependency text was ever changed, so there is nothing else to put back.
 * Run `node tools/harness-target.mjs --pin` afterwards only if the manifests
 * themselves are off the adopted target, which source-linking never causes.
 *
 * This tool owns every `@deepseek-ai/*` entry in that overrides block whose
 * value is a `link:` spec — link and restore both replace exactly that
 * subset and nothing else, so a hand-added override pinning some Harness
 * package to a specific registry version for an unrelated reason survives
 * both.
 *
 * Usage:
 *   node tools/link-harness.mjs ../deepseek-harness
 *   node tools/link-harness.mjs ~/src/deepseek-harness
 *   node tools/link-harness.mjs --check
 *   node tools/link-harness.mjs --restore
 */

import { access, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { declarationState } from './harness-declarations.mjs'
import {
  discoverHarnessPackages,
  evaluateLinkedClosure,
  findWorkspaceRoot,
  harnessScopedNames,
  readWorkspaceOverrides,
  requiredClosure,
  writeWorkspaceOverrides,
} from './harness-graph.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootManifestPath = join(repoRoot, 'package.json')
const bundleManifestPath = join(repoRoot, 'packages', 'dshline', 'package.json')
const workspaceYamlPath = join(repoRoot, 'pnpm-workspace.yaml')
const HARNESS_SCOPE = '@deepseek-ai/'

const [argument] = process.argv.slice(2)
if (argument === undefined || argument === '--help') {
  process.stdout.write('usage: node tools/link-harness.mjs <path-to-deepseek-harness> | --check | --restore\n')
  process.exit(argument === undefined ? 1 : 0)
}

/**
 * Read and parse a manifest.
 * @param manifestPath - the file to read.
 * @returns the parsed document.
 */
async function readManifest(manifestPath) {
  return JSON.parse(await readFile(manifestPath, 'utf8'))
}

if (argument === '--restore') {
  const yamlText = await readFile(workspaceYamlPath, 'utf8')
  const overrides = readWorkspaceOverrides(yamlText)
  // Only reclaim entries this tool itself would have written. A hand-added
  // `@deepseek-ai/*` override for an unrelated reason (pinning one package to
  // a specific registry version, say) is not this tool's to remove.
  const removed = [...overrides].filter(([name, spec]) => name.startsWith(HARNESS_SCOPE) && spec.startsWith('link:')).map(([name]) => name)
  if (removed.length === 0) {
    process.stdout.write('not linked to a checkout: nothing to restore\n')
    process.exit(0)
  }
  for (const name of removed) overrides.delete(name)
  await writeFile(workspaceYamlPath, writeWorkspaceOverrides(yamlText, overrides))
  process.stdout.write(`restored ${String(removed.length)} packages to their registry resolution\n`)
  process.exit(0)
}

if (argument === '--check') {
  const yamlText = await readFile(workspaceYamlPath, 'utf8')
  const overrides = readWorkspaceOverrides(yamlText)
  const linked = [...overrides].filter(([name, spec]) => name.startsWith(HARNESS_SCOPE) && spec.startsWith('link:'))
  if (linked.length === 0) {
    process.stdout.write('not linked to a checkout: types come from the pinned registry versions, which is the normal setup\n')
    process.exit(0)
  }

  const [, firstSpec] = linked[0]
  const firstTarget = resolve(repoRoot, firstSpec.slice('link:'.length))
  const harnessRoot = await findWorkspaceRoot(firstTarget)
  if (harnessRoot === undefined) {
    process.stdout.write(`harness checkout not found: ${firstTarget} has no pnpm-workspace.yaml in its ancestry\n`)
    process.stdout.write('fix with: node tools/link-harness.mjs <path-to-deepseek-harness>\n')
    process.exit(1)
  }

  const packages = await discoverHarnessPackages(harnessRoot)
  const rootManifest = await readManifest(rootManifestPath)
  const bundleManifest = await readManifest(bundleManifestPath)
  const seeds = harnessScopedNames([bundleManifest, rootManifest])
  const resolveTarget = spec => resolve(repoRoot, spec.slice('link:'.length))
  const { mismatched, notLinked, stale } = evaluateLinkedClosure(linked, packages, seeds, resolveTarget)
  const mismatchedNames = new Set(mismatched)

  // A mismatched link already fails coherence on its own; checking whether
  // its declarations are built would just be asking the wrong directory.
  const missing = []
  const unbuilt = []
  const invalid = []
  for (const [name, spec] of linked) {
    if (mismatchedNames.has(name)) continue
    const state = await declarationState(resolveTarget(spec))
    if (state.kind === 'missing') missing.push(name)
    else if (state.kind === 'unbuilt') unbuilt.push(name)
    else if (state.kind === 'invalid') invalid.push([name, state.message])
  }

  process.stdout.write(`harness expected at ${harnessRoot}\n`)

  // The contract is the exact required closure, not merely a superset of it:
  // a stale entry left over from a prior checkout is as much a failure as a
  // missing one, since either means the overrides no longer describe one
  // coherent graph.
  if (mismatched.length === 0 && missing.length === 0 && unbuilt.length === 0 && invalid.length === 0 && notLinked.length === 0 && stale.length === 0) {
    process.stdout.write(`harness links resolve to one coherent checkout and its declarations are built; ${String(linked.length)} package(s); \`pnpm typecheck\` will work\n`)
    process.exit(0)
  }

  if (mismatched.length > 0) {
    process.stdout.write(`  ${String(mismatched.length)} linked package(s) do not resolve to ${harnessRoot}'s own directory for their name, starting with ${mismatched[0]} — the overrides mix more than one checkout\n`)
    process.stdout.write('  fix with: node tools/link-harness.mjs <path-to-deepseek-harness>\n')
  }
  if (notLinked.length > 0) {
    process.stdout.write(`  ${String(notLinked.length)} package(s) are required by the checkout's dependency graph but not linked, starting with ${notLinked[0]}\n`)
    process.stdout.write('  fix with: node tools/link-harness.mjs <path-to-deepseek-harness>\n')
  }
  if (stale.length > 0) {
    process.stdout.write(`  ${String(stale.length)} linked package(s) are no longer required by the checkout's graph: ${stale.join(', ')}\n`)
    process.stdout.write('  re-run node tools/link-harness.mjs <path-to-deepseek-harness> to prune them\n')
  }
  if (missing.length > 0) {
    process.stdout.write(`  ${String(missing.length)} linked package(s) have no package directory or manifest at their link target, starting with ${missing[0]}\n`)
  }
  if (unbuilt.length > 0) {
    process.stdout.write(`  ${String(unbuilt.length)} linked package(s) are present but their advertised declarations are not built, starting with ${unbuilt[0]}\n`)
    process.stdout.write('  fix by building the harness: pnpm install && pnpm run build:lib, in that checkout\n')
  }
  if (invalid.length > 0) {
    const [name, message] = invalid[0]
    process.stdout.write(`  ${String(invalid.length)} linked package(s) have unreadable package.json manifests, starting with ${name}: ${message}\n`)
  }
  process.exit(1)
}

const expanded = argument.startsWith('~/') ? join(homedir(), argument.slice(2)) : argument
const harnessRoot = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)

try {
  await access(join(harnessRoot, 'pnpm-workspace.yaml'))
} catch {
  process.stderr.write(`not a harness checkout: ${harnessRoot}\n`)
  process.stderr.write('expected to find pnpm-workspace.yaml there\n')
  process.exit(1)
}

const packages = await discoverHarnessPackages(harnessRoot)
const rootManifest = await readManifest(rootManifestPath)
const bundleManifest = await readManifest(bundleManifestPath)
const seeds = harnessScopedNames([bundleManifest, rootManifest])
const closure = requiredClosure(seeds, packages)

if (closure.size === 0) {
  process.stderr.write('none of the workspace\'s @deepseek-ai/* dependencies were found in that checkout\n')
  process.exit(1)
}

/**
 * A portable `link:` specifier from the repo root to a checkout directory.
 * Relative where possible so the manifest stays portable and carries no home
 * directory; absolute only when the checkout is on another volume, where a
 * relative path would be worse than useless.
 * @param target - the absolute directory to link.
 * @returns the specifier, preferring a relative path.
 */
function linkSpec(target) {
  const asRelative = relative(repoRoot, target)
  const path = asRelative !== '' && !isAbsolute(asRelative) ? (asRelative.startsWith('.') ? asRelative : `./${asRelative}`) : target
  return `link:${path}`
}

const yamlText = await readFile(workspaceYamlPath, 'utf8')
const overrides = readWorkspaceOverrides(yamlText)
// Same ownership boundary as --restore: only replace entries this tool
// itself would have written, not a hand-added version override.
for (const [name, spec] of [...overrides]) {
  if (name.startsWith(HARNESS_SCOPE) && spec.startsWith('link:')) overrides.delete(name)
}
for (const name of [...closure].sort()) {
  overrides.set(name, linkSpec(packages.get(name).dir))
}
await writeFile(workspaceYamlPath, writeWorkspaceOverrides(yamlText, overrides))

process.stdout.write(`linked ${String(closure.size)} packages from ${harnessRoot}\n`)
process.stdout.write('run `pnpm install` then `pnpm typecheck`\n')

/**
 * Finding the harness launcher, and keeping one policy for it.
 *
 * `/profiles` mutations shell out to `dsh plugin`, so they have to reach the
 * launcher wherever this frontend itself starts — which a PATH lookup alone
 * does not: `DSH_BIN` and a `DSH_HARNESS` source checkout are both ordinary
 * working setups, and the first version of `/profiles` could not install
 * anything in either.
 *
 * `bin/dshline.mjs` keeps its own copy of the policy because it is the
 * package's executable and must run before anything is built. The last suite
 * here is the guard that keeps the two from drifting apart in silence.
 */

import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { LAUNCHER_PACKAGE, onPath, resolveLauncher, splitCommandLine as splitFromSource } from '../src/launcher.ts'
import { splitCommandLine as splitFromWrapper } from '../bin/dshline.mjs'

let dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
  dirs = []
})

/** A temp directory that is cleaned up after the test. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dshline-launcher-'))
  dirs.push(dir)
  return dir
}

/** An anchor that resolves no packages, so the package fallback finds nothing. */
const NO_PACKAGES = 'file:///nonexistent-anchor/package.json'

describe('DSH_BIN, when the user has pointed at a launcher', () => {
  it('uses it, and says where it came from', async () => {
    const dir = await tempDir()
    const bin = join(dir, 'dsh')
    await writeFile(bin, '#!/bin/sh\n', 'utf8')
    await chmod(bin, 0o755)
    const found = resolveLauncher({ DSH_BIN: bin }, NO_PACKAGES)
    expect(found.kind).toBe('found')
    if (found.kind !== 'found') throw new Error('expected found')
    expect(found.launcher.command).toBe(bin)
    expect(found.launcher.prefix).toEqual([])
    expect(found.launcher.describe).toContain('$DSH_BIN')
  })

  it('pins a relative path against this folder, so the managed seam can verify it', async () => {
    // The subprocess seam rejects relative commands (its resolution base is
    // undefined), while a relative $DSH_BIN has always meant "against the
    // working directory this process runs in". The lookup resolves that
    // answer itself instead of handing the seam a path it must refuse.
    const dir = await tempDir()
    await writeFile(join(dir, 'dsh'), '', 'utf8')
    const given = `${relative(process.cwd(), dir)}/dsh`
    const found = resolveLauncher({ DSH_BIN: given }, NO_PACKAGES)
    expect(found.kind).toBe('found')
    if (found.kind !== 'found') throw new Error('expected found')
    expect(found.launcher.command).toBe(resolve(given))
    expect(isAbsolute(found.launcher.command)).toBe(true)
    // The diagnostic still names what the user actually wrote.
    expect(found.launcher.describe).toContain(given)
  })

  it('reports a wrong relative path as a misconfiguration, unchanged', () => {
    const found = resolveLauncher({ DSH_BIN: './somewhere/missing' }, NO_PACKAGES)
    expect(found.kind).toBe('misconfigured')
    if (found.kind !== 'misconfigured') throw new Error('expected misconfigured')
    expect(found.message).toContain('./somewhere/missing')
  })

  it('reports a wrong path as a misconfiguration, not as "no launcher"', () => {
    // The answers differ: a wrong DSH_BIN is a sentence about the value they
    // set, not an invitation to install anything.
    const found = resolveLauncher({ DSH_BIN: '/nonexistent/dsh' }, NO_PACKAGES)
    expect(found.kind).toBe('misconfigured')
    if (found.kind !== 'misconfigured') throw new Error('expected misconfigured')
    expect(found.message).toContain('$DSH_BIN')
    expect(found.message).toContain('/nonexistent/dsh')
  })

  it('outranks PATH, because the user already decided', async () => {
    const dir = await tempDir()
    const bin = join(dir, 'chosen')
    await writeFile(bin, '', 'utf8')
    const path = await tempDir()
    await writeFile(join(path, 'dsh'), '', 'utf8')
    const found = resolveLauncher({ DSH_BIN: bin, PATH: path }, NO_PACKAGES)
    if (found.kind !== 'found') throw new Error('expected found')
    expect(found.launcher.command).toBe(bin)
  })
})

describe('DSH_HARNESS, when the launcher is a source checkout', () => {
  /** A checkout whose manifest defines the given `dsh` script. */
  async function checkout(script: string | undefined): Promise<string> {
    const dir = await tempDir()
    const manifest = script === undefined ? { name: 'harness' } : { name: 'harness', scripts: { dsh: script } }
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest), 'utf8')
    return dir
  }

  it('runs the checkout script, from the checkout', async () => {
    // A checkout has no `dsh` executable at all: the launcher is a script whose
    // loader resolves relative to the checkout, so it only runs with that cwd.
    const dir = await checkout('node --import tsx/esm apps/cli/src/bin.ts')
    const found = resolveLauncher({ DSH_HARNESS: dir }, NO_PACKAGES)
    if (found.kind !== 'found') throw new Error('expected found')
    expect(found.launcher.command).toBe('node')
    expect(found.launcher.prefix).toEqual(['--import', 'tsx/esm', 'apps/cli/src/bin.ts'])
    expect(found.launcher.cwd).toBe(dir)
  })

  it('keeps a quoted program path whole, which Windows needs', async () => {
    // Node lives under `C:\Program Files\nodejs` on a default Windows install, and a
    // checkout naming its interpreter in full is one token only because it is quoted.
    // Splitting on whitespace turned it into `C:\Program` plus
    // `Files\nodejs\node.exe`, and the launch failed with ENOENT beside a checkout
    // that worked from a shell. The harness's own script happens to use a bare `node`,
    // which is why this went unnoticed; any machine whose PATH needs the full path is
    // where it shows.
    const dir = await checkout('"C:\\Program Files\\nodejs\\node.exe" apps/cli.ts')
    const found = resolveLauncher({ DSH_HARNESS: dir }, NO_PACKAGES)
    if (found.kind !== 'found') throw new Error('expected found')
    expect(found.launcher.command).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(found.launcher.prefix).toEqual(['apps/cli.ts'])
  })

  it('marks where the launcher came from, which decides the pnpm remedy', async () => {
    // Not how it is run: what a prerequisite failure should say. A checkout declares
    // its own pnpm in `packageManager`, so corepack is the remedy that keeps that
    // version; a package install gets the global one.
    const checkoutDir = await checkout('node bin.ts')
    const local = resolveLauncher({ DSH_HARNESS: checkoutDir }, NO_PACKAGES)
    if (local.kind !== 'found') throw new Error('expected found')
    expect(local.launcher.origin).toBe('checkout')

    const binDirectory = await tempDir()
    const bin = join(binDirectory, 'dsh')
    await writeFile(bin, '', 'utf8')
    const explicit = resolveLauncher({ DSH_BIN: bin }, NO_PACKAGES)
    if (explicit.kind !== 'found') throw new Error('expected found')
    expect(explicit.launcher.origin).toBe('package')

    const path = await tempDir()
    await writeFile(join(path, 'dsh'), '', 'utf8')
    const found = resolveLauncher({ PATH: path }, NO_PACKAGES)
    if (found.kind !== 'found') throw new Error('expected found')
    expect(found.launcher.origin).toBe('package')
  })

  it('reports a directory that is not a checkout', async () => {    const dir = await tempDir()
    const found = resolveLauncher({ DSH_HARNESS: dir }, NO_PACKAGES)
    expect(found.kind).toBe('misconfigured')
    if (found.kind !== 'misconfigured') throw new Error('expected misconfigured')
    expect(found.message).toContain('no package.json')
  })

  it('reports a checkout whose manifest defines no dsh script', async () => {
    const dir = await checkout(undefined)
    const found = resolveLauncher({ DSH_HARNESS: dir }, NO_PACKAGES)
    expect(found.kind).toBe('misconfigured')
    if (found.kind !== 'misconfigured') throw new Error('expected misconfigured')
    expect(found.message).toContain('has no "dsh" script')
  })

  it('outranks PATH', async () => {
    const dir = await checkout('node bin.ts')
    const path = await tempDir()
    await writeFile(join(path, 'dsh'), '', 'utf8')
    const found = resolveLauncher({ DSH_HARNESS: dir, PATH: path }, NO_PACKAGES)
    if (found.kind !== 'found') throw new Error('expected found')
    expect(found.launcher.cwd).toBe(dir)
  })
})

describe('PATH, the ordinary global install', () => {
  it('uses a bare dsh so Node resolves it the way a shell would', async () => {
    const path = await tempDir()
    await writeFile(join(path, 'dsh'), '', 'utf8')
    const found = resolveLauncher({ PATH: path }, NO_PACKAGES)
    if (found.kind !== 'found') throw new Error('expected found')
    // The bare name everywhere but Windows, where the file that exists is a
    // `.cmd` shim and the bare name is not a file at all.
    expect(found.launcher.command).toBe(process.platform === 'win32' ? join(path, 'dsh') : 'dsh')
    expect(found.launcher.describe).toContain('PATH')
  })

  it('answers with the file it found, not just that it found one', async () => {
    // What Windows needs: npm installs the launcher as `dsh.cmd`, and a lookup
    // that answered only yes would leave a caller spawning a name that names
    // nothing. The path is the same answer everywhere, so nothing branches on
    // the platform to obtain it.
    const path = await tempDir()
    const executable = join(path, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    await writeFile(executable, '', 'utf8')
    expect(onPath('dsh', { PATH: path })).toBe(executable)
    expect(onPath('dsh', { PATH: await tempDir() })).toBeUndefined()
  })

  it('reports none when nothing on PATH and no package can be resolved', async () => {
    expect(resolveLauncher({ PATH: '/nonexistent-a:/nonexistent-b' }, NO_PACKAGES)).toEqual({ kind: 'none' })
    expect(resolveLauncher({ PATH: '' }, NO_PACKAGES)).toEqual({ kind: 'none' })
    expect(resolveLauncher({}, NO_PACKAGES)).toEqual({ kind: 'none' })
  })
})

describe('the launcher package, resolved side by side with this one', () => {
  it('runs its bin through this Node, so the file need not be executable', async () => {
    // What makes `npm i -g @deepseek-ai/dsh @dshline/dshline` enough.
    const root = await tempDir()
    const pkg = join(root, 'node_modules', LAUNCHER_PACKAGE)
    await mkdir(pkg, { recursive: true })
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: LAUNCHER_PACKAGE, bin: { dsh: 'cli.js' } }), 'utf8')
    await writeFile(join(pkg, 'cli.js'), '', 'utf8')
    const found = resolveLauncher({ PATH: '' }, `file://${join(root, 'anchor.js')}`)
    if (found.kind !== 'found') throw new Error('expected found')
    expect(found.launcher.command).toBe(process.execPath)
    // Compared by suffix: `createRequire` resolves through realpath, and the
    // system temp directory is a symlink on macOS.
    expect(found.launcher.prefix).toHaveLength(1)
    expect(found.launcher.prefix[0]).toMatch(/cli\.js$/u)
  })

  it('reports none when the package declares a bin file that is not there', async () => {
    const root = await tempDir()
    const pkg = join(root, 'node_modules', LAUNCHER_PACKAGE)
    await mkdir(pkg, { recursive: true })
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ bin: { dsh: 'missing.js' } }), 'utf8')
    expect(resolveLauncher({ PATH: '' }, `file://${join(root, 'anchor.js')}`)).toEqual({ kind: 'none' })
  })
})

describe('one launcher policy, two implementations', () => {
  // `bin/dshline.mjs` cannot import this module: it is the package's
  // executable and must run in a source checkout that has never been built.
  // The duplication is therefore deliberate — and guarded here, so it cannot
  // become a divergence nobody noticed.
  const wrapper = readFileSync(fileURLToPath(new URL('../bin/dshline.mjs', import.meta.url)), 'utf8')

  it('honours the same four mechanisms as the wrapper', () => {
    for (const mechanism of ['DSH_BIN', 'DSH_HARNESS', 'PATH', LAUNCHER_PACKAGE]) {
      expect(wrapper, `wrapper lost ${mechanism}`).toContain(mechanism)
    }
  })

  it('honours them in the same order', () => {
    // Order is policy, not detail: it is what makes an explicit DSH_BIN beat a
    // stale `dsh` on PATH. Measured inside the wrapper's own resolver, because
    // a top-of-file `const LAUNCHER_PACKAGE = …` would otherwise read as the
    // first mechanism.
    const start = wrapper.indexOf('function findLauncher()')
    expect(start).toBeGreaterThan(0)
    const body = wrapper.slice(start, wrapper.indexOf('\nfunction ', start + 1))
    const order = ['DSH_BIN', 'DSH_HARNESS', "onPath('dsh')", 'LAUNCHER_PACKAGE']
    const positions = order.map(token => body.indexOf(token))
    expect(positions.every(position => position >= 0), `missing: ${JSON.stringify(order.filter((_t, i) => positions[i] < 0))}`).toBe(true)
    expect([...positions].sort((left, right) => left - right)).toEqual(positions)
  })

  it('still runs the package fallback through this Node in the wrapper too', () => {
    expect(wrapper).toContain('process.execPath')
  })

  it('splits a checkout command line identically in both copies', () => {
    // A `dsh` script naming its interpreter in full is the case that needs quoting, and
    // a wrapper honoring quotes while `/profiles` did not would mean a session that
    // launches where a profile mutation then fails, or the reverse. Asserted as
    // equality of the two implementations rather than of each against a literal, so
    // whichever one drifts is the one that fails.
    const lines = [
      'node --import tsx/esm apps/cli/src/bin.ts',
      '"C:\\Program Files\\nodejs\\node.exe" apps/cli.ts',
      "'/opt/my node/bin/node' apps/cli.ts",
      'node ""',
      '   ',
      'pnpm dsh',
    ]
    for (const line of lines) {
      expect(splitFromWrapper(line), line).toEqual(splitFromSource(line))
    }
    // And the answer is the useful one, not two copies agreeing on something wrong.
    expect(splitFromSource('"C:\\Program Files\\nodejs\\node.exe" apps/cli.ts'))
      .toEqual(['C:\\Program Files\\nodejs\\node.exe', 'apps/cli.ts'])
  })

  it('names the Windows shim case in both PATH lookups', () => {
    // The one place the two lookups could agree on mechanism and still differ
    // on answer: a `.cmd` on PATH is the file to run there, and a wrapper that
    // returned the bare name would fail to spawn beside a working install.
    const body = wrapper.slice(wrapper.indexOf('function findLauncher()'))
    expect(body.slice(0, body.indexOf('\nfunction ', 1))).toContain('win32')
    expect(readFileSync(fileURLToPath(new URL('../src/launcher.ts', import.meta.url)), 'utf8'))
      .toContain('win32')
  })
})

describe('one release-age window, written down twice', () => {
  // `pnpm-workspace.yaml` governs installs into THIS repository; the wrapper's
  // `--config.minimum-release-age` governs the install into a harness profile,
  // which has no dshline settings in it and must not grow any. Two mechanisms,
  // deliberately — but one number, and a supply-chain window that drifts in one
  // place and not the other is exactly the kind of quiet weakening nobody reads
  // a diff carefully enough to catch.
  const wrapper = readFileSync(fileURLToPath(new URL('../bin/dshline.mjs', import.meta.url)), 'utf8')
  const workspace = readFileSync(fileURLToPath(new URL('../../../pnpm-workspace.yaml', import.meta.url)), 'utf8')

  /** The window the wrapper passes to the harness's pnpm, in minutes. */
  const wrapperMinutes = Number(/const RELEASE_AGE_MINUTES = (?<minutes>\d+)/u.exec(wrapper)?.groups?.minutes)

  /** The window this repository's own installs obey, in minutes. */
  const repositoryMinutes = Number(/^minimumReleaseAge: (?<minutes>\d+)$/mu.exec(workspace)?.groups?.minutes)

  it('is the deliberate two hours on both sides', () => {
    expect(wrapperMinutes).toBe(120)
    expect(repositoryMinutes).toBe(120)
  })

  it('reaches pnpm through the one spelling this was proved with', () => {
    // pnpm's `--config.<setting>` form, kebab-cased. The number is interpolated
    // from the constant above rather than typed into the string, so the two
    // cannot say different things; the spelling is pinned because this is the
    // one that was run end to end against the adopted harness and pnpm 11, and
    // a setting name pnpm does not recognize would restore the default window
    // without failing anything.
    expect(wrapper).toContain(`--config.minimum-release-age=${'${RELEASE_AGE_MINUTES.toString()}'}`)
  })
})

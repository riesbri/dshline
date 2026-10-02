import { execFile, spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { observeUntilReady, packAndInstallProfile, parseBootEvidence, processOutcome, run } from './consumer-smoke.mjs'

const execFileAsync = promisify(execFile)

const VERSION = '0.7.1'

/**
 * A fake booting process, standing in for `script(1)` running the real
 * launcher: it writes its own stdout directly (no file involved at all), so
 * these tests exercise exactly what `observeUntilReady` is documented to
 * rely on and cannot pass by accident from a file this fixture never writes.
 * @param script - inline Node source for the fake process to run.
 * @returns the spawned, fully piped child.
 */
function fakeBootingProcess(script) {
  return spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
}

/** Every fixture below exits on ctrl-d, the same key production quits with. */
const QUITS_ON_CTRL_D = `
  process.stdin.resume()
  process.stdin.on('data', (chunk) => { if (chunk.includes(4)) process.exit(0) })
`

describe('packAndInstallProfile()', () => {
  it.skipIf(process.platform === 'win32')('uses the current packed renderer through the packed frontend even when the initial install succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-packed-profile-test-'))
    try {
      // Same version, different code: release versions cannot identify whether
      // this commit's renderer answered the frontend's package-name import.
      const fixture = async (folder, manifest, source) => {
        const dir = join(root, folder, 'package')
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js', ...manifest }))
        await writeFile(join(dir, 'index.js'), source)
        return dir
      }
      const tar = async (folder) => {
        const tarball = join(root, `${folder}.tgz`)
        await execFileAsync('tar', ['-czf', tarball, '-C', join(root, folder), 'package'])
        return tarball
      }
      const rendererManifest = { name: '@dshline/renderer', version: VERSION }
      await fixture('registry', rendererManifest, 'export const terminal = {}\n')
      const oldRenderer = await tar('registry')
      const rendererDir = await fixture('current', rendererManifest,
        'export const terminal = { setTitle: () => "current packed renderer" }\n')
      await fixture('frontend', {
        name: '@dshline/dshline', version: VERSION,
        dependencies: { '@dshline/renderer': `file:${oldRenderer}` },
      }, 'import { terminal } from "@dshline/renderer"; export const boot = () => terminal.setTitle()\n')
      const frontend = await tar('frontend')
      const dshBin = join(root, 'dsh.mjs')
      await writeFile(dshBin, `#!${process.execPath}
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
if (args.slice(0, 4).join(' ') !== 'plugin --profile dshline add') process.exit(2)
const profile = join(process.env.DSH_HOME, 'profiles', 'dshline')
await mkdir(profile, { recursive: true })
const manifest = join(profile, 'package.json')
try { await readFile(manifest) } catch {
  await writeFile(manifest, JSON.stringify({ name: 'profile-fixture', private: true }))
  await writeFile(join(profile, 'pnpm-workspace.yaml'), "packages:\\n  - '.'\\n")
}
const store = process.env.CONSUMER_SMOKE_STORE_DIR
const result = spawnSync('pnpm', ['add', '--offline', '--ignore-scripts', ...(store ? ['--store-dir', store] : []), args.at(-1)], { cwd: profile, stdio: 'inherit' })
await appendFile(join(profile, 'adds.jsonl'), JSON.stringify({ code: result.status, tarball: args.at(-1) }) + '\\n')
process.exit(result.status ?? 1)
`)
      await chmod(dshBin, 0o755)
      const home = join(root, 'home')
      const packedDir = join(root, 'packed-renderer')
      const rendererTarball = await packAndInstallProfile(dshBin, home, frontend, rendererDir, packedDir)
      const profile = join(home, 'profiles', 'dshline')
      const adds = (await readFile(join(profile, 'adds.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(adds).toEqual([{ code: 0, tarball: frontend }, { code: 0, tarball: frontend }])
      expect(await readdir(packedDir)).toEqual([rendererTarball.slice(packedDir.length + 1)])
      // Import from the installed frontend, not a top-level renderer: only this
      // proves the transitive dependency override (rather than a separate add).
      const entry = pathToFileURL(join(profile, 'node_modules', '@dshline', 'dshline', 'index.js')).href
      const result = await execFileAsync(process.execPath, ['--input-type=module', '-e',
        `import { boot } from ${JSON.stringify(entry)}; console.log(boot())`])
      expect(result.stdout.trim()).toBe('current packed renderer')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('parseBootEvidence()', () => {
  it('recognizes the banner and readiness in a cursor-addressed stream', () => {
    // Reconstructed from the audit's real capture: the renderer writes column
    // by column, so words arrive shattered across lines.
    const frame = [
      '\u001b[>1u',
      '●', 'r', 'e', 'a', 'd', 'y', '·',
      '╭', '─', 'c', 'o', 'n', 's', 'u', 'm', '─', '╮',
      'dshline', ' ', VERSION,
    ].join('\n')
    expect(parseBootEvidence(frame, VERSION)).toEqual({ sawBanner: true, sawReady: true })
  })

  it('strips escape sequences so redraw noise cannot fake or hide evidence', () => {
    const frame = '\u001b[2J\u001b[Hdshline 0.7.1\u001b[3;1fready'
    expect(parseBootEvidence(frame, VERSION)).toEqual({ sawBanner: true, sawReady: true })
  })

  it('stays incomplete while startup has not finished', () => {
    expect(parseBootEvidence('loading…\n', VERSION)).toEqual({ sawBanner: false, sawReady: false })
    expect(parseBootEvidence('ready\n', VERSION)).toEqual({ sawBanner: false, sawReady: true })
    expect(parseBootEvidence(`dshline ${VERSION}\n`, '')).toEqual({ sawBanner: false, sawReady: false })
  })

  it('refuses the wrong version: an old banner is not this bundle booting', () => {
    const frame = 'dshline 0.6.4 ready'
    expect(parseBootEvidence(frame, VERSION)).toEqual({ sawBanner: false, sawReady: true })
  })

  it('matches case-insensitively across shattered writes', () => {
    expect(parseBootEvidence('d s h l i n e   0 . 7 . 1', VERSION)).toEqual({ sawBanner: true, sawReady: false })
    expect(parseBootEvidence('DSHLINE READY', VERSION).sawReady).toBe(true)
  })
})

describe('observeUntilReady()', () => {
  it('observes evidence from the process\'s own stdout, with no file involved', async () => {
    const child = fakeBootingProcess(`
      process.stdout.write('dshline ${VERSION} ready')
      ${QUITS_ON_CTRL_D}
    `)
    const result = await observeUntilReady(child, VERSION, 5_000, 2_000)
    expect(result).toMatchObject({ code: 0, evidence: { sawBanner: true, sawReady: true } })
  })

  it('reacts to evidence as soon as it streams, rather than only at the boot timeout', async () => {
    // The exact bug this guards against: `tools/consumer-smoke.mjs` used to
    // read a file that could still be empty long after the terminal it
    // mirrors had already rendered "ready" — script(1)'s own stdout is not
    // buffered the way its mirrored file write is. This fixture writes late
    // on purpose and asserts the observer reacts near that delay, not near
    // the (much larger) boot timeout, which is what a periodic re-read of a
    // slow-to-flush file would look like instead.
    const child = fakeBootingProcess(`
      process.stdout.write('dshline ${VERSION} ')
      setTimeout(() => process.stdout.write('ready'), 50)
      ${QUITS_ON_CTRL_D}
    `)
    const started = Date.now()
    const result = await observeUntilReady(child, VERSION, 5_000, 2_000)
    expect(result.evidence).toEqual({ sawBanner: true, sawReady: true })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('reports incomplete evidence rather than inventing it when the boot timeout elapses', async () => {
    const child = fakeBootingProcess(`
      process.stdout.write('dshline ${VERSION}') // never writes "ready"
      ${QUITS_ON_CTRL_D}
    `)
    const result = await observeUntilReady(child, VERSION, 200, 2_000)
    expect(result).toMatchObject({ code: 0, evidence: { sawBanner: true, sawReady: false } })
  })

  it('answers a question when it appears, and reports what it answered', async () => {
    // The first-run confirmation is on the terminal, not in a file, and it has
    // to be answered when it shows rather than after a fixed wait — the same
    // reason the evidence is read from the pipe.
    const child = fakeBootingProcess(`
      process.stdout.write('set it up now? [Y/n] ')
      process.stdin.on('data', (chunk) => {
        if (String(chunk).includes('y')) process.stdout.write('dshline ${VERSION} ready')
      })
      ${QUITS_ON_CTRL_D}
    `)
    const result = await observeUntilReady(child, VERSION, 5_000, 2_000, [{ after: 'set it up now?', send: 'y\n' }])
    expect(result.replied).toEqual(['set it up now?'])
    expect(result).toMatchObject({ code: 0, evidence: { sawBanner: true, sawReady: true } })
  })

  it('reports an unanswered question rather than pretending it answered one', async () => {
    // What a wrapper that stopped asking would look like: the flow under test
    // never happened, and the run must say so instead of passing on a banner
    // that came from somewhere else.
    const child = fakeBootingProcess(`
      process.stdout.write('dshline ${VERSION} ready')
      ${QUITS_ON_CTRL_D}
    `)
    const result = await observeUntilReady(child, VERSION, 5_000, 2_000, [{ after: 'set it up now?', send: 'y\n' }])
    expect(result.replied).toEqual([])
  })

  it('matches a question split across writes, like everything else on a terminal', async () => {
    const child = fakeBootingProcess(`
      process.stdout.write('set it\\n')
      setTimeout(() => process.stdout.write('up now?\\n'), 20)
      process.stdin.on('data', () => process.stdout.write('dshline ${VERSION} ready'))
      ${QUITS_ON_CTRL_D}
    `)
    const result = await observeUntilReady(child, VERSION, 5_000, 2_000, [{ after: 'set it up now?', send: 'y\n' }])
    expect(result.replied).toEqual(['set it up now?'])
    expect(result.evidence).toEqual({ sawBanner: true, sawReady: true })
  })

  it('rejects when the process is killed instead of quitting cleanly', async () => {
    const child = fakeBootingProcess(`
      process.stdout.write('dshline ${VERSION} ready')
      // Deliberately ignores ctrl-d and stays alive, so only the kill
      // timeout's SIGTERM can end this.
      setInterval(() => {}, 1_000)
    `)
    await expect(observeUntilReady(child, VERSION, 100, 100)).rejects.toThrow(/did not exit within/)
  })
})

describe('processOutcome()', () => {
  it.each([
    [{ code: 1 }, 'exited with code 1'],
    [{ code: 0, stderr: 'x' }, 'exited with code 0'],
    [{ code: 'ENOENT' }, 'could not be run (ENOENT)'],
    [{ code: 'EACCES' }, 'could not be run (EACCES)'],
    [{ killed: true, signal: 'SIGTERM', code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'produced more output than execFile allows'],
    [{ killed: true, signal: 'SIGTERM', code: null }, 'killed by execFile with SIGTERM'],
    [{ killed: true, code: null }, 'killed by execFile'],
    [{ signal: 'SIGKILL', code: null }, 'terminated by SIGKILL'],
    [{}, 'failed without an exit status'],
  ])('names %j as %s', (error, expected) => {
    // Several unrelated failures arrive as one rejection from `execFile`, and the
    // fields this harness reads from it are identical for all of them. An unnamed
    // failure sends the next investigation after the wrong cause entirely.
    expect(processOutcome(error)).toContain(expected)
  })

  it('does not call a system error an exit status', () => {
    // Deliberate break: a string `code` is Node's spawn/spawn-system failure.
    // Rendering it as "exited with code ENOENT" describes a process that never
    // ran, which sends a reader looking for a child that never started.
    expect(processOutcome({ code: 'ENOENT' })).not.toContain('exited with')
    expect(processOutcome({ code: 7 })).toContain('exited with code 7')
  })

  it('says who killed the command rather than why', () => {
    // `killed` proves `execFile` sent the signal, which is the useful half — a
    // command that never finished is a different bug from one that exited on its
    // own. It does NOT prove the timeout was the reason, and claiming that would
    // be asserting something the rejection does not carry.
    expect(processOutcome({ killed: true, signal: 'SIGTERM' })).toContain('killed by execFile')
    expect(processOutcome({ killed: true, signal: 'SIGTERM' })).not.toContain('timeout')
    // A child that terminated itself is not the same event, and must not read
    // as though the harness ended it.
    expect(processOutcome({ signal: 'SIGTERM' })).toContain('terminated by SIGTERM')
  })

  it('names the output limit rather than a bare kill', () => {
    // An output-limit kill carries `killed: true` too, and "killed by execFile"
    // would be true but useless: the fix is a smaller allowance, not a shorter
    // deadline.
    expect(processOutcome({ killed: true, signal: 'SIGTERM', code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }))
      .toContain('more output than execFile allows')
  })
})

describe('run()', () => {
  /** A command that is present on every supported platform. */
  const SHELL = process.platform === 'win32' ? undefined : '/bin/sh'

  it.skipIf(process.platform === 'win32')('still throws on a numeric non-zero exit', async () => {
    await expect(run(SHELL, ['-c', 'exit 3'], {}, 'probe')).rejects.toThrow(/exited with code 3/u)
  })

  it.skipIf(process.platform === 'win32')('still throws on a command that cannot be run', async () => {
    // A spawn failure, not an exit status: the wording must not pretend a
    // process ran.
    await expect(run('/nonexistent/dsh-consumer-smoke', [], {}, 'probe'))
      .rejects.toThrow(/could not be run/u)
  })

  it.skipIf(process.platform === 'win32')('still throws when the child kills itself', async () => {
    await expect(run(SHELL, ['-c', 'kill -TERM $$'], {}, 'probe'))
      .rejects.toThrow(/terminated by SIGTERM/u)
  })

  it.skipIf(process.platform === 'win32')('still throws when execFile kills the child', async () => {
    // The hang case. `timeout` here is the harness's own knob, overridden only
    // to keep the test quick; the report says WHO killed it either way.
    await expect(run(SHELL, ['-c', 'sleep 5'], { timeout: 50 }, 'probe'))
      .rejects.toThrow(/killed by execFile/u)
  })

  it('resolves normally when the command succeeds', async () => {
    const result = await run(process.execPath, ['-e', 'process.exit(0)'], {}, 'probe')
    expect(result.stdout).toBe('')
  })
})

/**
 * The adopted-generation contract.
 *
 * dshline supports exactly one Harness generation, so every assertion here is
 * an equality. The suite this replaced carried ~120 lines of semver cases —
 * caret bounds, prerelease precedence, npm's same-tuple eligibility rule —
 * which existed only to decide whether a range still admitted the version
 * recorded two lines away in `HARNESS_TARGET`. Exact pinning made the
 * question disappear rather than answering it faster.
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it, vi } from 'vitest'

import {
  checkTarget,
  compatProblems,
  formatReport,
  isPublished,
  parseCompat,
  parseTarget,
  readCompat,
  sourceVersion,
  targetUpdates,
} from './harness-target.mjs'

const TARGET = { revision: 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e', version: '0.1.1-rc.2' }

/**
 * A throwaway repository whose only interesting properties are the two
 * manifests, `HARNESS_TARGET`, and `HARNESS_COMPAT`. Driving the two check
 * modes from identical state is what proves they differ ONLY in the register;
 * the live repository cannot, because it changes generation on the next
 * adoption.
 * @param options - the state to seed.
 * @param options.shim - the `HARNESS_COMPAT` contents; defaults to a record already reconciled with the target.
 * @param options.pin - the version every governed spec carries; defaults to the target version.
 * @returns the fixture root.
 */
async function fixtureRepo({ shim = `shim packages/dshline/src/stderr.ts ${TARGET.version}\n`, pin = TARGET.version } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'harness-target-'))
  await mkdir(join(root, 'packages', 'dshline', 'src'), { recursive: true })
  await writeFile(join(root, 'HARNESS_TARGET'), `revision ${TARGET.revision}\nversion ${TARGET.version}\n`)
  await writeFile(join(root, 'package.json'), `${JSON.stringify({ devDependencies: { '@deepseek-ai/dsh-llm': pin } }, null, 2)}\n`)
  await writeFile(join(root, 'packages', 'dshline', 'package.json'), `${JSON.stringify({
    dependencies: { '@deepseek-ai/dsh-agent': pin },
    peerDependencies: { '@deepseek-ai/dsh-session': pin },
    devDependencies: { '@deepseek-ai/dsh-scope': pin },
  }, null, 2)}\n`)
  await writeFile(join(root, 'HARNESS_COMPAT'), shim)
  await writeFile(join(root, 'packages', 'dshline', 'src', 'stderr.ts'), '/** TEMPORARY shim; registered in HARNESS_COMPAT. */\n')
  return root
}

/**
 * Run the tool's CLI against a fixture root through its real flag parsing.
 * @param root - repository root to point `RELEASE_ROOT` at.
 * @param args - CLI flags.
 * @returns the exit code and standard output.
 */
async function runCli(root, args) {
  const cli = fileURLToPath(new URL('./harness-target.mjs', import.meta.url))
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      env: { ...process.env, RELEASE_ROOT: root },
    })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '' }
  }
}

describe('parseTarget()', () => {
  it('reads the two fields and ignores comments and blank lines', () => {
    expect(parseTarget([
      '# a comment',
      '',
      `revision ${TARGET.revision}`,
      `version ${TARGET.version}  # trailing note`,
      '',
    ].join('\n'))).toEqual(TARGET)
  })

  it('refuses anything but a full commit sha, so the blocking lane cannot follow a moving pointer', () => {
    // A branch name or an abbreviated sha would make "the revision we adopted"
    // mean whatever that pointer resolves to on the day CI runs — the exact
    // property the informational upstream lane owns and this one must not have.
    expect(() => parseTarget(`revision master\nversion ${TARGET.version}\n`)).toThrow(/40-character commit sha/)
    expect(() => parseTarget(`revision b150a55\nversion ${TARGET.version}\n`)).toThrow(/40-character commit sha/)
  })

  it('refuses a partial, duplicated, unknown, or malformed target rather than guessing', () => {
    expect(() => parseTarget(`revision ${TARGET.revision}\n`)).toThrow(/missing version/)
    expect(() => parseTarget(`version ${TARGET.version}\n`)).toThrow(/missing revision/)
    expect(() => parseTarget(`version ${TARGET.version}\nversion 0.1.2\n`)).toThrow(/declared twice/)
    expect(() => parseTarget('channel alpha\n')).toThrow(/unknown field: channel/)
    expect(() => parseTarget(`revision ${TARGET.revision}\nversion not-a-version\n`)).toThrow(/must look like/)
    for (const version of ['01.1.1', '0.01.1', '0.1.01', '0.1.1-', '0.1.1..rc']) {
      expect(() => parseTarget(`revision ${TARGET.revision}\nversion ${version}\n`), version).toThrow(/must look like/)
    }
    expect(() => parseTarget(`revision ${TARGET.revision}\nversion 0.1.1-rc.2\n\n`)).not.toThrow()
  })
})

describe('HARNESS_TARGET (the committed file)', () => {
  it('parses, so a malformed edit fails here rather than halfway through a CI job', async () => {
    const target = parseTarget(await readFile(new URL('../HARNESS_TARGET', import.meta.url), 'utf8'))
    expect(target.revision).toMatch(/^[0-9a-f]{40}$/)
  })

  it('is the only place the adopted revision is written down', async () => {
    // One source of truth is the whole point: a second copy in a workflow or a
    // manifest is a copy that goes stale during the next migration.
    const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
    const { revision } = parseTarget(await readFile(new URL('../HARNESS_TARGET', import.meta.url), 'utf8'))
    expect(workflow).not.toContain(revision)
    expect(workflow).toContain('harness-target.mjs --revision')
  })
})

describe('targetUpdates()', () => {
  it('accepts only the literal target version', () => {
    expect(targetUpdates({ '@deepseek-ai/dsh-agent': '0.1.1-rc.2' }, '0.1.1-rc.2')).toEqual([])
  })

  it('rejects a caret even though it would accept the target', () => {
    // This is the policy, not a formatting preference: `^0.1.1-rc.2` also
    // promises later releases in the same range, and dshline promises exactly
    // one generation. Refusing the range is what removed the need for a semver
    // engine here at all.
    expect(targetUpdates({ '@deepseek-ai/dsh-session': '^0.1.1-rc.2' }, '0.1.1-rc.2'))
      .toEqual([{ name: '@deepseek-ai/dsh-session', from: '^0.1.1-rc.2', to: '0.1.1-rc.2' }])
  })

  it('rejects a union range, which claims two generations', () => {
    expect(targetUpdates({ '@deepseek-ai/dsh-agent': '^0.1.1-rc.2 || ^0.1.2-alpha.2' }, '0.1.1-rc.2'))
      .toHaveLength(1)
  })

  it('rejects any other generation, in either direction', () => {
    expect(targetUpdates({ '@deepseek-ai/dsh-agent': '0.1.2-alpha.4' }, '0.1.1-rc.2'))
      .toEqual([{ name: '@deepseek-ai/dsh-agent', from: '0.1.2-alpha.4', to: '0.1.1-rc.2' }])
    expect(targetUpdates({ '@deepseek-ai/dsh-agent': '0.1.0-rc.8' }, '0.1.1-rc.2'))
      .toHaveLength(1)
  })

  it('never touches packages that share the scope but not the release cadence', () => {
    expect(targetUpdates({
      '@deepseek-ai/cordis': '^4.0.1',
      '@deepseek-ai/schemastery': '^3.18.1',
      commander: '^15.0.0',
    }, '0.1.1-rc.2')).toEqual([])
  })
})

describe('the committed manifests', () => {
  it.each([
    ['packages/dshline/package.json', ['dependencies', 'devDependencies', 'peerDependencies']],
    ['package.json', ['devDependencies']],
  ])('pin every dsh-* spec in %s to the target version', async (path, fields) => {
    const { version } = parseTarget(await readFile(new URL('../HARNESS_TARGET', import.meta.url), 'utf8'))
    const manifest = JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'))
    for (const field of fields) {
      expect(targetUpdates(manifest[field] ?? {}, version), `${path} (${field})`).toEqual([])
    }
  })

  it('leaves the independently-versioned peers as ordinary ranges', async () => {
    // Exact-pinning cordis would claim a coupling that does not exist: it is
    // not cut from the Harness release revision and moves on its own.
    const manifest = JSON.parse(await readFile(new URL('../packages/dshline/package.json', import.meta.url), 'utf8'))
    expect(manifest.peerDependencies['@deepseek-ai/cordis']).toMatch(/^\^/)
    expect(manifest.peerDependencies.commander).toMatch(/^\^/)
  })
})

describe('sourceVersion()', () => {
  it('reads the generation a Harness checkout declares', () => {
    expect(sourceVersion({ name: '@deepseek-ai/dsh-root', version: '0.1.1-rc.2' })).toBe('0.1.1-rc.2')
  })

  it('refuses a non-Harness root or a manifest with no version', () => {
    // Silently reading `undefined` here would make the coherence guard pass
    // for any checkout that is not a Harness workspace at all.
    expect(() => sourceVersion({ name: '@deepseek-ai/dsh-root' })).toThrow(/declares no version/)
    expect(() => sourceVersion({})).toThrow(/must be @deepseek-ai\/dsh-root/)
    expect(() => sourceVersion({ name: 'other', version: '0.1.1-rc.2' })).toThrow(/must be @deepseek-ai\/dsh-root/)
  })
})

describe('formatReport()', () => {
  it('confirms the invariant when the repository is coherent', () => {
    const report = formatReport(TARGET, [])
    expect(report).toContain('Harness target 0.1.1-rc.2 @ b150a551')
    expect(report).toContain('exactly 0.1.1-rc.2')
    expect(report).not.toContain('✗')
  })

  it('names the manifest, field, and spec that disagree', () => {
    const report = formatReport(TARGET, [
      { manifest: 'package.json', field: 'devDependencies', name: '@deepseek-ai/dsh-llm', from: '0.1.2-alpha.4' },
    ])
    expect(report).toContain('package.json (devDependencies): @deepseek-ai/dsh-llm 0.1.2-alpha.4')
    // A dependency-only failure must not tell the reader to hand-edit peers.
    expect(report).not.toContain('never rewritten by a tool')
  })

  it('says peers are a human decision when a peer is the thing that drifted', () => {
    const report = formatReport(TARGET, [
      { manifest: 'packages/dshline/package.json', field: 'peerDependencies', name: '@deepseek-ai/dsh-session', from: '^0.1.1-rc.2' },
    ])
    expect(report).toContain('never rewritten by a tool')
    expect(report).toContain('one exact version, not a range')
  })

  it('states the deferred register only in mechanical mode, leaving the default report unchanged', () => {
    const mechanical = formatReport(TARGET, [], [], { includeCompat: false })
    expect(mechanical).toContain('mechanical state only')
    expect(mechanical).toContain('0.1.1-rc.2')
    expect(mechanical).not.toContain('temporary shim')
    expect(formatReport(TARGET, [])).not.toContain('mechanical state only')
  })
})

describe('checkTarget(), the mechanical and full modes', () => {
  it('fails the mechanical mode on a target/pin mismatch, so a proposal cannot carry a broken tree', async () => {
    const root = await fixtureRepo({ pin: '0.1.1-rc.1' })
    const { report, failed } = await checkTarget(TARGET, root, { includeCompat: false })
    expect(failed).toBe(true)
    expect(report).toContain('@deepseek-ai/dsh-llm 0.1.1-rc.1')
    // The proposal defers a register decision, but it must still be honest
    // that the pins are its own mechanical responsibility.
    expect(report).toContain('Harness target 0.1.1-rc.2')
  })

  it('does not fail the mechanical mode on a stale register, because the pull request owns that decision', async () => {
    const root = await fixtureRepo({ shim: 'shim packages/dshline/src/stderr.ts 0.1.1-rc.1\n' })
    const { report, failed } = await checkTarget(TARGET, root, { includeCompat: false })
    expect(failed).toBe(false)
    expect(report).toContain('exactly 0.1.1-rc.2')
    expect(report).toContain('mechanical state only')
    expect(report).not.toContain('last confirmed against')
  })

  it('fails the default mode on that same stale register, so the gate still exists', async () => {
    const root = await fixtureRepo({ shim: 'shim packages/dshline/src/stderr.ts 0.1.1-rc.1\n' })
    const { report, failed } = await checkTarget(TARGET, root)
    expect(failed).toBe(true)
    expect(report).toContain('last confirmed against 0.1.1-rc.1')
    expect(report).toContain('bump the record to 0.1.1-rc.2')
  })

  it('fails the full check when a recorded module is gone, and refuses a malformed register', async () => {
    const missing = await fixtureRepo({ shim: 'shim packages/dshline/src/gone.ts 0.1.1-rc.2\n' })
    const { report, failed } = await checkTarget(TARGET, missing)
    expect(failed).toBe(true)
    expect(report).toContain('is recorded but does not exist — delete the record')

    const malformed = await fixtureRepo({ shim: 'workaround packages/dshline/src/stderr.ts 0.1.1-rc.2\n' })
    await expect(checkTarget(TARGET, malformed)).rejects.toThrow(/unknown field: workaround/)
  })

  it('passes both modes when the register is already reconciled', async () => {
    const root = await fixtureRepo()
    await expect(checkTarget(TARGET, root)).resolves.toMatchObject({ failed: false })
    await expect(checkTarget(TARGET, root, { includeCompat: false })).resolves.toMatchObject({ failed: false })
  })
})

describe('the CLI modes', () => {
  it('exits non-zero by default and zero with --mechanical on the same stale register', async () => {
    const root = await fixtureRepo({ shim: 'shim packages/dshline/src/stderr.ts 0.1.1-rc.1\n' })
    const full = await runCli(root, [])
    expect(full.code).toBe(1)
    expect(full.stdout).toContain('last confirmed against 0.1.1-rc.1')

    const mechanical = await runCli(root, ['--mechanical'])
    expect(mechanical.code).toBe(0)
    expect(mechanical.stdout).toContain('mechanical state only')
  })

  it('still fails --mechanical on a pin mismatch', async () => {
    const root = await fixtureRepo({ pin: '0.1.1-rc.1' })
    const { code, stdout } = await runCli(root, ['--mechanical'])
    expect(code).toBe(1)
    expect(stdout).toContain('@deepseek-ai/dsh-agent 0.1.1-rc.1')
  })
})

describe('isPublished()', () => {
  it('asks whether the exact version exists, not which channel it sits on', async () => {
    // Upstream moves generations between `next`, `alpha`, and `rc` without
    // changing its architecture; a check keyed on a channel name would need
    // redesigning every time it moved.
    const packument = { 'dist-tags': { next: '0.1.1-rc.2', alpha: '0.1.2-alpha.4' }, versions: { '0.1.1-rc.2': {}, '0.1.2-alpha.4': {} } }
    const fetchPackument = vi.fn(() => Promise.resolve(packument))
    await expect(isPublished('@deepseek-ai/dsh', '0.1.2-alpha.4', fetchPackument)).resolves.toBe(true)
    await expect(isPublished('@deepseek-ai/dsh', '0.1.3-alpha.1', fetchPackument)).resolves.toBe(false)
  })

  it('rejects a malformed packument rather than treating it as unpublished', async () => {
    await expect(isPublished('@deepseek-ai/dsh', '0.1.1-rc.2', () => Promise.resolve({})))
      .rejects.toThrow('invalid versions map')
    await expect(isPublished('@deepseek-ai/dsh', '0.1.1-rc.2', () => Promise.resolve({ versions: [] })))
      .rejects.toThrow('invalid versions map')
  })
})

describe('HARNESS_COMPAT, the register of temporary workarounds', () => {
  it('reads shim records and ignores comments and blank lines', () => {
    expect(parseCompat([
      '# why this one exists',
      '',
      'shim packages/dshline/src/stderr.ts 0.1.5-alpha.1',
      'shim packages/dshline/src/other.ts 0.1.5-alpha.1 # trailing note',
    ].join('\n'))).toEqual([
      { path: 'packages/dshline/src/stderr.ts', confirmed: '0.1.5-alpha.1' },
      { path: 'packages/dshline/src/other.ts', confirmed: '0.1.5-alpha.1' },
    ])
  })

  it('refuses a malformed, duplicated, or unknown record rather than guessing', () => {
    expect(() => parseCompat('shim packages/a.ts\n')).toThrow(/expected "shim <path> <version>"/)
    expect(() => parseCompat('shim packages/a.ts 0.1.5 extra\n')).toThrow(/expected "shim <path> <version>"/)
    expect(() => parseCompat('workaround packages/a.ts 0.1.5\n')).toThrow(/unknown field: workaround/)
    expect(() => parseCompat('shim packages/a.ts main\n')).toThrow(/not a version/)
    expect(() => parseCompat('shim packages/a.ts 0.1.5\nshim packages/a.ts 0.1.6\n')).toThrow(/recorded twice/)
  })

  it('treats an absent register as an empty one, so an older tag still checks', async () => {
    // `publish.yml` runs this check with RELEASE_ROOT pointing at a released
    // tag, which may predate the file. A repository carrying no workarounds is
    // also the state the register exists to return to.
    // This directory is a real one that carries no register.
    await expect(readCompat(new URL('.', import.meta.url).pathname)).resolves.toEqual([])
  })

  it('fails while a record names a generation other than the adopted one', async () => {
    // The whole point. Advancing HARNESS_TARGET cannot go green until someone
    // has confirmed the upstream behavior is still there, or deleted the shim.
    const shims = [{ path: 'tools/harness-target.mjs', confirmed: '0.1.1-rc.1' }]
    await expect(compatProblems({ ...TARGET }, shims)).resolves.toEqual([
      { path: 'tools/harness-target.mjs', confirmed: '0.1.1-rc.1', reason: 'unconfirmed' },
    ])
  })

  it('passes a record confirmed against the adopted generation', async () => {
    const shims = [{ path: 'tools/harness-target.mjs', confirmed: TARGET.version }]
    await expect(compatProblems({ ...TARGET }, shims)).resolves.toEqual([])
  })

  it('fails a record whose module is gone, so the register cannot outlive the shim', async () => {
    const shims = [{ path: 'packages/dshline/src/deleted.ts', confirmed: TARGET.version }]
    await expect(compatProblems({ ...TARGET }, shims)).resolves.toEqual([
      { path: 'packages/dshline/src/deleted.ts', confirmed: TARGET.version, reason: 'missing' },
    ])
  })

  it('names the decision in the report rather than only the failure', () => {
    const report = formatReport(TARGET, [], [
      { path: 'packages/dshline/src/stderr.ts', confirmed: '0.1.1-rc.1', reason: 'unconfirmed' },
    ])
    expect(report).toContain('1 temporary shim in HARNESS_COMPAT')
    expect(report).toContain('packages/dshline/src/stderr.ts last confirmed against 0.1.1-rc.1')
    expect(report).toContain(`bump the record to ${TARGET.version}`)
  })

  it('the committed register agrees with the committed target', async () => {
    // The same claim the blocking lane makes, asserted here so a stale record
    // fails in seconds rather than in a CI job.
    const target = parseTarget(await readFile(new URL('../HARNESS_TARGET', import.meta.url), 'utf8'))
    await expect(compatProblems(target, await readCompat())).resolves.toEqual([])
  })

  it('every recorded shim says it is temporary in its own first lines', async () => {
    // A register entry is a reminder to revisit; the module is where the
    // behavior and the removal condition live. One without the other is how a
    // workaround gets read as a design decision.
    for (const shim of await readCompat()) {
      const source = await readFile(new URL(`../${shim.path}`, import.meta.url), 'utf8')
      expect(source.slice(0, 400), shim.path).toMatch(/TEMPORARY/)
      expect(source, shim.path).toContain('HARNESS_COMPAT')
    }
  })
})

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

import { readFile } from 'node:fs/promises'

import { describe, expect, it, vi } from 'vitest'

import {
  formatReport,
  isPublished,
  parseTarget,
  sourceVersion,
  targetUpdates,
} from './harness-target.mjs'

const TARGET = { revision: 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e', version: '0.1.1-rc.2' }

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

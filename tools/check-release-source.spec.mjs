import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkReleaseSource } from './check-release-source.mjs'

const roots = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** @returns a disposable repository with one reviewed commit and origin/main. */
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'dshline-release-source-'))
  roots.push(cwd)
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Release fixture')
  git('config', 'user.email', 'release@example.invalid')
  writeFileSync(join(cwd, 'source'), 'reviewed')
  git('add', 'source')
  git('commit', '-m', 'reviewed source')
  const reviewed = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/main', reviewed)
  git('tag', 'v1.0.0', reviewed)
  return { cwd, git, reviewed }
}

describe('protected-main release provenance', () => {
  it('accepts the exact reviewed tag and peels annotated event revisions', () => {
    const f = fixture()
    expect(checkReleaseSource('v1.0.0', f.reviewed, f.cwd)).toBe(f.reviewed)
    f.git('tag', '-a', 'v1.0.1', '-m', 'annotated', f.reviewed)
    expect(checkReleaseSource('v1.0.1', f.git('rev-parse', 'v1.0.1'), f.cwd)).toBe(f.reviewed)
  })

  it('rejects a coherent new version tag on unreviewed package source', () => {
    const f = fixture()
    writeFileSync(join(f.cwd, 'source'), 'unreviewed')
    f.git('commit', '-am', 'unreviewed source')
    const unreviewed = f.git('rev-parse', 'HEAD')
    f.git('tag', 'v1.0.2', unreviewed)
    expect(() => checkReleaseSource('v1.0.2', unreviewed, f.cwd)).toThrow('not in protected main')
    expect(() => checkReleaseSource('v1.0.0', unreviewed, f.cwd)).toThrow('does not match')
  })

  it('fails closed for missing history and refuses branch or shell-shaped input', () => {
    const f = fixture()
    f.git('update-ref', '-d', 'refs/remotes/origin/main')
    expect(() => checkReleaseSource('v1.0.0', f.reviewed, f.cwd)).toThrow('not in protected main')
    for (const tag of ['main', 'v1.0.0\n--flag']) {
      expect(() => checkReleaseSource(tag, f.reviewed, f.cwd)).toThrow()
    }
    expect(() => checkReleaseSource('v1.0.0', 'main', f.cwd)).toThrow('immutable revision')
  })
})

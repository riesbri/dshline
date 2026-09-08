import { execFileSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'
import { versionFromReleaseTag } from './check-release-tag.mjs'

describe('versionFromReleaseTag()', () => {
  it('accepts immutable stable tags and rejects prereleases/build metadata', () => {
    expect(versionFromReleaseTag('v0.20.0')).toBe('0.20.0')
    expect(() => versionFromReleaseTag('v1.2.3-rc.1')).toThrow()
    expect(() => versionFromReleaseTag('v1.2.3+build.1')).toThrow()
  })

  it('rejects a branch, empty input, or shell-shaped tag', () => {
    for (const value of ['', 'main', 'v0.20.0/../../main', 'v0.20.0\n--flag']) {
      expect(() => versionFromReleaseTag(value)).toThrow()
    }
  })

  it('runs the coherent tagged-tree CLI success path', () => {
    const output = execFileSync(process.execPath, ['tools/check-release-tag.mjs'], {
      env: { ...process.env, RELEASE_TAG: 'v0.20.0' },
      encoding: 'utf8',
    })
    expect(output).toContain('matches 0.20.0 in 2 packages')
  })
})

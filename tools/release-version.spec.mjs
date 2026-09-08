import { describe, expect, it } from 'vitest'
import { RELEASE_TAG, VERSION_SHAPE, versionFromReleaseTag } from './release-version.mjs'

describe('strict release version grammar', () => {
  it('accepts ordinary semver and prerelease Harness versions, but not build metadata', () => {
    expect(VERSION_SHAPE.test('0.20.0')).toBe(true)
    expect(VERSION_SHAPE.test('0.1.1-rc.2')).toBe(true)
    expect(VERSION_SHAPE.test('1.2.3+build.7')).toBe(false)
    expect(RELEASE_TAG.test('v0.20.0')).toBe(true)
  })

  it('rejects leading zeros, empty identifiers, repeated dots, and trailing newlines', () => {
    for (const value of ['01.2.3', '1.02.3', '1.2.03', '1.2.3-', '1.2.3..1', '1.2.3\n']) {
      expect(VERSION_SHAPE.test(value), value).toBe(false)
    }
    for (const value of ['v01.2.3', 'v1.2.3-rc.1\n', 'v1.2.3+build.1']) {
      expect(() => versionFromReleaseTag(value), value).toThrow()
    }
  })
})

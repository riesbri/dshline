/**
 * Invariants of the probe table itself.
 *
 * `capability-report.mjs` already reports a probe whose file produced no
 * result as MISSING, but only after spending a vitest run. These checks are
 * the cheap, structural half of the same honesty: a table entry that names a
 * file which does not exist, a duplicated name or file, and a purpose-built
 * probe under `tests/capability/` that the table forgot all fail here, at a
 * glance, instead of waiting for a lane to run.
 * @module tools/capability-probes.spec
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CAPABILITY_PROBES } from './capability-probes.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Where purpose-built probes live, and the only place new ones may be added. */
const PROBE_DIR = join(repoRoot, 'packages/dshline/tests/capability')

describe('the capability probe table', () => {
  it('names each capability exactly once', () => {
    const names = CAPABILITY_PROBES.map(probe => probe.name)
    expect(names).toEqual([...new Set(names)])
  })

  it('uses capability names shaped like the doc vocabulary', () => {
    for (const probe of CAPABILITY_PROBES) {
      expect(probe.name).toMatch(/^[a-z][A-Za-z0-9]*$/)
    }
  })

  it('names only existing test files, once each per capability', () => {
    for (const probe of CAPABILITY_PROBES) {
      expect(probe.files.length, `${probe.name} names no file`).toBeGreaterThan(0)
      for (const file of probe.files) {
        expect(file, `${probe.name}: ${file} is not a test file`).toMatch(/\.spec\.tsx?$/)
        expect(existsSync(join(repoRoot, file)), `${probe.name} names a missing file: ${file}`).toBe(true)
      }
      expect(probe.files, `${probe.name} names a file twice`).toEqual([...new Set(probe.files)])
    }
  })

  it('keeps named evidence in the dshline package test tree', () => {
    // This is only a cheap repository-structure check. The capability report,
    // not this test, is the authority that a named file actually produced a
    // Vitest result in the active project configuration.
    for (const probe of CAPABILITY_PROBES) {
      for (const file of probe.files) {
        expect(file, `${file} is outside the package test tree`).toMatch(/^packages\/dshline\/tests\/.*\.spec\.ts$/u)
      }
    }
  })

  it('leaves no purpose-built probe behind the table', () => {
    const named = new Set(CAPABILITY_PROBES.flatMap(probe => probe.files))
    const onDisk = readdirSync(PROBE_DIR)
      .filter(file => file.endsWith('.spec.ts'))
      .map(file => `packages/dshline/tests/capability/${file}`)
    for (const file of onDisk) {
      expect(named.has(file), `${file} exists but no capability names it — add it to CAPABILITY_PROBES or delete it`).toBe(true)
    }
  })
})

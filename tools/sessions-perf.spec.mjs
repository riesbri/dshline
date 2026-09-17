import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { benchmarkOutput } from './sessions-perf.mjs'

/**
 * The predictable shared-temp path the pre-fix benchmark silently fell back to.
 *
 * It is deliberately the vulnerable value, not anything the current code can
 * produce: a regression that reintroduces the fallback must be caught by this
 * path appearing, so the test cannot derive its expectation from the code.
 */
const PREDICTABLE_TEMP_DEFAULT = '/tmp/dshline-sessions-perf-baseline.json'

const SELF = fileURLToPath(new URL('./sessions-perf.mjs', import.meta.url))

/**
 * Run the real CLI as a child so exit status and filesystem effects are what is
 * asserted, not an internal return value.
 *
 * The timeout keeps a reintroduced default from starting the full benchmark and
 * hanging the suite: the current rejections exit almost immediately.
 */
function runBenchmark(args) {
  return spawnSync(process.execPath, [SELF, ...args], { encoding: 'utf8', timeout: 15_000 })
}

/** State of the vulnerable artifact, so a rejection run can be seen not to touch it. */
function predictableDefaultState() {
  return existsSync(PREDICTABLE_TEMP_DEFAULT) ? statSync(PREDICTABLE_TEMP_DEFAULT).mtimeMs : undefined
}

describe('sessions-perf output argument', () => {
  it('a missing, empty, or flag-like --output has no destination', () => {
    expect(benchmarkOutput(['node', 'sessions-perf.mjs'])).toBeUndefined()
    expect(benchmarkOutput(['node', 'sessions-perf.mjs', '--output'])).toBeUndefined()
    expect(benchmarkOutput(['node', 'sessions-perf.mjs', '--output', ''])).toBeUndefined()
    expect(benchmarkOutput(['node', 'sessions-perf.mjs', '--output', '--some-other-flag'])).toBeUndefined()
    expect(benchmarkOutput(['node', 'sessions-perf.mjs', '--output', '--'])).toBeUndefined()
  })

  it('never substitutes a predictable temp filename for the missing destination', () => {
    expect(benchmarkOutput(['node', 'sessions-perf.mjs'])).not.toBe(PREDICTABLE_TEMP_DEFAULT)
  })

  it('accepts an explicitly chosen destination, including one the operator puts under /tmp', () => {
    expect(benchmarkOutput(['node', 'sessions-perf.mjs', '--output', '/some/explicit/evidence.json']))
      .toBe('/some/explicit/evidence.json')
    expect(benchmarkOutput(['node', 'sessions-perf.mjs', '--output', '/tmp/operator-chosen.json']))
      .toBe('/tmp/operator-chosen.json')
  })

  it('rejects a missing, empty, or flag-like --output with exit 2 and no benchmark output', () => {
    const before = predictableDefaultState()
    for (const args of [[], ['--output', ''], ['--output', '--some-other-flag']]) {
      const result = runBenchmark(args)
      expect(result.status, `args: ${JSON.stringify(args)}`).toBe(2)
      expect(result.stderr).toContain('usage:')
      // Reaching the benchmark would have printed this and looked like success.
      expect(result.stdout).not.toContain('Saved')
    }
    // The pre-fix fallback wrote this exact file; a rejection must create nothing.
    expect(predictableDefaultState()).toBe(before)
  })
})

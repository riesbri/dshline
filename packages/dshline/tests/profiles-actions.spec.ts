/**
 * Forwarding one `dsh plugin --profile <name> …` invocation, and the four ways
 * that forwarding can go wrong on a real machine.
 *
 * The forwarder never throws: an absent launcher, one the user pointed
 * somewhere wrong, a child that fails, and a child that never answers are all
 * facts about the environment, and each has to reach the reader as an outcome
 * rather than as an exception out of a keystroke.
 */

import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Launcher, LauncherResolution } from '../src/launcher.ts'
import type { ChildResult } from '../src/profiles/actions.ts'
import {
  failureReason,
  pendingDecision,
  pluginCommand,
  redactOutputLine,
  runProfileOperation,
  spawnCaptured,
} from '../src/profiles/actions.ts'
import {
  operationInFlight,
  resetProfilesRuntime,
  runExclusively,
} from '../src/profiles/runtime.ts'
import { displayArgument, resolveOperation } from '../src/profiles/model.ts'

// The runtime is process-scoped by design, so a test that leaves an operation
// or a queued restart behind would poison the next one.
afterEach(() => { resetProfilesRuntime() })

/** Real published Harness process provider for lifecycle and platform tests. */
const processContext = new Context()

beforeAll(async () => { await processContext.plugin(LocalSubprocessRuntime) })
afterAll(async () => { await processContext.fiber.dispose() })

/** A launcher that is present, without touching the environment. */
const FOUND: () => LauncherResolution = () => ({
  kind: 'found',
  launcher: { command: '/usr/local/bin/dsh', prefix: [], describe: 'dsh on your PATH' },
})

/** A never-called child runner, for paths that must not spawn. */
const NEVER: (launcher: Launcher, args: readonly string[]) => Promise<ChildResult> = () => {
  throw new Error('must not spawn')
}

/** A launcher that runs one inline Node program. */
function nodeProgram(source: string): Launcher {
  return { command: process.execPath, prefix: ['-e', source], describe: 'test child' }
}

describe('the command line a reader could run themselves', () => {
  it('names the profile and the forwarded arguments', () => {
    expect(pluginCommand('dshline', ['add', '@example/plugin']))
      .toBe('dsh plugin --profile dshline add @example/plugin')
  })

  it('quotes an argument a shell would otherwise act on', () => {
    // An argv list pasted together with spaces is not the command that ran.
    const shown = pluginCommand('dshline', ['add', 'name; echo harmless-fixture'])
    expect(shown).toContain(`'name; echo harmless-fixture'`)
    expect(shown).not.toContain('add name; echo')
  })

  it('withholds a spec that could carry a credential', () => {
    // The transcript outlives the overlay, so a token pasted into the prompt
    // must not be preserved in it.
    const shown = pluginCommand('dshline', ['add', 'https://x-token:ghp_secret@example.com/p.tgz'])
    expect(shown).not.toContain('ghp_secret')
    expect(shown).toContain('withheld')
  })

  it('leaves an ordinary registry name alone', () => {
    expect(displayArgument('@scope/name')).toBe('@scope/name')
    expect(displayArgument('name@1.2.3')).toBe('name@1.2.3')
  })

  it('withholds every URL-shaped spec form pnpm accepts', () => {
    for (const spec of ['https://h/p.tgz', 'git+ssh://git@h/p.git', 'git+https://h/p.git']) {
      expect(displayArgument(spec), spec).toBe('<url spec withheld>')
    }
  })
})

describe('redacting what the child echoed back', () => {
  it('strips userinfo from a URL pnpm printed', () => {
    const line = redactOutputLine('ERR  fetch https://x-access-token:ghp_secret@example.com/p.tgz failed')
    expect(line).not.toContain('ghp_secret')
    expect(line).toContain('<redacted>@')
  })

  it('strips a token query parameter', () => {
    const line = redactOutputLine('GET https://example.com/p.tgz?token=abc123 200')
    expect(line).not.toContain('abc123')
    expect(line).toContain('<redacted>')
  })

  it('leaves ordinary output untouched', () => {
    expect(redactOutputLine('Progress: resolved 12, added 3')).toBe('Progress: resolved 12, added 3')
  })

  it('withholds every URL query and fragment, not only known credential names', () => {
    for (const suffix of ['?auth=private-sentinel', '?X-Amz-Signature=private-sentinel', '?tenant=one&sig=private-sentinel#fragment', '#private-sentinel']) {
      const shown = redactOutputLine(`GET https://example.invalid/package.tgz${suffix} failed`)
      expect(shown, suffix).not.toContain('private-sentinel')
      expect(shown, suffix).toContain('<redacted>')
      expect(shown, suffix).toContain('example.invalid/package.tgz')
    }
  })

  it('redacts signed URL diagnostics in both the headline and output without changing argv', async () => {
    const spec = 'https://example.invalid/p.tgz?auth=private-sentinel'
    const outcome = await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('add', spec),
      launcher: FOUND,
      run: async (_launcher, args) => {
        expect(args.at(-1)).toBe(spec)
        return { code: 1, output: `ERR_PNPM_FETCH_401 GET ${spec}\n` }
      },
    })
    expect(JSON.stringify(outcome)).not.toContain('private-sentinel')
    expect(outcome.message).toContain('ERR_PNPM_FETCH_401')
    expect(outcome.output).toHaveLength(1)
  })
})

describe('running one operation', () => {
  it('forwards plugin, --profile, the name, then the operation arguments', async () => {
    const calls: { command: string; args: readonly string[] }[] = []
    await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('add', '@example/plugin'),
      launcher: FOUND,
      run: async (launcher, args) => {
        calls.push({ command: launcher.command, args })
        return { code: 0, output: '' }
      },
    })
    expect(calls).toEqual([{
      command: '/usr/local/bin/dsh',
      args: ['plugin', '--profile', 'dshline', 'add', '@example/plugin'],
    }])
  })

  it('reports success with what the operation was', async () => {
    const outcome = await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('add', '@example/plugin'),
      launcher: FOUND,
      run: async () => ({ code: 0, output: 'done\n' }),
    })
    expect(outcome.kind).toBe('done')
    expect(outcome.message).toContain('installing @example/plugin')
  })

  it('reports an incomplete Host without taking process ownership back', async () => {
    const outcome = await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('init'),
      launcher: FOUND,
    })
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('subprocess capability is unavailable')
    expect(outcome.message).toContain('run this yourself')
  })

  it('names the exact command when no launcher can be found', async () => {
    const outcome = await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('update-all', undefined, ['@a/one']),
      launcher: () => ({ kind: 'none' }),
      run: NEVER,
    })
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('could not be found')
    expect(outcome.message).toContain('dsh plugin --profile dshline update @a/one')
  })

  it('repeats the misconfiguration when the user pointed at a launcher that is not there', async () => {
    // Distinct from "none": a wrong DSH_BIN is a sentence about the value they
    // set, not an invitation to install anything.
    const outcome = await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('init'),
      launcher: () => ({ kind: 'misconfigured', message: '$DSH_BIN points at /nope, which does not exist' }),
      run: NEVER,
    })
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('$DSH_BIN points at /nope')
  })

  it('passes a checkout launcher its prefix and working directory', async () => {
    // The DSH_HARNESS case: the launcher is a script inside the checkout whose
    // loader resolves from there, so it only runs with that cwd.
    let seen: Launcher | undefined
    await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('init'),
      launcher: () => ({
        kind: 'found',
        launcher: {
          command: 'node',
          prefix: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts'],
          cwd: '/src/harness',
          describe: '$DSH_HARNESS',
        },
      }),
      run: async launcher => {
        seen = launcher
        return { code: 0, output: '' }
      },
    })
    expect(seen?.prefix).toEqual(['--import', 'tsx/esm', 'apps/cli/src/bin.ts'])
    expect(seen?.cwd).toBe('/src/harness')
  })

  it('reports a non-zero exit with the child output tail', async () => {
    const outcome = await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('add', '@example/missing'),
      launcher: FOUND,
      run: async () => ({ code: 1, output: 'ERR_PNPM_FETCH_404\nnot found\n' }),
    })
    expect(outcome.kind).toBe('failed')
    // The reason, not the exit code: see the failure-reason suite below.
    expect(outcome.message).toContain('ERR_PNPM_FETCH_404')
    expect(outcome.output).toEqual(['ERR_PNPM_FETCH_404', 'not found'])
  })

  it('bounds the kept output so a long pnpm log cannot flood the transcript', async () => {
    const output = Array.from({ length: 200 }, (_unused, index) => `line ${String(index)}`).join('\n')
    const outcome = await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('update-all', undefined, ['@a/one']),
      launcher: FOUND,
      run: async () => ({ code: 1, output }),
    })
    expect(outcome.output.length).toBeLessThanOrEqual(10)
    expect(outcome.output.at(-1)).toBe('line 199')
  })

  it('redacts the committed output tail, not only the command', async () => {
    const outcome = await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('add', 'https://h/p.tgz'),
      launcher: FOUND,
      run: async () => ({ code: 1, output: 'ERR fetch https://user:ghp_secret@h/p.tgz failed\n' }),
    })
    expect(outcome.output.join('\n')).not.toContain('ghp_secret')
    expect(outcome.message).not.toContain('ghp_secret')
  })

  it('drops blank lines from the kept output', async () => {
    const outcome = await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('update-all', undefined, ['@a/one']),
      launcher: FOUND,
      run: async () => ({ code: 1, output: 'first\n\n\n   \nlast\n' }),
    })
    expect(outcome.output).toEqual(['first', 'last'])
  })
})

describe('one operation per profile, for the whole process', () => {
  it('refuses a second operation on the same profile while one is running', async () => {
    let release = (): void => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const first = runExclusively('dshline', 'installing x', async () => {
      await held
      return 'first'
    })
    expect(operationInFlight('dshline')).toBe(true)
    // The overlay that started `first` may be long gone; the lock is not its
    // to release, which is the whole point.
    expect(await runExclusively('dshline', 'installing y', async () => 'second')).toBeUndefined()
    release()
    expect(await first).toBe('first')
    expect(operationInFlight('dshline')).toBe(false)
  })

  it('allows concurrent operations on different profiles', async () => {
    let release = (): void => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const first = runExclusively('dshline', 'installing x', async () => {
      await held
      return 'a'
    })
    // A different directory and a different lockfile: nothing to serialize.
    expect(await runExclusively('web', 'installing b', async () => 'b')).toBe('b')
    release()
    expect(await first).toBe('a')
  })

  it('releases the lock when the operation throws', async () => {
    await expect(runExclusively('dshline', 'installing x', async () => { throw new Error('pnpm exploded') }))
      .rejects.toThrow('pnpm exploded')
    expect(operationInFlight('dshline')).toBe(false)
  })
})

describe('the timeout is a bound, not a request', () => {
  it('settles even when the child ignores SIGTERM', async () => {
    // The bug this pins: SIGTERM followed by an indefinite wait is not a bound,
    // and the profile lock is held until this promise settles.
    const stubborn = "process.on('SIGTERM', () => {}); setInterval(() => {}, 50)"
    const result = await spawnCaptured(
      processContext.subprocess,
      nodeProgram(stubborn),
      [],
      { timeoutMs: 120, killGraceMs: 120 },
    )
    expect(result.code).not.toBe(0)
    expect(result.output).toContain('stopping the child')
  }, 10_000)

  it('settles on an ordinary child that exits on its own', async () => {
    const result = await spawnCaptured(
      processContext.subprocess,
      nodeProgram("process.stdout.write('hello'); process.exit(3)"),
      [],
      { timeoutMs: 5_000 },
    )
    expect(result.code).toBe(3)
    expect(result.output).toContain('hello')
  }, 10_000)

  it('restores the Host-resolved DSH_HOME for the nested launcher', async () => {
    const result = await spawnCaptured(
      processContext.subprocess,
      nodeProgram("process.stdout.write(process.env.DSH_HOME ?? 'missing')"),
      [],
      { timeoutMs: 5_000 },
      '/tmp/dshline-harness-home',
    )
    expect(result.code).toBe(0)
    expect(result.output).toBe('/tmp/dshline-harness-home')
  }, 10_000)

  it('reports a launcher that cannot be executed at all', async () => {
    const result = await spawnCaptured(
      processContext.subprocess,
      { command: '/nonexistent/launcher', prefix: [], describe: 'missing' },
      [],
      { timeoutMs: 5_000 },
    )
    expect(result.code).toBe(127)
  }, 10_000)

  it('holds only a bounded tail of a noisy child', async () => {
    // 4MB of output must not become 4MB of retained string.
    const noisy = "for (let i = 0; i < 60000; i += 1) process.stdout.write('x'.repeat(70) + '\\n')"
    const result = await spawnCaptured(processContext.subprocess, nodeProgram(noisy), [], { timeoutMs: 20_000 })
    expect(result.code).toBe(0)
    expect(result.output.length).toBeLessThanOrEqual(16_384)
  }, 25_000)

  it('does not display a signed URL suffix after its prefix left the retained window', async () => {
    const source = "process.stdout.write('https://example.invalid/' + 'x'.repeat(20000) + '?auth=private-sentinel\\ncomplete diagnostic\\n')"
    const result = await spawnCaptured(processContext.subprocess, nodeProgram(source), [], { timeoutMs: 5_000 })
    expect(result.code).toBe(0)
    expect(result.output).toBe('complete diagnostic\n')
    expect(redactOutputLine(result.output)).not.toContain('private-sentinel')
  })
})

describe('the environment the launcher child runs with', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('restores package-manager credentials that the scrub removes by shape', async () => {
    // pnpm expands `_authToken=${NPM_TOKEN}` from an .npmrc against the CHILD's
    // environment, so a private-registry install that authenticated under
    // direct spawning would fail under the seam's scrub without this restore.
    vi.stubEnv('NPM_TOKEN', 'env-test-token')
    vi.stubEnv('NODE_AUTH_TOKEN', 'env-test-gh-token')
    const result = await spawnCaptured(
      processContext.subprocess,
      nodeProgram("process.stdout.write([process.env.NPM_TOKEN, process.env.NODE_AUTH_TOKEN].join(' '))"),
      [],
      { timeoutMs: 5_000 },
    )
    expect(result.output).toBe('env-test-token env-test-gh-token')
  }, 10_000)

  it('still keeps everything outside those namespaces away from install scripts', async () => {
    // The scrub's point stands: harness and model secrets must not reach the
    // lifecycle scripts of whatever the operation installs.
    vi.stubEnv('DEEPSEEK_API_KEY', 'must-not-travel')
    vi.stubEnv('GITHUB_TOKEN', 'also-must-not-travel')
    const result = await spawnCaptured(
      processContext.subprocess,
      nodeProgram(
        "process.stdout.write((process.env.DEEPSEEK_API_KEY ?? 'absent') + ' ' + (process.env.GITHUB_TOKEN ?? 'absent'))",
      ),
      [],
      { timeoutMs: 5_000 },
    )
    expect(result.output).toBe('absent absent')
  }, 10_000)
})

describe('a failure says what went wrong, not just that it did', () => {
  it('picks the reason line out of pages of progress', () => {
    // A bracketed code, a bare code, and git's own prefix are the three shapes
    // pnpm and its children actually use.
    expect(failureReason('Progress: resolved 1\nERR_PNPM_FETCH_404 GET x: Not Found\n'))
      .toContain('ERR_PNPM_FETCH_404')
    expect(failureReason('[ERR_PNPM_GIT_RESOLVE_FAILED] Failed to resolve\n'))
      .toContain('ERR_PNPM_GIT_RESOLVE_FAILED')
    expect(failureReason("fatal: could not read Username for 'https://github.com'"))
      .toContain('fatal: could not read Username')
    expect(failureReason('Progress: resolved 3, reused 3\nAlready up to date\n')).toBeUndefined()
  })

  it('never lets a trailing warning become the headline', () => {
    // Seen on a real run: pnpm prints deprecation and peer warnings around the
    // error, and the reason search takes the LAST match.
    const output = [
      '[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/nope: Not Found',
      '[WARN] 6 deprecated subdependencies found: a@1, b@2',
      '[WARN] Issues with peer dependencies found. Run "pnpm peers check" to list them.',
    ].join('\n')
    expect(failureReason(output)).toContain('ERR_PNPM_FETCH_404')
    expect(failureReason(output)).not.toContain('deprecated')
  })

  it('still reports a genuine error that pnpm prints last', () => {
    // The real shape from a live `U`: warnings first, the failing policy error
    // last. That one IS the reason.
    const output = [
      '[WARN] Issues with peer dependencies found.',
      '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: a@1, b@2',
    ].join('\n')
    expect(failureReason(output)).toContain('ERR_PNPM_IGNORED_BUILDS')
  })

  it('names the pnpm error code rather than reporting "exited 1"', async () => {
    // The manual report this fixes: a mistyped package name produced only
    // "dsh plugin --profile X add deepseek-ai exited 1", which is true of a
    // mistyped name and an unreachable remote alike.
    const outcome = await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('add', 'deepseek-ai'),
      launcher: FOUND,
      run: async () => ({
        code: 1,
        output: 'Progress: resolved 1\n ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/deepseek-ai: Not Found\n',
      }),
    })
    expect(outcome.message).toContain('ERR_PNPM_FETCH_404')
    expect(outcome.message).not.toContain('exited 1')
  })

  it('names a git resolution failure, which needs a different fix entirely', async () => {
    const outcome = await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('add', 'someone/some-plugin'),
      launcher: FOUND,
      run: async () => ({
        code: 1,
        output: [
          'Progress: resolved 0, reused 0',
          '[ERR_PNPM_GIT_RESOLVE_FAILED] Failed to resolve git dependency',
          'fatal: could not read Username for \'https://github.com\': terminal prompts disabled',
        ].join('\n'),
      }),
    })
    // The LAST reason wins: pnpm prints the summarizing error after the attempt.
    expect(outcome.message).toContain('fatal: could not read Username')
    expect(outcome.output.join('\n')).toContain('ERR_PNPM_GIT_RESOLVE_FAILED')
  })

  it('falls back to the exit code when the child named no reason at all', async () => {
    const outcome = await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('init'),
      launcher: FOUND,
      run: async () => ({ code: 2, output: 'Progress: resolved 3, reused 3\n' }),
    })
    expect(outcome.message).toContain('exited 2')
  })

  it('keeps the reason redacted, like every other committed line', async () => {
    const outcome = await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('add', 'https://h/p.tgz'),
      launcher: FOUND,
      run: async () => ({ code: 1, output: 'ERR_PNPM_FETCH_401 https://u:ghp_secret@h/p.tgz\n' }),
    })
    expect(outcome.message).not.toContain('ghp_secret')
    expect(outcome.message).toContain('ERR_PNPM_FETCH_401')
  })

  it('bounds a pathologically long reason line', async () => {
    const outcome = await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('init'),
      launcher: FOUND,
      run: async () => ({ code: 1, output: `ERR_PNPM_WHATEVER ${'x'.repeat(5_000)}\n` }),
    })
    expect(outcome.message.length).toBeLessThan(400)
  })
})

describe('a failure that is a pending decision, not a mistake', () => {
  it('names the build decision that is blocking the profile', async () => {
    // Seen on a real machine: every operation on the profile fails until a
    // human answers pnpm's allowBuilds placeholders. Told only "ignored build
    // scripts", a reader cannot tell that from a broken install.
    const outcome = await runProfileOperation({
      profile: 'dshline',
      resolved: resolveOperation('update-all', undefined, ['@a/one']),
      launcher: FOUND,
      run: async () => ({
        code: 1,
        output: '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @google/genai@1.52.0, protobufjs@7.6.5\n',
      }),
    })
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toContain('allowBuilds')
    expect(outcome.message).toContain('pnpm-workspace.yaml')
  })

  it('answers no decision itself, and adds nothing to an ordinary failure', () => {
    // Allowing a build script runs arbitrary install-time code; the decision is
    // named, never made.
    expect(pendingDecision('ERR_PNPM_FETCH_404 Not Found')).toBeUndefined()
    expect(pendingDecision(undefined)).toBeUndefined()
    expect(pendingDecision('[ERR_PNPM_IGNORED_BUILDS] x')).toContain('true or false')
  })
})

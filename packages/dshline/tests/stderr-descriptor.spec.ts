/**
 * The Node runtime behaviour the stderr shim is built on, pinned by real processes.
 *
 * `src/stderr.ts` contains an upstream defect by substituting the descriptor
 * `process.stderr.fd` reports. Whether that is correct is a question about Node,
 * not about dshline, and a stubbed `WriteStream` cannot answer it — it answers
 * what the stub does. So these tests drive real `node` children with real
 * descriptors and read the files afterwards.
 *
 * Three facts are pinned, and the third is the reason the shim has a guard at
 * all:
 *
 * 1. `writeFileSync(process.stderr.fd, …)` resolves the property at call time,
 *    so a raw write follows the substituted descriptor, and the substitution is
 *    exactly reversible.
 * 2. Where `process.stderr` is a socket-backed stream — a pipe here, and a
 *    terminal in production, both `net.Socket` writing through a libuv handle
 *    opened once — `write` does NOT re-resolve the property, so the ordinary
 *    stream path is untouched by the substitution. This is the case the shim
 *    actually runs in.
 * 3. Where `process.stderr` is a FILE, Node uses `SyncWriteStream`, which
 *    writes through `this.fd` on every call — so substituting it would capture
 *    the ordinary stream path too. That is not a hazard in production only
 *    because `rawStderrReach` refuses to hold a stderr that is not a terminal.
 *    The refusal is load-bearing, so the reason for it is recorded here rather
 *    than asserted in a comment.
 *
 * The children mirror the shim's two operations rather than importing it: the
 * claims under test are the runtime's, and a child that had to resolve the
 * frontend's TypeScript would be testing a loader as well. `foreign-writes.spec.ts`
 * covers the shim's own policy.
 * @module dshline/tests/stderr-descriptor
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)

/** Long enough for a cold Node start on a loaded runner, short enough to fail fast. */
const CHILD_TIMEOUT_MS = 30_000

/** Distinct markers, because the whole question is which destination each reaches. */
const RAW_HELD = 'raw-while-held'
const STREAM_HELD = 'stream-while-held'
const RAW_RELEASED = 'raw-after-release'

/** One driven child: its own temp directory, its own destinations, its own verdict. */
interface Child {
  /** Whatever the program printed on stdout, including its own diagnostics. */
  readonly stdout: string
  /** The program's exit status, read back through the shell. */
  readonly status: number
  /** Contents of the file the substituted descriptor was opened on. */
  readonly hole: string
  /** Contents of whatever the child's real stderr was redirected into. */
  readonly stderr: string
}

/**
 * Run one child program with its stderr redirected the way a case needs.
 *
 * `sh -c` owns the redirection so the child inherits descriptor 2 as the shell
 * set it up — which is the only way to give a child a stderr that is a file in
 * one case and a pipe in another without Node choosing for us.
 * @param source - the program, as a function of its hole path.
 * @param redirect - shell redirection for descriptor 2, given the stderr path.
 * @returns what the child printed, exited with, and left in each destination.
 */
async function drive(
  source: (hole: string) => string,
  redirect: (stderrPath: string) => string,
): Promise<Child> {
  const directory = mkdtempSync(join(tmpdir(), 'dshline-stderr-fd-'))
  try {
    const hole = join(directory, 'hole')
    const stderrPath = join(directory, 'real-stderr')
    const script = join(directory, 'child.mjs')
    // Created up front so a case whose child never writes to one still reads an
    // empty string rather than failing on a missing file.
    writeFileSync(hole, '')
    writeFileSync(stderrPath, '')
    writeFileSync(script, source(hole))
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${redirect(stderrPath)}; echo "exit:$?"`
    const result = await run('sh', ['-c', command], { timeout: CHILD_TIMEOUT_MS })
    return {
      stdout: result.stdout,
      status: Number(/exit:(?<code>\d+)/u.exec(result.stdout)?.groups?.code ?? '-1'),
      hole: readFileSync(hole, 'utf8'),
      stderr: readFileSync(stderrPath, 'utf8'),
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * The shim's own sequence: substitute, write raw, write through the stream,
 * restore, write raw again.
 *
 * The preconditions are checked in the child and reported by exit status, so a
 * runtime that stops honouring one names which one rather than producing a
 * confusing file comparison.
 * @param hole - path the substituted descriptor is opened on.
 * @returns the program's source.
 */
function shimSequence(hole: string): string {
  return `
import { closeSync, openSync, writeFileSync } from 'node:fs'

const original = Object.getOwnPropertyDescriptor(process.stderr, 'fd')
if (original === undefined || !('value' in original) || original.configurable !== true) {
  console.log('process.stderr.fd is not a redefinable value property')
  process.exit(3)
}
const realFd = original.value
const hole = openSync(${JSON.stringify(hole)}, 'w')
console.log('stream=' + process.stderr.constructor.name)

// Exactly what src/stderr.ts does, and nothing more.
Object.defineProperty(process.stderr, 'fd', { ...original, value: hole })
if (process.stderr.fd !== hole) { console.log('the substitution did not take'); process.exit(4) }

writeFileSync(process.stderr.fd, ${JSON.stringify(RAW_HELD)})
process.stderr.write(${JSON.stringify(STREAM_HELD)})

Object.defineProperty(process.stderr, 'fd', original)
if (process.stderr.fd !== realFd) { console.log('the substitution did not reverse'); process.exit(5) }
closeSync(hole)

writeFileSync(process.stderr.fd, ${JSON.stringify(RAW_RELEASED)})
console.log('ok')
`
}

describe.skipIf(process.platform === 'win32')('substituting the descriptor process.stderr reports', () => {
  it('holds the raw path and leaves a socket-backed stream path alone', async () => {
    // A pipe, which is the same stream family a terminal gets: `net.Socket`
    // writing through a handle opened once, rather than through the property.
    // This is the configuration the shim actually engages in.
    const child = await drive(shimSequence, path => `2>&1 1>/dev/null | cat > ${JSON.stringify(path)}`)
    expect(child.status, child.stdout).toBe(0)

    // (1) the raw write while held followed the substituted descriptor, and
    // nothing else did.
    expect(child.hole).toBe(RAW_HELD)

    // (2) the ordinary stream path was untouched, and (1) reversed cleanly: the
    // post-release raw write is back on the real descriptor.
    expect(child.stderr).toBe(`${STREAM_HELD}${RAW_RELEASED}`)
    expect(child.stderr).not.toContain('exit:')
  })

  it('would capture a file-backed stream path too, which is why a non-terminal stderr is never held', async () => {
    // Node writes a file-backed stderr through `SyncWriteStream`, which reads
    // `this.fd` on every call — the same property the shim substitutes. So here
    // the ordinary stream path follows the hole as well.
    //
    // `rawStderrReach` returns `cannot-reach` for any stderr that is not a
    // terminal, so this configuration is never held in production. This test is
    // the record of WHY that refusal matters: it is not only that a raw write
    // could not corrupt a frame, it is that holding would redirect writes the
    // shim has no business redirecting.
    const child = await drive(shimSequence, path => `2> ${JSON.stringify(path)}`)
    expect(child.status, child.stdout).toBe(0)
    expect(child.stdout).toContain('stream=SyncWriteStream')
    expect(child.hole).toContain(RAW_HELD)
    expect(child.hole).toContain(STREAM_HELD)
  })
})

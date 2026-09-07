import { describe, expect, it } from 'vitest'
import type { ToolCallView, ToolDefinition, ToolResultView } from '@deepseek-ai/dsh-tools'
import { displayWidth, Screen, stripAnsi } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import type { CardDetail, ResultInput } from '../src/cards.ts'
import { ToolCards } from '../src/cards.ts'

/** Wide enough that nothing under test wraps, so assertions read as content. */
const COLUMNS = 90

/** Body rows a compact card shows, mirroring COMPACT_ROWS in the source. */
const COMPACT_BUDGET = 6

/** Strip styling, so assertions read as what a person would see. */
function plain(lines: readonly string[]): string[] {
  return lines.map(stripAnsi)
}

/**
 * A tool that declares the given presenters and nothing else.
 * @param presenters - the call and result views to return.
 * @returns a lookup for ToolCards.
 */
function tool(presenters: {
  call?: (args: unknown) => ToolCallView | undefined
  result?: (args: unknown) => ToolResultView | undefined
}): (name: string) => ToolDefinition | undefined {
  return () => ({
    ...presenters.call === undefined ? {} : { presentCall: presenters.call },
    ...presenters.result === undefined ? {} : { presentResult: presenters.result },
  } as unknown as ToolDefinition)
}

/** A tool that declares no presenters, the fallback path. */
const bare = (): ToolDefinition | undefined => ({} as unknown as ToolDefinition)

/**
 * A tool/result payload.
 * @param text - the model-facing result text.
 * @param extra - overrides.
 * @returns the input ToolCards reads.
 */
function result(text: string, extra: Partial<ResultInput> = {}): ResultInput {
  return { callId: 'c1', content: [{ type: 'text', text }], isError: false, ...extra }
}

/**
 * Draw one call and its result at a detail level.
 * @param lookup - the tool lookup.
 * @param detail - the level to draw at.
 * @returns the rows, styling removed.
 */
function draw(
  lookup: (name: string) => ToolDefinition | undefined,
  { detail = 'compact' as CardDetail, args = '{}', text = '' } = {},
): string[] {
  const cards = new ToolCards(lookup, '/w')
  cards.detail = detail
  const rows = cards.call({ callId: 'c1', name: 'demo', arguments: args }, COLUMNS)
  return plain([...rows, ...cards.result(result(text), COLUMNS)])
}

describe('a tool that declares nothing', () => {
  it('summarizes its arguments as key=value pairs', () => {
    expect(draw(bare, { args: '{"file_path":"src/index.ts","offset":10}' }))
      .toEqual(['', '⏺ demo', '  file_path=src/index.ts offset=10'])
  })

  it('shows malformed model JSON as it actually arrived', () => {
    // The harness logs arguments verbatim so a bad call stays reconstructable;
    // treating unparseable JSON as an error would hide what the model sent.
    expect(draw(bare, { args: '{"file_path": ' })).toEqual(['', '⏺ demo', '  {"file_path": '])
  })

  it('renders its raw result, the fallback every intent degrades to', () => {
    expect(draw(bare, { text: 'one\ntwo' })).toEqual(['', '⏺ demo', '  ⎿ one', '    two'])
  })

  it('elides a long result and says how much it hid', () => {
    const rows = draw(bare, { text: Array.from({ length: 20 }, (_, i) => `line ${String(i)}`).join('\n') })
    expect(rows.at(-1)).toBe('    … 14 more lines · ctrl+o view')
  })

  it('shows every line at full detail', () => {
    const rows = draw(bare, {
      detail: 'full',
      text: Array.from({ length: 20 }, (_, i) => `line ${String(i)}`).join('\n'),
    })
    expect(rows.at(-1)).toBe('    line 19')
    expect(rows.join('\n')).not.toContain('more lines')
  })

  it('neutralizes an escape sequence in tool output', () => {
    // Tool output is untrusted: a sequence reaching the terminal unescaped would
    // be obeyed rather than shown.
    expect(draw(bare, { text: '[2Jwiped' })).toContain('  ⎿ ^[[2Jwiped')
  })

  it('reports a failed call by the code the runtime gave it', () => {
    const cards = new ToolCards(bare, '/w')
    expect(plain(cards.result(result('', { error: { code: 'ENOENT', name: 'Error' } }), COLUMNS)))
      .toEqual(['  ⎿ ENOENT'])
  })
})

describe('render intent', () => {
  it('draws a terminal call as a framed command headed by its working directory', () => {
    const rows = draw(tool({ call: () => ({ card: 'terminal', title: 'pnpm test', cwd: '/w/repo' }) }))
    expect(rows[1]).toContain('/w/repo')
    expect(rows.join('\n')).toContain('pnpm test')
    // Framed, not a bare line: the border is what separates a command from prose,
    // and indented so it lines up with the output frame that follows it.
    expect(rows[1]?.startsWith('  ╭')).toBe(true)
  })

  it('shows a failing command\'s exit status on its output frame', () => {
    const rows = draw(
      tool({ result: () => ({ card: 'terminal', output: 'boom', exitCode: 2 }) }),
    )
    expect(rows.join('\n')).toContain('exit 2')
    expect(rows.join('\n')).toContain('boom')
  })

  it('says a command produced no output rather than drawing an empty frame', () => {
    expect(draw(tool({ result: () => ({ card: 'terminal', output: '', exitCode: 0 }) })).at(-1))
      .toBe('  no output')
  })

  it('names the signal that killed a command', () => {
    expect(draw(tool({ result: () => ({ card: 'terminal', signal: 'SIGTERM' }) })).join('\n'))
      .toContain('killed by SIGTERM')
  })

  it('marks added lines with + and removed lines with -', () => {
    const rows = draw(tool({
      result: () => ({
        card: 'diff',
        title: 'Edit config.ts',
        diffs: [{ path: 'config.ts', oldText: 'a\nold\nc', newText: 'a\nnew\nc' }],
      }),
    }))
    expect(rows).toContain('    - old')
    expect(rows).toContain('    + new')
    // The unchanged context is not repeated as a change.
    expect(rows.join('\n')).not.toContain('- a')
  })

  it('colours removals red and additions green', () => {
    // The marks alone are readable stripped; the colour is the thing a reader sees
    // first, and only an unstripped assertion can prove it is there.
    const cards = new ToolCards(tool({
      result: () => ({ card: 'diff', diffs: [{ path: 'f', oldText: 'old', newText: 'new' }] }),
    }), '/w')
    cards.call({ callId: 'c1', name: 'demo', arguments: '{}' }, COLUMNS)
    const joined = cards.result(result(''), COLUMNS).join('\n')
    expect(joined).toContain('[31m- old')
    expect(joined).toContain('[32m+ new')
  })

  it('treats a new file as all additions, since there is nothing to diff against', () => {
    const rows = draw(tool({
      result: () => ({ card: 'diff', title: 'Write new.ts', diffs: [{ path: 'new.ts', oldText: null, newText: 'a\nb' }] }),
    }))
    expect(rows).toContain('    + a')
    expect(rows).toContain('    + b')
  })

  it('says a diff changed nothing rather than drawing an empty change', () => {
    const rows = draw(tool({
      result: () => ({ card: 'diff', title: 'Edit f', diffs: [{ path: 'f', oldText: 'same', newText: 'same' }] }),
    }))
    expect(rows.join('\n')).toContain('(no change)')
  })

  it('draws a change once, though a mutation tool declares it from both presenters', () => {
    // The harness's card model has the completed view REPLACE the pending one, so
    // a mutation tool returns its diff twice on purpose. This screen appends, so
    // drawing both printed every change twice — once proposed, once applied.
    const diffs = [{ path: 'f.ts', oldText: 'old', newText: 'new' }]
    const rows = draw(tool({
      call: () => ({ card: 'diff', title: 'Edit f.ts', diffs }),
      result: () => ({ card: 'diff', diffs }),
    }))
    expect(rows.filter(row => row.endsWith('+ new'))).toHaveLength(1)
    expect(rows).toEqual(['', '◆ Edit f.ts', '  ⎿ f.ts', '    - old', '    + new'])
  })

  it('keeps the proposed change when the tool declares no result-time diff', () => {
    // Otherwise the only description of what a mutation changed is lost.
    const rows = draw(tool({
      call: () => ({ card: 'diff', title: 'Edit f.ts', diffs: [{ path: 'f.ts', oldText: 'old', newText: 'new' }] }),
    }), { text: 'wrote 1 file' })
    expect(rows).toEqual(['', '◆ Edit f.ts', '  ⎿ f.ts', '    - old', '    + new'])
  })

  it('groups search matches under their file, which a flat list loses', () => {
    const rows = draw(tool({
      result: () => ({
        card: 'search',
        shape: 'matches',
        files: [{ path: 'a.ts', matches: [{ lineNumber: 12, line: '  const a = 1' }] }],
        truncated: false,
        total: 1,
      }),
    }))
    expect(rows).toEqual(['', '⏺ demo', '  ⎿ 1 match in 1 file', '    a.ts', '      12: const a = 1'])
  })

  it('marks a capped search so a partial result never reads as complete', () => {
    const rows = draw(tool({
      result: () => ({ card: 'search', shape: 'paths', paths: ['a', 'b'], truncated: true, total: 40 }),
    }))
    expect(rows[2]).toBe('  ⎿ 40+ paths')
  })

  it('keeps a read\'s own line numbers, not a re-count from one', () => {
    const rows = draw(tool({
      result: () => ({
        card: 'read',
        path: 'src/a.ts',
        offset: 40,
        lines: [{ number: 40, text: 'first' }, { number: 41, text: 'second' }],
        totalLines: 900,
      }),
    }))
    expect(rows[2]).toBe('  ⎿ src/a.ts · 2 of 900 lines')
    expect(rows[3]).toBe('      40 first')
    expect(rows[4]).toBe('      41 second')
  })

  it('lists a web search\'s sources with their urls', () => {
    const rows = draw(tool({
      result: () => ({
        card: 'web',
        kind: 'search',
        sources: [{ url: 'https://e.com/a', title: 'A page' }],
        truncated: false,
      }),
    }))
    expect(rows[2]).toBe('  ⎿ 1 source')
    expect(rows[3]).toBe('    A page https://e.com/a')
  })

  it('marks a capped web search, so a partial source list never reads as complete', () => {
    const rows = draw(tool({
      result: () => ({
        card: 'web',
        kind: 'search',
        sources: [{ url: 'https://e.com/a' }],
        truncated: true,
      }),
    }))
    expect(rows[2]).toBe('  ⎿ 1+ sources')
  })

  it('picks an icon from the call category', () => {
    expect(draw(tool({ call: () => ({ card: 'generic', title: 'Read a.ts', kind: 'read' }) }))[1])
      .toBe('◇ Read a.ts')
  })

  it('keeps a declared rawInput for full detail, since the title already says it', () => {
    // grep's view titles the call "Grep MIT in LICENSE" and sets rawInput to
    // "MIT", so showing both printed the pattern twice on every search.
    const view = { card: 'generic', title: 'Grep MIT in LICENSE', kind: 'search', rawInput: 'MIT' } as const
    expect(draw(tool({ call: () => view }))).toEqual(['', '⌕ Grep MIT in LICENSE'])
    expect(draw(tool({ call: () => view }), { detail: 'full' })).toEqual(['', '⌕ Grep MIT in LICENSE', '  MIT'])
  })

  it('titles a terminal frame with the workspace when the view leaves cwd open', () => {
    // The harness documents an omitted cwd as "the session workspace", and leaves
    // naming it to the frontend; an untitled frame loses where a command ran.
    expect(draw(tool({ call: () => ({ card: 'terminal', title: 'ls' }) })).join('\n')).toContain('/w')
  })

  it('falls back to the raw arguments for a card it has never seen', () => {
    // The unions are merge-extensible: a harness release may add a card, and
    // drawing nothing would lose the call entirely.
    const rows = draw(
      tool({ call: () => ({ card: 'future-card' } as unknown as ToolCallView) }),
      { args: '{"a":1}' },
    )
    expect(rows.slice(0, 3)).toEqual(['', '⏺ demo', '  a=1'])
  })

  it('falls a web arm it has never seen back to the raw result content', () => {
    // Same rule on the result side: an unknown arm must degrade to the fallback
    // rather than read a field it does not carry.
    const rows = draw(
      tool({ result: () => ({ card: 'web', kind: 'future-kind' } as unknown as ToolResultView) }),
      { text: 'raw content' },
    )
    expect(rows).toEqual(['', '⏺ demo', '  ⎿ raw content'])
  })

  it('falls back to raw content when a presenter throws', () => {
    // Presenters read the model's arguments, which may be any JSON at all. A throw
    // must not take down the render.
    const rows = draw(
      tool({ call: () => { throw new Error('bad args') }, result: () => { throw new Error('bad args') } }),
      { text: 'the result' },
    )
    expect(rows).toEqual(['', '⏺ demo', '  ⎿ the result'])
  })
})

describe('the detail toggle', () => {
  it('still names a hidden call, so the transcript cannot lie about what ran', () => {
    expect(draw(bare, { detail: 'hidden', args: '{"a":1}', text: 'output' }))
      .toEqual(['', '⏺ demo'])
  })

  it('still shows a hidden command, since the command is not its output', () => {
    const rows = draw(
      tool({ call: () => ({ card: 'terminal', title: 'rm -rf build', description: 'Clean' }) }),
      { detail: 'hidden' },
    )
    expect(rows.join('\n')).toContain('rm -rf build')
  })

  it('still reports a non-zero exit when the body is hidden', () => {
    expect(draw(tool({ result: () => ({ card: 'terminal', output: 'noise', exitCode: 1 }) }), { detail: 'hidden' }))
      .toEqual(['', '⏺ demo', '  exit 1'])
  })

  it('hides a diff body but keeps its title', () => {
    const rows = draw(
      tool({
        call: () => ({ card: 'diff', title: 'Edit f', diffs: [{ path: 'f', oldText: 'a', newText: 'b' }] }),
        result: () => ({ card: 'diff', diffs: [{ path: 'f', oldText: 'a', newText: 'b' }] }),
      }),
      { detail: 'hidden' },
    )
    expect(rows).toEqual(['', '◆ Edit f'])
  })

  it('keeps a search summary when the matches are hidden', () => {
    const rows = draw(
      tool({
        result: () => ({
          card: 'search',
          shape: 'matches',
          files: [{ path: 'a.ts', matches: [{ lineNumber: 1, line: 'x' }] }],
          truncated: false,
          total: 1,
        }),
      }),
      { detail: 'hidden' },
    )
    expect(rows).toEqual(['', '⏺ demo', '  ⎿ 1 match in 1 file'])
  })
})

describe('call and result pairing', () => {
  it('hands the presenter the arguments of its own call', () => {
    // presentResult takes the call's arguments as well as its result, and a
    // tool/result event carries only the result — the pairing is by call id.
    const seen: unknown[] = []
    const cards = new ToolCards(() => ({
      presentResult: (args: unknown) => {
        seen.push(args)
        return undefined
      },
    } as unknown as ToolDefinition), '/w')
    cards.call({ callId: 'first', name: 'demo', arguments: '{"n":1}' }, COLUMNS)
    cards.call({ callId: 'second', name: 'demo', arguments: '{"n":2}' }, COLUMNS)
    cards.result(result('', { callId: 'second' }), COLUMNS)
    cards.result(result('', { callId: 'first' }), COLUMNS)
    expect(seen).toEqual([{ n: 2 }, { n: 1 }])
  })

  it('renders a result whose call it never saw', () => {
    // A resumed or replayed log can begin partway through a turn.
    const cards = new ToolCards(bare, '/w')
    expect(plain(cards.result(result('orphan'), COLUMNS))).toEqual(['  ⎿ orphan'])
  })

  it('threads the tool-private meta payload through to the presenter', () => {
    // The read and web cards cannot be reconstructed from result text alone; the
    // tool projects them through meta and reads them back here.
    let seen: unknown
    const cards = new ToolCards(() => ({
      presentResult: (_args: unknown, given: { meta?: unknown }) => {
        seen = given.meta
        return undefined
      },
    } as unknown as ToolDefinition), '/w')
    cards.call({ callId: 'c1', name: 'demo', arguments: '{}' }, COLUMNS)
    cards.result(result('', { meta: { totalLines: 12 } }), COLUMNS)
    expect(seen).toEqual({ totalLines: 12 })
  })
})

describe('on a real terminal', () => {
  /**
   * Draw rows through an emulator and read back what a person sees.
   * @param rows - the card rows.
   * @param columns - the terminal width.
   * @returns the visible rows, trailing blanks trimmed.
   */
  async function shown(rows: readonly string[], columns: number): Promise<string[]> {
    const emulator = createEmulator(columns, 24)
    new Screen(emulator.target).commit(rows)
    return (await emulator.screen()).map(row => row.trimEnd()).filter(row => row !== '')
  }

  it('lines a terminal card\'s two frames up in the same columns', async () => {
    // The frames are drawn by separate events, so nothing but arithmetic keeps
    // their borders in one column — and a border off by one is the single most
    // visible rendering defect there is.
    const cards = new ToolCards(tool({
      call: () => ({ card: 'terminal', title: 'ls -la', cwd: '/w' }),
      result: () => ({ card: 'terminal', output: 'a\nb', exitCode: 0 }),
    }), '/w')
    const rows = await shown([
      ...cards.call({ callId: 'c1', name: 'demo', arguments: '{}' }, 60),
      ...cards.result(result(''), 60),
    ], 60)
    const borders = rows.filter(row => row.includes('╭') || row.includes('╰'))
    expect(borders).toHaveLength(4)
    expect(new Set(borders.map(row => row.indexOf('╭') + row.indexOf('╰') + 1)).size).toBe(1)
    expect(new Set(borders.map(row => row.length)).size).toBe(1)
  })

  it('leaves a failing command\'s last words on screen, and the way to the rest', async () => {
    // The whole point of the tail anchor, read off the terminal rather than off
    // the returned strings: what a person sees after a failed test run is the
    // failure, not the banner it started with.
    const output = [
      ...Array.from({ length: 40 }, (_unused, i) => `RUN suite ${String(i)}`),
      'FAIL  packages/dshline/tests/thing.spec.ts',
      'Tests  1 failed | 40 passed',
    ].join('\n')
    const cards = new ToolCards(tool({
      call: () => ({ card: 'terminal', title: 'pnpm test', cwd: '/w' }),
      result: () => ({ card: 'terminal', output, exitCode: 1 }),
    }), '/w')
    const rows = await shown([
      ...cards.call({ callId: 'c1', name: 'demo', arguments: '{}' }, 70),
      ...cards.result(result(''), 70),
    ], 70)
    const screen = rows.join('\n')
    expect(screen).toContain('Tests  1 failed | 40 passed')
    expect(screen).toContain('FAIL  packages/dshline/tests/thing.spec.ts')
    expect(screen).not.toContain('RUN suite 0')
    expect(screen).toContain('earlier lines · ctrl+o view')
    expect(screen).toContain('exit 1')
  })

  it('keeps a card inside the terminal at a narrow width', async () => {
    const cards = new ToolCards(tool({
      result: () => ({ card: 'terminal', output: 'x'.repeat(200), exitCode: 0 }),
    }), '/w')
    const rows = await shown([
      ...cards.call({ callId: 'c1', name: 'demo', arguments: '{}' }, 30),
      ...cards.result(result(''), 30),
    ], 30)
    // Nothing wrapped: a row wider than the terminal would break the frame open.
    expect(rows.every(row => row.length <= 30)).toBe(true)
  })
})

describe('review findings', () => {
  it('does not draw a proposed diff for a call that failed', () => {
    // Otherwise a mutation that errored shows its proposal as though it landed, and
    // the error body that says otherwise is suppressed.
    const cards = new ToolCards(tool({
      call: () => ({ card: 'diff', title: 'Edit f.ts', diffs: [{ path: 'f.ts', oldText: 'old', newText: 'new' }] }),
    }), '/w')
    cards.call({ callId: 'c1', name: 'demo', arguments: '{}' }, COLUMNS)
    const rows = plain(cards.result(result('permission denied', { isError: true }), COLUMNS))
    expect(rows.join('\n')).not.toContain('+ new')
    expect(rows.join('\n')).toContain('permission denied')
  })

  it('drops the delimiter that ends command output rather than drawing a blank row', () => {
    // A trailing newline terminates the last line; keeping it added an empty row
    // inside the frame, and at the compact boundary reported a hidden line when
    // nothing had been hidden.
    const six = 'a\nb\nc\nd\ne\nf\n'
    const rows = draw(tool({ result: () => ({ card: 'terminal', output: six, exitCode: 0 }) }))
    expect(rows.join('\n')).not.toContain('more lines')
    // No empty framed row: the body is exactly the six lines the command printed.
    expect(rows.filter(row => /^\s*\u2502\s*\u2502\s*$/u.test(row))).toHaveLength(0)
  })

  it('measures command output with tabs at their real width', () => {
    // escapeControls expands tabs, so a framed row of tabular output no longer pads
    // to the wrong width and shifts its right border.
    const rows = draw(tool({ result: () => ({ card: 'terminal', output: 'a\tb\tc', exitCode: 0 }) }), { detail: 'full' })
    const framed = rows.filter(row => row.includes('\u2502'))
    expect(framed.length).toBeGreaterThan(0)
    // Every framed row the same display width means the right border did not shift.
    expect(new Set(framed.map(row => displayWidth(row))).size).toBe(1)
    expect(rows.join('')).not.toContain('\t')
  })

  it('reports match rows its own budget dropped', () => {
    // The card's budget is separate from the tool's `truncated` flag, so without a
    // marker a card can hide matches while reporting a complete result.
    const files = Array.from({ length: 12 }, (_, i) => ({
      path: `file${String(i)}.ts`,
      matches: [{ lineNumber: 1, line: 'hit' }],
    }))
    const rows = draw(tool({
      result: () => ({ card: 'search', shape: 'matches', files, truncated: false, total: 12 }),
    }))
    expect(rows.at(-1)).toMatch(/more rows · ctrl\+o view$/u)
  })

  it('spends one row budget across every file of a bulk mutation', () => {
    // A per-file budget let a bulk change emit a header plus six rows for each of
    // hundreds of files, which is the opposite of what the cap is for.
    const diffs = Array.from({ length: 40 }, (_, i) => ({
      path: `f${String(i)}.ts`,
      oldText: 'old',
      newText: 'new',
    }))
    const rows = draw(tool({ result: () => ({ card: 'diff', diffs }) }))
    expect(rows.filter(row => row.includes('+ new')).length).toBeLessThanOrEqual(COMPACT_BUDGET)
    expect(rows.at(-1)).toMatch(/more changed lines in \d+ more files · ctrl\+o view$/u)
  })

  it('keeps unchanged lines between two edits out of the changed set', () => {
    const rows = draw(tool({
      result: () => ({
        card: 'diff',
        diffs: [{ path: 'f.ts', oldText: 'a\nx\nkeep\ny\nz', newText: 'a\nX\nkeep\nY\nz' }],
      }),
    }))
    expect(rows.join('\n')).not.toContain('keep')
    expect(rows.filter(row => row.trim().startsWith('-'))).toHaveLength(2)
    expect(rows.filter(row => row.trim().startsWith('+'))).toHaveLength(2)
  })

  it('invents no added line when a mutation clears a file', () => {
    const rows = draw(tool({
      result: () => ({ card: 'diff', diffs: [{ path: 'f.ts', oldText: 'a\nb', newText: '' }] }),
    }))
    expect(rows.filter(row => row.trim().startsWith('+'))).toHaveLength(0)
    expect(rows.filter(row => row.trim().startsWith('-'))).toHaveLength(2)
  })
})

describe('the calls a turn is waiting on', () => {
  it('names the newest call, and nothing once every one has landed', () => {
    const cards = new ToolCards(bare, '/w')
    expect(cards.inFlight()).toBeUndefined()
    cards.call({ callId: 'c1', name: 'read_file', arguments: '{}' }, COLUMNS)
    expect(cards.inFlight()).toEqual({ title: 'read_file', others: 0 })
    cards.result(result('', { callId: 'c1' }), COLUMNS)
    expect(cards.inFlight()).toBeUndefined()
  })

  it('counts the calls running beside it, because the harness runs them in parallel', () => {
    // Concurrency-safe calls are dispatched together, so several are legitimately
    // outstanding. Naming one of six would report a different number of tools.
    const cards = new ToolCards(bare, '/w')
    for (const [id, name] of [['c1', 'read_file'], ['c2', 'grep'], ['c3', 'run_shell_command']] as const) {
      cards.call({ callId: id, name, arguments: '{}' }, COLUMNS)
    }
    expect(cards.inFlight()).toEqual({ title: 'run_shell_command', others: 2 })
  })

  it('follows the count down whichever order the results arrive in', () => {
    // Parallel calls finish out of order by definition, and the newest pending is
    // whatever is left — not whatever was dispatched last.
    const cards = new ToolCards(bare, '/w')
    for (const [id, name] of [['c1', 'read_file'], ['c2', 'grep'], ['c3', 'run_shell_command']] as const) {
      cards.call({ callId: id, name, arguments: '{}' }, COLUMNS)
    }
    // Newest first: the name changes, the count drops.
    cards.result(result('', { callId: 'c3' }), COLUMNS)
    expect(cards.inFlight()).toEqual({ title: 'grep', others: 1 })
    // Oldest next: the name stays, the count drops.
    cards.result(result('', { callId: 'c1' }), COLUMNS)
    expect(cards.inFlight()).toEqual({ title: 'grep', others: 0 })
    cards.result(result('', { callId: 'c2' }), COLUMNS)
    expect(cards.inFlight()).toBeUndefined()
  })

  it('forgets calls a cancelled turn never resolved', () => {
    // ctrl-c leaves a dispatched call with no result. Left pending, it would be
    // reported as running through every turn that followed.
    const cards = new ToolCards(bare, '/w')
    cards.call({ callId: 'c1', name: 'run_shell_command', arguments: '{}' }, COLUMNS)
    cards.reset()
    expect(cards.inFlight()).toBeUndefined()
  })

  it('prefers the resolved presentation title and falls back to the tool name', () => {
    const titled = new ToolCards(tool({ call: () => ({ card: 'terminal', title: 'npm test' }) }), '/w')
    titled.call({ callId: 'c1', name: 'run_shell_command', arguments: '{}' }, COLUMNS)
    expect(titled.inFlight()).toEqual({ title: 'npm test', others: 0 })

    const untitled = new ToolCards(() => undefined, '/w')
    untitled.call({ callId: 'c1', name: 'custom_tool', arguments: '{}' }, COLUMNS)
    expect(untitled.inFlight()).toEqual({ title: 'custom_tool', others: 0 })
  })
})

describe('semantic activity across pending calls', () => {
  /**
   * Resolve call views by the name used in the test.
   * @param kinds - generic kinds, with undefined meaning no resolved definition.
   * @returns a scoped tool lookup.
   */
  function activities(
    kinds: Readonly<Record<string, 'terminal' | 'diff' | 'read' | 'search' | 'execute' | 'edit' | 'delete' | 'other' | undefined>>,
  ): (name: string) => ToolDefinition | undefined {
    return name => {
      const kind = kinds[name]
      if (kind === undefined) return undefined
      if (kind === 'terminal') return { presentCall: () => ({ card: 'terminal', title: 'npm test' }) } as ToolDefinition
      if (kind === 'diff') return { presentCall: () => ({ card: 'diff', title: 'Edit f', diffs: [] }) } as ToolDefinition
      return { presentCall: () => ({ card: 'generic', title: name, kind }) } as ToolDefinition
    }
  }

  /** Add a pending call with its id also used as its tool name. */
  function call(cards: ToolCards, id: string): void {
    cards.call({ callId: id, name: id, arguments: '{}' }, COLUMNS)
  }

  it('reports none, one shared category, and conservative mixed categories', () => {
    const cases = [
      { kinds: { read: 'read' }, expected: 'reading' },
      { kinds: { read1: 'read', read2: 'read' }, expected: 'reading' },
      { kinds: { search1: 'search', search2: 'search' }, expected: 'searching' },
      { kinds: { read: 'read', search: 'search' }, expected: 'working' },
      { kinds: { read: 'read', execute: 'execute' }, expected: 'working' },
      { kinds: { edit: 'edit', delete: 'delete' }, expected: 'editing' },
      { kinds: { read: 'read', unknown: undefined }, expected: 'working' },
      { kinds: { unknown: undefined, other: 'other' }, expected: 'working' },
    ] as const
    for (const { kinds, expected } of cases) {
      const cards = new ToolCards(activities(kinds), '/w')
      expect(cards.semanticActivity()).toBeUndefined()
      for (const name of Object.keys(kinds)) call(cards, name)
      expect(cards.semanticActivity(), JSON.stringify(kinds)).toBe(expected)
    }
  })

  it('recomputes mixed activity immediately as exact call ids drain', () => {
    const cards = new ToolCards(activities({ read: 'read', search: 'search' }), '/w')
    call(cards, 'read')
    call(cards, 'search')
    expect(cards.semanticActivity()).toBe('working')
    cards.result(result('', { callId: 'search' }), COLUMNS)
    expect(cards.semanticActivity()).toBe('reading')
    cards.result(result('', { callId: 'read' }), COLUMNS)
    expect(cards.semanticActivity()).toBeUndefined()
  })

  it('keeps the remaining category when an older call resolves last', () => {
    const cards = new ToolCards(activities({ older: 'read', newer: 'search' }), '/w')
    call(cards, 'older')
    call(cards, 'newer')
    cards.result(result('', { callId: 'newer' }), COLUMNS)
    expect(cards.semanticActivity()).toBe('reading')
    cards.result(result('', { callId: 'older' }), COLUMNS)
    expect(cards.semanticActivity()).toBeUndefined()
  })

  it('presents each call exactly once when semantic activity is read', () => {
    let invocations = 0
    const cards = new ToolCards(tool({ call: () => {
      invocations += 1
      return { card: 'generic', title: 'Read f', kind: 'read' }
    } }), '/w')
    cards.call({ callId: 'c1', name: 'read_anything', arguments: '{}' }, COLUMNS)
    expect(cards.semanticActivity()).toBe('reading')
    expect(cards.semanticActivity()).toBe('reading')
    expect(invocations).toBe(1)
  })

  it('falls back to working and raw rendering when presentation is unavailable', () => {
    for (const lookup of [() => undefined, bare]) {
      const cards = new ToolCards(lookup, '/w')
      const rows = plain(cards.call({ callId: 'c1', name: 'unpresented', arguments: '{"a":1}' }, COLUMNS))
      expect(rows).toContain('⏺ unpresented')
      expect(cards.semanticActivity()).toBe('working')
    }
  })

  it('contains a throwing presenter and keeps the raw card truthful', () => {
    const cards = new ToolCards(tool({ call: () => { throw new Error('bad args') } }), '/w')
    expect(() => cards.call({ callId: 'c1', name: 'broken', arguments: '{}' }, COLUMNS)).not.toThrow()
    expect(cards.semanticActivity()).toBe('working')
    expect(plain(cards.call({ callId: 'c2', name: 'broken', arguments: '{}' }, COLUMNS))).toContain('⏺ broken')
  })

  it('classifies a custom name only through its resolved generic view', () => {
    const cards = new ToolCards(tool({ call: () => ({ card: 'generic', title: 'Look up symbols', kind: 'search' }) }), '/w')
    cards.call({ callId: 'c1', name: 'semantic_code_lookup', arguments: '{}' }, COLUMNS)
    expect(cards.semanticActivity()).toBe('searching')
  })

  it('follows the scoped definition that actually ran when a name is shadowed', () => {
    const cards = new ToolCards(activities({ shadowed_read: 'terminal' }), '/w')
    call(cards, 'shadowed_read')
    expect(cards.semanticActivity()).toBe('running')
  })
})

describe('the tool inspector', () => {
  /** A ToolCards that has drawn one completed result, returning both. */
  function completed(
    lookup: (name: string) => ToolDefinition | undefined,
    text = '',
    extra: Partial<ResultInput> = {},
  ): { cards: ToolCards } {
    const cards = new ToolCards(lookup, '/w')
    cards.call({ callId: 'c1', name: 'demo', arguments: '{}' }, COLUMNS)
    cards.result(result(text, extra), COLUMNS)
    return { cards }
  }

  /** Draw another completed result on the same cards object. */
  function next(cards: ToolCards, text: string, extra: Partial<ResultInput> = {}): void {
    cards.call({ callId: extra.callId ?? 'c2', name: 'demo', arguments: '{}' }, COLUMNS)
    cards.result(result(text, { ...extra, callId: extra.callId ?? 'c2' }), COLUMNS)
  }

  it('makes a compact-truncated terminal result inspectable and renders it expanded', () => {
    const { cards } = completed(tool({
      result: () => ({ card: 'terminal', output: Array.from({ length: 30 }, (_, i) => `out ${String(i)}`).join('\n'), exitCode: 0 }),
    }))
    const item = cards.takeInspectable()
    expect(item).toBeDefined()
    const expanded = cards.renderInspect(item!, COLUMNS)
    // The full budget reaches every line, so no truncation hint survives.
    expect(expanded.rows.join('\n')).toContain('out 29')
    expect(expanded.rows.join('\n')).not.toContain('more lines')
    expect(expanded.truncated).toBe(false)
  })

  it('does not make a card inspectable when nothing was elided', () => {
    const { cards } = completed(tool({
      result: () => ({ card: 'terminal', output: 'a\nb', exitCode: 0 }),
    }))
    expect(cards.takeInspectable()).toBeUndefined()
  })

  it('does not claim the inspectable slot from a full-detail card', () => {
    const cards = new ToolCards(tool({
      result: () => ({ card: 'terminal', output: Array.from({ length: 20 }, (_, i) => `line ${String(i)}`).join('\n'), exitCode: 0 }),
    }), '/w')
    cards.detail = 'full'
    cards.call({ callId: 'c1', name: 'demo', arguments: '{}' }, COLUMNS)
    cards.result(result(''), COLUMNS)
    expect(cards.takeInspectable()).toBeUndefined()
  })

  it('renders a generic/raw result expanded with its presenter, not a raw shortcut', () => {
    const { cards } = completed(bare, Array.from({ length: 20 }, (_, i) => `raw ${String(i)}`).join('\n'))
    const item = cards.takeInspectable()
    expect(item).toBeDefined()
    const expanded = cards.renderInspect(item!, COLUMNS)
    expect(expanded.rows.join('\n')).toContain('raw 19')
    expect(expanded.truncated).toBe(false)
  })

  it('expands a read card keeping its own line numbers', () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({ number: i + 1, text: `line ${String(i + 1)}` }))
    const { cards } = completed(tool({
      result: () => ({ card: 'read', path: 'src/a.ts', offset: 1, lines, totalLines: 20 }),
    }))
    const item = cards.takeInspectable()
    expect(item).toBeDefined()
    const expanded = cards.renderInspect(item!, COLUMNS)
    // The numbered rows are the read presentation, not concatenated raw text.
    expect(stripAnsi(expanded.rows.join('\n'))).toMatch(/20 line 20$/m)
    expect(expanded.truncated).toBe(false)
  })

  it('expands a diff with the diff presenter, added and removed lines intact', () => {
    const { cards } = completed(tool({
      result: () => ({
        card: 'diff',
        diffs: [{
          path: 'f.ts',
          oldText: 'a\nb\nc\nd\ne\nf\ng',
          newText: 'A\nb\nC\nd\nE\nf\nG',
        }],
      }),
    }))
    const item = cards.takeInspectable()
    expect(item).toBeDefined()
    const expanded = cards.renderInspect(item!, COLUMNS)
    expect(expanded.rows.join('\n')).toContain('- a')
    expect(expanded.rows.join('\n')).toContain('+ A')
    expect(expanded.rows.join('\n')).toContain('f.ts')
  })

  it('is one-shot: inspecting consumes the opportunity until a new truncated result', () => {
    const { cards } = completed(tool({
      result: () => ({ card: 'terminal', output: Array.from({ length: 30 }, (_, i) => `out ${String(i)}`).join('\n'), exitCode: 0 }),
    }))
    expect(cards.takeInspectable()).toBeDefined()
    // The opportunity was consumed: Ctrl+O now returns to detail cycling.
    expect(cards.takeInspectable()).toBeUndefined()
  })

  it('keeps a truncated card reachable after a newer short result lands', () => {
    // The raw (presenter-less) tool renders its CONTENT, so truncation is set by
    // how many lines the text carries — 30 lines elide, one line does not.
    const { cards } = completed(bare, `${'x\n'.repeat(30)}`)
    // A short result hid nothing, so it contributes nothing and — unlike before —
    // discards nothing. The elided rows are still only reachable here.
    next(cards, 'short', { callId: 'c2' })
    expect(cards.takeInspectable()).toBeDefined()
  })

  it('keeps a truncated card reachable after a newer error result lands', () => {
    const { cards } = completed(bare, `${'x\n'.repeat(30)}`)
    next(cards, 'boom', { callId: 'c2', error: { code: 'ENOENT', name: 'Error' } })
    expect(cards.takeInspectable()).toBeDefined()
  })

  it('retains every truncated result of a replay, newest first', () => {
    // Replay calls result() in log order, and a non-truncated result between two
    // truncated ones no longer decides what survives.
    const { cards } = completed(bare, `${'x\n'.repeat(30)}`)
    next(cards, 'plain', { callId: 'c2' })
    next(cards, `${'y\n'.repeat(20)}`, { callId: 'c3' })
    const newest = cards.takeInspectable()
    expect(cards.inspectableRank(newest!)).toEqual({ position: 1, total: 2 })
    expect(cards.renderInspect(newest!, COLUMNS).rows.join('\n')).toContain('y')
    const older = cards.inspectableOlderThan(newest!)
    expect(cards.renderInspect(older!, COLUMNS).rows.join('\n')).toContain('x')
  })

  it('steps back through the retained history and stops at the oldest', () => {
    const { cards } = completed(bare, `${'a\n'.repeat(30)}`)
    next(cards, `${'b\n'.repeat(30)}`, { callId: 'c2' })
    next(cards, `${'c\n'.repeat(30)}`, { callId: 'c3' })
    const newest = cards.takeInspectable()
    expect(cards.inspectableRank(newest!)).toEqual({ position: 1, total: 3 })
    const middle = cards.inspectableOlderThan(newest!)
    expect(cards.inspectableRank(middle!)).toEqual({ position: 2, total: 3 })
    const oldest = cards.inspectableOlderThan(middle!)
    expect(cards.inspectableRank(oldest!)).toEqual({ position: 3, total: 3 })
    // The end of the history is a stop, not a wrap: a reader stepping back must
    // not be silently returned to the newest card.
    expect(cards.inspectableOlderThan(oldest!)).toBeUndefined()
  })

  it('steps forward through the retained history and stops at the newest', () => {
    const { cards } = completed(bare, `${'a\n'.repeat(30)}`)
    next(cards, `${'b\n'.repeat(30)}`, { callId: 'c2' })
    next(cards, `${'c\n'.repeat(30)}`, { callId: 'c3' })
    const newest = cards.takeInspectable()
    const middle = cards.inspectableOlderThan(newest!)
    const oldest = cards.inspectableOlderThan(middle!)
    expect(cards.inspectableNewerThan(oldest!)).toBe(middle)
    expect(cards.inspectableNewerThan(middle!)).toBe(newest)
    // The front of the history is a stop, not a wrap back to the oldest.
    expect(cards.inspectableNewerThan(newest!)).toBeUndefined()
  })

  it('marks a newly arrived card offered when forward navigation shows it', () => {
    const { cards } = completed(bare, `${'a\n'.repeat(30)}`)
    next(cards, `${'b\n'.repeat(30)}`, { callId: 'c2' })
    const newest = cards.takeInspectable()
    const oldest = cards.inspectableOlderThan(newest!)
    // A result can finish while the overlay remains open, placing an unseen card
    // ahead of the current one in the retained ring.
    next(cards, `${'c\n'.repeat(30)}`, { callId: 'c3' })
    const middle = cards.inspectableNewerThan(oldest!)
    const arrived = cards.inspectableNewerThan(middle!)
    expect(cards.inspectableRank(arrived!)).toEqual({ position: 1, total: 3 })
    // It was already put on screen by the overlay, so outer Ctrl+O must not offer
    // it a second time after the reader closes.
    expect(cards.takeInspectable()).toBeUndefined()
  })

  it('does not let the outer gesture walk older history when the reader never stepped', () => {
    // The bug this pins: searching the ring for the newest UNOFFERED card let a
    // second Ctrl+O open the card before the one just closed, so the detail
    // toggle receded by one keystroke for every card retained.
    const { cards } = completed(bare, `${'a\n'.repeat(30)}`)
    next(cards, `${'b\n'.repeat(30)}`, { callId: 'c2' })
    const newest = cards.takeInspectable()
    expect(cards.inspectableRank(newest!)).toEqual({ position: 1, total: 2 })
    // No inspectableOlderThan() call: the reader closed the inspector without
    // stepping, so the older card must stay reachable only from inside it.
    expect(cards.takeInspectable()).toBeUndefined()
  })

  it('re-arms the outer gesture when a new truncated result arrives', () => {
    const { cards } = completed(bare, `${'a\n'.repeat(30)}`)
    expect(cards.takeInspectable()).toBeDefined()
    expect(cards.takeInspectable()).toBeUndefined()
    next(cards, `${'b\n'.repeat(30)}`, { callId: 'c2' })
    // The new card unshifts onto the front, so this offers it — and nothing
    // already seen behind it.
    const newest = cards.takeInspectable()
    expect(cards.inspectableRank(newest!)).toEqual({ position: 1, total: 2 })
    expect(cards.takeInspectable()).toBeUndefined()
  })

  it('leaves the detail cycle one keystroke away once every card has been offered', () => {
    const { cards } = completed(bare, `${'a\n'.repeat(30)}`)
    next(cards, `${'b\n'.repeat(30)}`, { callId: 'c2' })
    // Walking the history marks each step offered, so Ctrl+O does not then
    // re-offer the same cards one at a time from the runner's own handler.
    const newest = cards.takeInspectable()
    expect(cards.inspectableOlderThan(newest!)).toBeDefined()
    expect(cards.takeInspectable()).toBeUndefined()
  })

  it('bounds the retained history rather than keeping a second transcript', () => {
    const { cards } = completed(bare, `${'r0\n'.repeat(30)}`)
    for (let index = 1; index < 20; index += 1) {
      next(cards, `${`r${String(index)}\n`.repeat(30)}`, { callId: `c${String(index)}` })
    }
    const newest = cards.takeInspectable()
    expect(cards.inspectableRank(newest!)).toEqual({ position: 1, total: 12 })
  })

  it('replaces the latest result when a newer truncated one arrives', () => {
    const cards = new ToolCards(tool({
      result: (args: unknown) => ({
        card: 'terminal',
        output: Array.from({ length: 20 }, (_, i) => `${String((args as { tag: string }).tag)} ${String(i)}`).join('\n'),
        exitCode: 0,
      }),
    }), '/w')
    cards.call({ callId: 'a', name: 'demo', arguments: '{"tag":"first"}' }, COLUMNS)
    cards.result(result('', { callId: 'a' }), COLUMNS)
    expect(cards.takeInspectable()?.name).toBe('demo')
    // A second completed truncated result re-arms the slot with the newer one.
    cards.call({ callId: 'b', name: 'demo', arguments: '{"tag":"second"}' }, COLUMNS)
    cards.result(result('', { callId: 'b' }), COLUMNS)
    const item = cards.takeInspectable()
    expect(item).toBeDefined()
    expect(cards.renderInspect(item!, COLUMNS).rows.join('\n')).toContain('second 19')
  })

  it('stays bounded for huge output, reporting that the source was cut', () => {
    const { cards } = completed(tool({
      result: () => ({ card: 'terminal', output: 'many\n'.repeat(20_000), exitCode: 0 }),
    }))
    const item = cards.takeInspectable()
    expect(item).toBeDefined()
    const expanded = cards.renderInspect(item!, COLUMNS)
    // Bounded, but at the inspector's own budget: the overlay scrolls its rows,
    // where a card's rows are committed into scrollback and cannot be taken back.
    expect(expanded.rows.length).toBeLessThan(5100)
    expect(expanded.truncated).toBe(true)
  })

  it('shows more than the card did when the card was already at full detail', () => {
    // The reason a full card may now arm ctrl+o at all. When inspect shared the
    // 200-row budget, opening one showed exactly what was already in scrollback.
    const long = Array.from({ length: 1000 }, (_, i) => `line ${String(i)}`).join('\n')
    const cards = new ToolCards(tool({ result: () => ({ card: 'terminal', output: long, exitCode: 0 }) }), '/w')
    cards.detail = 'full'
    cards.call({ callId: 'c1', name: 'demo', arguments: '{}' }, COLUMNS)
    const card = stripAnsi(cards.result(result(''), COLUMNS).join('\n'))
    expect(card).not.toContain('line 100')

    const item = cards.takeInspectable()
    expect(item).toBeDefined()
    expect(cards.renderInspect(item!, COLUMNS).rows.join('\n')).toContain('line 100')
  })

  it.each([
    ['a diff', (n: number) => ({
      card: 'diff' as const,
      diffs: [{ path: 'f.ts', oldText: null, newText: Array.from({ length: n }, (_u, i) => `added ${String(i)}`).join('\n') }],
    })],
    ['a search', (n: number) => ({
      card: 'search' as const,
      total: n,
      files: Array.from({ length: n }, (_u, i) => ({ path: `f${String(i)}.ts`, matches: [] })),
    })],
  ])('gives %s the inspector budget too, not the card\'s', (_name, view) => {
    // Every presentation resolves its budget through the same function. Left to
    // compute their own, a diff and a search kept the card's cap while inspected,
    // so opening one showed exactly the rows already committed to scrollback.
    const cards = new ToolCards(tool({ result: () => view(600) as never }), '/w')
    cards.detail = 'full'
    cards.call({ callId: 'c1', name: 'demo', arguments: '{}' }, COLUMNS)
    const card = cards.result(result(''), COLUMNS).length
    const item = cards.takeInspectable()
    expect(item).toBeDefined()
    expect(cards.renderInspect(item!, COLUMNS).rows.length).toBeGreaterThan(card)
  })

  it('advertises ctrl+o on every card that arms the opportunity', () => {
    const long = 'x\n'.repeat(300)

    // Compact and truncated: the marker names ctrl+o.
    const compact = new ToolCards(tool({ result: () => ({ card: 'terminal', output: long, exitCode: 0 }) }), '/w')
    compact.call({ callId: 'c1', name: 'demo', arguments: '{}' }, COLUMNS)
    const compactRows = stripAnsi(compact.result(result(''), COLUMNS).join('\n'))
    expect(compactRows).toContain('· ctrl+o view')
    expect(compact.takeInspectable()).toBeDefined()

    // Full detail at the 200-row cap: the inspector has more to show, so the
    // marker promises it and the opportunity is armed.
    const full = new ToolCards(tool({ result: () => ({ card: 'terminal', output: long, exitCode: 0 }) }), '/w')
    full.detail = 'full'
    full.call({ callId: 'c1', name: 'demo', arguments: '{}' }, COLUMNS)
    const fullRows = stripAnsi(full.result(result(''), COLUMNS).join('\n'))
    expect(fullRows).toContain('earlier lines')
    expect(fullRows).toContain('· ctrl+o view')
    expect(full.takeInspectable()).toBeDefined()

    // Hidden draws no body, so it reports no truncation and arms nothing: there
    // would be nothing for the marker to sit beside.
    const hidden = new ToolCards(tool({ result: () => ({ card: 'terminal', output: long, exitCode: 0 }) }), '/w')
    hidden.detail = 'hidden'
    hidden.call({ callId: 'c1', name: 'demo', arguments: '{}' }, COLUMNS)
    hidden.result(result(''), COLUMNS)
    expect(hidden.takeInspectable()).toBeUndefined()

    // The inspector's own inspect detail: it must not offer to open itself.
    const inspected = new ToolCards(tool({ result: () => ({ card: 'terminal', output: 'x\n'.repeat(6000), exitCode: 0 }) }), '/w')
    inspected.call({ callId: 'c1', name: 'demo', arguments: '{}' }, COLUMNS)
    inspected.result(result(''), COLUMNS)
    const expanded = inspected.renderInspect(inspected.takeInspectable()!, COLUMNS)
    expect(expanded.rows.join('\n')).toContain('earlier lines')
    expect(expanded.rows.join('\n')).not.toContain('· ctrl+o view')
  })
})

describe('inspecting a call whose own presentation was elided', () => {
  // A synthetic generic tool, not a real one: the seam under test is "any
  // `presentCall` that declares long `content`", not one tool's name. Any
  // tool whose call view carries `content` long enough to elide exercises the
  // same gap `exit_plan_mode` happens to hit by echoing its plan back as a
  // call-time card.
  const longContent = [{ type: 'text' as const, text: Array.from({ length: 30 }, (_, i) => `call line ${String(i)}`).join('\n') }]
  const synthetic = tool({ call: () => ({ card: 'generic', title: 'Synthetic call', kind: 'other', content: longContent }) })

  it('makes an elided call card inspectable before any result arrives', () => {
    const cards = new ToolCards(synthetic, '/w')
    const rows = plain(cards.call({ callId: 'c1', name: 'synthetic', arguments: '{}' }, COLUMNS))
    expect(rows.join('\n')).toContain('· ctrl+o view')
    const item = cards.takeInspectable()
    expect(item).toBeDefined()
    const expanded = cards.renderInspect(item!, COLUMNS)
    expect(expanded.rows.join('\n')).toContain('call line 29')
    expect(expanded.truncated).toBe(false)
  })

  it('does not make a call card inspectable when its content was not elided', () => {
    const short = tool({ call: () => ({ card: 'generic', title: 'Synthetic call', kind: 'other', content: [{ type: 'text', text: 'one line' }] }) })
    const cards = new ToolCards(short, '/w')
    cards.call({ callId: 'c1', name: 'synthetic', arguments: '{}' }, COLUMNS)
    expect(cards.takeInspectable()).toBeUndefined()
  })

  it('never claims the inspectable slot for a hidden call, which draws no body', () => {
    const cards = new ToolCards(synthetic, '/w')
    cards.detail = 'hidden'
    cards.call({ callId: 'c1', name: 'synthetic', arguments: '{}' }, COLUMNS)
    expect(cards.takeInspectable()).toBeUndefined()
  })

  it('keeps ordinary result inspection and ctrl-o cycling working alongside a call-side entry', () => {
    const cards = new ToolCards(synthetic, '/w')
    // A truncated call arms the ring first...
    cards.call({ callId: 'c1', name: 'synthetic', arguments: '{}' }, COLUMNS)
    // ...then its result lands and is NOT itself truncated, so the ring still
    // holds only the call-side entry.
    cards.result(result('short result'), COLUMNS)
    const callItem = cards.takeInspectable()
    expect(callItem).toBeDefined()
    expect(cards.renderInspect(callItem!, COLUMNS).rows.join('\n')).toContain('call line 0')

    // A second, truncated RESULT from a different call now becomes the newest
    // entry, and stepping from it reaches the call-side entry as "older" —
    // one ring, one navigation, regardless of which kind of entry it holds.
    const resultTool = tool({ result: () => ({ card: 'terminal', output: Array.from({ length: 30 }, (_, i) => `out ${String(i)}`).join('\n'), exitCode: 0 }) })
    const mixed = new ToolCards((name: string) => (name === 'synthetic' ? synthetic(name) : resultTool(name)), '/w')
    mixed.call({ callId: 'c1', name: 'synthetic', arguments: '{}' }, COLUMNS)
    mixed.result(result('short', { callId: 'c1' }), COLUMNS)
    mixed.call({ callId: 'c2', name: 'terminal-ish', arguments: '{}' }, COLUMNS)
    mixed.result(result('', { callId: 'c2' }), COLUMNS)
    const newest = mixed.takeInspectable()
    expect(mixed.renderInspect(newest!, COLUMNS).rows.join('\n')).toContain('out 29')
    const older = mixed.inspectableOlderThan(newest!)
    expect(older).toBeDefined()
    expect(mixed.renderInspect(older!, COLUMNS).rows.join('\n')).toContain('call line 0')
    expect(mixed.inspectableOlderThan(older!)).toBeUndefined()
  })
})

describe('which end of a body survives the budget', () => {
  it('keeps the END of a command, where its answer is', () => {
    // Head-anchoring a shell result keeps the banner and drops the failure and the
    // exit line — the rows the command was run to produce.
    const output = Array.from({ length: 30 }, (_, i) => `out ${String(i)}`).join('\n')
    const rows = draw(tool({ result: () => ({ card: 'terminal', output, exitCode: 1 }) })).join('\n')
    expect(rows).toContain('out 29')
    expect(rows).toContain('out 24')
    expect(rows).not.toContain('out 23')
    expect(rows).not.toContain('out 0')
  })

  it('puts the marker above the rows it speaks for', () => {
    const output = Array.from({ length: 30 }, (_, i) => `out ${String(i)}`).join('\n')
    const body = draw(tool({ result: () => ({ card: 'terminal', output, exitCode: 0 }) }))
      .map(row => row.trim())
      .filter(row => row.includes('out ') || row.includes('earlier lines'))
    expect(body[0]).toContain('… 24 earlier lines')
    expect(body[1]).toContain('out 24')
  })

  it('still keeps the START of a file read, where its answer is', () => {
    // The anchor change is scoped to commands on purpose: the top of a read, a
    // search, or a diff IS what was asked for.
    const content = Array.from({ length: 30 }, (_, i) => `read ${String(i)}`).join('\n')
    const rows = draw(bare, { text: content }).join('\n')
    expect(rows).toContain('read 0')
    expect(rows).toContain('read 5')
    expect(rows).not.toContain('read 6')
    expect(rows).toContain('… 24 more lines')
  })
})

describe('the locations a call view declared', () => {
  it('lists the files a call declared it touches', () => {
    const rows = draw(tool({ call: () => ({ card: 'generic', title: 'Read config', kind: 'read', locations: [{ path: 'src/config.ts' }] }) }))
    expect(rows).toEqual(['', '◇ Read config', '  src/config.ts'])
  })

  it('keeps a location\'s line when the view declared one', () => {
    const rows = draw(tool({
      call: () => ({ card: 'generic', title: 'Read config', kind: 'read', locations: [{ path: 'src/config.ts', line: 40 }] }),
    }))
    expect(rows[2]).toBe('  src/config.ts:40')
  })

  it('lists several locations in the order the view declared them', () => {
    const rows = draw(tool({
      call: () => ({
        card: 'generic',
        title: 'Touch many',
        kind: 'edit',
        locations: [{ path: 'a.ts' }, { path: 'b.ts', line: 7 }, { path: 'c.ts' }],
      }),
    }))
    expect(rows.slice(2)).toEqual(['  a.ts', '  b.ts:7', '  c.ts'])
  })

  it('shows a diff call\'s declared locations beside its title', () => {
    // The change itself is still drawn once, at result time; a location says where
    // a follow-along UI would look, which the diff body never states.
    const rows = draw(tool({
      call: () => ({
        card: 'diff',
        title: 'Edit f.ts',
        diffs: [{ path: 'f.ts', oldText: 'a', newText: 'b' }],
        locations: [{ path: 'f.ts', line: 3 }],
      }),
    }))
    expect(rows.slice(0, 3)).toEqual(['', '◆ Edit f.ts', '  f.ts:3'])
  })

  it('escapes a control character in a location path', () => {
    const rows = draw(tool({ call: () => ({ card: 'generic', title: 'Read', locations: [{ path: 'evi\u001b[2Jl.ts' }] }) }))
    expect(rows[2]).toBe('  evi^[[2Jl.ts')
  })

  it('truncates a long path to the card width rather than wrapping it', () => {
    // One location is one row: a path that wrapped would shift every following
    // row of the card.
    const rows = draw(tool({
      call: () => ({ card: 'generic', title: 'Read', locations: [{ path: `${'deep/'.repeat(40)}config.ts` }] }),
    }))
    expect(rows).toHaveLength(3)
    expect(displayWidth(rows[2]!)).toBeLessThanOrEqual(COLUMNS)
  })

  it('bounds many locations at the compact budget and says how many it hid', () => {
    const locations = Array.from({ length: 10 }, (_, i) => ({ path: `file${String(i)}.ts` }))
    const cards = new ToolCards(tool({ call: () => ({ card: 'generic', title: 'Touch many', locations }) }), '/w')
    const rows = plain(cards.call({ callId: 'c1', name: 'demo', arguments: '{}' }, COLUMNS))
    expect(rows.filter(row => row.startsWith('  file'))).toHaveLength(COMPACT_BUDGET)
    expect(rows.at(-1)).toBe('  … 4 more locations · ctrl+o view')
    // Elided locations arm the inspector exactly as elided content does: those
    // rows are committed to scrollback and otherwise unreachable.
    const item = cards.takeInspectable()
    expect(item).toBeDefined()
    const expanded = cards.renderInspect(item!, COLUMNS)
    expect(stripAnsi(expanded.rows.join('\n'))).toContain('file9')
    expect(expanded.truncated).toBe(false)
  })

  it('invents no location row when the view declared none', () => {
    // A tool that declared no locations may still have touched files, and a row
    // claiming it did would be the frontend inventing a fact.
    const rows = draw(tool({ call: () => ({ card: 'generic', title: 'Grep MIT in LICENSE', kind: 'search', rawInput: 'MIT' }) }))
    expect(rows).toEqual(['', '⌕ Grep MIT in LICENSE'])
  })

  it('hides locations at hidden detail, where the title alone speaks', () => {
    const rows = draw(tool({
      call: () => ({ card: 'generic', title: 'Read config', kind: 'read', locations: [{ path: 'src/config.ts', line: 40 }] }),
    }), { detail: 'hidden' })
    expect(rows).toEqual(['', '◇ Read config'])
  })
})

describe('a web search result', () => {
  it('shows the provider answer before the source list', () => {
    const rows = draw(tool({
      result: () => ({
        card: 'web',
        kind: 'search',
        sources: [{ url: 'https://e.com/a', title: 'A page' }],
        truncated: false,
        answer: 'The answer is 42.',
      }),
    }))
    expect(rows[2]).toBe('  ⎿ 1 source')
    expect(rows[3]).toBe('  ⎿ The answer is 42.')
    expect(rows[4]).toBe('    A page https://e.com/a')
  })

  it('shows a source\'s snippet and publication date when the provider sent them', () => {
    const rows = draw(tool({
      result: () => ({
        card: 'web',
        kind: 'search',
        truncated: false,
        sources: [{
          url: 'https://e.com/a',
          title: 'A page',
          snippet: 'An excerpt about the page.',
          publishedAt: '2024-05-01T00:00:00Z',
        }],
      }),
    }))
    expect(rows).toContain('    An excerpt about the page.')
    // The provider's own timestamp string, not one reformatted into a precision
    // the contract never states.
    expect(rows).toContain('    published 2024-05-01T00:00:00Z')
  })

  it('degrades cleanly when every optional field is absent', () => {
    const rows = draw(tool({
      result: () => ({ card: 'web', kind: 'search', sources: [{ url: 'https://e.com/a' }], truncated: false }),
    }))
    // An untitled source shows its url once: the url beside itself says nothing.
    expect(rows).toEqual(['', '⏺ demo', '  ⎿ 1 source', '    https://e.com/a'])
  })

  it('keeps the harness\'s source order', () => {
    const rows = draw(tool({
      result: () => ({
        card: 'web',
        kind: 'search',
        truncated: false,
        sources: [{ url: 'https://b.com/1', title: 'B' }, { url: 'https://a.com/2', title: 'A' }],
      }),
    }))
    expect(rows[3]).toBe('    B https://b.com/1')
    expect(rows[4]).toBe('    A https://a.com/2')
  })

  it('escapes control characters in the structured fields', () => {
    const rows = draw(tool({
      result: () => ({
        card: 'web',
        kind: 'search',
        truncated: false,
        sources: [{
          url: 'https://e.com/\u001b[2Ja',
          title: 'Ti\u001b[2Jtle',
          snippet: 'Sni\u0007ppet',
          publishedAt: '2024\u0007-05-01',
        }],
      }),
    }))
    const joined = rows.join('\n')
    expect(joined).toContain('Ti^[[2Jtle')
    expect(joined).toContain('Sni^Gppet')
    expect(joined).toContain('published 2024^G-05-01')
    expect(joined).toContain('https://e.com/^[[2Ja')
  })

  it('spends one row budget across every source and reports what it hid', () => {
    const sources = Array.from({ length: 9 }, (_, i) => ({ url: `https://e.com/${String(i)}`, title: `Page ${String(i)}` }))
    const view = { card: 'web' as const, kind: 'search' as const, sources, truncated: false }
    expect(draw(tool({ result: () => view })).filter(row => row.includes('Page '))).toHaveLength(COMPACT_BUDGET)
    expect(draw(tool({ result: () => view })).at(-1)).toBe('    … 3 more rows · ctrl+o view')
    expect(draw(tool({ result: () => view }), { detail: 'full' }).filter(row => row.includes('Page '))).toHaveLength(9)
    expect(draw(tool({ result: () => view }), { detail: 'hidden' })).toEqual(['', '⏺ demo', '  ⎿ 9 sources'])
  })

  it('makes an elided search inspectable and expands every source', () => {
    const sources = Array.from({ length: 9 }, (_, i) => ({ url: `https://e.com/${String(i)}`, title: `Page ${String(i)}` }))
    const cards = new ToolCards(tool({ result: () => ({ card: 'web', kind: 'search', sources, truncated: false }) }), '/w')
    cards.call({ callId: 'c1', name: 'demo', arguments: '{}' }, COLUMNS)
    cards.result(result(''), COLUMNS)
    const item = cards.takeInspectable()
    expect(item).toBeDefined()
    const expanded = cards.renderInspect(item!, COLUMNS)
    expect(stripAnsi(expanded.rows.join('\n'))).toContain('Page 8')
    expect(expanded.truncated).toBe(false)
  })
})

describe('a web fetch result', () => {
  it('summarizes the retrieval from the structured view, then the body', () => {
    const rows = draw(tool({
      result: () => ({ card: 'web', kind: 'fetch', url: 'https://e.com/page', statusCode: 200, truncated: false }),
    }), { text: '# Page\nBody text.' })
    expect(rows[2]).toBe('  ⎿ https://e.com/page · 200')
    expect(rows[3]).toBe('  ⎿ # Page')
    expect(rows[4]).toBe('    Body text.')
  })

  it('marks a fetch the provider cut, and never one it did not', () => {
    const cut = draw(tool({ result: () => ({ card: 'web', kind: 'fetch', url: 'https://e.com/a', statusCode: 200, truncated: true }) }))
    expect(cut[2]).toBe('  ⎿ https://e.com/a · 200 · truncated')

    const whole = draw(tool({ result: () => ({ card: 'web', kind: 'fetch', url: 'https://e.com/a', statusCode: 200, truncated: false }) }), { text: 'body' })
    expect(whole.join('\n')).not.toContain('truncated')
  })

  it('never recomputes truncation from the body\'s length', () => {
    // A body that fits the card entirely can still have been cut upstream, and
    // only the view's flag says so.
    const rows = draw(tool({
      result: () => ({ card: 'web', kind: 'fetch', url: 'https://e.com/a', statusCode: 200, truncated: true }),
    }), { text: 'tiny body' })
    expect(rows[2]).toContain('· truncated')
  })

  it('reads the summary from the view, not the Fetched envelope in the result text', () => {
    const rows = draw(tool({
      result: () => ({ card: 'web', kind: 'fetch', url: 'https://real.example/page', statusCode: 200, truncated: false }),
    }), { text: 'Fetched https://decoy.example/other\nstatus 999\ncontent' })
    expect(rows[2]).toBe('  ⎿ https://real.example/page · 200')
  })

  it('keeps the body inside the card\'s row budget', () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${String(i)}`).join('\n')
    const rows = draw(tool({
      result: () => ({ card: 'web', kind: 'fetch', url: 'https://e.com/a', statusCode: 200, truncated: false }),
    }), { text: long })
    expect(rows.at(-1)).toBe('    … 24 more lines · ctrl+o view')
  })

  it('keeps the url and status visible when the body is hidden', () => {
    const rows = draw(tool({
      result: () => ({ card: 'web', kind: 'fetch', url: 'https://e.com/a', statusCode: 404, truncated: false }),
    }), { detail: 'hidden', text: 'body' })
    expect(rows).toEqual(['', '⏺ demo', '  ⎿ https://e.com/a · 404'])
  })

  it('lets the url give way before the status on a narrow row', () => {
    // The status and truncation marker are what a reader cannot do without; a
    // long url must not push them off the row.
    const rows = draw(tool({
      result: () => ({ card: 'web', kind: 'fetch', url: `https://e.com/${'x'.repeat(80)}`, statusCode: 200, truncated: true }),
    }))
    expect(rows[2]).toContain('· 200 · truncated')
    expect(displayWidth(rows[2]!)).toBeLessThanOrEqual(COLUMNS)
  })
})

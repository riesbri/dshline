import { describe, expect, it } from 'vitest'
import { Composer, stripAnsi } from '@dshline/renderer'
import type { CompletionSources } from '../src/completion.ts'
import { createCompletion } from '../src/completion.ts'

/** A tree to complete paths against. */
const TREE: Record<string, { name: string; directory: boolean }[]> = {
  '': [
    { name: 'README.md', directory: false },
    { name: 'packages', directory: true },
    { name: 'package.json', directory: false },
    { name: '.gitignore', directory: false },
    { name: 'tools', directory: true },
  ],
  packages: [
    { name: 'renderer', directory: true },
    { name: 'dshline', directory: true },
  ],
}

/** Commands to complete against. */
const COMMANDS = [
  { name: 'exit', description: 'leave the session' },
  { name: 'model', description: 'pick a model' },
  { name: 'clear', description: 'clear the session' },
  { name: 'compact', description: 'compact the session' },
  { name: 'reasoning', description: 'how hard to think' },
]

/** Values the frontend's own commands offer; everything else offers none. */
const ARGUMENTS: Record<string, { value: string; note?: string; aliases?: readonly string[] }[]> = {
  reasoning: [
    { value: 'off', note: 'no thinking' },
    { value: 'high', note: 'the usual level' },
    { value: 'max', note: 'as hard as it goes' },
    { value: 'default' },
  ],
  // One value that is a prefix of another, which is the case the
  // stop-when-finished rule must not swallow.
  prefixes: [{ value: 'max' }, { value: 'maxi' }],
  // The shape `/model` offers: a qualified route as the inserted value, with
  // the bare model id as a search alias. Two routes share one model id, so the
  // bare spelling is not itself a finished value.
  model: [
    { value: 'deepseek-official/deepseek-v4-flash', aliases: ['deepseek-v4-flash'] },
    { value: 'deepseek-official/deepseek-v4-pro', aliases: ['deepseek-v4-pro'] },
    { value: 'opencode/deepseek-v4-pro', aliases: ['deepseek-v4-pro'] },
  ],
}

/**
 * Sources over the fixtures above, recording which directories were listed.
 * @returns the sources and the list of directories asked for.
 */
function sources(): { sources: CompletionSources; listed: string[] } {
  const listed: string[] = []
  return {
    listed,
    sources: {
      commands: () => COMMANDS,
      commandArguments: async name => ARGUMENTS[name] ?? [],
      paths: async directory => {
        listed.push(directory)
        return TREE[directory] ?? []
      },
    },
  }
}

/**
 * A composer holding `text` with the cursor at its end, plus live completion.
 * @param text - what has been typed.
 * @returns the composer, the completion, and the recorded directory listings.
 */
function typed(text: string): {
  composer: Composer
  completion: ReturnType<typeof createCompletion>
  listed: string[]
} {
  const composer = new Composer()
  composer.handle({ kind: 'text', text })
  const built = sources()
  return { composer, completion: createCompletion(composer, built.sources, () => {}), listed: built.listed }
}

/**
 * Let any refresh the last gesture started run to completion.
 *
 * Accepting a candidate kicks off a refresh it does not hand back, so asserting
 * straight after a keystroke sees the state BEFORE that refresh lands — which is
 * indistinguishable from a refresh that never happened. A macrotask drains the
 * microtasks the async source is waiting on.
 * @returns a promise resolving after the pending work.
 */
async function settled(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

/** A thing with a renderable view, which is all these helpers need. */
type Rendered = { view: { render(columns: number, rows?: number): readonly string[] } }

/** The candidate rows, styling and selection marker removed, hint line dropped. */
function rows(completion: Rendered): string[] {
  return completion.view.render(80).map(stripAnsi).map(row => row.trim())
    .filter(row => row !== '' && !row.endsWith('complete · esc dismiss') && !row.startsWith('…'))
    .map(row => (row.startsWith('\u203a ') ? row.slice(2) : row))
}

/** Every rendered row at a comfortable width, styling removed. */
function render(completion: Rendered): string[] {
  return completion.view.render(80).map(stripAnsi).map(row => row.trim())
}

/**
 * A live completion over `count` files, for the windowing assertions.
 * @param count - how many candidates to offer.
 * @returns the refreshed completion.
 */
async function manyFiles(count: number): Promise<ReturnType<typeof createCompletion>> {
  const many = Array.from({ length: count }, (_, i) => ({ name: `file${String(i)}.ts`, directory: false }))
  const composer = new Composer()
  composer.handle({ kind: 'text', text: '@file' })
  const completion = createCompletion(composer, {
    commands: () => [],
    commandArguments: async () => [],
    paths: async () => many,
  }, () => {})
  await completion.refresh()
  return completion
}

/** The highlighted row, so a move through the list is observable. */
function selected(completion: Rendered): string | undefined {
  return completion.view.render(80).map(stripAnsi).map(row => row.trim())
    .find(row => row.startsWith('\u203a '))
    ?.slice(2)
}

describe('completing a command argument', () => {
  it('offers every value the moment the name is followed by a space', async () => {
    // This is what makes the picker optional rather than the only way in: tab
    // accepts `/reasoning `, and the levels are already listed under the cursor.
    const { completion } = typed('/reasoning ')
    await completion.refresh()
    expect(rows(completion)).toEqual([
      '/reasoning off no thinking',
      '/reasoning high the usual level',
      '/reasoning max as hard as it goes',
      '/reasoning default',
    ])
  })

  it('narrows to what has been typed', async () => {
    const { completion } = typed('/reasoning m')
    await completion.refresh()
    expect(rows(completion)).toEqual(['/reasoning max as hard as it goes'])
  })

  it('matches whatever case the value was typed in', async () => {
    const { completion } = typed('/reasoning MA')
    await completion.refresh()
    expect(rows(completion)).toEqual(['/reasoning max as hard as it goes'])
  })

  it('replaces the whole line, so accepting normalizes the spacing', async () => {
    const { composer, completion } = typed('/reasoning    ma')
    await completion.refresh()
    completion.handleKey({ kind: 'key', name: 'tab' })
    expect(composer.lines[0]).toBe('/reasoning max ')
  })

  it('makes accepting one candidate a single undoable edit', async () => {
    const { composer, completion } = typed('/m')
    await completion.refresh()
    completion.handleKey({ kind: 'key', name: 'tab' })
    expect(composer.value).toBe('/model ')
    // The acceptance is one draft edit: undo returns the typed token exactly.
    composer.handle({ kind: 'key', name: 'ctrl-z' })
    expect(composer.value).toBe('/m')
    composer.handle({ kind: 'key', name: 'ctrl-y' })
    expect(composer.value).toBe('/model ')
  })

  it('offers nothing once the value is complete', async () => {
    // `/reasoning high` is a finished instruction. A list still standing over it
    // is a popup between the user and the enter key they were reaching for.
    const { completion } = typed('/reasoning high')
    await completion.refresh()
    expect(rows(completion)).toEqual([])
    expect(completion.active).toBe(false)
  })

  it('still offers a longer value that the finished one is a prefix of', async () => {
    // The rule is "nothing left to offer", not "an exact match wins": if some
    // level were `maxi`, typing `max` would still have somewhere to go.
    const { completion } = typed('/prefixes ma')
    await completion.refresh()
    expect(rows(completion)).toEqual(['/prefixes max', '/prefixes maxi'])
    const finished = typed('/prefixes max')
    await finished.completion.refresh()
    expect(rows(finished.completion)).toEqual(['/prefixes max', '/prefixes maxi'])
  })

  it('does not reopen the list after a value is accepted', async () => {
    // Accepting used to refresh, which put the whole vocabulary straight back on
    // screen — the popup this rule exists to remove.
    const { composer, completion } = typed('/reasoning hi')
    await completion.refresh()
    completion.handleKey({ kind: 'key', name: 'tab' })
    expect(composer.lines[0]).toBe('/reasoning high ')
    await settled()
    expect(completion.active).toBe(false)
  })

  it('still reopens after a command NAME is accepted, to offer its values', async () => {
    // The two are different gestures: a name is a waypoint, a value is an answer.
    const { composer, completion } = typed('/reason')
    await completion.refresh()
    completion.handleKey({ kind: 'key', name: 'tab' })
    expect(composer.lines[0]).toBe('/reasoning ')
    // Not refreshed by hand: accepting a NAME reopens on its own, and that is
    // the behaviour under test.
    await settled()
    expect(rows(completion)).toHaveLength(4)
  })

  it('offers nothing for a command that takes no listed values', async () => {
    const { completion } = typed('/compact ')
    await completion.refresh()
    expect(rows(completion)).toEqual([])
  })

  it('offers nothing once the argument is a phrase rather than a word', async () => {
    // `/tmp is full` is a sentence about a folder, and completing inside it would
    // claim a line the user is writing as prose.
    const { completion } = typed('/reasoning max and also')
    await completion.refresh()
    expect(rows(completion)).toEqual([])
  })

  it('leaves a path mention alone', async () => {
    const { completion } = typed('see @pack')
    await completion.refresh()
    expect(rows(completion).every(row => !row.startsWith('/'))).toBe(true)
  })
})

describe('completing an argument whose value is qualified', () => {
  it('finds every route from the bare model id alone', async () => {
    // Insertion is `provider/model`, so the bare prefix a reader knows must
    // match a search alias or the row would offer nothing at all.
    const { completion } = typed('/model deepseek-v4')
    await completion.refresh()
    expect(rows(completion)).toEqual([
      '/model deepseek-official/deepseek-v4-flash',
      '/model deepseek-official/deepseek-v4-pro',
      '/model opencode/deepseek-v4-pro',
    ])
  })

  it('keeps the route choice visible when the bare id is typed in full', async () => {
    // An alias is not a finished value: two routes serve this id, so the list
    // must stand rather than treating the alias as an exact canonical match.
    const { completion } = typed('/model deepseek-v4-pro')
    await completion.refresh()
    expect(rows(completion)).toEqual([
      '/model deepseek-official/deepseek-v4-pro',
      '/model opencode/deepseek-v4-pro',
    ])
  })

  it('gets out of the way when a unique alias is typed in full', async () => {
    // Only one route serves `deepseek-v4-flash`, and `/model` already accepts
    // the bare spelling, so the word is a finished instruction. Leaving the row
    // standing would make the first Enter a canonicalization and only the
    // second one a submission.
    const { composer, completion } = typed('/model deepseek-v4-flash')
    await completion.refresh()
    expect(rows(completion)).toEqual([])
    expect(completion.active).toBe(false)
    // Enter reaches the composer instead of being consumed to rewrite the word.
    const enter = { kind: 'key', name: 'enter' } as const
    expect(completion.handleKey(enter)).toBe(false)
    expect(composer.handle(enter)).toEqual({
      kind: 'submit',
      text: '/model deepseek-v4-flash',
      gesture: 'enter',
    })
  })

  it('inserts the canonical value, not the alias that matched', async () => {
    const { composer, completion } = typed('/model deepseek-v4-pro')
    await completion.refresh()
    completion.handleKey({ kind: 'key', name: 'down' })
    completion.handleKey({ kind: 'key', name: 'tab' })
    expect(composer.value).toBe('/model opencode/deepseek-v4-pro ')
  })

  it('hides the list once the canonical value itself is complete', async () => {
    const { completion } = typed('/model opencode/deepseek-v4-pro')
    await completion.refresh()
    expect(rows(completion)).toEqual([])
    expect(completion.active).toBe(false)
  })
})

describe('what is completable', () => {
  it('offers commands for a slash at the start of a line', async () => {
    const { completion } = typed('/c')
    await completion.refresh()
    expect(rows(completion)).toEqual(['/clear clear the session', '/compact compact the session'])
  })

  it('offers every command for a bare slash', async () => {
    const { completion } = typed('/')
    await completion.refresh()
    expect(rows(completion)).toHaveLength(COMMANDS.length)
  })

  it('does not treat a slash inside a sentence as a command', async () => {
    // `/help` is a command and `see /etc/hosts` is a path; the difference is the
    // position, so position is what decides.
    const { completion } = typed('see /etc')
    await completion.refresh()
    expect(completion.active).toBe(false)
  })

  it('offers paths for an at-sign anywhere in the line', async () => {
    const { completion } = typed('please read @pack')
    await completion.refresh()
    expect(rows(completion)).toEqual(['packages/', 'package.json'])
  })

  it('sorts directories before files', async () => {
    const { completion } = typed('@')
    await completion.refresh()
    expect(rows(completion).slice(0, 2)).toEqual(['packages/', 'tools/'])
  })

  it('lists the directory named in the token, not the workspace root', async () => {
    const { completion, listed } = typed('@packages/d')
    await completion.refresh()
    expect(listed).toEqual(['packages'])
    expect(rows(completion)).toEqual(['packages/dshline/'])
  })

  it('withholds a dotfile until a dot is typed', async () => {
    // A completion list is not the place to volunteer `.git`.
    const first = typed('@')
    await first.completion.refresh()
    expect(rows(first.completion)).not.toContain('.gitignore')
    const second = typed('@.')
    await second.completion.refresh()
    expect(rows(second.completion)).toEqual(['.gitignore'])
  })

  it('offers nothing when no candidate matches', async () => {
    const { completion } = typed('@nothingmatchesthis')
    await completion.refresh()
    expect(completion.active).toBe(false)
    expect(completion.view.render(80)).toEqual([])
  })

  it('offers nothing for ordinary prose', async () => {
    const { completion } = typed('summarize the repository')
    await completion.refresh()
    expect(completion.active).toBe(false)
  })

  it('stops offering once the cursor leaves the token', async () => {
    const { composer, completion } = typed('@pack')
    await completion.refresh()
    expect(completion.active).toBe(true)
    composer.handle({ kind: 'text', text: ' and more' })
    await completion.refresh()
    expect(completion.active).toBe(false)
  })
})

describe('accepting a candidate', () => {
  it('replaces the typed token with the completion', async () => {
    const { composer, completion } = typed('@package')
    await completion.refresh()
    // `package.json` is the second row; `packages/` sorts first.
    completion.handleKey({ kind: 'key', name: 'down' })
    completion.handleKey({ kind: 'key', name: 'tab' })
    expect(composer.value).toBe('@package.json ')
  })

  it('keeps the rest of the line intact', async () => {
    const { composer, completion } = typed('please read @pack')
    await completion.refresh()
    completion.handleKey({ kind: 'key', name: 'tab' })
    expect(composer.value).toBe('please read @packages/')
  })

  it('leaves a directory open so the next segment continues', async () => {
    // A directory is a waypoint rather than an answer.
    const { composer, completion } = typed('@pack')
    await completion.refresh()
    completion.handleKey({ kind: 'key', name: 'tab' })
    expect(composer.value).toBe('@packages/')
    // The reopen is asynchronous, so it is awaited rather than assumed.
    await completion.refresh()
    expect(rows(completion)).toEqual(['packages/dshline/', 'packages/renderer/'])
  })

  it('completes a command with a trailing space, ready for its argument', async () => {
    const { composer, completion } = typed('/mod')
    await completion.refresh()
    completion.handleKey({ kind: 'key', name: 'tab' })
    expect(composer.value).toBe('/model ')
  })

  it('accepts a command with enter', async () => {
    const { composer, completion } = typed('/ex')
    await completion.refresh()
    expect(completion.handleKey({ kind: 'key', name: 'enter' })).toBe(true)
    expect(composer.value).toBe('/exit ')
  })

  it('accepts the highlighted path with enter', async () => {
    const { composer, completion } = typed('@pack')
    await completion.refresh()
    expect(completion.handleKey({ kind: 'key', name: 'enter' })).toBe(true)
    expect(composer.value).toBe('@packages/')
  })

  it('accepts a partial command argument with enter', async () => {
    const { composer, completion } = typed('/reasoning h')
    await completion.refresh()
    expect(completion.handleKey({ kind: 'key', name: 'enter' })).toBe(true)
    expect(composer.value).toBe('/reasoning high ')
  })

  it('submits an already-complete command with enter', async () => {
    const { composer, completion } = typed('/exit')
    await completion.refresh()
    const enter = { kind: 'key', name: 'enter' } as const
    expect(completion.handleKey(enter)).toBe(false)
    expect(composer.handle(enter)).toEqual({ kind: 'submit', text: '/exit', gesture: 'enter' })
  })

  it('submits a bare command with optional arguments with enter', async () => {
    const { composer, completion } = typed('/reasoning')
    await completion.refresh()
    const enter = { kind: 'key', name: 'enter' } as const
    expect(completion.handleKey(enter)).toBe(false)
    expect(composer.handle(enter)).toEqual({ kind: 'submit', text: '/reasoning', gesture: 'enter' })
  })

  it('submits an already-complete path with enter', async () => {
    const { composer, completion } = typed('@README.md')
    await completion.refresh()
    const enter = { kind: 'key', name: 'enter' } as const
    expect(completion.handleKey(enter)).toBe(false)
    expect(composer.handle(enter)).toEqual({ kind: 'submit', text: '@README.md', gesture: 'enter' })
  })

  it('completes on the accelerated gesture exactly as it does on enter', async () => {
    // `ctrl-enter` chooses how a submission is DELIVERED, so it must not change
    // WHAT is submitted. Left unclaimed, it fell past the list to the composer
    // and sent the half-typed token: `/comp` where `enter` completed `/compact `.
    const { composer, completion } = typed('/comp')
    await completion.refresh()
    expect(completion.handleKey({ kind: 'key', name: 'ctrl-enter' })).toBe(true)
    expect(composer.value).toBe('/compact ')
    // Nothing was submitted — there is no submission to route until the token is
    // complete, which is the same rule plain enter follows.
    expect(composer.isEmpty).toBe(false)
  })

  it('accepts a partial argument on the accelerated gesture too', async () => {
    const { composer, completion } = typed('/reasoning h')
    await completion.refresh()
    expect(completion.handleKey({ kind: 'key', name: 'ctrl-enter' })).toBe(true)
    expect(composer.value).toBe('/reasoning high ')
  })

  it('hands the accelerated gesture back once the token is already complete', async () => {
    // Where the list declines, the composer submits — and the gesture survives
    // the hand-off, which is what makes the modifier reach the delivery choice.
    const { composer, completion } = typed('/exit')
    await completion.refresh()
    const accelerated = { kind: 'key', name: 'ctrl-enter' } as const
    expect(completion.handleKey(accelerated)).toBe(false)
    expect(composer.handle(accelerated)).toEqual({
      kind: 'submit',
      text: '/exit',
      gesture: 'accelerated',
    })
  })

  it('submits ordinary prose on the accelerated gesture with no list in the way', async () => {
    const { composer, completion } = typed('ordinary prose')
    await completion.refresh()
    const accelerated = { kind: 'key', name: 'ctrl-enter' } as const
    expect(completion.handleKey(accelerated)).toBe(false)
    expect(composer.handle(accelerated)).toEqual({
      kind: 'submit',
      text: 'ordinary prose',
      gesture: 'accelerated',
    })
  })

  it('counts a wide character once when replacing', async () => {
    // The token is measured in code points, the unit the buffer stores, so a wide
    // or astral character does not consume two positions of the replacement.
    const { composer, completion } = typed('标准 @pack')
    await completion.refresh()
    completion.handleKey({ kind: 'key', name: 'tab' })
    expect(composer.value).toBe('标准 @packages/')
  })
})

describe('keys the completion claims, and those it does not', () => {
  it('moves through candidates with the vertical arrows, wrapping around', async () => {
    const { completion } = typed('@')
    await completion.refresh()
    const first = selected(completion)
    expect(first).toBe('packages/')
    expect(completion.handleKey({ kind: 'key', name: 'down' })).toBe(true)
    expect(selected(completion)).toBe('tools/')
    expect(completion.handleKey({ kind: 'key', name: 'up' })).toBe(true)
    expect(selected(completion)).toBe(first)
    // Wrapping means the list has no dead ends: up from the first row is the last,
    // which here is the last file after both directories.
    expect(completion.handleKey({ kind: 'key', name: 'up' })).toBe(true)
    expect(selected(completion)).toBe('README.md')
  })

  it('leaves enter to the composer when no completion is visible', async () => {
    const { composer, completion } = typed('ordinary prose')
    await completion.refresh()
    const enter = { kind: 'key', name: 'enter' } as const
    expect(completion.handleKey(enter)).toBe(false)
    expect(composer.handle(enter)).toEqual({ kind: 'submit', text: 'ordinary prose', gesture: 'enter' })
  })

  it('never claims a printable character, so the list narrows as you type', async () => {
    const { completion } = typed('/c')
    await completion.refresh()
    expect(completion.handleKey({ kind: 'text', text: 'l' })).toBe(false)
  })

  it('claims nothing at all while inactive', async () => {
    const { completion } = typed('ordinary prose')
    await completion.refresh()
    for (const name of ['up', 'down', 'tab', 'escape'] as const) {
      expect(completion.handleKey({ kind: 'key', name })).toBe(false)
    }
  })

  it('does not accept a dismissed candidate when enter submits', async () => {
    const { composer, completion } = typed('@pack')
    await completion.refresh()
    expect(completion.handleKey({ kind: 'key', name: 'escape' })).toBe(true)
    const enter = { kind: 'key', name: 'enter' } as const
    expect(completion.handleKey(enter)).toBe(false)
    expect(composer.handle(enter)).toEqual({ kind: 'submit', text: '@pack', gesture: 'enter' })
  })

  it('dismisses for the current token only', async () => {
    // Escape hides the list for this word; it must not hide completion forever, and
    // it must not reopen on the very next keystroke either.
    const { composer, completion } = typed('@pack')
    await completion.refresh()
    expect(completion.handleKey({ kind: 'key', name: 'escape' })).toBe(true)
    expect(completion.active).toBe(false)
    await completion.refresh()
    expect(completion.active).toBe(false)
    composer.handle({ kind: 'text', text: 'a' })
    await completion.refresh()
    expect(completion.active).toBe(true)
  })
})

describe('the rendered list', () => {
  it('shows at most a screenful and says how many are hidden', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `file${String(i)}.ts`, directory: false }))
    const composer = new Composer()
    composer.handle({ kind: 'text', text: '@file' })
    const completion = createCompletion(composer, {
      commands: () => [],
      paths: async () => many,
    }, () => {})
    await completion.refresh()
    const shown = completion.view.render(80).map(stripAnsi)
    expect(shown.filter(row => row.includes('file')).length).toBe(6)
    expect(shown.join('\n')).toContain('14 more')
  })

  it('counts down as the highlight walks off the bottom', async () => {
    // The count is about the rows BELOW the window, not about the rows the window
    // omits. Computing it as `candidates.length - shown.length` gave the same
    // fourteen at every position — including with the last of twenty highlighted,
    // where nothing at all is hidden below.
    const completion = await manyFiles(20)
    expect(render(completion).join('\n')).toContain('14 more')
    for (let step = 0; step < 6; step += 1) completion.handleKey({ kind: 'key', name: 'down' })
    expect(render(completion).join('\n')).toContain('13 more')
    for (let step = 0; step < 13; step += 1) completion.handleKey({ kind: 'key', name: 'down' })
    expect(render(completion).join('\n')).not.toContain('more')
  })

  it('says where in the list the highlight is', async () => {
    // The rows scrolled off ABOVE the window are otherwise unaccounted for: the
    // elision marker sits below the list and can only speak for what is under it.
    const completion = await manyFiles(20)
    expect(render(completion).join('\n')).toContain('1/20')
    for (let step = 0; step < 9; step += 1) completion.handleKey({ kind: 'key', name: 'down' })
    expect(render(completion).join('\n')).toContain('10/20')
  })

  it('gives up the position before the way out when the terminal is narrow', async () => {
    const completion = await manyFiles(20)
    const narrow = completion.view.render(24).map(stripAnsi).map(row => row.trim())
    expect(narrow.some(row => row === 'esc dismiss')).toBe(true)
  })

  it('shrinks to the rows it was left, keeping both chrome rows', async () => {
    // `render`'s second argument is what the views ABOVE this one did not spend,
    // not the terminal's height — see TuiSlots.compose(). A fixed six rows here
    // pushes the composer out of the live region, and rows that have scrolled off
    // can no longer be erased.
    const completion = await manyFiles(20)
    const short = completion.view.render(80, 7).map(stripAnsi)
    expect(short.filter(row => row.includes('file')).length).toBe(4)
    expect(short.join('\n')).toContain('16 more')
    expect(short.join('\n')).toContain('complete · esc dismiss')
  })

  it('renders nothing at all when it was left no room for a candidate', async () => {
    // Chrome with no candidates says completions exist while hiding every one of
    // them, and one row over budget is the duplicate-frame bug rather than a
    // smaller list.
    const completion = await manyFiles(20)
    for (const left of [3, 2, 1, 0]) {
      expect(completion.view.render(80, left), `${String(left)} rows left`).toEqual([])
    }
    expect(completion.view.render(80, 4).length).toBe(3)
  })

  it('ends the help line on a whole word, never half a key name', async () => {
    // `esc dism` reads as a rendering fault, not as a shorter hint.
    const completion = await manyFiles(20)
    for (const columns of [80, 40, 30, 24, 20, 16, 12, 10, 8, 6]) {
      const help = completion.view.render(columns).map(stripAnsi).map(row => row.trim())
        .find(row => row.startsWith('esc') || row.includes('dismiss') || row.includes('/20'))
      expect(help === undefined || /^(\d+\/20 · )?(tab\/enter complete · )?(esc dismiss|esc)$/u.test(help),
        `${String(columns)} columns: ${JSON.stringify(help)}`).toBe(true)
    }
  })

  it('escapes a control sequence in a file name', async () => {
    // A directory listing is untrusted: a file name can carry anything a filesystem
    // permits, and this one reaches the terminal.
    const composer = new Composer()
    composer.handle({ kind: 'text', text: '@x' })
    const completion = createCompletion(composer, {
      commands: () => [],
      paths: async () => [{ name: 'x[2Jevil', directory: false }],
    }, () => {})
    await completion.refresh()
    expect(completion.view.render(80).map(stripAnsi).join('')).toContain('^[[2J')
  })

  it('keeps every row inside the terminal', async () => {
    const composer = new Composer()
    composer.handle({ kind: 'text', text: '@x' })
    const completion = createCompletion(composer, {
      commands: () => [],
      paths: async () => [{ name: `x${'y'.repeat(300)}`, directory: false }],
    }, () => {})
    await completion.refresh()
    for (const row of completion.view.render(40)) expect(stripAnsi(row).length).toBeLessThanOrEqual(40)
  })
})

describe('untrusted candidates and racing lookups', () => {
  /**
   * Sources whose directory read resolves only when the test says so.
   * @param entries - what the read eventually returns.
   * @returns the sources and a function that releases the pending read.
   */
  function deferred(entries: { name: string; directory: boolean }[]): {
    sources: CompletionSources
    release: () => void
  } {
    let release = (): void => {}
    return {
      release: () => { release() },
      sources: {
        commands: () => [],
        paths: async () => new Promise(resolve => { release = () => { resolve(entries) } }),
      },
    }
  }

  it('escapes a control sequence in a file name it inserts', async () => {
    // The list showed the name escaped, but the accepted text went into the buffer
    // raw — and the composer view hands its lines to the screen without escaping
    // them again, so pressing tab on such a file executed the sequence.
    const composer = new Composer()
    composer.handle({ kind: 'text', text: '@x' })
    const completion = createCompletion(composer, {
      commands: () => [],
      paths: async () => [{ name: 'x\u001b[2Jevil', directory: false }],
    }, () => {})
    await completion.refresh()
    completion.handleKey({ kind: 'key', name: 'tab' })
    expect(composer.value).not.toContain('\u001b')
    expect(composer.value).toBe('@x^[[2Jevil ')
  })

  it('does not revive candidates for a token that disappeared while reading', async () => {
    // The read was in flight when the text stopped being completable. Landing it
    // anyway left a list for a token that is no longer there, and a later tab would
    // replace characters using its length.
    const composer = new Composer()
    composer.handle({ kind: 'text', text: '@pack' })
    const { sources, release } = deferred([{ name: 'packages', directory: true }])
    const completion = createCompletion(composer, sources, () => {})
    const pending = completion.refresh()
    composer.handle({ kind: 'text', text: ' and more' })
    await completion.refresh()
    release()
    await pending
    expect(completion.active).toBe(false)
  })

  it('offers nothing to accept while a newer lookup is in flight', async () => {
    // Candidates left standing during a directory read belong to the PREVIOUS
    // token, so a tab in that window replaced the wrong number of characters —
    // turning an active `@` list plus a typed `p` into `@@packages/`.
    const composer = new Composer()
    composer.handle({ kind: 'text', text: '@' })
    const { sources, release } = deferred([{ name: 'packages', directory: true }])
    const completion = createCompletion(composer, sources, () => {})
    const first = completion.refresh()
    release()
    await first
    expect(completion.active).toBe(true)

    composer.handle({ kind: 'text', text: 'p' })
    const second = completion.refresh()
    // Mid-read: nothing may be accepted, because what is offered is stale.
    expect(completion.active).toBe(false)
    expect(completion.handleKey({ kind: 'key', name: 'tab' })).toBe(false)
    expect(composer.value).toBe('@p')
    release()
    await second
    expect(composer.value).toBe('@p')
    completion.handleKey({ kind: 'key', name: 'tab' })
    expect(composer.value).toBe('@packages/')
  })
})

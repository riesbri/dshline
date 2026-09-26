import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { stripAnsi } from '@dshline/renderer'
import { commandEcho, commandLines, fileLine, imageLine, projectEvent, userContentLines } from '../src/transcript.ts'

/** Build the minimum event the projection reads, without the full envelope. */
function event(type: string, data: unknown): SessionEvent {
  return { type, data } as unknown as SessionEvent
}

/** Project and strip styling, so assertions read as what a person would see. */
function project(type: string, data: unknown, columns = 80): string[] {
  return projectEvent(event(type, data), columns).map(stripAnsi)
}

describe('projectEvent()', () => {
  it('echoes a direct human prompt', () => {
    expect(project('user/message', {
      content: [{ type: 'text', text: 'run the tests' }],
      source: { kind: 'user' },
    })).toEqual(['', '─'.repeat(78), '› run the tests'])
  })

  it('drops a synthetic injection, which the user never typed', () => {
    // File-change notices, skill bodies, and nested AGENTS.md are model-visible
    // context; echoing them buries the conversation they are attached to.
    expect(project('user/message', {
      content: [{ type: 'text', text: 'Additional instructions from: docs/AGENTS.md' }],
      source: { kind: 'plugin', plugin: 'agent-instructions' },
    })).toEqual([])
  })

  it('drops the body a skill invocation injects, which the user never typed', () => {
    // `dsh-tool-skill` appends the rendered `<skill_content>` block as its own
    // `skill-invocation`-sourced message. Echoing it would put a whole SKILL.md
    // into the terminal above the one line the reader actually wrote.
    expect(project('user/message', {
      content: [{ type: 'text', text: '<skill_content name="review-pr">…</skill_content>' }],
      source: { kind: 'skill-invocation', name: 'review-pr', form: 'instructions' },
    })).toEqual([])
  })

  it('still echoes the human line that triggered a skill invocation', () => {
    expect(project('user/message', {
      content: [{ type: 'text', text: '/review-pr inspect this' }],
      source: { kind: 'user' },
    })).toEqual(['', '─'.repeat(78), '› /review-pr inspect this'])
  })

  it('projects no tool output, which ToolCards owns so it can pair call to result', () => {
    // presentResult needs the call's arguments, which only a call-to-result
    // pairing has; a per-event projection cannot supply them.
    expect(project('tool/call', { callId: 'c1', name: 'read', arguments: '{}' })).toEqual([])
    expect(project('tool/result', {
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'x' }] }] },
    })).toEqual([])
  })

  it('projects no assistant output, which StreamBuffer owns on both paths', () => {
    // Splitting that ownership is what makes a reply print twice: the buffer has
    // already committed the streamed lines by the time this event arrives.
    expect(project('assistant/message', {
      message: { content: [{ type: 'text', text: 'first\nsecond' }] },
    })).toEqual([])
  })







  it('reports a turn that ended in error', () => {
    expect(project('turn/end', {
      reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: 'slow down' } },
    })).toEqual(['', '✗ RATE_LIMIT: slow down'])
  })

  it('reports an interrupted turn under the tag the harness actually emits', () => {
    // `TurnEndReasonMap` names this `aborted`. Testing for `canceled` meant a
    // ctrl-c that visibly stopped a reply left no mark explaining why.
    expect(project('turn/end', { reason: { kind: 'aborted', reason: { kind: 'user' } } }))
      .toEqual(['', '· interrupted'])
  })

  it('says a reply was cut off by the output limit', () => {
    // Otherwise a truncated answer is indistinguishable from a finished one.
    expect(project('turn/end', { reason: { kind: 'max-tokens' } }))
      .toEqual(['', '· reply reached the output limit'])
  })

  it('says a turn was blocked before the model was called', () => {
    expect(project('turn/end', { reason: { kind: 'blocked' } }))
      .toEqual(['', '· blocked before the model was called'])
  })

  it('says nothing about a reason it has never seen, which a plugin may add', () => {
    expect(project('turn/end', { reason: { kind: 'some-plugin-reason' } })).toEqual([])
  })

  it('says nothing about a completed turn', () => {
    expect(project('turn/end', { reason: { kind: 'completed' } })).toEqual([])
  })

  it('ignores an event type it has never seen', () => {
    // SessionEventMap is merge-extensible: any plugin may add a type, and a
    // frontend that threw on one would break the moment a deployment mounted it.
    expect(project('some-plugin/custom', { anything: true })).toEqual([])
  })

  it('shows durable image metadata beside text without exposing its opaque id', () => {
    const rows = project('user/message', {
      content: [
        { type: 'text', text: 'What is this?' },
        {
          type: 'image',
          attachment: {
            attachmentId: 'sha256:secret-object-name',
            mediaType: 'image/png',
            bytes: 1536,
            width: 640,
            height: 480,
            name: '界面.png',
          },
        },
      ],
      source: { kind: 'user' },
    })
    expect(rows).toContain('› What is this?')
    expect(rows).toContain('  image: 界面.png · 640×480 · 1.5 KiB')
    expect(rows.join('\n')).not.toContain('secret-object-name')
  })

  it('shows an image-only historical prompt and escapes a hostile display name', () => {
    const rows = project('user/message', {
      content: [{
        type: 'image',
        attachment: {
          attachmentId: 'opaque', mediaType: 'image/gif', bytes: 12,
          width: 2, height: 3, name: 'x\u001b[2J.gif',
        },
      }],
      source: { kind: 'user' },
    }, 24)
    expect(rows.join('\n')).toContain('image: x^[[2J.gif')
    expect(rows.join('\n')).not.toContain('\u001b[2J')
  })
})

describe('imageLine()', () => {
  it('uses only durable display metadata and formats byte units compactly', () => {
    expect(imageLine({
      type: 'image',
      attachment: {
        attachmentId: 'opaque' as never, mediaType: 'image/webp', bytes: 2 * 1024 * 1024,
        width: 12, height: 9,
      },
    })).toBe('image: unnamed · 12×9 · 2.0 MiB')
  })
})

/** One durable file reference, with the fields the transcript may show. */
function file(attachmentId: string, name: string, bytes: number): { type: 'file'; attachment: { attachmentId: string; name: string; bytes: number } } {
  return { type: 'file', attachment: { attachmentId, name, bytes } as never }
}

/** One durable image reference, with the fields the transcript may show. */
function image(name: string | undefined, bytes = 2_500): { type: 'image'; attachment: { name?: string; bytes: number } } {
  return { type: 'image', attachment: { name, bytes, mediaType: 'image/png', width: 2, height: 2 } as never }
}

describe('fileLine()', () => {
  it('shows the display name and byte count, in the same units an image uses', () => {
    expect(fileLine({ type: 'file', attachment: { name: 'report.pdf', bytes: 2 * 1024 * 1024 } as never }))
      .toBe('file: report.pdf · 2.0 MiB')
    expect(fileLine({ type: 'file', attachment: { name: 'trace.json', bytes: 85_094 } as never }))
      .toBe('file: trace.json · 83.1 KiB')
    expect(fileLine({ type: 'file', attachment: { name: 'empty.txt', bytes: 0 } as never }))
      .toBe('file: empty.txt · 0 B')
  })

  it('never shows the opaque id or any storage location', () => {
    // The scrollback is read by whoever opens this terminal. The id is content-
    // addressed and meaningless outside the provider, and a storage path is
    // host implementation detail; neither is information a reader can act on.
    const line = fileLine({
      type: 'file',
      attachment: { attachmentId: 'sha256:deadbeefdeadbeef', name: 'report.pdf', bytes: 12 } as never,
    })
    expect(line).toBe('file: report.pdf · 12 B')
    expect(line).not.toContain('sha256')
    expect(line).not.toContain('deadbeef')
  })
})

describe('userContentLines()', () => {
  it('projects durable blocks in the order the log records them', () => {
    // The regression the mixed attachment case exposes: text-then-images was
    // accurate only while a prompt could carry images or nothing. Grouping here
    // would render a sequence the session log does not contain, and a replay
    // would then disagree with what was watched happen.
    expect(userContentLines([
      { type: 'text', text: 'Compare these.' },
      image('a.png'),
      file('sha256:1', 'trace.json', 900),
      image('b.png'),
      file('sha256:2', 'report.pdf', 2_000),
    ] as never)).toEqual([
      'Compare these.',
      'image: a.png · 2×2 · 2.4 KiB',
      'file: trace.json · 900 B',
      'image: b.png · 2×2 · 2.4 KiB',
      'file: report.pdf · 2.0 KiB',
    ])
  })

  it('keeps a text block that follows an attachment after it', () => {
    expect(userContentLines([
      file('sha256:1', 'a.log', 10),
      { type: 'text', text: 'and this' },
    ] as never)).toEqual(['file: a.log · 10 B', 'and this'])
  })

  it('joins consecutive text blocks into one line', () => {
    expect(userContentLines([
      { type: 'text', text: 'first ' },
      { type: 'text', text: 'second' },
    ] as never)).toEqual(['first second'])
  })

  it('skips a block this transcript has no presentation for', () => {
    // `ContentBlockMap` is merge-extensible; a plugin's block is not something
    // to invent a line for.
    expect(userContentLines([
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
      { type: 'text', text: 'visible' },
    ] as never)).toEqual(['visible'])
  })

  it('produces nothing for a message with no presentable content', () => {
    expect(userContentLines([])).toEqual([])
    expect(userContentLines([{ type: 'text', text: '   \n  ' }] as never)).toEqual([])
  })
})

describe('a prompt carrying files', () => {
  it('renders a text prompt and its files as one indented block', () => {
    expect(project('user/message', {
      content: [
        { type: 'text', text: 'Please inspect this.' },
        file('sha256:1', 'report.pdf', 2_511_353),
        file('sha256:2', 'trace.json', 85_094),
      ],
      source: { kind: 'user' },
    })).toEqual([
      '',
      '─'.repeat(78),
      '› Please inspect this.',
      '  file: report.pdf · 2.4 MiB',
      '  file: trace.json · 83.1 KiB',
    ])
  })

  it('gives an attachment-only prompt a visible user entry of its own', () => {
    // No blank history entry, and nothing fabricated in place of the words the
    // reader did not type: the file rows ARE the message.
    expect(project('user/message', {
      content: [file('sha256:1', 'report.pdf', 2_511_353)],
      source: { kind: 'user' },
    })).toEqual(['', '─'.repeat(78), '› file: report.pdf · 2.4 MiB'])
  })

  it('renders mixed content in the logged order', () => {
    expect(project('user/message', {
      content: [
        { type: 'text', text: 'Mixed.' },
        image('a.png'),
        file('sha256:1', 'b.log', 100),
        image('c.png'),
        file('sha256:2', 'd.json', 200),
      ],
      source: { kind: 'user' },
    })).toEqual([
      '',
      '─'.repeat(78),
      '› Mixed.',
      '  image: a.png · 2×2 · 2.4 KiB',
      '  file: b.log · 100 B',
      '  image: c.png · 2×2 · 2.4 KiB',
      '  file: d.json · 200 B',
    ])
  })

  it('shows a hostile file name rather than obeying it', () => {
    const rows = project('user/message', {
      content: [file('sha256:1', 'evil[2J.log', 5)],
      source: { kind: 'user' },
    }, 24)
    expect(rows.join('\n')).toContain('file: evil^[[2J.log')
    expect(rows.join('\n')).not.toContain('[2J')
  })

  it('renders identically on a replay, because it reads only the logged blocks', () => {
    // The live path and the resume replay call the same projection, so a session
    // reopened from `/sessions` shows the same rows with no dshline-side state.
    const content = [
      { type: 'text', text: 'Replayed.' },
      file('sha256:1', 'report.pdf', 2_511_353),
    ]
    const live = project('user/message', { content, source: { kind: 'user' } })
    const replayed = project('user/message', {
      content: JSON.parse(JSON.stringify(content)),
      source: { kind: 'user' },
    })
    expect(replayed).toEqual(live)
  })
})

describe('commandEcho()', () => {
  it('echoes the command line, so a resumed session shows what was asked', () => {
    expect(commandEcho('permission', ' read-only', 80).map(stripAnsi))
      .toEqual(['\u203a /permission read-only'])
  })

  it('echoes a command with no arguments', () => {
    expect(commandEcho('compact', undefined, 80).map(stripAnsi)).toEqual(['\u203a /compact'])
  })

  it('shows a control sequence in a command line rather than obeying it', () => {
    expect(commandEcho('goal', ' \u001b[2J', 80).map(stripAnsi)).toEqual(['\u203a /goal ^[[2J'])
  })
})

describe('commandLines()', () => {
  /** Project and strip styling, so assertions read as what a person would see. */
  const lines = (result: Parameters<typeof commandLines>[0], name = 'goal', columns = 80): string[] =>
    commandLines(result, name, columns).map(stripAnsi)

  it('reports what a command said it did', () => {
    // A command runs without a model turn, so its own text is the ONLY thing that
    // says it happened: there is no reply to read and no card to look at.
    expect(lines({ kind: 'success', text: 'current preset workspace-write' }))
      .toEqual(['\u00b7 current preset workspace-write'])
  })

  it('reports a failure, which must never be silent', () => {
    // A command that fails quietly is indistinguishable from one that is broken —
    // which is exactly how a `/compact` refusal read before this existed.
    expect(lines({ kind: 'error', text: 'Compaction is unavailable' }))
      .toEqual(['\u2717 Compaction is unavailable'])
  })

  it('acknowledges a success that carries no text of its own', () => {
    // `{ kind: 'success' }` with no text is a valid outcome, and the commands that
    // return it are the ones whose effect this frontend cannot otherwise show — so
    // staying silent there is the same defect as dropping the result entirely.
    expect(lines({ kind: 'success' }, 'plan')).toEqual(['\u00b7 /plan done'])
    expect(lines({ kind: 'success', text: '   ' }, 'plan')).toEqual(['\u00b7 /plan done'])
  })

  it('acknowledges one even when its name was never seen', () => {
    // A log that begins between `command/run` and `command/done` has no name to
    // pair; saying something anonymous still beats saying nothing.
    expect(commandLines({ kind: 'success' }, undefined, 80).map(stripAnsi)).toEqual(['\u00b7 command done'])
  })

  it('speaks even when a domain event owns the richer presentation', () => {
    // `sourceEventSeq` defers to an event this frontend does not project, so
    // honouring it would keep the command invisible — the bug, not the fix.
    expect(lines({ kind: 'success', text: 'Goal created', sourceEventSeq: 42 }))
      .toEqual(['\u00b7 Goal created'])
  })

  it('indents a multi-line answer under its mark', () => {
    // `/goal` prints usage and `/permission` prints a list, so this is the normal
    // case rather than an edge one.
    expect(lines({ kind: 'success', text: 'No goal is currently set.\nUsage: /goal [<objective>|clear]' }))
      .toEqual(['\u00b7 No goal is currently set.', '  Usage: /goal [<objective>|clear]'])
  })

  it('keeps every row of a wrapped answer readable on its own', () => {
    // A style applied to multi-line text puts its reset on the last line only, so
    // the rows between would carry an unterminated colour into the live region.
    const rows = commandLines({ kind: 'error', text: 'a'.repeat(40) }, 'goal', 24)
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      expect(row.startsWith('\u001b[')).toBe(true)
      expect(row.endsWith('\u001b[0m')).toBe(true)
    }
  })

  it('shows a control sequence rather than obeying it', () => {
    // Command text is as untrusted as anything else reaching the terminal.
    expect(lines({ kind: 'error', text: 'boom \u001b[2J' })).toEqual(['\u2717 boom ^[[2J'])
  })
})

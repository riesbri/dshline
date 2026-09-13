/** The single-line text overlay: what it shows, and what it never shows. */

import { describe, expect, it } from 'vitest'
import type { Key } from '@dshline/renderer'
import { displayWidth, stripAnsi, wrapToWidth } from '@dshline/renderer'
import { createPromptOverlay } from '../src/prompt.ts'
import type { PromptKind } from '../src/prompt.ts'

/** Width of a comfortable terminal. */
const COLUMNS = 80

/**
 * The title the question adapter composes when a header and a question are both
 * present — the exact shape that used to be cut off mid-sentence.
 */
const LONG_TITLE = "Apply the profile fix?: Do you want me to fix the profile's Codex provider now, or leave it for now?"

/**
 * Rejoin rows the frame wrapped and drop box chrome, so a phrase split across
 * two physical rows still reads as one string.
 * @param text - rendered rows, already stripped of ANSI.
 * @returns the body text with runs of whitespace collapsed.
 */
function bodyText(text: string): string {
  return text
    .replace(/[│╭╮╰╯─]/gu, ' ')
    .split('\n')
    .map(row => row.trim())
    .filter(row => row !== '')
    .join(' ')
    .replace(/\s+/gu, ' ')
}

/** An overlay under test, plus what it settled with. */
interface Mounted {
  text(columns?: number, rows?: number): string
  press(...keys: Key[]): void
  readonly settled: () => { value: string | undefined } | undefined
}

/**
 * Mount a prompt.
 * @param kind - whether the field is masked.
 * @param extra - the optional presentation fields.
 * @returns the overlay and its settlement.
 */
function mount(
  kind: PromptKind,
  extra: { placeholder?: string; detail?: string; initial?: string } = {},
): Mounted {
  let settled: { value: string | undefined } | undefined
  const overlay = createPromptOverlay({
    title: 'API key · openai',
    message: 'Paste the key OpenAI issued you.',
    kind,
    ...extra,
    settle: value => { settled = { value } },
    invalidate: () => {},
  })
  return {
    text: (columns = COLUMNS, rows = 24) => stripAnsi(overlay.render(columns, rows).join('\n')),
    press: (...keys) => { for (const key of keys) overlay.handleKey(key) },
    settled: () => settled,
  }
}

describe('what a prompt shows', () => {
  it('shows the question, and the placeholder while the field is empty', () => {
    const view = mount('text', { placeholder: 'sk-…' })
    const shown = view.text()
    expect(shown).toContain('API key · openai')
    expect(shown).toContain('Paste the key OpenAI issued you.')
    expect(shown).toContain('sk-…')
  })

  it('masks a secret one glyph per character, so length is the only feedback', () => {
    // Length matters: a person typing into a field that shows nothing cannot
    // tell whether the keystrokes are arriving at all.
    const view = mount('secret')
    view.press({ kind: 'text', text: 'sk-abc' })
    const shown = view.text()
    expect(shown).toContain('••••••')
    expect(shown).not.toContain('sk-abc')
  })

  it('echoes a plain value, because a code is meant to be read back', () => {
    const view = mount('text')
    view.press({ kind: 'text', text: 'WXYZ-1234' })
    expect(view.text()).toContain('WXYZ-1234')
  })

  it('never draws a row wider than the terminal', () => {
    const view = mount('text')
    view.press({ kind: 'text', text: 'x'.repeat(400) })
    const overlay = createPromptOverlay({
      title: 'A title long enough to need cutting on a narrow frame',
      message: 'A message long enough to need cutting on a narrow frame as well',
      kind: 'text',
      settle: () => {},
      invalidate: () => {},
    })
    for (const line of [...overlay.render(40), ...view.text(40).split('\n')]) {
      expect(displayWidth(stripAnsi(line))).toBeLessThanOrEqual(40)
    }
  })

  it('shows an escape sequence in the question instead of obeying it', () => {
    const overlay = createPromptOverlay({
      title: 'x',
      message: 'open \u001b[2Jthis',
      kind: 'text',
      settle: () => {},
      invalidate: () => {},
    })
    expect(stripAnsi(overlay.render(COLUMNS).join('\n'))).toContain('^[[2J')
  })

  it('bounds narrative head rows and integrates help into the bottom border', () => {
    const overlay = createPromptOverlay({
      title: 'A detailed credential question',
      view: 'API key',
      message: 'first line\nsecond line\nthird line',
      detail: 'supporting detail',
      kind: 'text',
      settle: () => {},
      invalidate: () => {},
    })
    const lines = overlay.render(COLUMNS, 7).map(stripAnsi)
    expect(lines).toHaveLength(7)
    expect(lines[1]).toContain('API key')
    // The semantic title is the body's heading even when the border holds only
    // the concise view identity, and it spends the first narrative row.
    expect(lines[2]).toContain('A detailed credential question')
    expect(lines.join('\n')).toContain('first line')
    expect(lines.join('\n')).not.toContain('second line')
    expect(lines.at(-1)).toMatch(/^╰─ enter confirm · esc cancel .*─╯$/u)
  })

  it('keeps the message visible across the compact-to-framed boundary', () => {
    // The 5-row compact fallback shows the message; framing at exactly 6 rows
    // used to spend the whole budget on title+field and drop it — a question
    // that vanished because the terminal grew one row. The framed form must
    // never open without at least one message row.
    const overlay = createPromptOverlay({
      title: 'Sign in · ChatGPT (Codex)',
      view: 'Sign in',
      message: 'Paste the code ChatGPT issued you.',
      kind: 'text',
      settle: () => {},
      invalidate: () => {},
    })
    const compactSix = overlay.render(COLUMNS, 6).map(stripAnsi)
    expect(compactSix.join('\n')).toContain('Paste the code ChatGPT issued you.')
    expect(compactSix.join('\n')).not.toContain('╭')
    const framedSeven = overlay.render(COLUMNS, 7).map(stripAnsi)
    expect(framedSeven).toHaveLength(7)
    expect(framedSeven.join('\n')).toContain('Paste the code ChatGPT issued you.')
    expect(framedSeven.join('\n')).toContain('Sign in · ChatGPT (Codex)')
    expect(overlay.render(COLUMNS, 5).map(stripAnsi).join('\n'))
      .toContain('Paste the code ChatGPT issued you.')
    // Bounded at every boundary height, compact and framed alike.
    for (const rows of [5, 6, 7]) {
      const physical = overlay.render(30, rows).flatMap(line => wrapToWidth(line, 30))
      expect(physical.length, `${String(rows)} rows`).toBeLessThanOrEqual(rows)
    }
  })

  it('keeps the full semantic title in the body when the border shows only the view', () => {
    // The right border label may be short, but the full title is what carries
    // the provider or account name; truncating decoration must never lose it.
    for (const [title, view] of [
      ['Sign in · ChatGPT (Codex)', 'Sign in'],
      ['API key · opencode', 'API key'],
      ['New preset id', 'New preset'],
      ['Add a bundle', 'Add bundle'],
    ] as const) {
      const overlay = createPromptOverlay({
        title,
        view,
        message: 'Paste the value here.',
        kind: 'text',
        settle: () => {},
        invalidate: () => {},
      })
      const lines = overlay.render(COLUMNS, 24).map(stripAnsi)
      expect(lines.join('\n'), title).toContain(title)
      // The border carries only the concise identity, never the full title:
      // whatever the decoration truncates, the body heading above is the truth.
      expect(lines[1], title).toContain(view)
      expect(lines[1], title).not.toContain(title)
    }
  })

  it('never lets the title row grow the frame past the terminal', () => {
    const overlay = createPromptOverlay({
      title: 'Sign in · a very long provider label that needs cutting',
      view: 'Sign in',
      message: 'first line\nsecond line\nthird line\nfourth line',
      kind: 'text',
      settle: () => {},
      invalidate: () => {},
    })
    for (const rows of [5, 6, 7, 8, 9, 12]) {
      const lines = overlay.render(30, rows)
      const physical = lines.flatMap(line => wrapToWidth(line, 30))
      expect(physical.length, `${String(rows)} rows`).toBeLessThanOrEqual(rows)
    }
  })

  it('keeps a compact field and atomic exit help when the frame cannot fit', () => {
    const overlay = createPromptOverlay({
      title: 'Credential',
      message: 'first line\nsecond line\nthird line',
      kind: 'text',
      settle: () => {},
      invalidate: () => {},
    })
    const heightBound = overlay.render(COLUMNS, 5).map(stripAnsi)
    expect(heightBound).toHaveLength(5)
    expect(heightBound.join('\n')).not.toContain('╭')
    expect(heightBound.at(-1)).toBe('enter · esc')
    expect(overlay.render(4, 2).map(stripAnsi).at(-1)).toBe('esc')
  })
})

describe('a question too long for one row', () => {
  it('wraps the semantic title instead of dropping its end', () => {
    // The old one-row `truncateToWidth` silently lost everything past the
    // frame's inner width; a question must survive at any readable geometry.
    const overlay = createPromptOverlay({
      title: LONG_TITLE,
      view: 'Question',
      message: '',
      kind: 'text',
      settle: () => {},
      invalidate: () => {},
    })
    for (const columns of [100, 80]) {
      const shown = stripAnsi(overlay.render(columns, 24).join('\n'))
      expect(bodyText(shown), `${String(columns)} columns`).toContain(LONG_TITLE)
    }
  })

  it('uses the title as the compact fallback context when there is no message', () => {
    // `ask_user_question` sends an option-less question as the title with an
    // empty message, so a fallback that only knew the message erased the
    // question exactly when the terminal was too small to frame it.
    const overlay = createPromptOverlay({
      title: LONG_TITLE,
      view: 'Question',
      message: '',
      kind: 'text',
      settle: () => {},
      invalidate: () => {},
    })
    const compact = stripAnsi(overlay.render(COLUMNS, 6).join('\n'))
    expect(compact).not.toContain('╭')
    expect(bodyText(compact)).toContain(LONG_TITLE)
  })

  it('counts wrapped title rows against the frame height at every boundary', () => {
    const overlay = createPromptOverlay({
      title: LONG_TITLE,
      view: 'Question',
      message: 'Type your own answer',
      kind: 'text',
      settle: () => {},
      invalidate: () => {},
    })
    for (const rows of [5, 6, 7, 8, 9, 10, 12, 24]) {
      const lines = overlay.render(COLUMNS, rows)
      const physical = lines.flatMap(line => wrapToWidth(line, COLUMNS))
      expect(physical.length, `${String(rows)} rows`).toBeLessThanOrEqual(rows)
      for (const line of lines) {
        expect(displayWidth(line), `${String(rows)} rows`).toBeLessThanOrEqual(COLUMNS)
      }
    }
    // Once the frame has room for the wrapped title plus one message row, the
    // whole question is present rather than merely its beginning.
    const framed = stripAnsi(overlay.render(COLUMNS, 8).join('\n'))
    expect(framed).toContain('╭')
    expect(bodyText(framed)).toContain(LONG_TITLE)
  })

  it('falls back rather than framing a message out of the budget', () => {
    // The invariant the wrapped-title budget must preserve: a frame never opens
    // if wrapping the title leaves no room for one message row. At seven rows
    // the title owns two and the message cannot fit, so the compact form shows
    // it; one row later the frame has room for both.
    const overlay = createPromptOverlay({
      title: LONG_TITLE,
      view: 'Question',
      message: 'Type your own answer',
      kind: 'text',
      settle: () => {},
      invalidate: () => {},
    })
    const squeezed = stripAnsi(overlay.render(COLUMNS, 7).join('\n'))
    expect(squeezed).not.toContain('╭')
    expect(squeezed).toContain('Type your own answer')
    const roomy = stripAnsi(overlay.render(COLUMNS, 8).join('\n'))
    expect(roomy).toContain('╭')
    expect(bodyText(roomy)).toContain(LONG_TITLE)
    expect(roomy).toContain('Type your own answer')
  })

  it('wraps a long unbroken CJK title without losing a character', () => {
    const title = '这是一个需要完整显示的较长中文问题不能截断'.repeat(3)
    const overlay = createPromptOverlay({
      title,
      view: '问题',
      message: '',
      kind: 'text',
      settle: () => {},
      invalidate: () => {},
    })
    const shown = stripAnsi(overlay.render(COLUMNS, 24).join('\n'))
    expect(bodyText(shown).replace(/\s+/gu, '')).toContain(title)
  })
})

describe('editing', () => {
  it('starts from the initial value, edits it, and settles the edited answer', () => {
    // Deliberate break: starting `value` at the old empty string makes the
    // prefill, its backspace edit, and the final answer all fail together.
    const view = mount('text', { initial: 'Old Name' })
    expect(view.text()).toContain('Old Name')
    view.press(
      { kind: 'key', name: 'backspace' },
      { kind: 'text', text: 'e session' },
      { kind: 'key', name: 'enter' },
    )
    expect(view.settled()).toEqual({ value: 'Old Name session' })
  })

  it('clears an initial value with ctrl-u', () => {
    // Deliberate break: making ctrl-u preserve a prefill leaves this old title
    // visible and returns it instead of the empty replacement.
    const view = mount('text', { initial: 'Remove me' })
    view.press({ kind: 'key', name: 'ctrl-u' }, { kind: 'key', name: 'enter' })
    expect(view.text()).not.toContain('Remove me')
    expect(view.settled()).toEqual({ value: '' })
  })

  it('shows the initial value in the compact fallback', () => {
    const view = mount('text', { initial: 'Prefilled compact title' })
    expect(view.text(COLUMNS, 5)).toContain('Prefilled compact title')
  })

  it('flattens newlines in a prefilled value on screen but not on submit', () => {
    // Deliberate break: drawing the value with its raw newline lets Screen
    // expand one logical field row into two. The submitted answer keeps the
    // newline — normalization belongs to Harness, not the field.
    const view = mount('text', { initial: 'Title\nline two' })
    const field = view.text().split('\n').find(line => line.includes('❯')) ?? ''
    expect(field).toContain('Title line two')
    expect(field).not.toContain('\nline two')
    view.press({ kind: 'key', name: 'enter' })
    expect(view.settled()).toEqual({ value: 'Title\nline two' })
  })

  it('deletes one character per press, code points included', () => {
    const view = mount('text')
    view.press({ kind: 'text', text: 'a😀' }, { kind: 'key', name: 'backspace' })
    expect(view.text()).toContain('a')
    expect(view.text()).not.toContain('😀')
  })

  it('clears the line and the last word', () => {
    const view = mount('text')
    view.press({ kind: 'text', text: 'one two' }, { kind: 'key', name: 'ctrl-w' })
    expect(view.text()).toContain('one')
    expect(view.text()).not.toContain('two')
    view.press({ kind: 'key', name: 'ctrl-u' })
    expect(view.text()).not.toContain('one')
  })

  it('drops only the line breaks a one-line field cannot hold', () => {
    // A copied terminal line arrives with a trailing newline; everything else is
    // taken verbatim. This overlay serves Harness's generic `text` and `secret`
    // prompts, where the spacing of a value may BE the value, so collapsing runs
    // of space or trimming the ends would be editing an answer it does not
    // understand. An API key is trimmed later, by `normalizeApiKey`.
    const view = mount('text')
    view.press({ kind: 'paste', text: '  sk  one\ntwo\n' })
    expect(view.text()).toContain('  sk  onetwo')
  })

  it('keeps the value exactly as typed, spaces included', () => {
    const view = mount('text')
    view.press({ kind: 'text', text: 'two  spaces ' })
    view.press({ kind: 'key', name: 'enter' })
    expect(view.settled()).toEqual({ value: 'two  spaces ' })
  })
})

describe('a value longer than the field', () => {
  it('keeps the newest characters visible, not the oldest', () => {
    // The reason the field cuts at the front: a person watches what they are
    // typing, and hiding the tail hides exactly that.
    const view = mount('text')
    view.press({ kind: 'text', text: `${'a'.repeat(200)}TAIL` })
    const shown = view.text(40)
    expect(shown).toContain('TAIL')
    expect(shown).not.toContain('aaaaTAIL'.replace('TAIL', 'a'.repeat(200)))
  })

  it('keeps the cursor block at the end of a full field', () => {
    const view = mount('text')
    view.press({ kind: 'text', text: 'z'.repeat(200) })
    expect(view.text(40)).toContain('z█')
  })

  it('shows the newest mask glyphs for a long secret', () => {
    const view = mount('secret')
    view.press({ kind: 'text', text: 'z'.repeat(200) })
    const row = view.text(40).split('\n').find(line => line.includes('•')) ?? ''
    expect(displayWidth(row)).toBeLessThanOrEqual(40)
    expect(row).toContain('•█')
  })
})

describe('settling', () => {
  it('answers with the typed value on enter', () => {
    const view = mount('secret')
    view.press({ kind: 'text', text: 'sk-1' }, { kind: 'key', name: 'enter' })
    expect(view.settled()).toEqual({ value: 'sk-1' })
  })

  it('answers with nothing on escape', () => {
    const view = mount('text')
    view.press({ kind: 'key', name: 'escape' })
    expect(view.settled()).toEqual({ value: undefined })
  })

  it('settles once, however many keys arrive before the unmount', () => {
    // The registry can deliver one more keystroke between the decision and the
    // unmount, and a second settlement would resolve a promise nobody holds.
    let calls = 0
    const overlay = createPromptOverlay({
      title: 'x',
      message: 'y',
      kind: 'text',
      settle: () => { calls += 1 },
      invalidate: () => {},
    })
    overlay.handleKey({ kind: 'key', name: 'enter' })
    overlay.handleKey({ kind: 'key', name: 'escape' })
    expect(calls).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import { displayWidth, stripAnsi } from '@dshline/renderer'
import { composerHintRow } from '../src/views.ts'

describe('human-shell discovery', () => {
  it('adds a whole low-priority hint only when the profile supplies shell execution', () => {
    expect(stripAnsi(composerHintRow({ busy: false, busyEnter: 'queue', shell: true }, 80)))
      .toBe('› ask anything · / menu · ! shell')
    expect(stripAnsi(composerHintRow({ busy: false, busyEnter: 'queue' }, 80)))
      .toBe('› ask anything · / menu')
    expect(stripAnsi(composerHintRow({ busy: true, busyEnter: 'steer', shell: true }, 80)))
      .toBe('› type to steer')
  })

  it('sheds shell discovery before the existing prompt/menu and staged counts', () => {
    const hint = { busy: false, busyEnter: 'queue', shell: true, images: 1, files: 1 } as const
    for (let width = 8; width <= 80; width++) {
      const row = composerHintRow(hint, width)
      expect(displayWidth(row)).toBeLessThanOrEqual(width)
      if (stripAnsi(row).includes('! shell')) expect(stripAnsi(row)).toContain('1 image · 1 file · ask anything · / menu')
    }
    expect(stripAnsi(composerHintRow({ busy: false, busyEnter: 'queue', shell: true }, 24)))
      .toBe('› ask anything · / menu')
  })
})

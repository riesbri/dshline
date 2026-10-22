import type { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../src/window.ts', () => ({
  createWindow: async () => { throw new Error('boot-\u001b]52;c;AUDIT\u0007-\u009b2J') },
}))

import { apply } from '../src/index.ts'

afterEach(() => { vi.restoreAllMocks() })

it('escapes a rejected boot before reporting it and still exits nonzero', async () => {
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const exit = vi.fn()
  const ctx = {
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => name === 'appExit' ? exit : undefined,
    inject: (_names: string[], ready: (context: Context) => void) => { ready(ctx as unknown as Context) },
  }
  apply(ctx as unknown as Context)
  await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(1) })
  const diagnostic = write.mock.calls.map(([chunk]) => String(chunk)).join('')
  expect(diagnostic).toContain('boot-^[]52;c;AUDIT^G')
  expect(diagnostic.slice(0, -2)).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u)
  expect(diagnostic).toMatch(/\r\n$/u)
})

import { describe, it } from 'vitest'
import { Screen } from '../src/index.ts'
import { createEmulator } from '../../../tests/emulator.ts'

describe('tmp', () => {
  it('prints buffer after external output', async () => {
    const emulator = createEmulator(40, 12)
    const screen = new Screen(emulator.target)
    screen.setLive(['╭─ dshline ───────────────────────────╮', '│ composer                           │', '╰─────────────────────────────────────╯', 'status'], { row: 1, column: 3 })
    emulator.target.write('WARN: startup\r\n')
    screen.setLive(['╭─ dshline ───────────────────────────╮', '│ composer                           │', '╰─────────────────────────────────────╯', 'status active'], { row: 1, column: 3 })
    console.log('SCREEN', await emulator.screen())
    console.log('SCROLL', await emulator.scrollback())
    emulator.dispose()
  })
})

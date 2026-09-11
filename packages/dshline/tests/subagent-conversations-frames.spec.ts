/**
 * Real-terminal frames for the subagent conversation inspector.
 *
 * The inspector is temporary live-region chrome: it must never rewrite a
 * committed row, and repeated redraws must leave exactly one frame behind. A
 * headless `@xterm/headless` terminal is the only place those two properties
 * are visible, because the cursor moves rather than the whole screen being
 * repainted.
 */

import { describe, expect, it } from 'vitest'
import { Screen, stripAnsi } from '@dshline/renderer'
import type { Key } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { SurfaceNotice } from '../src/surface.ts'
import { createSubagentCatalogOverlay, createSubagentConversationOverlay } from '../src/subagents/overlay.ts'
import type { SubagentChildRow } from '../src/subagents/model.ts'
import type { SubagentTranscriptReading } from '../src/subagents/transcript.ts'

/** The child every frame test inspects. */
const CHILD: SubagentChildRow = {
  kind: 'child', id: 'child-1', mode: 'continuable', residency: 'resident', hasChildren: false, label: 'review',
}

/** A reading with enough rows to scroll. */
function reading(): SubagentTranscriptReading {
  return {
    kind: 'ready',
    hasOlder: false,
    stale: false,
    events: Array.from({ length: 12 }, (_, index) => ({
      type: 'user/message',
      seq: (index + 1) as never,
      time: 1_700_000_000_000 + index,
      data: { content: [{ type: 'text', text: `event number ${String(index + 1)}` }] },
    })) as never,
  }
}

/** Build the conversation inspector used by both frame tests. */
function inspector(): ReturnType<typeof createSubagentConversationOverlay> {
  return createSubagentConversationOverlay({
    child: () => CHILD,
    reading,
    followUp: true,
    steer: true,
    interruptible: true,
    loadOlder: () => {},
    refresh: () => {},
    message: () => {},
    interrupt: () => {},
    notice: new SurfaceNotice(1_000),
    close: () => {},
    invalidate: () => {},
  })
}

/** A key keystroke. */
function key(name: string): Key {
  return { kind: 'key', name } as Key
}

describe('subagent conversation frames on a real terminal', () => {
  it('never rewrites committed scrollback when it opens and closes', async () => {
    const emulator = createEmulator(60, 12)
    const screen = new Screen(emulator.target)
    screen.commit(['committed transcript row'])
    const before = await emulator.scrollback()

    const overlay = inspector()
    screen.setLive(overlay.render(60, 12))
    overlay.handleKey(key('down'))
    overlay.handleKey(key('down'))
    screen.setLive(overlay.render(60, 12))
    // Closing restores whatever was underneath; the committed row is untouched.
    screen.setLive(['composer', 'status'])

    const after = await emulator.scrollback()
    expect(after.filter(row => row.includes('committed transcript row')))
      .toEqual(before.filter(row => row.includes('committed transcript row')))
    expect(after.join('\n')).not.toContain('Subagent')
    expect(screen.height).toBeLessThanOrEqual(12)
  })

  it('leaves exactly one frame behind across repeated redraws', async () => {
    const emulator = createEmulator(60, 12)
    const screen = new Screen(emulator.target)
    const overlay = inspector()
    for (let step = 0; step < 10; step += 1) {
      overlay.handleKey(key('down'))
      screen.setLive(overlay.render(60, 12))
    }
    const history = await emulator.scrollback()
    expect(history.filter(row => row.includes('╭─'))).toHaveLength(1)
  })

  it('draws the catalog as bounded live-region chrome', async () => {
    const emulator = createEmulator(40, 8)
    const screen = new Screen(emulator.target)
    const overlay = createSubagentCatalogOverlay({
      reading: () => ({
        kind: 'ready',
        rows: [{ kind: 'child', id: 'child-1', mode: 'continuable', residency: 'stored', hasChildren: false, label: 'review' }],
      }),
      inspect: () => {},
      refresh: () => {},
      close: () => {},
      invalidate: () => {},
    })
    screen.setLive(overlay.render(40, 8))
    screen.setLive(overlay.render(40, 8))
    const visible = stripAnsi((await emulator.screen()).join('\n'))
    expect(visible).toContain('Subagent conversations')
    expect(visible).toContain('review')
    expect(screen.height).toBeLessThanOrEqual(8)
  })
})

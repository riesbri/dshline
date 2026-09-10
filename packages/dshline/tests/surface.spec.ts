/**
 * Tests for the bounded-surface kernel and the presenters built on it.
 *
 * The properties under test are the ones each surface used to re-derive: that a
 * live region never exceeds the rows it was given, that a terminal too small to
 * frame still says one whole thing, that a temporary notice is owned with an
 * explicit lifetime and can win the geometry backstop, that close is idempotent
 * and returns the keyboard, and that a presenter command mounts exactly one
 * surface and dismisses it.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Key } from '@dshline/renderer'
import { BOX_CHROME_COLUMNS, paint, Screen, stripAnsi, wrapToWidth } from '@dshline/renderer'
import { createEmulator } from '../../../tests/emulator.ts'
import { chromeWidth } from '../src/chrome.ts'
import type { TuiOverlay, TuiSlots } from '../src/slots.ts'
import {
  compactRows,
  createBoundedSurface,
  frameBounded,
  noticeRow,
  openSurface,
  physicalRows,
  SurfaceNotice,
  SURFACE_FIXED_ROWS,
} from '../src/surface.ts'
import { createTodosPresenter } from '../src/todos/presenter.ts'
import { createCachePresenter } from '../src/cache/presenter.ts'
import { createContextPresenter } from '../src/context/presenter.ts'

/** A live-region registry that records what a presenter mounts. */
function recordingSlots(): { slots: TuiSlots; mounted: TuiOverlay[]; dismissals: () => number } {
  const mounted: TuiOverlay[] = []
  let dismissals = 0
  const slots = {
    pushOverlay(overlay: TuiOverlay) {
      mounted.push(overlay)
      return () => { dismissals += 1 }
    },
  } as unknown as TuiSlots
  return { slots, mounted, dismissals: () => dismissals }
}

/** A one-key surface for key-routing tests. */
function key(name: string): Key {
  return { kind: 'key', name } as Key
}

describe('physicalRows', () => {
  it('counts the rows Screen wraps and ignores escape sequences', () => {
    expect(physicalRows(['abc', 'x'.repeat(10)], 4)).toHaveLength(4)
    expect(physicalRows([paint('abc', 'error')], 3)).toHaveLength(1)
  })
})

describe('compactRows', () => {
  it('prefers the whole summary, then the whole way out, then nothing', () => {
    expect(compactRows(['State'], 40).map(stripAnsi)).toEqual(['State · esc close'])
    expect(compactRows(['A very long state'], 9).map(stripAnsi)).toEqual(['esc close'])
    expect(compactRows(['A very long state'], 3).map(stripAnsi)).toEqual(['esc'])
    expect(compactRows(['A very long state'], 2)).toEqual([])
  })

  it('tries the most specific phrase first', () => {
    const narrow = compactRows(['compacting context', '12k/1M'], 22).map(stripAnsi)
    expect(narrow).toEqual(['12k/1M · esc close'])
  })
})

describe('SurfaceNotice', () => {
  it('retires a notice once its own lifetime passes', () => {
    const notice = new SurfaceNotice(1_000)
    notice.show('failed to compact')
    expect(notice.read()).toEqual({ text: 'failed to compact', failed: false })
    expect(notice.read(Date.now() + 2_000)).toBeUndefined()
    expect(notice.read()).toBeUndefined()
  })

  it('escapes untrusted text before styling it', () => {
    const notice = new SurfaceNotice(1_000)
    notice.show('a\u001b[2Jb', true)
    const row = notice.row(40) ?? ''
    expect(stripAnsi(row)).toContain('a^[[2Jb')
    expect(noticeRow(undefined, 40)).toBeUndefined()
  })
})

describe('frameBounded', () => {
  it('frames content that fits and refuses content that does not', () => {
    const fits = frameBounded({ columns: 60, rows: 6, title: 'Probe', body: ['one'] })
    expect(fits?.map(stripAnsi).join('\n')).toContain('one')
    expect(frameBounded({ columns: 60, rows: 3, title: 'Probe', body: ['one'] })).toBeUndefined()
  })
})

describe('createBoundedSurface', () => {
  it('hands the presenter the inner width and the capacity left after fixed rows', () => {
    let seen: { width: number; capacity: number } | undefined
    const surface = createBoundedSurface({
      reading: () => ['a', 'b', 'c', 'd', 'e'] as const,
      title: () => 'Probe',
      body: (reading, width, capacity) => {
        seen = { width, capacity }
        return reading.slice(0, capacity)
      },
      compact: () => 'Probe',
      close: () => {},
    })
    surface.render(40, 8)
    expect(seen).toEqual({ width: chromeWidth(40) - BOX_CHROME_COLUMNS, capacity: 8 - SURFACE_FIXED_ROWS })
  })

  it('never draws more physical rows than the live region was given', () => {
    const surface = createBoundedSurface({
      reading: () => ['one', 'two', 'three', 'four', 'five', 'six', 'seven'],
      title: () => 'Probe',
      body: (reading, width, capacity) => reading.slice(0, capacity).map(row => row.slice(0, width)),
      compact: () => 'Probe compact summary',
      close: () => {},
    })
    for (const columns of [2, 6, 20, 40, 80, 132]) {
      for (const rows of [0, 1, 2, 3, 4, 8, 24]) {
        const lines = surface.render(columns, rows)
        expect(physicalRows(lines, columns).length, `${String(columns)}x${String(rows)}`).toBeLessThanOrEqual(rows)
      }
    }
  })

  it('degrades to one whole phrase on a terminal too small to frame', () => {
    const surface = createBoundedSurface({
      reading: () => 0,
      title: () => 'Probe',
      body: () => ['body'],
      compact: () => 'Probe state',
      close: () => {},
    })
    expect(surface.render(80, 3).map(stripAnsi)).toEqual(['Probe state · esc close'])
    expect(surface.render(8, 3).map(stripAnsi)).toEqual(['esc'])
    expect(surface.render(2, 3)).toEqual([])
    expect(surface.render(80, 0)).toEqual([])
  })

  it('reserves a row for an active notice and drops it once retired', () => {
    const notice = new SurfaceNotice(1_000)
    const surface = createBoundedSurface({
      reading: () => 0,
      title: () => 'Probe',
      body: (_reading, _width, capacity) => Array.from({ length: capacity }, (_, index) => `row ${String(index)}`),
      compact: () => 'Probe',
      notice,
      close: () => {},
    })
    const before = physicalRows(surface.render(60, 8), 60).length
    notice.show('a problem')
    const during = physicalRows(surface.render(60, 8), 60).length
    expect(during).toBe(before)
    expect(surface.render(60, 8).map(stripAnsi).join('\n')).toContain('a problem')
  })

  it('lets a failed notice win the geometry backstop', () => {
    const notice = new SurfaceNotice(1_000)
    notice.show('compaction refused', true)
    const surface = createBoundedSurface({
      reading: () => 0,
      title: () => 'Probe',
      body: () => ['body'],
      compact: () => 'Probe state',
      notice,
      close: () => {},
    })
    const row = surface.render(60, 3).map(stripAnsi).join('\n')
    expect(row).toContain('compaction refused')
    expect(row).not.toContain('esc close')
  })

  it('closes once on escape or ctrl-c and still routes other keys', () => {
    const onKey = vi.fn()
    let closes = 0
    const surface = createBoundedSurface({
      reading: () => 0,
      title: () => 'Probe',
      body: () => [],
      compact: () => 'Probe',
      onKey,
      close: () => { closes += 1 },
    })
    surface.handleKey(key('ctrl-d'))
    surface.handleKey({ kind: 'text', text: 'x' })
    expect(closes).toBe(0)
    expect(onKey).toHaveBeenCalledTimes(2)
    surface.handleKey(key('escape'))
    expect(closes).toBe(1)
    surface.handleKey(key('ctrl-c'))
    expect(closes).toBe(1)
    // No feature key reaches the presenter once the surface is closed.
    surface.handleKey(key('enter'))
    expect(onKey).toHaveBeenCalledTimes(2)
  })

  it('forwards dispose so a presenter-owned heartbeat is released', () => {
    const dispose = vi.fn()
    const surface = createBoundedSurface({
      reading: () => 0,
      title: () => 'Probe',
      body: () => [],
      compact: () => 'Probe',
      close: () => {},
      dispose,
    })
    surface.dispose?.()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})

describe('openSurface', () => {
  it('resolves the close handshake with the dismisser the registry returned', () => {
    let dismissals = 0
    const overlay: TuiOverlay = { render: () => [], handleKey: () => {} }
    let captured: (() => void) | undefined
    const dismiss = openSurface(
      { pushOverlay: () => () => { dismissals += 1 } },
      close => { captured = close; return overlay },
    )
    captured?.()
    expect(dismissals).toBe(1)
    dismiss()
    expect(dismissals).toBe(2)
  })

  it('survives a surface that closes before it was mounted', () => {
    const overlay: TuiOverlay = { render: () => [], handleKey: () => {} }
    expect(() => openSurface(
      { pushOverlay: () => () => {} },
      close => { close(); return overlay },
    )).not.toThrow()
  })
})

describe('migrated capability presenters', () => {
  it('mounts the Todo surface from the authoritative snapshot and dismisses it on close', () => {
    const registry = recordingSlots()
    const presenter = createTodosPresenter({
      slots: registry.slots,
      snapshot: () => ({
        asOfSeq: -1,
        values: { todos: [{ content: 'ship it', status: 'pending' }] },
      }) as never,
    })
    expect(presenter.command.name).toBe('todos')
    presenter.command.execute('')
    expect(registry.mounted).toHaveLength(1)
    expect(registry.mounted[0]?.render(60, 8).map(stripAnsi).join('\n')).toContain('○ ship it')
    registry.mounted[0]?.handleKey(key('escape'))
    expect(registry.dismissals()).toBe(1)
    expect(registry.mounted).toHaveLength(1)
  })

  it('mounts the Cache surface without the runner building the reading', () => {
    const registry = recordingSlots()
    const presenter = createCachePresenter({
      slots: registry.slots,
      session: {} as never,
      snapshot: () => undefined,
    })
    expect(presenter.command.name).toBe('cache')
    presenter.command.execute('')
    expect(registry.mounted).toHaveLength(1)
    registry.mounted[0]?.handleKey(key('escape'))
    expect(registry.dismissals()).toBe(1)
  })

  it('mounts the Context surface with its survey and compaction deps', () => {
    const registry = recordingSlots()
    const presenter = createContextPresenter({
      slots: registry.slots,
      session: {} as never,
      snapshot: () => undefined,
      survey: () => ({ available: false, surfaceTokens: 0, nodes: 0, entries: [] }),
      capacity: () => undefined,
      canCompact: () => false,
      compact: () => Promise.resolve(undefined),
      invalidate: () => {},
    })
    expect(presenter.command.name).toBe('context')
    presenter.command.execute('')
    expect(registry.mounted).toHaveLength(1)
    expect(registry.mounted[0]?.render(60, 8).map(stripAnsi).join('\n')).toContain('Context')
    registry.mounted[0]?.handleKey(key('escape'))
    expect(registry.dismissals()).toBe(1)
  })
})

describe('the bounded surface over committed scrollback', () => {
  it('never rewrites finished transcript rows', async () => {
    const emulator = createEmulator(60, 12)
    const screen = new Screen(emulator.target)
    screen.commit(['committed transcript row'])
    const before = await emulator.scrollback()
    const surface = createBoundedSurface({
      reading: () => 0,
      title: () => 'Probe',
      body: () => ['live body'],
      compact: () => 'Probe',
      close: () => { screen.setLive(['composer', 'status']) },
    })
    screen.setLive(surface.render(60, 12))
    surface.handleKey(key('escape'))
    const after = await emulator.scrollback()
    expect(after.filter(row => row.includes('committed transcript row')))
      .toEqual(before.filter(row => row.includes('committed transcript row')))
    expect(after.join('\n')).not.toContain('live body')
    expect(after.join('\n')).not.toContain('Probe')
  })

  it('keeps a wrapped logical row inside the budget it was given', () => {
    const surface = createBoundedSurface({
      reading: () => '审查😀'.repeat(30),
      title: () => 'Probe',
      body: reading => [reading],
      compact: () => 'Probe',
      close: () => {},
    })
    const lines = surface.render(24, 6)
    expect(lines.flatMap(line => wrapToWidth(line, 24)).length).toBeLessThanOrEqual(6)
  })
})

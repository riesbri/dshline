import { readFileSync } from 'node:fs'
/** Hand-authored normalized requests; golden outputs MUST come from capture(). */
const plain = 'A中文 e\u0301 👩‍👩‍👧‍👦 \ud800\udfff'
const hostile = '\u001b[31mred\u001b[0m\u001b[?25l\u001b]8;;url\u0007link\u001b]8;;\u001b\\\u001b[broken\u001b\u0000\u009b\t'
export function observedInputs() {
  return JSON.parse(readFileSync(new URL('./renderer-parity-session/inputs.json', import.meta.url), 'utf8'))
}
export function corpusInputs() {
  const cases = []
  const add = (id, input, palette) => cases.push({ version: 1, provenance: { kind: 'synthetic', description: 'Deterministic hand-authored presentation request; actual TypeScript output captured, not a real Harness session.' }, ...(palette ? { palette } : {}), cases: [{ id, input }] })
  for (const op of ['displayWidth', 'stripAnsi', 'escapeControls', 'sanitizePasted', 'renderInline', 'renderMarkdown']) {
    add(`${op}-unicode`, { op, text: plain })
    add(`${op}-controls`, { op, text: hostile })
  }
  for (const code of [0, 65, 0x4e00, 0x1f600, 0x200d, 0xd800, 0xdfff, 0x10ffff]) add(`code-${code}`, { op: 'codePointWidth', code })
  for (const op of ['truncateToWidth', 'tailToWidth', 'chunkToWidth', 'wrapToWidth', 'fitToWidth']) {
    for (const columns of [-1, 0, 1, 7, 24]) add(`${op}-${columns}`, { op, text: '\u001b[31m中 e\u0301 😀\u001b[39m abc\u001b[0m', columns })
    add(`${op}-surrogates`, { op, text: plain, columns: 8 })
    add(`${op}-malformed`, { op, text: '\u001b[broken\u001b', columns: 4 })
  }
  add('hanging', { op: 'hangingIndent', mark: '› ', indent: '  ', text: plain, columns: 12 })
  add('sgr-order', { op: 'sgr', text: '\ud800X', params: [1, 38, 5, 123] })
  add('sgr-empty', { op: 'sgr', text: hostile, params: [] })
  for (const width of [-1, 5, 16]) {
    for (const op of ['box', 'frame']) add(`${op}-${width}`, { op, content: ['中文 abc', '', ...(op === 'frame' ? [{ kind: 'divider' }] : []), 'tail'], options: { width, title: 'left', border: [31], ...(op === 'frame' ? { rightTitle: 'right', footer: 'foot' } : {}) } })
    for (const op of ['boxHeight', 'frameHeight']) add(`${op}-${width}`, { op, content: ['中文 abc', ''], width })
  }
  for (const depth of [0, 4, 8, 24]) {
    const palette = { id: `resolved-${depth}`, depth, roles: { 'heading-1': depth === 24 ? [38, 2, 12, 34, 56] : depth === 8 ? [38, 5, 123] : [1, 35], strong: [1, 31], emphasis: [3], code: [44, 33], muted: [2] } }
    add(`markdown-palette-${depth}`, { op: 'renderMarkdown', text: '# Hi\n**bold** [link](url)\n> quote' }, palette)
    add(`inline-palette-${depth}`, { op: 'renderInline', text: '**bold** `code` _em_ ~~gone~~' }, palette)
  }
  add('markdown-missing-roles', { op: 'renderMarkdown', text: '# Hi\n`code`\n> quote' }, { id: 'missing', depth: 24, roles: {} })
  for (const marker of ['```', '~~~~']) add(`fence-${marker.length}-${marker[0]}`, { op: 'markdownSequence', calls: [
    { method: 'partial', text: marker + 'js' }, { method: 'line', text: marker + 'js' },
    { method: 'partial', text: '**x**' }, { method: 'line', text: '**x**' },
    { method: 'line', text: marker.slice(1) }, { method: 'line', text: marker + 'info' },
    { method: 'line', text: marker }, { method: 'partial', text: '_suffix_', startsLine: false },
  ] })
  add('screen-resize-bce', { op: 'screenSequence', columns: 18, calls: [
    { method: 'setLive', lines: ['\u001b[41;33mAB', 'second'], cursor: { row: 0, column: 1 } },
    { method: 'setLive', lines: ['\u001b[41;33mAB', 'second'], cursor: { row: 0, column: 1 } },
    { method: 'commit', lines: ['done'] }, { method: 'resize', columns: 10 },
    { method: 'markStale' }, { method: 'setLive', lines: ['short'], cursor: { row: 0, column: 2 } }, { method: 'close' },
  ] })
  return [...cases, ...observedInputs()]
}

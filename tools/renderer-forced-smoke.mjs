/** Exercise compiled package resolution, without Vitest's source aliases or a user profile. */
import { deepStrictEqual, strictEqual } from 'node:assert'
import * as api from '../packages/renderer/lib/index.js'
import * as referenceWidth from '../packages/renderer/lib/width.js'
import * as referenceBox from '../packages/renderer/lib/box.js'
import { rootFrame } from '../packages/dshline/lib/chrome.js'
import { THEMES } from '../packages/dshline/lib/themes/builtin.js'
let frames = 0, streamingLines = 0
for (const palette of THEMES) for (const depth of [0, 4, 8, 24]) {
  const release = api.setPalette(palette, depth)
  const restore = api.setRendererBackend('typescript')
  const options = { columns: 80, context: 'scratch', body: ['ready'], footer: 'esc close' }
  const expectedFrame = rootFrame(options)
  const inputs = ['````', '```', '**literal**', 'x'.repeat(4096), '````', '**bold**']
  const reference = api.createMarkdownRenderer()
  const expected = inputs.map(source => reference.line(source))
  api.setRendererBackend('rust') // A missing addon must fail this acceptance, not skip it.
  try {
    strictEqual(api.displayWidth('中文'), 4)
    deepStrictEqual(rootFrame(options), expectedFrame, `${palette.id}/${depth}`)
    frames++
    const stream = api.createMarkdownRenderer()
    for (let i = 0; i < inputs.length; i++) {
      deepStrictEqual(stream.line(inputs[i]), expected[i], `${palette.id}/${depth}/${i}`)
      streamingLines++
    }
    let reads = 0
    strictEqual(api.frameHeight(['x'.repeat(4096)], { get width() { reads++; return 80 } }), referenceBox.frameHeight(['x'.repeat(4096)], { width: 80 }))
    strictEqual(reads, 1)
    strictEqual(api.escapeControls('x'.repeat(4096)), 'x'.repeat(4096))
    for (const code of [-1, NaN, Infinity, undefined]) strictEqual(api.codePointWidth(code), referenceWidth.codePointWidth(code))
    for (const op of ['chunkToWidth', 'wrapToWidth']) {
      let coerced = 0
      deepStrictEqual(api[op]('abcd', { valueOf() { return ++coerced === 1 ? 1 : 64 } }), ['a', 'b', 'c', 'd'])
      strictEqual(coerced, 1)
    }
  } finally { restore(); release() }
}
const restore = api.setRendererBackend('rust')
try {
  let reads = 0
  const unused = [31]
  Object.defineProperty(unused, '0', { get() { reads++; throw Error('unused parameter must remain unread') } })
  let release = api.setPalette({ id: 'getter', name: '', description: '', depth: 4, roles: { unused: { ansi: unused } } }, 4)
  try { strictEqual(api.renderInline('plain'), 'plain'); strictEqual(reads, 0) } finally { release() }
  const used = [31]
  Object.defineProperty(used, '0', { get() { reads++; return 35 } })
  release = api.setPalette({ id: 'getter-used', name: '', description: '', depth: 4, roles: { strong: { ansi: used } } }, 4)
  try { strictEqual(api.renderInline('**x**'), '\u001b[35mx\u001b[0m'); strictEqual(reads, 1) } finally { release() }
  let iterations = 0
  const iterated = [31]
  iterated[Symbol.iterator] = function* () { iterations++; yield 35 }
  release = api.setPalette({ id: 'iterator', name: '', description: '', depth: 4, roles: { strong: { ansi: iterated } } }, 4)
  try {
    strictEqual(api.renderInline('plain'), 'plain'); strictEqual(iterations, 0)
    strictEqual(api.renderInline('**x**'), '\u001b[35mx\u001b[0m'); strictEqual(iterations, 1)
  } finally { release() }
  strictEqual(api.createMarkdownRenderer().partial('**x**', 0), '**x**')
  strictEqual(api.createMarkdownRenderer().partial('**x**', 1), '\u001b[1mx\u001b[0m')
  const options = new Proxy({ width: 8 }, { getPrototypeOf() { throw Error('must not inspect host prototype') } })
  deepStrictEqual(api.frame(['x'], options), referenceBox.frame(['x'], options))
  const rows = new Proxy(['x'], { getPrototypeOf() { throw Error('must not inspect array proxy') } })
  deepStrictEqual(api.frame(rows, { width: 8 }), referenceBox.frame(rows, { width: 8 }))
} finally { restore() }
process.stdout.write(JSON.stringify({ palettes: THEMES.length, frames, streamingLines, compiledPackageResolution: true }) + '\n')

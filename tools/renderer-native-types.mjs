/** Turn napi-rs compiler metadata into the dependency-free addon's declarations. */
import { readFile, writeFile } from 'node:fs/promises'
const [metadata, output] = process.argv.slice(2)
if (!metadata || process.argv.length < 3 || process.argv.length > 4) throw new Error('usage: node tools/renderer-native-types.mjs <napi-type-metadata> [output.d.ts]')
const definitions = (await readFile(metadata, 'utf8')).trim().split('\n').map(JSON.parse)
const names = ['unicodeVersion', 'execute', 'displayWidth', 'codePointWidth', 'stripAnsi', 'escapeControls', 'sanitizePasted', 'truncateToWidth', 'tailToWidth', 'fitToWidth', 'chunkToWidth', 'wrapToWidth']
if (definitions.length !== names.length || new Set(definitions.map(value => value.name)).size !== names.length || definitions.some(value => value.kind !== 'fn' || !names.includes(value.name))) throw new Error('unexpected napi exports')
await writeFile(output ?? new URL('../packages/renderer/native/index.d.ts', import.meta.url), '// Generated from napi-rs type metadata; do not edit.\n' + definitions.map(value => value.js_doc + 'export ' + value.def + ';\n').join(''))

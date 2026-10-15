/** Exact data copy, never substitute a crate's Unicode/grapheme policy. */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const source = readFileSync(new URL('../../packages/renderer/src/width-tables.ts', import.meta.url), 'utf8')
if (process.versions.unicode !== '17.0') throw new Error('Use a Node build with Unicode 17.0 to match the TypeScript reference properties')
let out = '// Exact project Unicode 17 data; generated from width-tables.ts.\n// Unicode data copyright Unicode, Inc.; https://www.unicode.org/license.txt\n'
for (const name of ['WIDE_RANGES', 'ZERO_WIDTH_RANGES']) {
  const body = source.split(`export const ${name}`)[1].split('= [')[1].split('\n]')[0]
  const ranges = [...body.matchAll(/\[\s*(0x[0-9a-f]+|\d+)\s*,\s*(0x[0-9a-f]+|\d+)\s*\]/gu)]
  out += `pub const ${name}: &[(u32,u32)] = &[\n${ranges.map(([,a,b])=>`(${a},${b}),`).join('\n')}\n];\n`
}
const ranges = []; let start = -1, last = -1
for (let code = 0; code <= 0x10ffff; code++) {
  if (/[\p{L}\p{N}]/u.test(String.fromCodePoint(code))) { if (start < 0) start = code; last = code }
  else if (start >= 0) { ranges.push([start,last]); start = -1 }
}
if (start >= 0) ranges.push([start,last])
out += `// JS Unicode L/N properties from Node ${process.version}, Unicode ${process.versions.unicode}.\npub const WORD_RANGES: &[(u32,u32)] = &[\n${ranges.map(([a,b])=>`(${a},${b}),`).join('\n')}\n];\n`
writeFileSync(fileURLToPath(new URL('src/tables.rs', import.meta.url)), out)

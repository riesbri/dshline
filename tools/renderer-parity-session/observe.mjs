import { registerHooks } from 'node:module'
import { appendFileSync } from 'node:fs'
let count = 0
globalThis.__rendererObservedInput = input => {
  if (count >= 128 || !process.env.RENDERER_OBSERVED_OUTPUT) return
  if (typeof input.text !== 'string' || input.text.length > 150) return
  appendFileSync(process.env.RENDERER_OBSERVED_OUTPUT, JSON.stringify(input) + '\n')
  count++
}
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url.endsWith('/renderer/lib/width.js')) {
      const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
      result.source = source.replace(/export function (wrapToWidth|chunkToWidth|truncateToWidth|tailToWidth)\(text, columns\) \{/gu,
        (declaration, op) => declaration + `\n globalThis.__rendererObservedInput?.({op: '${op}', text, columns});`)
    }
    return result
  },
})

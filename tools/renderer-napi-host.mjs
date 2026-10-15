/** Same differential host, real in-process addon transport instead of the Rust CLI. */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runRustHost } from './renderer-rust-host.mjs'
const require = createRequire(import.meta.url)
export function runNapiHost(value) {
  const addon = require(`../packages/renderer/native/${process.platform}-${process.arch}.node`)
  return runRustHost(value, undefined, request => addon.execute(request))
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw Object.assign(new Error(), { code: 'INVALID_INPUT' })
    const chunks = []
    let bytes = 0
    for await (const chunk of process.stdin) {
      bytes += chunk.length
      if (bytes > 1_048_576) throw Object.assign(new Error(), { code: 'RESOURCE_LIMIT' })
      chunks.push(chunk)
    }
    let value
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
    catch { throw Object.assign(new Error(), { code: 'INVALID_INPUT' }) }
    process.stdout.write(JSON.stringify(await runNapiHost(value)) + '\n')
  } catch (error) {
    const resource = error?.issues?.some(issue => issue.code === 'too_big' || issue.message.includes('RESOURCE_LIMIT'))
    const code = ['INVALID_INPUT', 'RESOURCE_LIMIT', 'BACKEND_FAILURE'].includes(error?.code) ? error.code : error?.issues ? (resource ? 'RESOURCE_LIMIT' : 'INVALID_INPUT') : 'BACKEND_FAILURE'
    process.stdout.write(JSON.stringify({ ok: false, error: { code, fallbackEligible: false } }) + '\n')
  }
}

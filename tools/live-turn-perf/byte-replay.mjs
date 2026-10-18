/** Matched, quota-free Screen replay from full-paint historical stock captures.
 * Reconstructed prewrapped rows, not original logical lines or scheduler replay. */
import { createReadStream, readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { createInterface } from 'node:readline'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import headless from '@xterm/headless'
const { Terminal } = headless
const [dataset, stock, candidate, output] = process.argv.slice(2).map(value => resolve(value))
const scratch = mkdtempSync(join(tmpdir(), 'byte-replay-'))
execFileSync('tar', ['-xzf', join(dataset, 'pty.tar.gz'), '-C', scratch])
const classes = await Promise.all([stock,candidate].map(root => import(pathToFileURL(join(root,'packages/renderer/lib/screen.js')))))
const records=[];const counts={}
for await (const line of createInterface({ input:createReadStream(join(dataset,'raw.jsonl.gz')).pipe(createGunzip()) })) {
 const d=JSON.parse(line)
 if(d.warmup||d.arm!=='stock'||(counts[d.workload]??0)>=2)continue
 records.push(d);counts[d.workload]=(counts[d.workload]??0)+1
}
function snapshot(term) {
 const b=term.buffer.active;const hash=createHash('sha256')
 for(let y=0;y<b.length;y++) {
  const line=b.getLine(y);hash.update(JSON.stringify([line.isWrapped]))
  for(let x=0;x<90;x++){const c=line.getCell(x);hash.update(JSON.stringify([c.getChars(),c.getWidth(),c.getFgColorMode(),c.getFgColor(),c.getBgColorMode(),c.getBgColor(),c.isBold(),c.isItalic(),c.isUnderline(),c.isInverse(),c.isDim()]))}
 }
 return JSON.stringify([b.cursorX,b.cursorY,b.baseY,b.viewportY,hash.digest('hex')])
}
const results=[]
for(const d of records){
 const bytes=readFileSync(join(scratch,d.run+'.pty'));const terms=[0,1].map(()=>new Terminal({cols:90,rows:24,scrollback:10000,allowProposedApi:true}))
 const sinks=[[],[]],totals=[0,0],commits=[0,0];const screens=classes.map((m,i)=>new m.Screen({columns:()=>90,write:s=>{sinks[i].push(s);totals[i]+=Buffer.byteLength(s)}}))
 let previous,operations=0
 for(const call of d.result.screens){
  const [method,,,start,end,,height]=call;let lines,cursor
  if(start===end){if(method!=='setLive'||!previous)continue;({lines,cursor}=previous)}
  else {
   let body=bytes.subarray(start,end).toString();const END='\x1b[?2026l',SHOW='\x1b[?25h'
   if(!body.endsWith(END))throw Error('missing sync tail');body=body.slice(0,-END.length)
   if(body.endsWith(SHOW)){
    body=body.slice(0,-SHOW.length);const m=body.match(/(?:\x1b\[(\d+)A)?\r(?:\x1b\[(\d+)C)?$/)
    if(!m)throw Error('cursor suffix');cursor={row:Math.max(0,height-1)-Number(m[1]??0),column:Number(m[2]??0)};body=body.slice(0,m.index)
   }
   const segments=body.split('\x1b[0K').slice(1).map(s=>s.endsWith('\r\n')?s.slice(0,-2):s)
   if(segments.some(s=>/\x1b\[(?:\d*[ABCDHJ]|\?)/.test(s)))throw Error('unparsed movement')
   if(method==='setLive'){if(segments.length!==height)throw Error('height');lines=segments;previous={lines,cursor}}
   else lines=segments.slice(0,segments.length-height)
  }
  for(let i=0;i<2;i++){
   const before=totals[i];screens[i][method](lines,cursor);if(method==='commit')commits[i]+=totals[i]-before
   const data=sinks[i].join('');sinks[i]=[];if(data)await new Promise(done=>terms[i].write(data,done))
  }
  if(snapshot(terms[0])!==snapshot(terms[1]))throw Error(`cell/style/wrap/cursor mismatch ${d.run} ${operations}`)
  operations++
 }
 terms.forEach(t=>t.dispose());results.push({run:d.run,workload:d.workload,operations,bytes:{stock:totals[0],candidate:totals[1]},commitBytes:{stock:commits[0],candidate:commits[1]}})
 console.log(JSON.stringify(results.at(-1)))
}
const hashes=Object.fromEntries([['stock',stock],['candidate',candidate]].map(([arm,root])=>[arm,createHash('sha256').update(readFileSync(join(root,'packages/renderer/lib/screen.js'))).digest('hex')]))
writeFileSync(output,JSON.stringify({endpoint:'Unpaced reconstructed prewrapped Screen operations; full buffer cells/styles/wrap flags and cursor after each call. Not original logical lines, PTY transport, provider or latency evidence.',sourceScreenSha256:hashes,results},null,2)+'\n')

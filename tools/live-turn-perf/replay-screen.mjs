/** Local-only matched Screen-stage replay reconstructed from saved stock PTY output.
 * Not a scheduler, provider, paced-PTY or original logical-line replay. */
import { readFileSync, writeFileSync, mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
const require = createRequire(resolve('package.json'));
const { Terminal } = require('@xterm/headless');
const root=resolve(process.argv[2]);
const metadata=JSON.parse(readFileSync(join(root,'metadata.json')));
const scratch=mkdtempSync(join(tmpdir(),'screen-frozen-replay-'));
execFileSync('tar',['-xzf',join(root,'pty.tar.gz'),'-C',scratch]);
const records=gunzipSync(readFileSync(join(root,'raw.jsonl.gz'))).toString().trim().split('\n').map(JSON.parse).filter(d=>!d.warmup&&d.workload==='cjk'&&d.arm==='stock');
const sourceHashes={}; const classes={};
for(const arm of ['stock','candidate']) {
 const lib=join(metadata.arms[arm].root,'packages/renderer/lib');
 const dir=join(scratch,arm);cpSync(lib,dir,{recursive:true});
 writeFileSync(join(dir,'package.json'),'{"type":"module"}');
 const source=readFileSync(join(dir,'screen.js'),'utf8');
 sourceHashes[arm]=createHash('sha256').update(source).digest('hex');
 const variants=arm==='stock'?['stock']:['candidate','noCache','fullRedraw','splitSink'];
 for(const name of variants) {
  let text=source;
  if(name==='noCache')text=text.replace('(columns === this.liveColumns ? this.liveWraps.get(line) : undefined)','undefined').replace('?? wraps.get(line) ?? wrapToWidth(line, columns)','?? wrapToWidth(line, columns)');
  if(name==='fullRedraw')text=text.replace('const stable = this.current && columns === this.liveColumns && rows.length === this.liveRows.length;','const stable = false;');
  if(name==='noCache'&&text===source || name==='fullRedraw'&&text===source)throw Error('ablation did not apply');
  text=text.replace("import { wrapToWidth } from './width.js';", "import { wrapToWidth as originalWrap } from './width.js';\nexport let wrapCalls=0; export function resetWrapCalls(){wrapCalls=0;} function wrapToWidth(...args){wrapCalls++;return originalWrap(...args);}");
  const file=join(dir,`replay-${name}.js`);writeFileSync(file,text);classes[name]=await import(pathToFileURL(file));
 }
}
const END='\x1b[?2026l', SHOW='\x1b[?25h';
const sequences=[];
for(const d of records) {
 const bytes=readFileSync(join(scratch,d.run+'.pty'));const operations=[];let previous;
 for(const call of d.result.screens) {
  const [method,, ,start,end,,height]=call;
  if(start===end) {if(method==='setLive'&&previous)operations.push({method,lines:previous.lines,cursor:previous.cursor});continue;}
  let body=bytes.subarray(start,end).toString('utf8');
  if(!body.endsWith(END))throw Error('missing sync end');body=body.slice(0,-END.length);
  const visible=body.endsWith(SHOW);if(visible)body=body.slice(0,-SHOW.length);
  let cursor;
  if(visible) {
   const match=body.match(/(?:\x1b\[(\d+)A)?\r(?:\x1b\[(\d+)C)?$/);
   if(!match)throw Error('cursor suffix');
   cursor={row:Math.max(0,height-1)-Number(match[1]??0),column:Number(match[2]??0)};
   body=body.slice(0,match.index);
  }
  const segments=body.split('\x1b[0K').slice(1).map(s=>s.endsWith('\r\n')?s.slice(0,-2):s);
  if(segments.some(s=>/\x1b\[(?:\d*[ABCDHJ]|\?)/.test(s)))throw Error('unparsed screen movement');
  if(method==='setLive') {
   if(segments.length!==height)throw Error(`height mismatch ${d.run} ${segments.length} ${height}`);
   previous={method,lines:segments,cursor};operations.push(previous);
  } else {
   const committed=segments.slice(0,segments.length-height);
   if(!committed.length)throw Error('empty reconstructed commit');
   operations.push({method:'commit',lines:committed});
  }
 }
 sequences.push({run:d.run,operations});
}
function q(xs,p){xs=[...xs].sort((a,b)=>a-b);const k=(xs.length-1)*p,i=Math.floor(k);return xs[i]+(xs[Math.ceil(k)]-xs[i])*(k-i);}
function stats(xs){const mean=xs.reduce((a,b)=>a+b,0)/xs.length;return {n:xs.length,median:q(xs,.5),p95:q(xs,.95),p99:q(xs,.99),sd:Math.sqrt(xs.reduce((a,b)=>a+(b-mean)**2,0)/(xs.length-1)),min:Math.min(...xs),max:Math.max(...xs)};}
function snapshot(term) {
 const b=term.buffer.active;const rows=[];
 for(let y=0;y<b.length;y++) {const line=b.getLine(y);let cells='';for(let x=0;x<90;x++){const c=line.getCell(x);cells+=JSON.stringify([c.getChars(),c.getWidth(),c.getFgColorMode(),c.getFgColor(),c.getBgColorMode(),c.getBgColor(),c.isBold(),c.isItalic(),c.isUnderline(),c.isInverse()]);}rows.push(cells);}
 return JSON.stringify([b.cursorX,b.cursorY,b.baseY,b.viewportY,rows]);
}
// Semantic gate: identical emulator state after every reconstructed operation.
let comparisons=0;
for(const seq of sequences) {
 const ts=['stock','candidate'].map(()=>new Terminal({cols:90,rows:24,scrollback:10000,allowProposedApi:true}));
 const sinks=[[],[]];const screens=['stock','candidate'].map((name,i)=>new classes[name].Screen({columns:()=>90,write:s=>sinks[i].push(s)}));
 for(const op of seq.operations) {
  for(let i=0;i<2;i++){screens[i][op.method](op.lines,op.cursor);const out=sinks[i].join('');sinks[i]=[];if(out)await new Promise(done=>ts[i].write(out,done));}
  if(snapshot(ts[0])!==snapshot(ts[1]))throw Error(`emulator mismatch ${seq.run} operation ${comparisons}`);
  comparisons++;
 }
 ts.forEach(t=>t.dispose());
}
console.log(JSON.stringify({semanticComparisons:comparisons,sequences:sequences.length}));
function run(seq,name,pass) {
 const module=classes[name];module.resetWrapCalls();const hash=createHash('sha256');let bytes=0,writes=0;
 function sink(s){const b=Buffer.from(s);hash.update(b);bytes+=b.length;writes++;}
 const screen=new module.Screen({columns:()=>90,write:s=>{if(name==='splitSink'){for(let i=0;i<s.length;i+=128)sink(s.slice(i,i+128));}else sink(s);}});
 const stable=[],changed=[],commits=[];let total=0;
 for(const op of seq.operations){const before=screen.height,t=performance.now();screen[op.method](op.lines,op.cursor);const dt=performance.now()-t;total+=dt;(op.method==='commit'?commits:before===screen.height?stable:changed).push(dt);}
 return {run:seq.run,arm:name,pass,totalMs:total,stableMs:stable.reduce((a,b)=>a+b,0),changedMs:changed.reduce((a,b)=>a+b,0),commitMs:commits.reduce((a,b)=>a+b,0),stableN:stable.length,changedN:changed.length,wrapCalls:module.wrapCalls,bytes,writes,hash:hash.digest('hex')};
}
const names=Object.keys(classes);for(const name of names)for(const seq of sequences.slice(0,3))run(seq,name,-1);
const samples=[];
for(let pass=0;pass<4;pass++)for(let i=0;i<sequences.length;i++){const order=(i+pass)%2?[...names].reverse():names;for(const name of order)samples.push(run(sequences[i],name,pass));}
const summary={};for(const name of names){const own=samples.filter(s=>s.arm===name);summary[name]=Object.fromEntries(['totalMs','stableMs','changedMs','commitMs','wrapCalls','bytes','writes'].map(k=>[k,stats(own.map(s=>s[k]))]));}
const result={endpoint:'Unpaced Screen-stage CPU plus hash sink only; reconstructed prewrapped stock frames, not original logical arguments, live calls, production scheduler, PTY transport, or physical paint',sourceHashes,sequences:sequences.length,semanticComparisons:comparisons,passes:4,variants:{noCache:'Disable previous-frame and intra-frame wrap reuse; keep map construction and other work',fullRedraw:'Disable row damage; retain cache and identical-frame skip',splitSink:'Split candidate sink strings into 128 UTF-16-code-unit hash writes; sink-overhead sensitivity only, not a production batching alternative'},summary,samples};
writeFileSync(join(root,'screen-replay.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(summary));

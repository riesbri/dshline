/** Verify actual composer cells at the producing offset retained by each probe. */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(resolve('package.json'));
const { Terminal } = require('@xterm/headless');
const root = resolve(process.argv[2]);
const checks = [];
const { gunzipSync } = await import('node:zlib');
const { execFileSync } = await import('node:child_process');
const records = existsSync(join(root,'raw.jsonl.gz'))
  ? gunzipSync(readFileSync(join(root,'raw.jsonl.gz'))).toString().trim().split('\n').map(JSON.parse)
  : readdirSync(root).filter(name => /-(stock|candidate)(-warmup)?\.json$/.test(name)).map(file => JSON.parse(readFileSync(join(root,file))));
for (const d of records) {
  if (d.failure || d.interruptProbe) continue;
  const echo = d.result.echoes?.[0];
  if (!echo) throw Error(`missing echo: ${d.run}`);
  const bytes = existsSync(join(root, `${d.run}.pty`)) ? readFileSync(join(root, `${d.run}.pty`)) : execFileSync('tar',['-xOf',join(root,'pty.tar.gz'),`${d.run}.pty`],{maxBuffer:64*1024*1024});
  const term = new Terminal({ cols:90, rows:24, scrollback:10000, allowProposedApi:true });
  await new Promise(done => term.write(bytes.subarray(0, echo[1]), done));
  const b = term.buffer.active;
  const visible = Array.from({length:24}, (_, i) => b.getLine(b.baseY+i)?.translateToString(true) ?? '');
  const row = visible.findIndex(line => line.includes('UXPROBE304'));
  if (row < 0) throw Error(`marker not visible: ${d.run}`);
  const end = visible[row].indexOf('UXPROBE304') + 'UXPROBE304'.length;
  if (b.cursorY !== row || b.cursorX !== end) throw Error(`composer cursor mismatch: ${d.run} ${b.cursorX},${b.cursorY}; expected ${end},${row}`);
  await new Promise(done => term.write(bytes.subarray(echo[1]), done));
  const final = term.buffer.active;
  for (let i=0; i<final.baseY; i++) {
    if (final.getLine(i)?.translateToString().includes('UXPROBE304')) throw Error(`unsubmitted marker committed: ${d.run}`);
  }
  checks.push({run:d.run,markerVisible:true,cursor:{x:end,y:row},markerNotCommitted:true});
  term.dispose();
}
writeFileSync(join(root,'input-cell-verification.json'), JSON.stringify(checks,null,2)+'\n');
console.log(JSON.stringify({verified:checks.length,endpoint:'emulator cells at captured producing offset; not real display timing'}));

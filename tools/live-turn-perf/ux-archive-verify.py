#!/usr/bin/env python3
"""Admit archived natural-EOF UX turns, including an explicitly missing attempt."""
import argparse,collections,gzip,hashlib,json,pathlib,tarfile
from verify import verify_record
p=argparse.ArgumentParser();p.add_argument('directory');a=p.parse_args();root=pathlib.Path(a.directory)
records=[json.loads(line) for line in gzip.decompress((root/'raw.jsonl.gz').read_bytes()).decode().splitlines()]
meta=json.loads((root/'metadata.json').read_text());intervention=root/'intervention.json'
expected={w+'/'+arm:meta['samplesPerWorkloadPerArm'] for w in meta['workloads'] for arm in ['stock','candidate']}
if intervention.exists():expected=json.loads(intervention.read_text())['expectedCompleted']
counts=collections.Counter(d['workload']+'/'+d['arm'] for d in records if not d['warmup'])
if counts!=expected:raise ValueError(f'cell counts differ: {counts} != {expected}')
if len({d['run'] for d in records})!=len(records):raise ValueError('duplicate turn IDs')
summary={d['run']:d for d in json.loads((root/'summary.json').read_text())['perTurn']}
with tarfile.open(root/'pty.tar.gz','r:gz') as tar:
 for d in records:
  b=tar.extractfile(d['run']+'.pty').read();verify_record(d,b)
  if not any('UXPROBE304' in x[1] for x in d['result'].get('inputReceipts',[])):raise ValueError('active typing probe missing')
  if not d['result'].get('echoes'):raise ValueError('composer echo missing')
  if d['warmup']:continue
  r=d['result'];points={}
  for axis,spans in [(0,[(s[1],s[1]+s[2]) for s in r['screens']]+[(s[0],s[0]+s[1]) for s in r['compositions']]),(1,[(s[0],s[1]) for s in r['providerCalls'][0]['waits']])]:
   for begin,end in spans:
    points.setdefault(begin,[0,0])[axis]+=1;points.setdefault(end,[0,0])[axis]-=1
  covering=[0,0];previous=min(points);overlap=0
  for t,change in sorted(points.items()):
   if covering==[1,1]:overlap+=t-previous
   covering=[covering[i]+change[i] for i in [0,1]]
   if not all(x in [0,1] for x in covering):raise ValueError('nested attribution spans')
   previous=t
  row=summary[d['run']]
  if abs(overlap-row['providerAwaitRendererOverlapMs'])>1e-4:raise ValueError('overlap attribution mismatch')
  if abs(row['wholeTurnMs']-row['rendererMs']-row['providerAwaitNonRendererMs']-row['residualMs'])>1e-6:raise ValueError('accounting split mismatch')
 # These faults must fail for their intended reason, not merely a parse error.
 d=records[0];b=tar.extractfile(d['run']+'.pty').read();corrupt=bytearray(b);corrupt[len(corrupt)//2]^=1
 for label,changed,body,reason in [('corruptByte',d,corrupt,'hash'),('zeroRenderer',{**d,'result':{**d['result'],'screens':[]}},b,'renderer'),('pipeOnly',{**d,'observer':{**d['observer'],'tty':{**d['observer']['tty'],'input':False}}},b,'PTY')]:
  try:verify_record(changed,body)
  except ValueError as e:
   if reason not in str(e):raise
  else:raise AssertionError(f'{label} was admitted')
report=dict(records=len(records),measured=sum(counts.values()),counts=dict(counts),warmups=sum(d['warmup'] for d in records),exactBytesAndSha256=True,independentAttributionSweep=True,corruptByteRejected=True,zeroRendererRejected=True,pipeOnlyRejected=True)
(root/'verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))

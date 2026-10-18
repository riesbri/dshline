#!/usr/bin/env python3
"""Analyze the bounded UX experiment, with separate interrupted observations."""
import argparse, gzip, hashlib, importlib.util, json, pathlib, statistics, sys, tarfile
# Import the existing accounting implementation without invoking its CLI.
source=pathlib.Path(__file__).with_name('summarize.py').read_text().split("if (root/'raw.jsonl.gz').exists():")[0]
source=source.replace("p=argparse.ArgumentParser();p.add_argument('directory');p.add_argument('--archive',action='store_true');p.add_argument('--exclude-workloads',default='');a=p.parse_args();root=pathlib.Path(a.directory)", '')
ns={};exec(compile(source,'summarize.py','exec'),ns)
from verify import verify_record
p=argparse.ArgumentParser();p.add_argument('directory');p.add_argument('--unpaced',action='store_true');p.add_argument('--interrupt',action='store_true');a=p.parse_args();root=pathlib.Path(a.directory)
archive=None
if (root/'raw.jsonl.gz').exists():
 records=[json.loads(line) for line in gzip.decompress((root/'raw.jsonl.gz').read_bytes()).decode().splitlines()]
 archive=tarfile.open(root/'pty.tar.gz','r:gz')
else:
 records=[json.loads(p.read_text()) for p in sorted(root.glob('*.json')) if '-stock' in p.name or '-candidate' in p.name]
rows=[]
for d in records:
 r=d['result'];b=archive.extractfile(d['run']+'.pty').read() if archive else (root/(d['run']+'.pty')).read_bytes()
 if a.interrupt:
  if d['failure'] or d['exitCode']!=0:raise ValueError('failed interrupt observation')
  if len(b)!=r['totalBytes'] or len(b)!=d['receivedBytes'] or d['receipts'][-1][2]!=len(b) or hashlib.sha256(b).hexdigest()!=r['outputHash'] or d['receivedSha256']!=r['outputHash']:raise ValueError('interrupt transport mismatch')
  if not r.get('cancelCalls') or not r.get('turnEnd') or not r.get('streamEnd'):raise ValueError('interrupt not settled')
  if r.get('toolCalls',0) or len(r['providerCalls'])!=1 or not r['frames'] or not r['screens']:raise ValueError('interrupt path not admitted')
  if d['observer']['tty']!={'input':True,'output':True,'columns':90,'rows':24}:raise ValueError('not a controlling fixed-size PTY')
  received=next(x[0] for x in r['inputReceipts'] if '\x03' in x[1]);cancel=r['cancelCalls'][0][0]
  call=r['providerCalls'][0]
  if call['provider']!='opencode-go' or call['model']!='deepseek-v4.1-flash':raise ValueError('wrong interrupt route')
  if not d['probeSent']<=received<=cancel<=r['turnEnd']:raise ValueError('invalid interrupt chronology')
  if call.get('end') and call['end']<cancel:raise ValueError('interrupt arrived after provider EOF')
  m=dict(sendToProcessMs=received-d['probeSent'],sendToCancelMs=cancel-d['probeSent'],processToCancelMs=cancel-received,sendToSettlementMs=r['turnEnd']-d['probeSent'],sendToDrainMs=d['receipts'][-1][0]-d['probeSent'])
 else:
  verify_record(d,b)
  if d['warmup']:continue
  m=ns['metrics'](d)
  received=next(x[0] for x in r['inputReceipts'] if 'UXPROBE304' in x[1]);echo=r['echoes'][0]
  m['inputDuringMainStream']=int(received<r['providerCalls'][0]['end'])
  receipt=next(x[0] for x in d['receipts'] if x[2]>=echo[1])
  m.update(sendToProcessMs=received-d['probeSent'],processToEchoMs=echo[0]-received,sendToEchoReceiptMs=receipt-d['probeSent'],activeWrites=len(r['writes']),commitBytes=sum(x[4]-x[3] for x in r['screens'] if x[0]=='commit'))
  output=[x for x in r['writes'] if x[0]>=r['firstContent']];gaps=[y[0]-x[0] for x,y in zip(output,output[1:])]
  frames=r['frames'];fgaps=[y[0]-x[0] for x,y in zip(frames,frames[1:])]
  m.update(outputGapP95Ms=ns['quantile'](gaps,.95),frameGapP95Ms=ns['quantile'](fgaps,.95),framesUnder16=sum(x<16 for x in fgaps))
 rows.append(dict(run=d['run'],arm=d['arm'],workload=d['workload'],sample=d['sample'],**m))
summary={}
for w in sorted({d['workload'] for d in rows}):
 summary[w]={}
 for arm in ['stock','candidate']:
  own=[d for d in rows if d['workload']==w and d['arm']==arm]
  summary[w][arm]={k:ns['stats']([d[k] for d in own]) for k in own[0] if k not in ['run','arm','workload','sample']}
report={'endpoint':'Actual PTY probes; interrupt observations separate' if a.interrupt else ('Separately built TS sources, production scheduling, natural EOF turns with unsubmitted typing' if a.unpaced else 'Current TS vs private 16ms trailing scheduler, natural EOF turns with unsubmitted typing'),'workloads':summary,'perTurn':rows,'quantile':'linear (n-1)*p; SD and sample variance; p99 near observed max, not bounded population tail'}
(root/'ux-summary.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({w:{arm:{k:round(s[k]['median'],3) for k in (['sendToCancelMs','sendToSettlementMs'] if a.interrupt else ['wholeTurnMs','rendererMs','bytes','sendToEchoReceiptMs'])} for arm,s in arms.items()} for w,arms in summary.items()},indent=2))

#!/usr/bin/env python3
"""Quota-free, disjoint emitted-byte classes from unchanged admitted archives."""
import argparse, collections, gzip, hashlib, json, pathlib, re, statistics, tarfile, tempfile
from verify import verify_record
p=argparse.ArgumentParser();p.add_argument('dataset');p.add_argument('--output',required=True);a=p.parse_args();root=pathlib.Path(a.dataset)
ansi=re.compile(rb'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))')
runs=re.compile(r'([ ─═])\1{6,}')
def stats(xs):
 xs=sorted(xs);n=len(xs)
 def q(p):
  k=(n-1)*p;i=int(k);return xs[i]+(xs[min(i+1,n-1)]-xs[i])*(k-i)
 return dict(n=n,median=statistics.median(xs),p95=q(.95),p99=q(.99),sd=statistics.stdev(xs) if n>1 else 0,variance=statistics.variance(xs) if n>1 else 0)
def classes(block,prefix,m):
 plain=ansi.sub(b'',block)
 m[prefix+'Printable']+=len(plain.replace(b'\r',b'').replace(b'\n',b''))
 m[prefix+'CrLf']+=plain.count(b'\r')+plain.count(b'\n')
 for x in ansi.findall(block):
  label='Sgr' if x.endswith(b'm') else 'Erase' if x[-1:] in [b'K',b'J'] else 'Sync' if x.startswith(b'\x1b[?2026') else 'CursorOther'
  m[prefix+label]+=len(x)
 # Encoding-only opportunity, not a replay/scheduler prediction. Preserve SGR
 # and both literal endpoints; unknown controls are never changed.
 pieces=[];position=0
 for match in ansi.finditer(block):
  pieces.append(runs.sub(lambda x:x[1]+'\x1b['+str(len(x[0])-2)+'b'+x[1],block[position:match.start()].decode()).encode());pieces.append(match[0]);position=match.end()
 pieces.append(runs.sub(lambda x:x[1]+'\x1b['+str(len(x[0])-2)+'b'+x[1],block[position:].decode()).encode())
 compressed=b''.join(pieces)
 m[prefix+'RepeatedChromeSaving']+=len(block)-len(compressed)
 m[prefix+'RepeatedSpaceSaving']+=sum(len(x[0])-(len(str(len(x[0])-2))+5) for part in ansi.split(block) for x in re.finditer(rb' {7,}',part))
rows=[];manifest={}
with tempfile.TemporaryDirectory(prefix='byte-class-pty-') as scratch:
 with tarfile.open(root/'pty.tar.gz','r|gz') as tar:
  for item in tar:
   if not item.isfile() or pathlib.Path(item.name).name!=item.name or not item.name.endswith('.pty'):raise ValueError('unexpected PTY archive entry')
   pathlib.Path(scratch,item.name).write_bytes(tar.extractfile(item).read())
 for line in gzip.open(root/'raw.jsonl.gz','rt'):
  d=json.loads(line);itemname=d['run']+'.pty'
  if pathlib.Path(itemname).name!=itemname:raise ValueError('invalid record name')
  b=pathlib.Path(scratch,itemname).read_bytes();verify_record(d,b)
  if d['warmup']:continue
  r=d['result'];m=collections.Counter()
  for s in r['screens']:
   method,_,_,begin,end,_,height=s;block=b[begin:end];prefix='commit' if method=='commit' else 'live';m[prefix+'Total']+=len(block);classes(block,prefix,m)
   if method=='commit':
    segments=block.split(b'\x1b[0K')[1:];cut=len(segments)-height
    if cut<1:raise ValueError('commit rows cannot be reconstructed')
    for name,parts in [('commitTranscriptPrintable',segments[:cut]),('commitRepaintPrintable',segments[cut:])]:
     m[name]+=sum(len(ansi.sub(b'',s).replace(b'\r',b'').replace(b'\n',b'')) for s in parts)
  active=sum(w[1] for w in r['writes']);m['activeTotal']=active;m['outsideScreen']=active-m['liveTotal']-m['commitTotal']
  for prefix in ['live','commit']:
   if sum(m[prefix+key] for key in ['Printable','CrLf','Sgr','Erase','Sync','CursorOther'])!=m[prefix+'Total']:raise ValueError('non-disjoint byte partition')
  content=r['assistant']['message']['content'];m['modelTextUtf8']=sum(len(x.get('text','').encode()) for x in content if x['type']=='text');m['modelReasoningUtf8']=sum(len(x.get('text','').encode()) for x in content if x['type']=='reasoning')
  rows.append(dict(run=d['run'],workload=d['workload'],arm=d['arm'],sample=d['sample'],**m));manifest[itemname]=hashlib.sha256(b).hexdigest()
keys=sorted({k for row in rows for k in row}-{ 'run','workload','arm','sample'})
summary={w:{arm:{k:stats([r.get(k,0) for r in rows if r['workload']==w and r['arm']==arm]) for k in keys} for arm in ['stock','candidate']} for w in sorted({r['workload'] for r in rows})}
report=dict(endpoint='Frozen producing bytes; disjoint per-method classes. Model UTF-8 is an independent denominator, not a subset of emitted bytes. RepeatedChromeSaving is encoding-only opportunity, not scheduler replay or live prediction.',quantiles='linear (n-1)p; sample SD/variance; medians of components need not sum',summary=summary,perTurn=rows,inputPtySha256=manifest,inputArchiveSha256={name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in ['raw.jsonl.gz','pty.tar.gz']})
pathlib.Path(a.output).write_text(json.dumps(report,indent=2)+'\n')
for w,arms in summary.items():
 for arm,s in arms.items():print(w,arm,{k:round(s[k]['median']) for k in ['activeTotal','commitTotal','commitTranscriptPrintable','commitRepaintPrintable','livePrintable','liveSgr','commitSgr','liveRepeatedChromeSaving','commitRepeatedChromeSaving']},flush=True)

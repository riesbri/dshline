#!/usr/bin/env python3
"""Exact avoided literal bytes within each candidate's actual output, not a replay."""
import argparse,collections,gzip,hashlib,json,pathlib,re,statistics,tarfile,tempfile
from verify import verify_record
p=argparse.ArgumentParser();p.add_argument('directory');a=p.parse_args();root=pathlib.Path(a.directory)
rep=re.compile(rb' \x1b\[(\d+)b ')
rows=[]
with tempfile.TemporaryDirectory(prefix='padding-effect-') as scratch:
 with tarfile.open(root/'pty.tar.gz','r|gz') as tar:
  for member in tar:
   if not member.isfile() or pathlib.Path(member.name).name!=member.name or not member.name.endswith('.pty'):raise ValueError('unexpected archive member')
   pathlib.Path(scratch,member.name).write_bytes(tar.extractfile(member).read())
 for line in gzip.open(root/'raw.jsonl.gz','rt'):
  d=json.loads(line)
  if d['warmup']:continue
  name=d['run']+'.pty'
  if pathlib.Path(name).name!=name:raise ValueError('invalid capture name')
  b=pathlib.Path(scratch,name).read_bytes();verify_record(d,b);m=collections.Counter()
  for method,_,_,begin,end,*rest in d['result']['screens']:
   block=b[begin:end];expanded=rep.sub(lambda x:b' '*(int(x[1])+2),block)
   allrep=list(re.finditer(rb'\x1b\[[0-9]*b',block))
   if len(allrep)!=len(rep.findall(block)):raise ValueError('REP without literal space endpoints')
   if d['arm']=='stock' and allrep:raise ValueError('unexpected baseline REP')
   avoided=len(expanded)-len(block)
   if avoided<0:raise ValueError('encoding expanded rather than reduced bytes')
   m[method+'BytesAvoided']+=avoided;m[method+'RepSequences']+=len(allrep)
  actual=sum(x[1] for x in d['result']['writes']);avoided=m['commitBytesAvoided']+m['setLiveBytesAvoided']
  m.update(emittedBytes=actual,paddingBytesAvoided=avoided,literalEquivalentBytes=actual+avoided,avoidedFraction=avoided/(actual+avoided))
  rows.append(dict(run=d['run'],arm=d['arm'],workload=d['workload'],sample=d['sample'],**m))
def stats(xs):
 xs=sorted(xs)
 def q(p):
  k=(len(xs)-1)*p;i=int(k);return xs[i]+(xs[min(i+1,len(xs)-1)]-xs[i])*(k-i)
 return dict(n=len(xs),median=statistics.median(xs),p95=q(.95),p99=q(.99),sd=statistics.stdev(xs),variance=statistics.variance(xs))
keys=sorted({k for r in rows for k in r}-{'run','arm','workload','sample'})
summary={w:{arm:{k:stats([r.get(k,0) for r in rows if r['workload']==w and r['arm']==arm]) for k in keys} for arm in ['stock','candidate']} for w in sorted({r['workload'] for r in rows})}
report=dict(endpoint='Exact bytes avoided by valid ASCII-space REP in each actual Screen write. Literal-equivalent expands only that encoding, retaining all captured operations. Not a rerun, scheduler replay, timing or cross-arm output-equality claim.',quantiles='linear (n-1)p; sample SD/variance',workloads=summary,perTurn=rows,archiveSha256={name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in ['raw.jsonl.gz','pty.tar.gz']})
(root/'padding-effect.json').write_text(json.dumps(report,indent=2)+'\n')
for w,arms in summary.items():print(w,{k:arms['candidate'][k]['median'] for k in ['paddingBytesAvoided','commitBytesAvoided','setLiveBytesAvoided','avoidedFraction']})

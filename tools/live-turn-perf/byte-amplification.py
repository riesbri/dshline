#!/usr/bin/env python3
"""Quota-free audit of frozen live writes. No mutation of input captures."""
import argparse, collections, gzip, hashlib, json, pathlib, statistics, tarfile
from verify import verify_record
p=argparse.ArgumentParser();p.add_argument('dataset');p.add_argument('--output',required=True);a=p.parse_args();root=pathlib.Path(a.dataset)
def stats(xs):
 xs=sorted(xs);n=len(xs);q=lambda p:xs[int((n-1)*p)]+(xs[min(int((n-1)*p)+1,n-1)]-xs[int((n-1)*p)])*((n-1)*p%1)
 return dict(n=n,median=statistics.median(xs),p95=q(.95),p99=q(.99),mean=statistics.mean(xs),sd=statistics.stdev(xs) if n>1 else 0,variance=statistics.variance(xs) if n>1 else 0)
rows=[];manifest={}
if (root/'raw.jsonl.gz').exists():
 records=[json.loads(line) for line in gzip.decompress((root/'raw.jsonl.gz').read_bytes()).decode().splitlines()]
 archive=tarfile.open(root/'pty.tar.gz','r:gz')
else:
 records=[json.loads(path.read_text()) for path in sorted(root.glob('*.json'))]
 archive=None
for d in records:
 if not isinstance(d,dict) or 'run' not in d or d.get('warmup'):continue
 b=archive.extractfile(d['run']+'.pty').read() if archive else (root/(d['run']+'.pty')).read_bytes();verify_record(d,b);r=d['result'];manifest[d['run']+'.json.canonical']=hashlib.sha256(json.dumps(d,sort_keys=True,separators=(',',':')).encode()).hexdigest();manifest[d['run']+'.pty']=hashlib.sha256(b).hexdigest()
 writes=r['writes'];screens=r['screens'];content=r['assistant']['message']['content'];text=sum(len(x.get('text','').encode()) for x in content if x['type']=='text');reasoning=sum(len(x.get('text','').encode()) for x in content if x['type']=='reasoning')
 m=dict(activeBytes=sum(x[1] for x in writes),activeWrites=len(writes),positiveWrites=sum(x[1]>0 for x in writes),textUtf8Bytes=text,reasoningUtf8Bytes=reasoning,screenCalls=len(screens),commitBytes=sum(x[4]-x[3] for x in screens if x[0]=='commit'),setLiveBytes=sum(x[4]-x[3] for x in screens if x[0]=='setLive'))
 m['bytesPerTextByte']=m['activeBytes']/text;m['bytesPerContentByte']=m['activeBytes']/(text+reasoning)
 # Fixed-rate trailing bucket opportunity model: preserve commits, keep only
 # the last setLive in a bucket. This is not a valid ANSI replay or a scheduler.
 live=[x for x in screens if x[0]=='setLive'];groups=collections.defaultdict(list)
 for x in live:groups[int((x[1]-d['submitted'])//16)].append(x)
 m['bucket16SetLiveCalls']=len(groups);m['bucket16RemovableCalls']=len(live)-len(groups)
 m['bucket16RemovedObservedBytes']=sum(x[4]-x[3] for group in groups.values() for x in group[:-1]);m['bucket16RemovedByteFraction']=m['bucket16RemovedObservedBytes']/m['activeBytes']
 frames=r['frames'];m['frameGapsUnder16']=sum(y[0]-x[0]<16 for x,y in zip(frames,frames[1:]));m['frameGaps']=max(0,len(frames)-1)
 rows.append(dict(run=d['run'],workload=d['workload'],arm=d['arm'],sample=d['sample'],**m))
summary={}
for w in sorted({d['workload'] for d in rows}):
 summary[w]={}
 for arm in ['stock','candidate']:
  own=[d for d in rows if d['workload']==w and d['arm']==arm];summary[w][arm]={k:stats([d[k] for d in own]) for k in own[0] if k not in ['run','workload','arm','sample']}
report=dict(endpoint='Frozen live producing writes, PTY hash validated; bucket model only, not paced scheduler replay',styled='Exploratory audit of abandoned workload; not revived confirmatory evidence',quantiles='linear (n-1)*p; small n p99 near maximum',summary=summary,perTurn=rows,inputSha256=manifest,archiveSha256={name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in ['raw.jsonl.gz','pty.tar.gz'] if (root/name).exists()})
pathlib.Path(a.output).write_text(json.dumps(report,indent=2)+'\n')
for w,arms in summary.items():
 for arm,s in arms.items():print(w,arm,json.dumps({k:round(s[k]['median'],3) for k in ['activeBytes','activeWrites','bytesPerTextByte','bytesPerContentByte','commitBytes','setLiveBytes','bucket16RemovableCalls','bucket16RemovedByteFraction']}),'n',s['activeBytes']['n'])

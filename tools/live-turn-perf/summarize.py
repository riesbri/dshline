#!/usr/bin/env python3
"""Recompute descriptive per-turn statistics; do not imply causal turn gains."""
import argparse, gzip, hashlib, io, json, math, pathlib, statistics, tarfile
p=argparse.ArgumentParser();p.add_argument('directory');p.add_argument('--archive',action='store_true');a=p.parse_args();root=pathlib.Path(a.directory)

def quantile(xs,p):
 xs=sorted(xs); x=(len(xs)-1)*p; lo=math.floor(x); hi=math.ceil(x)
 return xs[lo]+(xs[hi]-xs[lo])*(x-lo)
def stats(xs):
 return {'n':len(xs),'median':statistics.median(xs),'p95':quantile(xs,.95),'p99':quantile(xs,.99),'mean':statistics.mean(xs),'sd':statistics.stdev(xs) if len(xs)>1 else 0,'variance':statistics.variance(xs) if len(xs)>1 else 0,'min':min(xs),'max':max(xs)}

def intersection_ms(left, right):
 # Both families contain disjoint intervals. Linear sweep avoids quadratic
 # work on genuine streams with thousands of chunks/redraws.
 left=sorted(left);right=sorted(right);i=j=0;total=0
 while i<len(left) and j<len(right):
  a,b=left[i];c,d=right[j]
  total+=max(0,min(b,d)-max(a,c))
  if b<=d:i+=1
  else:j+=1
 return total

def metrics(d):
 r=d['result']; call=r['providerCalls'][0]; final=d['receipts'][-1][0]
 screen=[(x[1],x[1]+x[2]) for x in r['screens']]
 compose=[(x[0],x[0]+x[1]) for x in r['compositions']]
 render=screen+compose
 firstContent=next(c[0] for c in r['chunks'] if c[1] in ['text-delta','reasoning-delta'] and c[2]>0)
 first=next(x for x in r['screens'] if x[1]>=firstContent and x[4]>x[3])
 firstReceipt=next(x[0] for x in d['receipts'] if x[2]>=first[4])
 renderer=sum(end-start for start,end in render)
 awaitMs=sum(x[1]-x[0] for x in call['waits'])
 overlap=intersection_ms(render,[(w[0],w[1]) for w in call['waits']])
 whole=final-d['submitted']
 # These form a disjoint accounting split, NOT a pure network timing split.
 nonRenderAwait=awaitMs-overlap
 content=r['assistant']['message']['content']
 extra={}
 if r.get('redrawRequests'):
  firstFeedback=next((x for x in r['screens'] if x[4]>x[3]),None)
  if firstFeedback:
   extra['timeToFirstFeedbackMs']=next(x[0] for x in d['receipts'] if x[2]>=firstFeedback[4])-d['submitted']
  # Chunk-to-first subsequent complete Screen output. This is output eligibility,
  # not proof that every delta is visible (an emulator check owns that claim).
  eligible=[x for x in r['screens'] if x[4]>x[3]]
  lags=[];j=0
  for chunk in r['chunks']:
   if chunk[1] not in ['text-delta','reasoning-delta'] or not chunk[2]:continue
   while j<len(eligible) and eligible[j][1]<chunk[0]:j+=1
   if j<len(eligible):lags.append(eligible[j][1]-chunk[0])
  if lags:extra.update(chunkToScreenP95Ms=quantile(lags,.95),chunkToScreenP99Ms=quantile(lags,.99),chunkToScreenMaxMs=max(lags))
 if r.get('screens') and len(r['screens'][0])>=7:
  stable=[x[2] for x in r['screens'] if x[0]=='setLive' and x[5]==x[6]]
  resized=[x[2] for x in r['screens'] if x[0]=='setLive' and x[5]!=x[6]]
  extra.update(stableHeightCalls=len(stable),changedHeightCalls=len(resized),changedHeightScreenMs=sum(resized),stableHeightScreenMs=sum(stable))
 if r.get('auxiliaryCalls'):
  titles=[c for c in r['auxiliaryCalls'] if c['purpose']=='session-title']
  extra.update(titleCalls=len(titles),titleCompleted=sum('end' in c for c in titles),titleObservedSpanMs=sum(min(c.get('end',final),final)-max(c['start'],d['submitted']) for c in titles))
 return {**extra,'wholeTurnMs':whole,'firstContentPaintToDrainMs':final-firstReceipt,'timeToFirstContentPaintMs':firstReceipt-d['submitted'],'providerCallSpanMs':call['end']-call['start'],'providerAwaitMs':awaitMs,'providerAwaitNonRendererMs':nonRenderAwait,'providerAwaitRendererOverlapMs':overlap,'screenMs':sum(e-s for s,e in screen),'composeMs':sum(e-s for s,e in compose),'rendererMs':renderer,'residualMs':whole-renderer-nonRenderAwait,'screenMsPerCall':sum(e-s for s,e in screen)/len(screen),'frameP95Ms':quantile([x[1] for x in r['frames']],.95),'frameP99Ms':quantile([x[1] for x in r['frames']],.99),'renderCalls':len(screen),'frames':len(r['frames']),'chunks':len(r['chunks']),'outputCharacters':sum(len(x.get('text','')) for x in content if x['type']=='text'),'reasoningCharacters':sum(len(x.get('text','')) for x in content if x['type']=='reasoning'),'bytes':sum(x[1] for x in r['writes']),'cpuMs':sum(r['cpu'].values())/1000,'inputTokens':r['assistant'].get('usage',{}).get('inputTokens',0),'outputTokens':r['assistant'].get('usage',{}).get('outputTokens',0),'cacheReadTokens':r['assistant'].get('usage',{}).get('cacheReadTokens',0)}

if (root/'raw.jsonl.gz').exists():
 with gzip.open(root/'raw.jsonl.gz','rt') as f: records=[json.loads(line) for line in f]
else:
 files=sorted(root.glob('*warmup.json'))+sorted(p for p in root.glob('*.json') if ('-stock' in p.name or '-candidate' in p.name) and not p.name.endswith('warmup.json'))
 records=[json.loads(f.read_text()) for f in files]
measured=[d for d in records if not d['warmup'] and not d['failure']]
summary={'quantile':'linear interpolation (n-1)*p; per-turn distribution, not batch averages','warmups':sum(d['warmup'] for d in records),'failures':[{'run':d['run'],'failure':d['failure']} for d in records if d['failure']],'workloads':{},'perTurn':[]}
for workload in sorted({d['workload'] for d in measured}):
 byarm={arm:[metrics(d) for d in measured if d['workload']==workload and d['arm']==arm] for arm in ['stock','candidate']}
 summary['workloads'][workload]={arm:{metric:stats([row[metric] for row in rows]) for metric in rows[0]} for arm,rows in byarm.items() if rows}
 for arm in byarm:
  own=[d['result'] for d in measured if d['workload']==workload and d['arm']==arm]
  if own:
   summary['workloads'][workload][arm]['pooledScreenCallMs']=stats([s[2] for r in own for s in r['screens']])
   summary['workloads'][workload][arm]['pooledFrameMs']=stats([f[1] for r in own for f in r['frames']])
 for arm in byarm:
  for d in [d for d in measured if d['workload']==workload and d['arm']==arm]: summary['perTurn'].append({'run':d['run'],**metrics(d)})
(root/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
if a.archive:
 raw=''.join(json.dumps(d,separators=(',',':'))+'\n' for d in records).encode()
 (root/'raw.jsonl.gz').write_bytes(gzip.compress(raw,mtime=0))
 buf=io.BytesIO()
 with tarfile.open(fileobj=buf,mode='w') as tar:
  for path in sorted(root.glob('*.pty')):
   data=path.read_bytes(); info=tarfile.TarInfo(path.name); info.size=len(data);info.mtime=0;info.mode=0o644;tar.addfile(info,io.BytesIO(data))
 (root/'pty.tar.gz').write_bytes(gzip.compress(buf.getvalue(),mtime=0))
for workload,arms in summary['workloads'].items():
 print(workload)
 for arm,m in arms.items():
  print(arm, 'n',m['wholeTurnMs']['n'], 'whole',*[round(m['wholeTurnMs'][k],3) for k in ['median','p95','p99','sd']], 'renderer',*[round(m['rendererMs'][k],3) for k in ['median','p95','p99','sd']])

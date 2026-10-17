#!/usr/bin/env python3
"""Admission gate for retained *live* observations, independent of timing statistics."""
import argparse, collections, gzip, hashlib, json, pathlib, tarfile

def verify_record(record, transcript):
 if record['failure']: raise ValueError('failed live observation')
 if record.get('exitCode')!=0: raise ValueError('launcher did not exit successfully')
 r=record['result']; tty=record['observer']['tty']
 if tty!={'input':True,'output':True,'columns':90,'rows':24}: raise ValueError('real fixed-size PTY not proved')
 if not r['screens'] or not r['compositions'] or not r['frames']: raise ValueError('production renderer not reached')
 if len(transcript)!=r['totalBytes'] or len(transcript)!=record['receivedBytes']: raise ValueError('PTY byte count mismatch')
 digest=hashlib.sha256(transcript).hexdigest()
 if digest!=r['outputHash'] or digest!=record['receivedSha256']: raise ValueError('PTY byte hash mismatch')
 if len(r['providerCalls'])!=1: raise ValueError('main prepared provider call not proved')
 call=r['providerCalls'][0]
 if call['provider']!='opencode-go' or call['model']!='deepseek-v4.1-flash': raise ValueError('wrong live route/model')
 if not call.get('end') or call.get('error') or not call['waits'][-1][2]: raise ValueError('provider iterator did not reach EOF')
 if not any(c[1]=='text-delta' and c[2]>0 for c in r['chunks']): raise ValueError('no real streamed text')
 if r.get('toolCalls',0) or not r.get('assistant'): raise ValueError('not a completed text-only workload')
 if not record['submitted']<=r['turnStart']<=call['start']<=call['end']<=r['flush']: raise ValueError('invalid monotonic event order')
 if not r['turnEnd'] or not r['streamEnd']: raise ValueError('missing real Harness settlement')
 if record['receipts'][-1][2]!=len(transcript): raise ValueError('final PTY receipt does not account for output')

def main():
 p=argparse.ArgumentParser();p.add_argument('directory');a=p.parse_args();root=pathlib.Path(a.directory)
 with gzip.open(root/'raw.jsonl.gz','rt') as f: records=[json.loads(line) for line in f]
 with tarfile.open(root/'pty.tar.gz','r:gz') as tar:
  for d in records:
   verify_record(d,tar.extractfile(d['run']+'.pty').read())
 counts=collections.Counter((d['workload'],d['arm']) for d in records if not d['warmup'])
 expected=json.loads((root/'metadata.json').read_text())['samplesPerWorkloadPerArm']
 workloads=json.loads((root/'metadata.json').read_text()).get('workloads',['latin','cjk','styled','long'])
 if set(counts)!={(w,a) for w in workloads for a in ['stock','candidate']} or any(n!=expected for n in counts.values()): raise ValueError(f'incomplete live sample set: {counts}')
 if len({d['run'] for d in records})!=len(records): raise ValueError('duplicate run identities')
 # Independently recompute overlap using endpoint coverage, not the analysis
 # script's two-pointer interval intersection.
 summary={row['run']:row for row in json.loads((root/'summary.json').read_text())['perTurn']}
 for record in records:
  if record['warmup']:continue
  r=record['result'];points={}
  for dimension,spans in [(0,[(x[1],x[1]+x[2]) for x in r['screens']]+[(x[0],x[0]+x[1]) for x in r['compositions']]),(1,[(x[0],x[1]) for x in r['providerCalls'][0]['waits']])]:
   for begin,end in spans:
    points.setdefault(begin,[0,0])[dimension]+=1
    points.setdefault(end,[0,0])[dimension]-=1
  covering=[0,0];previous=min(points);overlap=0
  for t,change in sorted(points.items()):
   if covering==[1,1]:overlap+=t-previous
   covering=[covering[i]+change[i] for i in [0,1]]
   if not all(x in [0,1] for x in covering):raise ValueError('nested renderer or provider-await spans')
   previous=t
  row=summary[record['run']]
  if abs(overlap-row['providerAwaitRendererOverlapMs'])>1e-4:raise ValueError('independent attribution overlap mismatch')
  if abs(row['wholeTurnMs']-row['rendererMs']-row['providerAwaitNonRendererMs']-row['residualMs'])>1e-6:raise ValueError('attribution accounting mismatch')
 # Deliberate transport corruption and reachability mutations must be rejected.
 d=records[0]
 with tarfile.open(root/'pty.tar.gz','r:gz') as tar: original=tar.extractfile(d['run']+'.pty').read()
 corrupted=bytearray(original);corrupted[len(corrupted)//2]^=1
 try: verify_record(d,corrupted)
 except ValueError as e:
  if 'hash' not in str(e): raise
 else: raise AssertionError('transport corruption was admitted')
 changed=json.loads(json.dumps(d));changed['result']['screens']=[]
 try: verify_record(changed,original)
 except ValueError as e:
  if 'renderer' not in str(e): raise
 else: raise AssertionError('unreached renderer was admitted')
 print(json.dumps({'records':len(records),'measured':sum(counts.values()),'counts':{f'{w}/{a}':n for (w,a),n in sorted(counts.items())},'corruptByteRejected':True,'zeroRendererRejected':True,'independentAttributionSweep':True},indent=2))

if __name__=='__main__':main()

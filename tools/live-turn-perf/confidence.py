#!/usr/bin/env python3
"""Paired-block bootstrap and distribution-free quantile bounds. Stdlib only."""
import argparse, json, math, pathlib, random, statistics

def quantile(xs,p):
 xs=sorted(xs); k=(len(xs)-1)*p; i=math.floor(k)
 return xs[i]+(xs[min(i+1,len(xs)-1)]-xs[i])*(k-i)

def order_bounds(xs,p,alpha):
 # If B~Binomial(n,p), P(X_(l)<=q_p<=X_(u))=P(l<=B<u).
 # Missing endpoints are infinite, not silently replaced by sample extrema.
 xs=sorted(xs);n=len(xs)
 probs=[math.exp(math.lgamma(n+1)-math.lgamma(k+1)-math.lgamma(n-k+1)+k*math.log(p)+(n-k)*math.log1p(-p)) for k in range(n+1)]
 l=0; cumulative=0
 for k,prob in enumerate(probs):
  cumulative+=prob
  if cumulative<=alpha/2:l=k+1
 u=n+1;tail=0
 for k in range(n,-1,-1):
  tail+=probs[k]
  if tail<=alpha/2:u=k
 return [xs[l-1] if l else None,xs[u-1] if u<=n else None]

def analyze(summary,repetitions,seed,metrics=None):
 rng=random.Random(seed);result={'seed':seed,'replicates':repetitions,'method':'Adjacent AB/BA pair block bootstrap, percentile 95% pointwise quantile and variance CIs; no multiplicity adjustment. Quantile difference exact conservative 95% bounds use Bonferroni of two 97.5% marginal order-statistic intervals. null bound means unbounded. Exchangeability/local stationarity are assumptions, not proved.','workloads':{}}
 metrics=metrics or ['wholeTurnMs','rendererMs','screenMs','providerAwaitNonRendererMs','timeToFirstContentPaintMs','firstContentPaintToDrainMs','frameP99Ms','bytes']
 for workload,arms in summary['workloads'].items():
  paired={}
  for row in summary['perTurn']:
   if not row['run'].startswith(workload+'-'):continue
   _,sample,arm=row['run'].split('-');paired.setdefault(sample,{})[arm]=row
  pairs=[v for v in paired.values() if len(v)==2];n=len(pairs)
  if n<2:continue
  # One resampling schedule shared across endpoints keeps paired dependence.
  schedule=[[rng.randrange(n) for _ in range(n)] for _ in range(repetitions)]
  own={}
  for metric in metrics:
   stock=[v['stock'][metric] for v in pairs];candidate=[v['candidate'][metric] for v in pairs]
   observations={}
   for label,p in [('median',.5),('p95',.95),('p99',.99)]:
    delta=quantile(candidate,p)-quantile(stock,p)
    boot=[quantile([candidate[i] for i in indices],p)-quantile([stock[i] for i in indices],p) for indices in schedule]
    lo,hi=quantile(boot,.025),quantile(boot,.975)
    sb=order_bounds(stock,p,.025);cb=order_bounds(candidate,p,.025)
    exact=[None if cb[0] is None or sb[1] is None else cb[0]-sb[1],None if cb[1] is None or sb[0] is None else cb[1]-sb[0]]
    observations[label]={'stock':quantile(stock,p),'candidate':quantile(candidate,p),'delta':delta,'deltaPercent':delta/quantile(stock,p)*100,'bootstrap95Delta':[lo,hi],'conservative95Delta':exact,'bootstrapVerdict':'regression' if lo>0 else 'improvement' if hi<0 else 'inconclusive'}
   stockVars=[statistics.variance([stock[i] for i in indices]) for indices in schedule]
   candidateVars=[statistics.variance([candidate[i] for i in indices]) for indices in schedule]
   varianceDeltas=[c-s for s,c in zip(stockVars,candidateVars)]
   own[metric]={'stockVarianceBootstrap95':[quantile(stockVars,.025),quantile(stockVars,.975)],'candidateVarianceBootstrap95':[quantile(candidateVars,.025),quantile(candidateVars,.975)],'varianceDeltaBootstrap95':[quantile(varianceDeltas,.025),quantile(varianceDeltas,.975)],'pairs':n,'stockVariance':statistics.variance(stock),'candidateVariance':statistics.variance(candidate),'quantiles':observations}
  result['workloads'][workload]=own
 return result

def main():
 p=argparse.ArgumentParser();p.add_argument('directory');p.add_argument('--replicates',type=int,default=10000);p.add_argument('--seed',type=int,default=303);p.add_argument('--metrics',default='');p.add_argument('--summary',default='summary.json');a=p.parse_args();root=pathlib.Path(a.directory)
 result=analyze(json.loads((root/a.summary).read_text()),a.replicates,a.seed,a.metrics.split(',') if a.metrics else None)
 (root/'confidence.json').write_text(json.dumps(result,indent=2,allow_nan=False)+'\n')
 for w,metrics in result['workloads'].items():
  endpoint='wholeTurnMs' if 'wholeTurnMs' in metrics else next(iter(metrics))
  for label,obs in metrics[endpoint]['quantiles'].items():print(w,label,json.dumps(obs))
if __name__=='__main__':main()

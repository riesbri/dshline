"""Protect paired sampling and honest unsupported-tail bounds."""
import math, unittest
from confidence import analyze, order_bounds

class ConfidenceTests(unittest.TestCase):
 def test_small_tail_is_unbounded_not_sample_maximum(self):
  self.assertEqual(order_bounds(list(range(30)),.99,.025)[1],None)
  self.assertIsNotNone(order_bounds(list(range(500)),.99,.025)[1])

 def test_bounds_have_claimed_binomial_coverage(self):
  for n in [30,100,500]:
   for p in [.5,.95,.99]:
    lo,hi=order_bounds(list(range(1,n+1)),p,.025)
    l=lo if lo is not None else 0;u=hi if hi is not None else n+1
    coverage=sum(math.comb(n,k)*p**k*(1-p)**(n-k) for k in range(l,u))
    self.assertGreaterEqual(coverage,.975-1e-10)

 def test_identical_paired_arms_have_zero_resampling_delta(self):
  keys=['wholeTurnMs','rendererMs','screenMs','providerAwaitNonRendererMs','timeToFirstContentPaintMs','firstContentPaintToDrainMs','frameP99Ms','bytes']
  rows=[{'run':f'cjk-{i:03d}-{arm}',**dict.fromkeys(keys,100+2**i)} for i in range(12) for arm in ['stock','candidate']]
  result=analyze({'workloads':{'cjk':{}},'perTurn':rows},200,303)
  for metric in result['workloads']['cjk'].values():
   for q in metric['quantiles'].values():self.assertEqual(q['bootstrap95Delta'],[0,0])

if __name__=='__main__':unittest.main()

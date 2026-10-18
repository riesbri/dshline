#!/usr/bin/env python3
"""Recompute published padding-study results without original per-turn files."""
import argparse,hashlib,importlib.util,json,pathlib,shutil,subprocess,tempfile
p=argparse.ArgumentParser();p.add_argument('directory');a=p.parse_args();root=pathlib.Path(a.directory).resolve();tools=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('confidence',tools/'confidence.py');ci=importlib.util.module_from_spec(spec);spec.loader.exec_module(ci)
expected=['summary.json','ux-summary.json','padding-effect.json','verification.json','input-cell-verification.json','confidence.json','delivery-confidence.json']
inputs=['raw.jsonl.gz','pty.tar.gz','metadata.json']
with tempfile.TemporaryDirectory(prefix='byte-archive-recompute-') as scratch:
 staged=pathlib.Path(scratch)
 for name in inputs:shutil.copyfile(root/name,staged/name)
 commands=[['python3',str(tools/'summarize.py'),scratch],['python3',str(tools/'ux-analyze.py'),scratch,'--unpaced'],['python3',str(tools/'padding-effect.py'),scratch],['python3',str(tools/'ux-archive-verify.py'),scratch],['node',str(tools/'ux-verify.mjs'),scratch]]
 for command in commands:subprocess.run(command,check=True,stdout=subprocess.DEVNULL)
 for name,source,metrics in [('confidence.json','summary.json',['wholeTurnMs','rendererMs','bytes','providerAwaitNonRendererMs','timeToFirstContentPaintMs','chunkToScreenP95Ms']),('delivery-confidence.json','ux-summary.json',['sendToEchoReceiptMs','chunkToScreenP95Ms','timeToFirstFeedbackMs'])]:
  result=ci.analyze(json.loads((staged/source).read_text()),3000,303,metrics);(staged/name).write_text(json.dumps(result,indent=2)+'\n')
 checks={name:json.loads((root/name).read_text())==json.loads((staged/name).read_text()) for name in expected}
 if not all(checks.values()):raise ValueError(f'archive recomputation mismatch: {checks}')
report=dict(archiveOnly=True,originalPerTurnFilesRequired=False,resultsMatch=checks,inputsSha256={name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in inputs})
(root/'archive-recomputation.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))

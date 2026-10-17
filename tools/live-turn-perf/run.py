#!/usr/bin/env python3
"""Run actual dsh + provider in a private controlling PTY. Stdlib only."""
import argparse, fcntl, hashlib, json, os, pathlib, pty, random, select, shutil, signal, struct, subprocess, tempfile, termios, time
P = argparse.ArgumentParser()
P.add_argument('--stock', required=True)
P.add_argument('--candidate', required=True)
P.add_argument('--profile', default=str(pathlib.Path.home()/'.dsh/profiles/dshline'))
P.add_argument('--credential-home', default=str(pathlib.Path.home()/'.dsh'))
P.add_argument('--samples', type=int, default=30)
P.add_argument('--output', required=True)
P.add_argument('--timeout', type=int, default=180)
P.add_argument('--workloads', default='latin,cjk,styled,long')
P.add_argument('--pilot', action='store_true')
P.add_argument('--seed', type=int, default=303)
P.add_argument('--continue-on-failure', action='store_true')
args = P.parse_args()
ROOT = pathlib.Path(__file__).resolve().parent
out = pathlib.Path(args.output).resolve(); out.mkdir(parents=True, exist_ok=True)
private = pathlib.Path(tempfile.mkdtemp(prefix='dshline-live-')); os.chmod(private,0o700)
prompts = {
 'latin': 'Do not use tools. Output exactly 32 numbered lines, each containing this sentence: The quiet river carries silver leaves beneath the old stone bridge. No introduction or conclusion.',
 'cjk': 'Do not use tools. Output exactly 32 numbered lines, each containing this sentence: 清晨的河流穿过古老石桥，微风吹动竹林，远山笼罩着薄雾。 No introduction or conclusion.',
 'styled': 'Do not use tools. Output exactly 32 numbered Markdown lines, each containing: **bold river** and `inline code` with *gentle emphasis* beside [the bridge](https://example.com/bridge). No introduction or conclusion.',
 'long': 'Do not use tools. Output one single line, with no spaces or newlines, consisting of the string https://example.com/abcdefghijklmnopqrstuvwxyz0123456789/ repeated exactly 48 times. No introduction or conclusion.'}

def git(root, *argv): return subprocess.check_output(['git','-C',root,*argv], text=True).strip()
meta = {'schema':1,'started':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'host':os.uname()._asdict() if hasattr(os.uname(),'_asdict') else list(os.uname()),'cpu':subprocess.check_output(['lscpu'],text=True),'node':subprocess.check_output(['node','--version'],text=True).strip(),'launcher':subprocess.check_output(['dsh','--version'],text=True).strip(),'terminal':{'columns':90,'rows':24,'TERM':'xterm-256color','OPOST':False},'arms':{arm:{'root':root,'commit':git(root,'rev-parse','HEAD'),'tree':git(root,'rev-parse','HEAD^{tree}')} for arm,root in [('stock',args.stock),('candidate',args.candidate)]},'prompts':prompts,'samplesPerWorkloadPerArm':args.samples,'privatePath':str(private),'runnerSha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'scheduleSeed':args.seed,'workloads':args.workloads.split(','),'observerSha256':hashlib.sha256((ROOT/'observer.mjs').read_bytes()).hexdigest()}
meta['builds']={arm:{str(path.relative_to(pathlib.Path(root))):hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(pathlib.Path(root).glob('packages/*/lib/**/*.js'))} for arm,root in [('stock',args.stock),('candidate',args.candidate)]}
meta['adapterVersion']=json.loads((pathlib.Path(args.profile)/'node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json').read_text())['version']
meta['profilePackageSha256']=hashlib.sha256((pathlib.Path(args.profile)/'package.json').read_bytes()).hexdigest()
meta['profileLockSha256']=hashlib.sha256((pathlib.Path(args.profile)/'pnpm-lock.yaml').read_bytes()).hexdigest()
meta['profileWorkspaceConfig']=(pathlib.Path(args.profile)/'pnpm-workspace.yaml').read_text()
(out/'metadata.json').write_text(json.dumps(meta,indent=2)+'\n')

def run(arm, workload, n, warmup):
 root = pathlib.Path(args.stock if arm=='stock' else args.candidate).resolve()
 runid=f'{workload}-{n:03d}-{arm}'+('-warmup' if warmup else '')
 home = private/runid; profile=home/'profiles/dshline'; profile.mkdir(parents=True)
 for name in ['package.json','cordis.yml']:
  shutil.copy2(pathlib.Path(args.profile)/name,profile/name)
 (profile/'cordis.patch.yml').write_text('''- id: agent-default-model
  config:
    provider: opencode-go
    model: deepseek-v4.1-flash
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_API_KEY
- id: dshline
  config:
    theme: default
    busyEnter: steer
''')
 (profile/'node_modules').mkdir()
 for item in (pathlib.Path(args.profile)/'node_modules').iterdir():
  if item.name=='@dshline': continue
  (profile/'node_modules'/item.name).symlink_to(item,target_is_directory=item.is_dir())
 (profile/'node_modules/@dshline').mkdir()
 for package in ['dshline','renderer']:
  (profile/'node_modules/@dshline'/package).symlink_to(root/'packages'/package,target_is_directory=True)
 manifest=json.loads((profile/'package.json').read_text())
 manifest['dependencies']['@dshline/dshline']='link:'+str(root/'packages/dshline')
 manifest['dependencies'].pop('dshline',None)
 (profile/'package.json').write_text(json.dumps(manifest))
 creds=pathlib.Path(args.credential_home)/'.credentials.yaml'
 if creds.exists():
  shutil.copy2(creds,home/creds.name); os.chmod(home/creds.name,0o600)
 workspace=home/'workspace'; workspace.mkdir()
 overlay=home/'observe.yml'
 overlay.write_text(f'''- insert:
    - id: live-turn-observer
      name: {json.dumps(str(ROOT/'observer.mjs'))}
''')
 env={**os.environ,'DSH_HOME':str(home),'DSH_LIVE_ROOT':str(root),'TERM':'xterm-256color','COLORTERM':'truecolor','NODE_OPTIONS':f'--import={ROOT}/observer.mjs'}
 master,slave=pty.openpty(); fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,90,0,0))
 r,w=os.pipe()
 # fd 3 side channel must survive exec without stealing a PTY descriptor.
 def setup():
  os.setsid(); fcntl.ioctl(0,termios.TIOCSCTTY,0)
  if w!=3: os.dup2(w,3)
  os.set_inheritable(3,True)
 start=time.monotonic_ns()/1e6
 child=subprocess.Popen(['dsh','--profile','dshline','--patch',str(overlay),'-C',str(workspace)],stdin=slave,stdout=slave,stderr=slave,env=env,preexec_fn=setup,pass_fds=(w,3) if w!=3 else (w,),cwd=workspace,close_fds=True)
 os.close(slave); os.close(w)
 transcript=bytearray(); receipts=[]; messages=[]; side=b''; submitted=None; result=None; failure=None
 try:
  while time.monotonic_ns()/1e6-start < args.timeout*1000:
   ready,_,_=select.select([master,r],[],[],0.1)
   for fd in ready:
    try: data=os.read(fd,65536)
    except OSError: data=b''
    if not data: continue
    t=time.monotonic_ns()/1e6
    if fd==master:
     transcript.extend(data); receipts.append([t,len(data),len(transcript)])
    else:
     side+=data
     while b'\n' in side:
      line,side=side.split(b'\n',1); msg=json.loads(line); messages.append(msg)
      if msg['kind']=='result': result=msg
   if submitted is None and b'ready' in transcript and any(m['kind']=='observer-ready' for m in messages):
    time.sleep(0.05)
    submitted=time.monotonic_ns()/1e6
    os.write(master,b'\x1b[200~'+prompts[workload].encode()+b'\x1b[201~\r')
   if result and len(transcript)>=result['totalBytes']: break
   if child.poll() is not None: raise RuntimeError(f'early exit {child.returncode}')
  else: raise TimeoutError('live turn timeout')
  if submitted is None or result is None: raise RuntimeError('missing live turn')
  if len(transcript)!=result['totalBytes'] or hashlib.sha256(transcript).hexdigest()!=result['outputHash']: raise RuntimeError('PTY byte/hash accounting mismatch')
  if not result['screens'] or not result['compositions'] or not result['frames']: raise RuntimeError('renderer reachability failed')
  if not result.get('providerCalls') or len(result['providerCalls'])!=1: raise RuntimeError('expected one measured real prepared provider call')
  if not result.get('streamEnd') or not result['chunks'] or result.get('toolCalls',0): raise RuntimeError('expected one real text-only provider attempt without tools')
 except Exception as e: failure=str(e)
 record={'observer':next((m for m in messages if m['kind']=='observer-ready'),None),'run':runid,'arm':arm,'workload':workload,'sample':n,'warmup':warmup,'submitted':submitted,'receipts':receipts,'result':result,'failure':failure,'receivedBytes':len(transcript),'receivedSha256':hashlib.sha256(transcript).hexdigest()}
 # Raw PTY output is benchmark-generated text only. No session/credential stores are published.
 (out/f'{runid}.pty').write_bytes(transcript)
 os.write(master,b'\x04')
 try: child.wait(timeout=10)
 except subprocess.TimeoutExpired: os.killpg(child.pid,signal.SIGTERM); child.wait(timeout=10)
 record['exitCode']=child.returncode
 if child.returncode!=0 and not failure: failure=record['failure']=f'nonzero launcher exit {child.returncode}'
 (out/f'{runid}.json').write_text(json.dumps(record,separators=(',',':'))+'\n')
 os.close(master); os.close(r)
 if not failure:
  # Only generated private homes, never the installed profile or credentials.
  shutil.rmtree(home)
 if failure: raise RuntimeError(f'{runid}: {failure}; inspect private benchmark home {home}')
 print(json.dumps({'run':runid,'elapsedMs':result['flush']-submitted,'screenMs':sum(s[2] for s in result['screens']),'chunks':len(result['chunks'])}),flush=True)

workloads=args.workloads.split(',')
# Fixed, seed-reproducible workload order within each round; adjacent arm pairs.
# No interim testing or optional stopping. Preserve every failed attempt.
rng=random.Random(args.seed)
try:
 for workload in workloads:
  for arm in ['stock','candidate']: run(arm,workload,-1,True)
 if not args.pilot:
  for n in range(args.samples):
   order=workloads.copy(); rng.shuffle(order)
   for workload in order:
    for arm in (['stock','candidate'] if n%2==0 else ['candidate','stock']):
     try: run(arm,workload,n,False)
     except Exception as error:
      if not args.continue_on_failure: raise
      print(json.dumps({'failure':str(error)}),flush=True)
finally:
 final={arm:{str(path.relative_to(pathlib.Path(root))):hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(pathlib.Path(root).glob('packages/*/lib/**/*.js'))} for arm,root in [('stock',args.stock),('candidate',args.candidate)]}
 (out/'provenance-final.json').write_text(json.dumps({'finished':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'allCompiledModulesUnchanged':final==meta['builds']},indent=2)+'\n')
 # Failed homes can be retained for diagnosis without retaining credential copies.
 for copied in private.glob('*/.credentials.yaml'): copied.unlink()

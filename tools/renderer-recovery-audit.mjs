/** Deliberate recovery/guard faults in disposable compiled emission, restored even on failure. */
import {createHash} from 'node:crypto'
import {execFileSync,spawnSync} from 'node:child_process'
import {cpSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {equal,ok} from 'node:assert/strict'
import {rendererIdentity} from './renderer-identity.mjs'
import {rendererNativeInputsDigest} from './renderer-native-inputs.mjs'
const root=fileURLToPath(new URL('../',import.meta.url)),output=process.argv[2]
ok(output&&process.argv.length===3,'usage: node tools/renderer-recovery-audit.mjs output.json')
const file=new URL('../packages/renderer/lib/native-primitives.js',import.meta.url),original=readFileSync(file,'utf8')
const sha=value=>createHash('sha256').update(value).digest('hex')
const replace=(from,to)=>{equal(original.split(from).length,2,'fault must target exactly one source occurrence');return original.replace(from,to)}
const recovery='recovers admitted|recovery oracle|never retries terminal|recovers Screen and callback-frame'
const guards=['ascii-short-width','ascii-dominant-width','ascii-tail','ascii-chunk','ascii-wrap']
const experiments=[
  {name:'unmodified',text:original,pattern:recovery+'|gates every recorded ASCII regression',witness:null},
  {name:'remove-auto-recovery',text:replace("selection !== 'auto' || !(error instanceof Error)","true || !(error instanceof Error)"),pattern:recovery,witness:'recovers admitted panic/backend failures'},
  {name:'remove-TS-only-scope',text:replace("const previous = selection;\n    selection = 'typescript';","const previous = selection;"),pattern:recovery,witness:'recovery oracle only once'},
  {name:'retry-terminal-errors',text:replace("error.code !== 'BACKEND_FAILURE'","!['BACKEND_FAILURE', 'RESOURCE_LIMIT', 'INVALID_INPUT'].includes(error.code)"),pattern:recovery,witness:'never retries terminal native codes'},
  {name:'retry-forced-rust',text:replace("selection !== 'auto' || !(error instanceof Error)","!(error instanceof Error)"),pattern:recovery,witness:'recovers admitted panic/backend failures'},
  ...guards.map(guard=>({name:`remove-${guard}`,text:replace(`'${guard}'`,'undefined'),pattern:'gates every recorded ASCII regression',witness:'must stay TS:'})),
]
const results=[]
const scratch=mkdtempSync(join(tmpdir(),'renderer-recovery-audit-')),variant=join(scratch,'lib')
cpSync(new URL('../packages/renderer/lib',import.meta.url),variant,{recursive:true})
try{
  for(const experiment of experiments){
    writeFileSync(join(variant,'native-primitives.js'),experiment.text)
    const result=spawnSync('pnpm',['exec','vitest','run','tools/renderer-native.spec.mjs','tools/renderer-leaf.spec.mjs','-t',experiment.pattern],{cwd:root,encoding:'utf8',timeout:60000,env:{...process.env,NO_COLOR:'1',DSHLINE_TEST_RENDERER_LIB:variant}})
    const transcript=result.stdout+result.stderr
    ok(!result.error&&!result.signal,'test must execute, not fail to launch/time out')
    if(experiment.witness)ok(result.status!==0&&transcript.includes(experiment.witness),`${experiment.name}: expected named behavioral assertion failure`)
    else equal(result.status,0,transcript)
    results.push({name:experiment.name,status:result.status,compiledSha256:sha(experiment.text),transcriptSha256:sha(transcript),witness:experiment.witness,summary:transcript.split('\n').filter(line=>/Test Files|Tests\s|FAIL|must stay TS:/u.test(line)).map(line=>line.slice(0,240)).slice(-12)})
    console.error(`${experiment.name}: ${result.status}`)
  }
}finally{rmSync(scratch,{recursive:true,force:true})}
equal(readFileSync(file,'utf8'),original)
const evidence={commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),identity:rendererIdentity(),inputDigest:await rendererNativeInputsDigest(),auditToolSha256:sha(readFileSync(fileURLToPath(import.meta.url))),platform:`${process.platform}-${process.arch}`,node:process.version,procedure:'Single unmodified test pass, four independent recovery-policy faults and all five individual ASCII guard removals. Only private compiled copies are mutated through the test-only DSHLINE_TEST_RENDERER_LIB seam; the verified root stays byte-identical. No overlapping builds/tests/timing; scratch removed in finally. Mocked native throws test the JS boundary, not a real Rust panic. Guard faults must fail the explicit native-call counter even when auto recovers its throw.',results}
writeFileSync(output,JSON.stringify(evidence,null,2)+'\n')

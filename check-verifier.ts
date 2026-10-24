import fs from 'node:fs'; import path from 'node:path';
import { inspectMathematicsSandboxBackends, checkManyFormalVerifications } from './src/math/verifier.ts';
import { hashMathFormalSourceDeclaration } from './src/math/leanSource.ts';
import { git } from './src/solver/problem.ts';
const run='/home/lzh/theorem-os-runs/imo2026-gpt56-sol-retry-20261022-224112/cases/q1';
const w=run+'/result.json.runtime/worktree-3'; const project=w+'/generated/imo2026_q1';
const env={...JSON.parse(fs.readFileSync(run+'/result.json.runtime/environment-researcher-2.json','utf8'))}; delete env.DEEPSCIENTIST_MATH_PROOF_ENVIRONMENT; delete env.DEEPSCIENTIST_MATH_ENV_FILE;
console.log('head',git(w,['rev-parse','HEAD'])); console.log('backends',inspectMathematicsSandboxBackends(env));
const source=fs.readFileSync(project+'/Submission.lean','utf8'); const commit=git(w,['rev-parse','HEAD']);
for (const theoremName of ['statement_a_unique_large','terminal_value_eq_Mval','statement_a_termination']) {
 const statementHash=hashMathFormalSourceDeclaration(source,theoremName)!;
 console.log('checking',theoremName,statementHash);
 const res=await checkManyFormalVerifications({projectRoot:project,targetCommit:commit,items:[{proofPath:'Submission.lean',theoremName,statementHash,leanStatementHash:statementHash,expectedSourceDeclarationHash:statementHash}],timeoutMs:Infinity,batchTimeoutMs:Infinity},{env,collectDeclarationReferences:true});
 console.log(JSON.stringify({status:res.status,results:res.results.map(x=>({status:x.status,error:x.error,stderr:x.stderrPreview,stdout:x.stdoutPreview,verifier:x.verifier})),events:res.events.filter((e:any)=>e.kind==='diagnostic.emitted'||e.kind==='check.kernel_checked')},null,2));
}

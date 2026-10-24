import { readSolverProblem } from './src/solver/problem.ts';
import { taskChanges } from './src/solver/cooperativeProof.ts';
const root='/home/lzh/theorem-os-runs/imo2026-gpt56-sol-retry-20261022-224112/cases/q1';
const runtime=root+'/result.json.runtime';
const state=JSON.parse(await Bun.file(root+'/result.json.runtime/state.json').text());
const p=readSolverProblem(root+'/workspace', root+'/workspace/active-problem.json');
const W=runtime+'/worktree';
for (const id of ['goal_unique','goal_terminal_value']) {
 const node=state.cooperation.tasks.find((x:any)=>x.task.id===id);
 console.log('TASK',id,'seed',node.assignment.seedCommit,'worker',node.assignment.workerId);
 const proofCommit=id==='goal_unique'?'359bc25a1a47b8ddcf92d7e4aebe29a0fa7ed4f4':'515456fc277976026ab579a0c2a28e18a6408703';
 try {
  const changes=taskChanges(p,W,proofCommit,node.task,node.assignment);
  console.log(JSON.stringify(changes.map((c:any)=>({file:c.file,name:c.name,beforeName:c.beforeName,afterName:c.afterName,before:c.before?.slice(0,160),after:c.after.slice(0,160),tail:c.tail?.slice(0,80)})),null,2));
 } catch(e) { console.log('ERR',String(e)); }
}

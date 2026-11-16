import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { buildSync } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { mathBuildFile, mathBuildSource, MATH_BUILD_INPUTS, MATH_RUNTIME_BUNDLES } from '../src/math/mathBuildManifest';
import { mathDigest, writeMathJsonDurable } from '../src/math/mathRuntimeIo';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { git, readSolverProblem } from '../src/solver/problem';
import { solverSourceDigest } from '../src/solver/modules/evidence';
import { prepareResearchSkill, researchSkillIdentity } from '../src/solver/researchSkill';
import { readMathAgentSkill } from '../src/runtime/codexSkills';
import { solverState } from './helpers/solver';

// This peer supplies deterministic protocol frames and tool writes. It cannot use a provider.
// The lease, native adapter, skill lifecycle, usage ledger, archive and restart execute unchanged.
const peer = String.raw`const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const root=process.env.FIXTURE_ROOT,phase=process.env.FIXTURE_PHASE,recovery=process.env.FIXTURE_RECOVERY==='1';
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');let thread='process-research-thread',workspace;
fs.writeFileSync(path.join(root,'peer.pid'),String(process.pid));
const mark=()=>fs.writeFileSync(path.join(root,'ready'),phase);
const stream=readline.createInterface({input:process.stdin});stream.on('close',()=>process.exit(0));
stream.on('line',line=>{const call=JSON.parse(line),p=call.params||{};
fs.appendFileSync(path.join(root,'protocol.jsonl'),JSON.stringify({method:call.method,
threadId:p.threadId,turnId:p.clientUserMessageId})+'\n');
const reply=result=>send({id:call.id,result});
if(call.method==='initialize')return reply({});
if(call.method==='thread/start'||call.method==='thread/resume'){workspace=p.cwd;thread=p.threadId||thread;
return reply({thread:{id:thread},model:p.model,reasoningEffort:p.config.model_reasoning_effort,
approvalPolicy:'never',activePermissionProfile:{id:'math-worker'}});}
if(call.method==='skills/list')return reply({data:[{cwd:workspace,errors:[],skills:[{name:'theoremos-research',
path:path.join(workspace,'.agents/skills/theoremos-research/SKILL.md'),enabled:true}]}]});
if(call.method==='turn/start'){
if(!recovery&&phase==='request-before-ack'){mark();return;}
const turn=p.clientUserMessageId;reply({turn:{id:turn}});
if(!recovery&&phase==='request-after-ack'){mark();return;}
fs.mkdirSync(path.join(workspace,'.scratch'),{recursive:true});
fs.appendFileSync(path.join(workspace,'RESEARCH.md'),recovery?'Recovered from saved bytes.\n':'Tool result saved before shutdown.\n');
fs.writeFileSync(path.join(workspace,'.scratch/tool-result.json'),JSON.stringify({saved:true,turn}));
if(!recovery&&phase==='tool-write'){mark();return;}
if(!recovery&&phase.startsWith('whole-proof-')){
fs.writeFileSync(path.join(workspace,'generated/problem/Submission.lean'),'theorem original : True := by trivial\n');}
if(!recovery&&(phase==='pending-verifier'||phase.startsWith('declaration-'))){
const source=path.join(workspace,'generated/problem/Submission.lean');fs.appendFileSync(source,'\ntheorem saved_helper : True := by trivial\n');
fs.writeFileSync(path.join(workspace,'.scratch/declaration-submission.json'),JSON.stringify({declarations:[{file:'Submission.lean',name:'saved_helper',type:'True'}]}));}
send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'fixture-command',type:'commandExecution',command:'fixture tool write',exitCode:0,aggregatedOutput:'Saved fixture files.'}}});
const factor=recovery&&phase==='frozen'?2:1;
send({method:'thread/tokenUsage/updated',params:{threadId:thread,turnId:turn,tokenUsage:{total:{inputTokens:5*factor,outputTokens:2*factor,totalTokens:7*factor},last:{inputTokens:5,outputTokens:2,totalTokens:7}}}});
send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});}
});`;

const owner = String.raw`
import fs from 'node:fs';import path from 'node:path';
import { withMathRuntimeLease,writeMathJsonDurable } from './src/math/mathRuntimeIo';
import { readSolverRunState,writeSolverRunState } from './src/solver/archive';
import { prepareResearchSkill } from './src/solver/researchSkill';
import { runResearchWorkers } from './src/solver/research';
import { git } from './src/solver/problem';
import { directSolverModules } from './src/solver/modules';
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),recovery=process.argv[3]==='resume';
const stateFile=path.join(config.root,'state.json'),lockPath=path.join(config.root,'run.lock');
const hold=()=>{fs.writeFileSync(path.join(config.root,'ready'),config.phase);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
if(!recovery&&config.phase==='declaration-consumed'){
 const remove=fs.rmSync;fs.rmSync=(file,options)=>{remove(file,options);
  if(String(file).endsWith('/.scratch/declaration-submission.json'))hold();};
}
await withMathRuntimeLease({lockPath,flockExecutable:'/usr/bin/flock'},async lease=>{
 const state=readSolverRunState(stateFile),skill=prepareResearchSkill(config.repo,state.worktree,state.researchSkill,state.problem);
 if(!recovery&&config.phase==='whole-proof-after-freeze'){
  const read=fs.readFileSync;
  fs.readFileSync=(file,...args)=>{
   const value=read(file,...args);
   // Hold after the stopped writer's source is committed, before readiness is
   // journaled. No production hook or pending-check marker is used by this window.
   if(String(file)===path.join(state.worktree,state.problem.projectRelative,'Submission.lean')&&
     !state.pendingProofCheck&&git(state.worktree,['rev-parse','HEAD'])!==state.problem.baseCommit)hold();
   return value;
  };
 }
 const save=()=>{lease.assertOwned();writeSolverRunState(stateFile,state);
  if(!recovery&&config.phase==='whole-proof-before-freeze'&&state.pendingResearchFreeze&&!state.pendingProofCheck)hold();
  if(!recovery&&config.phase==='pending-verifier'&&state.pendingDeclarationCheck)hold();
  if(!recovery&&config.phase==='declaration-completed'&&state.pendingDeclarationCheck?.phase==='completed')hold();
  if(!recovery&&config.phase==='whole-proof-pending'&&state.pendingProofCheck)hold();
  if(!recovery&&config.phase==='whole-proof-accepted'&&state.pendingProofCheck&&state.check?.passed)hold();};
 if(!recovery&&config.phase==='prepared')hold();
 const result=await runResearchWorkers({state,root:config.repo,buildFile:config.buildFile,taskText:'Prove the fixed original target.',
 workers:[{id:'solver',role:'lead',worktree:state.worktree,ownedFiles:state.problem.ownedFiles}],
 access:new Map([['solver',{researchSkill:skill,environment:{...config.environment,FIXTURE_ROOT:config.root,FIXTURE_PHASE:config.phase,FIXTURE_RECOVERY:recovery?'1':'0'},retrievalRoot:state.worktree}]]),
 modules:directSolverModules,executable:path.join(config.root,'peer'),profile:path.join(config.root,'profile'),signal:lease.signal,
 deadline:Infinity,maxTurns:config.phase==='pending-verifier'?1:config.phase==='frozen'?2:1,maxTurnMs:Infinity,maxTotalTokens:1000,proofTimeoutMs:30000,
 save,emit:(event,details)=>{fs.appendFileSync(path.join(config.root,'events.jsonl'),JSON.stringify({event,details})+'\n');
  if(!recovery&&config.phase==='frozen'&&event==='research_saved')hold();}});
 writeMathJsonDurable(path.join(config.root,'completed.json'),{result:result?.check.passed??false,turns:state.turns,tokenBudget:state.tokenBudget});
});
`;

const roots: string[] = [], children: ChildProcess[] = [], observations: Record<string, unknown>[] = [];
const recoveryPhases = ['prepared', 'request-before-ack', 'request-after-ack', 'tool-write', 'frozen',
  'pending-verifier', 'declaration-completed', 'declaration-consumed',
  'whole-proof-before-freeze', 'whole-proof-after-freeze',
  'whole-proof-pending', 'whole-proof-accepted'] as const;
let runtimeRoot: string, runtimeManifest: string;
beforeAll(() => {
  // The mutable development worktree is never built into or used as a fake manifest.
  // Freeze private real source and the four normal bundles for both owner processes.
  runtimeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-process-runtime-')));
  const sourceRoot = process.cwd();
  for (const relative of [...MATH_BUILD_INPUTS, 'src', 'bin', 'resources', 'skills']) {
    const source = path.join(sourceRoot, relative), target = path.join(runtimeRoot, relative);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
  }
  fs.cpSync(path.join(sourceRoot, 'scripts'), path.join(runtimeRoot, 'scripts'), { recursive: true });
  const startedAt = new Date().toISOString(), source = mathBuildSource(runtimeRoot);
  const bundleRoot = path.join(runtimeRoot, 'out/main');
  buildSync({ entryPoints: Object.fromEntries(['runMathProof', 'searchLean', 'checkLean', 'proofSearch']
    .map((name, index) => [MATH_RUNTIME_BUNDLES[index].replace(/\.js$/u, ''),
      path.join(runtimeRoot, 'scripts/mathematics', name + '.ts')])),
    outdir: bundleRoot, bundle: true, platform: 'node', format: 'cjs',
    nodePaths: [path.join(sourceRoot, 'node_modules')], loader: { '.py': 'text', '.lean': 'text' }, logLevel: 'silent' });
  runtimeManifest = path.join(runtimeRoot, 'build-manifest.json');
  writeMathJsonDurable(runtimeManifest, { schema: 'deepscientist.math.build-manifest.v1',
    buildId: crypto.randomUUID(), startedAt, finishedAt: new Date().toISOString(), source, bundleRoot,
    bundles: MATH_RUNTIME_BUNDLES.map(name => mathBuildFile(path.join(bundleRoot, name))) });
  fs.chmodSync(runtimeManifest, 0o400);
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* This owned process already stopped. */ }
    child.stdout?.destroy(); child.stderr?.destroy();
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  }
  for (const root of roots.splice(0)) {
    if (fs.existsSync(path.join(root, 'peer.pid'))) {
      try { process.kill(-Number(fs.readFileSync(path.join(root, 'peer.pid'), 'utf8')), 'SIGKILL'); } catch { /* Reaped by its adapter. */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
afterAll(() => {
  if (process.env.THEOREMOS_EVIDENCE_ROOT) {
    fs.mkdirSync(process.env.THEOREMOS_EVIDENCE_ROOT, { recursive: true, mode: 0o700 });
    writeMathJsonDurable(path.join(process.env.THEOREMOS_EVIDENCE_ROOT, 'process-recovery.json'), {
      checkedAt: new Date().toISOString(), modelCalls: 0, provider: 'local-protocol-peer',
      casesExpected: recoveryPhases.length, casesPassed: observations.length, passed: observations.length === recoveryPhases.length,
      actualBoundaries: ['SIGKILL', 'OS-flock', 'native-adapter-process', 'durable-state',
        'real-Lean-helper-recovery', 'real-Lean-original-proof-recovery'], observations });
  }
  if (runtimeRoot) fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

function lockStatus(root: string) {
  const result = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73',
    path.join(root, 'run.lock'), '/usr/bin/true'], { timeout: 5000 });
  if (result.error) throw result.error;
  return result.status;
}
function alive(pid: number) {
  try { process.kill(pid, 0); return !/\) Z /u.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); }
  catch { return false; }
}

describe.skipIf(process.platform !== 'linux')('skill mode across actual owner process death', () => {
  it.each(recoveryPhases)(
    'recovers durable evidence at %s without replaying a request with unknown usage', async phase => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-process-recovery-'))); roots.push(root);
      const receipt = bootstrapLeanTask(path.join(root, 'workspace'), {
        source: 'theorem original : True := by sorry\n', task: 'Prove the fixed original target.' });
      const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
      const repo = runtimeRoot, skill = readMathAgentSkill(path.join(repo, 'skills/theoremos-research/SKILL.md'));
      const state = solverState(problem, receipt.workspaceRoot, { runId: 'process-fixture-' + phase, phase: 'prepared',
        model: 'fixture-model', effort: 'high', environmentDigest: mathDigest('process-fixture-environment'),
        coordination: 'independent', workerCount: 1, researchMode: 'skill', researchSkill: researchSkillIdentity(skill) });
      prepareResearchSkill(repo, state.worktree, state.researchSkill!, problem);
      writeSolverRunState(path.join(root, 'state.json'), state);
      fs.mkdirSync(path.join(root, 'profile'));
      fs.writeFileSync(path.join(root, 'peer'), '#!' + process.execPath + '\n' + peer, { mode: 0o700 });
      const toolchain = path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.33.0');
      const config = path.join(root, 'config.json');
      fs.writeFileSync(config, JSON.stringify({ root, repo, buildFile: runtimeManifest, phase, environment: {
        PATH: `${toolchain}/bin:/usr/bin:/bin`, ELAN_HOME: path.join(os.homedir(), '.elan'),
        DEEPSCIENTIST_MATH_SANDBOX_BACKEND: 'bwrap', DEEPSCIENTIST_MATH_ENV_FILE: path.join(root, 'absent.env') } }));
      const executable = path.join(root, 'owner.mjs');
      buildSync({ stdin: { contents: owner, resolveDir: repo, loader: 'ts' }, outfile: executable,
        bundle: true, platform: 'node', format: 'esm', loader: { '.py': 'text', '.lean': 'text' },
        nodePaths: [path.join(process.cwd(), 'node_modules')],
        banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
      const start = (resume: boolean) => {
        const child = spawn(process.execPath, [executable, config, resume ? 'resume' : 'initial'], {
          detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(child); let stderr = '';
        child.stderr!.on('data', chunk => { stderr += chunk; });
        return { child, error: () => stderr };
      };
      const initial = start(false);
      await expect.poll(() => {
        if (initial.child.exitCode !== null) throw new Error(initial.error());
        return fs.existsSync(path.join(root, 'ready'));
      }, { timeout: 10_000 }).toBe(true);
      expect(lockStatus(root)).toBe(73);
      const inode = fs.statSync(path.join(root, 'run.lock')).ino;
      const before = readSolverRunState(path.join(root, 'state.json'));
      const frozenCommit = git(state.worktree, ['rev-parse', 'HEAD']);
      const frozenSourceDigest = solverSourceDigest(problem, state.worktree);
      const peerIdentity = fs.existsSync(path.join(root, 'peer.pid'))
        ? fs.readFileSync(path.join(root, 'peer.pid'), 'utf8') : undefined;
      const declarationsFile = path.join(root, 'declarations.json');
      const artifactsBefore = fs.existsSync(declarationsFile) ? fs.readFileSync(declarationsFile, 'utf8') : undefined;
      const requestFile = path.join(state.worktree, '.scratch/declaration-submission.json');
      if (phase.startsWith('declaration-')) {
        expect(before.pendingDeclarationCheck?.phase).toBe('completed');
        expect(fs.existsSync(requestFile)).toBe(phase === 'declaration-completed');
        expect(artifactsBefore).toBeDefined();
      }
      if (phase.startsWith('whole-proof-')) {
        expect(before.turns).toBe(1);
        expect(before.writerStopUnconfirmed).toBeUndefined();
        expect(peerIdentity).toBeDefined();
        expect(alive(Number(peerIdentity))).toBe(false);
        if (phase === 'whole-proof-before-freeze' || phase === 'whole-proof-after-freeze') {
          expect(before.pendingProofCheck).toBeUndefined();
          expect(before.pendingResearchFreeze).toEqual({ commit: problem.baseCommit,
            sourceDigest: frozenSourceDigest, problemReceiptDigest: problem.receiptDigest,
            environmentDigest: state.environmentDigest });
          if (phase === 'whole-proof-before-freeze') {
            expect(frozenCommit).toBe(problem.baseCommit);
            expect(git(state.worktree, ['status', '--porcelain', '--untracked-files=no'])).not.toBe('');
          } else {
            expect(frozenCommit).not.toBe(problem.baseCommit);
            expect(git(state.worktree, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
          }
          expect(fs.readFileSync(path.join(state.worktree, problem.projectRelative, 'Submission.lean'), 'utf8'))
            .toBe('theorem original : True := by trivial\n');
        } else {
          expect(before.pendingProofCheck?.commit).toBe(frozenCommit);
          expect(before.pendingProofCheck?.problemReceiptDigest).toBe(problem.receiptDigest);
        }
        expect(before.check?.passed).toBe(phase === 'whole-proof-accepted' ? true : undefined);
      }
      const bytes = fs.existsSync(path.join(state.worktree, 'RESEARCH.md'))
        ? fs.readFileSync(path.join(state.worktree, 'RESEARCH.md'), 'utf8') : undefined;
      const exit = once(initial.child, 'exit'); initial.child.kill('SIGKILL'); await exit;
      await expect.poll(() => lockStatus(root), { timeout: 5000 }).toBe(0);
      if (fs.existsSync(path.join(root, 'peer.pid')))
        await expect.poll(() => alive(Number(fs.readFileSync(path.join(root, 'peer.pid'), 'utf8'))), { timeout: 5000 }).toBe(false);
      const restarted = start(true);
      await expect.poll(() => {
        if (restarted.child.exitCode !== null && restarted.child.exitCode !== 0) throw new Error(restarted.error());
        return fs.existsSync(path.join(root, 'completed.json'));
      }, { timeout: 15_000 }).toBe(true);
      if (restarted.child.exitCode === null) await once(restarted.child, 'exit');
      expect(restarted.child.exitCode, restarted.error()).toBe(0);
      expect(fs.statSync(path.join(root, 'run.lock')).ino).toBe(inode);
      const after = readSolverRunState(path.join(root, 'state.json'));
      if (bytes) expect(fs.readFileSync(path.join(state.worktree, 'RESEARCH.md'), 'utf8')).toContain(bytes);
      const calls = fs.existsSync(path.join(root, 'protocol.jsonl'))
        ? fs.readFileSync(path.join(root, 'protocol.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
      const turns = calls.filter(call => call.method === 'turn/start');
      expect(new Set(turns.map(call => call.turnId)).size).toBe(turns.length);
      if (['request-before-ack', 'request-after-ack', 'tool-write'].includes(phase)) {
        expect(turns).toHaveLength(1); expect(after.tokenBudget?.status).toBe('usage-unavailable');
        expect(after.usageAccounting?.incomplete).toBe(true);
      } else if (phase === 'frozen') {
        expect(calls.filter(call => call.method === 'thread/resume')).toHaveLength(1);
        expect(after.threadId).toBe(before.threadId); expect(after.turns).toBe(2);
      } else if (phase.startsWith('whole-proof-')) {
        expect(turns).toHaveLength(1); expect(after.turns).toBe(1);
        expect(calls.filter(call => call.method === 'initialize')).toHaveLength(1);
        expect(calls.filter(call => call.method === 'thread/resume')).toHaveLength(0);
        expect(fs.readFileSync(path.join(root, 'peer.pid'), 'utf8')).toBe(peerIdentity);
        expect(after.writerStopUnconfirmed).toBeUndefined();
        expect(after.pendingResearchFreeze).toBeUndefined();
        expect(after.pendingProofCheck).toBeUndefined(); expect(after.check?.passed).toBe(true);
        if (phase === 'whole-proof-before-freeze') {
          const checkedCommit = git(state.worktree, ['rev-parse', 'HEAD']);
          expect(checkedCommit).not.toBe(frozenCommit);
          expect(after.check?.commit).toBe(checkedCommit);
          expect(git(state.worktree, ['rev-list', '--parents', '-n', '1', 'HEAD']))
            .toBe(`${checkedCommit} ${frozenCommit}`);
        } else expect(after.check?.commit).toBe(frozenCommit);
        expect(after.check?.sourceDigest).toBe(frozenSourceDigest);
        expect(solverSourceDigest(problem, state.worktree)).toBe(frozenSourceDigest);
        expect(after.check?.verification.status).toBe('kernel_verified');
        expect(after.check?.verification.results.every(receipt => receipt.status === 'kernel_verified')).toBe(true);
        expect(JSON.parse(fs.readFileSync(path.join(root, 'completed.json'), 'utf8')).result).toBe(true);
        if (phase === 'whole-proof-accepted') expect(after.check).toEqual(before.check);
      } else if (phase === 'pending-verifier' || phase.startsWith('declaration-')) {
        expect(turns).toHaveLength(1); expect(after.pendingDeclarationCheck).toBeUndefined();
        const artifacts = JSON.parse(fs.readFileSync(declarationsFile, 'utf8'));
        expect(artifacts.artifacts).toHaveLength(1);
        expect(artifacts.artifacts[0].proof.verification.results[0].status).toBe('kernel_verified');
        expect(git(state.worktree, ['rev-parse', 'HEAD'])).toBe(before.pendingDeclarationCheck?.commit);
        expect(fs.existsSync(requestFile)).toBe(false);
        if (artifactsBefore) expect(fs.readFileSync(declarationsFile, 'utf8')).toBe(artifactsBefore);
      }
      observations.push({ phase, stateBefore: { turns: before.turns, threadId: before.threadId,
        pendingDeclarationCheck: before.pendingDeclarationCheck, pendingResearchFreeze: before.pendingResearchFreeze,
        pendingProofCheck: before.pendingProofCheck,
        proofAccepted: before.check?.passed, usageAccounting: before.usageAccounting },
        stateAfter: { turns: after.turns, threadId: after.threadId, tokenBudget: after.tokenBudget,
          pendingResearchFreeze: after.pendingResearchFreeze,
          pendingProofCheck: after.pendingProofCheck, proofAccepted: after.check?.passed,
          usageAccounting: after.usageAccounting }, requestIds: turns.map(call => call.turnId),
        lockInodeRetained: true, existingNotesRetained: bytes !== undefined,
        ...(phase.startsWith('whole-proof-') ? { frozenCommit, checkedCommit: after.check?.commit,
          frozenSourceDigest, writerStoppedBeforeFreeze: true,
          writerNotReopened: true } : {}) });
    }, 30_000);
});

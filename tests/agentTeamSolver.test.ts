import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { mathBuildFile, mathBuildSource, MATH_BUILD_INPUTS, MATH_RUNTIME_BUNDLES } from '../src/math/mathBuildManifest';
import { mathDigest, writeMathJsonDurable } from '../src/math/mathRuntimeIo';
import { projectMathematicsRuntimeEnvironment } from '../src/math/mathRuntimeEnvironment';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import { confirmHarnessProcessStopped, type HarnessProcessIdentity } from '../src/runtime/harnessProcess';
import { readSolverRunState, writeSolverRunState, type SolverRunState } from '../src/solver/archive';
import { readAgentTeamProofDelivery } from '../src/solver/agentTeamProof';
import { evaluateSolverProof } from '../src/solver/evaluation';
import { directSolverModules } from '../src/solver/modules';
import { git, readSolverProblem } from '../src/solver/problem';
import { runResearchWorkers } from '../src/solver/research';
import { runSolver } from '../src/solver/run';
import { prepareResearchSkill, researchSkillIdentity } from '../src/solver/researchSkill';
import { solverState } from './helpers/solver';
import { tacticBatteryCacheTestDefines } from './helpers/tacticBatteryCache';
import { nativeFileWatchFixture } from './helpers/nativeFileWatchFixture';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const task = 'Prove the frozen original target using independently checked team helpers.';
let directory: string | undefined;
let connectivityServer: ReturnType<typeof createServer> | undefined;
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (connectivityServer) {
    const server = connectivityServer; connectivityServer = undefined;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  if (directory) fs.rmSync(directory, { recursive: true, force: true }); directory = undefined;
});

// Freeze real source and all normal bundles so the dispatch build gate runs as in
// production. No model, adapter, manager, source checker or Lean verifier is mocked.
function freezeRuntime(root: string) {
  fs.mkdirSync(root);
  for (const relative of [...MATH_BUILD_INPUTS, 'src', 'scripts', 'bin', 'resources', 'skills']) {
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(path.join(repository, relative), destination, { recursive: true });
  }
  const bundleRoot = path.join(root, 'out/main');
  buildSync({ entryPoints: Object.fromEntries(['runMathProof', 'searchLean', 'checkLean', 'proofSearch']
    .map((name, index) => [MATH_RUNTIME_BUNDLES[index].replace(/\.js$/u, ''),
      path.join(root, 'scripts/mathematics', name + '.ts')])),
    outdir: bundleRoot, bundle: true, platform: 'node', format: 'cjs',
    define: tacticBatteryCacheTestDefines(path.join(root, 'tactic-battery-cache')),
    nodePaths: [path.join(repository, 'node_modules')], loader: { '.py': 'text', '.lean': 'text' }, logLevel: 'silent' });
  const manifest = path.join(root, 'build-manifest.json'), now = new Date().toISOString();
  writeMathJsonDurable(manifest, { schema: 'deepscientist.math.build-manifest.v1', buildId: crypto.randomUUID(),
    startedAt: now, finishedAt: now, source: mathBuildSource(root), bundleRoot,
    bundles: MATH_RUNTIME_BUNDLES.map(name => mathBuildFile(path.join(bundleRoot, name))) });
  fs.chmodSync(manifest, 0o400);
  return manifest;
}

const trace = (worktree: string): Record<string, any>[] => fs.readFileSync(
  path.join(worktree, '.scratch/agent-team-peer.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

describe.skipIf(process.platform !== 'linux')('Agent team through native tool RPC and independent Lean acceptance', () => {
  it('delivers two isolated writers asynchronously, resumes Lead after each adoption and proves the original with both helpers', async () => {
    const temporaryRoot = process.env.TMPDIR ?? '/data/lzh/default-storage/tmp';
    fs.mkdirSync(temporaryRoot, { recursive: true });
    directory = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'agent-team-solver-')));
    const root = path.join(directory, 'runtime'), buildFile = freezeRuntime(root);
    const receipt = bootstrapLeanTask(path.join(directory, 'primary'), { task,
      source: 'namespace Team\ntheorem original (n : Nat) : n + 0 = 0 + n := by sorry\nend Team\n' });
    const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
    const worktree = path.join(directory, 'lead');
    git(receipt.workspaceRoot, ['worktree', 'add', '--quiet', '--detach', worktree, problem.baseCommit]);
    const identity = researchSkillIdentity(readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md')));
    const state = solverState(problem, worktree, { runId: 'native-agent-team-solver', phase: 'prepared',
      model: 'fixture-model', effort: 'high', environmentDigest: mathDigest('native-team-real-Lean'),
      workerCount: 1, coordination: 'independent', researchMode: 'skill', researchSkillWorkflow: 'full',
      researchSkill: identity, researchDelegation: { mode: 'team', maxAgents: 3 } });
    const skill = prepareResearchSkill(root, worktree, identity, problem);
    const toolchain = path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.33.0');
    if (!fs.existsSync(path.join(toolchain, 'bin/lean'))) throw new Error('Real Lean 4.33.0 is required.');
    const environment = { PATH: `${toolchain}/bin:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      ELAN_HOME: path.join(os.homedir(), '.elan'), LEAN_PATH: '', LEAN_SYSROOT: '',
      DEEPSCIENTIST_MATH_SANDBOX_BACKEND: 'bwrap', DEEPSCIENTIST_MATH_ENV_FILE: path.join(directory, 'missing.env') };
    const profile = path.join(directory, 'profile'), executable = path.join(directory, 'peer');
    fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'config.toml'), '');
    fs.writeFileSync(executable, '#!' + process.execPath + '\n' + nativeFileWatchFixture +
      fs.readFileSync(path.join(repository, 'tests/fixtures/agentTeamPeer.cjs'), 'utf8'), { mode: 0o700 });
    const processes = new Map<string, HarnessProcessIdentity>();
    const open = vi.fn(directSolverModules.M1.open);
    const events: { event: string; details?: Record<string, unknown> }[] = [];
    const snapshots: SolverRunState[] = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('native-team-fixture-deadline')), 60_000);
    let winner: Awaited<ReturnType<typeof runResearchWorkers>>;
    try {
      winner = await runResearchWorkers({ state, root, buildFile, taskText: task, executable, profile,
        workers: [{ id: 'solver', role: 'lead', worktree, ownedFiles: problem.ownedFiles }],
        access: new Map([['solver', { environment, retrievalRoot: path.join(worktree, problem.projectRelative), researchSkill: skill }]]),
        modules: { ...directSolverModules, M1: { ...directSolverModules.M1, open } },
        signal: controller.signal, deadline: Date.now() + 60_000,
        maxTurns: 8, maxTurnMs: 45_000, maxTotalTokens: 1000, proofTimeoutMs: 30_000,
        save: () => {
          for (const current of [state.writerProcess, ...(state.agentTeam?.workers.map(worker => worker.writerProcess) ?? [])])
            if (current) processes.set(`${current.pid}:${current.startTime}`, current);
          writeSolverRunState(path.join(directory!, 'state.json'), state);
        }, emit: (event, details) => {
          events.push({ event, details });
          if (event === 'team_event' && details?.kind === 'adopted') snapshots.push(structuredClone(state));
        } });
    } catch (error) {
      throw new Error(JSON.stringify({ reason: String(error), leadStop: state.writerStopUnconfirmed,
        workers: state.agentTeam?.workers.map(worker => ({ id: worker.id, stop: worker.writerStopUnconfirmed,
          error: worker.error, process: worker.writerProcess && confirmHarnessProcessStopped(worker.writerProcess) })),
        failures: events.filter(item => /failed|deferred/u.test(item.event)),
      }), { cause: error });
    } finally { clearTimeout(timer); }

    expect(winner?.check.passed).toBe(true);
    expect(winner?.check.verification.status).toBe('kernel_verified');
    expect(winner?.check.verification.results.map(result => result.theoremName)).toEqual(['Team.original']);
    expect(state.turns).toBe(5);
    expect(state.threadId).toBe('peer-lead');
    expect(state.teamUsage?.totalTokens).toBe(50);
    expect(state.tokenBudget).toMatchObject({ usageComplete: true, reportedTotalTokens: 50 });
    expect(state.agentTeam?.workers).toHaveLength(2);
    expect(open).toHaveBeenCalledTimes(5);
    for (const [options] of open.mock.calls) {
      expect(options).toMatchObject({ turnTimeoutMs: 45_000, turnCheckpointMs: 36_000 });
    }
    expect(state.agentTeam?.deliveries).toHaveLength(2);
    expect(state.agentTeam?.adoptions.map(adoption => adoption.status)).toEqual(['completed', 'completed']);
    expect(state.writerStopUnconfirmed).toBeUndefined();
    expect(state.agentTeam?.workers.every(worker => !worker.writerStopUnconfirmed && !worker.writerProcess)).toBe(true);
    expect(processes.size).toBe(5);
    expect([...processes.values()].every(identity => confirmHarnessProcessStopped(identity).status === 'stopped')).toBe(true);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every(snapshot => snapshot.check?.passed !== true)).toBe(true);

    const leadTrace = trace(worktree), hostFrames = leadTrace.filter(frame => frame.direction === 'host');
    expect(hostFrames.filter(frame => frame.method === 'thread/start')).toHaveLength(1);
    expect(hostFrames.filter(frame => frame.method === 'thread/resume').map(frame => frame.params.threadId))
      .toEqual(['peer-lead', 'peer-lead']);
    expect(hostFrames.find(frame => frame.method === 'thread/start')?.params.dynamicTools[0].name).toBe('theoremos_team');
    expect(hostFrames.filter(frame => frame.method === 'thread/resume').every(frame => !frame.params.dynamicTools)).toBe(true);
    expect(leadTrace).toContainEqual({ observation: 'fast-delivered-while-slow-running' });
    expect(leadTrace.some(frame => frame.observation === 'lead-resumed-with-fast')).toBe(true);
    expect(leadTrace.some(frame => frame.observation === 'lead-resumed-with-both')).toBe(true);
    expect(state.agentTeam!.researchState).toMatchObject({ revision: 2,
      summary: 'The original target consumes fast then symmetric slow; check each exact helper before adoption.' });
    const inspectedResearch = leadTrace.find(frame => frame.observation === 'lead-inspected-research')!;
    const fastTask = state.agentTeam!.workers.find(worker => worker.id === 'fast')!.tasks[0]!;
    expect(inspectedResearch).toEqual({ observation: 'lead-inspected-research', artifactId: fastTask.researchArtifactId,
      taskId: fastTask.id, commit: fastTask.sourceCommit });
    expect(state.agentTeam!.researchArtifacts).toContainEqual(expect.objectContaining({ id: fastTask.researchArtifactId,
      taskId: fastTask.id, commit: fastTask.sourceCommit }));
    expect(leadTrace.some(frame => frame.observation === 'peer-error')).toBe(false);

    for (const worker of state.agentTeam!.workers) {
      expect(worker.worktree).not.toBe(worktree); expect(worker.threadId).toBe(`peer-${worker.id}`);
      const childTrace = trace(worker.worktree);
      expect(childTrace.some(frame => frame.observation === 'pinned-skill-read')).toBe(true);
      expect(childTrace).toContainEqual({ observation: 'worker-received-research', actor: worker.id, revision: 1 });
      expect(childTrace).toContainEqual({ observation: 'worker-polled-current-research', actor: worker.id, revision: 2 });
      expect(childTrace.some(frame => frame.direction === 'peer' && frame.params?.arguments?.operation === 'submit')).toBe(true);
      const reference = state.agentTeam!.deliveries.find(delivery => delivery.agentId === worker.id)!;
      const delivery = readAgentTeamProofDelivery(reference.path, state);
      expect(delivery.artifacts[0]!.proof.verification.status).toBe('kernel_verified');
      expect(delivery.artifacts[0]!.proof.passed).toBe(true);
    }
    const source = fs.readFileSync(path.join(worktree, problem.projectRelative, 'Submission.lean'), 'utf8');
    expect(source).toContain('exact Eq.trans (fast n) (Eq.symm (slow n))');
    expect(source).not.toContain('sorry');
    expect(events.filter(event => event.event === 'proof_checked')).toHaveLength(1);
    expect(git(receipt.workspaceRoot, ['rev-parse', 'HEAD'])).toBe(problem.baseCommit);
  }, 90_000);

  it('corrects a rejected child delivery in the same native thread with current task feedback before Lead adoption', async () => {
    const temporaryRoot = process.env.TMPDIR ?? '/data/lzh/default-storage/tmp';
    fs.mkdirSync(temporaryRoot, { recursive: true });
    directory = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'agent-team-followup-')));
    const root = path.join(directory, 'runtime'), buildFile = freezeRuntime(root);
    const receipt = bootstrapLeanTask(path.join(directory, 'primary'), { task,
      source: 'namespace Team\ntheorem original (n : Nat) : n + 0 = n := by sorry\nend Team\n' });
    const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
    const worktree = path.join(directory, 'lead');
    git(receipt.workspaceRoot, ['worktree', 'add', '--quiet', '--detach', worktree, problem.baseCommit]);
    const identity = researchSkillIdentity(readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md')));
    const state = solverState(problem, worktree, { runId: 'native-agent-team-followup', phase: 'prepared',
      model: 'fixture-model', effort: 'high', environmentDigest: mathDigest('native-team-followup-real-Lean'),
      workerCount: 1, coordination: 'independent', researchMode: 'skill', researchSkillWorkflow: 'full',
      researchSkill: identity, researchDelegation: { mode: 'team', maxAgents: 2 } });
    const skill = prepareResearchSkill(root, worktree, identity, problem);
    const toolchain = path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.33.0');
    if (!fs.existsSync(path.join(toolchain, 'bin/lean'))) throw new Error('Real Lean 4.33.0 is required.');
    const environment = { PATH: `${toolchain}/bin:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      ELAN_HOME: path.join(os.homedir(), '.elan'), LEAN_PATH: '', LEAN_SYSROOT: '',
      DEEPSCIENTIST_MATH_SANDBOX_BACKEND: 'bwrap', DEEPSCIENTIST_MATH_ENV_FILE: path.join(directory, 'missing.env') };
    const profile = path.join(directory, 'profile'), executable = path.join(directory, 'peer');
    fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'config.toml'), '');
    fs.writeFileSync(executable, '#!' + process.execPath + '\n' + nativeFileWatchFixture +
      fs.readFileSync(path.join(repository, 'tests/fixtures/agentTeamFollowupPeer.cjs'), 'utf8'), { mode: 0o700 });
    const processes = new Map<string, HarnessProcessIdentity>();
    const events: { event: string; details?: Record<string, unknown> }[] = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('native-team-followup-deadline')), 60_000);
    let winner: Awaited<ReturnType<typeof runResearchWorkers>>;
    try {
      winner = await runResearchWorkers({ state, root, buildFile, taskText: task, executable, profile,
        workers: [{ id: 'solver', role: 'lead', worktree, ownedFiles: problem.ownedFiles }],
        access: new Map([['solver', { environment, retrievalRoot: path.join(worktree, problem.projectRelative), researchSkill: skill }]]),
        modules: directSolverModules, signal: controller.signal, deadline: Date.now() + 60_000,
        maxTurns: 6, maxTurnMs: 45_000, maxTotalTokens: 1000, proofTimeoutMs: 30_000,
        save: () => {
          for (const current of [state.writerProcess, ...(state.agentTeam?.workers.map(worker => worker.writerProcess) ?? [])])
            if (current) processes.set(`${current.pid}:${current.startTime}`, current);
          writeSolverRunState(path.join(directory!, 'state.json'), state);
        }, emit: (event, details) => { events.push({ event, details }); } });
    } finally { clearTimeout(timer); }

    expect(winner?.check.passed, JSON.stringify({ events, workers: state.agentTeam?.workers })).toBe(true);
    expect(winner?.check.verification.status).toBe('kernel_verified');
    expect(winner?.check.verification.results.map(result => result.theoremName)).toEqual(['Team.original']);
    expect(state.turns).toBe(4); expect(state.threadId).toBe('followup-lead');
    expect(state.teamUsage?.totalTokens).toBe(40);
    expect(state.agentTeam?.workers).toHaveLength(1);
    const worker = state.agentTeam!.workers[0]!, [first, second] = worker.tasks;
    expect(worker.worktree).not.toBe(worktree);
    expect(worker.threadId).toBe('followup-child'); expect(worker.turns).toBe(2);
    expect(worker.tasks.map(task => task.status)).toEqual(['failed', 'completed']);
    expect(first!.error).toContain('math_declaration_artifact_check_failed:Team.helper:');
    expect(first!.error).toMatch(/type mismatch/iu);
    expect(second!.id).not.toBe(first!.id);
    expect(second!.seedCommit).toBe(first!.seedCommit);
    expect(worker.pendingSourceBase).toBeUndefined(); expect(worker.pendingDelivery).toBeUndefined();
    expect(state.agentTeam!.deliveries).toHaveLength(1);
    expect(state.agentTeam!.adoptions.map(adoption => adoption.status)).toEqual(['completed']);
    expect(events.filter(item => item.event === 'team_event' && item.details?.kind === 'failed'))
      .toMatchObject([{ details: { from: 'child', to: 'lead', taskId: first!.id, text: expect.stringContaining(first!.error!) } }]);

    const childTrace = trace(worker.worktree), childFrames = childTrace.filter(frame => frame.direction === 'host');
    const childStart = childFrames.find(frame => frame.method === 'thread/start')!;
    const childResumes = childFrames.filter(frame => frame.method === 'thread/resume');
    expect(childFrames.filter(frame => frame.method === 'thread/start')).toHaveLength(1);
    expect(childResumes.map(frame => frame.params.threadId)).toEqual(['followup-child']);
    expect(childResumes[0]!.params.dynamicTools).toBeUndefined();
    const childToolSchema = childStart.params.dynamicTools[0].inputSchema;
    const childOperations = ['progress', 'yield', 'history', 'message', 'poll', 'wait', 'inspect', 'inspect-research',
      'submit', 'submit_helpers', 'route_summary'];
    expect(childToolSchema.properties.operation.enum).toEqual(childOperations);
    expect(childToolSchema.oneOf.map((branch: { properties: { operation: { enum: string[] } } }) =>
      branch.properties.operation.enum[0])).toEqual(childOperations);
    expect([childStart, ...childResumes].every(frame => frame.params.developerInstructions.includes(
      'your agentId is "child", and your coordinator is lead.'))).toBe(true);
    expect([childStart, ...childResumes].some(frame => frame.params.developerInstructions.includes('You are the Lead'))).toBe(false);
    const childTurns = childFrames.filter(frame => frame.method === 'turn/start');
    const assignments = childTurns.map(frame => JSON.parse(frame.params.input.filter((item: { type: string }) =>
      item.type === 'text').map((item: { text: string }) => item.text).join('\n').split('\n')
      .find((line: string) => line.startsWith('{"agentId":'))));
    expect(childTurns.map(frame => frame.params.clientUserMessageId)).toEqual([first!.id, second!.id]);
    expect(assignments[1]).toMatchObject({ agentId: 'child', coordinator: 'lead', taskId: second!.id,
      deliveryBaseCommit: first!.seedCommit, previousTask: { id: first!.id, status: 'failed', error: first!.error } });
    expect(assignments[1].objective).toBe(second!.message);
    expect(assignments[1].sourceCommit).not.toBe(assignments[1].deliveryBaseCommit);
    expect(git(worker.worktree, ['show', `${assignments[1].sourceCommit}:${problem.projectRelative}/Submission.lean`]))
      .toContain('by exact Nat.succ_ne_zero n');
    expect(childTrace.some(frame => frame.observation === 'worker-followup-context')).toBe(true);

    const leadTrace = trace(worktree), leadFrames = leadTrace.filter(frame => frame.direction === 'host');
    const leadToolSchema = leadFrames.find(frame => frame.method === 'thread/start')!.params.dynamicTools[0].inputSchema;
    expect(leadToolSchema.properties.operation.enum).toEqual(['spawn', 'assign', 'amend', 'finish', 'coordinate', 'budget',
      'resume', 'history', 'publish', 'cancel', 'message', 'poll', 'wait', 'inspect', 'inspect-research', 'adopt', 'stop',
      'retire_route', 'route_summary']);
    expect(leadToolSchema).not.toHaveProperty('oneOf');
    expect(leadFrames.filter(frame => frame.method === 'thread/resume').map(frame => frame.params.threadId))
      .toEqual(['followup-lead']);
    expect(leadTrace).toContainEqual({ observation: 'lead-assigned-correction',
      failedTaskId: first!.id, taskId: second!.id, error: first!.error });
    expect(leadTrace.some(frame => frame.observation === 'lead-inspected-corrected-helper')).toBe(true);
    expect(leadTrace.some(frame => frame.observation === 'lead-resumed-with-corrected-helper')).toBe(true);
    const roleGuideBytes = fs.statSync(path.join(repository, 'skills/theoremos-research/references/team-roles.md')).size;
    for (const [frames, actor] of [[childTrace, 'child'], [leadTrace, 'lead']] as const) {
      expect(frames.filter(frame => frame.observation === 'team-role-guide-read'))
        .toEqual(Array.from({ length: 2 }, () => ({ observation: 'team-role-guide-read', actor, bytes: roleGuideBytes })));
      for (const resource of ['references/domain-experts.md', 'references/domain-experts/number-theory.md',
        'references/domain-materials.md', 'references/domain-materials/number-theory.md']) {
        const content = fs.readFileSync(path.join(repository, 'skills/theoremos-research', resource));
        expect(frames.filter(frame => frame.observation === 'domain-expert-resource-read' && frame.resource === resource))
          .toEqual(Array.from({ length: 2 }, () => ({ observation: 'domain-expert-resource-read', actor,
            expertId: 'D011', resource, sha256: crypto.createHash('sha256').update(content).digest('hex') })));
      }
    }
    expect([...childTrace, ...leadTrace].some(frame => frame.observation === 'peer-error')).toBe(false);
    const reference = state.agentTeam!.deliveries[0]!, delivery = readAgentTeamProofDelivery(reference.path, state);
    expect(reference.taskId).toBe(second!.id); expect(delivery.seedCommit).toBe(first!.seedCommit);
    expect(delivery.artifacts[0]!.proof.verification.status).toBe('kernel_verified');
    const source = fs.readFileSync(path.join(worktree, problem.projectRelative, 'Submission.lean'), 'utf8');
    expect(source).toContain('exact helper n'); expect(source).not.toContain('sorry');
    expect(events.filter(item => item.event === 'proof_checked')).toHaveLength(1);
    expect(processes.size).toBe(4);
    expect([...processes.values()].every(identity => confirmHarnessProcessStopped(identity).status === 'stopped')).toBe(true);
    expect(state.writerStopUnconfirmed).toBeUndefined(); expect(worker.writerStopUnconfirmed).toBeUndefined();
    expect(git(receipt.workspaceRoot, ['rev-parse', 'HEAD'])).toBe(problem.baseCommit);
  }, 90_000);

  it('preserves one paused native task and its draft across peer adoption, cumulative budgeting and final independent S3 acceptance', async () => {
    const temporaryRoot = process.env.TMPDIR ?? '/data/lzh/default-storage/tmp';
    fs.mkdirSync(temporaryRoot, { recursive: true });
    directory = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'agent-team-handoff-')));
    const root = path.join(directory, 'runtime'), buildFile = freezeRuntime(root);
    const receipt = bootstrapLeanTask(path.join(directory, 'primary'), { task,
      source: 'namespace Team\ntheorem original (n : Nat) : n + 0 = n := by sorry\nend Team\n' });
    const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
    const worktree = path.join(directory, 'lead');
    git(receipt.workspaceRoot, ['worktree', 'add', '--quiet', '--detach', worktree, problem.baseCommit]);
    const identity = researchSkillIdentity(readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md')));
    const state = solverState(problem, worktree, { runId: 'native-agent-team-handoff', phase: 'prepared',
      model: 'fixture-model', effort: 'high', environmentDigest: mathDigest('native-team-handoff-real-Lean'),
      workerCount: 1, coordination: 'independent', researchMode: 'skill', researchSkillWorkflow: 'full',
      researchSkill: identity, researchDelegation: { mode: 'team', maxAgents: 3 } });
    const skill = prepareResearchSkill(root, worktree, identity, problem);
    const toolchain = path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.33.0');
    if (!fs.existsSync(path.join(toolchain, 'bin/lean'))) throw new Error('Real Lean 4.33.0 is required.');
    const environment = { PATH: `${toolchain}/bin:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      ELAN_HOME: path.join(os.homedir(), '.elan'), LEAN_PATH: '', LEAN_SYSROOT: '',
      DEEPSCIENTIST_MATH_SANDBOX_BACKEND: 'bwrap', DEEPSCIENTIST_MATH_ENV_FILE: path.join(directory, 'missing.env') };
    const profile = path.join(directory, 'profile'), executable = path.join(directory, 'peer');
    fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'config.toml'), '');
    fs.writeFileSync(executable, '#!' + process.execPath + '\n' + nativeFileWatchFixture +
      fs.readFileSync(path.join(repository, 'tests/fixtures/agentTeamHandoffPeer.cjs'), 'utf8'), { mode: 0o700 });
    const processes = new Map<string, HarnessProcessIdentity>();
    const events: { event: string; details?: Record<string, unknown> }[] = [];
    const snapshots: { kind: unknown; to: unknown; state: SolverRunState }[] = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('native-team-handoff-deadline')), 60_000);
    let winner: Awaited<ReturnType<typeof runResearchWorkers>>;
    try {
      winner = await runResearchWorkers({ state, root, buildFile, taskText: task, executable, profile,
        workers: [{ id: 'solver', role: 'lead', worktree, ownedFiles: problem.ownedFiles }],
        access: new Map([['solver', { environment, retrievalRoot: path.join(worktree, problem.projectRelative), researchSkill: skill }]]),
        modules: directSolverModules, signal: controller.signal, deadline: Date.now() + 60_000,
        maxTurns: 8, maxTurnMs: 45_000, maxTotalTokens: 1000, proofTimeoutMs: 30_000,
        save: () => {
          for (const current of [state.writerProcess, ...(state.agentTeam?.workers.map(worker => worker.writerProcess) ?? [])])
            if (current) processes.set(`${current.pid}:${current.startTime}`, current);
          writeSolverRunState(path.join(directory!, 'state.json'), state);
        }, emit: (event, details) => {
          events.push({ event, details });
          if (event === 'team_event' && ['paused', 'adopted'].includes(String(details?.kind)))
            snapshots.push({ kind: details?.kind, to: details?.to, state: structuredClone(state) });
        } });
    } finally { clearTimeout(timer); }

    const team = state.agentTeam!;
    expect(winner?.check.passed, JSON.stringify({ events, workers: team.workers })).toBe(true);
    expect(winner?.check.verification.status).toBe('kernel_verified');
    expect(winner?.check.verification.results.map(result => result.theoremName)).toEqual(['Team.original']);
    expect(state.turns).toBe(5); expect(state.threadId).toBe('handoff-lead');
    expect(state.teamUsage?.totalTokens).toBe(50);
    expect(state.tokenBudget).toMatchObject({ usageComplete: true, reportedTotalTokens: 50 });
    expect(team.workers).toHaveLength(2); expect(team.deliveries).toHaveLength(2);
    expect(team.adoptions.map(adoption => ({ targetId: adoption.targetId, status: adoption.status })))
      .toEqual([{ targetId: 'consumer', status: 'completed' }, { targetId: 'lead', status: 'completed' }]);
    expect(team.leadReserve).toEqual({ tokens: 50, turns: 2 });
    const consumer = team.workers.find(worker => worker.id === 'consumer')!, [consumerTask] = consumer.tasks;
    expect(consumer.tasks).toHaveLength(1);
    expect(consumerTask).toMatchObject({ status: 'completed', turns: 2, budget: { tokens: 100, turns: 2 } });
    expect(consumerTask!.pauseRequested).toBeUndefined();
    expect(consumerTask!.declarations?.map(declaration => declaration.name)).toEqual(['Team.combined']);
    expect(consumer.pendingSourceBase).toBeUndefined(); expect(consumer.pendingPeerDeliveries).toBeUndefined();
    expect(consumer.pendingDelivery).toBeUndefined();
    const first = JSON.parse(fs.readFileSync(path.join(consumer.worktree, '.scratch/handoff-first-assignment.json'), 'utf8'));
    expect(first.assignment.taskId).toBe(consumerTask!.id);
    expect(consumerTask!.seedCommit).toBe(first.assignment.deliveryBaseCommit);

    const paused = snapshots.find(snapshot => snapshot.kind === 'paused')!.state.agentTeam!.workers
      .find(worker => worker.id === 'consumer')!;
    const adopted = snapshots.find(snapshot => snapshot.kind === 'adopted' && snapshot.to === 'consumer')!.state.agentTeam!.workers
      .find(worker => worker.id === 'consumer')!;
    expect(paused.tasks[0]).toMatchObject({ id: consumerTask!.id, status: 'paused', turns: 1,
      seedCommit: first.assignment.deliveryBaseCommit, pauseRequested: { kind: 'handoff' } });
    expect(paused.writerProcess).toBeUndefined(); expect(paused.writerStopUnconfirmed).toBeUndefined();
    expect(paused.pendingSourceBase).toBe(first.assignment.deliveryBaseCommit);
    expect(git(consumer.worktree, ['show', `${paused.tasks[0]!.sourceCommit}:${problem.projectRelative}/Submission.lean`]))
      .toContain(first.draft.trim());
    expect(adopted.tasks[0]).toMatchObject({ id: consumerTask!.id, status: 'paused', turns: 1 });
    expect(adopted.pendingSourceBase).toBe(paused.pendingSourceBase);
    expect(adopted.pendingPeerDeliveries).toEqual([team.deliveries.find(delivery => delivery.agentId === 'producer')!.id]);
    const notes = team.researchArtifacts!.filter(artifact => artifact.taskId === consumerTask!.id)
      .map(artifact => JSON.parse(fs.readFileSync(artifact.path, 'utf8')));
    expect(notes.map(note => note.status)).toEqual(['paused', 'completed']);
    expect(notes[0]).toMatchObject({ commit: paused.tasks[0]!.sourceCommit, advisory: true, originalProblemAcceptance: 'not-assessed' });
    expect(notes[0].notes.text).toContain('awaits checked Team.dependency');
    expect(notes[1].notes.text).toContain('Resumed the same task after adoption');

    const leadTrace = trace(worktree), consumerTrace = trace(consumer.worktree);
    const consumerFrames = consumerTrace.filter(frame => frame.direction === 'host');
    expect(consumerFrames.filter(frame => frame.method === 'thread/start')).toHaveLength(1);
    expect(consumerFrames.filter(frame => frame.method === 'thread/resume').map(frame => frame.params.threadId))
      .toEqual(['handoff-consumer']);
    expect(consumerFrames.filter(frame => frame.method === 'turn/start').map(frame => frame.params.clientUserMessageId))
      .toEqual([consumerTask!.id, consumerTask!.id]);
    const resumed = consumerTrace.find(frame => frame.observation === 'consumer-resumed-and-submitted-own-declaration')!;
    expect(resumed).toMatchObject({ taskId: consumerTask!.id, threadId: first.threadId,
      assignment: { deliveryBaseCommit: first.assignment.deliveryBaseCommit }, declarations: consumerTask!.declarations });
    expect(resumed.turnId).not.toBe(first.turnId);
    expect(consumerTrace.filter(frame => frame.observation === 'handoff-worker-history')).toHaveLength(2);
    expect(leadTrace.filter(frame => frame.observation === 'lead-observed-paused-draft')).toHaveLength(1);
    expect(leadTrace.filter(frame => frame.observation === 'lead-resumed-same-consumer-task')).toHaveLength(1);
    expect(leadTrace.filter(frame => frame.observation === 'lead-inspected-carried-peer')).toHaveLength(1);
    expect(leadTrace.filter(frame => frame.observation === 'handoff-lead-proved-original')).toHaveLength(1);
    expect(leadTrace.filter(frame => frame.direction === 'peer' && frame.params?.arguments?.operation === 'budget')).toHaveLength(2);
    const reference = team.deliveries.find(delivery => delivery.agentId === 'consumer')!;
    const delivery = readAgentTeamProofDelivery(reference.path, state);
    expect(delivery.seedCommit).toBe(first.assignment.deliveryBaseCommit);
    expect(delivery.declarations.map(declaration => declaration.name).toSorted()).toEqual(['Team.combined', 'Team.dependency']);
    expect(delivery.artifacts.every(artifact => artifact.proof.passed && artifact.proof.commit === delivery.commit &&
      artifact.proof.verification.status === 'kernel_verified')).toBe(true);
    for (const frames of [leadTrace, ...team.workers.map(worker => trace(worker.worktree))])
      expect(frames.some(frame => frame.observation === 'peer-error')).toBe(false);
    expect(state.writerStopUnconfirmed).toBeUndefined();
    expect(team.workers.every(worker => !worker.writerProcess && !worker.writerStopUnconfirmed)).toBe(true);
    expect(processes.size).toBe(5);
    expect([...processes.values()].every(identity => confirmHarnessProcessStopped(identity).status === 'stopped')).toBe(true);
    const source = fs.readFileSync(path.join(worktree, problem.projectRelative, 'Submission.lean'), 'utf8');
    expect(source).toContain('theorem dependency'); expect(source).toContain(first.draft);
    expect(source).toContain('exact combined n'); expect(source).not.toContain('sorry');
    expect(git(receipt.workspaceRoot, ['rev-parse', 'HEAD'])).toBe(problem.baseCommit);

    const evaluation = await evaluateSolverProof(problem, winner!.check,
      environment, controller.signal, { timeoutMs: 30_000 });
    expect(evaluation).toMatchObject({ status: 'passed', method: 'host-lean-kernel-all-targets',
      verification: { passed: true, commit: winner!.check.commit, verification: { status: 'kernel_verified' } } });
    expect(git(receipt.workspaceRoot, ['rev-parse', 'HEAD'])).toBe(winner!.check.commit);
  }, 120_000);

  it('freezes the new native transport and resumes historical host-tool runs through CLI preparation and independent S3 evaluation', async () => {
    const temporaryRoot = process.env.TMPDIR ?? '/data/lzh/default-storage/tmp';
    fs.mkdirSync(temporaryRoot, { recursive: true });
    directory = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'agent-team-cli-')));
    const root = path.join(directory, 'runtime'), buildFile = freezeRuntime(root);
    const receipt = bootstrapLeanTask(path.join(directory, 'primary'), { task,
      source: 'namespace Team\ntheorem original (n : Nat) : n + 0 = 0 + n := by sorry\nend Team\n' });
    const taskFile = path.join(directory, 'task.md'), output = path.join(directory, 'result.json');
    fs.writeFileSync(taskFile, task);
    const toolchain = path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.33.0');
    if (!fs.existsSync(path.join(toolchain, 'bin/lean'))) throw new Error('Real Lean 4.33.0 is required.');
    const environmentFile = path.join(directory, 'math-environment.json');
    writeMathJsonDurable(environmentFile, projectMathematicsRuntimeEnvironment({
      PATH: `${toolchain}/bin:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      ELAN_HOME: path.join(os.homedir(), '.elan'), LEAN_PATH: '', LEAN_SYSROOT: '',
      DEEPSCIENTIST_MATH_SANDBOX_BACKEND: 'bwrap', DEEPSCIENTIST_MATH_ENV_FILE: environmentFile,
      NO_PROXY: '127.0.0.1,localhost',
    }), 0o400);
    vi.stubEnv('DEEPSCIENTIST_MATH_ENV_FILE', environmentFile);

    // The actual startup connectivity probe targets only this disposable local
    // health endpoint. No provider or inference endpoint exists in this fixture.
    const httpRequests: { method: string | undefined; url: string | undefined }[] = [];
    connectivityServer = createServer((request, response) => {
      httpRequests.push({ method: request.method, url: request.url });
      response.writeHead(request.method === 'HEAD' && request.url === '/v1/models' ? 200 : 500); response.end();
    });
    const health = connectivityServer;
    await new Promise<void>((resolve, reject) => {
      health.once('error', reject); health.listen(0, '127.0.0.1', resolve);
    });
    const address = health.address();
    if (!address || typeof address === 'string') throw new Error('Fixture health endpoint unavailable.');
    const profile = path.join(directory, 'profile'), executable = path.join(directory, 'peer');
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'config.toml'), 'model_provider = "fixture"\n' +
      '[model_providers.fixture]\nname = "Local protocol fixture"\nwire_api = "responses"\n' +
      `base_url = "http://127.0.0.1:${address.port}/v1"\n`);
    fs.writeFileSync(executable, '#!' + process.execPath + '\n' + nativeFileWatchFixture +
      fs.readFileSync(path.join(repository, 'tests/fixtures/agentTeamPeer.cjs'), 'utf8'), { mode: 0o700 });
    const events: Record<string, unknown>[] = [];
    vi.spyOn(console, 'log').mockImplementation(line => { events.push(JSON.parse(String(line))); });
    const args = ['--workspace', receipt.workspaceRoot, '--task-file', taskFile,
      '--output', output, '--build-manifest', buildFile, '--harness', 'codex',
      '--harness-profile', profile, '--harness-executable', executable,
      '--model', 'fixture-model', '--effort', 'high', '--no-explanations',
      '--prepare-timeout-seconds', '30', '--max-run-seconds', '60', '--max-turns', '8',
      '--max-turn-seconds', '30', '--max-total-tokens', '1000', '--proof-timeout-seconds', '30',
      '--evaluator-timeout-seconds', '30'];
    expect(await runSolver([...args, '--agent-team', '3', '--startup-only'], root)).toBe(0);
    const historicalFile = path.join(output + '.runtime', 'state.json');
    const historical = readSolverRunState(historicalFile);
    expect(historical.agentTeam?.transport).toBe('native-agent-control');
    // This fixture implements the historical dynamic tool protocol. Existing
    // saved runs retain it even when the current default uses AgentControl.
    delete historical.agentTeam!.transport;
    writeSolverRunState(historicalFile, historical);
    const code = await runSolver([...args, '--research-mode', 'skill', '--skill-delegation', 'team', '--skill-max-agents', '3', '--resume'], root);
    const result = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(code, JSON.stringify({ result, events })).toBe(0);
    expect(result).toMatchObject({ status: 'evaluated_passed', solver_ready_receipt_valid: true,
      completion_signal_valid: true, explanations: { status: 'disabled', targets: [] },
      evaluator: { status: 'passed', method: 'host-lean-kernel-all-targets', verification: { passed: true } } });
    const state = readSolverRunState(path.join(output + '.runtime', 'state.json'));
    expect(state).toMatchObject({ phase: 'finished', researchMode: 'skill',
      researchDelegation: { mode: 'team', maxAgents: 3 }, workerCount: 1, coordination: 'independent',
      threadId: 'peer-lead', turns: 5, check: { passed: true } });
    expect(state.agentTeam?.workers.map(worker => worker.id).toSorted()).toEqual(['fast', 'slow']);
    expect(state.agentTeam?.deliveries).toHaveLength(2);
    expect(state.agentTeam?.adoptions.map(adoption => adoption.status)).toEqual(['completed', 'completed']);
    expect(state.teamUsage?.totalTokens).toBe(50);
    const runtime = output + '.runtime';
    expect(JSON.parse(fs.readFileSync(path.join(runtime, 'toolchain-readiness.json'), 'utf8')).status).toBe('ready');
    expect(JSON.parse(fs.readFileSync(path.join(runtime, 'provider-connectivity.json'), 'utf8')).status).toBe('reachable');
    expect(httpRequests).toEqual([{ method: 'HEAD', url: '/v1/models' }, { method: 'HEAD', url: '/v1/models' }]);
    for (const id of ['solver', 'fast', 'slow']) {
      const accessId = id === 'solver' ? id : 'team-' + id;
      const diagnostics = JSON.parse(fs.readFileSync(path.join(runtime,
        id === 'solver' ? 'preparation-diagnostics.json' : `preparation-${accessId}.json`), 'utf8'));
      expect(diagnostics).toMatchObject({ exitCode: 0, timedOut: false });
      const projectedPath = path.join(runtime, `environment-${accessId}.json`);
      const projected = JSON.parse(fs.readFileSync(projectedPath, 'utf8'));
      expect(projected.DEEPSCIENTIST_MATH_SANDBOX_BACKEND).toBe('bwrap');
      expect(projected.DEEPSCIENTIST_MATH_ENV_FILE).toBe(projectedPath);
      const writerWorktree = id === 'solver' ? state.worktree : state.agentTeam!.workers.find(worker => worker.id === id)!.worktree;
      const started = trace(writerWorktree).find(frame => frame.direction === 'host' && frame.method === 'thread/start');
      expect(started?.params.cwd).toBe(writerWorktree);
      expect(started?.params.developerInstructions).toContain(projectedPath);
      expect(started?.params.developerInstructions).toContain(path.join(writerWorktree, state.problem.projectRelative));
    }
    for (const worker of state.agentTeam!.workers) {
      expect(worker.threadId).toBe(`peer-${worker.id}`);
      expect(worker.writerProcess).toBeUndefined(); expect(worker.writerStopUnconfirmed).toBeUndefined();
      const reference = state.agentTeam!.deliveries.find(delivery => delivery.agentId === worker.id)!;
      const delivery = readAgentTeamProofDelivery(reference.path, state);
      expect(delivery.artifacts[0]!.proof.verification.status).toBe('kernel_verified');
      expect(delivery.artifacts[0]!.proof.passed).toBe(true);
      expect(trace(worker.worktree).some(frame => frame.observation === 'pinned-skill-read')).toBe(true);
    }
    const finalCheck = result.evaluator.verification;
    expect(finalCheck.commit).toBe(state.check!.commit);
    expect(finalCheck.verification.status).toBe('kernel_verified');
    expect(finalCheck.verification.results.map((item: { theoremName: string }) => item.theoremName)).toEqual(['Team.original']);
    expect(git(receipt.workspaceRoot, ['rev-parse', 'HEAD'])).toBe(state.check!.commit);
    const source = fs.readFileSync(path.join(receipt.projectRoot, 'Submission.lean'), 'utf8');
    expect(source).toContain('exact Eq.trans (fast n) (Eq.symm (slow n))'); expect(source).not.toContain('sorry');
    expect(events.some(event => event.event === 'evaluation_finished' && event.status === 'passed')).toBe(true);
    expect(trace(state.worktree).filter(frame => frame.direction === 'host' && frame.method === 'thread/resume')).toHaveLength(2);
  }, 150_000);
});

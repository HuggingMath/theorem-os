import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mathDigest } from '../src/math/mathRuntimeIo';
import type { MathAgentSession } from '../src/runtime/agentSession';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import { planMathAgentSession } from '../src/runtime/agentSessionPlan';
import { readCliConfiguration } from '../src/runtime/cliConfiguration';
import { researchHarness } from '../src/runtime/researchHarness';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { directSolverModules } from '../src/solver/modules';
import { git } from '../src/solver/problem';
import { runResearchWorkers, type WorkerAccess } from '../src/solver/research';
import { prepareResearchSkill, researchSkillIdentity } from '../src/solver/researchSkill';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

// Native processes, scoped role context, source freezing, task checking and original
// checks are real. Only the unrelated source-bundle receipt is replaced.
vi.mock('../src/math/mathBuildManifest', async original => ({
  ...await original<typeof import('../src/math/mathBuildManifest')>(), readMathBuildManifest: vi.fn(),
}));
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(harnessId: 'claude-code' | 'opencode' | 'cli', invalid: boolean) {
  const toolchain = path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.33.0');
  if (!fs.existsSync(path.join(toolchain, 'bin/lean'))) throw new Error('Real Lean 4.33.0 is required.');
  const example = localExample('portable-cooperation-'); roots.push(example.directory);
  const { workspace, problem, directory } = example;
  const workers = [leadWorker(problem, workspace), peerWorker(example, 'engineer', { role: 'engineer' }),
    peerWorker(example, 'reviewer', { role: 'reviewer' })];
  const profile = path.join(directory, 'native-profile'); fs.mkdirSync(profile);
  const executable = path.join(directory, 'native-peer.cjs');
  fs.copyFileSync(path.join(repository, 'tests/fixtures/portableCooperationPeer.cjs'), executable); fs.chmodSync(executable, 0o700);
  const tasks = problem.targets.map((target, index) => ({ id: 'goal_' + (index + 1), kind: 'goal',
    objective: 'Prove the unchanged original tutorial declaration ' + target.theoremName, ...target,
    ownerId: 'engineer', dependsOn: index ? ['goal_1'] : [] }));
  fs.writeFileSync(path.join(profile, 'portable-fixture.json'), JSON.stringify({ tasks, invalid,
    proofs: { 'Tutorial.add_zero': 'by rfl', 'Tutorial.zero_add': 'by exact Nat.zero_add n' } }));
  if (harnessId === 'opencode') fs.writeFileSync(path.join(profile, 'opencode.json'), JSON.stringify({ provider: {
    fixture: { npm: '@ai-sdk/openai-compatible', models: { model: { name: 'Fixture', variants: { high: {} } } } },
  } }));
  if (harnessId === 'cli') fs.writeFileSync(path.join(profile, 'cli.json'), JSON.stringify({ schema: 'theorem-os.cli-harness.v1', executable,
    args: ['--model', '{model}', '--effort', '{effort}', '--profile', '{profile}'], efforts: ['high'],
    session: { mode: 'generated', startArgs: ['--session-id', '{sessionId}'], resumeArgs: ['--resume', '{sessionId}'] },
    output: { format: 'json', sessionId: { field: '/session/id' }, text: { field: '/result/text' },
      usage: { inputTokens: '/stats/input', outputTokens: '/stats/output', completeness: 'complete', scope: 'turn' } } }));
  const researchSkill = researchSkillIdentity(readMathAgentSkill(path.join(repository, 'skills/theoremos-research/SKILL.md'), 'file'));
  const environment = { PATH: `${toolchain}/bin:${path.dirname(process.execPath)}:/usr/bin:/bin`, ELAN_HOME: path.join(os.homedir(), '.elan'),
    LEAN_PATH: '', LEAN_SYSROOT: '', DEEPSCIENTIST_MATH_SANDBOX_BACKEND: 'bwrap',
    DEEPSCIENTIST_MATH_ENV_FILE: path.join(directory, 'absent.env') };
  const access = new Map<string, WorkerAccess>(workers.map(worker => [worker.id, { environment, retrievalRoot: directory,
    researchSkill: prepareResearchSkill(repository, worker.worktree, researchSkill, problem) }]));
  const opened: MathAgentSession[] = [];
  const open = vi.fn(async options => {
    const session = await researchHarness(harnessId).open(options); opened.push(session); return session;
  });
  const modules = { ...directSolverModules, M1: { ...directSolverModules.M1, open } };
  const stateFile = path.join(directory, 'state.json');
  const state = solverState(problem, workspace, { runId: 'portable-full-' + harnessId + '-' + invalid,
    phase: 'running', coordination: 'cooperative', workerCount: workers.length,
    environmentDigest: mathDigest('portable-full-cooperation'), model: harnessId === 'claude-code' ? 'claude-fixture' : 'fixture/model',
    effort: 'high', researchMode: 'skill', researchSkillWorkflow: 'full', researchSkill,
    agentSessionPlan: planMathAgentSession(harnessId, { skills: [access.get(workers[0].id)!.researchSkill!] },
      harnessId === 'cli' ? readCliConfiguration(profile) : undefined),
    workers: workers.map(worker => ({ ...worker, phase: 'prepared', turns: 0 })) });
  const events: { event: string; details?: Record<string, unknown> }[] = [];
  const run = async (current: typeof state, maxTurns: number) => await runResearchWorkers({ state: current,
    workers, access, modules, root: repository, buildFile: path.join(directory, 'unused-build.json'),
    taskText: 'Prove the frozen original tutorial statements using the full cooperative workflow.',
    executable, profile, signal: new AbortController().signal, deadline: Infinity, maxTurns, maxTurnMs: Infinity,
    maxTotalTokens: 1000, proofTimeoutMs: 30_000,
    save: () => writeSolverRunState(stateFile, current), emit: (event, details) => events.push({ event, details }) });
  const calls = () => fs.readFileSync(path.join(profile, 'portable-native-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { ...example, workers, state, stateFile, run, calls, opened, open, events };
}

describe('full Skill cooperation over portable native harnesses', () => {
  it.each(['claude-code', 'opencode', 'cli'] as const)('restores the %s plan and accepts only the independently checked original goals', async harness => {
    const f = fixture(harness, false);
    expect(await f.run(f.state, 1)).toBeUndefined();
    const planned = readSolverRunState(f.stateFile);
    expect(planned.cooperation!.tasks.map(node => node.task.id)).toEqual(['goal_1', 'goal_2']);
    expect(planned.cooperation!.tasks.every(node => node.status !== 'integrated')).toBe(true);
    expect(planned.check?.passed).not.toBe(true); expect(planned.turns).toBe(1);
    expect(f.calls()).toMatchObject([{ worker: 'solver', kind: 'lead' }]);
    for (const session of f.opened) expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
    const winner = await f.run(planned, 12);
    expect(winner?.check.passed).toBe(true);
    expect(winner!.check.verification.results).toHaveLength(f.problem.targets.length);
    expect(winner!.check.verification.results.every(result => result.status === 'kernel_verified')).toBe(true);
    expect(planned.cooperation!.tasks.every(node => node.status === 'integrated')).toBe(true);
    expect(f.calls().filter(call => call.kind === 'task').map(call => call.taskId)).toEqual(['goal_1', 'goal_2']);
    expect(f.calls().some(call => call.kind === 'review' && call.worker === 'reviewer')).toBe(true);
    expect(planned.usage!.totalTokens).toBe(planned.turns * 16);
    expect(planned.workers!.every(worker => !worker.writerStopUnconfirmed)).toBe(true);
    for (const session of f.opened) expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
    expect(git(f.workspace, ['rev-parse', 'HEAD'])).not.toBe(f.problem.baseCommit);
  }, 90_000);

  it.each(['claude-code', 'opencode', 'cli'] as const)('rejects an incorrect %s goal even when the native turn reports completed', async harness => {
    const f = fixture(harness, true);
    expect(await f.run(f.state, 5)).toBeUndefined();
    const bad = f.state.cooperation!.tasks.find(node => node.task.id === 'goal_2')!;
    expect(f.calls().some(call => call.kind === 'task' && call.taskId === 'goal_2')).toBe(true);
    expect(bad.status).not.toBe('integrated'); expect(bad.integratedCheck?.passed).not.toBe(true);
    expect(f.state.cooperation!.deliveries!.some(delivery => delivery.kind === 'failure' && delivery.taskId === 'goal_2')).toBe(true);
    expect(f.state.check?.passed).not.toBe(true);
    expect(f.state.workers!.every(worker => !worker.writerStopUnconfirmed)).toBe(true);
    for (const session of f.opened) expect(await session.stopForFreeze!()).toEqual({ status: 'stopped' });
  }, 90_000);
});

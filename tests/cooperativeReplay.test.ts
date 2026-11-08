import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COOPERATIVE_REPLAY_SOURCE, cooperativeReplay, cooperativeReplayAccepted, cooperativeReplayActors,
  cooperativeReplayAssignment, replayCooperative } from '../scripts/mathematics/cooperativeReplay';
import type { MathAgentOptions } from '../src/runtime/codexSession';
import type { SolverRunState } from '../src/solver/archive';
import { directSolverModules } from '../src/solver/modules';
import { taskCanStart } from '../src/solver/modules/search';
import { leadResearchInputSection, type TaskContextInput } from '../src/solver/contextCompiler';
import type { DeliveryRecord } from '../src/solver/deliveries';
import { answerResearchInputs } from '../src/solver/researchDecisions';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { leadPlanDeliveryFile, taskVersion, type CooperativeAction, type CooperativeTask, type TaskRecord } from '../src/solver/tasks';

const directories: string[] = [];
const temporary = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cooperative-replay-')); directories.push(directory); return directory; };
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const researchDelivery = (id: string, task: CooperativeTask,
  finding: { summary: string; lemmaRequests?: CooperativeTask[] } & Record<string, unknown>): DeliveryRecord => ({
  id, producer: task.ownerId!, taskId: task.id, taskDigest: taskVersion(task), findingDigest: mathDigest(JSON.stringify(finding)),
  kind: 'research', status: 'advisory', statement: '', premises: [], dependencies: [], remainingObligations: [],
  summary: finding.summary, evidenceRefs: [], createdAt: 1, finding: JSON.stringify(finding), lemmaRequests: finding.lemmaRequests,
});
const researchContext = (tasks: TaskRecord[], deliveries: DeliveryRecord[], leadResearchInputIds?: string[]) =>
  leadResearchInputSection({ cooperation: { tasks, deliveries, leadResearchInputIds } as TaskContextInput['cooperation'] })?.text ?? '';
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('scripted cooperative replay', () => {
  it('reads current initial and continuation assignments and rejects non-model assembly', () => {
    const first = { kind: 'lead', seedCommit: 'first' }, current = { kind: 'lead', seedCommit: 'current', planNonce: 'new' };
    expect(cooperativeReplayAssignment('Cooperative assignment:\n' + JSON.stringify(first))).toEqual(first);
    expect(cooperativeReplayAssignment('Cooperative assignment:\n' + JSON.stringify(first) +
      '\nCurrent cooperative assignment (replaces every previous dispatch nonce and receipt):\n' + JSON.stringify(current))).toEqual(current);
    expect(() => cooperativeReplayAssignment('No assignment was dispatched.')).toThrow('assignment_missing');
    expect(() => cooperativeReplayAssignment('Cooperative assignment:\n{"kind":"assemble"}')).toThrow('unexpected_assignment');
  });

  it('publishes a nonce-bound research-to-proof handoff and retains the failed draft and independent review', async () => {
    const directory = temporary(), trace = path.join(directory, 'trace');
    fs.mkdirSync(path.join(directory, 'generated/problem'), { recursive: true });
    const source = path.join(directory, 'generated/problem/Submission.lean');
    fs.writeFileSync(source, COOPERATIVE_REPLAY_SOURCE);
    const actors = cooperativeReplayActors('repair-once', trace);
    expect(actors.modules.M1.execute).toBe(directSolverModules.M1.execute);
    expect(actors.modules.M2).toBe(directSolverModules.M2);
    expect(actors.modules.M3).toBe(directSolverModules.M3);
    expect(actors.modules.M4).toBe(directSolverModules.M4);
    expect(actors.modules.M5).toBe(directSolverModules.M5);
    const usage = vi.fn(), started = vi.fn();
    const run = async (workerId: string, action: CooperativeAction) => {
      const session = await actors.modules.M1.open({ workspace: directory, executable: 'must-not-start-a-process', profile: directory,
        model: 'scripted-zero-model', effort: 'none', instructions: 'Frozen fixture instructions.', onUsage: usage,
        environment: { DEEPSCIENTIST_MATH_WORKER_ID: workerId } } as MathAgentOptions);
      const viewFile = path.join(directory, 'COOPERATION.json'), view = fs.existsSync(viewFile) ? read(viewFile) : undefined;
      const context = action.kind === 'lead' && view ? researchContext(view.tasks, view.deliveries) : '';
      expect(await session.run('Cooperative assignment:\n' + JSON.stringify(action) + '\n' + context, 'message', directory, started)).toBe('completed');
      await session.close();
      return fs.readFileSync(path.join(directory, 'RESEARCH.md'), 'utf8');
    };
    const initial: CooperativeAction = { kind: 'lead', seedCommit: 'seed', initialPlanNonce: 'initial', planVersion: 'base' };
    await run('solver', initial);
    const first = read(path.join(directory, leadPlanDeliveryFile(initial)!));
    expect(first).toMatchObject({ kind: 'plan', dispatchNonce: 'initial', baseVersion: 'base' });
    const tasks: CooperativeTask[] = first.tasks;
    const question = tasks.find(task => task.kind === 'research')!, goal = tasks.find(task => task.kind === 'goal')!;
    expect(goal).toMatchObject({ status: 'paused', conditional: false });
    const writeView = (nodes: unknown[], deliveries: unknown[] = []) => fs.writeFileSync(path.join(directory, 'COOPERATION.json'),
      JSON.stringify({ tasks: nodes, deliveries }));
    const assignment = (task: CooperativeTask) => ({ kind: 'task' as const, task,
      assignment: { taskId: task.id, taskDigest: taskVersion(task), workerId: task.ownerId!, seedCommit: 'seed', assignmentId: task.id } });
    writeView(tasks.map(task => ({ task, status: 'pending', attempts: 0 })));
    const finding = JSON.parse(await run('researcher-2', assignment(question)));
    expect(finding).toMatchObject({ conclusion: 'supporting', needsDecision: true, lemmaRequests: [{ theoremName: 'Replay.climb_eq' }] });
    // Host-published proposals carry their normalized group in the actual prompt.
    const helper = { ...finding.lemmaRequests[0], groupId: 'main' } as CooperativeTask;
    const deliveries = [researchDelivery('published-helper', question, { ...finding, lemmaRequests: [helper] })];
    writeView([{ task: question, status: 'completed', attempts: 1 }, { task: goal, status: 'pending', attempts: 0 }], deliveries);
    const adoption: CooperativeAction = { kind: 'lead', seedCommit: 'seed', planNonce: 'adopt', planVersion: 'v1' };
    await run('solver', adoption);
    const adopted = read(path.join(directory, leadPlanDeliveryFile(adoption)!));
    expect(adopted).toMatchObject({ baseVersion: 'v1', upsert: [helper,
      { id: goal.id, status: 'active', dependsOn: [helper.id] } ] });
    const activeGoal = { ...goal, status: 'active' as const, dependsOn: [helper.id] };
    expect(answerResearchInputs(adopted, deliveries, tasks, [question, helper, activeGoal], [], 'v1'))
      .toMatchObject([{ deliveryId: 'published-helper', outcome: 'adopt', taskIds: [helper.id] }]);
    const dependencies = [{ task: helper, status: 'pending' as const, attempts: 0 },
      { task: activeGoal, status: 'pending' as const, attempts: 0 }];
    expect(taskCanStart(activeGoal, dependencies)).toBe(false);
    expect(taskCanStart(activeGoal, [{ ...dependencies[0], status: 'integrated' }, dependencies[1]])).toBe(true);
    expect(fs.readFileSync(source, 'utf8')).toBe(COOPERATIVE_REPLAY_SOURCE);

    await run('engineer', assignment(helper));
    expect(fs.readFileSync(source, 'utf8')).toContain('exact Nat.zero_ne_one');
    await run('engineer', assignment(helper));
    expect(fs.readFileSync(source, 'utf8')).toContain('induction n with');
    expect(fs.readFileSync(source, 'utf8')).not.toContain('exact Nat.zero_ne_one');
    expect(actors.turns.filter(turn => turn.injectedFailure)).toHaveLength(1);
    expect(fs.readFileSync(actors.turns[3].source, 'utf8')).toContain('exact Nat.zero_ne_one');

    writeView([{ task: question, status: 'completed', attempts: 1 }, { task: helper, status: 'integrated', attempts: 2 },
      { task: goal, status: 'pending', attempts: 0 }], deliveries);
    await run('engineer', assignment(activeGoal));
    const solved = fs.readFileSync(source, 'utf8');
    expect(solved).toContain('rw [climb_eq n]'); expect(solved).not.toContain('sorry');
    await run('researcher-1', { kind: 'review', seedCommit: 'checked-original', sourceDigest: 'exact-source' });
    expect(fs.readFileSync(source, 'utf8')).toBe(solved);
    expect(fs.readFileSync(path.join(directory, 'RESEARCH.md'), 'utf8')).toContain('"commit":"checked-original","verdict":"accepted"');
    expect(new Set(actors.turns.map(turn => turn.role))).toEqual(new Set(['lead', 'researcher', 'engineer', 'reviewer']));
    expect(read(path.join(trace, 'turns.json'))).toHaveLength(7);
    for (const turn of actors.turns) for (const file of [turn.context, turn.output, turn.source]) expect(fs.existsSync(file)).toBe(true);
    expect(usage).toHaveBeenCalledTimes(7); expect(started).toHaveBeenCalledTimes(7);
  });

  it('answers the current research page and leaves an inconclusive gap to its next-check', async () => {
    const directory = temporary();
    fs.mkdirSync(path.join(directory, 'generated/problem'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'generated/problem/Submission.lean'), COOPERATIVE_REPLAY_SOURCE);
    const question: CooperativeTask = { id: 'research_bridge', kind: 'research', ownerId: 'researcher-2',
      objective: 'Check the recursion.', dependsOn: [], revision: 0 };
    const goal: CooperativeTask = { id: 'original', kind: 'goal', objective: 'Prove Replay.target.', status: 'paused',
      proofPath: 'Submission.lean', theoremName: 'Replay.target', dependsOn: [], revision: 0 };
    const helper: CooperativeTask = { id: 'climb_identity', kind: 'lemma', ownerId: 'engineer',
      objective: 'Induct on n to prove climb is the identity; Replay.target consumes two instances at n.',
      proofPath: 'Submission.lean', theoremName: 'Replay.climb_eq', type: '∀ n : Nat, Replay.climb n = n',
      dependsOn: [], revision: 0, groupId: 'main' };
    const tasks: TaskRecord[] = [{ task: question, status: 'completed', attempts: 1 }, { task: goal, status: 'pending', attempts: 0 }];
    const gap = researchDelivery('gap', question, { summary: 'The induction invariant needs a construction check.',
      conclusion: 'inconclusive', needsDecision: true, mathematicalGap: { nextCheck: { action: 'construction-check' } } });
    const wrong = researchDelivery('wrong-interface', question, { summary: 'A pointwise instance is insufficient.',
      conclusion: 'supporting', lemmaRequests: [{ ...helper, type: 'Replay.climb 0 = 0' }] });
    const late = researchDelivery('not-shown', question, { summary: 'A later helper publication.',
      conclusion: 'supporting', lemmaRequests: [helper] });
    const deliveries = [gap, wrong, late];
    fs.writeFileSync(path.join(directory, 'COOPERATION.json'), JSON.stringify({ tasks, deliveries }));
    const actors = cooperativeReplayActors('next-check', path.join(directory, 'trace'));
    const session = await actors.modules.M1.open({ workspace: directory, executable: 'must-not-start-a-process', profile: directory,
      model: 'scripted-zero-model', effort: 'none', instructions: 'Frozen fixture instructions.', onUsage: vi.fn(),
      environment: { DEEPSCIENTIST_MATH_WORKER_ID: 'solver' } } as MathAgentOptions);
    const action: CooperativeAction = { kind: 'lead', seedCommit: 'seed', planNonce: 'current-page', planVersion: 'v1' };
    await session.run('Cooperative assignment:\n' + JSON.stringify(action) + '\n' +
      researchContext(tasks, deliveries, [late.id]) + '\n' + researchContext(tasks, deliveries, [gap.id, wrong.id]),
    'message', directory, vi.fn());
    await session.close();
    const plan = read(path.join(directory, leadPlanDeliveryFile(action)!));
    expect(plan.upsert).toEqual([]);
    const decisions = answerResearchInputs(plan, [wrong, gap], [question, goal], [question, goal], [], 'v1');
    expect(decisions).toMatchObject([{ deliveryId: wrong.id, outcome: 'decline' }, { deliveryId: gap.id, outcome: 'decline' }]);
    expect(plan.researchDecisions).toHaveLength(2);
    expect(decisions.find(decision => decision.deliveryId === gap.id)?.reason).toContain('next-check');
  });

  it('does not treat scripted completion or an accepted review as independent final acceptance', () => {
    const result = { status: 'evaluated_passed', completion_signal_valid: true, solver_ready_receipt_valid: true,
      solution_commit: 'claimed', evaluator: { status: 'passed', method: 'host-lean-kernel-all-targets' } };
    const state = { phase: 'finished', check: { passed: true, commit: 'claimed' }, problem: { targets: [] } } as unknown as SolverRunState;
    expect(cooperativeReplayAccepted(state, result)).toBe(false);
    expect(cooperativeReplayAccepted({ ...state, check: { ...state.check!, passed: false } }, result)).toBe(false);
    expect(cooperativeReplayAccepted({ ...state, phase: 'running' }, result)).toBe(false);
  });

  it('requires an existing build manifest and preserves an existing replay directory', async () => {
    const directory = temporary();
    fs.writeFileSync(path.join(directory, 'evidence'), 'retained');
    await expect(replayCooperative(directory, '/unused', '/unused')).rejects.toThrow('Replay directory already exists');
    expect(fs.readFileSync(path.join(directory, 'evidence'), 'utf8')).toBe('retained');
    await expect(cooperativeReplay(['--directory', directory])).rejects.toThrow('--build-manifest is required');
  });
});

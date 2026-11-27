import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';

import { parseLeadPlan } from '../src/solver/cooperationShared';
import type { TaskProof } from '../src/solver/cooperativeProof';
import { answerGoalProgress, GOAL_PROGRESS_REVIEW_MS as interval, goalProgressForTask, goalProgressStateSchema,
  goalProgressTaskContext, observeGoalProgress, parseGoalProgressDecision, prepareGoalProgressDecision,
  resetGoalProgressClock, type GoalProgressState } from '../src/solver/goalProgress';
import { buildResearchContext } from '../src/solver/modules/context';
import type { NextCheckRecord } from '../src/solver/nextCheckContract';
import { captureObligationSnapshot } from '../src/solver/obligationProgress';
import { leadPlanningEvidence, leadPlanningEvidenceText } from '../src/solver/planningEvidence';
import { leadPlanDeliveryFile, markTaskAcceptance, parseCooperationPlan, taskVersion, type CooperativeTask, type TaskRecord } from '../src/solver/tasks';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';
import { receiptBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ createSession: vi.fn() }));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.createSession }));
const roots: string[] = [];
afterEach(async () => {
  expect(host.createSession).not.toHaveBeenCalled(); host.createSession.mockReset();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const lemma = (id: string, dependsOn: readonly string[] = []): CooperativeTask => ({ id, kind: 'lemma',
  objective: `Prove ${id}.`, revision: 0, proofPath: 'Submission.lean', theoremName: `Example.${id}`, type: 'True', dependsOn });
const goal = (id = 'goal', dependsOn: readonly string[] = ['core']): CooperativeTask => ({ ...lemma(id, dependsOn), kind: 'goal' });
const research = (id = 'research', consumerGoalIds: readonly string[] = ['goal']): CooperativeTask => ({ id, kind: 'research',
  objective: 'Investigate the missing inference.', revision: 0, dependsOn: [], consumerGoalIds });
const node = (task: CooperativeTask): TaskRecord => ({ task, status: 'pending', attempts: 0 });
const check = (task: CooperativeTask) => ({ action: 'construction-check' as const, targetTaskId: task.id,
  objective: 'Test the finite construction at the recorded boundary case.', expectedEvidence: 'A concrete witness or an exact failed equality.' });
const proof = (task: CooperativeTask, conditions: NonNullable<TaskProof['conditions']> = []): TaskProof => {
  const digest = taskVersion(task), commit = 'f'.repeat(40);
  const checked: TaskProof = { taskDigest: digest, seedCommit: commit, commit, sourceDigest: 'fixture-source', passed: true, conditions,
    changes: [{ file: task.proofPath!, name: task.theoremName!, after: `lemma ${task.theoremName} : ${task.type} := by trivial\n` }],
    verification: receiptBatch({ projectRoot: '/unused-fixture', targetCommit: commit, items: [{
      proofPath: task.proofPath!, theoremName: task.theoremName, statementHash: digest, leanStatementHash: digest,
    }] }, { sessionId: 'progress-verifier', receiptId: () => `progress-${task.id}` }) };
  markTaskAcceptance(checked);
  return checked;
};
function observer(initial: TaskRecord[], active = ['research']) {
  let state: GoalProgressState | undefined;
  const observe = (now: number, tasks = initial, activeIds = active, nextChecks?: NextCheckRecord[]) => {
    const targets = tasks.filter(item => item.task.kind === 'goal').map(item => ({
      proofPath: item.task.proofPath!, theoremName: item.task.theoremName! }));
    const result = observeGoalProgress(state, { problemReceiptDigest: 'fixture-receipt', targets, tasks,
      snapshot: captureObligationSnapshot(tasks), activeTaskIds: new Set(activeIds), now, nextChecks });
    state = result.state;
    return result;
  };
  return { observe, get state() { return state!; } };
}

describe('goal effort and unresolved frontier', () => {
  it('attributes advisory effort only to its original goals without adding proof dependencies or evidence', () => {
    const first = goal(), second = goal('other', []), core = lemma('core'), work = research();
    const tasks = [node(first), node(second), node(core), node(work), node(research('parallel'))];
    const clock = observer(tasks, ['research', 'parallel']);
    clock.observe(0);
    expect(clock.observe(interval).requested).toBe(true);
    expect(clock.state.goals[0]).toMatchObject({ activeMs: interval, coreActiveMs: interval, seenEvidence: [], coreSeenEvidence: [] });
    expect(clock.state.goals[1]).toMatchObject({ activeMs: 0, coreActiveMs: 0, active: false });
    expect(first.dependsOn).toEqual(['core']);
    expect(captureObligationSnapshot(tasks).goals[0]!.frontier.map(item => item.taskId)).not.toContain(work.id);
  });

  it('uses an existing host check consumer to attribute effort without an additional proof dependency', () => {
    const work = { ...research('host_check', []), reviewScope: 'feasibility' as const }, core = lemma('core');
    const tasks = [node(goal()), node(core), { ...node(work), nextCheckId: 'a'.repeat(64) }];
    const record = { id: 'a'.repeat(64), taskId: work.id, taskDigest: taskVersion(work), status: 'pending',
      scope: { consumer: { taskId: core.id, taskDigest: taskVersion(core) } } } as NextCheckRecord;
    const clock = observer(tasks, [work.id]);
    clock.observe(0, tasks, [work.id], [record]);
    expect(clock.observe(interval, tasks, [work.id], [record]).requested).toBe(true);
    clock.observe(interval, tasks, [work.id], [{ ...record, status: 'stale' }]);
    expect(clock.state.goals[0]!.active).toBe(false);
  });

  it('keeps the core clock running through useful conditional connections and resets on actual frontier closure', () => {
    const core = lemma('core'), target = goal('goal', ['bridge']);
    const tasks = [node(core), node(lemma('bridge', [core.id])), node(target), node(research())];
    const clock = observer(tasks); clock.observe(0);
    for (let index = 1; index <= 3; index++) {
      const bridge = { ...tasks[1]!.task, type: `True${' ∧ True'.repeat(index)}`, revision: index };
      tasks[1] = { ...node(bridge), status: 'conditional', proof: proof(bridge, [{ taskId: core.id, taskDigest: taskVersion(core) }]) };
      const result = clock.observe(index * interval / 3);
      expect(clock.state.goals[0]!.activeMs).toBe(0);
      expect(clock.state.goals[0]!.coreActiveMs).toBe(index * interval / 3);
      expect(result.requested).toBe(index === 3);
    }
    expect(clock.state.goals[0]!.seenEvidence).toHaveLength(3);
    expect(clock.state.goals[0]!.coreSeenEvidence).toEqual([]);
    const checked = proof(core); tasks[0] = { ...node(core), status: 'integrated', proof: checked, integratedCheck: checked };
    clock.observe(interval + 1);
    expect(clock.state.goals[0]).toMatchObject({ coreActiveMs: 0, lastCoreProgressAt: interval + 1, closed: false });
    expect(clock.state.goals[0]!.coreSeenEvidence).toHaveLength(1);
    expect(clock.state.pending).toBeUndefined();
  });

  it('does not treat a changed contract or replayed closure as another core breakthrough', () => {
    const core = lemma('core'), tasks = [node(core), node(goal()), node(research())];
    const clock = observer(tasks); clock.observe(0);
    const weakened = { ...core, type: 'True ∨ False', revision: 1 }, weakProof = proof(weakened);
    tasks[0] = { ...node(weakened), status: 'integrated', proof: weakProof, integratedCheck: weakProof };
    clock.observe(100);
    expect(clock.state.goals[0]).toMatchObject({ coreActiveMs: 100, coreSeenEvidence: [] });
    tasks[0] = node(core); clock.observe(100);
    const checked = proof(core); tasks[0] = { ...node(core), status: 'integrated', proof: checked, integratedCheck: checked };
    clock.observe(200);
    expect(clock.state.goals[0]!.coreSeenEvidence).toHaveLength(1);
    tasks[0] = node(core); clock.observe(300);
    tasks[0] = { ...node(core), status: 'integrated', proof: checked, integratedCheck: checked };
    clock.observe(400);
    expect(clock.state.goals[0]).toMatchObject({ coreActiveMs: 200, lastCoreProgressAt: 200 });
  });

  it('keeps paused and offline time out, and initializes old checkpoints without inventing core history', () => {
    const tasks = [node(lemma('core')), node(goal()), node(research())], clock = observer(tasks);
    clock.observe(0); clock.observe(100, tasks, []); clock.observe(interval * 2, tasks, []);
    expect(clock.state.goals[0]!.coreActiveMs).toBe(100);
    resetGoalProgressClock(clock.state, interval * 3);
    clock.observe(interval * 4);
    expect(clock.state.goals[0]!.coreActiveMs).toBe(100);
    const old = clock.state.goals[0]!;
    delete old.coreActiveMs; delete old.coreSeenEvidence; delete old.coreFrontier; delete old.lastReviewedCoreMs;
    resetGoalProgressClock(clock.state, interval * 5); clock.observe(interval * 6);
    expect(clock.state.goals[0]).toMatchObject({ activeMs: 100, coreActiveMs: 0, coreSeenEvidence: [] });
  });
});

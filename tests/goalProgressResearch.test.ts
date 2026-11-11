import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { type CooperativeResearch } from '../src/solver/cooperation';
import type { TaskProof } from '../src/solver/cooperativeProof';
import { answerGoalProgress, GOAL_PROGRESS_REVIEW_MS as interval, goalProgressForTask, goalProgressStateSchema,
  goalProgressTaskContext, observeGoalProgress, parseGoalProgressDecision, prepareGoalProgressDecision,
  resetGoalProgressClock, type GoalProgressState } from '../src/solver/goalProgress';
import { buildResearchContext } from '../src/solver/modules/context';
import type { NextCheckRecord } from '../src/solver/nextCheckContract';
import { captureObligationSnapshot } from '../src/solver/obligationProgress';
import { leadPlanningEvidence, leadPlanningEvidenceText } from '../src/solver/planningEvidence';
import { leadPlanDeliveryFile, markTaskAcceptance, parseCooperationPlan, taskVersion, type CooperativeTask, type TaskRecord } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';
import { receiptBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ createSession: vi.fn() }));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.createSession }));
const roots: string[] = [];
const running: { cooperation: CooperativeResearch; controller: AbortController }[] = [];
afterEach(async () => {
  for (const item of running.splice(0)) { item.controller.abort(); await item.cooperation.stop(); }
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

describe('executable goal reviews', () => {
  it.each([false, true])('accepts a live Lead plan after peer proof progress supersedes its review (new review: %s)', async replacement => {
    const example = localExample('goal-review-race-'); roots.push(example.directory);
    const lead = leadWorker(example.problem, example.workspace), peer = peerWorker(example, 'peer');
    const originals = example.problem.targets.map((target, index) => ({ ...target, id: `goal_${index}`, kind: 'goal' as const,
      objective: `Prove ${target.theoremName}`, dependsOn: index === 0 ? ['core'] : [], revision: 0,
      ...(index ? { status: 'paused' as const } : {}) }));
    const core = { ...lemma('core'), theoremName: 'Tutorial.core', status: 'paused' as const };
    const work = { ...research('research', [originals[0]!.id]), ownerId: peer.id };
    const plan = parseCooperationPlan(example.problem, { tasks: [...originals, core, work] });
    const state = solverState(example.problem, example.workspace, { runId: 'review-race', phase: 'running',
      cooperation: { tasks: plan.tasks.map(node), canonicalCommit: example.problem.baseCommit,
        groups: plan.groups.map(group => ({ group, turns: 0 })) } });
    const events: string[] = [], controller = new AbortController();
    let now = 0; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const cooperation = cooperativeResearch({ state, workers: [lead, peer], retrievalRoot: example.directory,
      signal: controller.signal, emit: event => events.push(event) }); running.push({ cooperation, controller });
    const budget = { maxTurns: Infinity, remainingMs: Infinity };
    const workAction = await cooperation.next(peer, budget);
    if (workAction?.kind !== 'task' || workAction.task.id !== work.id) throw new Error('missing research assignment');
    expect(cooperation.started(peer, workAction)).toBe(true);
    cooperation.activate(peer, workAction, async () => {}, async () => {});
    (cooperation as any).changed(); now = interval; (cooperation as any).changed();
    const oldReview = state.cooperation!.goalProgress!.pending!.id;
    const leadAction = await cooperation.next(lead, budget);
    if (leadAction?.kind !== 'lead') throw new Error('missing Lead review');
    expect(cooperation.contextState(leadAction, lead).goalProgress!.pending!.id).toBe(oldReview);
    expect(cooperation.started(lead, leadAction)).toBe(true);
    cooperation.activate(lead, leadAction, async () => {}, async () => {});
    const reminder = cooperation.leadCheckpointInstruction(leadAction);
    expect(reminder).toContain('Include progressReview with id ' + JSON.stringify(oldReview));
    expect(reminder).toContain('nextChecks covering every reviewed goal: ["goal_0"]');
    expect(reminder).not.toContain('return without a revision');

    // Another worker's checked receipt reaches the archive while the Lead is still composing this plan.
    const checked = proof(core);
    checked.projection = { environmentDigest: state.environmentDigest, problemReceiptDigest: example.problem.receiptDigest,
      sourceDigest: 'fixture-source' };
    checked.references = { root: { file: core.proofPath!, name: core.theoremName! }, sourceCommit: example.problem.baseCommit,
      environmentDigest: state.environmentDigest, contextDigest: 'fixture-context', inputs: [], tasks: [], statement: [], proof: [] };
    const index = state.cooperation!.tasks.findIndex(item => item.task.id === core.id);
    state.cooperation!.tasks[index] = { ...node(core), status: 'integrated', proof: checked, integratedCheck: checked };
    now++; (cooperation as any).changed();
    expect(state.cooperation!.goalProgress!.pending).toBeUndefined();
    expect(state.cooperation!.goalProgress!.goals[0]!.coreSeenEvidence).toHaveLength(1);
    if (replacement) { now += interval; (cooperation as any).changed(); }
    const nextReview = state.cooperation!.goalProgress!.pending?.id;
    if (replacement) expect(nextReview).not.toBe(oldReview);
    const settledReminder = cooperation.leadCheckpointInstruction(leadAction);
    expect(settledReminder).toContain('return without a revision');
    expect(settledReminder).not.toContain('Include progressReview');
    expect(settledReminder).not.toContain(oldReview);
    if (nextReview) expect(settledReminder).not.toContain(nextReview);

    fs.appendFileSync(path.join(lead.worktree, leadPlanDeliveryFile(leadAction)!), JSON.stringify({ kind: 'plan',
      dispatchNonce: leadAction.planNonce, baseVersion: leadAction.planVersion,
      upsert: [{ id: work.id, informalProof: 'Use the newly checked input in the next construction.' }],
      progressReview: { id: oldReview, reason: 'Continue with the planned check.', nextChecks: [check(core)] } }) + '\n');
    await cooperation.pulse(lead.id);
    expect(state.cooperation!.planPublicationRejection).toBeUndefined();
    expect(events).toContain('plan_published');
    expect(state.cooperation!.tasks.find(item => item.task.id === work.id)!.task.informalProof)
      .toBe('Use the newly checked input in the next construction.');
    expect(state.cooperation!.goalProgress!.pending?.id).toBe(nextReview);
    expect(state.cooperation!.goalProgress!.decisions ?? []).toEqual([]);
    expect(events).not.toContain('goal_progress_review_answered');
  });

  it('requires concrete active tasks serving every reviewed goal and records guidance without resetting core stagnation', () => {
    const tasks = [node(lemma('core')), node(goal()), node(research())], clock = observer(tasks);
    clock.observe(0); clock.observe(interval);
    const request = { progressReview: { id: clock.state.pending!.id, reason: 'Test the unresolved construction.', nextChecks: [check(tasks[0]!.task)] } };
    expect(() => parseGoalProgressDecision({ progressReview: { id: request.progressReview.id, reason: 'Keep going.' } })).toThrow('nextChecks');
    expect(parseGoalProgressDecision({ progressReview: { id: request.progressReview.id, reason: 'Keep going.' } }, true)).toBeUndefined();
    const parsed = parseGoalProgressDecision(request)!;
    const plan = { tasks: tasks.map(item => item.task), groups: [] };
    const prepared = prepareGoalProgressDecision(parsed, clock.state, plan);
    expect(prepared.nextChecks[0]!.taskDigest).toBe(taskVersion(tasks[0]!.task));
    expect(() => prepareGoalProgressDecision({ ...parsed, nextChecks: [check(lemma('unrelated'))] }, clock.state,
      { ...plan, tasks: [...plan.tasks, lemma('unrelated')] })).toThrow('task_unavailable');
    expect(() => prepareGoalProgressDecision(parsed, clock.state, { ...plan,
      tasks: plan.tasks.map(task => task.id === 'core' ? { ...task, status: 'paused' } : task) })).toThrow('task_unavailable');
    expect(() => prepareGoalProgressDecision(parsed, clock.state, plan, [],
      tasks.map(item => item.task.id === 'core' ? { ...item, status: 'integrated' } : item))).toThrow('task_unavailable');
    const evidence = structuredClone(clock.state.goals[0]!.seenEvidence);
    expect(answerGoalProgress(clock.state, prepared, interval)).toBe(true);
    expect(clock.state.goals[0]).toMatchObject({ coreActiveMs: interval, lastReviewedCoreMs: interval, seenEvidence: evidence });
    expect(clock.observe(interval).requested).toBe(false);
    expect(clock.observe(2 * interval - 1).requested).toBe(false);
    expect(clock.observe(2 * interval).requested).toBe(true);
    expect(goalProgressTaskContext(clock.state, tasks[0]!.task)).toContain(prepared.nextChecks[0]!.expectedEvidence);
    expect(goalProgressTaskContext(clock.state, { ...tasks[0]!.task, type: 'False', revision: 1 })).toBe('');
  });

  it('reports the uncovered independent goal while allowing one shared check to cover multiple goals', () => {
    const shared = lemma('shared'), independent = goal('independent', []);
    const tasks = [node(shared), node(goal('left', [shared.id])), node(goal('right', [shared.id])), node(independent)];
    const clock = observer(tasks, [shared.id, independent.id]);
    clock.observe(0); clock.observe(interval);
    expect(clock.state.pending!.goalIds).toEqual(['left', 'right', 'independent']);
    const plan = { tasks: tasks.map(item => item.task), groups: [] };
    const decision = { id: clock.state.pending!.id, reason: 'Check the shared estimate and retain the independent proof.',
      nextChecks: [check(shared)] };
    expect(() => prepareGoalProgressDecision(decision, clock.state, plan))
      .toThrow('math_plan_progress_review_goal_unanswered: independent');
    const prepared = prepareGoalProgressDecision({ ...decision, nextChecks: [...decision.nextChecks, check(independent)] },
      clock.state, plan);
    expect(prepared.nextChecks.map(item => item.targetTaskId)).toEqual(['shared', 'independent']);
    expect(plan.tasks.map(task => task.dependsOn)).toEqual([[], ['shared'], ['shared'], []]);
    const prompt = leadPlanningEvidenceText(leadPlanningEvidence({ tasks, goalProgress: clock.state }));
    expect(prompt).toContain('nextChecks must cover every reviewed goal');
    expect(prompt).toContain('One check may cover multiple goals through recorded dependencies');
    expect(prompt).toContain('do not invent connections merely to satisfy coverage');
  });

  it('preserves old reason-only records but exposes only exact bound directions to each worker', () => {
    const tasks = [node(lemma('core')), node(goal()), node(research())], clock = observer(tasks);
    clock.observe(0); clock.observe(interval);
    const pending = clock.state.pending!;
    clock.state.decisions = [{ id: 'legacy', at: 0, reason: 'Keep going.', goalKeys: pending.goalKeys }];
    const bound = prepareGoalProgressDecision({ id: pending.id, reason: 'Check the next inference.', nextChecks: [check(tasks[0]!.task)] },
      clock.state, { tasks: tasks.map(item => item.task), groups: [] });
    answerGoalProgress(clock.state, bound, interval);
    const restored = goalProgressStateSchema.parse(JSON.parse(JSON.stringify(clock.state)));
    expect(restored).toEqual(clock.state);
    const scoped = goalProgressForTask(restored, tasks[0]!.task)!;
    expect(scoped.goals).toEqual([]); expect(scoped.pending).toBeUndefined(); expect(scoped.decisions).toHaveLength(1);
    expect(goalProgressForTask(restored, research())).toBeUndefined();
  });

  it('assigns fallback research to its covered original goals and notifies an active task of an accepted check', async () => {
    const example = localExample('goal-review-fallback-'); roots.push(example.directory);
    const lead = leadWorker(example.problem, example.workspace), peer = peerWorker(example, 'peer');
    const state = solverState(example.problem, example.workspace, { runId: 'review-fallback', phase: 'running' });
    const controller = new AbortController(), cooperation = cooperativeResearch({ state, workers: [lead, peer],
      retrievalRoot: example.directory, signal: controller.signal }); running.push({ cooperation, controller });
    await cooperation.startInitialTasks();
    const work = state.cooperation!.tasks.find(item => item.task.kind === 'research')!.task;
    expect(work.consumerGoalIds).toEqual(state.cooperation!.tasks.filter(item => item.task.kind === 'goal').map(item => item.task.id));
    const target = state.cooperation!.tasks.find(item => item.task.kind === 'goal')!.task;
    expect(target.dependsOn).not.toContain(work.id);
    const clock = observer(state.cooperation!.tasks, [work.id]); clock.observe(0); clock.observe(interval);
    state.cooperation!.goalProgress = clock.state;
    const action = { kind: 'task' as const, task: work, assignment: { taskId: work.id, taskDigest: taskVersion(work),
      workerId: peer.id, seedCommit: example.problem.baseCommit, dependencies: [] } };
    const record = state.cooperation!.tasks.find(item => item.task.id === work.id)!;
    record.assignment = action.assignment;
    const notify = vi.fn(async () => {});
    (cooperation as any).active.set(peer.id, { action, notify, interrupt: async () => {} });
    const decision = prepareGoalProgressDecision({ id: clock.state.pending!.id, reason: 'Use the recorded finite input.', nextChecks: [check(work)] },
      clock.state, { tasks: state.cooperation!.tasks.map(item => item.task), groups: state.cooperation!.groups!.map(item => item.group) });
    const leadAction = { kind: 'lead' as const, seedCommit: example.problem.baseCommit };
    (cooperation as any).presentedGoalProgress.set(leadAction, decision.id);
    (cooperation as any).goalProgressDecisions.set(leadAction, decision);
    (cooperation as any).answerGoalProgressReview(leadAction);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0]).toContain(decision.nextChecks[0]!.expectedEvidence);
    (cooperation as any).active.delete(peer.id);
  });

  it('preserves attribution as metadata, validates original-goal references, and delivers saved checks in mandatory context', async () => {
    const example = localExample('goal-progress-review-'); roots.push(example.directory);
    const originals = example.problem.targets.map((target, index) => ({ ...target, id: `goal_${index}`, kind: 'goal' as const,
      objective: `Prove ${target.theoremName}`, dependsOn: [], revision: 0 }));
    const work = research('research', [originals[0]!.id]);
    const plan = parseCooperationPlan(example.problem, { tasks: [...originals, work] });
    expect(taskVersion(work)).toBe(taskVersion({ ...work, consumerGoalIds: [] }));
    expect(plan.tasks.at(-1)!.consumerGoalIds).toEqual([originals[0]!.id]);
    expect(() => parseCooperationPlan(example.problem, { tasks: [...originals, { ...work, consumerGoalIds: ['research'] }] })).toThrow('consumerGoalIds');
    const records = plan.tasks.map(node), clock = observer(records); clock.observe(0); clock.observe(interval);
    const bound = prepareGoalProgressDecision({ id: clock.state.pending!.id, reason: 'Investigate the boundary case.', nextChecks: [check(work)] }, clock.state, plan);
    answerGoalProgress(clock.state, bound, interval);
    const lead = leadWorker(example.problem, example.workspace), peer = peerWorker(example, 'peer');
    const state = solverState(example.problem, example.workspace, { runId: 'review-context', phase: 'running',
      cooperation: { tasks: records, canonicalCommit: example.problem.baseCommit, goalProgress: clock.state,
        groups: plan.groups.map(group => ({ group, turns: 0 })) } });
    // Persist and re-read through the real checkpoint schema before constructing the next dispatch.
    const file = path.join(example.directory, 'state.json'); writeSolverRunState(file, state);
    const restored = readSolverRunState(file);
    const controller = new AbortController(), cooperation = cooperativeResearch({ state: restored, workers: [lead, peer],
      retrievalRoot: example.directory, signal: controller.signal }); running.push({ cooperation, controller });
    const action = { kind: 'task' as const, task: work, assignment: { taskId: work.id, taskDigest: taskVersion(work),
      workerId: peer.id, seedCommit: example.problem.baseCommit, dependencies: [] } };
    const scoped = cooperation.contextState(action, peer);
    expect(scoped.goalProgress?.decisions?.[0]?.nextChecks?.[0]?.targetTaskId).toBe(work.id);
    const context = buildResearchContext(example.problem, { ...restored, cooperation: scoped }, { root: example.directory,
      worktree: peer.worktree, environment: {}, taskText: 'Prove the frozen goal.', retrievalRoot: example.directory,
      assignment: action, maxOptionalContextBytes: 0 });
    expect(context.manifest?.included).toContainEqual(expect.objectContaining({ id: 'goal-review-next-checks', required: true }));
    expect(context.message).toContain(bound.nextChecks[0]!.expectedEvidence);
    expect(context.continuationMessage).toContain(bound.nextChecks[0]!.expectedEvidence);
  });
});

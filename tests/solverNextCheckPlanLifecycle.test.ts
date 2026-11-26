import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { currentNextCheck } from '../src/solver/nextChecks';
import { commitSolverSources } from '../src/solver/problem';
import { parseCooperationPlan, taskVersion } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

const host = vi.hoisted(() => ({ createSession: vi.fn() }));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.createSession }));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  expect(host.createSession).not.toHaveBeenCalled(); host.createSession.mockReset();
});

async function fixture(routes = false) {
  const example = localExample('next-check-plan-lifecycle-');
  const lead = leadWorker(example.problem, example.workspace);
  const author = peerWorker(example, 'author'), checker = peerWorker(example, 'checker');
  const proofPath = example.problem.targets[0].proofPath;
  const plan = parseCooperationPlan(example.problem, { tasks: [
    ...example.problem.targets.map((target, index) => ({ ...target, id: `goal_${index}`, kind: 'goal',
      objective: 'Prove the original target.', ...(index ? { status: 'paused' } : { dependsOn: routes ? [] : ['left', 'right'] }) })),
    { id: 'witness', kind: 'lemma', declaration: 'definition', objective: 'Construct the shared witness.',
      theoremName: 'sharedWitness', type: 'ℕ', proofPath, ownerId: author.id },
    ...['left', 'right'].map(id => ({ id, kind: 'lemma', objective: `Apply the witness to ${id}.`,
      theoremName: `shared_${id}`, type: 'True', proofPath, dependsOn: ['witness'] })),
  ], ...(routes ? { proofRoutes: ['left', 'right'].map(id => ({ id: `${id}_route`, targetTaskId: 'goal_0',
    closingTaskId: id, prerequisiteTaskIds: ['witness'] })) } : {}) });
  const state = solverState(example.problem, example.workspace, { runId: 'next-check-plan-fixture', phase: 'running',
    cooperation: { canonicalCommit: example.problem.baseCommit, proofRoutes: plan.proofRoutes,
      tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
      groups: plan.groups.map(group => ({ group, turns: 0 })) } });
  const controller = new AbortController(), events: string[] = [];
  const cooperation = cooperativeResearch({ state, workers: [lead, author, checker], retrievalRoot: example.directory,
    signal: controller.signal, emit: event => events.push(event) });
  cleanup.push(async () => { controller.abort(); await cooperation.stop(); fs.rmSync(example.directory, { recursive: true, force: true }); });
  await cooperation.restore();
  const acceptPlan = (next: typeof plan) => (cooperation as unknown as {
    acceptPlan(plan: typeof next): Promise<void>;
  }).acceptPlan(next);
  const identity = { problemReceiptDigest: example.problem.receiptDigest, environmentDigest: state.environmentDigest };
  return { state, plan, cooperation, lead, checker, problem: example.problem, acceptPlan, identity, events };
}

it('requires the presented check outcome decision even when a checkpoint inherits an unchanged graph', async () => {
  const f = await fixture(), archive = f.state.cooperation!, record = archive.nextChecks![0];
  record.status = 'awaiting-decision';
  record.outcome = { checkId: record.id, deliveryId: 'definition-outcome', conclusion: 'inconclusive',
    summary: 'The definition still needs its characterizing estimate.', evidenceRefs: ['retained-check-notes'] };
  archive.tasks.find(node => node.task.id === record.taskId)!.status = 'completed';
  const budget = { maxTurns: Infinity, remainingMs: Infinity };
  const start = async () => {
    const action = await f.cooperation.next(f.lead, budget);
    if (action?.kind !== 'lead') throw new Error('fixture_expected_lead_decision');
    f.cooperation.contextState(action, f.lead);
    expect(f.cooperation.started(f.lead, action)).toBe(true);
    f.cooperation.activate(f.lead, action, async () => {}, async () => {});
    return action;
  };
  const notes = path.join(f.lead.worktree, 'RESEARCH.md');
  fs.writeFileSync(notes, '```math-plan\n' + JSON.stringify(f.plan) + '\n```\n');
  const first = await start();
  const reminder = f.cooperation.leadCheckpointInstruction(first);
  expect(reminder).toContain('nextCheckDecisions');
  expect(reminder).toContain(JSON.stringify({ checkId: record.id, outcomeDeliveryId: record.outcome.deliveryId }));
  expect(reminder).not.toContain('return without a revision');
  const shownOutcome = record.outcome;
  record.outcome = { ...shownOutcome, deliveryId: 'later-definition-outcome' };
  expect(f.cooperation.leadCheckpointInstruction(first)).not.toContain('nextCheckDecisions');
  record.outcome = shownOutcome;
  await f.cooperation.deliver(f.lead, first, first.seedCommit, true, 'scheduling-checkpoint');
  f.cooperation.deactivate(f.lead);
  expect(archive.error).toContain('math_plan_next_check_decision_required');
  expect(archive.lastLeadPauseInputDigest).toBeUndefined();
  expect(record.status).toBe('awaiting-decision');
  const next = await start();
  fs.writeFileSync(notes, '```math-plan\n' + JSON.stringify({ baseVersion: next.planVersion, upsert: [],
    nextCheckDecisions: [{ checkId: record.id, outcomeDeliveryId: record.outcome.deliveryId,
      action: 'continue', reason: 'Continue the separately assigned estimate while retaining the unresolved check.' }] }) + '\n```\n');
  await f.cooperation.deliver(f.lead, next, commitSolverSources(f.problem, f.lead.worktree), true, 'scheduling-checkpoint');
  f.cooperation.deactivate(f.lead);
  expect(record.status).toBe('decided');
  expect(archive.error).toBeUndefined();
  expect(archive.lastLeadPauseInputDigest).toBeUndefined();
  expect(f.cooperation.leadCheckpointInstruction(next)).toContain('return without a revision');
});

it('preserves the host check and its dispatch identity across a group revision', async () => {
  const f = await fixture(), record = f.state.cooperation!.nextChecks![0];
  const changed = structuredClone(f.plan);
  changed.groups[0].revision++;
  await f.acceptPlan(changed);
  expect(f.state.cooperation!.nextChecks).toHaveLength(1);
  expect(record.status).toBe('pending');
  expect(currentNextCheck(record, f.state.cooperation!, f.identity)).toBe(true);
  expect(f.state.cooperation!.tasks.filter(node => node.task.id === record.taskId))
    .toEqual([expect.objectContaining({ nextCheckId: record.id, status: 'pending' })]);
  const action = await f.cooperation.next(f.checker, { maxTurns: Infinity, remainingMs: Infinity });
  expect(action?.kind === 'task' && action.task.id).toBe(record.taskId);
  expect(action && f.cooperation.started(f.checker, action)).toBe(true);
  expect(f.events).not.toContain('next_check_expired');
  expect(f.state.cooperation!.invalidTaskTransitions ?? []).toEqual([]);
});

it('redispatches an unfinished gap check from a fresh report after a group revision', async () => {
  const example = localExample('next-check-gap-lifecycle-');
  const lead = leadWorker(example.problem, example.workspace);
  const author = peerWorker(example, 'author'), checker = peerWorker(example, 'checker'), prover = peerWorker(example, 'prover');
  const plan = parseCooperationPlan(example.problem, { tasks: [
    ...example.problem.targets.map((target, index) => ({ ...target, id: `goal_${index}`, kind: 'goal',
      objective: 'Prove the original target.', ownerId: prover.id })),
    { id: 'survey', kind: 'research', objective: 'Study the missing step.', ownerId: author.id },
  ] });
  const state = solverState(example.problem, example.workspace, { runId: 'next-check-gap-fixture', phase: 'running',
    cooperation: { canonicalCommit: example.problem.baseCommit,
      tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
      groups: plan.groups.map(group => ({ group, turns: 0 })) } });
  const controller = new AbortController();
  const cooperation = cooperativeResearch({ state, workers: [lead, author, checker, prover], retrievalRoot: example.directory,
    signal: controller.signal });
  cleanup.push(async () => { controller.abort(); await cooperation.stop(); fs.rmSync(example.directory, { recursive: true, force: true }); });
  await cooperation.restore();
  const budget = { maxTurns: Infinity, remainingMs: Infinity };
  const archive = state.cooperation!, target = plan.tasks.find(task => task.id === 'goal_0')!;
  const mathematicalGap = {
    consumer: { taskId: target.id, taskDigest: taskVersion(target) }, previousGap: 'Missing the main inference.',
    remaining: 'Connect the estimates.', reduced: 'The estimates are stated.', evidenceScope: 'Current goal.',
    reconsiderWhen: [], nextCheck: { action: 'feasibility', objective: 'Check the remaining inference.',
      expectedEvidence: 'Find an exact missing premise.' },
  };
  const report = async (summary: string) => {
    const action = await cooperation.next(author, budget);
    if (action?.kind !== 'task' || action.task.id !== 'survey') throw new Error('fixture_expected_survey');
    expect(cooperation.started(author, action)).toBe(true);
    fs.writeFileSync(path.join(author.worktree, 'RESEARCH.md'), JSON.stringify({ summary, conclusion: 'inconclusive', mathematicalGap }));
    await cooperation.deliver(author, action, commitSolverSources(example.problem, author.worktree));
    return archive.deliveries!.at(-1)!;
  };

  const firstDelivery = await report('First delivery.');
  const record = archive.nextChecks![0];
  expect(record).toMatchObject({ status: 'pending', gapDeliveryId: firstDelivery.id });
  const firstAssignment = await cooperation.next(checker, budget);
  if (firstAssignment?.kind !== 'task') throw new Error('fixture_expected_gap_check');
  expect(firstAssignment.task.id).toBe(record.taskId);
  const revised = structuredClone(plan);
  revised.groups[0].revision++;
  await (cooperation as unknown as { acceptPlan(plan: typeof revised): Promise<void> }).acceptPlan(revised);
  expect(firstDelivery.status).toBe('superseded');
  expect(record.status).toBe('stale');

  const freshDelivery = await report('Updated notes on the same question.');
  expect(archive.nextChecks).toHaveLength(1);
  expect(record).toMatchObject({ status: 'pending', gapDeliveryId: freshDelivery.id });
  const reassignment = await cooperation.next(checker, budget);
  expect(reassignment).toMatchObject({ kind: 'task', task: { id: record.taskId } });
  expect(reassignment?.kind === 'task' && reassignment.assignment.assignmentId).not.toBe(firstAssignment.assignment.assignmentId);
  expect(archive.invalidTaskTransitions ?? []).toEqual([]);
});

it('expires a changed exact definition contract without leaving an ordinary orphan task', async () => {
  const f = await fixture(), previous = f.state.cooperation!.nextChecks![0];
  const changed = structuredClone(f.plan), target = changed.tasks.find(task => task.id === 'witness')!;
  target.type = 'ℤ'; target.revision++;
  await f.acceptPlan(changed);
  expect(previous.status).toBe('stale');
  expect(currentNextCheck(previous, f.state.cooperation!, f.identity)).toBe(false);
  expect(f.state.cooperation!.tasks.some(node => node.task.id === previous.taskId)).toBe(false);
  const current = f.state.cooperation!.nextChecks!.filter(record => record.status === 'pending');
  expect(current).toHaveLength(1);
  expect(current[0].id).not.toBe(previous.id);
  expect(currentNextCheck(current[0], f.state.cooperation!, f.identity)).toBe(true);
  expect(f.state.cooperation!.tasks.filter(node => node.nextCheckId)).toHaveLength(1);
  expect(f.state.cooperation!.invalidTaskTransitions ?? []).toEqual([]);
});

it('uses the proposed group status and resumes one record when the group reopens', async () => {
  const f = await fixture(), record = f.state.cooperation!.nextChecks![0];
  const paused = structuredClone(f.plan); paused.groups[0].status = 'paused';
  await f.acceptPlan(paused);
  expect(record.status).toBe('stale');
  expect(f.state.cooperation!.tasks.some(node => node.task.id === record.taskId)).toBe(false);
  await f.acceptPlan(structuredClone(f.plan));
  expect(record.status).toBe('pending');
  expect(f.state.cooperation!.nextChecks).toHaveLength(1);
  expect(f.state.cooperation!.tasks.filter(node => node.task.id === record.taskId))
    .toEqual([expect.objectContaining({ nextCheckId: record.id, status: 'pending' })]);
  expect(currentNextCheck(record, f.state.cooperation!, f.identity)).toBe(true);
  expect(f.state.cooperation!.invalidTaskTransitions ?? []).toEqual([]);
});

it('expires a pending check when the accepted plan removes its only proof routes', async () => {
  const f = await fixture(true), record = f.state.cooperation!.nextChecks![0];
  const changed = structuredClone(f.plan); changed.proofRoutes = [];
  await f.acceptPlan(changed);
  expect(record.status).toBe('stale');
  expect(currentNextCheck(record, f.state.cooperation!, f.identity)).toBe(false);
  expect(f.state.cooperation!.tasks.some(node => node.task.id === record.taskId)).toBe(false);
  expect(f.state.cooperation!.nextChecks).toHaveLength(1);
  expect(f.state.cooperation!.invalidTaskTransitions ?? []).toEqual([]);
});

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { parseLeadPlan } from '../src/solver/cooperationShared';
import { currentNextCheck, prepareNextCheckDecisions } from '../src/solver/nextChecks';
import { buildResearchContext } from '../src/solver/modules/context';
import { commitSolverSources } from '../src/solver/problem';
import { prepareResearchDelivery } from '../src/solver/researchAdmission';
import { researchCheckpointLocalInputDigest } from '../src/solver/researchCheckpoints';
import { queueResearchObservation } from '../src/solver/researchObservation';
import { assignmentDeliveryFile, leadPlanDeliveryFile, parseCooperationPlan, taskVersion, type CooperativeAction } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

const host = vi.hoisted(() => ({ createSession: vi.fn() }));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.createSession }));
const instances: { stop: () => Promise<void>; directory?: string }[] = [];
afterEach(async () => {
  for (const item of instances.splice(0).reverse()) { await item.stop(); if (item.directory) fs.rmSync(item.directory, { recursive: true, force: true }); }
  expect(host.createSession).not.toHaveBeenCalled(); host.createSession.mockReset();
});

async function fixture(constructionDependencies = ['goal_0']) {
  const example = localExample('scoped-next-check-'), lead = leadWorker(example.problem, example.workspace);
  const author = peerWorker(example, 'author'), checker = peerWorker(example, 'checker');
  const plan = parseCooperationPlan(example.problem, { tasks: [
    ...example.problem.targets.map((target, index) => ({ ...target, id: `goal_${index}`, kind: 'goal', objective: 'Prove the original target.', status: 'paused' })),
    { id: 'construction', kind: 'research', objective: 'Find the missing construction.', ownerId: author.id, dependsOn: constructionDependencies },
  ] });
  const state = solverState(example.problem, example.workspace, { runId: 'next-check-fixture', phase: 'running',
    cooperation: { canonicalCommit: example.problem.baseCommit, tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
      groups: plan.groups.map(group => ({ group, turns: 0 })) } });
  const controller = new AbortController(), events: string[] = [];
  const cooperation = cooperativeResearch({ state, workers: [lead, author, checker], retrievalRoot: example.directory,
    signal: controller.signal, emit: event => events.push(event) });
  instances.push({ directory: example.directory, stop: async () => { controller.abort(); await cooperation.stop(); } });
  const action = await cooperation.next(author, { maxTurns: Infinity, remainingMs: Infinity });
  if (action?.kind !== 'task') throw new Error('missing author assignment');
  expect(cooperation.started(author, action)).toBe(true);
  cooperation.activate(author, action, async () => {}, async () => {});
  const goal = state.cooperation!.tasks.find(node => node.task.id === 'goal_0')!.task;
  const gap = { consumer: { taskId: goal.id, taskDigest: taskVersion(goal) }, previousGap: 'The construction needs a missing membership fact.',
    reduced: 'The candidate operator is defined.', remaining: 'Prove membership in the original algebra.',
    evidenceScope: 'Only the stated construction and current assumptions.', reconsiderWhen: ['A valid membership argument.'],
    nextCheck: { action: 'construction-check' as const, objective: 'Test whether the construction belongs to the required algebra.',
      expectedEvidence: 'A scoped application with its assumptions, or the exact unsupported inference.', targetTaskId: 'construction' } };
  const publishGap = async (summary = 'Check the hardest membership premise.') => {
    queueResearchObservation({ worktree: author.worktree, finding: { summary, mathematicalGap: gap } });
    await cooperation.pulse(author.id);
    return state.cooperation!.nextChecks![0]!;
  };
  const record = await publishGap();
  const identity = { problemReceiptDigest: example.problem.receiptDigest, environmentDigest: state.environmentDigest };
  const publishOutcome = async (beforePublish?: (action: Extract<CooperativeAction, { kind: 'task' }>) => void) => {
    const checkAction = await cooperation.next(checker, { maxTurns: Infinity, remainingMs: Infinity });
    if (checkAction?.kind !== 'task') throw new Error('missing check assignment');
    expect(checkAction.task.id).toBe(record.taskId);
    expect(cooperation.started(checker, checkAction)).toBe(true);
    cooperation.activate(checker, checkAction, async () => {}, async () => {});
    beforePublish?.(checkAction);
    queueResearchObservation({ worktree: checker.worktree, finding: { summary: 'The membership inference is still unknown.',
      checkOutcome: { checkId: record.id, conclusion: 'inconclusive', summary: 'The available assumptions do not yet provide a membership argument.', evidenceRefs: [] } } });
    await cooperation.pulse(checker.id);
    return checkAction;
  };
  const leadDecision = async () => {
    const leadAction = await cooperation.next(lead, { maxTurns: Infinity, remainingMs: Infinity });
    if (leadAction?.kind !== 'lead') throw new Error('missing Lead decision');
    const view = cooperation.contextState(leadAction, lead);
    expect(cooperation.started(lead, leadAction)).toBe(true);
    cooperation.activate(lead, leadAction, async () => {}, async () => {});
    const publish = async (decisions?: unknown[]) => {
      fs.appendFileSync(path.join(lead.worktree, leadPlanDeliveryFile(leadAction)!), JSON.stringify({ kind: 'plan',
        dispatchNonce: leadAction.planNonce, baseVersion: leadAction.planVersion, upsert: [],
        ...(decisions ? { nextCheckDecisions: decisions } : {}) }) + '\n');
      await cooperation.pulse(lead.id);
    };
    return { leadAction, view, publish };
  };
  return { ...example, lead, author, checker, workers: [lead, author, checker], state, cooperation, controller,
    action, gap, record, identity, events, publishGap, publishOutcome, leadDecision };
}

describe('scoped next check lifecycle', () => {
  it.each(['live', 'legacy restart'] as const)('keeps a parked check paused through progress rephrasing and resumes it on new evidence (%s)', async mode => {
    const f = await fixture([]), budget = { maxTurns: Infinity, remainingMs: Infinity };
    let state = f.state.cooperation!, check = state.tasks.find(node => node.nextCheckId === f.record.id)!;
    let cooperation = f.cooperation, assignment = f.action.assignment;
    const progress = async (summary: string, evidenceRefs?: string[]) => {
      const log = path.join(f.author.worktree, assignmentDeliveryFile(assignment));
      fs.appendFileSync(log, JSON.stringify({ kind: 'progress', summary, evidenceRefs }) + '\n');
      await cooperation.pulse(f.author.id);
      expect(state.deliveries!.at(-1)).toMatchObject({ kind: 'progress', status: 'advisory', summary });
    };
    await progress('Saved the unfinished comparison. No new evidence.');
    for (let attempt = 0; attempt < 3; attempt++) {
      const action = await f.cooperation.next(f.checker, budget);
      if (action?.kind !== 'task') throw new Error('missing scoped check assignment');
      expect(action.task.id).toBe(check.task.id);
      expect(f.cooperation.started(f.checker, action)).toBe(true);
      fs.writeFileSync(path.join(f.checker.worktree, 'RESEARCH.md'), 'Membership remains open.\n');
      await f.cooperation.deliver(f.checker, action, commitSolverSources(f.problem, f.checker.worktree), true);
    }
    expect(check.status).toBe('blocked');
    const checkpoint = structuredClone(state.researchCheckpoints![check.task.id]);
    expect(checkpoint).toMatchObject({ count: 3, paused: true });
    if (mode === 'legacy restart') {
      const legacyDigest = researchCheckpointLocalInputDigest({ task: check.task, workerId: f.checker.id,
        tasks: state.tasks, deliveries: state.deliveries!, environmentDigest: f.state.environmentDigest,
        problemReceiptDigest: f.problem.receiptDigest }, true);
      expect(legacyDigest).not.toBe(checkpoint.localInputDigest);
      state.researchCheckpoints![check.task.id].localInputDigest = legacyDigest;
      const file = path.join(f.directory, 'state.json');
      writeSolverRunState(file, f.state);
      f.controller.abort(); await f.cooperation.stop();

      const restored = readSolverRunState(file), controller = new AbortController();
      state = restored.cooperation!;
      check = state.tasks.find(node => node.nextCheckId === f.record.id)!;
      cooperation = cooperativeResearch({ state: restored, workers: f.workers, retrievalRoot: f.directory,
        signal: controller.signal, emit: event => f.events.push(event) });
      instances.push({ stop: async () => { controller.abort(); await cooperation.stop(); } });
      await cooperation.restore();
      expect(check.status).toBe('blocked');
      const action = await cooperation.next(f.author, budget);
      if (action?.kind !== 'task') throw new Error('missing author assignment on restart');
      expect(cooperation.started(f.author, action)).toBe(true);
      cooperation.activate(f.author, action, async () => {}, async () => {});
      assignment = action.assignment;
    }

    await progress('Retained the same comparison and its open question in the draft.');
    expect(check.status).toBe('blocked');
    expect(state.researchCheckpoints![check.task.id]).toEqual(checkpoint);
    expect(f.events).not.toContain('research_checkpoint_reopened');

    await progress('Found a supporting calculation for this membership test.', ['calculation:membership-reduction']);
    expect(check.status).toBe('pending');
    expect(f.events).toContain('research_checkpoint_reopened');
    const resumed = await cooperation.next(f.checker, budget);
    expect(resumed).toMatchObject({ kind: 'task', task: { id: check.task.id } });
    expect(f.record.outcome).toBeUndefined();
  });

  it('schedules independent work, consumes an unknown outcome, applies a Lead stop and preserves it across restart', async () => {
    const f = await fixture();
    expect(f.record).toMatchObject({ status: 'pending', scope: { parent: { taskId: 'construction' },
      target: { taskId: 'construction' }, consumer: { taskId: 'goal_0' } } });
    expect(f.state.cooperation!.tasks.find(node => node.task.id === f.record.taskId)?.task.reviewScope).toBe('feasibility');
    await f.publishOutcome();
    expect(f.record.status).toBe('awaiting-decision');
    expect(f.record.outcome?.conclusion).toBe('inconclusive');
    expect(f.state.cooperation!.tasks.find(node => node.task.id === f.record.taskId)?.status).toBe('completed');
    expect(f.state.cooperation!.tasks.find(node => node.task.id === 'construction')?.status).toBe('running');
    const lead = await f.leadDecision();
    const template = JSON.parse(lead.view.leadDecisionInstruction!.match(/Current response template[^\n]*\n([^\n]+)\n/u)![1]);
    expect(template).toMatchObject({ baseVersion: lead.leadAction.planVersion, upsert: [],
      nextCheckDecisions: [{ checkId: f.record.id, outcomeDeliveryId: f.record.outcome!.deliveryId }] });
    expect(template.nextCheckDecisions[0].action).toBe('<choose continue, revise or stop>');
    await lead.publish([{ checkId: f.record.id, outcomeDeliveryId: f.record.outcome!.deliveryId, action: 'stop', reason: 'Try another route before spending more effort on this construction.' }]);
    expect(f.state.cooperation!.planPublicationRejection).toBeUndefined();
    expect(f.record).toMatchObject({ status: 'decided', decision: { action: 'stop' } });
    expect(f.state.cooperation!.tasks.find(node => node.task.id === 'construction')?.task.status).toBe('paused');
    expect(f.events).toEqual(expect.arrayContaining(['next_check_scheduled', 'next_check_outcome', 'next_check_decided']));
    expect(f.state.cooperation!.tasks.some(node => node.proof || node.integratedCheck)).toBe(false);
    const file = path.join(f.directory, 'state.json'); writeSolverRunState(file, f.state);
    const restored = readSolverRunState(file);
    expect(restored.cooperation!.nextChecks).toEqual(f.state.cooperation!.nextChecks);
    f.controller.abort(); await f.cooperation.stop();
    const resumed = cooperativeResearch({ state: restored, workers: f.workers, retrievalRoot: f.directory });
    instances.push({ stop: () => resumed.stop() });
    await resumed.restore();
    expect(restored.cooperation!.nextChecks).toHaveLength(1);
    expect(restored.cooperation!.tasks.filter(node => node.nextCheckId === f.record.id)).toHaveLength(1);
    expect(restored.cooperation!.nextChecks![0]!.decision?.action).toBe('stop');
  });

  it('requires the shown outcome to receive an explicit decision and keeps it in full and same-thread contexts', async () => {
    const f = await fixture();
    const access = { root: f.directory, environment: {}, retrievalRoot: f.directory, taskText: 'Prove the original target.',
      maxOptionalContextBytes: 0 };
    const draft = buildResearchContext(f.problem, { ...f.state, cooperation: f.cooperation.contextState(f.action, f.author) },
      { ...access, worktree: f.author.worktree, assignment: f.action });
    for (const message of [draft.message, draft.continuationMessage]) {
      expect(message).toContain(f.record.id);
      expect(message).not.toContain('checkOutcome:');
      expect(message).not.toContain('guidanceDecisions:');
    }
    await f.publishOutcome(action => {
      const context = buildResearchContext(f.problem, { ...f.state, cooperation: f.cooperation.contextState(action, f.checker) },
        { ...access, worktree: f.checker.worktree, assignment: action });
      expect(context.message).toContain(f.record.id);
      expect(context.message).toContain('checkOutcome:');
      expect(context.message).toContain('with research-observe');
    });
    const lead = await f.leadDecision();
    const context = buildResearchContext(f.problem, { ...f.state, cooperation: lead.view },
      { ...access, worktree: f.workspace, assignment: lead.leadAction });
    for (const text of [context.message, context.continuationMessage]) {
      expect(text).toContain(f.record.id); expect(text).toContain(f.record.outcome!.deliveryId);
      expect(text).toContain('inconclusive');
      expect(text).toContain('nextCheckDecisions');
      expect(text).not.toContain('checkOutcome:');
    }
    await lead.publish();
    expect(f.state.cooperation!.planPublicationRejection?.reason).toContain('math_plan_next_check_decision_required');
    expect(f.record.status).toBe('awaiting-decision');
    await lead.publish([{ checkId: f.record.id, outcomeDeliveryId: f.record.outcome!.deliveryId, action: 'continue', reason: 'Retain this route while seeking the missing argument.' }]);
    expect(f.state.cooperation!.planPublicationRejection).toBeUndefined();
    expect(f.record.status).toBe('decided');
  });

  it('reconciles a running task for a decided check left by an older continuation', async () => {
    const f = await fixture();
    await f.publishOutcome();
    const lead = await f.leadDecision();
    await lead.publish([{ checkId: f.record.id, outcomeDeliveryId: f.record.outcome!.deliveryId, action: 'continue',
      reason: 'Continue the other estimate using the archived result.' }]);
    const check = f.state.cooperation!.tasks.find(node => node.nextCheckId === f.record.id)!;
    f.state.cooperation!.tasks = f.state.cooperation!.tasks.map(node => node === check
      ? { ...node, status: 'running', assignment: undefined, attempts: 0 } : node);
    const file = path.join(f.directory, 'state.json');
    writeSolverRunState(file, f.state);
    f.controller.abort(); await f.cooperation.stop();

    const restored = readSolverRunState(file), controller = new AbortController(), assigned: unknown[] = [];
    const resumed = cooperativeResearch({ state: restored, workers: f.workers, retrievalRoot: f.directory,
      signal: controller.signal, emit: (event, details) => { if (event === 'task_assigned') assigned.push(details); } });
    instances.push({ stop: async () => { controller.abort(); await resumed.stop(); } });
    await resumed.restore();
    expect(restored.cooperation!.nextChecks![0]).toMatchObject({ id: f.record.id, status: 'decided' });
    expect(restored.cooperation!.tasks.find(node => node.nextCheckId === f.record.id)).toMatchObject({ status: 'completed', attempts: 0 });

    // Even an inconsistent pending record reaching the scheduler cannot be reserved.
    restored.cooperation!.tasks = restored.cooperation!.tasks.map(node => node.nextCheckId === f.record.id
      ? { ...node, status: 'pending' } : node);
    const offered = resumed.next(f.checker, { maxTurns: Infinity, remainingMs: Infinity });
    try {
      await expect(Promise.race([offered, new Promise(resolve => setTimeout(resolve, 30, 'waiting'))])).resolves.toBe('waiting');
      expect(assigned).toEqual([]);
    } finally {
      controller.abort();
      await offered.catch(() => {});
    }
  });

  it('deduplicates the same question across notes-only publications and rejects an outcome from its author', async () => {
    const f = await fixture();
    await f.publishGap('The same missing inference, reported again after a checkpoint.');
    expect(f.state.cooperation!.nextChecks).toHaveLength(1);
    expect(f.events.filter(event => event === 'next_check_scheduled')).toHaveLength(1);
    expect(() => queueResearchObservation({ worktree: f.author.worktree, finding: { summary: 'An author self-report.',
      checkOutcome: { checkId: f.record.id, conclusion: 'supporting', summary: 'I believe this method works.', evidenceRefs: [] } } }))
      .toThrow('math_delivery_invalid:check_outcome_scope');
    expect(f.record.status).toBe('pending');
  });

  it('keeps a pending check and its exact scope after checkpoint reload without creating another task', async () => {
    const f = await fixture(), file = path.join(f.directory, 'pending.json');
    writeSolverRunState(file, f.state); const restored = readSolverRunState(file);
    f.controller.abort(); await f.cooperation.stop();
    const resumed = cooperativeResearch({ state: restored, workers: f.workers, retrievalRoot: f.directory });
    instances.push({ stop: () => resumed.stop() }); await resumed.restore();
    expect(restored.cooperation!.nextChecks).toHaveLength(1);
    const check = await resumed.next(f.checker, { maxTurns: Infinity, remainingMs: Infinity });
    expect(check?.kind === 'task' && check.task.id).toBe(f.record.taskId);
    expect(currentNextCheck(restored.cooperation!.nextChecks![0]!, restored.cooperation!, f.identity)).toBe(true);
  });

  it('expires a changed target and rejects its old scoped outcome', async () => {
    const f = await fixture();
    const task = f.state.cooperation!.tasks.find(node => node.task.id === f.record.taskId)!;
    const assigned = { taskId: task.task.id, taskDigest: taskVersion(task.task), workerId: f.checker.id, seedCommit: f.problem.baseCommit };
    fs.appendFileSync(path.join(f.directory, 'edits.jsonl'), JSON.stringify({ id: 'changed-construction',
      baseVersion: f.state.cooperation!.planVersion, tasks: f.state.cooperation!.tasks.filter(node => !node.nextCheckId)
        .map(node => node.task.id === 'construction' ? { ...node.task, objective: 'Investigate a different construction.', revision: 1 } : node.task) }) + '\n');
    await f.cooperation.pulse(f.lead.id);
    expect(f.state.cooperation!.edits?.at(-1)?.status).toBe('applied');
    expect(f.record.status).toBe('stale');
    expect(f.state.cooperation!.tasks.find(node => node.nextCheckId === f.record.id)).toBeUndefined();
    const admission = prepareResearchDelivery({ kind: 'event', value: { summary: 'An old result.',
      checkOutcome: { checkId: f.record.id, conclusion: 'inconclusive', summary: 'The old construction remains unknown.', evidenceRefs: [] } } },
    { source: task.task, assignment: assigned, ...f.state.cooperation!, identity: f.identity });
    expect(admission).toMatchObject({ status: 'rejected', code: 'math_delivery_invalid:check_outcome_scope' });
  });

  it('keeps an unanswered scoped outcome owed to Lead after restart', async () => {
    const f = await fixture(); await f.publishOutcome();
    const file = path.join(f.directory, 'awaiting.json'); writeSolverRunState(file, f.state);
    const restored = readSolverRunState(file); f.controller.abort(); await f.cooperation.stop();
    const resumed = cooperativeResearch({ state: restored, workers: f.workers, retrievalRoot: f.directory });
    instances.push({ stop: () => resumed.stop() }); await resumed.restore();
    const action = await resumed.next(f.lead, { maxTurns: Infinity, remainingMs: Infinity });
    expect(action?.kind).toBe('lead');
    expect(resumed.contextState(action, f.lead).nextChecks).toContainEqual(expect.objectContaining({
      id: f.record.id, status: 'awaiting-decision', outcome: expect.objectContaining({ deliveryId: f.record.outcome!.deliveryId }) }));
    expect(restored.cooperation!.tasks.filter(node => node.nextCheckId)).toHaveLength(1);
    expect(restored.cooperation!.tasks.find(node => node.nextCheckId)?.status).toBe('completed');
  });

  it('rejects a claimed revision that merely renames the objective and retains legacy plans', async () => {
    const f = await fixture(); await f.publishOutcome();
    const base = { version: f.state.cooperation!.planVersion!, tasks: f.state.cooperation!.tasks.filter(node => !node.nextCheckId).map(node => node.task),
      groups: f.state.cooperation!.groups!.map(record => record.group) };
    const plan = parseLeadPlan(f.problem, { baseVersion: base.version, upsert: [{ id: 'construction', objective: 'A renamed core problem.' }],
      nextCheckDecisions: [{ checkId: f.record.id, outcomeDeliveryId: f.record.outcome!.deliveryId, action: 'revise', reason: 'Rename the central problem.' }] }, base);
    expect(() => prepareNextCheckDecisions(f.state.cooperation!, f.identity, plan, plan.nextCheckDecisions))
      .toThrow('math_plan_next_check_revision_required');
    expect(parseLeadPlan(f.problem, { tasks: base.tasks, groups: base.groups }).nextCheckDecisions).toBeUndefined();
  });
});

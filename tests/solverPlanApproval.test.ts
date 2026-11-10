import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSolverRunState, writeSolverRunState, type SolverRunState } from '../src/solver/archive';
import type { CooperativeResearch } from '../src/solver/cooperation';
import type { ResearchWorker } from '../src/solver/modules/organization';
import { planApprovalInspection, planApprovalLog } from '../src/solver/planApproval';
import { commitSolverSources, type SolverProblem } from '../src/solver/problem';
import { leadPlanDeliveryFile, type CooperativeAction } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';
import { ExecutionDeadline } from '../src/runtime/executionDeadline';
import * as statementReview from '../src/solver/statementReview';

describe('plan approval before dispatch (--plan-approval)', () => {
  let directory: string, problem: SolverProblem, state: SolverRunState, lead: ResearchWorker, peer: ResearchWorker;
  let events: { event: string; details?: Record<string, unknown> }[];
  let instances: { cooperative: CooperativeResearch; controller: AbortController }[];
  let pending: Promise<unknown>[];
  const budget = { maxTurns: Infinity, remainingMs: Infinity };
  const plan = (suffix = '') => ({ tasks: problem.targets.map((target, index) => ({ id: `goal_${index + 1}${suffix}`, kind: 'goal',
    objective: `Prove ${target.theoremName}.`, theoremName: target.theoremName, proofPath: target.proofPath })) });
  const create = (onPlanApprovalWaiting?: (waiting: boolean) => void,
    exclusiveCheck?: ConstructorParameters<typeof CooperativeResearch>[0]['exclusiveCheck']) => {
    const controller = new AbortController();
    const cooperative = cooperativeResearch({ state, workers: [lead, peer], retrievalRoot: directory,
      signal: controller.signal, onPlanApprovalWaiting, ...(exclusiveCheck ? { exclusiveCheck } : {}),
      emit: (event, details) => events.push({ event, details }) });
    instances.push({ cooperative, controller });
    return cooperative;
  };
  const track = <T,>(promise: Promise<T>) => { pending.push(promise); void promise.catch(() => {}); return promise; };
  const settled = async (promise: Promise<unknown>) => {
    let done = false; void promise.then(() => { done = true; }, () => { done = true; });
    for (let index = 0; index < 5; index++) await new Promise<void>(resolve => setImmediate(resolve));
    return done;
  };
  const named = (name: string) => events.filter(item => item.event === name).map(item => item.details);
  const wait = (worker: ResearchWorker) => state.workers!.find(item => item.id === worker.id)!.scheduling?.wait;
  const startLead = async (cooperative: CooperativeResearch) => {
    const action = await cooperative.next(lead, budget);
    if (action?.kind !== 'lead') throw new Error('fixture_expected_lead');
    expect(cooperative.started(lead, action)).toBe(true);
    cooperative.activate(lead, action, async () => {}, async () => {});
    return action;
  };
  const publish = async (cooperative: CooperativeResearch, action: CooperativeAction, suffix = '') => {
    if (action.kind !== 'lead') throw new Error('fixture_expected_lead');
    fs.appendFileSync(path.join(lead.worktree, leadPlanDeliveryFile(action)!), JSON.stringify({ kind: 'plan',
      baseVersion: action.planVersion, ...(action.planNonce ? { dispatchNonce: action.planNonce } : {}),
      summary: 'One task per original goal.', ...plan(suffix) }) + '\n');
    await cooperative.pulse();
  };
  const approve = async (cooperative: CooperativeResearch, id: string, planVersion = state.cooperation!.planVersion!) => {
    fs.appendFileSync(planApprovalLog(path.join(directory, 'state.json')), JSON.stringify({ id, planVersion }) + '\n');
    await cooperative.pulse();
  };
  /** A note to the Lead as queueHumanGuidance stores it. */
  const guideLead = (id: string) => {
    const file = path.join(directory, 'human-guidance.json'), now = new Date().toISOString();
    const store = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : { schema: 'theorem-os.human-guidance.v1', runId: state.runId, records: [] };
    store.records.push({ id, recipient: { kind: 'lead' }, text: 'Split the first goal into a helper lemma.',
      observationRef: { sequence: 1, stateDigest: 'a'.repeat(64) }, status: 'queued', createdAt: now, updatedAt: now });
    fs.writeFileSync(file, JSON.stringify(store));
  };
  const guidance = (id: string) => JSON.parse(fs.readFileSync(path.join(directory, 'human-guidance.json'), 'utf8'))
    .records.find((record: { id: string }) => record.id === id);

  beforeEach(() => {
    const example = localExample('solver-plan-approval-', 'lead');
    ({ directory, problem } = example);
    lead = leadWorker(problem, example.workspace);
    peer = peerWorker(example, 'engineer', { role: 'engineer' });
    state = solverState(problem, example.workspace, { runId: 'plan-approval-fixture', phase: 'prepared',
      evaluatorDigest: 'evaluation', model: 'fixture', effort: 'fixture', planApproval: true,
      workers: [lead, peer].map(worker => ({ id: worker.id, role: worker.role, worktree: worker.worktree, phase: 'running', turns: 0 })) });
    instances = []; events = []; pending = [];
  });
  afterEach(async () => {
    for (const instance of instances) instance.controller.abort();
    await Promise.allSettled(pending);
    await Promise.allSettled(instances.map(instance => instance.cooperative.stop()));
    vi.useRealTimers(); vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true });
  });
  it('holds every worker after the first plan until the exact version is approved', async () => {
    const cooperative = create(), action = await startLead(cooperative);
    expect(planApprovalInspection(state)).toMatchObject({ required: true, status: 'awaiting-plan', leadRevising: false });
    const waiting = track(cooperative.next(peer, budget));
    await publish(cooperative, action);
    const version = state.cooperation!.planVersion!;
    expect(await settled(waiting)).toBe(false);
    expect(wait(peer)).toMatchObject({ stage: 'plan-approval', planVersion: version });
    expect(named('plan_approval_requested')).toEqual([{ planVersion: version }]);
    // The Lead turn that published the plan is still running, but it is not a revision for the owner.
    expect(planApprovalInspection(state)).toMatchObject({ status: 'pending', planVersion: version,
      requestedAt: expect.any(Number), rejections: [], leadRevising: false });

    await approve(cooperative, 'stale', 'obsolete-version');
    expect(await settled(waiting)).toBe(false);
    expect(named('plan_approval_rejected')).toEqual([expect.objectContaining({ id: 'stale',
      reason: 'math_plan_approval_version_conflict', planVersion: 'obsolete-version' })]);

    await approve(cooperative, 'owner');
    expect(await waiting).toMatchObject({ kind: 'task', task: { id: 'goal_1' } });
    expect(named('plan_approved')).toEqual([{ id: 'owner', planVersion: version }]);
    expect(planApprovalInspection(state)).toMatchObject({ status: 'approved', approvedId: 'owner',
      approvedVersion: version, approvedAt: expect.any(Number) });
    expect(events.find(item => item.event === 'dispatch_wait_ended' && item.details?.workerId === peer.id &&
      item.details.stage === 'plan-approval')).toMatchObject({ details: { planVersion: version, reason: 'selected' } });

    // The same approval read twice is a no-op; a different one after approval is reported, not applied.
    await approve(cooperative, 'owner');
    await approve(cooperative, 'second');
    expect(named('plan_approved')).toHaveLength(1);
    expect(state.cooperation!.planApproval!.rejections!.map(item => [item.id, item.reason])).toEqual([
      ['stale', 'math_plan_approval_version_conflict'], ['second', 'math_plan_approval_already_approved']]);
    expect(state.cooperation!.planApproval!.approvedId).toBe('owner');
  });

  it('rejects an approval that arrives before any plan and leaves dispatch untouched without the flag', async () => {
    const cooperative = create();
    await approve(cooperative, 'early', 'anything');
    expect(state.cooperation!.planApproval!.rejections).toEqual([expect.objectContaining({ id: 'early',
      reason: 'math_plan_approval_plan_unavailable' })]);
    expect(planApprovalInspection(state).status).toBe('awaiting-plan');

    state.planApproval = undefined;
    const action = await startLead(cooperative), waiting = track(cooperative.next(peer, budget));
    await publish(cooperative, action);
    expect(await waiting).toMatchObject({ kind: 'task', task: { id: 'goal_1' } });
    expect(named('plan_approval_requested')).toEqual([]);
    expect(planApprovalInspection(state)).toMatchObject({ required: false, status: 'not-required' });
  });

  it('applies an edit before an approval read in the same pulse, so the approval of the older plan conflicts', async () => {
    const cooperative = create(), action = await startLead(cooperative);
    await publish(cooperative, action);
    const read = state.cooperation!.planVersion!;
    fs.appendFileSync(path.join(directory, 'edits.jsonl'), JSON.stringify({ id: 'owner-edit', baseVersion: read, ...plan('_edited') }) + '\n');
    await approve(cooperative, 'owner', read);
    expect(state.cooperation!.edits?.[0]).toMatchObject({ id: 'owner-edit', status: 'applied' });
    expect(state.cooperation!.planVersion).not.toBe(read);
    expect(state.cooperation!.planApproval!.rejections).toEqual([expect.objectContaining({ id: 'owner',
      reason: 'math_plan_approval_version_conflict', planVersion: read })]);
    expect(planApprovalInspection(state)).toMatchObject({ status: 'pending', planVersion: state.cooperation!.planVersion });

    const waiting = track(cooperative.next(peer, budget));
    await approve(cooperative, 'owner-again');
    expect(await waiting).toMatchObject({ kind: 'task', task: { id: 'goal_1_edited' } });
  });
  it('gives the Lead one revision turn per owner note while the plan waits', async () => {
    const cooperative = create(), action = await startLead(cooperative);
    await publish(cooperative, action);
    cooperative.deactivate(lead);
    await cooperative.deliver(lead, action, commitSolverSources(problem, lead.worktree));
    const first = state.cooperation!.planVersion!;
    const idle = track(cooperative.next(lead, budget));
    expect(await settled(idle)).toBe(false);

    guideLead('note-1');
    await cooperative.pulse();
    // No Lead is running to hear it, so the note waits and wakes a revision turn.
    expect(guidance('note-1')).toMatchObject({ status: 'deferred' });
    const revision = await idle;
    expect(revision).toMatchObject({ kind: 'lead', planVersion: first, planNonce: expect.any(String) });
    expect(named('plan_approval_revision')).toEqual([{ guidanceIds: ['note-1'], planVersion: first }]);
    expect(state.cooperation!.planApproval).toMatchObject({ guidanceIds: ['note-1'], revisionAt: expect.any(Number) });
    expect(planApprovalInspection(state).leadRevising).toBe(false);
    expect(cooperative.started(lead, revision!)).toBe(true);
    cooperative.activate(lead, revision!, async () => {}, async () => {});
    expect(planApprovalInspection(state)).toMatchObject({ status: 'pending', leadRevising: true });
    await cooperative.pulse();
    expect(guidance('note-1')).toMatchObject({ status: 'delivered', deliveredTo: [lead.id] });

    await publish(cooperative, revision!, '_revised');
    const revised = state.cooperation!.planVersion!;
    expect(revised).not.toBe(first);
    expect(state.cooperation!.tasks.map(node => node.task.id)).toEqual(['goal_1_revised', 'goal_2_revised']);
    cooperative.deactivate(lead);
    expect(planApprovalInspection(state)).toMatchObject({ status: 'pending', planVersion: revised, leadRevising: false });

    // The answered note does not earn a second turn; only the owner's approval releases the team.
    const after = track(cooperative.next(lead, budget)), waiting = track(cooperative.next(peer, budget));
    expect(await settled(after)).toBe(false);
    expect(named('plan_approval_revision')).toHaveLength(1);
    await approve(cooperative, 'owner');
    expect(await waiting).toMatchObject({ kind: 'task', task: { id: 'goal_1_revised' } });
  });

  it('keeps approvals and rejections across a restart without rereading the log', async () => {
    const cooperative = create(), action = await startLead(cooperative);
    await publish(cooperative, action);
    await approve(cooperative, 'stale', 'obsolete-version');
    const stateFile = path.join(directory, 'state.json');
    writeSolverRunState(stateFile, state); state = readSolverRunState(stateFile);
    expect(state.cooperation!.cursors!.planApprovals).toBe(fs.statSync(planApprovalLog(stateFile)).size);

    const restored = create();
    await restored.restore();
    await restored.pulse();
    expect(state.cooperation!.planApproval!.rejections!.map(item => item.id)).toEqual(['stale']);
    expect(planApprovalInspection(state).status).toBe('pending');
    expect(named('plan_approval_requested')).toHaveLength(1);
    await approve(restored, 'owner');
    expect(planApprovalInspection(state)).toMatchObject({ status: 'approved', approvedId: 'owner' });
  });

  it('preserves execution time while a person reads, rejects a stale approval, and continues the same run', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const expire = vi.fn(), clock = new ExecutionDeadline(1_000, expire);
    const cooperative = create(waiting => clock.setWaiting(waiting)), action = await startLead(cooperative);
    await vi.advanceTimersByTimeAsync(200);
    await publish(cooperative, action);
    expect(clock.waiting).toBe(false); // A published plan does not waive the remainder of the running Lead turn.
    cooperative.deactivate(lead);
    expect(clock.waiting).toBe(true);
    const runId = state.runId, problemReceiptDigest = state.problem.receiptDigest;
    await vi.advanceTimersByTimeAsync(600_000);
    await approve(cooperative, 'old-version', 'obsolete');
    expect(clock.waiting).toBe(true);
    expect(clock.remainingMs()).toBe(800);
    expect(expire).not.toHaveBeenCalled();
    const waiting = track(cooperative.next(peer, { maxTurns: Infinity, remainingMs: clock.remainingMs() }));
    await approve(cooperative, 'owner');
    expect(await waiting).toMatchObject({ kind: 'task', task: { id: 'goal_1' } });
    expect(clock.waiting).toBe(false);
    expect(state.runId).toBe(runId);
    expect(state.problem.receiptDigest).toBe(problemReceiptDigest);
    await vi.advanceTimersByTimeAsync(799);
    expect(expire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(expire).toHaveBeenCalledOnce();
    clock.stop();
  });

  it('counts owner-requested model revisions, then freezes again when the revision finishes', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const clock = new ExecutionDeadline(1_000, vi.fn());
    const cooperative = create(waiting => clock.setWaiting(waiting)), action = await startLead(cooperative);
    await publish(cooperative, action);
    cooperative.deactivate(lead);
    await cooperative.deliver(lead, action, commitSolverSources(problem, lead.worktree));
    expect(clock.waiting).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    guideLead('revision-note'); await cooperative.pulse();
    const revision = await cooperative.next(lead, { maxTurns: Infinity, remainingMs: clock.remainingMs() });
    if (!revision) throw new Error('expected_owner_revision');
    cooperative.reserveTurn(lead);
    expect(clock.waiting).toBe(false);
    expect(cooperative.started(lead, revision)).toBe(true);
    cooperative.activate(lead, revision, async () => {}, async () => {});
    cooperative.settleTurn(lead);
    await vi.advanceTimersByTimeAsync(250);
    await publish(cooperative, revision, '_revised');
    cooperative.deactivate(lead);
    expect(clock.waiting).toBe(true);
    expect(clock.remainingMs()).toBe(750);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clock.remainingMs()).toBe(750);
    clock.stop();
  });

  it('charges host rechecks of a human-edited plan before returning to idle approval waiting', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.spyOn(statementReview, 'captureStatementContexts').mockImplementation(async (_problem, tasks) =>
      new Map(tasks.map(task => [task.id, { type: 'True', constants: [], omitted: [] }])));
    const clock = new ExecutionDeadline(1_000, vi.fn());
    let hold = false, release!: () => void, checking!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { checking = resolve; });
    const cooperative = create(waiting => clock.setWaiting(waiting), async check => {
      if (hold && state.cooperation!.tasks.some(node => node.pendingValidation)) {
        hold = false; checking(); await released;
      }
      return check();
    });
    try {
      const action = await startLead(cooperative);
      await publish(cooperative, action);
      cooperative.deactivate(lead);
      await cooperative.deliver(lead, action, commitSolverSources(problem, lead.worktree));
      expect(clock.waiting).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      hold = true;
      fs.appendFileSync(path.join(directory, 'edits.jsonl'), JSON.stringify({ id: 'owner-edit',
        baseVersion: state.cooperation!.planVersion, tasks: plan('_edited').tasks.map(task =>
          ({ ...task, statementReview: true, informalStatement: 'The stated equality holds.' })) }) + '\n');
      const pulse = track(cooperative.pulse());
      await started;
      expect(clock.waiting).toBe(false);
      await vi.advanceTimersByTimeAsync(300);
      expect(clock.remainingMs()).toBe(700);
      release(); await pulse;
      for (let index = 0; index < 5; index++) await new Promise<void>(resolve => setImmediate(resolve));
      expect(clock.waiting).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(clock.remainingMs()).toBe(700);
    } finally { release(); clock.stop(); }
  });

  it('reports an unanswered plan at stop and respects an already exhausted execution allowance', async () => {
    const cooperative = create(), action = await startLead(cooperative);
    await publish(cooperative, action);
    cooperative.deactivate(lead);
    expect(await cooperative.next(peer, { maxTurns: Infinity, remainingMs: 0 })).toBeUndefined();
    expect(await cooperative.next(lead, { maxTurns: Infinity, remainingMs: 0 })).toBeUndefined();
    await cooperative.stop();
    expect(named('plan_approval_unanswered')).toEqual([{ planVersion: state.cooperation!.planVersion }]);
  });
});

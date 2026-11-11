import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SolverRunState } from '../src/solver/archive';
import type { CooperativeResearch } from '../src/solver/cooperation';
import type { ResearchWorker } from '../src/solver/modules/organization';
import { committedSource, commitSolverSources, type SolverProblem } from '../src/solver/problem';
import { advisoryCheckpointScope } from '../src/solver/research';
import { leadPlanDeliveryFile, parseCooperationPlan, taskVersion, type CooperativeAction, type CooperativeTask } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

const host = vi.hoisted(() => ({ verify: vi.fn(), createSession: vi.fn() }));
vi.mock('../src/math/verifier', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/verifier')>(), checkManyFormalVerifications: host.verify,
  resolveMathematicsLakePackagesCache: () => undefined,
}));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.createSession }));

type Lead = Extract<CooperativeAction, { kind: 'lead' | 'assemble' }>;
const lead = (fields: Partial<Lead> = {}): Lead => ({ kind: 'lead', seedCommit: 'seed-a', planVersion: 'graph-a', responsibilityDigest: 'responsibility-a',
  planNonce: 'nonce-a', planningInputDigest: 'operational-input-a', ...fields });

describe('semantic advisory checkpoint inputs', () => {
  it('preserves the same scope across nonce, seed and planning input changes', () => {
    const original = lead();
    const replay = lead({ planNonce: 'nonce-b', seedCommit: 'seed-b', planningInputDigest: 'operational-input-b' });
    expect(advisoryCheckpointScope(replay)).toBe(advisoryCheckpointScope(original));
  });

  it.each([
    ['planning input', { planningInputDigest: 'operational-input-b' }],
    ['new base graph presentation', { planVersion: 'graph-b' }],
  ] as const)('keeps new %s from resetting the same responsibility guard', (_label, change) => {
    expect(advisoryCheckpointScope(lead(change as Partial<Lead>))).toBe(advisoryCheckpointScope(lead()));
  });

  it('gives a changed mathematical responsibility a fresh scope', () => {
    expect(advisoryCheckpointScope(lead({ responsibilityDigest: 'responsibility-b' }))).not.toBe(advisoryCheckpointScope(lead()));
  });

  it('distinguishes initial planning without using the initial dispatch nonce', () => {
    const original = lead({ initialPlanNonce: 'initial-a' });
    expect(advisoryCheckpointScope(lead({ initialPlanNonce: 'initial-b' }))).toBe(advisoryCheckpointScope(original));
    expect(advisoryCheckpointScope(lead())).not.toBe(advisoryCheckpointScope(original));
  });

  it('keeps non-Lead research scoped to its exact task contract and excludes proof work', () => {
    const task: CooperativeTask = { id: 'question', kind: 'research', objective: 'Find the missing construction.', dependsOn: [], revision: 0 };
    const assignment = { taskId: task.id, taskDigest: 'task-a', workerId: 'worker-a', seedCommit: 'seed-a', assignmentId: 'first' };
    const action: CooperativeAction = { kind: 'task', task, assignment };
    const original = advisoryCheckpointScope(action);
    expect(advisoryCheckpointScope({ ...action, assignment: { ...assignment, assignmentId: 'second', workerId: 'worker-b', seedCommit: 'seed-b' } })).toBe(original);
    expect(advisoryCheckpointScope({ ...action, assignment: { ...assignment, taskDigest: 'task-b' } })).not.toBe(original);
    expect(advisoryCheckpointScope({ ...action, task: { ...task, kind: 'lemma' } })).toBeUndefined();
    expect(advisoryCheckpointScope(undefined)).toBeUndefined();
  });
});

describe('Lead scheduling checkpoint control responses', () => {
  const budget = { maxTurns: Infinity, remainingMs: Infinity };
  let directory: string, problem: SolverProblem, workers: ResearchWorker[], state: SolverRunState;
  let cooperative: CooperativeResearch, controller: AbortController;
  let events: { event: string; details?: Record<string, unknown> }[];
  let notify: ReturnType<typeof vi.fn<(message: string) => Promise<void>>>;
  let proposal: CooperativeTask;
  // Current research deliveries whose exact lemma proposals are not yet in the plan.
  const pendingProposals = () => (state.cooperation!.deliveries ?? []).filter(delivery => delivery.kind === 'research' &&
    delivery.status !== 'superseded' && delivery.lemmaRequests?.some(task => !state.cooperation!.tasks.some(node => node.task.id === task.id)));
  const graph = () => ({ tasks: state.cooperation!.tasks.map(node => node.task),
    groups: state.cooperation!.groups!.map(route => route.group) });
  const notes = () => path.join(workers[0].worktree, 'RESEARCH.md');
  const planText = (response: unknown) => '```math-plan\n' + JSON.stringify(response) + '\n```\n';
  const write = (response: unknown) => fs.writeFileSync(notes(), planText(response));
  // A validated plan answers each shown research finding.
  const decide = (outcome: 'adopt' | 'decline') => ({ researchDecisions: [{ deliveryId: 'proposal-delivery', outcome,
    reason: outcome === 'adopt' ? 'The typed bridge closes the route.' : 'The bridge is not needed yet.',
    ...(outcome === 'adopt' ? { taskIds: ['bridge'] } : {}) }] });
  const start = async (baseline?: string | null) => {
    if (baseline === null) fs.rmSync(notes(), { force: true });
    else if (baseline === undefined) write(graph());
    else fs.writeFileSync(notes(), baseline);
    const action = await cooperative.next(workers[0], budget);
    if (action?.kind !== 'lead' || !action.planNonce) throw new Error('fixture_expected_revision_dispatch');
    expect(cooperative.started(workers[0], action)).toBe(true);
    cooperative.activate(workers[0], action, async () => {}, notify);
    return action;
  };
  const checkpoint = (action: Lead) => {
    const commit = commitSolverSources(problem, workers[0].worktree);
    cooperative.deactivate(workers[0]);
    return cooperative.deliver(workers[0], action, commit, true, 'scheduling-checkpoint');
  };

  beforeEach(() => {
    host.verify.mockReset().mockImplementation(() => { throw new Error('fixture_unexpected_proof_acceptance'); });
    host.createSession.mockReset().mockImplementation(() => { throw new Error('fixture_real_models_forbidden'); });
    const example = localExample('lead-checkpoint-semantics-', 'lead');
    ({ directory, problem } = example);
    workers = [leadWorker(problem, example.workspace), peerWorker(example, 'researcher')];
    const question: CooperativeTask = { id: 'question', kind: 'research', objective: 'Find a bridge.', dependsOn: [], revision: 0 };
    proposal = { id: 'bridge', kind: 'lemma', objective: 'Prove the missing exact bridge.', theoremName: 'Tutorial.bridge',
      proofPath: 'Submission.lean', type: 'True', dependsOn: [], revision: 0 };
    const parsed = parseCooperationPlan(problem, { tasks: [question, ...problem.targets.map((target, index) => ({
      id: `goal_${index}`, kind: 'goal', objective: `Prove ${target.theoremName}.`, ...target,
    }))] });
    state = solverState(problem, example.workspace, { runId: 'lead-checkpoint-semantics', phase: 'running',
      workers: workers.map(worker => ({ id: worker.id, role: worker.role, worktree: worker.worktree, phase: 'checking', turns: 0 })),
      cooperation: { canonicalCommit: problem.baseCommit,
        tasks: parsed.tasks.map(task => ({ task, status: task.id === question.id ? 'completed' : 'pending', attempts: 0 })),
        groups: parsed.groups.map(group => ({ group, turns: 0 })),
        deliveries: [{ id: 'proposal-delivery', producer: workers[1].id, taskId: question.id, taskDigest: taskVersion(question),
          kind: 'research', status: 'advisory', summary: 'A typed bridge needs a Lead decision.', statement: '', premises: [],
          dependencies: [], remainingObligations: [], evidenceRefs: [], createdAt: 1, lemmaRequests: [proposal] }] } });
    events = []; controller = new AbortController(); notify = vi.fn(async (_message: string) => {});
    cooperative = cooperativeResearch({ state, workers, retrievalRoot: directory, signal: controller.signal,
      emit: (event, details) => events.push({ event, details }) });
  });
  afterEach(async () => {
    controller.abort(); await cooperative.stop();
    expect(host.verify).not.toHaveBeenCalled(); expect(host.createSession).not.toHaveBeenCalled();
    vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true });
  });

  it('corrects a saved incomplete Lead decision in the same dispatch without publishing the draft', async () => {
    const action = await start(), before = structuredClone(state.cooperation!.tasks);
    await cooperative.pulse();
    expect(notify).not.toHaveBeenCalled(); // The inherited accepted graph is still just the dispatch seed.
    write({ ...graph(), tasks: [...graph().tasks, proposal] });
    await cooperative.pulse();
    expect(notify).toHaveBeenCalledOnce();
    const message = notify.mock.calls[0][0];
    expect(message).toContain('math_plan_research_decisions_missing');
    expect(message).toContain('proposal-delivery');
    expect(message).toContain(leadPlanDeliveryFile(action));
    expect(message).toContain('has not accepted the plan or any proof');
    expect(state.cooperation!.tasks).toEqual(before);
    expect(state.cooperation!.researchDecisions).toBeUndefined();
    expect(state.cooperation!.planPublication).toBeUndefined();
    expect(state.cooperation!.planRejection).toBeUndefined();
    await cooperative.pulse(); await cooperative.pulse();
    expect(notify).toHaveBeenCalledOnce();
    write({ ...graph(), tasks: [...graph().tasks, proposal], ...decide('adopt') });
    await cooperative.pulse();
    expect(notify).toHaveBeenCalledOnce();
    expect(state.cooperation!.tasks).toEqual(before);
    await checkpoint(action);
    expect(state.cooperation!.tasks.find(node => node.task.id === proposal.id)?.status).toBe('pending');
    expect(state.cooperation!.researchDecisions).toContainEqual(expect.objectContaining({
      deliveryId: 'proposal-delivery', outcome: 'adopt' }));
    expect(state.cooperation!.error).toBeUndefined();
  });

  it('ignores a missing, partial or prose-only draft while the Lead is still writing', async () => {
    await start();
    fs.rmSync(notes()); await cooperative.pulse();
    for (const text of ['A mathematical argument under construction.', '```math-plan\n{"tasks":[',
      '```math-plan\n{"tasks":[\n```']) {
      fs.writeFileSync(notes(), text); await cooperative.pulse();
    }
    expect(notify).not.toHaveBeenCalled();
    expect(events.some(item => item.event === 'lead_draft_correction_requested')).toBe(false);
  });

  it('ignores an unpublished draft after its dispatch has already published a valid decision', async () => {
    const action = await start();
    const response = { ...graph(), tasks: [...graph().tasks, proposal], ...decide('adopt') };
    write({ ...graph(), tasks: [...graph().tasks, proposal] });
    fs.appendFileSync(path.join(workers[0].worktree, leadPlanDeliveryFile(action)!), JSON.stringify({
      ...response, kind: 'plan', dispatchNonce: action.planNonce, baseVersion: action.planVersion,
    }) + '\n');
    await cooperative.pulse(); await cooperative.pulse();
    expect(state.cooperation!.planPublication).toMatchObject({ nonce: action.planNonce });
    expect(state.cooperation!.researchDecisions).toContainEqual(expect.objectContaining({
      deliveryId: 'proposal-delivery', outcome: 'adopt' }));
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not notify a deactivated Lead or require a research decision already settled by a peer', async () => {
    await start();
    write({ ...graph(), tasks: [...graph().tasks, proposal] });
    const delivery = state.cooperation!.deliveries!.find(record => record.id === 'proposal-delivery')!;
    state.cooperation!.researchDecisions = [{ deliveryId: delivery.id, taskDigest: delivery.taskDigest,
      findingDigest: delivery.findingDigest, outcome: 'decline',
      reason: 'A peer settled this finding in the accepted plan.', at: 1, planVersion: state.cooperation!.planVersion! }];
    await cooperative.pulse();
    expect(notify).not.toHaveBeenCalled();
    state.cooperation!.researchDecisions = [];
    cooperative.deactivate(workers[0]);
    await cooperative.pulse();
    expect(notify).not.toHaveBeenCalled();
    expect(pendingProposals()).toHaveLength(1);
  });

  it('retries a failed correction notification without losing or accepting the saved draft', async () => {
    await start();
    notify.mockRejectedValueOnce(new Error('fixture_request_boundary_unavailable'));
    write({ ...graph(), tasks: [...graph().tasks, proposal] });
    await cooperative.pulse(); await Promise.resolve();
    await cooperative.pulse();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(state.cooperation!.planPublication).toBeUndefined();
    expect(pendingProposals()).toHaveLength(1);
  });

  it.each([false, true])('retains an unanswered research decision in an unchanged control draft (prose-only: %s)', async prose => {
    const action = await start(), before = structuredClone(state.cooperation!.tasks), base = state.cooperation!.planVersion;
    const pending = pendingProposals().map(item => item.id);
    if (prose) fs.appendFileSync(notes(), '\nA still unfinished mathematical investigation.\n');
    await expect(checkpoint(action)).resolves.toEqual({ checkWhole: false });
    expect(state.cooperation!.error).toContain('math_plan_research_decisions_missing');
    expect(state.cooperation!.planRejection).toMatchObject({ stalled: false });
    expect(state.cooperation!.lastLeadPauseInputDigest).toBeUndefined();
    expect(events.some(item => item.event === 'lead_draft_preserved')).toBe(true);
    expect(events.some(item => item.event === 'plan_updated')).toBe(false);
    expect(state.cooperation!.tasks).toEqual(before);
    expect(state.cooperation!.planVersion).toBe(base);
    expect(pending).toEqual(['proposal-delivery']);
    expect(pendingProposals().map(item => item.id)).toEqual(pending);
    expect(fs.readFileSync(notes(), 'utf8')).toContain(prose ? 'unfinished mathematical' : 'math-plan');
  });

  it.each(['ordinary Markdown with no control response', null])('preserves an incomplete draft and its required feedback: %s', async baseline => {
    const action = await start(baseline);
    await checkpoint(action);
    expect(events.some(item => item.event === 'lead_draft_preserved')).toBe(true);
    expect(events.some(item => item.event === 'plan_rejected')).toBe(true);
    expect(state.cooperation!.lastLeadPauseInputDigest).toBeUndefined();
    expect(pendingProposals()).toHaveLength(1);
  });

  it.each(['control', 'Markdown', null])('preserves an unchanged draft without a required decision: %s', async baseline => {
    state.cooperation!.deliveries = [];
    const action = await start(baseline === 'control' ? undefined : baseline);
    await checkpoint(action);
    expect(events.some(item => item.event === 'lead_checkpoint_saved')).toBe(true);
    expect(events.some(item => item.event === 'plan_rejected')).toBe(false);
    expect(state.cooperation!.lastLeadPauseInputDigest).toBeDefined();
  });

  it('answers a research finding from a checkpoint without changing the graph', async () => {
    const action = await start(planText({ ...graph(), ...decide('decline') }));
    const reminder = cooperative.leadCheckpointInstruction(action);
    expect(reminder).toContain('researchDecisions: ["proposal-delivery"]');
    expect(reminder).toContain('task graph stays unchanged');
    expect(reminder).toContain(JSON.stringify({ baseVersion: action.planVersion, upsert: [] }));
    expect(reminder).not.toContain('return without a revision');
    await checkpoint(action);
    expect(state.cooperation!.researchDecisions).toContainEqual(expect.objectContaining({
      deliveryId: 'proposal-delivery', outcome: 'decline' }));
    expect(state.cooperation!.lastLeadInputDigest).toBeDefined();
    expect(state.cooperation!.lastLeadPauseInputDigest).toBeUndefined();
    expect(state.cooperation!.error).toBeUndefined();
    expect(events.some(item => item.event === 'lead_checkpoint_saved')).toBe(false);
    expect(cooperative.leadCheckpointInstruction(action)).toContain('return without a revision');
  });

  it('accepts a nested research decision through the live plan intake without inventing proof progress', async () => {
    const action = await start(), planVersion = state.cooperation!.planVersion;
    fs.appendFileSync(path.join(workers[0].worktree, leadPlanDeliveryFile(action)!), JSON.stringify({
      kind: 'plan', dispatchNonce: action.planNonce, baseVersion: action.planVersion,
      tasks: { baseVersion: action.planVersion, upsert: [], ...decide('decline') },
    }) + '\n');
    await cooperative.pulse();
    expect(state.cooperation!.planVersion).toBe(planVersion);
    expect(state.cooperation!.planPublication).toMatchObject({ nonce: action.planNonce });
    expect(state.cooperation!.researchDecisions).toContainEqual(expect.objectContaining({
      deliveryId: 'proposal-delivery', outcome: 'decline' }));
    expect(state.cooperation!.tasks.some(node => node.task.id === proposal.id)).toBe(false);
    expect(state.cooperation!.tasks.some(node => node.status === 'integrated')).toBe(false);
    expect(state.cooperation!.error).toBeUndefined();
    expect(events.some(item => item.event === 'plan_publication_rejected')).toBe(false);
  });

  it('does not add a later research publication to the old dispatch checkpoint obligations', async () => {
    const later = state.cooperation!.deliveries!.splice(0)[0]!;
    const action = await start();
    state.cooperation!.deliveries!.push(later);
    const reminder = cooperative.leadCheckpointInstruction(action);
    expect(reminder).toContain('return without a revision');
    expect(reminder).not.toContain(later.id);
  });

  it('drops only the exact source decision already being merged from the checkpoint reminder', async () => {
    const action = await start(), delivery = state.cooperation!.deliveries![0]!;
    const merging = { deliveryId: delivery.id, taskDigest: delivery.taskDigest, findingDigest: delivery.findingDigest };
    (cooperative as any).pendingSourceResearchDecisions.set(action, [{ ...merging, findingDigest: 'different-finding' }]);
    expect(cooperative.leadCheckpointInstruction(action)).toContain('researchDecisions');
    (cooperative as any).pendingSourceResearchDecisions.set(action, [merging]);
    expect(cooperative.leadCheckpointInstruction(action)).toContain('return without a revision');
  });

  it('requires current host feedback to be repaired before returning from the checkpoint', async () => {
    state.cooperation!.deliveries = [];
    const action = await start();
    state.cooperation!.error = 'math_plan_progress_review_goal_unanswered: goal_0';
    const reminder = cooperative.leadCheckpointInstruction(action);
    expect(reminder).toContain('Repair the current host plan validation feedback');
    expect(reminder).not.toContain('return without a revision');
    delete state.cooperation!.error;
    expect(cooperative.leadCheckpointInstruction(action)).toContain('return without a revision');
  });

  it('bounds repeated incomplete checkpoints even when each saves different draft prose', async () => {
    for (const node of state.cooperation!.tasks) node.task.status = 'paused';
    for (let attempt = 0; attempt < 2; attempt++) {
      const action = await start();
      fs.appendFileSync(notes(), `\nUnfinished draft slice ${attempt}.\n`);
      await checkpoint(action);
    }
    expect(state.cooperation!.planRejection).toMatchObject({ stalled: true,
      error: expect.stringContaining('math_plan_research_decisions_missing') });
    expect(state.cooperation!.lastLeadPauseInputDigest).toBeUndefined();
    expect(await cooperative.next(workers[0], budget)).toBeUndefined();
    expect(events.some(item => item.event === 'plan_stalled')).toBe(true);
    expect(pendingProposals()).toHaveLength(1);
  });

  it('does not let a saved pause or completed-input digest hide an unanswered finding', async () => {
    write(graph());
    // A restored pre-fix archive can contain both markers despite never answering this publication.
    state.cooperation!.lastLeadInputDigest = (cooperative as any).planningInputDigest();
    state.cooperation!.lastLeadPauseInputDigest = (cooperative as any).leadPauseInputDigest();
    state.cooperation!.leadWakes = { requested: 1, consumed: 0, settled: 0 };
    const action = await start();
    expect(cooperative.contextState(action, workers[0]).leadResearchInputIds).toEqual(['proposal-delivery']);
  });

  it('keeps initial dispatch response validation even if an existing graph is present', async () => {
    const action = await start(planText({ ...graph(), ...decide('decline') }));
    action.initialPlanNonce = 'initial-dispatch-with-bootstrap-graph';
    await checkpoint(action);
    // Ordinary validation accepts the inherited graph; the unchanged-draft shortcut is not taken.
    expect(events.some(item => item.event === 'plan_updated')).toBe(true);
    expect(events.some(item => item.event === 'lead_checkpoint_saved')).toBe(false);
  });

  it.each(['final', 'request-failure', 'checkpoint'] as const)('still validates an inherited graph delivered as %s', async kind => {
    const action = await start(planText({ ...graph(), ...decide('decline') })), commit = commitSolverSources(problem, workers[0].worktree);
    cooperative.deactivate(workers[0]);
    const result = await cooperative.deliver(workers[0], action, commit, kind !== 'final', kind === 'final' ? 'checkpoint' : kind);
    expect(result).toEqual({ checkWhole: false, ...(kind === 'request-failure' ? { savedPlan: true } : {}) });
    expect(events.some(item => item.event === 'plan_updated')).toBe(true);
    expect(events.some(item => item.event === 'lead_checkpoint_saved')).toBe(false);
    // The declined proposal is not added to the plan.
    expect(pendingProposals()).toHaveLength(1);
  });

  it('accepts a changed complete checkpoint plan as a new unproved obligation', async () => {
    const action = await start();
    write({ ...graph(), tasks: [...graph().tasks, proposal], ...decide('adopt') });
    await checkpoint(action);
    expect(state.cooperation!.tasks.find(node => node.task.id === proposal.id)).toMatchObject({ status: 'pending', task: proposal });
    expect(state.cooperation!.tasks.find(node => node.task.id === proposal.id)?.integratedCheck).toBeUndefined();
    expect(pendingProposals()).toEqual([]);
    expect(events.some(item => item.event === 'lead_checkpoint_saved' || item.event === 'plan_rejected')).toBe(false);
  });

  it('keeps an already published graph when a checkpoint retains the inherited old notes', async () => {
    const action = await start(), inherited = fs.readFileSync(notes(), 'utf8');
    fs.appendFileSync(path.join(workers[0].worktree, leadPlanDeliveryFile(action)!), JSON.stringify({
      kind: 'plan', dispatchNonce: action.planNonce, baseVersion: action.planVersion,
      ...graph(), tasks: [...graph().tasks, proposal], ...decide('adopt'),
    }) + '\n');
    await cooperative.pulse();
    expect(state.cooperation!.planPublication).toBeDefined();
    fs.writeFileSync(notes(), inherited);
    await checkpoint(action);
    expect(state.cooperation!.tasks.some(node => node.task.id === proposal.id)).toBe(true);
    expect(pendingProposals()).toEqual([]);
    expect(events.some(item => item.event === 'lead_checkpoint_saved' || item.event === 'plan_rejected')).toBe(false);
  });

  it('merges saved Lean sources despite an unchanged control block and still requests whole-proof checking', async () => {
    const action = await start(), file = path.join(workers[0].worktree, problem.projectRelative, 'Submission.lean');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('theorem add_zero', 'lemma checkpoint_draft : True := by trivial\ntheorem add_zero'));
    await expect(checkpoint(action)).resolves.toEqual({ checkWhole: true });
    const canonical = state.cooperation!.canonicalCommit!;
    expect(committedSource(workers[0].worktree, canonical, `${problem.projectRelative}/Submission.lean`)).toContain('lemma checkpoint_draft : True');
    expect(events.some(item => item.event === 'lead_draft_preserved')).toBe(true);
    expect(state.cooperation!.error).toContain('math_plan_research_decisions_missing');
    expect(pendingProposals()).toHaveLength(1);
    expect(state.cooperation!.tasks.every(node => !node.proof && !node.integratedCheck)).toBe(true);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { SolverRunState } from '../src/solver/archive';
import type { CooperationState } from '../src/solver/cooperation';
import { buildResearchContext, finalizeResearchDispatch } from '../src/solver/modules/context';
import { commitSolverSources, type SolverProblem } from '../src/solver/problem';
import { parseCooperationPlan, taskVersion, type CooperativeAction, type CooperativeTask } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

const formal = 'theorem target : True := by sorry';
const problem = { projectRelative: '.', ownedFiles: ['Submission.lean'], declarations: {},
  targets: [{ proofPath: 'Submission.lean', theoremName: 'target' }], receiptDigest: 'problem', baseCommit: 'fixed',
  contract: { formalStatement: formal, assumptions: [] } } as unknown as SolverProblem;
const task: CooperativeTask = { id: 'goal', kind: 'lemma', objective: 'Prove target', dependsOn: [], revision: 0,
  proofPath: 'Submission.lean', theoremName: 'target', type: 'True' };
const rejected = (error: string, id: string) => ({ error,
  planRejection: { error, proposalDigest: `proposal-${id}`, inputDigest: `input-${id}`, stalled: false } });
const build = (cooperation: CooperationState, action: CooperativeAction) => buildResearchContext(problem,
  { cooperation } as unknown as SolverRunState, { root: '/runtime', worktree: '/proof', environment: {},
    taskText: 'Prove target', retrievalRoot: '/library', maxOptionalContextBytes: 0,
    frozenContexts: { 'Submission.lean': 'theorem target : True := /- body omitted -/' }, assignment: action });

it.each([false, true])('carries only the current rejected plan into full and warm Lead dispatches (existing graph: %s)', existing => {
  const cooperation: CooperationState = { tasks: existing ? [{ task, status: 'pending', attempts: 0 }] : [] };
  const action: CooperativeAction = { kind: 'lead', seedCommit: 'fixed', planVersion: 'plan',
    ...(existing ? { planNonce: 'revision' } : { initialPlanNonce: 'initial' }) };
  const errors = ['math_plan_research_decisions_missing: answer each shown deliveryId in researchDecisions.',
    'math_plan_invalid_proof_target: task goal, field theoremName'];
  for (const [index, error] of errors.entries()) {
    Object.assign(cooperation, rejected(error, String(index)));
    const context = build(cooperation, action);
    for (const continuation of [false, true]) {
      const dispatch = finalizeResearchDispatch(context, { continuation });
      expect(dispatch.message).toContain(error);
      expect(dispatch.message).toContain(JSON.stringify(cooperation.planRejection));
      expect(dispatch.message).toContain('"originalTargets":[{"proofPath":"Submission.lean","theoremName":"target"}]');
      expect(dispatch.manifest.included).toContainEqual(expect.objectContaining({ id: 'plan-rejection', required: true }));
      expect(dispatch.manifest.optionalBytes).toBe(0);
      if (index) expect(dispatch.message).not.toContain(errors[0]);
    }
  }
  cooperation.error = undefined;
  cooperation.planRejection = undefined;
  const repaired = build(cooperation, action);
  for (const continuation of [false, true]) {
    const dispatch = finalizeResearchDispatch(repaired, { continuation });
    for (const error of errors) expect(dispatch.message).not.toContain(error);
    expect(dispatch.manifest.included.some(section => section.id === 'plan-rejection')).toBe(false);
  }
});

it('retains a current recoverable Lead error without a complete rejection record', () => {
  const error = 'math_plan_incomplete: saved planning draft';
  const context = build({ tasks: [], error }, { kind: 'lead', seedCommit: 'fixed', initialPlanNonce: 'initial' });
  for (const continuation of [false, true]) {
    const dispatch = finalizeResearchDispatch(context, { continuation });
    expect(dispatch.message).toContain(error);
    expect(dispatch.manifest.included).toContainEqual(expect.objectContaining({ id: 'plan-rejection', required: true }));
  }
});

it.each(['task', 'review'] as const)('keeps Lead plan errors out of %s dispatches', kind => {
  const error = 'math_plan_research_decisions_missing: private planning error';
  const action: CooperativeAction = kind === 'review' ? { kind, seedCommit: 'fixed', sourceDigest: 'source' } :
    { kind, task, assignment: { taskId: task.id, taskDigest: taskVersion(task), workerId: 'peer', seedCommit: 'fixed' } };
  const context = build({ tasks: [{ task, status: 'pending', attempts: 0 }], ...rejected(error, 'private') }, action);
  for (const continuation of [false, true]) {
    const dispatch = finalizeResearchDispatch(context, { continuation });
    expect(dispatch.message).not.toContain(error);
    expect(dispatch.manifest.included.some(section => section.id === 'plan-rejection')).toBe(false);
  }
});

it('updates only the Lead inbox on plan rejection and clears it when a repaired plan is accepted', async () => {
  const example = localExample('solver-plan-rejection-feedback-', 'lead');
  const lead = leadWorker(example.problem, example.workspace);
  const peer = peerWorker(example, 'engineer', { role: 'engineer' });
  const plan = parseCooperationPlan(example.problem, { tasks: example.problem.targets.map((target, index) => ({
    id: `goal_${index}`, kind: 'goal', objective: `Prove ${target.theoremName}.`, ...target,
  })) });
  const state = solverState(example.problem, example.workspace, { runId: 'rejection-feedback', phase: 'running',
    cooperation: { tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
      groups: plan.groups.map(group => ({ group, turns: 0 })), error: 'fixture_request_new_plan' } });
  const controller = new AbortController();
  const cooperative = cooperativeResearch({ state, workers: [lead, peer], retrievalRoot: example.directory,
    signal: controller.signal });
  const inbox = (worktree: string) => JSON.parse(fs.readFileSync(path.join(worktree, 'COOPERATION.json'), 'utf8'));
  const deliver = async (value: unknown) => {
    const action = await cooperative.next(lead, { maxTurns: Infinity, remainingMs: Infinity });
    if (action?.kind !== 'lead') throw new Error('fixture_expected_lead');
    expect(cooperative.started(lead, action)).toBe(true);
    cooperative.activate(lead, action, vi.fn(async () => {}), async () => {});
    fs.writeFileSync(path.join(lead.worktree, 'RESEARCH.md'), '```math-plan\n' + JSON.stringify(value) + '\n```');
    cooperative.deactivate(lead);
    await cooperative.deliver(lead, action, commitSolverSources(example.problem, lead.worktree));
  };
  try {
    await deliver({ tasks: [] });
    expect(state.cooperation!.error).toBe('math_plan_invalid');
    expect(state.cooperation!.planRejection).toBeDefined();
    expect(inbox(lead.worktree)).toMatchObject({ error: state.cooperation!.error, planRejection: state.cooperation!.planRejection });
    expect(inbox(peer.worktree)).not.toHaveProperty('error');
    expect(inbox(peer.worktree)).not.toHaveProperty('planRejection');
    await deliver({ tasks: plan.tasks, groups: plan.groups });
    expect(state.cooperation!.error).toBeUndefined();
    expect(state.cooperation!.planRejection).toBeUndefined();
    expect(inbox(lead.worktree)).not.toHaveProperty('error');
    expect(inbox(lead.worktree)).not.toHaveProperty('planRejection');
    expect(inbox(peer.worktree)).not.toHaveProperty('error');
    expect(inbox(peer.worktree)).not.toHaveProperty('planRejection');
  } finally {
    controller.abort();
    await cooperative.stop();
    fs.rmSync(example.directory, { recursive: true, force: true });
  }
});

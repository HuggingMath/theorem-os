import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SolverRunState } from '../src/solver/archive';
import type { CooperativeResearch } from '../src/solver/cooperation';
import type { ResearchWorker } from '../src/solver/modules/organization';
import { commitSolverSources, type SolverProblem } from '../src/solver/problem';
import { parseCooperationPlan, taskVersion, type CooperativeAction, type CooperativeTask } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

const host = vi.hoisted(() => ({ verify: vi.fn(), createSession: vi.fn() }));
vi.mock('../src/math/verifier', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/verifier')>(), checkManyFormalVerifications: host.verify,
  resolveMathematicsLakePackagesCache: () => undefined,
}));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.createSession }));

type Lead = Extract<CooperativeAction, { kind: 'lead' }>;

describe('correction of inherited rejected Lead drafts', () => {
  const budget = { maxTurns: Infinity, remainingMs: Infinity };
  let directory: string, problem: SolverProblem, workers: ResearchWorker[], state: SolverRunState;
  let cooperative: CooperativeResearch, controller: AbortController;
  let notify: ReturnType<typeof vi.fn<(message: string) => Promise<void>>>;
  let proposal: CooperativeTask;
  const graph = () => ({ tasks: state.cooperation!.tasks.map(node => node.task),
    groups: state.cooperation!.groups!.map(route => route.group) });
  const notes = () => path.join(workers[0].worktree, 'RESEARCH.md');
  const write = (response: unknown) => fs.writeFileSync(notes(), '```math-plan\n' + JSON.stringify(response) + '\n```\n');
  const decision = () => ({ researchDecisions: [{ deliveryId: 'unanswered-finding', outcome: 'decline',
    reason: 'The accepted route uses a different exact construction.' }] });
  const start = async () => {
    const action = await cooperative.next(workers[0], budget);
    if (action?.kind !== 'lead' || !action.planNonce) throw new Error('fixture_expected_lead_revision');
    expect(cooperative.started(workers[0], action)).toBe(true);
    cooperative.activate(workers[0], action, async () => {}, notify);
    return action;
  };
  const checkpoint = async (action: Lead) => {
    const commit = commitSolverSources(problem, workers[0].worktree);
    cooperative.deactivate(workers[0]);
    return cooperative.deliver(workers[0], action, commit, true, 'scheduling-checkpoint');
  };
  const rejectForRetry = async () => {
    const action = await start();
    await checkpoint(action);
    expect(state.cooperation!.error).toContain('math_plan_research_decisions_missing');
    expect(state.cooperation!.planRejection?.stalled).toBe(false);
    return start();
  };

  beforeEach(() => {
    host.verify.mockReset().mockImplementation(() => { throw new Error('fixture_unexpected_proof_acceptance'); });
    host.createSession.mockReset().mockImplementation(() => { throw new Error('fixture_real_models_forbidden'); });
    const example = localExample('lead-inherited-draft-correction-', 'lead');
    ({ directory, problem } = example);
    workers = [leadWorker(problem, example.workspace), peerWorker(example, 'researcher')];
    const question: CooperativeTask = { id: 'question', kind: 'research', objective: 'Find an exact bridge.', dependsOn: [], revision: 0 };
    proposal = { id: 'bridge', kind: 'lemma', objective: 'Prove the exact bridge.', theoremName: 'Tutorial.bridge',
      proofPath: 'Submission.lean', type: 'True', dependsOn: [], revision: 0 };
    const plan = parseCooperationPlan(problem, { tasks: [question, ...problem.targets.map((target, index) => ({
      id: `goal_${index}`, kind: 'goal', objective: `Prove ${target.theoremName}.`, ...target, status: 'paused',
    }))] });
    state = solverState(problem, example.workspace, { runId: 'inherited-draft-correction', phase: 'running',
      workers: workers.map(worker => ({ id: worker.id, role: worker.role, worktree: worker.worktree, phase: 'checking', turns: 0 })),
      cooperation: { canonicalCommit: problem.baseCommit,
        tasks: plan.tasks.map(task => ({ task, attempts: 0, status: task.id === question.id ? 'completed' : 'pending' })),
        groups: plan.groups.map(group => ({ group, turns: 0 })),
        deliveries: [{ id: 'unanswered-finding', producer: workers[1].id, taskId: question.id, taskDigest: taskVersion(question),
          kind: 'research', status: 'advisory', summary: 'An exact bridge awaits the Lead decision.', statement: '', premises: [],
          dependencies: [], remainingObligations: [], evidenceRefs: [], createdAt: 1, lemmaRequests: [proposal] }] } });
    controller = new AbortController(); notify = vi.fn(async (_message: string) => {});
    cooperative = cooperativeResearch({ state, workers, retrievalRoot: directory, signal: controller.signal });
    write(graph());
  });
  afterEach(async () => {
    controller.abort(); await cooperative.stop();
    expect(host.verify).not.toHaveBeenCalled(); expect(host.createSession).not.toHaveBeenCalled();
    vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true });
  });

  it('reports a previously rejected inherited draft at checkpoint handoff without publishing it', async () => {
    const action = await rejectForRetry(), before = structuredClone(state.cooperation!.tasks);
    await cooperative.pulse();
    expect(notify).not.toHaveBeenCalled();
    expect(cooperative.leadCheckpointHandoff(action)?.reason).toContain('math_plan_research_decisions_missing');
    expect(cooperative.leadCheckpointInstruction(action)).toContain('unanswered-finding');
    expect(state.cooperation!.tasks).toEqual(before);
    expect(state.cooperation!.researchDecisions).toBeUndefined();
    expect(state.cooperation!.planPublication).toBeUndefined();
    write({ ...graph(), ...decision() });
    expect(cooperative.leadCheckpointHandoff(action)).toBeUndefined();
    expect(state.cooperation!.researchDecisions).toBeUndefined();
    expect(state.cooperation!.planPublication).toBeUndefined();
    expect(state.cooperation!.error).toContain('math_plan_research_decisions_missing');
    await checkpoint(action);
    expect(state.cooperation!.researchDecisions).toContainEqual(expect.objectContaining({
      deliveryId: 'unanswered-finding', outcome: 'decline' }));
    expect(state.cooperation!.error).toBeUndefined();
  });

  it('requests the decision without diagnosing an ordinary accepted baseline as a rejected draft', async () => {
    const action = await start();
    expect(cooperative.leadCheckpointHandoff(action)).toEqual({ reason: undefined });
    expect(state.cooperation!.planRejection).toBeUndefined();
    expect(state.cooperation!.researchDecisions).toBeUndefined();
  });

  it('does not mistake an accepted baseline for a different previously rejected draft', async () => {
    const action = await start();
    write({ ...graph(), tasks: [...graph().tasks, proposal] });
    await checkpoint(action);
    expect(state.cooperation!.planRejection?.error).toContain('math_plan_research_decisions_missing');
    write(graph());
    const retry = await start();
    expect(cooperative.leadCheckpointHandoff(retry)).toEqual({ reason: undefined });
    expect(state.cooperation!.researchDecisions).toBeUndefined();
  });

  it('does not correct a missing research decision already settled by other accepted evidence', async () => {
    const action = await rejectForRetry();
    const finding = state.cooperation!.deliveries!.find(record => record.id === 'unanswered-finding')!;
    state.cooperation!.researchDecisions = [{ deliveryId: finding.id, taskDigest: finding.taskDigest,
      findingDigest: finding.findingDigest, outcome: 'decline', reason: 'An accepted decision already settled this finding.',
      at: 1, planVersion: state.cooperation!.planVersion! }];
    expect(cooperative.leadCheckpointHandoff(action)?.reason).toBeUndefined();
    expect(state.cooperation!.planPublication).toBeUndefined();
  });
});

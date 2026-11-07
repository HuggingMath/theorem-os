import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MathematicsVerifierBatchRequest } from '../src/math/verifier';
import { writeSolverRunState, type SolverRunState } from '../src/solver/archive';
import { parseCooperationPlan, type CooperativeResearch } from '../src/solver/cooperation';
import { readHumanGuidance, queueHumanGuidance, type HumanGuidanceInput } from '../src/solver/humanGuidance';
import { runInspectionSnapshot } from '../src/solver/inspection';
import { directSolverModules } from '../src/solver/modules';
import type { ResearchWorker } from '../src/solver/modules/organization';
import { captureObligationSnapshot } from '../src/solver/obligationProgress';
import { commitSolverSources, type SolverProblem } from '../src/solver/problem';
import { taskVersion, type CooperativeAction } from '../src/solver/tasks';
import { deferred } from './helpers/async';
import { answeredGoalPathStall, cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';
import { verifiedBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ verify: vi.fn(), createSession: vi.fn() }));
vi.mock('../src/math/verifier', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify,
  formalVerificationToolIdentity: () => 'dependency-scheduling-fixture-tools',
  resolveMathematicsLakePackagesCache: () => undefined,
}));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.createSession }));

const budget = { maxTurns: Infinity, remainingMs: Infinity };
const verified = (request: MathematicsVerifierBatchRequest) => verifiedBatch(request, { sessionId: 'dependency-scheduling-fixture' });
type TaskAction = Extract<CooperativeAction, { kind: 'task' }>;

describe('critical-dependency scheduling during host work', () => {
  let directory: string, problem: SolverProblem, state: SolverRunState;
  let lead: ResearchWorker, first: ResearchWorker, second: ResearchWorker, engineer: ResearchWorker;
  let cooperative: CooperativeResearch, controller: AbortController, action: TaskAction, modelAllowed: boolean;
  let pending: Promise<unknown>[], releases: (() => void)[];
  let events: { event: string; details?: Record<string, unknown> }[];
  const node = (id: string) => state.cooperation!.tasks.find(item => item.task.id === id)!;
  const record = (worker: ResearchWorker) => state.workers!.find(item => item.id === worker.id)!;
  const refresh = () => (cooperative as any).changed();
  const overlays = () => state.cooperation!.tasks.filter(item => item.capacityExploration);
  const track = <T,>(promise: Promise<T>) => { pending.push(promise); void promise.catch(() => {}); return promise; };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const waitFor = async (worker: ResearchWorker, limits = budget) => {
    let settled = false;
    const waiting = track(cooperative.next(worker, limits));
    void waiting.then(() => { settled = true; }, () => { settled = true; });
    await flush(); expect(settled).toBe(false);
    return { waiting };
  };
  const activate = (worker: ResearchWorker, work: CooperativeAction) => {
    expect(cooperative.started(worker, work)).toBe(true);
    cooperative.activate(worker, work, async () => {}, async () => {});
  };
  const idleFor = (worker: ResearchWorker, ms = 31 * 60_000) => {
    record(worker).scheduling = { status: 'idle', since: Date.now() - ms };
  };
  const unanswered = (count = 2) => {
    state.cooperation!.leadDecisionBasisAt = Date.now() - 90 * 60_000;
    state.cooperation!.idlePeerWake = { at: Date.now() - 5 * 60_000, workerIds: [first.id, second.id], count };
  };
  const completeExploration = async (worker: ResearchWorker, work: CooperativeAction | undefined) => {
    if (work?.kind !== 'task') throw new Error('fixture_expected_exploration');
    activate(worker, work);
    fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), '```math-result\n' + JSON.stringify({
      taskId: work.task.id, conclusion: 'inconclusive', summary: 'The proposed decomposition leaves the original goal open.',
    }) + '\n```\n');
    cooperative.deactivate(worker);
    await cooperative.deliver(worker, work, commitSolverSources(problem, worker.worktree));
    expect(node(work.task.id).status).toBe('completed');
  };
  const holdProof = async () => {
    const entered = deferred(), blocked = deferred();
    releases.push(blocked.resolve);
    host.verify.mockImplementationOnce(async request => { entered.resolve(); await blocked.promise; return verified(request); });
    const source = path.join(engineer.worktree, problem.projectRelative, 'Submission.lean');
    fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('end Tutorial', 'lemma busy_helper : True := by trivial\nend Tutorial'));
    const commit = commitSolverSources(problem, engineer.worktree);
    cooperative.deactivate(engineer);
    const checking = track(cooperative.deliver(engineer, action, commit));
    await entered.promise;
    return { checking, release: blocked.resolve, commit };
  };
  const guide = async (id: string, overrides: Partial<HumanGuidanceInput> = {}) => {
    const stateFile = path.join(directory, 'state.json');
    writeSolverRunState(stateFile, state);
    return queueHumanGuidance(stateFile, { id, recipient: { kind: 'lead', id: lead.id },
      text: 'Audit helper premises and explicitly connect each prerequisite to its consumer through a versioned plan.',
      observationRef: { sequence: 1, stateDigest: runInspectionSnapshot(state).stateDigest }, ...overrides });
  };
  const guidance = () => readHumanGuidance(path.join(directory, 'state.json'), state.runId);
  const unchangedLeadInputs = () => {
    state.cooperation!.lastLeadInputDigest = (cooperative as any).planningInputDigest();
    state.cooperation!.lastLeadPauseInputDigest = (cooperative as any).leadPauseInputDigest();
    answeredGoalPathStall(state);
  };

  beforeEach(() => {
    const example = localExample('solver-dependency-scheduling-', 'lead');
    ({ directory, problem } = example);
    lead = leadWorker(problem, example.workspace);
    first = peerWorker(example, 'researcher-1'); second = peerWorker(example, 'researcher-2');
    engineer = peerWorker(example, 'engineer', { role: 'engineer' });
    const workers = [lead, first, second, engineer];
    const plan = parseCooperationPlan(problem, { tasks: [
      { id: 'busy_helper', kind: 'lemma', ownerId: engineer.id, objective: 'Prove the exact original-goal prerequisite.',
        proofPath: 'Submission.lean', theoremName: 'Tutorial.busy_helper', type: 'True' },
      ...problem.targets.map((target, index) => ({ id: `goal_${index}`, kind: 'goal', ownerId: engineer.id,
        objective: `Prove ${target.theoremName}.`, theoremName: target.theoremName,
        proofPath: target.proofPath, dependsOn: ['busy_helper'] })),
    ], groups: [{ id: 'main', objective: 'Close the frozen original goals.', engineerId: engineer.id, maxConcurrent: 3 }] });
    state = solverState(problem, example.workspace, { runId: 'dependency-scheduling-fixture', phase: 'running',
      workers: workers.map(worker => ({ ...worker, phase: 'running', turns: 0 })),
      cooperation: { canonicalCommit: problem.baseCommit, tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
        groups: plan.groups.map(group => ({ group, turns: 0 })) } });
    const envFile = path.join(directory, 'math.env'); fs.writeFileSync(envFile, '');
    const environment = { PATH: '/usr/bin:/bin', DEEPSCIENTIST_MATH_ENV_FILE: envFile };
    controller = new AbortController(); pending = []; releases = []; events = []; modelAllowed = true;
    host.verify.mockReset().mockImplementation(async request => verified(request));
    host.createSession.mockReset().mockImplementation(() => { throw new Error('fixture_real_models_forbidden'); });
    cooperative = cooperativeResearch({ state, workers, retrievalRoot: directory, continuousResearch: true,
      signal: controller.signal, access: new Map(workers.map(worker => [worker.id, { environment, retrievalRoot: directory }])),
      modelDispatchAllowed: () => modelAllowed, emit: (event, details) => events.push({ event, details }),
      modules: { ...directSolverModules, M2: { ...directSolverModules.M2, closeTask: undefined } } });
    state.cooperation!.planVersion = (cooperative as any).planVersion();
    state.cooperation!.planEdited = true; (cooperative as any).syncPlanNotes();
    const busy = node('busy_helper');
    busy.assignment = { taskId: busy.task.id, taskDigest: taskVersion(busy.task), workerId: engineer.id,
      seedCommit: problem.baseCommit, assignmentId: 'long-running-original-dependency' };
    Object.assign(busy, { status: 'running' });
    action = { kind: 'task', task: busy.task, assignment: busy.assignment };
    activate(engineer, action);
  });
  afterEach(async () => {
    releases.forEach(release => release()); controller.abort();
    await Promise.allSettled(pending); await cooperative.stop();
    expect(host.createSession).not.toHaveBeenCalled();
    vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each([Infinity, 2 * 60 * 60_000])('supplies the two narrow methods to four workers with %s ms remaining without changing the mathematical plan', async remainingMs => {
    const snapshot = captureObligationSnapshot(state.cooperation!.tasks, { groups: state.cooperation!.groups,
      environmentDigest: state.environmentDigest }), version = state.cooperation!.planVersion;
    idleFor(first); idleFor(second); unanswered();
    const decomposition = await cooperative.next(first, { ...budget, remainingMs });
    if (decomposition?.kind !== 'task') throw new Error('fixture_expected_exploration');
    activate(first, decomposition);
    const construction = await cooperative.next(second, { ...budget, remainingMs });
    if (construction?.kind !== 'task') throw new Error('fixture_expected_exploration');
    expect(node(decomposition.task.id).capacityExploration).toMatchObject({ focus: 'decomposition', targetTaskId: 'busy_helper' });
    expect(node(construction.task.id).capacityExploration).toMatchObject({ focus: 'construction', targetTaskId: 'busy_helper' });
    expect(events.filter(item => item.event === 'capacity_exploration_requested').map(item => item.details?.gate))
      .toEqual(['timed-idle', 'timed-idle']);
    expect(state.cooperation!.planVersion).toBe(version);
    expect(captureObligationSnapshot(state.cooperation!.tasks, { groups: state.cooperation!.groups,
      environmentDigest: state.environmentDigest })).toEqual(snapshot);
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('preserves the wait interval and durable per-input method tombstones under an infinite deadline', async () => {
    idleFor(first); unanswered();
    const decomposition = await cooperative.next(first, budget);
    await completeExploration(first, decomposition);
    const { waiting } = await waitFor(first);
    expect(overlays()).toHaveLength(1);
    idleFor(first); unanswered(); refresh();
    const construction = await waiting;
    await completeExploration(first, construction);
    idleFor(first); unanswered(); await waitFor(first);
    expect(overlays().map(item => item.capacityExploration!.focus)).toEqual(['decomposition', 'construction']);
    expect(state.cooperation!.capacityExplorationInputs).toHaveLength(2);
  });

  it.each([
    { name: 'less than thirty minutes idle', idle: 29 * 60_000 },
    { name: 'only one unanswered wake', wakes: 1 },
    { name: 'a deciding Lead after the wakes', decided: true },
    { name: 'a finite turn budget', maxTurns: 50 },
    { name: 'less than thirty minutes remaining', remainingMs: 29 * 60_000 },
    { name: 'a running Lead', leadRunning: true },
  ])('keeps the narrow gate with $name', async scenario => {
    idleFor(first, scenario.idle ?? 31 * 60_000); unanswered(scenario.wakes ?? 2);
    if (scenario.decided) state.cooperation!.leadDecisionBasisAt = Date.now() - 60_000;
    if (scenario.leadRunning) {
      const leadAction = (cooperative as any).leadDecision(lead, problem.baseCommit, (cooperative as any).planningInputDigest());
      activate(lead, leadAction);
    }
    await waitFor(first, { maxTurns: scenario.maxTurns ?? Infinity, remainingMs: scenario.remainingMs ?? Infinity });
    expect(overlays()).toHaveLength(0); expect(state.cooperation!.capacityExplorationInputs).toBeUndefined();
  });

  it('keeps a frozen host proof busy and goal-active, wakes the idle Lead, and releases occupancy on completion', async () => {
    const { checking, release, commit } = await holdProof();
    expect(record(engineer).scheduling).toMatchObject({ status: 'working', action: 'task', taskId: 'busy_helper' });
    expect(state.cooperation!.goalProgress!.goals.every(goal => goal.active)).toBe(true);
    expect(state.cooperation!.groups![0].busy).toBe(1);
    const agents = JSON.parse(fs.readFileSync(path.join(lead.worktree, 'COOPERATION.json'), 'utf8')).agents;
    expect(agents.find((agent: { id: string }) => agent.id === engineer.id)).toMatchObject({ status: 'working', work: { taskId: 'busy_helper' } });
    // An overlapping intake of the same frozen proof shares the original check.
    const duplicate = track(cooperative.deliver(engineer, action, commit));
    idleFor(first); idleFor(second); idleFor(lead, 20 * 60_000);
    for (const worker of [first, second]) record(worker).scheduling!.wait = {
      stage: 'm3-no-ready', observedAt: Date.now() - 31 * 60_000, candidates: [], candidateCount: 0, omittedCandidates: 0 };
    state.cooperation!.leadDecisionBasisAt = Date.now() - 90 * 60_000;
    unchangedLeadInputs();
    const decision = await cooperative.next(lead, budget);
    expect(decision?.kind).toBe('lead');
    expect(events.find(item => item.event === 'lead_woken_for_idle_peers')?.details?.workerIds).toEqual([first.id, second.id]);
    expect(host.verify).toHaveBeenCalledOnce();
    release(); await checking; await duplicate;
    expect(node('busy_helper').status).toBe('integrated');
    expect(record(engineer).scheduling).toMatchObject({ status: 'idle' });
    expect(state.cooperation!.groups![0].busy).toBe(0);
    expect(state.cooperation!.goalProgress!.goals.every(goal => !goal.active)).toBe(true);
  });

  it('does not issue exploration to a host checker, and keeps stale work occupied without counting goal effort', async () => {
    const { checking, release } = await holdProof();
    idleFor(engineer); unanswered();
    expect(await (cooperative as any).requestCapacityExploration(engineer, budget, [])).toBe(false);
    expect(overlays()).toHaveLength(0);
    node('busy_helper').task = { ...node('busy_helper').task, revision: 1 };
    refresh();
    expect(cooperative.current(action)).toBe(false);
    expect(record(engineer).scheduling).toMatchObject({ status: 'working', taskId: 'busy_helper' });
    expect(state.cooperation!.goalProgress!.goals.every(goal => !goal.active)).toBe(true);
    release(); await checking;
    expect(node('busy_helper').proof).toBeUndefined();
    expect(record(engineer).scheduling?.status).toBe('idle');
  });

  it('holds the worker and group slot while a checked proof awaits canonical integration', async () => {
    const entered = deferred(), blocked = deferred(); releases.push(blocked.resolve);
    const integrate = (cooperative as any).integrateNow.bind(cooperative);
    vi.spyOn(cooperative as any, 'integrateNow').mockImplementation(async (...args: unknown[]) => {
      entered.resolve(); await blocked.promise; return integrate(...args);
    });
    const { checking, release } = await holdProof();
    release(); await entered.promise;
    expect(node('busy_helper').status).toBe('delivered');
    expect(record(engineer).scheduling).toMatchObject({ status: 'working', taskId: 'busy_helper' });
    expect(state.cooperation!.groups![0].busy).toBe(1);
    expect(state.cooperation!.goalProgress!.goals.every(goal => goal.active)).toBe(true);
    blocked.resolve(); await checking;
    expect(record(engineer).scheduling?.status).toBe('idle');
    expect(state.cooperation!.groups![0].busy).toBe(0);
  });

  it('drains the existing host publication promises on stop and disables the goal clock', async () => {
    const { checking, release } = await holdProof();
    let stopped = false;
    const stopping = track(cooperative.stop().then(() => { stopped = true; }));
    await flush(); expect(stopped).toBe(false);
    expect(state.cooperation!.goalProgress!.goals.every(goal => !goal.active)).toBe(true);
    release(); await checking; await stopping;
    expect(stopped).toBe(true); expect(record(engineer).scheduling?.status).toBe('idle');
  });

  it('wakes a waiting ordinary Lead for guidance despite unchanged rejected input, then delivers once', async () => {
    unchangedLeadInputs();
    state.cooperation!.planRejection = { inputDigest: (cooperative as any).planningInputDigest(),
      proposalDigest: (cooperative as any).proposedPlanDigest(), stalled: true } as any;
    const { waiting } = await waitFor(lead);
    await guide('repair-dependencies'); await cooperative.pulse(lead.id);
    const decision = await waiting;
    expect(decision?.kind).toBe('lead');
    expect(guidance()[0].status).toBe('deferred');
    const notify = vi.fn(async () => {});
    expect(cooperative.started(lead, decision!)).toBe(true);
    cooperative.activate(lead, decision!, async () => {}, notify);
    await cooperative.pulse(lead.id); await cooperative.pulse(lead.id);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]).toEqual([expect.stringContaining('repair-dependencies'), { requireTurn: true }]);
    expect(guidance()[0]).toMatchObject({ status: 'delivered', deliveredTo: [lead.id] });
    expect(state.cooperation!.tasks.map(item => item.task.id)).toEqual(['busy_helper', ...problem.targets.map((_, index) => `goal_${index}`)]);
  });

  it('finds a previously deferred Lead note without another record-status transition', async () => {
    await guide('restored-guidance'); await cooperative.pulse(lead.id);
    expect(guidance()[0].status).toBe('deferred');
    unchangedLeadInputs();
    const decision = await cooperative.next(lead, budget);
    expect(decision?.kind).toBe('lead');
  });

  it.each(['time', 'turns', 'model', 'review', 'statement-review', 'synchronization'] as const)('does not let ordinary guidance bypass the %s gate', async gate => {
    unchangedLeadInputs(); await guide(`gate-${gate}`);
    if (gate === 'turns') state.turns = 1;
    if (gate === 'model') modelAllowed = false;
    if (gate === 'review') state.cooperation!.review = { status: 'pending', commit: problem.baseCommit, sourceDigest: 'fixture' } as any;
    if (gate === 'statement-review') vi.spyOn(cooperative as any, 'pendingFixedStatementReviews').mockReturnValue(true);
    if (gate === 'synchronization') vi.spyOn(cooperative as any, 'synchronizationPending').mockReturnValue(true);
    await waitFor(lead, { maxTurns: gate === 'turns' ? 1 : Infinity, remainingMs: gate === 'time' ? 0 : Infinity });
    expect(guidance()[0].status).toBe('queued');
  });

  it('retains the approval revision protocol and keeps peers gated after a Lead note', async () => {
    state.planApproval = true; refresh(); await guide('approval-revision');
    const decision = await cooperative.next(lead, budget);
    expect(decision?.kind).toBe('lead');
    expect(state.cooperation!.planApproval?.guidanceIds).toEqual(['approval-revision']);
    await waitFor(lead); await waitFor(first);
    expect(record(first).scheduling?.wait?.stage).toBe('plan-approval');
    expect(events.filter(item => item.event === 'plan_approval_revision')).toHaveLength(1);
  });

  it('keeps task-scoped Lead notes deferred instead of reopening an unrelated plan turn', async () => {
    unchangedLeadInputs();
    await guide('task-scoped', { taskRef: { id: 'busy_helper', version: taskVersion(node('busy_helper').task) } });
    await cooperative.pulse(lead.id); await waitFor(lead);
    expect(guidance()[0].status).toBe('deferred');
    expect(host.verify).not.toHaveBeenCalled();
  });
});

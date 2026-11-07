import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SolverRunState } from '../src/solver/archive';
import { parseCooperationPlan, type CooperativeResearch } from '../src/solver/cooperation';
import type { TaskProof } from '../src/solver/cooperativeProof';
import type { DeliveryRecord } from '../src/solver/deliveries';
import { GOAL_PROGRESS_REVIEW_MS, observeGoalProgress, type GoalProgressState } from '../src/solver/goalProgress';
import { bindMathematicalGap, mathematicalGaps } from '../src/solver/mathematicalGaps';
import { buildResearchContext } from '../src/solver/modules/context';
import { captureObligationSnapshot } from '../src/solver/obligationProgress';
import { captureProofReferences } from '../src/solver/proofReferences';
import { commitSolverSources } from '../src/solver/problem';
import { prepareResearchDelivery } from '../src/solver/researchAdmission';
import { recordRouteBlockers, refreshRouteBlockers, type RouteBlocker } from '../src/solver/routeControl';
import { automaticTaskConnection, createTaskConnectionCheck } from '../src/solver/taskConnections';
import { invalidatedTaskIds, markTaskAcceptance, taskProofContractVersion, taskVersion,
  type CooperativeAction, type CooperativeTask, type TaskRecord } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState, type LocalExample } from './helpers/solver';
import { receiptBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ createSession: vi.fn() }));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.createSession }));

const identity = { problemReceiptDigest: 'fixture-receipt', environmentDigest: 'feedback-environment' };
const roots: string[] = [];
const running: { cooperation: CooperativeResearch; controller: AbortController }[] = [];
const fixture = () => { const result = localExample('solver-capability-feedback-'); roots.push(result.directory); return result; };
const helper = (id: string, dependsOn: readonly string[] = []): CooperativeTask => ({ id, kind: 'lemma',
  objective: `Prove ${id}.`, revision: 0, proofPath: 'Submission.lean', theoremName: `Tutorial.${id}`, type: 'True', dependsOn });
const node = (task: CooperativeTask): TaskRecord => ({ task, status: 'pending', attempts: 0 });
const goals = (example: LocalExample): CooperativeTask[] => example.problem.targets.map((target, index) => ({
  id: `goal_${index}`, kind: 'goal', objective: `Prove ${target.theoremName}.`, revision: 0, dependsOn: [], ...target,
}));
const assignment = (task: CooperativeTask, seedCommit: string) => ({ taskId: task.id, taskDigest: taskVersion(task),
  workerId: 'peer', seedCommit, assignmentId: 'feedback-assignment', dependencies: [] });
const proof = (task: CooperativeTask, conditions: NonNullable<TaskProof['conditions']> = [], references?: TaskProof['references']): TaskProof => {
  const digest = taskVersion(task), commit = 'f'.repeat(40);
  return { taskDigest: digest, seedCommit: commit, commit, sourceDigest: 'fixture-source', passed: true, conditions,
    changes: [{ file: task.proofPath!, name: task.theoremName!, after: `lemma ${task.theoremName} : ${task.type} := by trivial\n` }],
    projection: { ...identity, sourceDigest: 'fixture-source' }, ...(references ? { references } : {}),
    verification: receiptBatch({ projectRoot: '/unused-fixture', targetCommit: commit, items: [{
      proofPath: task.proofPath!, theoremName: task.theoremName, statementHash: digest, leanStatementHash: digest,
    }] }, { sessionId: 'feedback-verifier', receiptId: () => `feedback-${task.id}` }) };
};

afterEach(async () => {
  for (const instance of running.splice(0)) { instance.controller.abort(); await instance.cooperation.stop(); }
  expect(host.createSession).not.toHaveBeenCalled();
  host.createSession.mockReset();
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('mathematical feedback consumed by the next turn', () => {
  it.each(['lead', 'task'] as const)('keeps scoped negative evidence inline in full and same-thread %s contexts', role => {
    const example = fixture(), goalTasks = goals(example), goal = goalTasks[0]!;
    const research: CooperativeTask = { id: 'finite_tree_audit', kind: 'research', revision: 0,
      objective: 'Determine whether the finite-tree identity supports the original estimate.', dependsOn: [goal.id] };
    const tasks = [...goalTasks.map(node), node(research)], sourceAssignment = assignment(research, example.problem.baseCommit);
    const gap = { consumer: { taskId: goal.id, taskDigest: taskVersion(goal) },
      previousGap: 'The proposed finite-tree identity was assumed to give the norm estimate.',
      reduced: 'Exact arithmetic in the saved finite example gives 6 ≠ 4, excluding that identity.',
      remaining: 'A bound for the actual segment norm, followed by completion and density, remains unproved.',
      evidenceScope: 'One exact finite calculation; no Lean proof or general counterexample to the original theorem.',
      reconsiderWhen: ['A different finite-tree estimate with a concrete application to the original norm.'] };
    const admission = prepareResearchDelivery({ kind: 'event', value: { conclusion: 'inconclusive',
      summary: 'The proposed identity fails; the original norm estimate is still open.', mathematicalGap: gap,
      remainingObligations: [gap.remaining], lemmaRequests: [] } }, {
      source: research, assignment: sourceAssignment, tasks,
      identity: { ...identity, problemReceiptDigest: example.problem.receiptDigest },
    });
    if (admission.status !== 'admitted') throw new Error('fixture-research-not-admitted');
    expect(admission.finding.conclusion).toBe('inconclusive');
    const delivery: DeliveryRecord = { id: 'finite-negative-evidence', kind: 'research', status: 'advisory',
      producer: 'researcher', taskId: research.id, taskDigest: taskVersion(research),
      statement: '', premises: [], dependencies: [], remainingObligations: [gap.remaining],
      summary: admission.finding.summary, evidenceRefs: ['RESEARCH.md exact finite calculation'], createdAt: 1,
      mathematicalGap: gap, mathematicalGapScope: admission.mathematicalGapScope };
    const cooperation: NonNullable<SolverRunState['cooperation']> = { tasks, deliveries: [delivery],
      canonicalCommit: example.problem.baseCommit, groups: [{ group: { id: 'main', objective: 'Original target', status: 'active', revision: 0 }, turns: 0 }] };
    cooperation.mathematicalGaps = mathematicalGaps(cooperation, { ...identity, problemReceiptDigest: example.problem.receiptDigest });
    const action: CooperativeAction = role === 'lead' ? { kind: 'lead', seedCommit: example.problem.baseCommit, planVersion: 'fixed-plan' }
      : { kind: 'task', task: goal, assignment: assignment(goal, example.problem.baseCommit) };
    const state = solverState(example.problem, example.workspace, { runId: 'feedback-context', phase: 'running',
      environmentDigest: identity.environmentDigest, cooperation });
    const context = buildResearchContext(example.problem, state, { root: example.directory, worktree: example.workspace,
      environment: {}, taskText: 'Prove the frozen original goal.', retrievalRoot: example.directory,
      assignment: action, maxOptionalContextBytes: 0 });
    expect(context.manifest?.included).toContainEqual(expect.objectContaining({ id: 'mathematical-gaps', required: true }));
    for (const message of [context.message, context.continuationMessage]) {
      expect(message).toContain(gap.reduced);
      expect(message).toContain(gap.remaining);
      expect(message).toContain(gap.evidenceScope);
      expect(message).toContain(gap.reconsiderWhen[0]);
      expect(message).toContain('finite-negative-evidence');
      expect(message).toContain('current-contracts');
    }
    expect(tasks.filter(item => item.task.kind === 'lemma')).toEqual([]);
    expect(goalTasks[0]).toBe(goal);
  });

  it('keeps changed-scope evidence historical without silently changing the consumer objective', () => {
    const goal: CooperativeTask = { ...helper('original'), kind: 'goal', objective: 'Prove the original target using the proposed identity.' };
    const source: CooperativeTask = { id: 'audit', kind: 'research', objective: 'Audit the identity.', revision: 0, dependsOn: [goal.id] };
    const tasks = [node(goal), node(source)];
    const gap = { consumer: { taskId: goal.id, taskDigest: taskVersion(goal) }, previousGap: 'The identity was assumed.',
      reduced: 'The identity failed at the recorded finite input.', remaining: 'Find a different argument.',
      evidenceScope: 'Exact finite input only.', reconsiderWhen: ['Changed norm estimate.'] };
    const scope = bindMathematicalGap(gap, source, { tasks }, identity);
    const delivery: DeliveryRecord = { id: 'negative', producer: 'peer', kind: 'research', status: 'advisory',
      taskId: source.id, taskDigest: taskVersion(source), statement: '', premises: [], dependencies: [],
      remainingObligations: [gap.remaining], summary: gap.reduced, evidenceRefs: ['saved finite input'], createdAt: 1,
      mathematicalGap: gap, mathematicalGapScope: scope };
    tasks[1]!.task = { ...source, objective: 'Audit a different estimate.', revision: 1 };
    const entries = mathematicalGaps({ tasks, deliveries: [delivery] }, identity);
    expect(entries).toMatchObject([{ reduced: gap.reduced, scopeStatus: 'historical-scope' }]);
    expect(tasks[0]!.task.objective).toBe(goal.objective);
    expect(entries[0]!.evidence).toBe('model-reported-advisory');
  });

  it('preserves a live assignment for route hints and supersedes it for a changed mathematical responsibility', async () => {
    const example = fixture(), lead = leadWorker(example.problem, example.workspace), peer = peerWorker(example, 'peer');
    const task: CooperativeTask = { id: 'construction', kind: 'research', objective: 'Find a finite-tree norm estimate.',
      revision: 0, dependsOn: [], ownerId: peer.id, informalProof: 'Try the identity.' };
    const plan = parseCooperationPlan(example.problem, { tasks: [
      ...goals(example).map(goal => ({ ...goal, status: 'paused' })), task,
    ] });
    const state = solverState(example.problem, example.workspace, { runId: 'feedback-assignment', phase: 'running',
      cooperation: { canonicalCommit: example.problem.baseCommit, tasks: plan.tasks.map(node),
        groups: plan.groups.map(group => ({ group, turns: 0 })) } });
    const controller = new AbortController(), cooperation = cooperativeResearch({ state, workers: [lead, peer],
      retrievalRoot: example.directory, signal: controller.signal });
    running.push({ cooperation, controller });
    const action = await cooperation.next(peer, { maxTurns: Infinity, remainingMs: Infinity });
    if (action?.kind !== 'task') throw new Error('fixture-assignment-missing');
    expect(cooperation.started(peer, action)).toBe(true);
    const interrupt = vi.fn(async () => {});
    cooperation.activate(peer, action, interrupt, async () => {});
    const edit = async (id: string, change: (current: CooperativeTask) => CooperativeTask) => {
      fs.appendFileSync(path.join(example.directory, 'edits.jsonl'), JSON.stringify({ id, baseVersion: state.cooperation!.planVersion,
        tasks: state.cooperation!.tasks.map(item => item.task.id === task.id ? change(item.task) : item.task) }) + '\n');
      await cooperation.pulse(lead.id);
      expect(state.cooperation!.edits?.find(record => record.id === id)?.status).toBe('applied');
    };
    await edit('hint-only', current => ({ ...current, informalProof: 'The identity failed at 6 ≠ 4; try a norm estimate.',
      citations: ['RESEARCH.md exact finite calculation'] }));
    const preserved = state.cooperation!.tasks.find(item => item.task.id === task.id)!;
    expect(preserved.assignment).toBe(action.assignment);
    expect(preserved.status).toBe('running');
    expect(taskVersion(preserved.task)).toBe(taskVersion(task));
    expect(interrupt).not.toHaveBeenCalled();
    await edit('new-responsibility', current => ({ ...current, objective: 'Study completion and density instead.', revision: 1 }));
    expect(state.cooperation!.tasks.find(item => item.task.id === task.id)?.assignment).toBeUndefined();
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it('invalidates actual helper contracts and consumers while keeping blueprint edits outside proof identity', () => {
    const core = helper('core'), consumer = helper('consumer', [core.id]), records = [node(core), node(consumer)];
    const hinted = { ...core, informalProof: 'Another argument.', citations: ['checked source'] };
    expect(taskVersion(hinted)).toBe(taskVersion(core));
    expect(invalidatedTaskIds(records, [hinted, consumer], new Set(), new Map())).toEqual(new Set());
    const changed = { ...core, type: 'False', revision: 1 };
    expect(taskProofContractVersion(changed)).not.toBe(taskProofContractVersion(core));
    expect(invalidatedTaskIds(records, [changed, consumer], new Set(), new Map())).toEqual(new Set([core.id, consumer.id]));
  });
});

describe('mathematical progress and conditional connections', () => {
  it('counts a namespaced connection once across renamed wrappers, receipt replay and changed notes', () => {
    const example = fixture(), core = helper('core'), first = helper('bridgeA', [core.id]), second = helper('bridgeB', [core.id]);
    const goal = { ...goals(example)[0]!, dependsOn: [first.id] };
    const file = path.join(example.receipt.projectRoot, 'Submission.lean');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('theorem add_zero',
      'lemma core : True := by sorry\nlemma bridgeA : True := core\nlemma bridgeB : True := core\n\ntheorem add_zero'));
    const sourceCommit = commitSolverSources(example.problem, example.workspace);
    const references = (task: CooperativeTask) => {
      const result = captureProofReferences(example.problem, example.workspace, sourceCommit,
        { file: 'Submission.lean', name: task.theoremName! }, { statement: [], proof: task.id === core.id ? [] :
          [{ file: 'Submission.lean', name: core.theoremName! }] },
        identity.environmentDigest);
      if (!result) throw new Error('fixture-references-missing');
      expect(result.inputs).toContainEqual(expect.objectContaining({ name: task.id }));
      return result;
    };
    let tasks: TaskRecord[] = [node(core), node(first), node(goal)];
    let state: GoalProgressState | undefined;
    vi.useFakeTimers(); vi.setSystemTime(0);
    const observe = () => {
      const result = observeGoalProgress(state, { ...identity, targets: [example.problem.targets[0]!], tasks,
        snapshot: captureObligationSnapshot(tasks, { environmentDigest: identity.environmentDigest }), activeTaskIds: new Set([core.id]) });
      state = result.state; return result;
    };
    observe();
    vi.setSystemTime(1000);
    const conditions = [{ taskId: core.id, taskDigest: taskVersion(core) }];
    const firstProof = proof(first, conditions, references(first));
    tasks[1] = { ...node(first), status: 'conditional', proof: firstProof };
    expect(observe().resumed).toEqual([goal.id]);
    expect(state!.goals[0]!.seenEvidence).toHaveLength(1);
    vi.setSystemTime(2000);
    const noted = { ...first, objective: 'Same connection with updated checkpoint notes.', informalProof: 'Retain the open core.' };
    const replay = proof(noted, conditions, references(first));
    replay.verification.results[0]!.receiptId = 'replayed-receipt';
    tasks[1] = { ...node(noted), status: 'conditional', proof: replay, feedback: 'Checkpoint notes saved.' };
    expect(observe().resumed).toEqual([]);
    expect(state!.goals[0]!.activeMs).toBe(1000);
    vi.setSystemTime(1000 + GOAL_PROGRESS_REVIEW_MS - 1);
    const repeated = { ...second, objective: 'Same connection, renamed in the updated notes.', informalProof: 'No new mathematical input.' };
    tasks = [node(core), { ...node(repeated), status: 'conditional', proof: proof(repeated, conditions, references(second)) },
      node({ ...goal, dependsOn: [second.id] })];
    const stalled = observe();
    expect(stalled.resumed).toEqual([]);
    expect(state!.goals[0]!.seenEvidence).toHaveLength(1);
    expect(state!.goals[0]!.activeMs).toBe(GOAL_PROGRESS_REVIEW_MS - 1);
    expect(stalled.requested).toBe(true); // The useful connection did not close the old frontier.
    vi.setSystemTime(1000 + GOAL_PROGRESS_REVIEW_MS);
    expect(observe().requested).toBe(false);
    expect(state!.pending).toBeDefined();
    expect(state!.goals[0]!.closed).toBe(false);
    expect(captureObligationSnapshot(tasks, { environmentDigest: identity.environmentDigest }).obligations
      .find(item => item.taskId === second.id)).toMatchObject({ recordedProof: 'conditional', closed: false });
    vi.setSystemTime(1001 + GOAL_PROGRESS_REVIEW_MS);
    const checkedCore = proof(core, [], references(core));
    tasks[0] = { ...node(core), status: 'integrated', proof: checkedCore, integratedCheck: checkedCore };
    expect(captureObligationSnapshot(tasks, { environmentDigest: identity.environmentDigest }).obligations
      .find(item => item.taskId === core.id)).toMatchObject({ recordedProof: 'checked', closed: true });
    expect(observe().resumed).toEqual([goal.id]);
    expect(state!.goals[0]!.activeMs).toBe(0);
    expect(state!.pending).toBeUndefined();
    expect(state!.goals[0]!.closed).toBe(false);
  });

  it('checks typed-input sufficiency while definitions remain unavailable as assumed inputs', () => {
    const core = helper('core'), consumer = { ...helper('consumer', [core.id]), kind: 'goal' as const }, tasks = [node(core), node(consumer)];
    expect(automaticTaskConnection(consumer, tasks)).toBe(true);
    const dispatched = { ...assignment(consumer, 'seed'), dependencies: [{ taskId: core.id, taskDigest: taskVersion(core) }] };
    const connection = createTaskConnectionCheck(consumer, dispatched, tasks, identity);
    expect(connection.assumedInputs).toEqual(dispatched.dependencies);
    const candidate = proof(consumer, connection.assumedInputs);
    tasks[1] = { ...node(consumer), status: 'conditional', proof: candidate };
    const snapshot = captureObligationSnapshot(tasks, { environmentDigest: identity.environmentDigest });
    expect(snapshot.goals).toMatchObject([{ closed: false }]);
    const definition = { ...core, declaration: 'definition' as const, type: 'Nat' };
    expect(automaticTaskConnection(consumer, [node(definition), node(consumer)])).toBe(false);
  });

  it('parks only the repeated local inference and reopens for a newly checked relevant input', () => {
    const core = helper('core'), consumer = helper('consumer', [core.id]), original = { ...helper('original', [consumer.id]), kind: 'goal' as const };
    const tasks = [node(core), node(consumer), node(original)], records: RouteBlocker[] = [];
    const proposal = { mechanism: 'Exact finite identity fails: 6 ≠ 4.', scope: 'This identity at the recorded finite input only.',
      evidenceRefs: ['RESEARCH.md exact finite calculation'], reopenOn: [{ kind: 'dependency-checked' as const, taskId: core.id }] };
    recordRouteBlockers(records, [proposal], consumer, tasks, identity.environmentDigest, identity.problemReceiptDigest, 1);
    recordRouteBlockers(records, [proposal], consumer, tasks, identity.environmentDigest, identity.problemReceiptDigest, 2);
    refreshRouteBlockers(records, tasks, identity.environmentDigest, identity.problemReceiptDigest, 3);
    expect(tasks[1]!.routeParking).toEqual([records[0]!.id]);
    expect(tasks[2]!.routeParking).toEqual([]);
    tasks[1]!.task = { ...consumer, objective: 'Reworded route, same inference.', revision: 1, informalProof: 'Try again.' };
    expect(refreshRouteBlockers(records, tasks, identity.environmentDigest, identity.problemReceiptDigest, 4)).toEqual([]);
    expect(records[0]!.status).toBe('parked');
    const checked = proof(core); markTaskAcceptance(checked);
    tasks[0] = { ...node(core), status: 'integrated', proof: checked, integratedCheck: checked };
    expect(refreshRouteBlockers(records, tasks, identity.environmentDigest, identity.problemReceiptDigest, 5))
      .toMatchObject([{ status: 'reopened', reopenedReason: 'dependency-checked', evidenceStatus: 'advisory' }]);
    expect(tasks[1]!.routeParking).toEqual([]);
    expect(tasks[2]!.status).toBe('pending');
  });
});

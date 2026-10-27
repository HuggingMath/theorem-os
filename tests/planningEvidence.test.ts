import { expect, it } from 'vitest';
import { leadPlanningEvidence, leadPlanningEvidenceText, createTaskApplicationEvidence } from '../src/solver/planningEvidence';
import type { FailedTaskInput } from '../src/solver/cooperationShared';
import { taskVersion, type TaskRecord } from '../src/solver/tasks';
import { integratedProof } from './helpers/taskProof';
import { reviewGoalPaths } from '../src/solver/goalPathReview';

const node = (id: string, dependsOn: string[] = [], kind: TaskRecord['task']['kind'] = 'lemma'): TaskRecord => ({
  task: { id, kind, objective: 'Prove ' + id, dependsOn, revision: 0, type: '∀ n : Nat, n = n',
    theoremName: 'Submission.' + id, proofPath: 'Submission.lean' }, status: 'pending', attempts: 0,
});
const checked = (item: TaskRecord, uses: TaskRecord[] = []) => integratedProof(item,
  { uses, accept: false, environmentDigest: 'environment' });

it('shows a checked local package and its exact remaining inputs without moving the original frontier', () => {
  const goal = node('main', [], 'goal'), core = node('core'), closing = node('closing', ['core']);
  const row = node('row'), rest = node('classification'), application = node('row_application', ['row', 'classification']);
  checked(row);
  const state = { tasks: [goal, core, closing, row, rest, application], proofRoutes: [{ id: 'route',
    targetTaskId: 'main', prerequisiteTaskIds: ['core'], closingTaskId: 'closing' }] };
  const before = structuredClone(state), evidence = leadPlanningEvidence(state, 'environment');
  expect(evidence).toMatchObject({ evidence: 'recorded-not-replayed', acceptance: 'not-assessed',
    goals: [{ taskId: 'main', recordedProof: 'none', frontier: [{ taskId: 'core' }] }] });
  expect(evidence.localPackages).toContainEqual(expect.objectContaining({ taskId: 'row', recordedProof: 'checked',
    consumerConnection: 'recorded', consumers: [expect.objectContaining({ taskId: 'row_application', taskDigest: taskVersion(application.task) })] }));
  expect(evidence.localPackages).toContainEqual(expect.objectContaining({ taskId: 'row_application',
    consumerConnection: 'not-recorded', unprovedInputTaskIds: ['classification'], missingInputTaskIds: [],
    remainingConnection: expect.stringContaining('original goal') }));
  expect(state).toEqual(before);

  core.task = { ...core.task, dependsOn: ['row_application'] };
  const connected = leadPlanningEvidence(state, 'environment');
  expect(connected.goals[0].frontier.map(item => item.taskId)).toEqual(['classification']);
  expect(connected.localPackages).toEqual([]);
  expect(goal.status).toBe('pending');
});

it('does not infer failed or repeated mathematics from provider recovery or scheduling attempts', () => {
  const goal = node('main', ['core'], 'goal'), core = node('core'); core.attempts = 99;
  const state = { tasks: [goal, core], failedTaskInputs: [] as FailedTaskInput[] };
  expect(leadPlanningEvidence(state).repeatedInputs).toEqual([]);
  core.feedback = 'math_task_repeated_failed_input\nThe exact saved input already failed.\nMissing declaration.';
  state.failedTaskInputs = [{ id: 'same-input', taskId: 'core', taskDigest: taskVersion(core.task),
    inputDigest: 'input', sourceDigest: 'source', targetDigest: 'target', attemptFingerprint: 'method-input',
    relatedFailureIds: ['previous'] } as FailedTaskInput,
  { id: 'old-contract', taskId: 'core', taskDigest: 'obsolete' } as FailedTaskInput];
  expect(leadPlanningEvidence(state).repeatedInputs).toMatchObject([{ taskId: 'core',
    feedbackPreview: core.feedback, failures: [{ id: 'same-input', inputDigest: 'input', attemptFingerprint: 'method-input' }],
    requiredChange: expect.stringContaining('discriminating check') }]);
  expect(leadPlanningEvidence(state).repeatedInputs[0].failures).toHaveLength(1);
  core.feedback = undefined;
  expect(leadPlanningEvidence(state).repeatedInputs[0]).toMatchObject({ basis: 'recorded-related-failures' });
  expect(leadPlanningEvidence(state).repeatedInputs[0]).not.toHaveProperty('feedbackPreview');
  expect(core.status).toBe('pending');
  checked(core);
  expect(leadPlanningEvidence(state).repeatedInputs).toEqual([]);
});

it('references large local interfaces without duplicating their complete types into Lead summaries', () => {
  const row = node('row'), application = node('application', ['row']); checked(row);
  application.task = { ...application.task, type: '∀ n : Nat, ' + 'n = n ∧ '.repeat(10000) + 'True' };
  const evidence = leadPlanningEvidence({ tasks: [node('main', [], 'goal'), row, application] });
  const consumer = evidence.localPackages.find(item => item.taskId === 'row')!.consumers[0];
  expect(consumer).toMatchObject({ taskId: 'application', taskDigest: taskVersion(application.task) });
  expect(consumer).not.toHaveProperty('type');
  expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThan(8 * 1024);
});

it('bounds a local package with many inputs and consumers while retaining exact archive references', () => {
  const seed = node('seed'); checked(seed);
  const inputs = Array.from({ length: 50 }, (_, i) => node('input_' + i));
  const hub = node('hub', ['seed', ...inputs.map(item => item.task.id)]);
  const consumers = Array.from({ length: 50 }, (_, i) => node('consumer_' + i, ['hub']));
  const evidence = leadPlanningEvidence({ tasks: [node('main', [], 'goal'), seed, hub, ...inputs, ...consumers] });
  const local = evidence.localPackages.find(item => item.taskId === 'hub')!;
  expect(local.inputs).toHaveLength(4);
  expect(local.consumers).toHaveLength(4);
  expect(local).toMatchObject({ omittedInputs: 47, omittedConsumers: 46, omittedUnprovedInputs: 46,
    interfaceSource: { path: 'COOPERATION.json', field: 'tasks[].task' } });
  expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThan(8 * 1024);
});

it('bounds independent packages and keeps their missing connection explicit', () => {
  const tasks = [node('main', [], 'goal'), ...Array.from({ length: 20 }, (_, i) => node('local_' + i))];
  tasks.slice(1).forEach(item => checked(item));
  const evidence = leadPlanningEvidence({ tasks }, 'environment');
  expect(evidence.localPackages).toHaveLength(8);
  expect(evidence.omittedLocalPackages).toBe(12);
  expect(evidence.localPackages.every(item => item.consumerConnection === 'not-recorded')).toBe(true);
  expect(evidence.goals[0].frontier.map(item => item.taskId)).toEqual(['main']);
});

it('keeps a changed input contract unproved and distinguishes a missing input from an absent consumer', () => {
  const input = node('input'), consumer = node('consumer', ['input', 'missing']); checked(input);
  input.task = { ...input.task, type: 'False', revision: 1 };
  const evidence = createTaskApplicationEvidence([input, consumer], { environmentDigest: 'environment' })(consumer.task);
  expect(evidence.inputs).toMatchObject([{ taskId: 'input', type: 'False', availability: 'unproved' },
    { taskId: 'missing', taskDigest: null, availability: 'missing' }]);
  expect(evidence).toMatchObject({ consumerConnection: 'not-recorded', missingInputTaskIds: ['missing'],
    unprovedInputTaskIds: ['input', 'missing'] });
});

it('shows the goal path to the Lead and asks for a decision only when an original goal is stalled', () => {
  const goal = node('main', ['core'], 'goal'), core = node('core');
  const runnable = leadPlanningEvidence({ tasks: [goal, core] }, 'environment');
  expect(runnable.goalPath).toMatchObject({ goals: [{ taskId: 'main', stalled: false, candidates: [] }], stalledGoalIds: [] });
  expect(runnable.goalPath).not.toHaveProperty('stallDigest');
  expect(leadPlanningEvidenceText(runnable)).not.toContain('Stalled original goals');

  core.task = { ...core.task, status: 'paused' };
  const stalled = leadPlanningEvidence({ tasks: [goal, core] }, 'environment');
  expect(stalled.goalPath).toMatchObject({ stalledGoalIds: ['main'], goals: [{ taskId: 'main', stalled: true,
    frontier: [{ taskId: 'core', state: 'paused' }], candidates: expect.arrayContaining([
      expect.objectContaining({ id: 'resume:core', action: 'resume', taskId: 'core', mechanical: true })]) }] });
  const text = leadPlanningEvidenceText(stalled);
  expect(text).toContain('Stalled original goals'); expect(text).toContain('"goalPath":{"adopt":["CANDIDATE_ID"]');
  expect(text).toContain('mechanical:true'); expect(text).not.toContain('recorded as ignored');
  expect(core.task.status).toBe('paused'); expect(core.status).toBe('pending');
});

it('shows the Lead its earlier answers to the same stall only', () => {
  const goal = node('main', ['core'], 'goal'), core = node('core');
  core.task = { ...core.task, status: 'paused' };
  const digest = reviewGoalPaths([goal, core], { environmentDigest: 'environment', candidates: false }).stallDigest!;
  const stall = { digest, active: true, at: 0, goalIds: ['main'], taskIds: ['core'], unanswered: 1,
    declined: [{ taskId: 'core', reason: 'Waiting for the compact seed.', at: 1 }] };
  const owed = leadPlanningEvidence({ tasks: [goal, core], goalPathStall: stall }, 'environment');
  expect(owed.goalPath).toMatchObject({ declined: [{ taskId: 'core', reason: 'Waiting for the compact seed.' }], unansweredTurns: 1 });
  expect(owed.goalPath.declined![0]).not.toHaveProperty('at');
  expect(leadPlanningEvidenceText(owed)).toContain('1 earlier turn(s) shown this stall answered none of it');
  const ignored = leadPlanningEvidence({ tasks: [goal, core], goalPathStall: { ...stall, unanswered: 2, answeredAt: 2, ignoredAt: 2 } }, 'environment');
  expect(ignored.goalPath).toMatchObject({ ignored: true, unansweredTurns: 2 });
  expect(leadPlanningEvidenceText(ignored)).not.toContain('earlier turn(s)');
  for (const other of [{ ...stall, digest: 'an-older-stall' }, { ...stall, active: false }]) {
    const fresh = leadPlanningEvidence({ tasks: [goal, core], goalPathStall: other }, 'environment').goalPath;
    expect(fresh).not.toHaveProperty('declined'); expect(fresh).not.toHaveProperty('unansweredTurns');
  }
});

it('bounds the goal path of many stalled goals and frontier inputs', () => {
  const tasks: TaskRecord[] = [];
  for (let g = 0; g < 12; g++) {
    const inputs = Array.from({ length: 12 }, (_, i) => node(`g${g}_input_${i}`));
    for (const item of inputs) item.task = { ...item.task, status: 'paused', type: '∀ n : Nat, ' + 'n = n ∧ '.repeat(200) + 'True' };
    tasks.push(node(`goal_${g}`, inputs.map(item => item.task.id), 'goal'), ...inputs);
  }
  const evidence = leadPlanningEvidence({ tasks }, 'environment');
  expect(evidence.goalPath.goals).toHaveLength(4);
  expect(evidence.goalPath.omittedGoals).toBe(8);
  expect(evidence.goalPath.stalledGoalIds).toHaveLength(12);
  expect(evidence.goalPath.goals.every(goal => goal.frontier.length <= 6 && goal.candidates.length <= 8)).toBe(true);
  expect(Buffer.byteLength(leadPlanningEvidenceText(evidence))).toBeLessThan(16 * 1024);
});

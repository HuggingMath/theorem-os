import { afterEach, expect, it, vi } from 'vitest';
import * as contextCompiler from '../src/solver/contextCompiler';
import type { CooperationState } from '../src/solver/cooperation';
import type { SolverRunState } from '../src/solver/archive';
import type { SolverProblem } from '../src/solver/problem';
import { buildResearchContext } from '../src/solver/modules/context';
import { assignmentDeliveryFile, taskVersion, type CooperativeAction, type TaskRecord } from '../src/solver/tasks';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';

const seedCommit = 'a'.repeat(40);
const formal = 'namespace Original\ntheorem target : True := by sorry\nend Original';
const problem = {
  projectRelative: 'generated/p', ownedFiles: ['Submission.lean'],
  declarations: { 'Submission.lean': [{ name: 'target', header: 'target : True' }] },
  sourceImports: { 'Submission.lean': ['Mathlib.Data.Nat.Basic'] }, sourceStructure: { 'Submission.lean': 'context' },
  targets: [{ proofPath: 'Submission.lean', theoremName: 'Original.target', declarationHash: 'original-type' }],
  receiptDigest: 'problem-receipt', baseCommit: seedCommit,
  contract: { formalStatement: formal, informalStatement: 'Prove the original proposition.', assumptions: [],
    statementHash: 'statement', leanStatementHash: 'lean-statement' },
} as unknown as SolverProblem;
const node = (id: string, kind: TaskRecord['task']['kind'] = 'lemma', dependsOn: string[] = []): TaskRecord => ({
  task: { id, kind, objective: `Prove ${id}`, dependsOn, revision: 0,
    ...(['goal', 'lemma'].includes(kind) ? { type: 'True', theoremName: kind === 'goal' ? 'Original.target' : `Original.${id}`,
      proofPath: 'Submission.lean' } : {}) },
  status: 'pending', attempts: 0,
});
const fixture = () => {
  const core = node('core'); core.status = 'blocked'; core.attempts = 2;
  const seed = node('seed'), collar = node('collar', 'lemma', ['seed']);
  const probe = node('probe', 'research', ['core', 'collar']);
  const goal = node('private_original_goal', 'goal', ['core']);
  const cooperation: CooperationState = { canonicalCommit: seedCommit, tasks: [core, seed, collar, probe, goal] };
  return { core, seed, collar, probe, goal, cooperation };
};
const actionFor = (record: TaskRecord): CooperativeAction => ({ kind: 'task', task: record.task,
  assignment: { taskId: record.task.id, taskDigest: taskVersion(record.task), workerId: 'researcher', seedCommit } });
const contextFor = (cooperation: CooperationState, action: CooperativeAction) => buildResearchContext(problem,
  { problem, cooperation, environmentDigest: 'environment' } as SolverRunState, {
    root: '/runtime', worktree: '/proof', environment: {}, taskText: 'Prove the original target.',
    retrievalRoot: '/library', assignment: action,
    frozenContexts: { 'Submission.lean': contextCompiler.frozenSourceContext(problem, 'Submission.lean', formal) },
  });
const packet = (message: string) => JSON.parse(message.split('Original-goal focus (advisory, not proof acceptance):\n')[1].split('\n\n')[0]);
/** Compiles every task context with no optional context allowance. */
const withoutOptionalContext = () => {
  const compile = contextCompiler.compileTaskContext;
  vi.spyOn(contextCompiler, 'compileTaskContext').mockImplementation(input => compile({ ...input, maxOptionalContextBytes: 0 }));
};

afterEach(() => vi.restoreAllMocks());

it.each(['lemma', 'goal', 'research', 'sketch'] as const)(
  'keeps the %s delivery entry points available without optional context', kind => {
    withoutOptionalContext();
    const record = node('assigned', kind), action = actionFor(record);
    if (action.kind !== 'task') throw new Error('fixture_assignment');
    const context = contextFor({ canonicalCommit: seedCommit, tasks: [record] }, action);

    expect(context.manifest).toMatchObject({ maxOptionalBytes: 0, optionalBytes: 0 });
    expect(context.manifest!.included).toContainEqual(expect.objectContaining({ id: 'assignment-policy', required: true }));
    expect(context.message).toContain('Current delivery log: ' + assignmentDeliveryFile(action.assignment));
    expect(context.instructions).toContain('"kind":"helpers","declarations":');
    expect(context.instructions).toContain('Use research-observe from .scratch/theoremos-help.md');
    expect(context.toolHelp?.text).toContain("--finding '.scratch/finding.json'");
    if (kind === 'lemma' || kind === 'goal') {
      expect(context.instructions).toContain('save the assigned declaration and return for host checking');
    } else {
      expect(context.instructions).toContain('return with RESEARCH.md to deliver an advisory assignment');
    }
    expect(context.instructions).not.toContain('"kind":"research","finding":');
    expect(context.message).toContain(`Your role: ${kind === 'goal' ? 'engineer' : kind === 'lemma' ? 'prover' : 'researcher'}`);
    expect(context.message).toContain('Delivery protocol: see session instructions.');
    expect(context.message).toContain(formal);
  });

it('keeps initial plan publication available without optional context', () => {
  withoutOptionalContext();
  const action: CooperativeAction = { kind: 'lead', seedCommit, initialPlanNonce: 'publication', planVersion: 'plan-version' };
  const context = contextFor({ canonicalCommit: seedCommit, tasks: [] }, action);

  expect(context.manifest).toMatchObject({ maxOptionalBytes: 0, optionalBytes: 0 });
  expect(context.instructions).toContain('Edit only /proof/RESEARCH.md, /proof/.scratch/plan.json.');
  expect(context.instructions).toContain('The host accepts only one publication per dispatch');
  expect(context.toolHelp?.text).toContain('plan-apply --publish --file .scratch/plan.json');
  expect(context.message).toContain(JSON.stringify(action));
  expect(context.message).toContain('Your role: lead');
  expect(context.message).toContain('Delivery protocol: see session instructions.');
  expect(context.message).toContain(formal);
});

it('retains the assigned support task, its actual consumer and open frontier without optional hints', () => {
  withoutOptionalContext();
  const { seed, cooperation } = fixture();
  const context = contextFor(cooperation, actionFor(seed));

  expect(context.manifest).toMatchObject({ maxOptionalBytes: 0, optionalBytes: 0 });
  expect(context.manifest!.included).toContainEqual(expect.objectContaining({ id: 'frontier-focus', required: true }));
  expect(context.manifest!.omitted).toContainEqual({ id: 'proof-continuation', kind: 'continuation', reason: 'optional-budget' });
  expect(packet(context.message)).toEqual({ goalTaskIds: ['private_original_goal'], frontierTaskIds: ['core'],
    assignedTaskId: 'seed', relationship: 'frontier-support', plannedConsumers: ['collar'] });
  expect(context.manifest!.requiredTaskIds).toContain('seed');
});

it('keeps concrete concurrent questions mandatory while preserving private route scope and independent review', () => {
  withoutOptionalContext();
  const { seed, core, probe, cooperation } = fixture();
  core.status = 'running'; probe.status = 'running';
  const hidden = node('private_question', 'research'); hidden.status = 'running';
  hidden.task = { ...hidden.task, groupId: 'private-route', sharing: 'group', objective: 'PRIVATE_CONCURRENT_QUESTION' };
  cooperation.tasks.push(hidden);
  const context = contextFor(cooperation, actionFor(seed));
  expect(context.manifest!.included).toContainEqual(expect.objectContaining({ id: 'parallel-questions', required: true }));
  const questions = JSON.parse(context.message.split('Current in-flight questions (scope-visible assignments; advisory, retrieve exact interfaces from COOPERATION.json):\n')[1]
    .split('\n\n')[0]);
  expect(questions.map((question: { taskId: string }) => question.taskId)).toEqual(['core', 'probe']);
  expect(context.instructions).toContain('Leave a slot waiting for input');
  probe.task = { ...probe.task, reviewScope: 'feasibility' };
  expect(contextFor(cooperation, actionFor(probe)).manifest!.included.some(section => section.id === 'parallel-questions')).toBe(false);
});

it('updates the advisory research focus when its original gap becomes checked', () => {
  const { core, probe, cooperation } = fixture();
  expect(packet(contextFor(cooperation, actionFor(probe)).message)).toMatchObject({
    frontierTaskIds: ['core'], relationship: 'targeted-investigation',
  });

  core.status = 'integrated';
  core.integratedCheck = { passed: true, taskDigest: taskVersion(core.task), conditions: [],
    verification: { status: 'kernel_verified', targetCommit: seedCommit, results: [
      { status: 'kernel_verified', targetCommit: seedCommit, receiptId: 'fixture-receipt' },
    ] } } as TaskRecord['integratedCheck'];

  expect(packet(contextFor(cooperation, actionFor(probe)).message)).toMatchObject({
    frontierTaskIds: ['private_original_goal'], relationship: 'independent-exploration',
  });
  expect(cooperation.tasks.find(record => record.task.kind === 'goal')!.status).toBe('pending');
});

it('builds mandatory Lead focus and task focus only from the supplied scoped graph', () => {
  const { seed, cooperation } = fixture();
  const lead = contextFor(cooperation, { kind: 'lead', seedCommit });
  expect(packet(lead.message)).toEqual({ goalTaskIds: ['private_original_goal'], frontierTaskIds: ['core'] });
  const scoped = { ...cooperation, tasks: [seed] };
  const context = contextFor(scoped, actionFor(seed));

  expect(packet(context.message)).toEqual({ goalTaskIds: [], frontierTaskIds: [],
    assignedTaskId: 'seed', relationship: 'independent-exploration', plannedConsumers: [] });
  expect(context.message).not.toContain('private_original_goal');
  expect(context.message).not.toContain('Original.core');
});

it('keeps route-strength and implementation obligations visible to initial and continuing Lead and proof work', () => {
  withoutOptionalContext();
  const { core, probe, cooperation } = fixture();
  const contexts = [
    contextFor({ canonicalCommit: seedCommit, tasks: [] }, { kind: 'lead', seedCommit }),
    contextFor(cooperation, { kind: 'lead', seedCommit }),
    contextFor(cooperation, actionFor(core)),
    contextFor(cooperation, actionFor(probe)),
  ];
  for (const context of contexts) {
    expect(context.manifest).toMatchObject({ maxOptionalBytes: 0, optionalBytes: 0 });
    expect(context.instructions).toContain('justify its necessity and feasibility before expanding it');
    expect(context.instructions).toContain('bounded output size alone supplies no running-time proof');
    expect(context.instructions).toContain('keep its unproved conditions on the frontier');
  }
  expect(core.status).toBe('blocked');
  expect(cooperation.tasks.find(record => record.task.kind === 'goal')!.integratedCheck).toBeUndefined();
});

it('gives an early feasibility reviewer complete unproved interfaces even with no optional context budget', () => {
  withoutOptionalContext();
  const { core, probe, goal, cooperation } = fixture();
  const exactType = '∀ (n : Nat), n > 0 → ∃ N : Nat, ∀ m ≥ N, m + n > m';
  core.task = { ...core.task, type: exactType };
  probe.task = { ...probe.task, reviewScope: 'feasibility', dependsOn: [goal.task.id, core.task.id] };
  const context = contextFor(cooperation, actionFor(probe));

  expect(context.workContract).toMatchObject({ stage: 'feasibility-review', owner: 'independent-researcher',
    consumer: 'lead-route-decision', acceptance: 'advisory-only', sourcePolicy: 'read-only' });
  expect(context.manifest).toMatchObject({ maxOptionalBytes: 0, optionalBytes: 0 });
  expect(context.manifest!.requiredTaskIds).toEqual(expect.arrayContaining([probe.task.id, goal.task.id, core.task.id]));
  expect(context.message).toContain(JSON.stringify(exactType));
  expect(context.message).toContain('theorem target : True');
  expect(context.message).toContain('Your role: reviewer');
  expect(context.instructions).toContain('quantifier order, uniform constants, quantitative strength, boundary cases');
  expect(context.instructions).toContain('First test whether the proposed inputs would actually suffice for the consumer');
  expect(core.status).toBe('blocked');
  expect(goal.integratedCheck).toBeUndefined();
});

it.each([10, 100, 500])('keeps local mandatory route focus bounded across %i alternatives', count => {
  withoutOptionalContext();
  const goal = node('goal', 'goal');
  const inputs = Array.from({ length: count }, (_, index) => node(`input_${index}`));
  const closing = inputs.map(input => node(`closing_${input.task.id}`, 'lemma', [input.task.id]));
  const proofRoutes = inputs.map((input, index) => ({ id: `route_${index}`, targetTaskId: goal.task.id,
    prerequisiteTaskIds: [input.task.id], closingTaskId: closing[index].task.id }));
  goal.alternativeRoutes = proofRoutes;
  const active = inputs.at(-1)!;
  closing.at(-1)!.task = { ...closing.at(-1)!.task, type: 'And True True' };
  const cooperation: CooperationState = { canonicalCommit: seedCommit, tasks: [...inputs, ...closing, goal], proofRoutes };
  const context = contextFor(cooperation, actionFor(active)), focus = packet(context.message);
  // Exclude fixed worker instructions so protocol additions cannot hide route-focus growth.
  // Assignment, source pins, focus and the bounded manifest must fit regardless of alternative count.
  expect(context.manifest!.mandatoryBytes - Buffer.byteLength(context.instructions)).toBeLessThan(8 * 1024);
  const inline = JSON.parse(context.message.split('Context compilation manifest:\n')[1]);
  expect(inline.manifestRef).toBe('CONTEXT-MANIFEST.json');
  expect(inline.contentDigest).toBe(context.manifest!.contentDigest);
  expect(inline.omitted).toEqual(context.manifest!.omitted.slice(0, 16));
  expect(inline).not.toHaveProperty('included');
  expect(inline).not.toHaveProperty('requiredTaskIds');
  expect(context.manifest!.requiredTaskIds).toEqual([active.task.id]);
  expect(context.message).toContain(formal);
  expect(context.message).toContain(seedCommit);
  expect(context.message).toContain(taskVersion(active.task));
  expect((context.instructions + context.message).match(/Prioritize a ready typed step/g)).toHaveLength(1);
  expect(focus.routePriority).toMatchObject({ selection: 'bounded-preview', totalCount: count, selectedCount: 4,
    omittedCount: count - 4, index: { path: 'COOPERATION.json', field: 'routePriority.routes', count } });
  expect(focus.routePriority.routes[0].routeId).toBe(proofRoutes.at(-1)!.id);
  expect(focus.frontierTaskIds).toContain(active.task.id);
  expect(focus.frontierTaskIds.length).toBeLessThanOrEqual(4);
  expect(focus.frontierSet).toEqual({ count, digest: mathDigest(canonicalMathJson(inputs.map(input => input.task.id))),
    reference: { path: 'COOPERATION.json', field: 'frontierFocus.taskIds' } });
  expect(context.message).toContain('And True True');
  expect(focus.plannedConsumers).toEqual(expect.arrayContaining([goal.task.id, closing.at(-1)!.task.id]));
  expect(context.manifest!.included).toContainEqual(expect.objectContaining({ id: 'consumer-interfaces', required: true }));

  const action = actionFor(goal);
  if (action.kind !== 'task') throw new Error('fixture_assignment');
  action.assignment.routeId = proofRoutes.at(-1)!.id;
  const assigned = packet(contextFor(cooperation, action).message);
  expect(assigned.routePriority.routes[0].routeId).toBe(action.assignment.routeId);
  expect(assigned.routePriority.selectedCount).toBe(5);
});

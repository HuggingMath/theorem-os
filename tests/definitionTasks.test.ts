import { describe, expect, it } from 'vitest';
import type { SolverRunState } from '../src/solver/archive';
import { buildResearchContext } from '../src/solver/modules/context';
import { taskCanStart } from '../src/solver/modules/search';
import type { SolverProblem } from '../src/solver/problem';
import { parseProofRoutes } from '../src/solver/proofRoutes';
import { closeTaskByTactics } from '../src/solver/tacticBattery';
import { automaticTaskConnection } from '../src/solver/taskConnections';
import { assumableLemma, isDefinitionTask, parseCooperationPlan, taskProofContractVersion, taskVersion,
  type CooperativeTask, type TaskRecord } from '../src/solver/tasks';

const problem = {
  projectRelative: '.', ownedFiles: ['Submission.lean'], receiptDigest: 'problem', baseCommit: 'fixed-commit',
  targets: [{ proofPath: 'Submission.lean', theoremName: 'Submission.main' }],
  declarations: { 'Submission.lean': [{ name: 'main', header: 'main : True' }] },
  contract: { formalStatement: 'theorem main : True := by sorry', assumptions: [] },
} as unknown as SolverProblem;
const concept = { id: 'coprime_pair', kind: 'lemma', declaration: 'definition', objective: 'Two naturals with gcd one.',
  theoremName: 'Submission.coprimePair', type: 'Nat → Nat → Prop' };
const uses = { id: 'coprime_symm', kind: 'lemma', objective: 'Symmetry of the concept.', theoremName: 'Submission.coprimePair_symm',
  type: '∀ a b : Nat, coprimePair a b → coprimePair b a', dependsOn: ['coprime_pair'] };
const goal = { id: 'goal', kind: 'goal', objective: 'Prove the frozen target.', theoremName: 'Submission.main', dependsOn: ['coprime_symm'] };
const plan = (...tasks: object[]) => parseCooperationPlan(problem, { tasks });
const records = (tasks: readonly CooperativeTask[], status: (task: CooperativeTask) => TaskRecord['status'] = () => 'pending'): TaskRecord[] =>
  tasks.map(task => ({ task, status: status(task), attempts: 0 }));

describe('definition tasks', () => {
  it('accepts a typed lemma definition and binds the declaration kind into both task versions', () => {
    const { tasks } = plan(concept, uses, goal);
    expect(tasks[0]).toMatchObject({ declaration: 'definition', kind: 'lemma', type: 'Nat → Nat → Prop' });
    expect(isDefinitionTask(tasks[0])).toBe(true);
    expect(isDefinitionTask(tasks[1])).toBe(false);
    const proposition = { ...tasks[0], declaration: undefined };
    expect(taskVersion(tasks[0])).not.toBe(taskVersion(proposition));
    expect(taskProofContractVersion(tasks[0])).not.toBe(taskProofContractVersion(proposition));
    expect(assumableLemma(tasks[0])).toBe(false);
    expect(assumableLemma(tasks[1])).toBe(true);
  });

  it.each([
    ['a research task', { ...concept, kind: 'research', theoremName: undefined, type: undefined }],
    ['a goal', { ...goal, declaration: 'definition' }],
    ['a conditional definition', { ...concept, conditional: true }],
    ['a statement-reviewed definition', { ...concept, statementReview: true, informalStatement: 'Coprime pairs.' }],
    ['an unknown declaration kind', { ...concept, declaration: 'structure' }],
  ])('rejects %s and names the declaration field', (_name, task) => {
    const tasks = task.id === 'goal' ? [concept, uses, task] : [task, { ...uses, dependsOn: [] }, goal];
    expect(() => plan(...tasks)).toThrow(`math_plan_invalid_task: {"taskId":"${task.id}","field":"declaration"}`);
  });

  it('starts consumers only after the definition body is integrated, even when they could assume typed inputs', () => {
    const { tasks } = plan(concept, { ...uses, conditional: true }, goal);
    const pending = records(tasks);
    expect(taskCanStart(tasks[0], pending)).toBe(true);
    expect(taskCanStart(tasks[1], pending)).toBe(false);
    expect(taskCanStart(tasks[2], pending)).toBe(false);
    expect(automaticTaskConnection(tasks[2], pending)).toBe(false);
    // The same graph with a proposition in place of the concept may start conditionally.
    const proposition = records([{ ...tasks[0], declaration: undefined }, ...tasks.slice(1)]);
    expect(taskCanStart(tasks[1], proposition)).toBe(true);
    const integrated = records(tasks, task => task.id === concept.id ? 'integrated' : 'pending');
    expect(taskCanStart(tasks[1], integrated)).toBe(true);
  });

  it('never offers a definition an early connection check against assumed typed inputs', () => {
    const base = { id: 'base', kind: 'lemma', objective: 'A typed input.', theoremName: 'Submission.base', type: 'True' };
    const { tasks } = plan(base, { ...concept, dependsOn: ['base'] }, uses, goal);
    const pending = records(tasks);
    expect(automaticTaskConnection(tasks[1], pending)).toBe(false);
    expect(taskCanStart(tasks[1], pending)).toBe(false);
    // A proposition in the same position, with the same consumer, is offered the early check.
    const proposition = records([tasks[0], { ...tasks[1], declaration: undefined }, ...tasks.slice(2)]);
    expect(automaticTaskConnection(proposition[1].task, proposition)).toBe(true);
  });

  it('allows a definition as a route prerequisite but not as the closing proposition', () => {
    const { tasks } = plan(concept, uses, { ...goal, dependsOn: [] });
    expect(parseProofRoutes([{ id: 'route', targetTaskId: 'goal', prerequisiteTaskIds: ['coprime_pair'], closingTaskId: 'coprime_symm' }], tasks))
      .toHaveLength(1);
    expect(() => parseProofRoutes([{ id: 'route', targetTaskId: 'goal', prerequisiteTaskIds: [], closingTaskId: 'coprime_pair' }], tasks))
      .toThrow('math_plan_invalid_proof_route_input: {"routeId":"route","taskId":"coprime_pair"}. A route closes with a typed proposition, not a definition.');
  });

  it('leaves definitions to a model instead of the host tactic battery', async () => {
    const task = plan(concept, uses, goal).tasks[0];
    await expect(closeTaskByTactics({ problem, task, worktree: '/unused', seedCommit: 'fixed-commit', context: 'Submission.main',
      env: {}, timeoutMs: 1000 })).resolves.toMatchObject({ status: 'skipped', reason: 'not-typed-lemma' });
  });

  it('tells the assigned worker to save a complete def and the Lead how to plan a concept', () => {
    const { tasks } = plan(concept, uses, goal);
    const state = { cooperation: { tasks: records(tasks) } } as unknown as SolverRunState;
    const access = { root: '/runtime', worktree: '/proof', environment: {}, taskText: 'Prove the target', retrievalRoot: '/library',
      maxOptionalContextBytes: 0, frozenContexts: { 'Submission.lean': 'theorem main : True := by sorry' } };
    const worker = buildResearchContext(problem, state, { ...access, assignment: { kind: 'task', task: tasks[0],
      assignment: { taskId: tasks[0].id, taskDigest: taskVersion(tasks[0]), workerId: 'worker', seedCommit: 'fixed-commit' } } });
    expect(worker.instructions).toContain('Define the declaration named in the current assignment: save one def of exactly the requested type with a complete body');
    expect(worker.instructions).not.toContain('Prove the lemma named');
    const lemma = buildResearchContext(problem, state, { ...access, assignment: { kind: 'task', task: tasks[1],
      assignment: { taskId: tasks[1].id, taskDigest: taskVersion(tasks[1]), workerId: 'worker', seedCommit: 'fixed-commit' } } });
    expect(lemma.instructions).toContain('Prove the lemma named in the current assignment.');
    const lead = buildResearchContext(problem, state, { ...access, assignment: { kind: 'lead', seedCommit: 'fixed-commit' } });
    expect(lead.instructions).toContain('A new concept is a lemma task with declaration:"definition" and its Lean type');
    expect(lead.instructions).toContain('Consumers wait for its checked body.');
  });
});

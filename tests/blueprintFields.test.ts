import { describe, expect, it } from 'vitest';
import type { SolverRunState } from '../src/solver/archive';
import { buildRunInspection, renderRunInspection } from '../src/solver/inspection';
import type { SolverProblem } from '../src/solver/problem';
import { MAX_CITATION_CHARS, MAX_CITATIONS, MAX_INFORMAL_PROOF_CHARS, parseCooperationPlan, taskProofContractVersion,
  taskVersion } from '../src/solver/tasks';

const problem = {
  projectRelative: '.', ownedFiles: ['Submission.lean'], receiptDigest: 'problem', baseCommit: 'fixed-commit',
  targets: [{ proofPath: 'Submission.lean', theoremName: 'Submission.main' }],
  declarations: { 'Submission.lean': [{ name: 'main', header: 'main : True' }] },
  contract: { formalStatement: 'theorem main : True := by sorry', assumptions: [] },
} as unknown as SolverProblem;
const helper = { id: 'escalator_bound', kind: 'lemma', objective: 'Bound the truant of every escalator.',
  theoremName: 'Submission.escalator_bound', type: '∀ n : Nat, n ≤ n + 1' };
const goal = { id: 'goal', kind: 'goal', objective: 'Prove the frozen target.', theoremName: 'Submission.main', dependsOn: ['escalator_bound'] };
const blueprint = { informalProof: 'Reduce to the finite escalator tree, then bound each leaf by the 290 criterion.',
  citations: ['Bhargava–Hanke 2005, Thm 2', 'Rouse 2014, §3'] };
const plan = (...tasks: object[]) => parseCooperationPlan(problem, { tasks });

describe('blueprint task fields', () => {
  it('keeps the intended argument and citations without changing the task contract or its versions', () => {
    const [plain] = plan(helper, goal).tasks, [annotated] = plan({ ...helper, ...blueprint }, goal).tasks;
    expect(annotated).toMatchObject(blueprint);
    expect(plain).not.toHaveProperty('informalProof'); expect(plain).not.toHaveProperty('citations');
    expect(taskVersion(annotated)).toBe(taskVersion(plain));
    expect(taskProofContractVersion(annotated)).toBe(taskProofContractVersion(plain));
    const research = plan({ id: 'route', kind: 'research', objective: 'Locate the escalation route.', ...blueprint },
      { ...goal, dependsOn: [] }).tasks[0];
    expect(research).toMatchObject({ kind: 'research', ...blueprint });
  });

  it.each([
    ['an empty argument', { informalProof: '  ' }, 'informalProof'],
    ['a non-string argument', { informalProof: 42 }, 'informalProof'],
    ['an overlong argument', { informalProof: 'x'.repeat(MAX_INFORMAL_PROOF_CHARS + 1) }, 'informalProof'],
    ['an empty citation list', { citations: [] }, 'citations'],
    ['too many citations', { citations: Array.from({ length: MAX_CITATIONS + 1 }, (_, i) => `Ref ${i}`) }, 'citations'],
    ['a blank citation', { citations: ['Rouse 2014', ' '] }, 'citations'],
    ['an overlong citation', { citations: ['x'.repeat(MAX_CITATION_CHARS + 1)] }, 'citations'],
    ['a non-string citation', { citations: [7] }, 'citations'],
  ])('rejects %s and names the field', (_name, fields, field) => {
    expect(() => plan({ ...helper, ...fields }, goal)).toThrow(`math_plan_invalid_task: {"taskId":"escalator_bound","field":"${field}"}`);
  });

  it('accepts the documented limits exactly', () => {
    const [task] = plan({ ...helper, informalProof: 'x'.repeat(MAX_INFORMAL_PROOF_CHARS),
      citations: Array.from({ length: MAX_CITATIONS }, () => 'y'.repeat(MAX_CITATION_CHARS)) }, goal).tasks;
    expect(task.informalProof).toHaveLength(MAX_INFORMAL_PROOF_CHARS); expect(task.citations).toHaveLength(MAX_CITATIONS);
  });

  it('shows the blueprint in run inspection as planning prose', () => {
    const tasks = plan({ ...helper, ...blueprint }, goal).tasks;
    const state = { runId: 'blueprint-fixture', turns: 0, phase: 'running', problem, environmentDigest: 'environment',
      cooperation: { tasks: tasks.map(task => ({ task, status: 'pending', attempts: 0 })) } } as unknown as SolverRunState;
    const report = buildRunInspection(state);
    expect(report.tasks.find(task => task.id === 'escalator_bound')).toMatchObject(blueprint);
    expect(report.tasks.find(task => task.id === 'goal')).toMatchObject({ citations: [] });
    const text = renderRunInspection(report);
    expect(text).toContain('Intended argument: ' + blueprint.informalProof);
    expect(text).toContain('Citations: Bhargava–Hanke 2005, Thm 2; Rouse 2014, §3');
  });
});

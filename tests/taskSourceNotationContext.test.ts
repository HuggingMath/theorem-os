import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { readSolverProblem } from '../src/solver/problem';
import type { CooperativeTask, TaskRecord } from '../src/solver/tasks';
import { createTaskSourceProjector, projectedGoalInputs } from '../src/solver/cooperativeProof';
import { temporaryDirectory } from './helpers/files';
import { newestLeanBinary } from './helpers/lean';

const lean = newestLeanBinary(), directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

const cases = [
  { id: 'overloaded token', lines: [
    'local notation "choice" => first',
    'local notation (priority := high) "choice" => (0 : Nat)',
    'theorem target : choice = 0 := by rfl',
  ] },
  { id: 'plus substring in append', lines: [
    'def stageOperation (left _right : Nat) : Nat := by have := first; exact left',
    'local infixl:65 (priority := high) " + " => stageOperation',
    'theorem target : ([1] ++ [2] : List Nat) = [1, 2] := by rfl',
  ] },
  { id: 'adjacent prefix operators', lines: [
    'def stageOperation (value : Bool) : Bool := by have := first; exact value',
    'def stableOperation (value : Bool) : Bool := value',
    'local prefix:90 "↟" => stageOperation', 'local prefix:91 "↓" => stableOperation',
    'theorem target : ↟↓true = true := by rfl',
  ] },
] as const;
const sourceFor = (lines: readonly string[]) => ['namespace NotationContext',
  'theorem first : True := by trivial', ...lines, 'end NotationContext', '',
].join('\n');
const root = { file: 'Submission.lean', name: 'NotationContext.first' };

function fixture(source: string, theoremName = 'NotationContext.target') {
  const directory = temporaryDirectory('task-source-notation-context-'); directories.push(directory);
  const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), { source, task: 'Preserve checked source quotation context.' });
  const workspace = receipt.workspaceRoot, problem = readSolverProblem(workspace, receipt.activeProblemPath);
  const records: TaskRecord[] = problem.targets.map((item, index) => ({ task: { id: `original-${index}`, kind: 'goal',
    objective: 'Prove the exact original.', proofPath: item.proofPath, theoremName: item.theoremName, dependsOn: [], revision: 0 },
    status: 'pending', attempts: 0 }));
  const task = records.find(node => node.task.theoremName === theoremName)!.task;
  const project = createTaskSourceProjector(problem, workspace, problem.baseCommit);
  const native = (text: string, name = theoremName) => {
    if (!lean) throw new Error('Native Lean is required for quotation-context regression checks.');
    const file = path.join(directory, 'Projection.lean'); fs.writeFileSync(file, text + `\n#print axioms ${name}\n`);
    const result = spawnSync(lean, [file], { cwd: receipt.projectRoot, encoding: 'utf8', timeout: 20_000 });
    expect(result.error).toBeUndefined(); return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };
  const accepted = (text: string) => {
    const result = native(text); expect(result.status, result.output).toBe(0); expect(result.output).not.toContain('sorryAx');
  };
  return { directory, receipt, workspace, problem, source, records, task, project, native, accepted };
}

// Missing API returns no candidates so the baseline fails on the actual discovery gap.
function possible(f: ReturnType<typeof fixture>, retained: readonly string[] = [], conditions: readonly CooperativeTask[] = []) {
  const project = f.project as typeof f.project & { possibleContextGoals?: (task: CooperativeTask, retained: readonly string[],
    conditions: readonly CooperativeTask[]) => readonly { file: string; name: string }[] };
  return project.possibleContextGoals?.(f.task, retained, conditions) ?? [];
}

describe('conservative notation context without invented dependency hints', () => {
  it.each(cases)('finds quotation context for $id without claiming an unambiguous dependency', ({ lines }) => {
    const f = fixture(sourceFor(lines)); f.accepted(f.source);
    const unretained = f.native(f.project(f.task, []).get('Submission.lean')!);
    expect(unretained.status, unretained.output).not.toBe(0);
    f.accepted(f.project(f.task, [root.name]).get('Submission.lean')!);
    expect(f.project.dependencyHints(f.task, [])).toEqual([]);
    expect(possible(f)).toEqual([expect.objectContaining(root)]);
    expect(projectedGoalInputs(f.project, f.task, f.records).map(node => node.task.theoremName)).toEqual([root.name]);
    expect(possible(f, [root.name])).toEqual([]);
    expect(f.records.find(node => node.task.theoremName === root.name)?.status).toBe('pending');
  });

  it('does not recover an expired local notation', () => {
    const f = fixture(sourceFor([
      'section', 'local notation "choice" => first', 'end',
      'local notation "choice" => (0 : Nat)', 'theorem target : choice = 0 := by rfl',
    ]));
    f.accepted(f.source); expect(possible(f)).toEqual([]);
    expect(f.project.dependencyHints(f.task, [])).toEqual([]);
    expect(projectedGoalInputs(f.project, f.task, f.records)).toEqual([]);
    f.accepted(f.project(f.task, []).get('Submission.lean')!);
  });

  it('keeps possible context out of source hints across distinct namespace lifetimes', () => {
    const f = fixture([
      'namespace Dead', 'theorem first : True := by trivial', 'local notation "choice" => first', 'end Dead',
      'namespace Live', 'local notation "choice" => (0 : Nat)',
      'theorem target : choice = 0 := by rfl', 'end Live', '',
    ].join('\n'), 'Live.target');
    f.accepted(f.source); expect(possible(f)).toEqual([]);
    expect(projectedGoalInputs(f.project, f.task, f.records)).toEqual([]);
    f.accepted(f.project(f.task, []).get('Submission.lean')!);
  });

  it('includes required quotation context from a frozen conditional input without retaining its assumed proof', () => {
    const f = fixture(sourceFor([
      'def stageType : Type := by have := first; exact Nat',
      'local notation "choice" => stageType', 'local notation (priority := high) "choice" => Nat',
      'theorem assumed : ∀ n : choice, n = n := by intro n; rfl',
      'theorem target : True := by have := assumed; trivial',
    ]));
    const condition: CooperativeTask = { id: 'condition', kind: 'lemma', objective: 'Prove the frozen condition.',
      theoremName: 'NotationContext.assumed', proofPath: 'Submission.lean', type: '∀ n : choice, n = n', dependsOn: [], revision: 0 };
    expect(possible(f, [], [condition])).toEqual([expect.objectContaining(root)]);
    expect(projectedGoalInputs(f.project, f.task, f.records, [condition]).map(node => node.task.theoremName)).toEqual([root.name]);
    const projected = f.project(f.task, [root.name], [condition]).get('Submission.lean')!;
    expect(projected).not.toContain('theorem assumed');
    expect(projected).toContain('theorem target : theorem_os_conditional_type%');
    expect(projected).toContain('∀ n : choice, n = n');
    f.accepted(projected);
    expect(possible(f, [], [])).not.toEqual(possible(f, [root.name], [condition]));
  });

  it('isolates returned context and keeps changed conditions, retained goals and targets separate', () => {
    const f = fixture(sourceFor([
      'theorem second : True := by trivial',
      'def firstType : Type := by have := first; exact Nat',
      'def secondType : Type := by have := second; exact Nat',
      'local notation "choice" => firstType', 'local notation (priority := high) "choice" => Nat',
      'local notation "otherChoice" => secondType', 'local notation (priority := high) "otherChoice" => Nat',
      'theorem target : True := by trivial', 'theorem otherTarget : otherChoice = Nat := by rfl',
    ]));
    const condition: CooperativeTask = { id: 'assumed', kind: 'lemma', objective: 'Prove the frozen condition.',
      theoremName: 'NotationContext.assumed', proofPath: 'Submission.lean', type: '∀ n : choice, n = n', dependsOn: [], revision: 0 };
    expect(f.project.possibleContextGoals(f.task, [])).toEqual([]);
    const initial = f.project.possibleContextGoals(f.task, [], [condition]);
    const expected = structuredClone(initial);
    expect(expected).toEqual([expect.objectContaining(root)]);
    initial[0]!.name = 'NotationContext.forged'; initial[0]!.declarationDigest = 'forged';
    expect(f.project.possibleContextGoals(structuredClone(f.task), [], [structuredClone(condition)])).toEqual(expected);
    expect(f.project.dependencyHints(f.task, [], [condition])).toEqual([]);
    const retained = [root.name];
    expect(f.project.possibleContextGoals(f.task, retained, [condition])).toEqual([]);
    condition.type = '∀ n : otherChoice, n = n'; condition.revision++;
    expect(f.project.possibleContextGoals(f.task, retained, [condition]).map(item => item.name)).toEqual(['NotationContext.second']);
    retained.push('NotationContext.second');
    expect(f.project.possibleContextGoals(f.task, retained, [condition])).toEqual([]);
    retained.length = 0;
    expect(f.project.possibleContextGoals(f.task, retained, [condition]).map(item => item.name)).toEqual(['NotationContext.second']);
    const other = f.records.find(node => node.task.theoremName === 'NotationContext.otherTarget')!.task;
    expect(f.project.possibleContextGoals(other, []).map(item => item.name)).toEqual(['NotationContext.second']);
    expect(f.project.possibleContextGoals(f.task, [])).toEqual([]);
  });
});

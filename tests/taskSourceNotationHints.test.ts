import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { createTaskSourceProjector, projectedGoalInputs } from '../src/solver/cooperativeProof';
import { readSolverProblem } from '../src/solver/problem';
import type { CooperativeTask, TaskRecord } from '../src/solver/tasks';
import { temporaryDirectory } from './helpers/files';
import { newestLeanBinary } from './helpers/lean';

const directories: string[] = [], lean = newestLeanBinary();
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function fixture(source: string, theoremName = 'NotationHint.target') {
  const directory = temporaryDirectory('task-source-notation-hints-'); directories.push(directory);
  const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), { source, task: 'Find the exact original input.' });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  const records: TaskRecord[] = problem.targets.map((target, index) => ({ task: { id: `original-${index}`, kind: 'goal',
    objective: 'Prove the original target.', proofPath: target.proofPath, theoremName: target.theoremName,
    dependsOn: [], revision: 0 }, status: 'pending', attempts: 0 }));
  const task: CooperativeTask = records.find(node => node.task.theoremName === theoremName)!.task;
  const project = createTaskSourceProjector(problem, receipt.workspaceRoot, problem.baseCommit);
  const native = (text: string) => {
    if (!lean) throw new Error('Native Lean is required for notation dependency hint regressions.');
    const file = path.join(directory, 'Projection.lean'); fs.writeFileSync(file, text + `\n#print axioms ${theoremName}\n`);
    const result = spawnSync(lean, [file], { cwd: receipt.projectRoot, encoding: 'utf8', timeout: 20_000 });
    expect(result.error).toBeUndefined(); return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };
  const accepted = (text: string) => {
    const result = native(text); expect(result.status, result.output).toBe(0); expect(result.output).not.toContain('sorryAx');
  };
  return { source, records, task, project, native, accepted };
}

describe('original input discovery through notation', () => {
  it.each([
    ['alphabetic', ['local notation "bridge" => first'], 'bridge'],
    ['chained', ['local notation "bridge" => first', 'local notation "bridgeAgain" => bridge'], 'bridgeAgain'],
    ['symbolic', ['local notation "◇" => first'], '◇'],
  ] as const)('finds the original input behind a %s notation', (_kind, notations, expression) => {
    const f = fixture(['namespace NotationHint', 'theorem first : True := by trivial', ...notations,
      `theorem target : True := by exact ${expression}`, 'end NotationHint', '',
    ].join('\n'));
    f.accepted(f.source);
    const hints = f.project.dependencyHints(f.task, []);
    expect(hints.map(hint => hint.root.name)).toEqual(['NotationHint.first']);
    expect(hints[0]!.root.removedBecause).toBe('excluded-original-target');
    expect(hints[0]!.consumer.declaration.name).toBe('NotationHint.target');
    expect(hints[0]!.path[0]!.name).toBe('NotationHint.target');
    expect(hints[0]!.path.at(-1)!.name).toBe('NotationHint.first');
    const inputs = projectedGoalInputs(f.project, f.task, f.records);
    expect(inputs.map(node => node.task.theoremName)).toEqual(['NotationHint.first']);
    // Discovery does not grant acceptance to this still-pending original input.
    expect(inputs[0]!.status).toBe('pending'); expect(inputs[0]!.integratedCheck).toBeUndefined();
    expect(f.native(f.project(f.task, []).get('Submission.lean')!).status).not.toBe(0);
    f.accepted(f.project(f.task, inputs.map(node => node.task.theoremName!)).get('Submission.lean')!);
  });

  it('follows an unscoped global notation outside the namespace where it was declared', () => {
    const f = fixture([
      'namespace Producer', 'theorem first : True := by trivial', 'notation "globalBridge" => first', 'end Producer',
      'namespace Consumer', 'def wrapper : True := globalBridge',
      'theorem target : True := by exact wrapper', 'end Consumer', '',
    ].join('\n'), 'Consumer.target');
    f.accepted(f.source);
    expect(f.project.dependencyHints(f.task, []).map(hint => hint.root.name)).toEqual(['Producer.first']);
    const inputs = projectedGoalInputs(f.project, f.task, f.records);
    expect(inputs.map(node => node.task.theoremName)).toEqual(['Producer.first']);
    f.accepted(f.project(f.task, inputs.map(node => node.task.theoremName!)).get('Submission.lean')!);
  });

  it('keeps overloaded syntax out of unambiguous dependency hints', () => {
    const f = fixture([
      'namespace NotationHint', 'theorem first : True := by trivial',
      'theorem second : False → False := by intro impossible; exact impossible',
      'local notation "choice" => first', 'local notation "choice" => second',
      'theorem target : True := by exact choice', 'end NotationHint', '',
    ].join('\n'));
    f.accepted(f.source);
    expect(f.project.dependencyHints(f.task, [])).toEqual([]);
    expect(projectedGoalInputs(f.project, f.task, f.records).map(node => node.task.theoremName))
      .toEqual(['NotationHint.first', 'NotationHint.second']);
    expect(f.native(f.project(f.task, []).get('Submission.lean')!).status).not.toBe(0);
    f.accepted(f.project(f.task, ['NotationHint.first', 'NotationHint.second']).get('Submission.lean')!);
  });

  it('does not discover a dead input through a same-named live notation in another namespace', () => {
    const f = fixture([
      'namespace Dead', 'theorem originalProof : True := by trivial',
      'def shadowed : Nat := by have := originalProof; exact 0', 'local notation "choice" => shadowed', 'end Dead',
      'namespace Live', 'abbrev shadowed := Nat', 'local notation "choice" => shadowed',
      'theorem target (n : choice) : n = n := by rfl', 'end Live', '',
    ].join('\n'), 'Live.target');
    f.accepted(f.source);
    expect(f.project.dependencyHints(f.task, [])).toEqual([]);
    expect(projectedGoalInputs(f.project, f.task, f.records)).toEqual([]);
    f.accepted(f.project(f.task, []).get('Submission.lean')!);
  });

  it('keeps the plus quotation context out of unambiguous append dependency hints', () => {
    const f = fixture([
      'namespace NotationHint', 'theorem first : True := by trivial',
      'def stageOperation (left right : Nat) : Nat := by have := first; exact left',
      'local infixl:65 (priority := high) " + " => stageOperation',
      'theorem target : ([1] ++ [2] : List Nat) = [1, 2] := by rfl', 'end NotationHint', '',
    ].join('\n'));
    f.accepted(f.source);
    expect(f.project.dependencyHints(f.task, [])).toEqual([]);
    expect(projectedGoalInputs(f.project, f.task, f.records).map(node => node.task.theoremName))
      .toEqual(['NotationHint.first']);
  });

  it('ignores notation names mentioned only in strings and comments', () => {
    const f = fixture([
      'namespace NotationHint', 'theorem first : True := by trivial', 'local notation "bridge" => first',
      'theorem target : "bridge" = "bridge" := by /- bridge -/ rfl', 'end NotationHint', '',
    ].join('\n'));
    f.accepted(f.source);
    expect(f.project.dependencyHints(f.task, [])).toEqual([]);
    expect(projectedGoalInputs(f.project, f.task, f.records)).toEqual([]);
    f.accepted(f.project(f.task, []).get('Submission.lean')!);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { createTaskSourceProjector } from '../src/solver/cooperativeProof';
import { committedSource, readSolverProblem } from '../src/solver/problem';
import type { CooperativeTask } from '../src/solver/tasks';
import { temporaryDirectory } from './helpers/files';
import { newestLeanBinary } from './helpers/lean';

const directories: string[] = [], lean = newestLeanBinary();
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

const source = [
  'namespace MacroProjection',
  'theorem sourceGoal : ∃ n : Nat, n = n := by exact ⟨0, rfl⟩',
  'noncomputable def sourceStage : Nat := sourceGoal.choose',
  'abbrev SourceCoordinate := Fin (sourceStage + 1)',
  'section',
  'local notation "coordinate" =>',
  '  SourceCoordinate',
  'local notation "coordinateAgain" => coordinate',
  'local notation "stableCoordinate" => Nat',
  'theorem independent (n : stableCoordinate) : n = n := by rfl',
  'theorem dependent (n : coordinateAgain) : n = n := by rfl',
  'end',
  'theorem unfinished : True := by sorry',
  'end MacroProjection', '',
].join('\n');

function fixture(text = source) {
  const directory = temporaryDirectory('task-source-macro-projection-'); directories.push(directory);
  const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), { source: text, task: 'Check the exact independent original target.' });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  const task = (name: string): CooperativeTask => ({ id: name, kind: 'goal', objective: 'Original goal',
    proofPath: 'Submission.lean', theoremName: `MacroProjection.${name}`, dependsOn: [], revision: 0 });
  const native = (text: string) => {
    if (!lean) throw new Error('Native Lean is required for macro quotation projection regression.');
    const file = path.join(directory, 'Projected.lean'); fs.writeFileSync(file, text);
    const checked = spawnSync(lean, [file], { cwd: receipt.projectRoot, encoding: 'utf8', timeout: 20_000 });
    expect(checked.error).toBeUndefined();
    return { status: checked.status, output: `${checked.stdout}${checked.stderr}` };
  };
  return { directory, receipt, problem, task, native };
}

describe('macro quotation context after source projection', () => {
  it.each([false, true])('removes notations whose quoted input was excluded (compact: %s)', compact => {
    const f = fixture();
    expect(f.native(source).status).toBe(0);
    const projected = createTaskSourceProjector(f.problem, f.receipt.workspaceRoot, f.problem.baseCommit, { compact })
      (f.task('independent'), []).get('Submission.lean')!;
    // An excluded original theorem cannot authorize its data-dependent aliases.
    expect(projected).not.toContain('theorem sourceGoal'); expect(projected).not.toContain('def sourceStage');
    expect(projected).not.toContain('abbrev SourceCoordinate');
    const checked = f.native(projected + '\n#print axioms MacroProjection.independent\n');
    expect(checked.status, checked.output).toBe(0); expect(checked.output).not.toContain('sorryAx');
    expect(projected).toContain('local notation "stableCoordinate" => Nat');
    expect(projected).toContain('theorem independent'); expect(projected).not.toContain('theorem unfinished');
    expect(committedSource(f.receipt.workspaceRoot, f.problem.baseCommit,
      `${f.problem.projectRelative}/Submission.lean`)).toBe(source);
  });

  it('retains live notation and its original inputs when the host explicitly supplies those checked goals', () => {
    const f = fixture(), projected = createTaskSourceProjector(f.problem, f.receipt.workspaceRoot, f.problem.baseCommit)
      (f.task('dependent'), ['MacroProjection.sourceGoal']).get('Submission.lean')!;
    for (const declaration of ['theorem sourceGoal', 'def sourceStage', 'abbrev SourceCoordinate',
      'local notation "coordinate"', 'local notation "coordinateAgain"', 'theorem dependent'])
      expect(projected).toContain(declaration);
    const checked = f.native(projected + '\n#print axioms MacroProjection.dependent\n');
    expect(checked.status, checked.output).toBe(0); expect(checked.output).not.toContain('sorryAx');
    expect(projected).not.toContain('theorem unfinished');
  });

  it('does not accept a consumer that actually needs an excluded original through notation', () => {
    const f = fixture(), projected = createTaskSourceProjector(f.problem, f.receipt.workspaceRoot, f.problem.baseCommit)
      (f.task('dependent'), []).get('Submission.lean')!;
    expect(projected).not.toContain('theorem sourceGoal'); expect(projected).not.toContain('def sourceStage');
    expect(f.native(projected).status).not.toBe(0);
  });

  it('keeps the syntax behind a retained target’s definition dependencies from becoming implicit parameters', () => {
    const text = source.replace('theorem independent', [
      'abbrev wrappedCoordinate := coordinateAgain',
      'theorem wrappedDependent (n : wrappedCoordinate) : n = n := by rfl',
      'theorem independent',
    ].join('\n')), f = fixture(text);
    const original = f.native(text);
    expect(original.status, original.output).toBe(0);
    const projected = createTaskSourceProjector(f.problem, f.receipt.workspaceRoot, f.problem.baseCommit)
      (f.task('wrappedDependent'), []).get('Submission.lean')!;
    expect(projected).not.toContain('theorem sourceGoal');
    expect(f.native(projected).status).not.toBe(0);
  });

  it.each([
    { name: 'shadowed', declaration: [
      'namespace Shadow', 'abbrev SourceCoordinate := Nat',
      'local notation "shadowCoordinate" => SourceCoordinate',
      'theorem shadowed (n : shadowCoordinate) : n = n := by rfl', 'end Shadow',
    ].join('\n'), target: 'Shadow.shadowed', retained: 'local notation "shadowCoordinate"' },
    { name: 'later-local-alias', declaration: [
      'section', 'local notation "coordinate" => Nat',
      'theorem later (n : coordinate) : n = n := by rfl', 'end',
    ].join('\n'), target: 'later', retained: 'local notation "coordinate" => Nat' },
    { name: 'syntax-parameter', declaration: [
      'local notation "passthrough " sourceStage => sourceStage',
      'theorem boundInput (n : passthrough Nat) : n = n := by rfl',
    ].join('\n'), target: 'boundInput', retained: 'local notation "passthrough "' },
    { name: 'string-literal', declaration: [
      'local notation "keptText" => "SourceCoordinate"',
      'theorem stringInput : keptText = "SourceCoordinate" := by rfl',
    ].join('\n'), target: 'stringInput', retained: 'local notation "keptText"' },
  ])('preserves live $name notation while removing an unrelated broken alias', ({ declaration, target, retained }) => {
    const text = source.replace('theorem unfinished', `${declaration}\ntheorem unfinished`), f = fixture(text);
    const original = f.native(text);
    expect(original.status, original.output).toBe(0);
    const projected = createTaskSourceProjector(f.problem, f.receipt.workspaceRoot, f.problem.baseCommit)
      (f.task(target), []).get('Submission.lean')!;
    expect(projected).toContain(retained);
    expect(projected).not.toContain('local notation "coordinateAgain"');
    const checked = f.native(projected + `\n#print axioms MacroProjection.${target}\n`);
    expect(checked.status, checked.output).toBe(0);
    expect(checked.output).not.toContain('sorryAx');
  });
});

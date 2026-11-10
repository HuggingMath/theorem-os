import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { inspectLeanProjectionDeclarations } from '../src/math/leanSource';
import { createTaskSourceProjector } from '../src/solver/cooperativeProof';
import { readSolverProblem } from '../src/solver/problem';
import { inspectProjectionNotations } from '../src/solver/projectionNotation';
import type { CooperativeTask } from '../src/solver/tasks';
import { temporaryDirectory } from './helpers/files';
import { newestLeanBinary } from './helpers/lean';

const directories: string[] = [], lean = newestLeanBinary();
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const prerequisite = [
  'namespace NotationFixture',
  'theorem sourceGoal : ∃ n : Nat, n = n := by exact ⟨0, rfl⟩',
  'noncomputable def sourceStage : Nat := sourceGoal.choose',
  'abbrev SourceCoordinate := Fin (sourceStage + 1)',
];

function fixture(lines: string[]) {
  const source = [...prerequisite, ...lines, 'end NotationFixture', ''].join('\n');
  const directory = temporaryDirectory('projection-notation-'); directories.push(directory);
  const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), { source, task: 'Verify notation projection boundaries.' });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  const project = (name: string) => {
    const task: CooperativeTask = { id: name, kind: 'goal', objective: 'Check the original target.', proofPath: 'Submission.lean',
      theoremName: `NotationFixture.${name}`, dependsOn: [], revision: 0 };
    return createTaskSourceProjector(problem, receipt.workspaceRoot, problem.baseCommit)(task, []).get('Submission.lean')!;
  };
  const native = (text: string) => {
    if (!lean) throw new Error('Native Lean is required for notation projection regressions.');
    const file = path.join(directory, 'Projection.lean'); fs.writeFileSync(file, text);
    const result = spawnSync(lean, [file], { cwd: receipt.projectRoot, encoding: 'utf8', timeout: 20_000 });
    expect(result.error).toBeUndefined(); return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };
  const accepted = (text: string) => { const result = native(text); expect(result.status, result.output).toBe(0); };
  return { source, project, native, accepted };
}

describe('notation command projection boundaries', () => {
  it('handles multiline commands while preserving syntax binders, comments and string contents', () => {
    const f = fixture([
      'section', 'local notation "broken" =>', '  /- This reference is executable below. -/', '  SourceCoordinate',
      'local notation "passthrough " sourceStage => sourceStage',
      'local notation "stable" => Nat /- SourceCoordinate -/',
      'local notation "keptText" => "SourceCoordinate"',
      'theorem independent (n : passthrough stable) : n = n ∧ keptText = "SourceCoordinate" := by exact ⟨rfl, rfl⟩', 'end',
    ]);
    f.accepted(f.source);
    const notes = inspectProjectionNotations(f.source, inspectLeanProjectionDeclarations(f.source));
    expect(notes.find(note => note.alias === 'passthrough')?.bound).toEqual(['sourceStage']);
    const projected = f.project('independent');
    expect(projected).not.toContain('local notation "broken"');
    expect(projected).toContain('local notation "passthrough "');
    expect(projected).toContain('local notation "stable"'); expect(projected).toContain('local notation "keptText"');
    f.accepted(projected + '\n#print axioms NotationFixture.independent\n');
  });

  it('removes an excluded notation together with its command-local open prefix', () => {
    const f = fixture([
      'namespace Helpers', 'abbrev Coordinate := SourceCoordinate', 'end Helpers',
      'open Helpers in', 'local notation "coordinate" =>', '  Coordinate',
      'theorem independent : True := by trivial',
    ]);
    f.accepted(f.source);
    const note = inspectProjectionNotations(f.source, inspectLeanProjectionDeclarations(f.source))[0]!;
    expect(note.startOffset).toBe(f.source.indexOf('open Helpers in'));
    expect(note.opens.at(-1)).toMatchObject({ command: 'Helpers', namespace: 'NotationFixture', local: true });
    const projected = f.project('independent');
    expect(projected).not.toContain('local notation "coordinate"'); expect(projected).not.toContain('open Helpers in');
    f.accepted(projected);
  });

  it('limits a notation in suffix to its following declaration', () => {
    const f = fixture([
      'notation "temporaryCoordinate" => SourceCoordinate in',
      'theorem temporary (n : temporaryCoordinate) : n = n := by rfl',
      'theorem independent : True := by trivial',
    ]);
    f.accepted(f.source);
    const note = inspectProjectionNotations(f.source, inspectLeanProjectionDeclarations(f.source))[0]!;
    expect(note.local).toBe(true); expect(note.scopeEnd).toBe(f.source.indexOf('theorem independent'));
    const projected = f.project('independent');
    expect(projected).not.toContain('notation "temporaryCoordinate"');
    f.accepted(projected);
  });

  it('keeps a live same-named coordinate in a nested namespace', () => {
    const f = fixture([
      'section', 'local notation "coordinate" => SourceCoordinate', 'end',
      'namespace Live', 'abbrev SourceCoordinate := Nat',
      'local notation "coordinate" => SourceCoordinate',
      'theorem independent (n : coordinate) : n = n := by rfl', 'end Live',
    ]);
    f.accepted(f.source);
    const notes = inspectProjectionNotations(f.source, inspectLeanProjectionDeclarations(f.source));
    expect(notes.map(note => note.namespace)).toEqual(['NotationFixture', 'NotationFixture.Live']);
    const projected = f.project('Live.independent');
    expect(projected.match(/local notation "coordinate"/gu)).toHaveLength(1);
    f.accepted(projected);
  });

  it.each([
    ['infix', 'local infixl:65 (priority := high) " + " => stageOperation', '(left right : Nat)', 'left + right'],
    ['prefix', 'local prefix:90 "↟" => stageUnary', '(value : Nat)', '↟value'],
  ])('keeps a required %s command so deletion cannot change the target meaning', (_kind, command, parameters, expression) => {
    const f = fixture([
      'noncomputable def stageOperation (left right : Nat) : Nat := left + right + sourceStage',
      'noncomputable def stageUnary (value : Nat) : Nat := value + sourceStage',
      command, 'theorem independent : True := by trivial',
      `theorem dependent ${parameters} : ${expression} = ${expression} := by rfl`,
    ]);
    f.accepted(f.source);
    const independent = f.project('independent');
    expect(independent).not.toContain(command); f.accepted(independent);
    const dependent = f.project('dependent');
    expect(dependent).toContain(command); expect(dependent).not.toContain('theorem sourceGoal');
    expect(f.native(dependent).status).not.toBe(0);
  });

  it('leaves escaped syntax tokens unoptimized when their exact literal is unsupported', () => {
    const source = 'notation "quote\\\"token" => Missing\n';
    expect(inspectProjectionNotations(source, [])).toEqual([]);
  });
});

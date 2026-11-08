import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { createTaskSourceProjector, projectedGoalInputs } from '../src/solver/cooperativeProof';
import { committedSource, commitSolverSources, readSolverProblem } from '../src/solver/problem';
import type { CooperativeTask } from '../src/solver/tasks';
import { temporaryDirectory } from './helpers/files';
import { newestLeanBinary } from './helpers/lean';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(source: string, solved = source) {
  const directory = temporaryDirectory('task-source-projection-'); roots.push(directory);
  const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), { source, task: 'Prove the original targets.' });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  const file = path.join(receipt.projectRoot, 'Submission.lean'); fs.writeFileSync(file, solved);
  const commit = commitSolverSources(problem, receipt.workspaceRoot);
  return { directory, receipt, problem, commit, file,
    project: createTaskSourceProjector(problem, receipt.workspaceRoot, commit),
    task(name: string): CooperativeTask {
      return { id: name, kind: 'goal', objective: `Prove ${name}.`, proofPath: 'Submission.lean', theoremName: name,
        dependsOn: [], revision: 0 };
    } };
}

function leanCheck(f: ReturnType<typeof fixture>, source: string, name: string) {
  const output = path.join(f.directory, 'Projection.lean');
  fs.writeFileSync(output, source + `\n#print axioms ${name}\n`);
  const checked = spawnSync(newestLeanBinary()!, [output], { encoding: 'utf8', timeout: 20_000 });
  expect(checked.error).toBeUndefined();
  expect(`${checked.stdout}${checked.stderr}`).not.toContain('sorryAx');
  expect(checked.status, `${checked.stdout}${checked.stderr}`).toBe(0);
}

const fieldSource = [
  'namespace Nat',
  'theorem fixture_field_zero (n : Nat) : n = n := by sorry',
  'theorem fixture_field_star (n : Nat) : n = n := by sorry',
  'def fixtureFrozen (n : Nat) : {m : Nat // m = n} := ⟨n, n.fixture_field_zero⟩',
  'def fixtureFrozenChain (n : Nat) : Nat := n.fixtureFrozen.val',
  'def fixtureFieldConsumer (n : Nat) : {m : Nat // m = n} := ⟨n.fixtureFrozenChain, n.fixture_field_star⟩',
  'end Nat',
  '',
].join('\n');

describe('owned source projection through dot notation', () => {
  const typedConsumerSource = [
    'namespace Fixture',
    'theorem nonneg (n : Nat) : 0 ≤ n := by sorry',
    'theorem mass (n : Nat) : n = n := by sorry',
    'def channel (n : Nat) : {m : Nat // m = n} := ⟨n, mass n⟩',
    'def observationLaw (n : Nat) : Nat := (channel n).val',
    'theorem headline (n : Nat) : observationLaw n = n := by sorry',
    'end Fixture', '',
  ].join('\n');

  it.skipIf(!newestLeanBinary())('tracks global dependencies before a same-named parameter enters scope', () => {
    const source = [
      'namespace Fixture', 'theorem input : True := by sorry',
      'def witness : Nat := by have := input; exact 0',
      'theorem goal : True := by sorry', 'end Fixture', '',
    ].join('\n');
    const solved = source.replaceAll('by sorry', 'by trivial').replace('theorem goal',
      'theorem typed (witness : {n : Nat // n = witness}) : True := by trivial\n' +
      'theorem grouped (witness companion : Fin (witness + 1)) : True := by trivial\n' +
      'theorem nested (h : (witness : Nat) = 0) : True := by trivial\n' +
      'theorem defaulted (n : Nat := witness) : True := by trivial\n' +
      'theorem anonymous [Decidable (witness = 0)] : True := by trivial\n' +
      'theorem cast : (witness : Nat) = 0 := by rfl\n' +
      'theorem shadowed (witness : Nat) : witness = witness := by rfl\n' +
      'theorem goal');
    const f = fixture(source, solved);
    leanCheck(f, solved, 'Fixture.goal');
    const projected = f.project(f.task('Fixture.goal'), []).get('Submission.lean')!;
    expect(projected).not.toContain('def witness');
    expect(projected).not.toContain('theorem typed');
    expect(projected).not.toContain('theorem grouped');
    expect(projected).not.toContain('theorem nested');
    expect(projected).not.toContain('theorem defaulted');
    expect(projected).not.toContain('theorem anonymous');
    expect(projected).not.toContain('theorem cast');
    expect(projected).toContain('theorem shadowed');
    leanCheck(f, projected, 'Fixture.goal');
  });

  it.skipIf(!newestLeanBinary()).each([
    ['inferred', '(witness) (h : witness = (0 : Nat))'],
    ['bare', 'witness (h : witness = (0 : Nat))'],
    ['implicit', '{witness} (h : witness = (0 : Nat))'],
    ['strict implicit', '⦃witness : Nat⦄'],
    ['grouped', '(witness companion : Nat)'],
    ['instance', '[witness : Inhabited Nat]'],
  ])('keeps %s parameters that shadow an excluded global definition', (_kind, parameters) => {
    const source = [
      'namespace Fixture', 'theorem input : True := by sorry',
      'def witness : Nat := by have := input; exact 0',
      'theorem goal : True := by sorry', 'end Fixture', '',
    ].join('\n');
    const solved = source.replaceAll('by sorry', 'by trivial').replace('theorem goal',
      `theorem kept ${parameters} : True := by trivial\n` + 'theorem goal');
    const f = fixture(source, solved);
    leanCheck(f, solved, 'Fixture.kept');
    const projected = f.project(f.task('Fixture.goal'), []).get('Submission.lean')!;
    expect(projected).not.toContain('def witness');
    expect(projected).toContain('theorem kept');
    leanCheck(f, projected, 'Fixture.kept');
  });

  it.skipIf(!newestLeanBinary())('orders a goal after the original used by its same-named parameter type', () => {
    const source = [
      'namespace Fixture', 'theorem input : True := by sorry',
      'def witness : Nat := by have := input; exact 0',
      'theorem goal (witness : {n : Nat // n = witness}) : True := by sorry', 'end Fixture', '',
    ].join('\n');
    const f = fixture(source, source.replaceAll('by sorry', 'by trivial'));
    const task = f.task('Fixture.goal'), input = { task: f.task('Fixture.input'), status: 'pending' as const, attempts: 0 };
    expect(projectedGoalInputs(f.project, task, [input])).toEqual([input]);
    expect(f.project.dependencyHints(task, []).map(hint => hint.path.map(item => item.name)))
      .toEqual([['Fixture.goal', 'Fixture.witness', 'Fixture.input']]);
    leanCheck(f, f.project(task, ['Fixture.input']).get('Submission.lean')!, 'Fixture.goal');
  });

  it.skipIf(!newestLeanBinary())('removes consumers whose types reference a removed frozen definition', () => {
    const solved = typedConsumerSource.replace('by sorry', 'by exact Nat.zero_le n')
      .replace('theorem headline',
        'theorem observation_helper (n : Nat) : observationLaw n = n := by rfl\n' +
        'theorem typed_binder (n : Nat) (h : channel n = channel n) : True := by trivial\n' +
        'theorem shadowed (channel : Nat) : channel = channel := by rfl\n' +
        'theorem headline');
    const f = fixture(typedConsumerSource, solved);
    const projected = f.project(f.task('Fixture.nonneg'), []).get('Submission.lean')!;
    expect(projected).not.toContain('def channel');
    expect(projected).not.toContain('def observationLaw');
    expect(projected).not.toContain('theorem observation_helper');
    expect(projected).not.toContain('theorem typed_binder');
    expect(projected).toContain('theorem shadowed (channel : Nat)');
    leanCheck(f, projected, 'Fixture.nonneg');
  });

  it.skipIf(!newestLeanBinary())('orders an original goal after the proved originals needed by its type', () => {
    const f = fixture(typedConsumerSource, typedConsumerSource.replaceAll('by sorry', 'by rfl'));
    const target = f.task('Fixture.headline'), mass = f.task('Fixture.mass');
    expect(projectedGoalInputs(f.project, target,
      [{ task: mass, status: 'pending', attempts: 0 }, { task: target, status: 'pending', attempts: 0 }]))
      .toEqual([{ task: mass, status: 'pending', attempts: 0 }]);
    expect(f.project.dependencyHints(target, []).map(hint => hint.path.map(item => item.name)))
      .toContainEqual(['Fixture.headline', 'Fixture.observationLaw', 'Fixture.channel', 'Fixture.mass']);
    const projected = f.project(target, ['Fixture.mass']).get('Submission.lean')!;
    expect(projected).toContain('def channel');
    expect(projected).toContain('def observationLaw');
    leanCheck(f, projected, 'Fixture.headline');
  });

  it.skipIf(!newestLeanBinary())('removes unrelated frozen definitions and chained consumers of excluded original fields', () => {
    const f = fixture(fieldSource, fieldSource.replace('fixture_field_star (n : Nat) : n = n := by sorry',
      'fixture_field_star (n : Nat) : n = n := by rfl'));
    const source = f.project(f.task('Nat.fixture_field_star'), []).get('Submission.lean')!;
    expect(source).toContain('theorem fixture_field_star');
    expect(source).not.toContain('theorem fixture_field_zero');
    expect(source).not.toContain('def fixtureFrozen');
    expect(source).not.toContain('def fixtureFieldConsumer');
    leanCheck(f, source, 'Nat.fixture_field_star');
    expect(fs.readFileSync(f.file, 'utf8')).toContain('def fixtureFrozenChain');
    expect(committedSource(f.receipt.workspaceRoot, f.commit, 'generated/problem/Submission.lean'))
      .toBe(fs.readFileSync(f.file, 'utf8'));
  });

  it.skipIf(!newestLeanBinary())('removes old frozen callers when a target gets conditional binders', () => {
    const source = [
      'namespace Nat',
      'theorem fixture_field_star (n : Nat) : n = n := by sorry',
      'def fixtureFrozen (n : Nat) : {m : Nat // m = n} := ⟨n, n.fixture_field_star⟩',
      'def fixtureFrozenChain (n : Nat) : Nat := n.fixtureFrozen.val',
      'end Nat', '',
    ].join('\n');
    const solved = source.replace('by sorry', 'by exact fixture_premise n').replace('namespace Nat\n',
      'namespace Nat\nlemma fixture_premise (n : Nat) : n = n := by sorry\n');
    const f = fixture(source, solved), task = f.task('Nat.fixture_field_star');
    const premise: CooperativeTask = { id: 'premise', kind: 'lemma', objective: 'Prove reflexivity.',
      proofPath: 'Submission.lean', theoremName: 'Nat.fixture_premise', type: '∀ n : Nat, n = n', dependsOn: [], revision: 0 };
    const projected = f.project(task, [], [premise]).get('Submission.lean')!;
    expect(projected).toContain('theorem fixture_field_star (fixture_premise : ∀ n : Nat, n = n)');
    expect(projected).not.toContain('def fixtureFrozen');
    expect(projected).not.toContain('lemma fixture_premise');
    leanCheck(f, projected, 'Nat.fixture_field_star');
    expect(fs.readFileSync(f.file, 'utf8')).toBe(solved);
  });

  it.skipIf(!newestLeanBinary())('removes declaration-prefix consumers such as witness.choose', () => {
    const source = [
      'namespace Fixture',
      'theorem witness : ∃ n : Nat, n = 1 := by sorry',
      'noncomputable def frozen : Nat := witness.choose',
      'def frozenConsumer : Nat := frozen',
      'theorem goal : True := by sorry',
      'end Fixture', '',
    ].join('\n');
    const f = fixture(source, source.replace('goal : True := by sorry', 'goal : True := by trivial'));
    const projected = f.project(f.task('Fixture.goal'), []).get('Submission.lean')!;
    expect(projected).not.toContain('def frozen');
    expect(projected).not.toContain('witness.choose');
    leanCheck(f, projected, 'Fixture.goal');
  });

  it('emits the original-goal path through frozen definitions without retaining an unproved field', () => {
    const source = fieldSource.replace('end Nat',
      'theorem fixture_goal (n : Nat) : n.fixtureFrozenChain = n := by sorry\nend Nat');
    const f = fixture(source), task = f.task('Nat.fixture_goal');
    const hints = f.project.dependencyHints(task, []);
    expect(hints.map(hint => hint.path.map(item => item.name))).toContainEqual([
      'Nat.fixture_goal', 'Nat.fixtureFrozenChain', 'Nat.fixtureFrozen', 'Nat.fixture_field_zero',
    ]);
    expect(hints.every(hint => hint.proofAcceptance === 'not-assessed' && hint.authority === 'unambiguous-source-reference')).toBe(true);
    expect(f.project(task, []).get('Submission.lean')).not.toContain('theorem fixture_field_zero');
  });

  it.skipIf(!newestLeanBinary())('keeps an explicitly retained proved original and its frozen consumers', () => {
    const source = fieldSource.replace('fixtureFieldConsumer (n : Nat) : {m : Nat // m = n} := ⟨n.fixtureFrozenChain, n.fixture_field_star⟩',
      'fixtureFieldConsumer (n : Nat) : {m : Nat // m = n} := ⟨n.fixtureFrozenChain, n.fixture_field_zero⟩');
    const f = fixture(source, source.replaceAll('by sorry', 'by rfl'));
    const projected = f.project(f.task('Nat.fixture_field_star'), ['Nat.fixture_field_zero']).get('Submission.lean')!;
    expect(projected).toContain('theorem fixture_field_zero');
    expect(projected).toContain('def fixtureFrozenChain');
    leanCheck(f, projected, 'Nat.fixture_field_star');
  });

  it('does not turn ambiguous receiver fields into a unique dependency hint', () => {
    const source = [
      'structure Left where', '  value : Nat',
      'structure Right where', '  value : Nat',
      'namespace Left', 'theorem left_input (x : Left) : x = x := by sorry',
      'def field (x : Left) : x = x := left_input x', 'end Left',
      'namespace Right', 'theorem right_input (x : Right) : x = x := by sorry',
      'def field (x : Right) : x = x := right_input x', 'end Right',
      'def frozen (x : Right) : x = x := x.field',
      'theorem goal (x : Right) : x = x := by sorry', '',
    ].join('\n');
    const f = fixture(source, source.replace('goal (x : Right) : x = x := by sorry',
      'goal (x : Right) : x = x := by exact x.field'));
    expect(f.project(f.task('goal'), []).get('Submission.lean')).not.toContain('def frozen');
    expect(f.project.dependencyHints(f.task('goal'), [])).toEqual([]);
  });

  it('keeps explicit namespace references distinct from unrelated declarations sharing their leaf', () => {
    const source = [
      'namespace Other', 'theorem other_input (n : Nat) : n = n := by sorry',
      'def same (n : Nat) : n = n := other_input n', 'end Other',
      'namespace Nat', 'theorem nat_input (n : Nat) : n = n := by sorry',
      'def same (n : Nat) : n = n := nat_input n',
      'def frozen (n : Nat) : n = n := Nat.same n',
      'theorem goal (n : Nat) : n = n := by sorry', 'end Nat', '',
    ].join('\n');
    const f = fixture(source, source.replace('goal (n : Nat) : n = n := by sorry',
      'goal (n : Nat) : n = n := by exact frozen n'));
    const hints = f.project.dependencyHints(f.task('Nat.goal'), []);
    expect(hints.map(hint => hint.root.name)).toEqual(['Nat.nat_input']);
    expect(hints[0]!.path.map(item => item.name)).toEqual(['Nat.goal', 'Nat.frozen', 'Nat.same', 'Nat.nat_input']);
  });

  it('propagates removal from a draft helper through an otherwise frozen definition', () => {
    const source = [
      'namespace Nat', 'theorem goal : True := by sorry', 'end Nat', '',
    ].join('\n');
    const solved = source.replace('theorem goal',
      'lemma fixture_draft (n : Nat) : n = n := by sorry\n' +
      'def fixtureFrozen (n : Nat) : n = n := n.fixture_draft\n' +
      'theorem goal');
    const f = fixture(source, solved);
    expect(f.project(f.task('Nat.goal'), []).get('Submission.lean')).not.toContain('def fixtureFrozen');
  });
});

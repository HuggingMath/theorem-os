import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { createTaskSourceProjector, projectedGoalInputs, taskChanges } from '../src/solver/cooperativeProof';
import { committedSource, commitSolverSources, git, readSolverProblem } from '../src/solver/problem';
import * as problemApi from '../src/solver/problem';
import { taskVersion, type CooperativeTask } from '../src/solver/tasks';
import { temporaryDirectory } from './helpers/files';
import { newestLeanBinary } from './helpers/lean';
import * as taskProjection from '../src/solver/taskProjection';

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
  expect(checked.status, `${checked.stdout}${checked.stderr}\n${source}`).toBe(0);
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

describe('task source change snapshots', () => {
  it.each(['sha1', 'sha256'] as const)('avoids source reads when both inputs are the same fixed %s commit', format => {
    const f = fixture('theorem goal : True := by trivial\n');
    const worktree = path.join(f.directory, format);
    fs.mkdirSync(worktree);
    git(worktree, ['init', '--quiet', `--object-format=${format}`]);
    const file = path.join(worktree, f.problem.projectRelative, 'Submission.lean');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(f.file, file);
    git(worktree, ['add', '--', '.']);
    git(worktree, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost',
      'commit', '--quiet', '--no-gpg-sign', '-m', 'Fixed source snapshot']);
    const commit = git(worktree, ['rev-parse', 'HEAD']);
    expect(commit).toHaveLength(format === 'sha1' ? 40 : 64);
    const read = vi.spyOn(problemApi, 'committedSource');
    try {
      expect(taskChanges(f.problem, worktree, commit, f.task('goal'), { seedCommit: commit })).toEqual([]);
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });

  it('keeps equal dynamic refs and abbreviated commits on the source-reading path', () => {
    const f = fixture('theorem goal : True := by trivial\n');
    const read = vi.spyOn(problemApi, 'committedSource');
    try {
      for (const commit of ['HEAD', f.commit.slice(0, 12), `${f.commit}^0`]) {
        read.mockClear();
        expect(taskChanges(f.problem, f.receipt.workspaceRoot, commit, f.task('goal'), { seedCommit: commit })).toEqual([]);
        expect(read).toHaveBeenCalledTimes(2 * f.problem.ownedFiles.length);
      }
    } finally { read.mockRestore(); }
  });
});

describe('source dependency observations', () => {
  it('reports the same hints without constructing a compact acceptance projection', () => {
    const source = ['namespace Fixture', 'theorem premise : True := by trivial',
      'def frozen : True := premise', 'theorem goal : True := by exact frozen', 'end Fixture', '',
    ].join('\n');
    const f = fixture(source), task = f.task('Fixture.goal');
    const compact = createTaskSourceProjector(f.problem, f.receipt.workspaceRoot, f.commit, { compact: true });
    const render = vi.spyOn(taskProjection, 'compactTaskSources');
    try {
      expect(compact.dependencyHints(task, [])).toEqual(f.project.dependencyHints(task, []));
      expect(compact.dependencyHints(task, []).map(hint => hint.root.name)).toEqual(['Fixture.premise']);
      expect(render).not.toHaveBeenCalled();
      const checked = compact(task, ['Fixture.premise']);
      expect(render).toHaveBeenCalledOnce();
      expect(checked.get('Submission.lean')).toContain('theorem goal');
    } finally { render.mockRestore(); }
  });

  it('keeps conditional type references and retained-input changes separate in one snapshot', () => {
    const source = ['namespace Fixture', 'theorem premise : True := by trivial',
      'def conditionType : Prop := by have _ : True := premise; exact True',
      'theorem goal : True := by trivial', 'end Fixture', '',
    ].join('\n');
    const solved = source.replace('theorem goal', 'theorem bridge : True := by exact missing\ntheorem goal');
    const f = fixture(source, solved);
    const task: CooperativeTask = { id: 'bridge', kind: 'lemma', objective: 'Connect the input.',
      proofPath: 'Submission.lean', theoremName: 'Fixture.bridge', type: 'True', dependsOn: ['missing'], revision: 0 };
    const condition: CooperativeTask = { id: 'missing', kind: 'lemma', objective: 'Prove the input.',
      proofPath: 'Submission.lean', theoremName: 'Fixture.missing', type: 'Fixture.conditionType', dependsOn: [], revision: 0 };
    expect(f.project.dependencyHints(task, [])).toEqual([]);
    expect(f.project.dependencyHints(task, [], [condition]).map(hint => hint.root.name)).toEqual(['Fixture.premise']);
    expect(f.project.dependencyHints(task, ['Fixture.premise'], [condition])).toEqual([]);
    expect(f.project.dependencyHints(task, [], [{ ...condition, type: 'True' }])).toEqual([]);
    expect(f.project.dependencyHints(task, [], [condition]).map(hint => hint.root.name)).toEqual(['Fixture.premise']);
  });
});

describe.skipIf(!newestLeanBinary())('anonymous instance dependency cleanup', () => {
  const source = [
    'namespace InstanceFixture',
    'class FirstWitness (n : Nat) : Prop where',
    '  proof : n = n',
    'class SecondWitness (n : Nat) : Prop where',
    '  proof : n = n',
    'class Independent where',
    '  marker : Nat',
    'theorem original (n : Nat) : n = n := by sorry',
    'def frozen (n : Nat) : n = n := original n',
    'abbrev chained (n : Nat) : n = n := frozen n',
    'instance (n : Nat) : FirstWitness n := ⟨chained n⟩',
    'instance : SecondWitness 0 := ⟨chained 0⟩',
    'instance : Independent := ⟨7⟩',
    'theorem goal : True := by sorry',
    'end InstanceFixture', '',
  ].join('\n');
  const solved = source.replace('original (n : Nat) : n = n := by sorry',
    'original (n : Nat) : n = n := by rfl').replace('goal : True := by sorry',
    'goal : True := by have _ : Independent := inferInstance; trivial');
  const expectCleaned = (projected: string) => {
    expect(projected).not.toContain('def frozen');
    expect(projected).not.toContain('abbrev chained');
    expect(projected).not.toContain('instance (n : Nat) : FirstWitness');
    expect(projected).not.toContain('instance : SecondWitness');
    expect(projected).toContain('instance : Independent := ⟨7⟩');
  };

  it('removes adjacent anonymous instances that use an excluded original through def and abbrev', () => {
    const f = fixture(source, solved);
    leanCheck(f, solved, 'InstanceFixture.goal');
    const projected = f.project(f.task('InstanceFixture.goal'), []).get('Submission.lean')!;
    leanCheck(f, projected, 'InstanceFixture.goal');
    expect(projected).not.toContain('theorem original');
    expectCleaned(projected);
  });

  it('removes anonymous instances after an original gains conditional parameters', () => {
    const conditional = solved.replace('theorem original',
      'theorem premise (n : Nat) : n = n := by rfl\ntheorem original')
      .replace('original (n : Nat) : n = n := by rfl',
        'original (n : Nat) : n = n := by exact premise n');
    const f = fixture(source, conditional), task = f.task('InstanceFixture.original');
    leanCheck(f, conditional, 'InstanceFixture.goal');
    const premise: CooperativeTask = { id: 'premise', kind: 'lemma', objective: 'Prove reflexivity.',
      proofPath: 'Submission.lean', theoremName: 'InstanceFixture.premise',
      type: '∀ n : Nat, n = n', dependsOn: [], revision: 0 };
    const projected = f.project(task, [], [premise]).get('Submission.lean')!;
    leanCheck(f, projected, 'InstanceFixture.original');
    expect(projected).toContain('theorem original (premise : ∀ n : Nat, n = n)');
    expect(projected).not.toContain('theorem premise');
    expectCleaned(projected);
  });

  it('preserves usable anonymous instances when their proved original is explicitly retained', () => {
    const f = fixture(source, solved);
    const projected = f.project(f.task('InstanceFixture.goal'), ['InstanceFixture.original']).get('Submission.lean')!;
    leanCheck(f, projected + [
      '\nexample (n : Nat) : InstanceFixture.FirstWitness n := inferInstance',
      'example : InstanceFixture.SecondWitness 0 := inferInstance', '',
    ].join('\n'), 'InstanceFixture.goal');
    for (const declaration of ['theorem original', 'def frozen', 'abbrev chained',
      'instance (n : Nat) : FirstWitness n', 'instance : SecondWitness 0', 'instance : Independent'])
      expect(projected).toContain(declaration);
  });

  it.each([
    ['where', 'instance (n : Nat) : FirstWitness n where\n  proof := chained n'],
    ['local with attributes', '/-- A dependent local instance. -/\n@[instance 1100]\nlocal instance (n : Nat) : FirstWitness n := ⟨chained n⟩'],
    ['scoped with priority', 'scoped instance (priority := 1100) (n : Nat) : FirstWitness n := ⟨chained n⟩'],
    ['named with commented priority', 'instance (/- priority choice -/ priority /- token gap -/ := 1100) dependent (n : Nat) : FirstWitness n where\n  proof := chained n\ndef dependentConsumer : FirstWitness 0 := dependent 0'],
  ])('removes a dependent %s instance without leaving command prefixes', (_kind, instance) => {
    const originalInstance = 'instance (n : Nat) : FirstWitness n := ⟨chained n⟩';
    const changed = solved.replace(originalInstance, instance);
    const f = fixture(source.replace(originalInstance, instance), changed);
    leanCheck(f, changed, 'InstanceFixture.goal');
    const projected = f.project(f.task('InstanceFixture.goal'), []).get('Submission.lean')!;
    leanCheck(f, projected, 'InstanceFixture.goal');
    expect(projected).not.toContain('FirstWitness n');
    expect(projected).not.toContain('chained');
    expect(projected).not.toContain('@[instance 1100]');
    expect(projected).toContain('instance : Independent := ⟨7⟩');
  });

  it('keeps anonymous instance parameters that shadow an excluded dependency', () => {
    const shadowed = source.replace('instance (n : Nat) : FirstWitness n := ⟨chained n⟩',
      'instance (chained : Nat) : FirstWitness chained := ⟨rfl⟩')
      .replace('instance : SecondWitness 0 := ⟨chained 0⟩',
        'instance [chained : Inhabited Nat] : SecondWitness 0 := ⟨rfl⟩');
    const changed = shadowed.replace('original (n : Nat) : n = n := by sorry',
      'original (n : Nat) : n = n := by rfl').replace('goal : True := by sorry',
      'goal : True := by have _ : Independent := inferInstance; trivial');
    const f = fixture(shadowed, changed);
    leanCheck(f, changed, 'InstanceFixture.goal');
    const projected = f.project(f.task('InstanceFixture.goal'), []).get('Submission.lean')!;
    leanCheck(f, projected, 'InstanceFixture.goal');
    expect(projected).not.toContain('abbrev chained');
    expect(projected).toContain('instance (chained : Nat)');
    expect(projected).toContain('instance [chained : Inhabited Nat]');
  });
});

describe('immutable source dependency hint caching', () => {
  const source = ['namespace Fixture',
    'theorem first : True := by sorry',
    'theorem second : True := by sorry',
    'def firstType : Prop := by have _ := first; exact True',
    'def secondType : Prop := by have _ := second; exact True',
    'theorem goal : True := by sorry', 'end Fixture', '',
  ].join('\n');
  const helper: CooperativeTask = { id: 'helper', kind: 'lemma', objective: 'Use the frozen context.',
    proofPath: 'Submission.lean', theoremName: 'Fixture.helper', type: 'True', dependsOn: [], revision: 0 };
  const conditionalFixture = () => fixture(source, source.replace('theorem goal',
    'theorem helper : True := by have := assumed; trivial\ntheorem goal'));
  const condition = (): CooperativeTask => ({ id: 'assumed', kind: 'lemma', objective: 'Prove the input.',
    proofPath: 'Submission.lean', theoremName: 'Fixture.assumed', type: 'Fixture.firstType', dependsOn: [], revision: 0 });

  it('returns stable source observations without letting a consumer corrupt later hint metadata', () => {
    const f = conditionalFixture(), input = condition();
    const initial = f.project.dependencyHints(helper, [], [input]);
    const expected = structuredClone(initial);
    expect(expected.map(hint => hint.root.name)).toEqual(['Fixture.first']);
    expect(f.project.dependencyHints(structuredClone(helper), [], [structuredClone(input)])).toEqual(expected);
    // A TaskProof or delivery consumer can alter its own nested metadata. Its
    // changes must not become the next check's source observation.
    const modified = initial as any;
    modified[0].root.name = 'Fixture.forged';
    modified[0].consumer.taskDigest = 'forged-version';
    modified[0].path[0].name = 'Fixture.other';
    modified.push(structuredClone(modified[0]));
    const next = f.project.dependencyHints(helper, [], [input]);
    expect(next).toEqual(expected);
    expect(next).not.toBe(initial);
    expect(next[0].root).not.toBe(initial[0].root);
    expect(next[0].proofAcceptance).toBe('not-assessed');
    expect(f.project(helper, ['Fixture.first'], [input]).get('Submission.lean')).toContain('def firstType');
  });

  it('recomputes the referenced original and consumer identity when the task contract changes', () => {
    const f = fixture(source, source.replace('theorem goal', 'theorem helper : True := by trivial\ntheorem goal'));
    const task = { ...helper, type: 'Fixture.firstType' };
    const before = f.project.dependencyHints(task, []);
    expect(before.map(hint => hint.root.name)).toEqual(['Fixture.first']);
    task.type = 'Fixture.secondType'; task.revision++;
    const after = f.project.dependencyHints(task, []);
    expect(after.map(hint => hint.root.name)).toEqual(['Fixture.second']);
    expect(after[0].consumer.taskDigest).toBe(taskVersion(task));
    expect(after[0].consumer.taskDigest).not.toBe(before[0].consumer.taskDigest);
    expect(after[0].id).not.toBe(before[0].id);
    expect(f.project.dependencyHints({ ...task, theoremName: 'Fixture.goal', kind: 'goal', type: undefined }, [])).toEqual([]);
  });

  it('keeps condition types and explicitly retained goals in each source query identity', () => {
    const f = conditionalFixture(), input = condition();
    const retained: string[] = [];
    expect(f.project.dependencyHints(helper, retained)).toEqual([]);
    expect(f.project.dependencyHints(helper, retained, [input]).map(hint => hint.root.name)).toEqual(['Fixture.first']);
    retained.push('Fixture.first');
    expect(f.project.dependencyHints(helper, retained, [input])).toEqual([]);
    input.type = 'Fixture.secondType'; input.revision++;
    expect(f.project.dependencyHints(helper, retained, [input]).map(hint => hint.root.name)).toEqual(['Fixture.second']);
    retained.push('Fixture.second');
    expect(f.project.dependencyHints(helper, retained, [input])).toEqual([]);
    retained.length = 0;
    expect(f.project.dependencyHints(helper, retained, [input]).map(hint => hint.root.name)).toEqual(['Fixture.second']);
    expect(f.project.dependencyHints(helper, retained, [condition()]).map(hint => hint.root.name)).toEqual(['Fixture.first']);
  });
});

describe('owned source projection through dot notation', () => {
  it.skipIf(!newestLeanBinary()).each([
    ['function application', '(f i)', false],
    ['nested application', '((fun n : Nat => f n) i)', false],
    ['type ascription', '(i : Nat)', false],
    ['same-named local parameter', '(f i)', true],
  ] as const)('removes compound receiver field consumers with a %s', (_kind, receiver, shadowed) => {
    const parameters = shadowed ? '(dependencyField : Nat) ' : '';
    const source = [
      'namespace Nat',
      'theorem fieldInput (n : Nat) : n = n := by sorry',
      'def dependencyField (n : Nat) : {m : Nat // m = n} := ⟨n, fieldInput n⟩',
      'end Nat',
      'namespace Packet',
      `def derived ${parameters}(f : Nat → Nat) (i : Nat) : Nat := ${receiver}.dependencyField.val`,
      `def downstream (f : Nat → Nat) (i : Nat) : Nat := derived ${shadowed ? '0 ' : ''}f i`,
      'theorem goal : True := by sorry',
      'end Packet', '',
    ].join('\n');
    const solved = source.replace('goal : True := by sorry', 'goal : True := by trivial');
    const f = fixture(source, solved);
    leanCheck(f, solved, 'Packet.goal');
    const projected = f.project(f.task('Packet.goal'), []).get('Submission.lean')!;
    expect(projected).not.toContain('theorem fieldInput');
    expect(projected).not.toContain('def dependencyField');
    expect(projected).not.toContain('def derived');
    expect(projected).not.toContain('def downstream');
    leanCheck(f, projected, 'Packet.goal');
  });

  it.skipIf(!newestLeanBinary())('finds the original input through a compound receiver field and keeps it only when retained', () => {
    const source = [
      'namespace Nat',
      'theorem fieldInput (n : Nat) : n = n := by sorry',
      'def dependencyField (n : Nat) : {m : Nat // m = n} := ⟨n, fieldInput n⟩',
      'end Nat',
      'namespace Packet',
      'def derived (f : Nat → Nat) (i : Nat) : Nat := (f i).dependencyField.val',
      'theorem goal (f : Nat → Nat) (i : Nat) : derived f i = f i := by sorry',
      'end Packet', '',
    ].join('\n');
    const f = fixture(source, source.replaceAll('by sorry', 'by rfl')), task = f.task('Packet.goal');
    expect(f.project.dependencyHints(task, []).map(hint => hint.path.map(item => item.name))).toEqual([
      ['Packet.goal', 'Packet.derived', 'Nat.dependencyField', 'Nat.fieldInput'],
    ]);
    expect(f.project(task, []).get('Submission.lean')).not.toContain('def derived');
    const retained = f.project(task, ['Nat.fieldInput']).get('Submission.lean')!;
    expect(retained).toContain('theorem fieldInput');
    expect(retained).toContain('def derived');
    leanCheck(f, retained, 'Packet.goal');
  });

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

  it.skipIf(!newestLeanBinary())('finds original inputs transitively across other original goals and frozen definitions', () => {
    const source = [
      'namespace Fixture',
      'theorem first (n : Nat) : n = n := by sorry',
      'theorem second (n : Nat) : n = n := by sorry',
      'def secondWitness (n : Nat) : {m : Nat // m = n} := ⟨n, second n⟩',
      'theorem headline (n : Nat) : (secondWitness n).val = n := by sorry',
      'end Fixture', '',
    ].join('\n');
    const solved = source.replace('second (n : Nat) : n = n := by sorry', 'second (n : Nat) : n = n := by exact first n')
      .replaceAll('by sorry', 'by rfl');
    const f = fixture(source, solved), task = f.task('Fixture.headline');
    const inputs = ['Fixture.first', 'Fixture.second'].map(name => ({ task: f.task(name), status: 'pending' as const, attempts: 0 }));
    const found = projectedGoalInputs(f.project, task, inputs);
    expect(found.map(node => node.task.theoremName)).toEqual(['Fixture.second', 'Fixture.first']);
    leanCheck(f, f.project(task, found.map(node => node.task.theoremName!)).get('Submission.lean')!, 'Fixture.headline');
    expect(f.project(task, []).get('Submission.lean')).not.toContain('theorem first');
  });

  it('bounds cyclic source discovery and never reports the consumer as its own input', () => {
    const source = ['namespace Fixture',
      'theorem first : True := by sorry', 'theorem second : True := by sorry',
      'theorem headline : True := by sorry', 'end Fixture', '',
    ].join('\n');
    const solved = source.replace('first : True := by sorry', 'first : True := by exact headline')
      .replace('second : True := by sorry', 'second : True := by exact first')
      .replace('headline : True := by sorry', 'headline : True := by exact second');
    const f = fixture(source, solved), task = f.task('Fixture.headline');
    const inputs = ['Fixture.first', 'Fixture.second', 'Fixture.headline'].map(name => ({ task: f.task(name), status: 'pending' as const, attempts: 0 }));
    expect(projectedGoalInputs(f.project, task, inputs).map(node => node.task.theoremName))
      .toEqual(['Fixture.second', 'Fixture.first']);
  });

  it.skipIf(!newestLeanBinary())('finds original context used only by an exact conditional input type', () => {
    const source = ['namespace Fixture', 'theorem premise : True := by sorry',
      'def conditionType : Prop := by have _ : True := premise; exact True',
      'theorem headline : True := by sorry', 'end Fixture', '',
    ].join('\n');
    const solved = source.replace('premise : True := by sorry', 'premise : True := by trivial')
      .replace('theorem headline', 'theorem bridge : True := by exact missing\ntheorem headline');
    const f = fixture(source, solved), input = { task: f.task('Fixture.premise'), status: 'pending' as const, attempts: 0 };
    const condition: CooperativeTask = { id: 'missing', kind: 'lemma', objective: 'Prove the condition.',
      proofPath: 'Submission.lean', theoremName: 'Fixture.missing', type: 'Fixture.conditionType', dependsOn: [], revision: 0 };
    const task: CooperativeTask = { id: 'bridge', kind: 'lemma', objective: 'Connect the condition.',
      proofPath: 'Submission.lean', theoremName: 'Fixture.bridge', type: 'True', dependsOn: ['missing'], revision: 0 };
    const inputs = projectedGoalInputs(f.project, task, [input], [condition]);
    expect(inputs).toEqual([input]);
    const projected = f.project(task, inputs.map(node => node.task.theoremName!), [condition]).get('Submission.lean')!;
    expect(projected).toContain('(missing : Fixture.conditionType)');
    expect(projected).toContain('def conditionType');
    leanCheck(f, projected, 'Fixture.bridge');
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

  it.each(['x', '(id x)'])('does not turn ambiguous receiver fields on %s into a unique dependency hint', receiver => {
    const source = [
      'structure Left where', '  value : Nat',
      'structure Right where', '  value : Nat',
      'namespace Left', 'theorem left_input (x : Left) : x = x := by sorry',
      'def field (x : Left) : x = x := left_input x', 'end Left',
      'namespace Right', 'theorem right_input (x : Right) : x = x := by sorry',
      'def field (x : Right) : x = x := right_input x', 'end Right',
      `def frozen (x : Right) : x = x := ${receiver}.field`,
      'theorem goal (x : Right) : x = x := by sorry', '',
    ].join('\n');
    const f = fixture(source, source.replace('goal (x : Right) : x = x := by sorry',
      `goal (x : Right) : x = x := by exact ${receiver}.field`));
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

describe.skipIf(!newestLeanBinary())('opened namespace dependency projection', () => {
  it.each(['Module.rep', 'A.Module.rep'])('preserves the independent dependency written as %s', reference => {
    const source = [
      'namespace A', 'namespace Module', 'def rep : Nat := 0', 'end Module', 'end A',
      'namespace B', 'theorem unrelated : (0 : Nat) = 0 := by rfl',
      'def rep : Nat := by have h := unrelated; exact 0', 'end B',
      'namespace C', 'open A', `def frozen : Nat := ${reference}`,
      'theorem goal : frozen = 0 := by rfl', 'end C', '',
    ].join('\n');
    const f = fixture(source), task = f.task('C.goal');
    leanCheck(f, source, 'C.goal');
    const projected = f.project(task, []).get('Submission.lean')!;
    expect(projected).toContain(`def frozen : Nat := ${reference}`);
    expect(projected).not.toContain('theorem unrelated');
    expect(projected).not.toContain('have h := unrelated');
    expect(f.project.dependencyHints(task, [])).toEqual([]);
    leanCheck(f, projected, 'C.goal');
  });

  it('recovers the unique original dependency through a relatively opened namespace', () => {
    const source = [
      'namespace Outer',
      'namespace A', 'namespace Module',
      'theorem input : (0 : Nat) = 0 := by rfl',
      'def rep : Nat := by have h := input; exact 0', 'end Module', 'end A',
      'namespace B', 'theorem unrelated : (0 : Nat) = 0 := by rfl',
      'def rep : Nat := by have h := unrelated; exact 0', 'end B',
      'namespace C', 'open A', 'def frozen : Nat := Module.rep',
      'theorem goal : frozen = 0 := by rfl', 'end C', 'end Outer', '',
    ].join('\n');
    const f = fixture(source), task = f.task('Outer.C.goal');
    leanCheck(f, source, 'Outer.C.goal');
    const excluded = f.project(task, []).get('Submission.lean')!;
    expect(excluded).not.toContain('theorem input');
    expect(excluded).not.toContain('def frozen');
    const hints = f.project.dependencyHints(task, []);
    expect(hints.map(hint => hint.root.name)).toEqual(['Outer.A.Module.input']);
    expect(hints[0]!.path.map(item => item.name)).toEqual([
      'Outer.C.goal', 'Outer.C.frozen', 'Outer.A.Module.rep', 'Outer.A.Module.input',
    ]);
    const retained = f.project(task, ['Outer.A.Module.input']).get('Submission.lean')!;
    expect(retained).toContain('theorem input');
    expect(retained).toContain('def frozen');
    expect(retained).not.toContain('theorem unrelated');
    expect(retained).not.toContain('have h := unrelated');
    leanCheck(f, retained, 'Outer.C.goal');
  });

  it.each(['namespace', 'section'])('does not leak an open after its %s ends', kind => {
    const source = [
      'namespace A', 'theorem input : (0 : Nat) = 0 := by rfl',
      'def rep : Nat := by have h := input; exact 0', 'end A',
      'def rep : Nat := 0', `${kind} Scoped`, 'open A',
      'def inside : Nat := A.rep', 'end Scoped',
      'def frozen : Nat := rep', 'theorem goal : frozen = 0 := by rfl', '',
    ].join('\n');
    const f = fixture(source), task = f.task('goal');
    leanCheck(f, source, 'goal');
    const projected = f.project(task, []).get('Submission.lean')!;
    expect(projected).not.toContain('theorem input');
    expect(projected).not.toContain('def inside');
    expect(projected).toContain('def frozen : Nat := rep');
    expect(f.project.dependencyHints(task, [])).toEqual([]);
    leanCheck(f, projected, 'goal');
  });

  it('prefers the enclosing namespace over a same-named opened dependency', () => {
    const source = [
      'namespace A', 'namespace Module',
      'theorem input : (0 : Nat) = 0 := by rfl',
      'def rep : Nat := by have h := input; exact 0', 'end Module', 'end A',
      'namespace C', 'namespace Module', 'def rep : Nat := 0', 'end Module',
      'open A', 'def frozen : Nat := Module.rep',
      'theorem goal : frozen = 0 := by rfl', 'end C', '',
    ].join('\n');
    const f = fixture(source), task = f.task('C.goal');
    leanCheck(f, source, 'C.goal');
    const projected = f.project(task, []).get('Submission.lean')!;
    expect(projected).not.toContain('theorem input');
    expect(projected).not.toContain('have h := input');
    expect(projected).toContain('def frozen : Nat := Module.rep');
    expect(f.project.dependencyHints(task, [])).toEqual([]);
    leanCheck(f, projected, 'C.goal');
  });

  it.each([
    ['selected', 'open A (rep)', 'rep'],
    ['renamed', 'open A renaming rep → chosen', 'chosen'],
  ])('recovers and rechecks a %s opened dependency', (_kind, command, reference) => {
    const source = [
      'namespace A', 'theorem input : (0 : Nat) = 0 := by rfl',
      'def rep : Nat := by have h := input; exact 0', 'end A',
      'namespace B', 'theorem unrelated : (0 : Nat) = 0 := by rfl',
      'def rep : Nat := by have h := unrelated; exact 0', 'end B',
      'namespace C', command, `def frozen : Nat := ${reference}`,
      'theorem goal : frozen = 0 := by rfl', 'end C', '',
    ].join('\n');
    const f = fixture(source), task = f.task('C.goal');
    leanCheck(f, source, 'C.goal');
    expect(f.project(task, []).get('Submission.lean')).not.toContain('def frozen');
    const hints = f.project.dependencyHints(task, []);
    expect(hints.map(hint => hint.root.name)).toEqual(['A.input']);
    expect(hints[0]!.path.map(item => item.name)).toEqual(['C.goal', 'C.frozen', 'A.rep', 'A.input']);
    const retained = f.project(task, ['A.input']).get('Submission.lean')!;
    expect(retained).toContain(`def frozen : Nat := ${reference}`);
    expect(retained).not.toContain('theorem unrelated');
    expect(retained).not.toContain('have h := unrelated');
    leanCheck(f, retained, 'C.goal');
  });

  it('keeps a root dependency independent of a hidden excluded declaration', () => {
    const source = [
      'namespace A', 'theorem input : (0 : Nat) = 0 := by rfl',
      'def rep : Nat := by have h := input; exact 0', 'end A',
      'def rep : Nat := 0', 'open A hiding rep',
      'def frozen : Nat := rep', 'theorem goal : frozen = 0 := by rfl', '',
    ].join('\n');
    const f = fixture(source), task = f.task('goal');
    leanCheck(f, source, 'goal');
    const projected = f.project(task, []).get('Submission.lean')!;
    expect(projected).not.toContain('theorem input');
    expect(projected).not.toContain('have h := input');
    expect(projected).toContain('def frozen : Nat := rep');
    expect(f.project.dependencyHints(task, [])).toEqual([]);
    leanCheck(f, projected, 'goal');
  });

  it('does not transfer a command-local open when its declaration is removed', () => {
    const source = [
      'namespace A', 'theorem input : (0 : Nat) = 0 := by rfl',
      'namespace Module', 'def rep : Nat := by have h := input; exact 0', 'end Module',
      'def rep : Nat := 1', 'end A',
      'def rep : Nat := 0', 'open A in', 'def localFrozen : Nat := Module.rep',
      'def frozen : Nat := rep', 'theorem goal : frozen = 0 := by rfl', '',
    ].join('\n');
    const f = fixture(source), task = f.task('goal');
    leanCheck(f, source, 'goal');
    const projected = f.project(task, []).get('Submission.lean')!;
    expect(projected).not.toContain('theorem input');
    expect(projected).not.toContain('def localFrozen');
    expect(projected).toContain('def frozen : Nat := rep');
    expect(f.project.dependencyHints(task, [])).toEqual([]);
    leanCheck(f, projected, 'goal');
  });

  it('does not carry a proof-local open into later declarations', () => {
    const source = [
      'namespace A', 'theorem input : (0 : Nat) = 0 := by rfl',
      'def rep : Nat := by have h := input; exact 0', 'end A',
      'def rep : Nat := 0', 'def localProof : True := by', '  exact',
      '    open A in', '      True.intro',
      'def frozen : Nat := rep', 'theorem goal : frozen = 0 := by rfl', '',
    ].join('\n');
    const f = fixture(source), task = f.task('goal');
    leanCheck(f, source, 'goal');
    const projected = f.project(task, []).get('Submission.lean')!;
    expect(projected).not.toContain('theorem input');
    expect(projected).not.toContain('have h := input');
    expect(projected).toContain('def localProof : True := by');
    expect(projected).toContain('def frozen : Nat := rep');
    expect(f.project.dependencyHints(task, [])).toEqual([]);
    leanCheck(f, projected, 'goal');
  });
});

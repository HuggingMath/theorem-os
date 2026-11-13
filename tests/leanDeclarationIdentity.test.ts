import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { inspectLeanDeclarationRegions, inspectScopedLeanDeclarations } from '../src/math/leanSource';
import { applyTaskChanges, createTaskSourceProjector, declarationStartWithDoc, omitTaskHelpers, taskChanges } from '../src/solver/cooperativeProof';
import { assertSolverSources, commitSolverSources, readSolverProblem, type SolverProblem } from '../src/solver/problem';
import { frozenSourceContext } from '../src/solver/contextCompiler';
import { captureProofReferences, proofReferencesUnchanged } from '../src/solver/proofReferences';
import type { CooperativeTask } from '../src/solver/tasks';
import { temporaryDirectory } from './helpers/files';
import { conditionalPayloads } from './helpers/conditionalProjection';

describe('punctuation in cooperative declaration identities', () => {
  let directory: string, workspace: string, file: string, problem: SolverProblem;
  const original = 'namespace Submission\ntheorem goal : True := by sorry\nend Submission\n';
  const helper = (name: string): CooperativeTask => ({ id: 'helper', kind: 'lemma', revision: 0,
    objective: 'Prove the helper', proofPath: 'Submission.lean', theoremName: `Submission.${name}`,
    type: 'True', dependsOn: [] });
  const save = (declarations: string) => {
    const source = original.replace('theorem goal', declarations + 'theorem goal');
    fs.writeFileSync(file, source);
    return { source, commit: commitSolverSources(problem, workspace) };
  };

  beforeEach(() => {
    directory = temporaryDirectory('lean-declaration-identity-');
    workspace = path.join(directory, 'workspace');
    const receipt = bootstrapLeanTask(workspace, { source: original, task: 'Prove the goal.' });
    problem = readSolverProblem(workspace, receipt.activeProblemPath);
    file = path.join(receipt.projectRoot, 'Submission.lean');
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('projects each distinct helper and replays the changes without name collisions', () => {
    const names = ['probe?', 'probe', 'probe!'];
    const { source, commit } = save(names.map(name => `lemma ${name} : True := by trivial\n`).join(''));
    const changes = taskChanges(problem, workspace, commit, helper('probe?'), { seedCommit: problem.baseCommit });
    expect(changes.map(change => change.name)).toEqual(names);
    const project = createTaskSourceProjector(problem, workspace, commit);
    for (const name of names) {
      const projected = project(helper(name), []).get('Submission.lean')!;
      expect(inspectLeanDeclarationRegions(projected).map(item => item.name)).toEqual(names);
    }
    fs.writeFileSync(file, original);
    applyTaskChanges(problem, workspace, changes);
    expect(fs.readFileSync(file, 'utf8')).toBe(source);
  });

  it('still rejects genuine duplicate names when collecting changes or projecting a target', () => {
    const { commit } = save('lemma probe? : True := by trivial\nlemma probe? : True := by trivial\n');
    expect(() => taskChanges(problem, workspace, commit, helper('probe?'), { seedCommit: problem.baseCommit }))
      .toThrow('math_task_ambiguous_declaration');
    expect(() => createTaskSourceProjector(problem, workspace, commit)(helper('probe?'), []))
      .toThrow('math_task_ambiguous_declaration');
  });

  it.each(['?', '!'])('abstracts %s inputs and removes their wrapper chains without touching the plain name', suffix => {
    const input = `premise${suffix}`;
    const { source, commit } = save(`lemma ${input} : True := by trivial\n` +
      `lemma wrapper : True := ${input}\nlemma wrapper_chain : True := wrapper\n` +
      'lemma premise : True := by trivial\nlemma independent : True := premise\n' +
      `lemma consumer : True := Submission.${input}\n`);
    const projected = createTaskSourceProjector(problem, workspace, commit)(
      { ...helper('consumer'), dependsOn: ['input'], conditional: true }, [], [{ ...helper(input), id: 'input' }])
      .get('Submission.lean')!;
    expect(conditionalPayloads(projected)).toEqual([{ declaration: `lemma consumer : True := _root_.Submission.${input}\n`,
      dependencies: [{ theoremName: `Submission.${input}`, type: 'True' }] }]);
    expect(inspectScopedLeanDeclarations(projected).filter(item => item.namespace === 'Submission').map(item => item.name))
      .toEqual(['premise', 'independent', 'consumer']);
    expect(fs.readFileSync(file, 'utf8')).toBe(source);
  });

  it.each([['declared', 'lemma premise : True := by trivial\n'], ['undeclared', '']])(
    'removes wrapper chains of a %s input and of the parameterized consumer under an open command', (_, input) => {
      // 2026-10-29 TriangularCovering: the challenge's `open Set` disabled this cleanup, so stale wrappers broke
      // every conditional check of A_min_eq_H.
      const opened = original.replace('namespace Submission\n', 'namespace Submission\nopen Classical\n');
      const root = path.join(directory, 'opened');
      const receipt = bootstrapLeanTask(root, { source: opened, task: 'Prove the goal.' });
      const openedProblem = readSolverProblem(root, receipt.activeProblemPath);
      fs.writeFileSync(path.join(receipt.projectRoot, 'Submission.lean'), opened.replace('theorem goal',
        `${input}lemma uses_premise : True := premise\nlemma consumer : True := premise\n` +
        'lemma uses_consumer : True := by exact consumer\nlemma uses_chain : True := uses_consumer\n' +
        'lemma independent : True := trivial\ntheorem goal'));
      const commit = commitSolverSources(openedProblem, root);
      const projected = createTaskSourceProjector(openedProblem, root, commit)(
        { ...helper('consumer'), dependsOn: ['input'], conditional: true }, [], [{ ...helper('premise'), id: 'input' }])
        .get('Submission.lean')!;
      expect(conditionalPayloads(projected)).toEqual([{ declaration: 'lemma consumer : True := _root_.Submission.premise\n',
        dependencies: [{ theoremName: 'Submission.premise', type: 'True' }] }]);
      expect(inspectScopedLeanDeclarations(projected).filter(item => item.namespace === 'Submission').map(item => item.name))
        .toEqual(['consumer', 'independent']);
    });

  it.each(['?', '!'])('retains a %s helper wrapper when only the plain-name peer is unfinished', suffix => {
    const { commit } = save('lemma premise : True := by sorry\n' +
      `lemma premise${suffix} : True := by trivial\nlemma wrapper : True := premise${suffix}\n` +
      'lemma consumer : True := wrapper\n');
    const projected = createTaskSourceProjector(problem, workspace, commit)(helper('consumer'), []).get('Submission.lean')!;
    expect(inspectLeanDeclarationRegions(projected).map(item => item.name)).toEqual([`premise${suffix}`, 'wrapper', 'consumer']);
  });

  it.each(['?', '!'])('orders a conditional consumer after its exact %s input during integration', suffix => {
    const input = `premise${suffix}`;
    const before = 'theorem goal : True := by sorry\n', after = `theorem goal : True := ${input}\n`;
    fs.writeFileSync(file, original.replace('end Submission', `lemma ${input} : True := by trivial\nend Submission`));
    applyTaskChanges(problem, workspace, [{ file: 'Submission.lean', name: 'goal', before, after }], [], [helper(input)]);
    const integrated = fs.readFileSync(file, 'utf8');
    expect(inspectLeanDeclarationRegions(integrated).map(item => item.name)).toEqual([input, 'goal']);
    expect(integrated).toContain(after);
  });

  it.each(['?', '!'])('fingerprints the exact %s dependency when deciding whether evidence is reusable', suffix => {
    const input = `premise${suffix}`;
    const { source, commit } = save('lemma premise : True := by trivial\n' +
      `lemma ${input} : True := by trivial\nlemma consumer : True := ${input}\n`);
    // These references stand in for Lean-selected evidence; source text only fingerprints their declarations.
    const references = captureProofReferences(problem, workspace, commit, { file: 'Submission.lean', name: 'Submission.consumer' },
      { statement: [], proof: [{ file: 'Submission.lean', name: `Submission.${input}` }] }, 'environment')!;
    expect(references.inputs.map(item => item.name).sort()).toEqual(['consumer', input].sort());
    fs.writeFileSync(file, source.replace('lemma premise : True := by trivial', 'lemma premise : True := by exact True.intro'));
    expect(proofReferencesUnchanged(problem, workspace, commitSolverSources(problem, workspace), references, 'environment')).toBe(true);
    fs.writeFileSync(file, source.replace(`lemma ${input} : True := by trivial`, `lemma ${input} : True := by exact True.intro`));
    expect(proofReferencesUnchanged(problem, workspace, commitSolverSources(problem, workspace), references, 'environment')).toBe(false);
  });
});

describe('attribute and in-command prefixes of cooperative declarations', () => {
  let directory: string, workspace: string, file: string, problem: SolverProblem;
  const original = 'namespace Submission\nvariable {p : Prop} [Decidable p]\n' +
    'theorem goal : True := by sorry\nomit [Decidable p] in\ntheorem side : True := by sorry\nend Submission\n';
  const helper = (name: string): CooperativeTask => ({ id: name, kind: 'lemma', revision: 0,
    objective: 'Prove the helper', proofPath: 'Submission.lean', theoremName: `Submission.${name}`,
    type: 'True', dependsOn: [] });

  beforeEach(() => {
    directory = temporaryDirectory('lean-declaration-prefix-');
    workspace = path.join(directory, 'workspace');
    const receipt = bootstrapLeanTask(workspace, { source: original, task: 'Prove the goals.' });
    problem = readSolverProblem(workspace, receipt.activeProblemPath);
    file = path.join(receipt.projectRoot, 'Submission.lean');
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('replays a helper inserted before a prefixed declaration without taking its prefix', () => {
    const source = original.replace('omit [Decidable p] in', 'lemma probe : True := by trivial\nomit [Decidable p] in');
    fs.writeFileSync(file, source);
    const commit = commitSolverSources(problem, workspace);
    const changes = taskChanges(problem, workspace, commit, helper('probe'), { seedCommit: problem.baseCommit });
    expect(changes).toMatchObject([{ name: 'probe', beforeName: 'side' }]);
    fs.writeFileSync(file, original);
    applyTaskChanges(problem, workspace, changes);
    expect(fs.readFileSync(file, 'utf8')).toBe(source);
  });

  it('hides a helper together with its attribute and in-command lines', () => {
    const hidden = 'omit [Decidable p] in\n@[simp]\nlemma hidden : True := by trivial\n';
    const source = original.replace('end Submission', `${hidden}end Submission`);
    expect(omitTaskHelpers(problem, 'Submission.lean', source, ['Submission.hidden'])).toBe(original);
  });

  it('moves a conditional consumer past a prefixed declaration without stranding its prefix', () => {
    fs.writeFileSync(file, original.replace('theorem goal', 'lemma consumer : True := by sorry\ntheorem goal')
      .replace('end Submission', 'lemma premise : True := by trivial\nend Submission'));
    applyTaskChanges(problem, workspace, [{ file: 'Submission.lean', name: 'consumer',
      before: 'lemma consumer : True := by sorry\n', after: 'lemma consumer : True := premise\n' }], [], [helper('premise')]);
    expect(fs.readFileSync(file, 'utf8')).toBe(original.replace('end Submission',
      'lemma premise : True := by trivial\nlemma consumer : True := premise\nend Submission'));
  });

  it('stops at the previous declaration and at commands that do not bind the next one', () => {
    const source = 'theorem a : True := by\n  open Nat in\n  trivial\n' +
      '/-- Documented. -/\n@[simp, norm_cast]\ntheorem b : True := trivial\n' +
      'omit [Decidable p]\n  [DecidableEq Nat] in\n-- Lean comments do not end the command.\ntheorem c : True := trivial\n' +
      'open Nat\ntheorem d : True := trivial\n';
    const start = (name: string) => declarationStartWithDoc(source, source.indexOf(`theorem ${name}`));
    expect(start('a')).toBe(0);
    expect(start('b')).toBe(source.indexOf('/-- Documented.'));
    expect(start('c')).toBe(source.indexOf('omit'));
    expect(start('d')).toBe(source.indexOf('theorem d'));
    expect(declarationStartWithDoc(source, source.indexOf('theorem c'), source.indexOf('[DecidableEq')))
      .toBe(source.indexOf('theorem c'));
  });
});

describe('statements that repeat a final name component', () => {
  // 2026-10-30: 52 of 416 OpenAI challenge statements repeat names such as `Literal.eval`/`Clause.eval`
  // or `A.step`/`B.step`; preparation rejected all of them.
  let directory: string, workspace: string, file: string, problem: SolverProblem;
  const original = 'namespace Submission\n' +
    'namespace A\nstructure State where\n  n : Nat\ndef step (s : State) : Nat := s.n + 1\ndef Literal.eval : Nat := 0\nend A\n' +
    'namespace B\nstructure State where\n  n : Nat\ndef step (s : State) : Nat := s.n + 2\ndef Clause.eval : Nat := 0\n' +
    'def size : Nat := 3\nend B\n' +
    'theorem goal : B.step ⟨0⟩ = 2 := by sorry\nend Submission\n';
  const solved = original.replace('= 2 := by sorry', '= 2 := rfl');
  const goal: CooperativeTask = { id: 'goal', kind: 'goal', objective: 'Prove the goal', dependsOn: [], revision: 0,
    proofPath: 'Submission.lean', theoremName: 'Submission.goal' };
  const helper = (name: string): CooperativeTask => ({ id: 'helper', kind: 'lemma', revision: 0, objective: 'Prove the helper',
    proofPath: 'Submission.lean', theoremName: `Submission.B.${name}`, type: 'True', dependsOn: [] });
  const save = (source: string) => { fs.writeFileSync(file, source); return commitSolverSources(problem, workspace); };

  beforeEach(() => {
    directory = temporaryDirectory('lean-repeated-names-');
    workspace = path.join(directory, 'workspace');
    const receipt = bootstrapLeanTask(workspace, { source: original, task: 'Prove the goal.' });
    problem = readSolverProblem(workspace, receipt.activeProblemPath);
    file = path.join(receipt.projectRoot, 'Submission.lean');
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('freezes each repeated written name by its qualified name', () => {
    expect(problem.declarations['Submission.lean']!.map(item => item.qualifiedName ?? item.name))
      .toEqual(['Submission.A.step', 'Literal.eval', 'Submission.B.step', 'Clause.eval', 'size', 'goal']);
    expect(() => assertSolverSources(problem, workspace)).not.toThrow();
    save(solved);
    expect(frozenSourceContext(problem, 'Submission.lean', solved)).toContain('s.n + 2');
    fs.writeFileSync(file, solved.replace('s.n + 2', 's.n + 3'));
    expect(() => assertSolverSources(problem, workspace)).toThrow('math_original_declaration_changed');
    expect(() => frozenSourceContext(problem, 'Submission.lean', solved.replace('s.n + 2', 's.n + 3')))
      .toThrow('math_context_stale_required');
  });

  it('projects, collects and replays a goal proof and a helper beside repeated names', () => {
    const source = solved.replace('def size', 'lemma helper : True := trivial\ndef size');
    const commit = save(source);
    const projected = createTaskSourceProjector(problem, workspace, commit)(goal, []).get('Submission.lean')!;
    expect(projected).toBe(source);
    const compact = createTaskSourceProjector(problem, workspace, commit, { compact: true })(goal, []).get('Submission.lean')!;
    expect(compact).toContain('s.n + 1');
    expect(compact).toContain('s.n + 2');
    const changes = taskChanges(problem, workspace, commit, goal, { seedCommit: problem.baseCommit });
    expect(changes).toMatchObject([{ name: 'goal' }, { name: 'helper', beforeName: 'size' }]);
    fs.writeFileSync(file, original);
    applyTaskChanges(problem, workspace, changes);
    expect(fs.readFileSync(file, 'utf8')).toBe(source);
  });

  it('replays a move past a repeated declaration by its qualified identity', () => {
    const seeded = original.replace('end A', 'lemma probe : True := trivial\nend A');
    const seedCommit = save(seeded);
    const source = seeded.replace('lemma probe : True := trivial\n', '')
      .replace('def step (s : State) : Nat := s.n + 1', 'lemma probe : True := trivial\ndef step (s : State) : Nat := s.n + 1');
    const commit = save(source);
    const changes = taskChanges(problem, workspace, commit, undefined, { seedCommit });
    expect(changes).toContainEqual(expect.objectContaining({ name: 'Submission.A.step', afterName: 'probe' }));
    fs.writeFileSync(file, seeded);
    applyTaskChanges(problem, workspace, changes);
    expect(fs.readFileSync(file, 'utf8')).toBe(source);
  });

  it.each([
    ['a third copy of a repeated name', 'lemma C.step : True := trivial\n'],
    ['a new repeat of a unique name', 'lemma Other.size : True := trivial\n'],
  ])('rejects %s', (_, declaration) => {
    const commit = save(solved.replace('def size', `${declaration}def size`));
    expect(() => taskChanges(problem, workspace, commit, helper('step'), { seedCommit: problem.baseCommit }))
      .toThrow('math_task_ambiguous_declaration');
  });

  it.each([
    ['a repeated target name', 'namespace A\ntheorem goal : True := by sorry\nend A\ntheorem goal : True := by sorry\n',
      'lean_task_target_name_ambiguous: A.goal'],
    ['a repeated qualified name', 'def A.x : Nat := 0\nnamespace A\ndef x : Nat := 1\nend A\ntheorem goal : True := by sorry\n',
      'lean_task_declaration_names_ambiguous'],
  ])('refuses to prepare %s', (_, source, code) => {
    expect(() => bootstrapLeanTask(path.join(directory, 'refused'), { source, task: 'Prove it.' })).toThrow(code);
  });
});

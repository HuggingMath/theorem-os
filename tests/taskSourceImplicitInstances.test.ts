import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { hashMathFormalSourceDeclaration } from '../src/math/leanSource';
import { createTaskSourceProjector } from '../src/solver/cooperativeProof';
import { commitSolverSources, readSolverProblem } from '../src/solver/problem';
import type { CooperativeTask } from '../src/solver/tasks';
import { temporaryDirectory } from './helpers/files';
import { newestLeanBinary } from './helpers/lean';

const lean = newestLeanBinary();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

type Scenario = 'independent' | 'requires-instance' | 'alternative-provider';
const examples = [
  {
    name: 'a direct inferred instance',
    source(scenario: Scenario) {
      return [
        'set_option autoImplicit false',
        'namespace ImplicitFixture',
        'class First : Prop where',
        '  proof : True',
        'class Second : Prop where',
        '  proof : True',
        'theorem original : True := by sorry',
        'instance originalFirst : First := ⟨original⟩',
        ...(scenario === 'alternative-provider' ? ['instance independentFirst : First := ⟨True.intro⟩'] : []),
        'instance implicitSecond : Second := ⟨(inferInstance : First).proof⟩',
        `theorem goal : ${scenario === 'independent' ? 'True' : 'Second'} := by sorry`,
        'end ImplicitFixture', '',
      ].join('\n');
    },
    solve(source: string, scenario: Scenario) {
      return source.replace('original : True := by sorry', 'original : True := by trivial')
        .replace(/(theorem goal[^\n]*:=) by sorry/u, `$1 by ${scenario === 'independent' ? 'trivial' : 'infer_instance'}`);
    },
  },
  {
    name: 'a parameterized law unfolded before instance synthesis',
    source(scenario: Scenario) {
      return [
        'set_option autoImplicit false',
        'namespace ImplicitFixture',
        'structure BoxLaw (α : Type) where',
        '  value : α',
        'class FirstProbability {α : Type} (law : BoxLaw α) : Prop where',
        '  proof : True',
        'class CountableProbability {α : Type} (laws : Nat → BoxLaw α) : Prop where',
        '  proof : True',
        'theorem original (α : Type) (x : α) : True := by sorry',
        'def firstLaw {α : Type} (x : α) : BoxLaw α := ⟨x⟩',
        'instance originalFirst {α : Type} (x : α) : FirstProbability (firstLaw x) := ⟨original α x⟩',
        ...(scenario === 'alternative-provider' ? [
          'instance independentFirst {α : Type} (x : α) : FirstProbability (firstLaw x) := ⟨True.intro⟩',
        ] : []),
        'instance pointwiseProbability {α : Type} (laws : Nat → BoxLaw α)',
        '    [∀ i, FirstProbability (laws i)] : CountableProbability laws := ⟨True.intro⟩',
        'def countableLaw {α : Type} (x : Nat → α) : Nat → BoxLaw α := fun i => firstLaw (x i)',
        'instance implicitCountable {α : Type} (x : Nat → α) : CountableProbability (countableLaw x) := by',
        '  unfold countableLaw',
        '  infer_instance',
        `theorem goal : ${scenario === 'independent' ? 'True' : 'CountableProbability (countableLaw (fun n : Nat => n))'} := by sorry`,
        'end ImplicitFixture', '',
      ].join('\n');
    },
    solve(source: string, scenario: Scenario) {
      return source.replace('original (α : Type) (x : α) : True := by sorry',
        'original (α : Type) (x : α) : True := by trivial')
        .replace(/(theorem goal[^\n]*:=) by sorry/u, `$1 by ${scenario === 'independent' ? 'trivial' : 'infer_instance'}`);
    },
  },
  {
    name: 'one probability class for input and constructed laws',
    source(scenario: Scenario) {
      return [
        'set_option autoImplicit false',
        'namespace ImplicitFixture',
        'structure BoxLaw (α : Type) where',
        '  value : α',
        '  marker : Nat',
        'class Probability {α : Type} (law : BoxLaw α) : Prop where',
        '  proof : True',
        'theorem original (α : Type) (law : BoxLaw α) : True := by sorry',
        'def firstLaw {α : Type} (law : BoxLaw α) : BoxLaw α := ⟨law.value, law.marker + 1⟩',
        'instance originalFirst {α : Type} (law : BoxLaw α) [Probability law] :',
        '    Probability (firstLaw law) := ⟨original α law⟩',
        ...(scenario === 'alternative-provider' ? [
          'instance independentFirst {α : Type} (law : BoxLaw α) [Probability law] :',
          '    Probability (firstLaw law) := ⟨True.intro⟩',
        ] : []),
        'def pointwiseLaw {α : Type} (laws : Nat → BoxLaw α) : BoxLaw (Nat → α) :=',
        '  ⟨fun i => (laws i).value, 0⟩',
        'instance pointwiseProbability {α : Type} (laws : Nat → BoxLaw α)',
        '    [∀ i, Probability (laws i)] : Probability (pointwiseLaw laws) := ⟨True.intro⟩',
        'def countableLaw {α : Type} (laws : Nat → BoxLaw α) : BoxLaw (Nat → α) :=',
        '  pointwiseLaw fun i => firstLaw (laws i)',
        'instance implicitCountable {α : Type} (laws : Nat → BoxLaw α) [∀ i, Probability (laws i)] :',
        '    Probability (countableLaw laws) := by',
        '  unfold countableLaw',
        '  infer_instance',
        'def inputLaw : BoxLaw Nat := ⟨0, 0⟩',
        'instance inputProbability : Probability inputLaw := ⟨True.intro⟩',
        `theorem goal : ${scenario === 'independent' ? 'True' : 'Probability (countableLaw (fun _ : Nat => inputLaw))'} := by sorry`,
        'end ImplicitFixture', '',
      ].join('\n');
    },
    solve(source: string, scenario: Scenario) {
      return source.replace('original (α : Type) (law : BoxLaw α) : True := by sorry',
        'original (α : Type) (law : BoxLaw α) : True := by trivial')
        .replace(/(theorem goal[^\n]*:=) by sorry/u, `$1 by ${scenario === 'independent' ? 'trivial' : 'infer_instance'}`);
    },
  },
];

function fixture(example: typeof examples[number], scenario: Scenario) {
  const source = example.source(scenario);
  return sourceFixture(source, example.solve(source, scenario));
}

function sourceFixture(source: string, solved: string) {
  const directory = temporaryDirectory('task-source-implicit-instances-'); roots.push(directory);
  const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), { source, task: 'Prove the frozen original targets.' });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  fs.writeFileSync(path.join(receipt.projectRoot, 'Submission.lean'), solved);
  const commit = commitSolverSources(problem, receipt.workspaceRoot);
  const task: CooperativeTask = { id: 'goal', kind: 'goal', objective: 'Prove the original goal.',
    proofPath: 'Submission.lean', theoremName: 'ImplicitFixture.goal', dependsOn: [], revision: 0 };
  const target = problem.targets.find(target => target.theoremName === task.theoremName)!;
  const project = createTaskSourceProjector(problem, receipt.workspaceRoot, commit);
  return { directory, solved, task, target,
    projection: (retained: readonly string[] = []) => project(task, retained).get('Submission.lean')! };
}

function compile(f: ReturnType<typeof fixture>, source: string) {
  expect(f.target.declarationHash).toEqual(expect.any(String));
  expect(hashMathFormalSourceDeclaration(source, f.task.theoremName!)).toBe(f.target.declarationHash);
  const file = path.join(f.directory, 'Projection.lean');
  fs.writeFileSync(file, source + `\n#print axioms ${f.task.theoremName}\n`);
  const checked = spawnSync(lean!, [file], { encoding: 'utf8', timeout: 20_000 });
  expect(checked.error).toBeUndefined();
  return { status: checked.status, diagnostics: `${checked.stdout}${checked.stderr}`, source };
}

function expectAccepted(checked: ReturnType<typeof compile>) {
  expect(checked.status, `${checked.diagnostics}\n${checked.source}`).toBe(0);
  expect(checked.diagnostics).not.toContain('sorryAx');
}

describe.skipIf(!lean)('implicit instance dependencies in task source projections', () => {
  for (const example of examples) describe(example.name, () => {
    it('checks an unrelated original goal after excluding another original from the instance context', () => {
      const f = fixture(example, 'independent');
      expectAccepted(compile(f, f.solved));
      expectAccepted(compile(f, f.projection()));
    });

    it('does not accept a goal requiring an instance whose original input was excluded', () => {
      const f = fixture(example, 'requires-instance');
      expectAccepted(compile(f, f.solved));
      const checked = compile(f, f.projection());
      expect(checked.status, checked.diagnostics).not.toBe(0);
      expect(checked.diagnostics).toMatch(/failed to synthesize|synthInstanceFailed/u);
    });

    it('checks a required instance chain when its original input is explicitly retained', () => {
      const f = fixture(example, 'requires-instance');
      expectAccepted(compile(f, f.solved));
      expectAccepted(compile(f, f.projection(['ImplicitFixture.original'])));
    });

    it('keeps a required instance chain usable through an independent alternative provider', () => {
      const f = fixture(example, 'alternative-provider');
      expectAccepted(compile(f, f.solved));
      expectAccepted(compile(f, f.projection()));
    });
  });

  describe('independent instance providers', () => {
    it('uses a provider supplied by the wrapper instance header', () => {
      const source = [
        'set_option autoImplicit false',
        'namespace ImplicitFixture',
        'class First : Prop where',
        '  proof : True',
        'class Second : Prop where',
        '  proof : True',
        'theorem original : True := by sorry',
        'instance originalFirst : First := ⟨original⟩',
        'instance suppliedSecond [First] : Second := ⟨(inferInstance : First).proof⟩',
        'theorem goal : Second := by sorry',
        'end ImplicitFixture', '',
      ].join('\n');
      const solved = source.replace('original : True := by sorry', 'original : True := by trivial')
        .replace('goal : Second := by sorry', 'goal : Second := by\n  letI : First := ⟨True.intro⟩\n  infer_instance');
      const f = sourceFixture(source, solved);
      expectAccepted(compile(f, f.solved));
      expectAccepted(compile(f, f.projection()));
    });

    it.each(['haveI', 'letI'] as const)('uses a provider established inside the wrapper proof with %s', localInstance => {
      const source = [
        'set_option autoImplicit false',
        'namespace ImplicitFixture',
        'class First : Prop where',
        '  proof : True',
        'class Second : Prop where',
        '  proof : True',
        'theorem original : True := by sorry',
        'instance originalFirst : First := ⟨original⟩',
        'instance independentSecond : Second := by',
        `  ${localInstance} : First := ⟨True.intro⟩`,
        '  exact ⟨(inferInstance : First).proof⟩',
        'theorem goal : Second := by sorry',
        'end ImplicitFixture', '',
      ].join('\n');
      const solved = source.replace('original : True := by sorry', 'original : True := by trivial')
        .replace('goal : Second := by sorry', 'goal : Second := by infer_instance');
      const f = sourceFixture(source, solved);
      expectAccepted(compile(f, f.solved));
      expectAccepted(compile(f, f.projection()));
    });

    it('uses an independent provider for another subject of the same class', () => {
      const source = [
        'set_option autoImplicit false',
        'namespace ImplicitFixture',
        'class First (n : Nat) : Prop where',
        '  proof : True',
        'class Second (n : Nat) : Prop where',
        '  proof : True',
        'def excludedSubject : Nat := 0',
        'def independentSubject : Nat := 1',
        'theorem original : True := by sorry',
        'instance originalFirst : First excludedSubject := ⟨original⟩',
        'instance independentFirst : First independentSubject := ⟨True.intro⟩',
        'instance independentSecond : Second independentSubject := ⟨(inferInstance : First independentSubject).proof⟩',
        'theorem goal : Second independentSubject := by sorry',
        'end ImplicitFixture', '',
      ].join('\n');
      const solved = source.replace('original : True := by sorry', 'original : True := by trivial')
        .replace('goal : Second independentSubject := by sorry', 'goal : Second independentSubject := by infer_instance');
      const f = sourceFixture(source, solved);
      expectAccepted(compile(f, f.solved));
      expectAccepted(compile(f, f.projection()));
    });

    it('keeps providers for different qualified classes with the same final name separate', () => {
      const source = [
        'set_option autoImplicit false',
        'namespace LeftFixture',
        'class First : Prop where',
        '  proof : True',
        'end LeftFixture',
        'namespace RightFixture',
        'class First : Prop where',
        '  proof : True',
        'end RightFixture',
        'namespace ImplicitFixture',
        'class Second : Prop where',
        '  proof : True',
        'theorem original : True := by sorry',
        'instance originalFirst : LeftFixture.First := ⟨original⟩',
        'instance independentFirst : RightFixture.First := ⟨True.intro⟩',
        'instance independentSecond : Second := ⟨(inferInstance : RightFixture.First).proof⟩',
        'theorem goal : Second := by sorry',
        'end ImplicitFixture', '',
      ].join('\n');
      const solved = source.replace('original : True := by sorry', 'original : True := by trivial')
        .replace('goal : Second := by sorry', 'goal : Second := by infer_instance');
      const f = sourceFixture(source, solved);
      expectAccepted(compile(f, f.solved));
      expectAccepted(compile(f, f.projection()));
    });
  });
});

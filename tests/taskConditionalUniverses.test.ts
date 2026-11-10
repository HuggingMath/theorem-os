import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { checkTaskProof, createTaskSourceProjector } from '../src/solver/cooperativeProof';
import { committedSource, commitSolverSources, readSolverProblem } from '../src/solver/problem';
import { taskVersion, type CooperativeTask, type TaskAssignment } from '../src/solver/tasks';
import { temporaryDirectory } from './helpers/files';
import { newestLeanBinary } from './helpers/lean';

const roots: string[] = [], lean = newestLeanBinary();
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const condition: CooperativeTask = { id: 'dep', kind: 'lemma', objective: 'Prove the polymorphic dependency.',
  proofPath: 'Submission.lean', theoremName: 'ConditionalUniverses.dep',
  type: '∀ {α : Type _} (x : α), x = x', dependsOn: [], revision: 0 };

function fixture(declaration: string, type: string, dependencies = [condition]) {
  const directory = temporaryDirectory('task-conditional-universes-'); roots.push(directory);
  const original = 'universe u v\nnamespace ConditionalUniverses\ntheorem goal : True := by sorry\nend ConditionalUniverses\n';
  const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), { source: original, task: 'Check conditional universe instantiations.' });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  const candidate = original.replace('theorem goal', declaration + '\ntheorem goal');
  fs.writeFileSync(path.join(receipt.projectRoot, 'Submission.lean'), candidate);
  const commit = commitSolverSources(problem, receipt.workspaceRoot);
  const task: CooperativeTask = { id: 'bridge', kind: 'lemma', objective: 'Connect independently typed inputs.',
    proofPath: 'Submission.lean', theoremName: 'ConditionalUniverses.bridge', type,
    dependsOn: dependencies.map(task => task.id), conditional: true, revision: 0 };
  const assignment: TaskAssignment = { taskId: task.id, taskDigest: taskVersion(task), workerId: 'engineer',
    seedCommit: problem.baseCommit, dependencies: dependencies.map(task => ({ taskId: task.id, taskDigest: taskVersion(task) })) };
  const project = createTaskSourceProjector(problem, receipt.workspaceRoot, commit);
  const projected = () => project(task, [], dependencies).get('Submission.lean')!;
  const native = () => {
    if (!lean) throw new Error('Native Lean is required for conditional universe checks.');
    const file = path.join(directory, 'Projection.lean');
    fs.writeFileSync(file, projected() + '\n#print axioms ConditionalUniverses.bridge\n#check ConditionalUniverses.bridge\n');
    const result = spawnSync(lean, [file], { cwd: receipt.projectRoot, encoding: 'utf8', timeout: 30_000 });
    expect(result.error).toBeUndefined();
    return { status: result.status, output: result.stdout + result.stderr };
  };
  const envFile = path.join(directory, 'math.env'); fs.writeFileSync(envFile, '');
  const check = () => checkTaskProof(problem, receipt.workspaceRoot, commit, task, assignment, [],
    { PATH: `${path.dirname(lean!)}:/usr/bin:/bin`, DEEPSCIENTIST_MATH_ENV_FILE: envFile },
    new AbortController().signal, 30_000, dependencies, 'conditional-universe-fixture');
  return { directory, receipt, problem, candidate, commit, task, assignment, dependencies, projected, native, check };
}

describe.skipIf(!lean)('polymorphic conditional proof projection', () => {
  it('instantiates the closed dependency at the target universe without editing the candidate', () => {
    const f = fixture('theorem bridge {α : Type u} (x : α) : x = x := by\n  exact dep (α := α) x',
      '∀ {α : Type _} (x : α), x = x');
    const result = f.native();
    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain('sorryAx');
    expect(committedSource(f.receipt.workspaceRoot, f.commit, `${f.problem.projectRelative}/Submission.lean`)).toBe(f.candidate);
  });

  it('supports two independent universe instantiations of the same dependency', () => {
    const f = fixture('theorem bridge {α : Type u} {β : Type v} (x : α) (y : β) : x = x ∧ y = y := by\n' +
      '  exact ⟨dep (α := α) x, dep (α := β) y⟩',
      '∀ {α β : Type _} (x : α) (y : β), x = x ∧ y = y');
    const result = f.native();
    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain('sorryAx');
  });

  it('supports universe expressions and fully qualified dependency references', () => {
    const f = fixture('theorem bridge {α : Type u} {β : Type v} (x : α) (y : β) : x = x := by\n' +
      '  have hp : (x, y) = (x, y) := ConditionalUniverses.dep (α := α × β) (x, y)\n' +
      '  exact congrArg Prod.fst hp',
      '∀ {α β : Type _} (x : α) (y : β), x = x');
    const result = f.native();
    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain('sorryAx');
  });

  it('keeps the independent host expected-type check for a conditional helper', async () => {
    const f = fixture('theorem bridge {α : Type u} (x : α) : x = x := by\n  exact dep (α := α) x',
      '∀ {α : Type _} (x : α), x = x');
    const proof = await f.check();
    expect(proof.passed, JSON.stringify(proof.verification.results)).toBe(true);
    expect(proof.conditions).toEqual(f.assignment.dependencies);
    expect(proof.changes.find(change => change.name === 'bridge')!.after).toContain('exact dep (α := α) x');
  }, 60_000);

  it('rejects a wrong host contract even when the conditional proof itself elaborates', async () => {
    const f = fixture('theorem bridge {α : Type u} (x : α) : x = x := by\n  exact dep (α := α) x', 'False');
    const proof = await f.check();
    expect(proof.passed).toBe(false);
    expect(JSON.stringify(proof.verification.results)).toContain('different type or additional assumptions');
  }, 60_000);

  it('rejects an unfinished proof hidden inside the host projection', async () => {
    const f = fixture('theorem bridge {α : Type u} (x : α) : x = x := by sorry',
      '∀ {α : Type _} (x : α), x = x');
    const proof = await f.check();
    expect(proof.passed).toBe(false);
    expect(JSON.stringify(proof.verification.results)).toMatch(/sorry|axiom/iu);
  }, 60_000);

  it('rejects an extra premise beyond the selected dependency contracts', async () => {
    const f = fixture('theorem bridge (extra : False) : True := by\n' +
      '  have h : (0 : Nat) = 0 := dep (α := Nat) 0\n  exact False.elim extra', 'True');
    const proof = await f.check();
    expect(proof.passed).toBe(false);
    expect(JSON.stringify(proof.verification.results)).toContain('different type or additional assumptions');
  }, 60_000);
});

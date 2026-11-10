import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { LIBRARY_PACK_SCHEMA } from '../src/math/libraryPacks';
import { createTaskSourceProjector } from '../src/solver/cooperativeProof';
import { committedSource, commitSolverSources, readSolverProblem } from '../src/solver/problem';
import type { CooperativeTask } from '../src/solver/tasks';
import { temporaryDirectory } from './helpers/files';
import { newestLeanBinary } from './helpers/lean';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const base = 'Submission/Library/Base.lean';
const bounds = 'Submission/Library/Bounds.lean';
const unrelated = 'Submission/Library/Unrelated.lean';
const module = 'Submission.Library.Bounds';

function fixture(imported = false) {
  const root = temporaryDirectory('conditional-library-imports-'); roots.push(root);
  const sources = {
    [base]: 'namespace Frozen\ndef identity (n : Nat) : Nat := n\nend Frozen\n',
    [bounds]: 'import Submission.Library.Base\nnamespace Frozen\n' +
      'structure Box where\n  value : Nat\n' +
      'def maxEntropy (n : Nat) : Nat := identity n\nend Frozen\n',
    [unrelated]: 'namespace Other\ndef maxEntropy (n : Nat) : Nat := n\nend Other\n',
  };
  const receipt = bootstrapLeanTask(path.join(root, 'workspace'), {
    source: 'namespace Original\ntheorem target : True := by sorry\nend Original\n', task: 'Prove the original target.',
    libraryPack: { schema: LIBRARY_PACK_SCHEMA, modules: Object.entries(sources).map(([file, source]) => ({ file, source,
      origin: { kind: 'upstream' as const, repository: 'fixture', commit: 'a'.repeat(40), file: 'Library.lean' } })) },
  });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  const source = (imported ? `import ${module}\n` : '') +
    'namespace Original\ntheorem consumer : True := by trivial\ntheorem target : True := by sorry\nend Original\n';
  fs.writeFileSync(path.join(receipt.projectRoot, 'Submission.lean'), source);
  const commit = commitSolverSources(problem, receipt.workspaceRoot);
  const task: CooperativeTask = { id: 'consumer', kind: 'lemma', objective: 'Discharge the conditional consumer.',
    proofPath: 'Submission.lean', theoremName: 'Original.consumer', type: 'True',
    dependsOn: ['transfer'], conditional: true, revision: 0 };
  const condition: CooperativeTask = { id: 'transfer', kind: 'lemma', objective: 'Prove the transfer.',
    proofPath: 'Submission.lean', theoremName: 'Original.transfer', type: '∀ n : Nat, _root_.Frozen.maxEntropy n = n',
    dependsOn: [], revision: 0 };
  const project = createTaskSourceProjector(problem, receipt.workspaceRoot, commit);
  return { root, receipt, problem, source, sources, commit, task, condition, project };
}

describe('frozen library imports for host-injected conditions', () => {
  it.skipIf(!newestLeanBinary())('elaborates a condition from a frozen module absent from the candidate and its seed', () => {
    const f = fixture();
    const projected = f.project(f.task, [], [f.condition]);
    const source = projected.get('Submission.lean')!;
    expect(source).toContain(`import ${module}\n`);
    expect(source).not.toContain('import Submission.Library.Unrelated');
    expect(source).toContain('(transfer : ∀ n : Nat, _root_.Frozen.maxEntropy n = n)');
    expect(source).not.toContain('theorem target');
    for (const [file, original] of Object.entries(f.sources)) expect(projected.get(file)).toBe(original);

    const lean = newestLeanBinary()!;
    const env = { ...process.env, LEAN_PATH: f.receipt.projectRoot };
    for (const file of [base, bounds]) {
      const compiled = spawnSync(lean, ['-o', file.replace(/\.lean$/u, '.olean'), file],
        { cwd: f.receipt.projectRoot, env, encoding: 'utf8', timeout: 20_000 });
      expect(compiled.status, `${compiled.stdout}${compiled.stderr}`).toBe(0);
    }
    const output = path.join(f.receipt.projectRoot, 'Projection.lean');
    fs.writeFileSync(output, source + '\n#print axioms Original.consumer\n');
    const checked = spawnSync(lean, [output], { cwd: f.receipt.projectRoot, env, encoding: 'utf8', timeout: 20_000 });
    expect(checked.status, `${checked.stdout}${checked.stderr}`).toBe(0);
    expect(`${checked.stdout}${checked.stderr}`).not.toContain('sorryAx');
    expect(committedSource(f.receipt.workspaceRoot, f.commit, 'generated/problem/Submission.lean')).toBe(f.source);
    expect(fs.readFileSync(path.join(f.receipt.projectRoot, 'Submission.lean'), 'utf8')).toBe(f.source);
  });

  it('does not add duplicate imports or infer imports from comments and short names', () => {
    const f = fixture(true);
    expect(f.project(f.task, [], [f.condition]).get('Submission.lean')!.match(/import Submission\.Library\.Bounds/gu)).toHaveLength(1);
    const clean = fixture();
    const condition = { ...clean.condition, type: '∀ maxEntropy : Nat, maxEntropy = maxEntropy /- Frozen.maxEntropy -/' };
    expect(clean.project(clean.task, [], [condition]).get('Submission.lean')).not.toContain('import Submission.Library');
    expect(clean.project(clean.task, []).get('Submission.lean')).not.toContain('import Submission.Library');
  });

  it('does not turn a mutable owned module into an implicit conditional import', () => {
    const f = fixture();
    const problem = { ...f.problem, frozenFiles: { [base]: f.problem.frozenFiles![base]!, [unrelated]: f.problem.frozenFiles![unrelated]! } };
    const project = createTaskSourceProjector(problem, f.receipt.workspaceRoot, f.commit);
    expect(project(f.task, [], [f.condition]).get('Submission.lean')).not.toContain(`import ${module}`);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapLeanTask, readLeanTaskReceipt } from '../src/math/leanTask';
import { assertSolverSources, readSolverProblem } from '../src/solver/problem';
import { temporaryDirectory } from './helpers/files';

const roots: string[] = [];
const workspace = () => {
  const root = temporaryDirectory('qualified-input-regression-');
  roots.push(root); return path.join(root, 'workspace');
};
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const source = [
  'namespace A', 'def value : Nat := 1', 'end A',
  'namespace B', 'def value : Nat := 2', 'end B',
  'theorem goal : A.value + B.value = 3 := by sorry', '',
].join('\n');

describe('qualified Lean input names', () => {
  it('keeps different namespace definitions independent through bootstrap, receipt, problem and source guards', () => {
    const receipt = bootstrapLeanTask(workspace(), { source, task: 'Prove the original goal.' });
    expect(receipt.declarations.map(item => item.name)).toEqual(['A.value', 'B.value', 'goal']);
    expect(readLeanTaskReceipt(receipt.activeProblemPath)).toEqual(receipt);
    const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
    expect(problem.targets.map(item => item.theoremName)).toEqual(['goal']);
    const submission = path.join(receipt.projectRoot, 'Submission.lean');
    fs.writeFileSync(submission, source.replace('by sorry', 'by rfl'));
    expect(() => assertSolverSources(problem, receipt.workspaceRoot)).not.toThrow();
    for (const text of [source.replace('Nat := 1', 'Nat := 2'), source.replace('Nat := 2', 'Nat := 1')]) {
      fs.writeFileSync(submission, text);
      expect(() => assertSolverSources(problem, receipt.workspaceRoot)).toThrow('math_original_declaration_changed');
    }
  });

  it('still rejects duplicate qualified declarations before creating a workspace', () => {
    const destination = workspace();
    expect(() => bootstrapLeanTask(destination, {
      source: source.replace('namespace B', 'namespace A').replace('end B', 'end A'),
      task: 'Prove the original goal.',
    })).toThrow('lean_task_declaration_names_ambiguous');
    expect(fs.existsSync(destination)).toBe(false);
  });
});

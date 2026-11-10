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
const originalName = 'ConditionalContext.first';

function fixture(notation = false, shadow = false) {
  const directory = temporaryDirectory('task-source-conditional-context-'); directories.push(directory);
  const source = ['namespace ConditionalContext', 'theorem first : True := by trivial',
    'def frozen : True := first', ...(notation ? ['local notation "choice" => frozen'] : []),
    `theorem target ${shadow ? '(first : Nat) ' : ''}: True := by trivial`, 'end ConditionalContext', '',
  ].join('\n');
  const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), { source, task: 'Check injected condition source context.' });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  const task: CooperativeTask = { id: 'target', kind: 'goal', objective: 'Prove the exact original.', proofPath: 'Submission.lean',
    theoremName: 'ConditionalContext.target', dependsOn: ['assumed'], conditional: true, revision: 0 };
  const condition: CooperativeTask = { id: 'assumed', kind: 'lemma', objective: 'Prove the frozen condition.',
    proofPath: 'Submission.lean', theoremName: 'ConditionalContext.assumed', type: notation ? 'choice = choice' : 'first = first',
    dependsOn: [], revision: 0 };
  const records: TaskRecord[] = problem.targets.map((item, index) => ({ task: { ...task, id: `original-${index}`,
    theoremName: item.theoremName, dependsOn: [], conditional: false }, status: 'pending', attempts: 0 }));
  const project = createTaskSourceProjector(problem, receipt.workspaceRoot, problem.baseCommit);
  const native = (text: string) => {
    if (!lean) throw new Error('Native Lean is required for conditional source-context regression checks.');
    const file = path.join(directory, 'Projection.lean'); fs.writeFileSync(file, text + '\n#print axioms ConditionalContext.target\n');
    const checked = spawnSync(lean, ['-DautoImplicit=false', file], { cwd: receipt.projectRoot, encoding: 'utf8', timeout: 20_000 });
    expect(checked.error).toBeUndefined(); return { status: checked.status, output: `${checked.stdout}${checked.stderr}` };
  };
  const accepted = (text: string) => {
    const result = native(text); expect(result.status, result.output).toBe(0); expect(result.output).not.toContain('sorryAx');
  };
  return { source, problem, task, condition, records, project, native, accepted };
}

describe('source context of host-injected closed conditional types', () => {
  it.each([false, true].flatMap(notation => [false, true].map(shadow => ({ notation, shadow }))))
  ('retains conditional context before target parameters (notation: $notation, shadow: $shadow)', ({ notation, shadow }) => {
    const f = fixture(notation, shadow); f.accepted(f.source);
    const missing = f.native(f.project(f.task, [], [f.condition]).get('Submission.lean')!);
    expect(missing.status, missing.output).not.toBe(0);
    f.accepted(f.project(f.task, [originalName], [f.condition]).get('Submission.lean')!);
    expect(f.project.possibleContextGoals(f.task, [], [f.condition]).map(root => root.name)).toEqual([originalName]);
    expect(projectedGoalInputs(f.project, f.task, f.records, [f.condition]).map(node => node.task.theoremName)).toEqual([originalName]);
    // Short condition names are possible source context, never a guessed unique plan edge.
    expect(f.project.dependencyHints(f.task, [], [f.condition])).toEqual([]);
    expect(f.project.possibleContextGoals(f.task, [originalName], [f.condition])).toEqual([]);
    expect(f.project.possibleContextGoals(f.task, [])).toEqual([]);
  });

  it('keeps a qualified conditional reference in the existing unambiguous hint contract', () => {
    const f = fixture(); f.condition.type = 'ConditionalContext.first = ConditionalContext.first';
    const hints = f.project.dependencyHints(f.task, [], [f.condition]);
    expect(hints.map(hint => hint.root.name)).toEqual([originalName]);
    expect(hints[0]!.authority).toBe('unambiguous-source-reference');
    expect(hints[0]!.root.removedBecause).toBe('excluded-original-target');
    expect(projectedGoalInputs(f.project, f.task, f.records, [f.condition]).map(node => node.task.theoremName)).toEqual([originalName]);
    f.accepted(f.project(f.task, [originalName], [f.condition]).get('Submission.lean')!);
  });

  it.each(['∀ first : Nat, first = first', '∀ (first : Nat), first = first'] as const)
  ('keeps a type-local binder in the exact conditional type: %s', type => {
    const f = fixture(false, true); f.condition.type = type;
    // Source-only observations may conservatively offer an accepted original,
    // but a bound name cannot justify an unambiguous dependency hint.
    expect(f.project.dependencyHints(f.task, [], [f.condition])).toEqual([]);
    const source = f.project(f.task, [], [f.condition]).get('Submission.lean')!;
    expect(source).not.toContain('theorem first');
    expect(source).toContain('theorem target : theorem_os_conditional_type%');
    expect(source).toContain(type); f.accepted(source);
  });
});

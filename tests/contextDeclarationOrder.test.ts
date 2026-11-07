import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { inspectLeanDeclarationRegions } from '../src/math/leanSource';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { COMPACT_CONTEXT_SOURCE_BYTES, compileTaskContext, DEFAULT_TASK_CONTEXT_BYTES, frozenSourceContext,
  type TaskContextInput } from '../src/solver/contextCompiler';
import { committedSource, readSolverProblem, type SolverProblem } from '../src/solver/problem';
import { taskVersion, type CooperativeAction, type CooperativeTask, type TaskRecord } from '../src/solver/tasks';
import { temporaryDirectory } from './helpers/files';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const order = (message: string) => JSON.parse(message.split('Frozen declaration order by file:\n')[1].split('\n')[0]);
const sources = (message: string) => JSON.parse(message.split('Frozen source context and immutable retrieval references:\n')[1].split('\n')[0]);
const node = (task: CooperativeTask): TaskRecord => ({ task, status: 'pending', attempts: 0 });
function fixture(source: string) {
  const root = temporaryDirectory('context-declaration-order-'); roots.push(root);
  const receipt = bootstrapLeanTask(path.join(root, 'workspace'), { source, task: 'Prove the frozen target with its exact hypotheses.' });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  const frozen = committedSource(problem.workspace, problem.baseCommit, `${problem.projectRelative}/Submission.lean`);
  const context = frozenSourceContext(problem, 'Submission.lean', frozen);
  const goal: CooperativeTask = { id: 'goal', kind: 'goal', objective: 'Prove the original target.',
    theoremName: problem.targets[0].theoremName, proofPath: 'Submission.lean', dependsOn: ['input'], revision: 0 };
  const helper: CooperativeTask = { id: 'input', kind: 'lemma', objective: 'Prove the exact prerequisite.',
    type: '∀ (n : Nat), 0 < n → n = n', theoremName: 'Frozen.input', proofPath: 'Submission.lean',
    dependsOn: [], revision: 0, premises: ['Use only positive natural inputs.'],
    preferredOwnerId: 'researcher', researchSource: 'library' };
  const tasks = [node(goal), node(helper)];
  const input = (action: CooperativeAction = { kind: 'lead', seedCommit: problem.baseCommit }): TaskContextInput => ({
    problem, cooperation: { tasks }, action, instructions: 'Preserve every mathematical interface and assumption.',
    taskText: 'Prove the frozen target.', frozenContexts: { 'Submission.lean': context }, maxOptionalContextBytes: 0,
  });
  return { root, problem, frozen, context, tasks, goal, helper, input };
}
const small = 'namespace Frozen\nvariable (n : Nat)\ndef fixed : Nat := 7\n' +
  'theorem target (h : 0 < n) : n = n := by sorry\nend Frozen\n';
const largeSource = () => {
  const definitions = Array.from({ length: 1135 }, (_, index) =>
    `def prerequisite_obligation_ordered_exact_name_${index.toString().padStart(4, '0')} : Nat := 7\n`).join('');
  const body = small.replace('def fixed : Nat := 7\n', definitions), bytes = 474 * 1024;
  return '/- ' + 'x'.repeat(bytes - Buffer.byteLength(body) - 7) + ' -/\n' + body;
};

describe('frozen declaration order references', () => {
  it('fits a large frozen context under the unchanged default budget while retaining exact open interfaces', () => {
    const f = fixture(largeSource()), original = structuredClone(f.tasks);
    const context = compileTaskContext(f.input());
    expect(context.manifest.maxBytes).toBe(512 * 1024);
    expect(context.manifest.usedBytes).toBeLessThanOrEqual(DEFAULT_TASK_CONTEXT_BYTES);
    const declarationOrder = order(context.message)['Submission.lean'];
    expect(declarationOrder).toMatchObject({ encoding: 'frozen-declaration-order-v1', declarationCount: 1136,
      commit: f.problem.baseCommit, path: `${f.problem.projectRelative}/Submission.lean` });
    expect(sources(context.message).files[0].context).toBe(f.context);
    expect(context.message).toContain(JSON.stringify(f.helper.type));
    expect(context.message).toContain(JSON.stringify(f.helper.premises));
    expect(context.message).toContain('theorem target (h : 0 < n) : n = n');
    expect(context.manifest.requiredTaskIds).toEqual(['goal', 'input']);
    expect(context.manifest.included.find(item => item.id === 'declaration-order')).toMatchObject({ required: true });
    expect(f.tasks).toEqual(original);
    // Reintroducing the old duplicate list would exceed this same hard boundary.
    const oldNames = JSON.stringify({ 'Submission.lean': f.problem.declarations['Submission.lean'].map(item => item.name) });
    expect(context.manifest.mandatoryBytes + Buffer.byteLength(oldNames) - Buffer.byteLength(JSON.stringify(order(context.message))))
      .toBeGreaterThan(DEFAULT_TASK_CONTEXT_BYTES);
  });

  it('retrieves the full ordered names from the immutable file and checks the exact count and digest', () => {
    const source = largeSource().replace('variable (n : Nat)',
      'namespace First\ndef repeated : Nat := 1\nend First\nnamespace Second\ndef repeated : Nat := 2\nend Second\nvariable (n : Nat)');
    const f = fixture(source), context = compileTaskContext(f.input()), reference = order(context.message)['Submission.lean'];
    const retrieved = committedSource(f.problem.workspace, reference.commit, reference.path);
    const names = inspectLeanDeclarationRegions(retrieved).map(item => item.name);
    expect(retrieved).toBe(f.frozen);
    expect(names.filter(name => name === 'repeated')).toHaveLength(2);
    expect(names).toHaveLength(reference.declarationCount);
    expect(mathDigest(canonicalMathJson(names))).toBe(reference.orderDigest);
    const reordered = [...names].reverse();
    expect(mathDigest(canonicalMathJson(reordered))).not.toBe(reference.orderDigest);
    expect(reference.retrieval).toContain('Missing or mismatched source is unavailable');
  });

  it('keeps the complete short-source name list without adding reference metadata', () => {
    const f = fixture(small), context = compileTaskContext(f.input());
    expect(order(context.message)).toEqual({ 'Submission.lean': ['fixed', 'target'] });
    expect(context.message).not.toContain('frozen-declaration-order-v1');
  });

  it.each([COMPACT_CONTEXT_SOURCE_BYTES, COMPACT_CONTEXT_SOURCE_BYTES + 1])('switches only above the existing %i-byte source-context boundary', bytes => {
    const f = fixture(small), supplied = f.context + ' '.repeat(bytes - Buffer.byteLength(f.context));
    const context = compileTaskContext({ ...f.input(), frozenContexts: { 'Submission.lean': supplied } });
    const result = order(context.message)['Submission.lean'];
    if (bytes === COMPACT_CONTEXT_SOURCE_BYTES) expect(result).toEqual(['fixed', 'target']);
    else expect(result).toMatchObject({ encoding: 'frozen-declaration-order-v1', declarationCount: 2 });
    expect(sources(context.message).files[0].context).toBe(supplied);
  });

  it('uses the same lossless reference for a proof task and preserves conditions and premises inline', () => {
    const f = fixture(largeSource());
    const action: CooperativeAction = { kind: 'task', task: f.helper, assignment: {
      taskId: f.helper.id, taskDigest: taskVersion(f.helper), workerId: 'researcher', seedCommit: f.problem.baseCommit } };
    const context = compileTaskContext(f.input(action));
    expect(context.manifest.usedBytes).toBeLessThanOrEqual(DEFAULT_TASK_CONTEXT_BYTES);
    expect(context.message).toContain(JSON.stringify(f.helper.type));
    expect(context.message).toContain(JSON.stringify(f.helper.premises));
    expect(context.message).toContain(taskVersion(f.helper));
    expect(order(context.message)['Submission.lean'].orderDigest)
      .toBe(mathDigest(canonicalMathJson(f.problem.declarations['Submission.lean'].map(item => item.name))));
  });

  it('does not turn missing frozen sources or changed exact interfaces into references', () => {
    const f = fixture(largeSource());
    expect(() => compileTaskContext({ ...f.input(), frozenContexts: {} })).toThrow('math_context_missing_required:frozen-context:Submission.lean');
    const action: CooperativeAction = { kind: 'task', task: f.helper, assignment: {
      taskId: f.helper.id, taskDigest: 'old-type', workerId: 'researcher', seedCommit: f.problem.baseCommit } };
    expect(() => compileTaskContext(f.input(action))).toThrow('math_context_stale_required:assignment:input');
  });

  it('still rejects an exact required contract that cannot fit instead of truncating it', () => {
    const f = fixture(small), long = { ...f.helper, type: '∀ n : Nat, ' + 'n = n ∧ '.repeat(70_000) + 'True' };
    const source = f.input();
    expect(() => compileTaskContext({ ...source, cooperation: { tasks: [node(f.goal), node(long)] } }))
      .toThrow('math_context_mandatory_overflow:');
    expect(long.type.endsWith('True')).toBe(true);
  });

  it('does not inline the frozen library declaration inventory when another source uses an order reference', () => {
    const f = fixture(largeSource()), library = 'Submission/Library/Fixed.lean';
    const problem = { ...f.problem, ownedFiles: [...f.problem.ownedFiles, library],
      frozenFiles: { [library]: 'library-digest' }, declarations: { ...f.problem.declarations,
        [library]: [{ name: 'library_private_name', header: 'library_private_name : True' }] } } as SolverProblem;
    const context = compileTaskContext({ ...f.input(), problem });
    expect(order(context.message)).not.toHaveProperty(library);
    expect(sources(context.message).libraryFiles).toEqual([expect.objectContaining({
      path: `${f.problem.projectRelative}/${library}`, digest: 'library-digest', declarationCount: 1 })]);
    expect(context.message).not.toContain('library_private_name');
  });
});

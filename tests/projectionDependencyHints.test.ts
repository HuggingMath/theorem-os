import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_EXAMPLE_PROOF } from '../src/math/localExample';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { inspectLeanDeclarationRegions } from '../src/math/leanSource';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { checkTaskProof, createTaskSourceProjector } from '../src/solver/cooperativeProof';
import { projectionDependencyConnections, type ProjectionDependencyHint } from '../src/solver/projectionDependencyHints';
import { commitSolverSources, readSolverProblem } from '../src/solver/problem';
import { freshlyAccepted, taskVersion, type CooperativeTask, type TaskRecord } from '../src/solver/tasks';
import { localExample } from './helpers/solver';
import { integratedProof } from './helpers/taskProof';
import { temporaryDirectory } from './helpers/files';
import { failedBatch, receiptBatch } from './helpers/verifier';

const checker = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../src/math/verifier', async original => ({ ...await original<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: checker.verify,
}));

const goal: CooperativeTask = { id: 'add', kind: 'goal', objective: 'Original target.',
  theoremName: 'Tutorial.add_zero', proofPath: 'Submission.lean', dependsOn: [], revision: 0 };
const helper: CooperativeTask = { id: 'helper', kind: 'lemma', objective: 'Use the original target through a definition.',
  theoremName: 'Tutorial.helper', proofPath: 'Submission.lean', type: 'Tutorial.bridge = 0', dependsOn: [], revision: 0 };
const node = (task: CooperativeTask, status: TaskRecord['status'] = 'pending'): TaskRecord => ({ task, status, attempts: 0 });

describe('projection dependency hints', () => {
  const cleanup: string[] = [];
  afterEach(() => { for (const directory of cleanup.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

  it('traces a removed original goal through a dependent definition without altering the projection', () => {
    const example = localExample('projection-hints-'); cleanup.push(example.directory);
    const file = path.join(example.receipt.projectRoot, 'Submission.lean');
    fs.writeFileSync(file, LOCAL_EXAMPLE_PROOF.replace('theorem zero_add',
      'def bridge : Nat := by\n  have h := add_zero 0\n  exact 0\n\nlemma helper : bridge = 0 := by rfl\n\ntheorem zero_add'));
    const commit = commitSolverSources(example.problem, example.workspace);
    const projector = createTaskSourceProjector(example.problem, example.workspace, commit);
    const before = projector(helper, []).get('Submission.lean');
    const hints = projector.dependencyHints(helper, []);
    const rootRegion = inspectLeanDeclarationRegions(fs.readFileSync(file, 'utf8')).find(item => item.name === 'add_zero')!;
    expect(hints[0]!.root.declarationDigest).toBe(mathDigest(fs.readFileSync(file, 'utf8').slice(rootRegion.startOffset, rootRegion.endOffset)));
    expect(projector(helper, []).get('Submission.lean')).toBe(before);
    expect(hints).toEqual(expect.arrayContaining([expect.objectContaining({
      consumer: expect.objectContaining({ taskId: 'helper', taskDigest: taskVersion(helper) }),
      root: expect.objectContaining({ name: 'Tutorial.add_zero', removedBecause: 'excluded-original-target' }),
      path: expect.arrayContaining([expect.objectContaining({ name: 'Tutorial.bridge' })]),
    })]));
    const accepted = node(goal); integratedProof(accepted);
    const tasks = [accepted, node(helper)];
    const input = { problemReceiptDigest: example.problem.receiptDigest, sourceCommit: commit,
      sourceDigest: hints[0]!.sourceDigest, consumer: helper, tasks,
      isFreshlyAccepted: (candidate: TaskRecord) => freshlyAccepted(candidate, taskVersion(candidate.task)) };
    expect(projectionDependencyConnections(hints, input)).toEqual([expect.objectContaining({
      consumer: { taskId: 'helper', taskDigest: taskVersion(helper) },
      dependency: { taskId: 'add', taskDigest: taskVersion(goal) },
    })]);
    expect(projectionDependencyConnections(hints, { ...input, sourceCommit: 'stale' })).toEqual([]);
    expect(projectionDependencyConnections(hints, { ...input, sourceDigest: 'stale' })).toEqual([]);
    expect(projectionDependencyConnections(hints, { ...input, problemReceiptDigest: 'stale' })).toEqual([]);
    expect(projectionDependencyConnections(hints, { ...input, isFreshlyAccepted: () => false })).toEqual([]);
    expect(projectionDependencyConnections(hints.map(hint => ({ ...hint, root: { ...hint.root, name: 'Tutorial.wrong' } })), input)).toEqual([]);
    expect(projectionDependencyConnections(hints, { ...input, tasks: [accepted, node({ ...helper, dependsOn: ['add'] })] })).toEqual([]);
    expect(projectionDependencyConnections(hints, { ...input, tasks: [accepted, node({ ...goal, id: 'duplicate' }), node(helper)] })).toEqual([]);
    const privateRoot = node({ ...goal, sharing: 'group', groupId: 'private' }); integratedProof(privateRoot);
    expect(projectionDependencyConnections(hints, { ...input, tasks: [privateRoot, node(helper)] })).toEqual([]);
    const historicalRoot = node(goal); integratedProof(historicalRoot, { accept: false });
    expect(projectionDependencyConnections(hints, { ...input, tasks: [historicalRoot, node(helper)] })).toEqual([]);
    expect(projector.dependencyHints(helper, ['Tutorial.add_zero'])).toEqual([]);
  });

  it('ignores an invalid hint instead of manufacturing a connection', () => {
    const hint = { id: 'bad' } as ProjectionDependencyHint;
    const tasks = [node(goal), node(helper)];
    expect(projectionDependencyConnections([hint], {
      problemReceiptDigest: 'receipt', sourceCommit: 'commit', sourceDigest: 'source', consumer: helper, tasks,
      isFreshlyAccepted: () => true,
    })).toEqual([]);
  });

  it('preserves exact namespace identities through two frozen definitions', () => {
    const directory = temporaryDirectory('projection-hints-namespaces-'); cleanup.push(directory);
    const original = 'namespace Geometry\n' +
      'theorem collapse : True := by sorry\n' +
      'def expansion : Nat := by\n  have h := collapse\n  exact 0\n' +
      'def wrapper : Nat := expansion\nend Geometry\n' +
      'namespace Consumer\ntheorem original : True := by sorry\nend Consumer\n';
    const workspace = path.join(directory, 'workspace'), receipt = bootstrapLeanTask(workspace, { source: original, task: 'Fixture.' });
    const problem = readSolverProblem(workspace, receipt.activeProblemPath);
    const file = path.join(receipt.projectRoot, 'Submission.lean');
    fs.writeFileSync(file, original.replace('theorem collapse : True := by sorry', 'theorem collapse : True := by trivial')
      .replace('theorem original', 'lemma helper : Geometry.wrapper = 0 := by rfl\ntheorem original'));
    const commit = commitSolverSources(problem, workspace);
    const task = { ...helper, theoremName: 'Consumer.helper', type: 'Geometry.wrapper = 0' };
    const projector = createTaskSourceProjector(problem, workspace, commit);
    const hints = projector.dependencyHints(task, []);
    expect(hints).toHaveLength(1);
    expect(hints[0]!.path.map(item => [item.file, item.name])).toEqual([
      ['Submission.lean', 'Consumer.helper'], ['Submission.lean', 'Geometry.wrapper'],
      ['Submission.lean', 'Geometry.expansion'], ['Submission.lean', 'Geometry.collapse'],
    ]);
    expect(hints[0]).toMatchObject({ sourceCommit: commit, authority: 'unambiguous-source-reference', proofAcceptance: 'not-assessed' });
  });

  it('leaves opened-name ambiguity unknown and never guesses another namespace from a final name', () => {
    const directory = temporaryDirectory('projection-hints-ambiguous-'); cleanup.push(directory);
    const original = 'namespace A\ntheorem rootA : True := by sorry\n' +
      'def shared : Nat := by\n  have h := rootA\n  exact 0\nend A\n' +
      'namespace B\ntheorem rootB : True := by sorry\n' +
      'def shared : Nat := by\n  have h := rootB\n  exact 0\nend B\n' +
      'open A B\ndef ambiguous : Nat := shared\n' +
      'theorem original : True := by sorry\n';
    const workspace = path.join(directory, 'workspace'), receipt = bootstrapLeanTask(workspace, { source: original, task: 'Fixture.' });
    const problem = readSolverProblem(workspace, receipt.activeProblemPath);
    fs.writeFileSync(path.join(receipt.projectRoot, 'Submission.lean'), original
      .replace('theorem rootA : True := by sorry', 'theorem rootA : True := by trivial')
      .replace('theorem rootB : True := by sorry', 'theorem rootB : True := by trivial')
      .replace('theorem original', 'lemma helper : ambiguous = 0 := by rfl\ntheorem original'));
    const commit = commitSolverSources(problem, workspace);
    expect(createTaskSourceProjector(problem, workspace, commit).dependencyHints({
      ...helper, theoremName: 'helper', type: '_root_.ambiguous = 0',
    }, [])).toEqual([]);
  });

  it('does not turn an unrelated proof failure or a local header binder into a dependency hint', () => {
    const example = localExample('projection-hints-no-dependency-'); cleanup.push(example.directory);
    fs.writeFileSync(path.join(example.receipt.projectRoot, 'Submission.lean'), LOCAL_EXAMPLE_PROOF.replace('theorem zero_add',
      'lemma helper (add_zero : Nat) : False := by trivial\n\ntheorem zero_add'));
    const commit = commitSolverSources(example.problem, example.workspace);
    expect(createTaskSourceProjector(example.problem, example.workspace, commit).dependencyHints({
      ...helper, type: '∀ add_zero : Nat, False',
    }, [])).toEqual([]);
  });

  it('does not identify a local let binding as the removed original declaration', () => {
    const example = localExample('projection-hints-shadowed-'); cleanup.push(example.directory);
    fs.writeFileSync(path.join(example.receipt.projectRoot, 'Submission.lean'), LOCAL_EXAMPLE_PROOF.replace('theorem zero_add',
      'def bridge : Nat := by\n  let add_zero := 0\n  exact add_zero\n\nlemma helper : bridge = 0 := by rfl\n\ntheorem zero_add'));
    const commit = commitSolverSources(example.problem, example.workspace);
    expect(createTaskSourceProjector(example.problem, example.workspace, commit).dependencyHints(helper, [])).toEqual([]);
  });

  it('keeps a removed draft advisory even if a caller offers an unrelated accepted task', () => {
    const example = localExample('projection-hints-draft-'); cleanup.push(example.directory);
    fs.writeFileSync(path.join(example.receipt.projectRoot, 'Submission.lean'), LOCAL_EXAMPLE_PROOF.replace('theorem zero_add',
      'lemma draft : True := by sorry\n\ndef bridge : Nat := by\n  have h := draft\n  exact 0\n' +
      '\nlemma helper : bridge = 0 := by rfl\n\ntheorem zero_add'));
    const commit = commitSolverSources(example.problem, example.workspace);
    const hints = createTaskSourceProjector(example.problem, example.workspace, commit).dependencyHints(helper, []);
    expect(hints).toHaveLength(1);
    expect(hints[0]!.root).toMatchObject({ name: 'Tutorial.draft', removedBecause: 'draft-declaration' });
    const draft = node({ ...goal, id: 'draft', theoremName: 'Tutorial.draft', kind: 'lemma', type: 'True' });
    expect(projectionDependencyConnections(hints, { problemReceiptDigest: example.problem.receiptDigest, sourceCommit: commit,
      sourceDigest: hints[0]!.sourceDigest, consumer: helper, tasks: [draft, node(helper)], isFreshlyAccepted: () => true })).toEqual([]);
  });

  it('retains the source-bound hint in the failed TaskProof returned through the existing checker', async () => {
    const example = localExample('projection-hints-checker-'); cleanup.push(example.directory);
    fs.writeFileSync(path.join(example.receipt.projectRoot, 'Submission.lean'), LOCAL_EXAMPLE_PROOF.replace('theorem zero_add',
      'def bridge : Nat := by\n  have h := add_zero 0\n  exact 0\n\nlemma helper : bridge = 0 := by rfl\n\ntheorem zero_add'));
    const commit = commitSolverSources(example.problem, example.workspace);
    checker.verify.mockReset().mockImplementation(async request => failedBatch(receiptBatch(request, {
      sessionId: 'hint-checker', receiptId: (_, name) => 'hint-' + name,
    }), { stdoutPreview: () => 'Submission.lean:4:0: error: unknown identifier bridge' }));
    const proof = await checkTaskProof(example.problem, example.workspace, commit, helper, {
      taskId: helper.id, taskDigest: taskVersion(helper), workerId: 'engineer', seedCommit: commit,
    }, [], { PATH: '/usr/bin:/bin' }, new AbortController().signal, Infinity, [], 'environment');
    expect(proof).toMatchObject({ passed: false, commit, projectionDependencyHints: [
      expect.objectContaining({ sourceCommit: commit, sourceDigest: proof.sourceDigest,
        consumer: expect.objectContaining({ taskId: helper.id, taskDigest: taskVersion(helper) }) }),
    ] });
    expect(proof.projectionDependencyHints![0]!.root.name).toBe('Tutorial.add_zero');
    expect(proof.references).toBeUndefined();
    expect(checker.verify).toHaveBeenCalled();
  });
});

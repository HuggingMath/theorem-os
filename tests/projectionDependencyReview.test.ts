import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_EXAMPLE_PROOF } from '../src/math/localExample';
import { createTaskSourceProjector, ownedSourceDigest, type TaskProof } from '../src/solver/cooperativeProof';
import { parseLeadPlan } from '../src/solver/cooperationShared';
import { reviewGoalPaths } from '../src/solver/goalPathReview';
import { leadPlanningEvidence } from '../src/solver/planningEvidence';
import { captureProofReferences } from '../src/solver/proofReferences';
import { reviewProjectionDependencies } from '../src/solver/projectionDependencyReview';
import { commitSolverSources } from '../src/solver/problem';
import { markTaskAcceptance, parseCooperationPlan, taskVersion, type TaskRecord } from '../src/solver/tasks';
import { localExample } from './helpers/solver';
import { integratedProof } from './helpers/taskProof';

describe('source-bound projection dependency planning', () => {
  const cleanup: string[] = [];
  afterEach(() => { for (const directory of cleanup.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
  const fixture = () => {
    const example = localExample('projection-review-'); cleanup.push(example.directory);
    const file = path.join(example.receipt.projectRoot, 'Submission.lean');
    const source = LOCAL_EXAMPLE_PROOF.replace('theorem zero_add',
      'def bridge : Nat := by\n  have h := add_zero 0\n  exact 0\n\nlemma helper : bridge = 0 := by rfl\n\ntheorem zero_add');
    fs.writeFileSync(file, source);
    const commit = commitSolverSources(example.problem, example.workspace);
    const plan = parseCooperationPlan(example.problem, { tasks: [
      { id: 'root', kind: 'goal', objective: 'Original dependency.', proofPath: 'Submission.lean', theoremName: 'Tutorial.add_zero', dependsOn: [] },
      { id: 'helper', kind: 'lemma', objective: 'Use the original through a definition.', proofPath: 'Submission.lean',
        theoremName: 'Tutorial.helper', type: 'Tutorial.bridge = 0', dependsOn: [] },
      { id: 'goal', kind: 'goal', objective: 'Original target.', proofPath: 'Submission.lean', theoremName: 'Tutorial.zero_add', dependsOn: ['helper'] },
    ] });
    const tasks: TaskRecord[] = plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 }));
    const root = tasks.find(node => node.task.id === 'root')!, helper = tasks.find(node => node.task.id === 'helper')!;
    const proof = integratedProof(root, { accept: false, sourceCommit: commit });
    proof.commit = commit; proof.sourceDigest = ownedSourceDigest(example.problem, example.workspace, commit);
    proof.references = captureProofReferences(example.problem, example.workspace, commit,
      { file: 'Submission.lean', name: 'Tutorial.add_zero' }, { statement: [], proof: [] }, 'environment');
    markTaskAcceptance(proof);
    helper.status = 'blocked'; helper.attempts = 1;
    helper.proof = { passed: false, taskDigest: taskVersion(helper.task), commit, seedCommit: commit, changes: [],
      sourceDigest: proof.sourceDigest, verification: { status: 'kernel_failed', targetCommit: 'failed-projection', results: [] },
      projectionDependencyHints: createTaskSourceProjector(example.problem, example.workspace, commit).dependencyHints(helper.task, []),
    } as TaskProof;
    const input = { problem: example.problem, worktree: example.workspace, canonicalCommit: commit, environmentDigest: 'environment',
      tasks, consumerTaskIds: ['helper'], retainedGoals: () => [] as string[] };
    const connections = () => reviewProjectionDependencies(input);
    const review = () => reviewGoalPaths(tasks, { environmentDigest: 'environment', projectionConnections: connections() });
    return { ...example, file, source, commit, plan, tasks, root, helper, input, connections, review };
  };

  it('turns the failure observation into an adoptable dependency through the existing plan validator', () => {
    const f = fixture(), connections = f.connections(), review = f.review();
    expect(connections).toEqual([expect.objectContaining({ consumer: { taskId: 'helper', taskDigest: taskVersion(f.helper.task) },
      dependency: { taskId: 'root', taskDigest: taskVersion(f.root.task) } })]);
    expect(review.goals.find(goal => goal.taskId === 'goal')!.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'connect:helper:root', mechanical: true, relatedTaskIds: ['root'] }),
    ]));
    const evidence = leadPlanningEvidence({ tasks: f.tasks }, 'environment', { goalPathReview: review });
    expect(evidence.goalPath.goals.find(goal => goal.taskId === 'goal')!.candidates).toContainEqual(
      expect.objectContaining({ id: 'connect:helper:root', mechanical: true }));
    const next = parseLeadPlan(f.problem, { baseVersion: 'current', goalPath: { adopt: ['connect:helper:root'] } },
      { version: 'current', tasks: f.plan.tasks, groups: f.plan.groups }, { goalPath: review });
    expect(next.tasks.find(task => task.id === 'helper')!.dependsOn).toEqual(['root']);
    expect(next.goalPathDecisions!.adopted).toEqual([{ id: 'connect:helper:root', action: 'connect', taskId: 'helper' }]);
    expect(f.helper.proof!.passed).toBe(false);
  });

  it('reconstructs hints for historical failed proofs while refusing historical acceptance', () => {
    const f = fixture(); delete f.helper.proof!.projectionDependencyHints;
    expect(f.connections()).toHaveLength(1);
    f.root.integratedCheck = structuredClone(f.root.integratedCheck!);
    expect(f.connections()).toEqual([]);
  });

  it('binds the failed task, source, recorded observation and current environment', () => {
    const f = fixture(), proof = f.helper.proof!;
    proof.sourceDigest = 'changed'; expect(f.connections()).toEqual([]);
    proof.sourceDigest = f.root.integratedCheck!.sourceDigest;
    proof.taskDigest = 'old-contract'; expect(f.connections()).toEqual([]);
    proof.taskDigest = taskVersion(f.helper.task);
    const hints = proof.projectionDependencyHints!;
    proof.projectionDependencyHints = hints.map(hint => ({ ...hint, id: 'changed' })); expect(f.connections()).toEqual([]);
    proof.projectionDependencyHints = hints;
    expect(reviewProjectionDependencies({ ...f.input, environmentDigest: 'another-environment' })).toEqual([]);
    expect(reviewProjectionDependencies({ ...f.input, canonicalCommit: 'missing-commit' })).toEqual([]);
    expect(reviewProjectionDependencies({ ...f.input, consumerTaskIds: [] })).toEqual([]);
  });

  it('requires the exact root declaration in both the current canonical and the accepted source', () => {
    const f = fixture();
    fs.writeFileSync(f.file, f.source.replace(':= by rfl', ':= by\n  rfl'));
    const changed = commitSolverSources(f.problem, f.workspace);
    expect(reviewProjectionDependencies({ ...f.input, canonicalCommit: changed })).toEqual([]);
    const proof = f.root.integratedCheck!;
    proof.commit = changed; proof.references!.sourceCommit = changed;
    markTaskAcceptance(proof);
    expect(f.connections()).toEqual([]);
  });

  it('offers the connection only for an actual failed, stalled frontier', () => {
    const f = fixture(), connections = f.connections();
    expect(connections).toHaveLength(1);
    f.helper.status = 'pending';
    expect(f.review().goals.find(goal => goal.taskId === 'goal')).toMatchObject({ stalled: false, candidates: [] });
    f.helper.status = 'blocked';
    f.helper.routeParking = ['existing-blocker'];
    expect(f.review().goals.find(goal => goal.taskId === 'goal')!.candidates.some(candidate => candidate.id === 'connect:helper:root')).toBe(true);
    delete f.helper.proof;
    expect(reviewGoalPaths(f.tasks, { environmentDigest: 'environment', projectionConnections: connections })
      .goals.find(goal => goal.taskId === 'goal')!.candidates.some(candidate => candidate.action === 'connect')).toBe(false);
  });

  it('does not cross a private task boundary or preserve a connection after either contract changes', () => {
    const f = fixture(), connections = f.connections();
    f.root.task = { ...f.root.task, sharing: 'group', groupId: 'private' };
    expect(f.connections()).toEqual([]);
    expect(reviewGoalPaths(f.tasks, { environmentDigest: 'environment', projectionConnections: connections })
      .goals.find(goal => goal.taskId === 'goal')!.candidates.some(candidate => candidate.action === 'connect')).toBe(false);
    f.root.task = f.plan.tasks.find(task => task.id === 'root')!;
    f.helper.task = { ...f.helper.task, revision: f.helper.task.revision + 1 };
    expect(f.connections()).toEqual([]);
  });
});

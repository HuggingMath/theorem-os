import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_EXAMPLE_PROOF } from '../src/math/localExample';
import type { MathematicsVerifierBatchRequest } from '../src/math/verifier';
import { checkTaskProof, checkTaskProofs, createTaskSourceProjector, TaskProofCache } from '../src/solver/cooperativeProof';
import { committedSource, commitSolverSources, type SolverProblem } from '../src/solver/problem';
import { taskVersion, type CooperativeTask, type TaskAssignment } from '../src/solver/tasks';
import { localExample } from './helpers/solver';
import { failedBatch, receiptBatch } from './helpers/verifier';
import { compactTaskSources } from '../src/solver/taskProjection';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, solverState } from './helpers/solver';

const host = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../src/math/verifier', async original => ({ ...await original<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify, formalVerificationToolIdentity: () => 'compact-fixture-tools',
}));
vi.mock('../src/math/mathProofEnvironment', async original => ({
  ...await original<typeof import('../src/math/mathProofEnvironment')>(), resolveMathProofEnvironment: () => undefined,
}));

describe('compact single-task proof checks', () => {
  let directory: string, workspace: string, file: string, problem: SolverProblem;
  let env: NodeJS.ProcessEnv, controller: AbortController, cache: TaskProofCache;
  const task: CooperativeTask = { id: 'helper', kind: 'lemma', objective: 'Check a small helper.',
    proofPath: 'Submission.lean', theoremName: 'Tutorial.helper', type: 'True', dependsOn: [], revision: 0 };
  const source = (extra = '') => LOCAL_EXAMPLE_PROOF.replace('theorem add_zero',
    'def anchor : Nat := 0\n\nlemma expensive : True := by trivial\n\n' +
    'lemma dependency : True := by trivial\n\n' +
    'lemma helper : True := by exact dependency\n\n' + extra + '\ntheorem add_zero');
  const write = (text: string) => { fs.writeFileSync(file, text); return commitSolverSources(problem, workspace); };
  const assignment = (seedCommit: string): TaskAssignment => ({ taskId: task.id,
    taskDigest: taskVersion(task), workerId: 'proof', seedCommit });
  const check = (commit: string, seed = commit) => checkTaskProof(problem, workspace, commit, task, assignment(seed), [],
    env, controller.signal, Infinity, [], 'environment', cache);
  const verified = (request: MathematicsVerifierBatchRequest) => receiptBatch(request, {
    sessionId: 'compact-fixture', receiptId: (_, name) => `receipt-${request.targetCommit}-${name}`,
  });
  const checkedSource = (request: MathematicsVerifierBatchRequest) =>
    committedSource(workspace, request.targetCommit!, `${problem.projectRelative}/Submission.lean`);

  beforeEach(() => {
    const example = localExample('compact-task-projection-');
    ({ directory, workspace, problem } = example);
    file = path.join(example.receipt.projectRoot, 'Submission.lean');
    const envFile = path.join(directory, 'math.env'); fs.writeFileSync(envFile, '');
    env = { PATH: '/usr/bin:/bin', DEEPSCIENTIST_MATH_ENV_FILE: envFile };
    controller = new AbortController(); cache = new TaskProofCache();
    host.verify.mockReset().mockImplementation(async request => verified(request));
  });
  afterEach(() => { controller.abort(); vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

  it('omits inherited unrelated certificates and retains the complete target dependency chain', async () => {
    const commit = write(source()), proof = await check(commit);
    const projected = checkedSource(host.verify.mock.calls[0]![0]);
    expect(projected).not.toContain('lemma expensive');
    expect(projected).toContain('lemma dependency');
    expect(projected).toContain('lemma helper');
    expect(projected).toContain('def anchor');
    expect(proof).toMatchObject({ passed: true, projectionMode: 'compact' });
    const hostProjection = createTaskSourceProjector(problem, workspace, commit,
      { compact: true, preserved: proof.changes })(task, []);
    expect(hostProjection.get('Submission.lean')).toBe(projected);
  });

  it('reuses the same kernel artifact after unrelated inherited helpers are appended', async () => {
    const first = write(source()), initial = await check(first);
    const second = write(source('lemma another : True := by trivial\n\n'));
    const next = await check(second);
    expect(second).not.toBe(first);
    expect(host.verify).toHaveBeenCalledOnce();
    expect(next.verification).toEqual(initial.verification);
    expect(next.projectionReuse).toBeDefined();
    expect(next.sourceDigest).not.toBe(initial.sourceDigest);
  });

  it('keeps changed sibling declarations in the independent check', async () => {
    const seed = write(source());
    const commit = write(source('lemma new_sibling : False := by trivial\n\n'));
    await check(commit, seed);
    expect(checkedSource(host.verify.mock.calls[0]![0])).toContain('lemma new_sibling : False');
  });

  it('retains attribute declarations, definition references and quoted tactic references', async () => {
    const text = source().replace('lemma helper : True := by exact dependency',
      'def proofRoot : True := expensive\n\n' +
      '@[simp]\nlemma simp_root : True := by trivial\n\n' +
      'private lemma hidden : True := by trivial\n\n' +
      'lemma helper : True := by\n  let name := "dependency"\n  exact dependency');
    const projected = compactTaskSources(problem, new Map([['Submission.lean', text]]), task, []).get('Submission.lean')!;
    for (const name of ['expensive', 'dependency', 'simp_root', 'hidden', 'proofRoot']) expect(projected).toContain(name);
  });

  it('falls back to the complete projection when a tactic needs an omitted declaration', async () => {
    host.verify.mockImplementation(async request => checkedSource(request).includes('lemma expensive') ? verified(request) :
      failedBatch(verified(request), { stdoutPreview: () => 'Submission.lean:8:1: error: unsolved goals\n⊢ True' }));
    const proof = await check(write(source()));
    expect(proof.passed).toBe(true);
    expect(proof.projectionMode).toBeUndefined();
    expect(host.verify).toHaveBeenCalledTimes(2);
  });

  it('validates compact evidence through the normal host seam, including a custom checker wrapper', async () => {
    const commit = write(source()), raw = await check(commit);
    const worker = leadWorker(problem, workspace), action = assignment(commit);
    const state = solverState(problem, workspace, { runId: 'compact-host', phase: 'running',
      cooperation: { canonicalCommit: commit, tasks: [{ task, assignment: action, status: 'delivered', proof: raw, attempts: 1 }] } });
    const cooperative = cooperativeResearch({ state, workers: [worker], retrievalRoot: workspace,
      access: new Map([[worker.id, { environment: env, retrievalRoot: workspace }]]), signal: controller.signal,
      exclusiveCheck: operation => operation() });
    try {
      const custom = (...args: Parameters<typeof checkTaskProof>) => checkTaskProof(...args);
      const modules = (cooperative as any).input.modules;
      (cooperative as any).input.modules = { ...modules, M2: { ...modules.M2, checkTask: custom } };
      expect(await (cooperative as any).check(task, action, workspace, commit, [], raw)).toMatchObject({ passed: true });
      const forged = structuredClone(raw);
      await expect((cooperative as any).check(task, action, workspace, commit, [], forged))
        .rejects.toThrow('math_task_check_identity_changed');
    } finally { await cooperative.stop(); }
  });

  it('does not retry infrastructure failures as a full projection', async () => {
    host.verify.mockImplementation(async request => ({ ...verified(request), status: 'unavailable',
      results: verified(request).results.map(result => ({ ...result, status: 'unavailable', error: 'verifier unavailable' })) }));
    const proof = await check(write(source()));
    expect(proof.passed).toBe(false);
    expect(host.verify).toHaveBeenCalledOnce();
  });

  it('keeps multi-target batches on one complete projection', async () => {
    const commit = write(source()), other = { ...task, id: 'dependency', theoremName: 'Tutorial.dependency' };
    const proofs = await checkTaskProofs(problem, workspace, commit, [task, other].map(item => ({ task: item,
      assignment: { ...assignment(commit), taskId: item.id, taskDigest: taskVersion(item) }, retainedGoals: [] })),
    env, controller.signal, Infinity, 'environment', cache);
    expect(proofs.every(proof => proof.passed && !proof.projectionMode)).toBe(true);
    expect(host.verify).toHaveBeenCalledOnce();
    expect(host.verify.mock.calls[0]![0].items).toHaveLength(2);
    expect(checkedSource(host.verify.mock.calls[0]![0])).toContain('lemma expensive');
  });
});

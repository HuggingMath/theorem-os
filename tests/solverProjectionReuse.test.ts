import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_EXAMPLE_PROOF } from '../src/math/localExample';
import type { MathematicsVerifierBatchRequest, MathematicsVerifierBatchResult } from '../src/math/verifier';
import type { CooperativeResearch } from '../src/solver/cooperation';
import { checkTaskProof, TaskProofCache, trustedTaskProjectionReuse, type TaskProof } from '../src/solver/cooperativeProof';
import { commitSolverSources, git, type SolverProblem } from '../src/solver/problem';
import { taskVersion, type CooperativeTask, type TaskAssignment } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, solverState } from './helpers/solver';
import { failedBatch, receiptBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../src/math/verifier', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify, formalVerificationToolIdentity: () => 'projection-reuse-fixture-tools',
}));
vi.mock('../src/math/mathProofEnvironment', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/mathProofEnvironment')>(), resolveMathProofEnvironment: () => undefined,
}));

describe('host validation of content-equivalent task projections', () => {
  let directory: string, workspace: string, problem: SolverProblem, task: CooperativeTask, assignment: TaskAssignment;
  let cooperative: CooperativeResearch, controller: AbortController, raw: TaskProof, sourceCommit: string;
  let environment: NodeJS.ProcessEnv;
  const check = (proof: TaskProof) => (cooperative as any).check(task, assignment, workspace, sourceCommit, [], proof) as Promise<TaskProof>;

  beforeEach(async () => {
    host.verify.mockReset().mockImplementation(async (request: MathematicsVerifierBatchRequest): Promise<MathematicsVerifierBatchResult> => {
      const sessionId = 'original-projection-check';
      return { schema: 'deepscientist.mathematics.verification-batch/v1', status: 'kernel_verified',
        targetCommit: request.targetCommit!, sessionId, events: [], startedAt: 1, checkedAt: 2, durationMs: 1,
        results: request.items.map((item, index) => ({ ...item, sourceDeclarationHash: item.expectedSourceDeclarationHash,
          status: 'kernel_verified', targetCommit: request.targetCommit!, claim: 'statement',
          checkId: `check-${index + 1}`, receiptId: `original-receipt-${index}`, sessionId, checkedAt: 2,
          declarationReferences: { statement: [], proof: [] } })) as MathematicsVerifierBatchResult['results'] };
    });
    const example = localExample('host-projection-reuse-'), receipt = example.receipt;
    ({ directory, workspace, problem } = example);
    const file = path.join(receipt.projectRoot, 'Submission.lean');
    fs.writeFileSync(file, LOCAL_EXAMPLE_PROOF);
    const seedCommit = commitSolverSources(problem, workspace);
    fs.writeFileSync(file, LOCAL_EXAMPLE_PROOF.replace('theorem add_zero', 'lemma helper : True := by trivial\ntheorem add_zero'));
    const first = commitSolverSources(problem, workspace);
    task = { id: 'helper', kind: 'lemma', objective: 'Prove the current helper.', proofPath: 'Submission.lean',
      theoremName: 'Tutorial.helper', type: 'True', dependsOn: [], revision: 0 };
    assignment = { taskId: task.id, taskDigest: taskVersion(task), seedCommit, workerId: 'solver' };
    controller = new AbortController();
    const envFile = path.join(directory, 'math.env');
    fs.writeFileSync(envFile, '');
    environment = { PATH: '/usr/bin:/bin', DEEPSCIENTIST_MATH_ENV_FILE: envFile };
    const cache = new TaskProofCache();
    await checkTaskProof(problem, workspace, first, task, assignment, [], environment, controller.signal, Infinity, [], 'environment', cache);
    git(workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--allow-empty', '--no-gpg-sign', '--quiet', '-m', 'Same content, new source commit']);
    sourceCommit = git(workspace, ['rev-parse', 'HEAD']);
    raw = await checkTaskProof(problem, workspace, sourceCommit, task, assignment, [], environment, controller.signal, Infinity, [], 'environment', cache);
    expect(host.verify).toHaveBeenCalledOnce();
    expect(trustedTaskProjectionReuse(raw)).toBeDefined();
    const state = solverState(problem, workspace, { runId: 'projection-reuse-fixture', phase: 'running',
      cooperation: { canonicalCommit: seedCommit, tasks: [{ task, assignment, status: 'delivered', proof: raw, attempts: 1 }] } });
    const worker = leadWorker(problem, workspace);
    cooperative = cooperativeResearch({ state, workers: [worker], retrievalRoot: workspace,
      access: new Map([[worker.id, { environment, retrievalRoot: workspace }]]), signal: controller.signal, exclusiveCheck: operation => operation() });
  });
  afterEach(() => { controller?.abort(); vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

  it('validates and pins both projections while keeping the checked receipt unchanged', async () => {
    const receipt = structuredClone(raw.verification), reuse = trustedTaskProjectionReuse(raw)!;
    const checked = await check(raw);
    expect(checked.passed).toBe(true);
    expect(checked.commit).toBe(sourceCommit);
    expect(checked.verification).toEqual(receipt);
    expect(checked.verification.targetCommit).toBe(reuse.checkedProjectionCommit);
    expect(reuse.projectionCommit).not.toBe(reuse.checkedProjectionCommit);
    expect(git(workspace, ['rev-parse', `${reuse.projectionCommit}^{tree}`])).toBe(reuse.projectionTree);
    expect(git(workspace, ['rev-parse', `${reuse.checkedProjectionCommit}^{tree}`])).toBe(reuse.projectionTree);
    expect((cooperative as any).pinned.has(reuse.projectionCommit)).toBe(true);
    expect((cooperative as any).pinned.has(reuse.checkedProjectionCommit)).toBe(true);
    expect(host.verify).toHaveBeenCalledOnce();
  });

  it('rechecks each member independently after a restored integration batch fails', async () => {
    const file = path.join(workspace, problem.projectRelative, 'Submission.lean');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('theorem add_zero',
      'lemma broken : True := by trivial\ntheorem add_zero'));
    const canonical = commitSolverSources(problem, workspace);
    const broken = { ...task, id: 'broken', theoremName: 'Tutorial.broken', objective: 'Check the broken helper' };
    const archive = (cooperative as any).archive;
    archive.canonicalCommit = canonical;
    archive.tasks = [task, broken].map(task => ({ task, status: 'integrated', attempts: 1,
      integratedCheck: { ...raw, taskDigest: taskVersion(task) } }));
    host.verify.mockReset().mockImplementation((request: MathematicsVerifierBatchRequest) => {
      const receipts = receiptBatch(request, { sessionId: 'restored-check', receiptId: (_, name) => `restore-${name}` });
      return request.items.length > 1 || request.items.some(item => item.theoremName === broken.theoremName)
        ? failedBatch(receipts, { stdoutPreview: file => `${file}:4:1: error: unsolved goals` }) : receipts;
    });
    await (cooperative as any).recheckIntegrated(canonical);
    expect(host.verify.mock.calls[0][0].items).toHaveLength(2);
    expect(host.verify.mock.calls.slice(1).every(([request]) => request.items.length === 1)).toBe(true);
    expect(archive.tasks.map(node => [node.task.id, node.status])).toEqual([['helper', 'integrated'], ['broken', 'blocked']]);
  });

  it.each(['recover', 'still-fails', 'no-fresh-goal', 'goal-already-checked'] as const)
  ('bounds restored recheck context recovery: %s', async mode => {
    const archive = (cooperative as any).archive;
    archive.canonicalCommit = sourceCommit;
    const goal: CooperativeTask = { id: 'original-goal', kind: 'goal', objective: 'Check the original.',
      proofPath: problem.targets[0]!.proofPath, theoremName: problem.targets[0]!.theoremName,
      dependsOn: ['no-fresh-goal', 'goal-already-checked'].includes(mode) ? [] : [task.id], revision: 0 };
    // Persisted receipts deliberately do not enter checkedDeliveries in this process.
    archive.tasks = [task, ...(mode === 'no-fresh-goal' ? [] : [goal])].map(task => ({ task,
      status: 'integrated', attempts: 1, integratedCheck: { ...raw, taskDigest: taskVersion(task) } }));
    if (mode === 'goal-already-checked') archive.tasks.reverse();
    const expectedStatus = ['recover', 'goal-already-checked'].includes(mode) ? 'integrated' : 'blocked';
    const emit = vi.fn(); (cooperative as any).input.emit = emit;
    const helperContexts: boolean[] = [];
    host.verify.mockReset().mockImplementation((request: MathematicsVerifierBatchRequest) => {
      const receipts = receiptBatch(request, { sessionId: 'context-recheck',
        receiptId: (_, name) => 'context-' + request.targetCommit + '-' + name });
      // Missing reference coverage preserves the explicit dependency contract.
      for (const result of receipts.results) if (result.theoremName === goal.theoremName)
        delete result.declarationReferences;
      if (!request.items.some(item => item.theoremName === task.theoremName)) return receipts;
      const source = fs.readFileSync(path.join(request.projectRoot, 'Submission.lean'), 'utf8');
      const retained = source.includes('theorem add_zero'); helperContexts.push(retained);
      return ['recover', 'goal-already-checked'].includes(mode) && retained ? receipts : failedBatch(receipts,
        { stdoutPreview: file => file + ':4:1: error: unknown identifier from omitted original context' });
    });
    await (cooperative as any).recheckIntegrated(sourceCommit);
    expect(archive.tasks.find((node: any) => node.task.id === task.id).status).toBe(expectedStatus);
    if (mode !== 'no-fresh-goal') expect(archive.tasks.find((node: any) => node.task.id === goal.id).status).toBe(expectedStatus);
    const retries = emit.mock.calls.filter(([event]) => event === 'task_recheck_context_retry');
    expect(retries).toHaveLength(mode === 'no-fresh-goal' ? 0 : 1);
    expect(helperContexts).toContain(false);
    if (mode !== 'no-fresh-goal') expect(helperContexts).toContain(true);
    expect(archive.recheck.completed).toBe(archive.tasks.length);
    expect(archive.recheck.completed).toBeLessThanOrEqual(archive.recheck.total);
  });

  it.each(['clone', 'json', 'changed-map', 'removed-map', 'changed-reference'] as const)
  ('rejects %s evidence before adding host annotations', async kind => {
    if (kind === 'clone') raw = structuredClone(raw);
    else if (kind === 'json') raw = JSON.parse(JSON.stringify(raw));
    else if (kind === 'changed-map') raw.projectionReuse = { ...raw.projectionReuse!, inputDigest: 'f'.repeat(64) };
    else if (kind === 'removed-map') delete raw.projectionReuse;
    else raw.references!.sourceCommit = 'e'.repeat(40);
    expect(trustedTaskProjectionReuse(raw)).toBeUndefined();
    await expect(check(raw)).rejects.toThrow('math_task_check_identity_changed');
    expect((cooperative as any).checkedDeliveries.has(raw)).toBe(false);
    expect(host.verify).toHaveBeenCalledOnce();
  });
});

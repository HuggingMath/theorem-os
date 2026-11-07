import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTaskChanges, taskChanges } from '../src/solver/cooperativeProof';
import { committedSource, commitSolverSources, git, withSolverWorktree, type SolverProblem } from '../src/solver/problem';
import { taskVersion, type CooperativeTask, type TaskRecord } from '../src/solver/tasks';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState, type LocalExample } from './helpers/solver';
import { failedBatch, receiptBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ verify: vi.fn(), environment: vi.fn(), createSession: vi.fn() }));
vi.mock('../src/math/verifier', async original => ({
  ...await original<typeof import('../src/math/verifier')>(), checkManyFormalVerifications: host.verify,
  formalVerificationToolIdentity: () => 'exact-source-fixture-tools',
}));
vi.mock('../src/math/mathProofEnvironment', async original => ({
  ...await original<typeof import('../src/math/mathProofEnvironment')>(), resolveMathProofEnvironment: host.environment,
}));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.createSession }));

describe('exact source task integration', () => {
  let example: LocalExample, directory: string, workspace: string, project: string, problem: SolverProblem;
  let seed: string, candidate: string, delivery: string, task: CooperativeTask;
  beforeEach(() => {
    example = localExample('exact-source-integration-');
    ({ directory, workspace, problem } = example); project = example.receipt.projectRoot;
    seed = fs.readFileSync(path.join(project, 'Submission.lean'), 'utf8');
    candidate = seed.replace('theorem add_zero',
      'def preservedText : String := "alpha\\n\\n  beta"\n\n\nlemma helper : True := by\n  trivial\n\n\ntheorem add_zero')
      .replace(':= by sorry', ':= by\n  have _ := helper\n  have _ := preservedText\n  rfl');
    task = { id: 'goal', kind: 'goal', objective: 'Prove the original target.', proofPath: problem.targets[0]!.proofPath,
      theoremName: problem.targets[0]!.theoremName, dependsOn: [], revision: 0 };
    host.verify.mockReset().mockImplementation(async request => receiptBatch(request,
      { sessionId: 'exact-source-fixture', receiptId: index => `fixture-${request.targetCommit}-${index}` }));
    host.environment.mockReset().mockReturnValue(undefined);
    host.createSession.mockReset().mockImplementation(() => { throw new Error('fixture_real_models_forbidden'); });
  });
  afterEach(() => {
    expect(host.createSession).not.toHaveBeenCalled();
    vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true });
  });
  const save = (seedCommit = problem.baseCommit) => {
    fs.writeFileSync(path.join(project, 'Submission.lean'), candidate);
    delivery = commitSolverSources(problem, workspace);
    return taskChanges(problem, workspace, delivery, task, { seedCommit });
  };

  it('keeps every source byte when the current owned sources equal the delivery seed', async () => {
    const changes = save();
    await withSolverWorktree(workspace, problem.baseCommit, async checkout => {
      const file = path.join(checkout, problem.projectRelative, 'Submission.lean');
      applyTaskChanges(problem, checkout, changes);
      expect(fs.readFileSync(file, 'utf8')).not.toBe(candidate);
      fs.writeFileSync(file, seed);
      applyTaskChanges(problem, checkout, changes, [], [], { commit: delivery, seedCommit: problem.baseCommit });
      expect(fs.readFileSync(file)).toEqual(Buffer.from(candidate));
    });
  });

  it('retains concurrent peer declarations through the original merge', async () => {
    const changes = save();
    await withSolverWorktree(workspace, problem.baseCommit, async checkout => {
      const file = path.join(checkout, problem.projectRelative, 'Submission.lean');
      fs.writeFileSync(file, seed.replace('theorem add_zero', 'lemma peer : True := by trivial\ntheorem add_zero'));
      applyTaskChanges(problem, checkout, changes, [], [], { commit: delivery, seedCommit: problem.baseCommit });
      const merged = fs.readFileSync(file, 'utf8');
      expect(merged).toContain('lemma peer : True := by trivial');
      expect(merged).toContain('lemma helper : True := by');
    });
  });

  it('checks all owned files before replacing the complete delivery', async () => {
    const helper = 'Helpers.lean', helperFile = path.join(project, helper);
    fs.writeFileSync(helperFile, 'def count : Nat := 1\n');
    problem = { ...problem, ownedFiles: [...problem.ownedFiles, helper] };
    const seedCommit = commitSolverSources(problem, workspace);
    const changes = save(seedCommit);
    await withSolverWorktree(workspace, seedCommit, async checkout => {
      fs.writeFileSync(path.join(checkout, problem.projectRelative, helper), 'def count : Nat := 2\n');
      applyTaskChanges(problem, checkout, changes, [], [], { commit: delivery, seedCommit });
      expect(fs.readFileSync(path.join(checkout, problem.projectRelative, helper), 'utf8')).toBe('def count : Nat := 2\n');
    });
  });

  it('does not import an omitted candidate change through the complete-source path', async () => {
    const changes = save().filter(change => change.name !== 'preservedText');
    await withSolverWorktree(workspace, problem.baseCommit, async checkout => {
      applyTaskChanges(problem, checkout, changes, [], [], { commit: delivery, seedCommit: problem.baseCommit });
      expect(fs.readFileSync(path.join(checkout, problem.projectRelative, 'Submission.lean'), 'utf8')).not.toContain('def preservedText');
    });
  });

  it('requires imported modules to match the authorized patch', async () => {
    const module = 'Mathlib.Data.Nat.Basic';
    candidate = `import ${module}\n` + candidate;
    const changes = save();
    await withSolverWorktree(workspace, problem.baseCommit, async checkout => {
      applyTaskChanges(problem, checkout, changes, [], [], { commit: delivery, seedCommit: problem.baseCommit });
      expect(fs.readFileSync(path.join(checkout, problem.projectRelative, 'Submission.lean'), 'utf8')).not.toContain(`import ${module}`);
    });
  });

  it('uses the original merge when discharging assumptions and preserves the checked dependency', async () => {
    const file = path.join(project, 'Submission.lean');
    seed = seed.replace('theorem add_zero', 'lemma dependency : True := by trivial\ntheorem add_zero');
    fs.writeFileSync(file, seed);
    const seedCommit = commitSolverSources(problem, workspace);
    candidate = seed.replace('dependency : True := by trivial', 'dependency : True := by sorry')
      .replace('theorem add_zero', 'lemma consumer : True := by exact dependency\n\n\ntheorem add_zero');
    const changes = save(seedCommit).filter(change => change.name !== 'dependency');
    const dependency: CooperativeTask = { id: 'dependency', kind: 'lemma', objective: 'Prove the premise.', type: 'True',
      proofPath: 'Submission.lean', theoremName: 'Tutorial.dependency', dependsOn: [], revision: 0 };
    await withSolverWorktree(workspace, seedCommit, async checkout => {
      applyTaskChanges(problem, checkout, changes, [], [dependency], { commit: delivery, seedCommit });
      const merged = fs.readFileSync(path.join(checkout, problem.projectRelative, 'Submission.lean'), 'utf8');
      expect(merged).toContain('lemma dependency : True := by trivial');
      expect(merged).not.toContain('dependency : True := by sorry');
      expect(merged).toContain('lemma consumer : True := by exact dependency');
    });
  });

  it.each(['statement', 'context', 'unowned'] as const)('retains the %s source guard on the complete-source path', async kind => {
    if (kind === 'statement') candidate = candidate.replace('n + 0 = n', 'n + 0 = 0');
    if (kind === 'context') candidate = candidate.replace('namespace Tutorial', 'namespace Tutorial\nopen Nat');
    fs.writeFileSync(path.join(project, 'Submission.lean'), candidate);
    git(workspace, ['add', '--', `${problem.projectRelative}/Submission.lean`]);
    git(workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--quiet', '--no-gpg-sign', '-m', 'Untrusted source guard fixture']);
    delivery = git(workspace, ['rev-parse', 'HEAD']);
    const changes = taskChanges(problem, workspace, delivery, undefined, { seedCommit: problem.baseCommit });
    await withSolverWorktree(workspace, problem.baseCommit, async checkout => {
      if (kind === 'unowned') fs.writeFileSync(path.join(checkout, 'outside.txt'), 'outside ownership\n');
      expect(() => applyTaskChanges(problem, checkout, changes, [], [], { commit: delivery, seedCommit: problem.baseCommit }))
        .toThrow(kind === 'statement' ? 'math_original_declaration_changed' : kind === 'context' ? 'math_original_context_changed' : 'math_source_outside_ownership');
    });
  });

  it('preserves the delivery projection and receipt through the actual single-task integration caller', async () => {
    host.environment.mockReturnValue({ identity: 'sealed-fixture' });
    const worker = peerWorker(example, 'engineer'), lead = leadWorker(problem, workspace);
    const env = { PATH: '/usr/bin:/bin', DEEPSCIENTIST_MATH_ENV_FILE: path.join(directory, 'missing.env') };
    // Distinct histories require the host's content-equivalent receipt rebind even
    // when both projection commits are created within the same timestamp second.
    git(worker.worktree, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit',
      '--allow-empty', '--quiet', '--no-gpg-sign', '-m', 'Distinct worker history']);
    fs.writeFileSync(path.join(worker.worktree, problem.projectRelative, 'Submission.lean'), candidate);
    const lake = path.join(worker.worktree, problem.projectRelative, '.lake');
    fs.mkdirSync(lake, { recursive: true });
    fs.writeFileSync(path.join(lake, 'package-overrides.json'), '{"path":"/engineer/packages"}\n');
    delivery = commitSolverSources(problem, worker.worktree);
    const assignment = { taskId: task.id, taskDigest: taskVersion(task), workerId: worker.id, seedCommit: problem.baseCommit };
    const node = { task, assignment, status: 'running' as const, attempts: 1 };
    const state = solverState(problem, workspace, { runId: 'exact-source-fixture', phase: 'running',
      cooperation: { canonicalCommit: problem.baseCommit, tasks: [node] } });
    const controller = new AbortController();
    const cooperative = cooperativeResearch({ state, workers: [lead, worker], retrievalRoot: directory,
      signal: controller.signal, access: new Map([lead, worker].map(item => [item.id, { environment: env, retrievalRoot: directory }])) });
    const cacheChecks = vi.spyOn((cooperative as any).taskProofCache, 'check');
    try {
      const proof = await (cooperative as any).check(task, assignment, worker.worktree, delivery);
      Object.assign(node, { status: 'delivered', proof });
      await (cooperative as any).integrateNow(node);
      const integrated = state.cooperation!.tasks[0]!;
      expect(integrated.status).toBe('integrated');
      expect(committedSource(workspace, state.cooperation!.canonicalCommit!, `${problem.projectRelative}/Submission.lean`)).toBe(candidate);
      expect(host.verify).toHaveBeenCalledOnce();
      expect(integrated.integratedCheck!.verification).toEqual(proof.verification);
      expect(cacheChecks).toHaveBeenCalledTimes(2);
      expect(cacheChecks.mock.calls[1]![0]).toBe(cacheChecks.mock.calls[0]![0]);
      expect(integrated.integratedCheck!.projectionReuse).toMatchObject({ checkedProjectionCommit: proof.verification.targetCommit });
    } finally { controller.abort(); await cooperative.stop(); }
  });

  const conflictingDelivery = async (declaration = 'lemma shared : True := by exact True.intro') => {
    task = { id: 'shared', kind: 'lemma', objective: 'Prove the shared statement.', type: 'True',
      proofPath: 'Submission.lean', theoremName: 'Tutorial.shared', dependsOn: [], revision: 0 };
    const worker = peerWorker(example, 'engineer'), lead = leadWorker(problem, workspace);
    const submittedSource = seed.replace('theorem add_zero',
      'lemma shared : True := by trivial\nlemma deliveryOnly : True := by trivial\ntheorem add_zero');
    fs.writeFileSync(path.join(worker.worktree, problem.projectRelative, 'Submission.lean'), submittedSource);
    const submittedCommit = commitSolverSources(problem, worker.worktree);
    const canonicalSource = seed.replace('theorem add_zero',
      `${declaration}\nlemma peerKept : True := by trivial\ntheorem add_zero`);
    fs.writeFileSync(path.join(project, 'Submission.lean'), canonicalSource);
    const canonical = commitSolverSources(problem, workspace);
    const assignment = { taskId: task.id, taskDigest: taskVersion(task), workerId: worker.id, seedCommit: problem.baseCommit };
    const node: TaskRecord = { task, assignment, status: 'running', attempts: 1 };
    const state = solverState(problem, workspace, { runId: 'canonical-conflict-fixture', phase: 'running',
      cooperation: { canonicalCommit: canonical, tasks: [node] } });
    const controller = new AbortController(), events: { event: string; [key: string]: unknown }[] = [];
    const cooperative = cooperativeResearch({ state, workers: [lead, worker], retrievalRoot: directory,
      signal: controller.signal, emit: (event, detail) => events.push({ event, ...detail }) });
    const proof = await (cooperative as any).check(task, assignment, worker.worktree, submittedCommit);
    Object.assign(node, { status: 'delivered', proof });
    host.verify.mockClear();
    return { node, state, cooperative, controller, proof, canonical, canonicalSource, events,
      finish: async () => { controller.abort(); await cooperative.stop(); } };
  };

  it('accepts a different canonical proof only after checking the exact task without overwriting peer work', async () => {
    const f = await conflictingDelivery();
    try {
      await (f.cooperative as any).integrateNow(f.node);
      expect(f.node.status).toBe('integrated');
      expect(f.state.cooperation!.canonicalCommit).toBe(f.canonical);
      expect(committedSource(workspace, f.canonical, `${problem.projectRelative}/Submission.lean`)).toBe(f.canonicalSource);
      expect(f.node.proof).toBe(f.proof);
      expect(f.node.integratedCheck).toMatchObject({ passed: true, commit: f.canonical, seedCommit: f.canonical,
        taskDigest: taskVersion(task), changes: [] });
      expect(f.node.integratedCheck!.conditions).toBeUndefined();
      expect(host.verify).toHaveBeenCalledOnce();
      const [request, options] = host.verify.mock.calls[0]!;
      expect(options.expectedDeclarationType).toBe('True');
      const checked = committedSource(workspace, request.targetCommit, `${problem.projectRelative}/Submission.lean`);
      expect(checked).toContain('lemma shared : True := by exact True.intro');
      expect(checked).not.toContain('deliveryOnly');
    } finally { await f.finish(); }
  });

  it.each([
    ['unproved', 'lemma shared : True := by sorry'],
    ['wrong type', 'lemma shared : False := by sorry'],
    ['extra premise', 'lemma shared (h : True) : True := by exact h'],
  ])('keeps the original conflict when the canonical declaration is %s', async (_kind, declaration) => {
    const f = await conflictingDelivery(declaration);
    host.verify.mockImplementation(async request => failedBatch(receiptBatch(request,
      { sessionId: 'canonical-rejected', receiptId: () => 'canonical-rejected' }),
    { stdoutPreview: () => 'Submission.lean:1:1: error: exact task is not proved', goalsRemaining: 1 }));
    try {
      await (f.cooperative as any).integrateNow(f.node);
      expect(host.verify).toHaveBeenCalled();
      for (const [, options] of host.verify.mock.calls) expect(options.expectedDeclarationType).toBe('True');
      expect(f.node.status).toBe('blocked');
      expect(f.node.feedback).toMatch(/^math_task_integration_conflict/u);
      expect(f.node.proof).toBe(f.proof);
      expect(f.node.integratedCheck?.passed).not.toBe(true);
      expect(f.state.cooperation!.canonicalCommit).toBe(f.canonical);
      expect(committedSource(workspace, f.canonical, `${problem.projectRelative}/Submission.lean`)).toBe(f.canonicalSource);
    } finally { await f.finish(); }
  });

  it('does not accept a missing canonical target when a different supporting declaration conflicts', async () => {
    const f = await conflictingDelivery('lemma deliveryOnly : True := by exact True.intro');
    try {
      await (f.cooperative as any).integrateNow(f.node);
      expect(f.node.status).toBe('blocked');
      expect(f.node.feedback).toMatch(/^math_task_integration_conflict/u);
      expect(f.node.integratedCheck?.passed).not.toBe(true);
      expect(f.node.proof).toBe(f.proof);
      expect(f.state.cooperation!.canonicalCommit).toBe(f.canonical);
      expect(committedSource(workspace, f.canonical, `${problem.projectRelative}/Submission.lean`)).not.toContain('lemma shared');
    } finally { await f.finish(); }
  });

  it('rechecks the new canonical when peer integration advances during conflict recovery', async () => {
    const f = await conflictingDelivery();
    let newer: string | undefined;
    host.verify.mockImplementationOnce(async request => {
      fs.writeFileSync(path.join(project, 'Submission.lean'), f.canonicalSource.replace('theorem add_zero',
        'lemma newestPeer : True := by trivial\ntheorem add_zero'));
      newer = commitSolverSources(problem, workspace);
      f.state.cooperation!.canonicalCommit = newer;
      return receiptBatch(request, { sessionId: 'superseded-canonical', receiptId: () => 'superseded-canonical' });
    });
    try {
      await (f.cooperative as any).integrateNow(f.node);
      expect(host.verify).toHaveBeenCalledTimes(2);
      expect(f.events).toContainEqual(expect.objectContaining({ event: 'task_integration_rebased',
        taskId: task.id, from: f.canonical, to: newer }));
      expect(f.node.status).toBe('integrated');
      expect(f.node.integratedCheck).toMatchObject({ passed: true, commit: newer, seedCommit: newer });
      expect(f.node.integratedCheck!.verification.results[0]!.receiptId).not.toBe('superseded-canonical');
      expect(f.state.cooperation!.canonicalCommit).toBe(newer);
      expect(committedSource(workspace, newer!, `${problem.projectRelative}/Submission.lean`)).toContain('newestPeer');
      expect(f.node.proof).toBe(f.proof);
    } finally { await f.finish(); }
  });

  it.each(['unavailable', 'abort'] as const)('propagates %s during canonical conflict verification', async outcome => {
    const f = await conflictingDelivery();
    host.verify.mockImplementationOnce(async request => {
      const batch = receiptBatch(request, { sessionId: 'canonical-interrupted', receiptId: () => 'canonical-interrupted' });
      if (outcome === 'abort') f.controller.abort();
      else { batch.status = 'unavailable'; for (const result of batch.results) result.status = 'unavailable'; }
      return batch;
    });
    try {
      const integration = (f.cooperative as any).integrateNow(f.node);
      if (outcome === 'abort') await expect(integration).rejects.toMatchObject({ name: 'AbortError' });
      else await expect(integration).rejects.toThrow('math_verifier_unavailable');
      expect(f.node.status).not.toBe('integrated');
      expect(f.node.integratedCheck?.passed).not.toBe(true);
      expect(f.state.cooperation!.canonicalCommit).toBe(f.canonical);
      expect(f.node.proof).toBe(f.proof);
    } finally { await f.finish(); }
  });
});

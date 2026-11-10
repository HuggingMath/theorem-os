import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import type { MathematicsVerifierBatchRequest } from '../src/math/verifier';
import type { SolverRunState } from '../src/solver/archive';
import { parseCooperationPlan, type CooperativeResearch } from '../src/solver/cooperation';
import { checkTaskProof } from '../src/solver/cooperativeProof';
import { directSolverModules } from '../src/solver/modules';
import type { ResearchWorker } from '../src/solver/modules/organization';
import { committedSource, commitSolverSources, git, readSolverProblem } from '../src/solver/problem';
import { TaskTypePreflightCache } from '../src/solver/taskTypePreflight';
import { freshlyAccepted, taskVersion } from '../src/solver/tasks';
import { deferred } from './helpers/async';
import { cooperativeResearch } from './helpers/cooperation';
import { temporaryDirectory } from './helpers/files';
import { newestLeanBinary } from './helpers/lean';
import { leadWorker, solverState } from './helpers/solver';
import { failedBatch, receiptBatch, verifiedBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ verify: vi.fn(), model: vi.fn() }));
vi.mock('../src/math/verifier', async original => ({ ...await original<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify, formalVerificationToolIdentity: () => 'canonical-goal-fixture-tools',
}));
vi.mock('../src/math/mathProofEnvironment', async original => ({
  ...await original<typeof import('../src/math/mathProofEnvironment')>(), resolveMathProofEnvironment: () => undefined,
}));

const source = [
  'namespace Canonical',
  'theorem already (n : Nat) : n + 0 = n := by rfl',
  'theorem usesAlready (n : Nat) : n + 0 = n := by exact already n',
  'def value (n : Nat) : Nat := n',
  'theorem unfinished : True := by sorry',
  'end Canonical', '',
].join('\n');

describe('canonical original goals before model dispatch', () => {
  let directory: string, state: SolverRunState, workers: ResearchWorker[], cooperative: CooperativeResearch;
  let controller: AbortController, allowed: boolean, environment: NodeJS.ProcessEnv, emit: ReturnType<typeof vi.fn>;
  let exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  const budget = { maxTurns: Infinity, remainingMs: Infinity };
  const node = (id = 'already') => state.cooperation!.tasks.find(item => item.task.id === id)!;
  const canonical = () => committedSource(workers[0].worktree, state.cooperation!.canonicalCommit!,
    `${state.problem.projectRelative}/Submission.lean`);
  const verified = (request: MathematicsVerifierBatchRequest) => verifiedBatch(request, { sessionId: 'canonical-goal-fixture', checks: true });
  const next = (index = 1) => cooperative.next(workers[index], budget);
  const activate = (id: string) => {
    for (const record of state.cooperation!.tasks.filter(item => item.task.kind === 'goal'))
      record.task = { ...record.task, status: record.task.id === id ? 'active' : 'paused' };
    node('followup').task = { ...node('followup').task, dependsOn: [id] };
  };
  const writeCanonical = (text: string) => {
    fs.writeFileSync(path.join(workers[0].worktree, state.problem.projectRelative, 'Submission.lean'), text);
    state.cooperation!.canonicalCommit = commitSolverSources(state.problem, workers[0].worktree);
  };
  const noAcceptance = (id = 'already') => {
    expect(state.cooperation!.deliveries ?? []).toEqual([]);
    expect(state.cooperation!.failedTaskInputs ?? []).toEqual([]);
    expect(node(id).proof).toBeUndefined(); expect(node(id).integratedCheck).toBeUndefined();
    expect(node(id).attempts).toBe(0); expect(state.turns).toBe(0);
    expect(state.cooperation!.groups![0].turns).toBe(0);
  };
  const holdVerifier = () => {
    const entered = deferred<MathematicsVerifierBatchRequest>(), release = deferred<void>();
    host.verify.mockImplementationOnce(async (request: MathematicsVerifierBatchRequest) => {
      entered.resolve(request); await release.promise; return verified(request);
    });
    return { entered: entered.promise, release: () => release.resolve() };
  };

  beforeEach(() => {
    directory = temporaryDirectory('solver-canonical-original-goal-');
    const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), {
      source, task: 'Prove the original targets.', definitionTargets: ['Canonical.value'],
    });
    const workspace = receipt.workspaceRoot, problem = readSolverProblem(workspace, receipt.activeProblemPath);
    workers = [leadWorker(problem, workspace), ...['proof', 'other'].map(id => {
      const worktree = path.join(directory, id);
      git(workspace, ['worktree', 'add', '--quiet', '--detach', worktree, problem.baseCommit]);
      return { id, worktree, role: 'researcher' as const, ownedFiles: problem.ownedFiles };
    })];
    const plan = parseCooperationPlan(problem, { tasks: [
      ...problem.targets.map(target => ({ id: target.theoremName.split('.').at(-1)!, kind: 'goal', objective: 'Original goal',
        proofPath: target.proofPath, theoremName: target.theoremName, ownerId: 'proof',
        status: target.theoremName === 'Canonical.already' ? 'active' : 'paused' })),
      { id: 'followup', kind: 'research', objective: 'Use the checked original', dependsOn: ['already'], ownerId: 'proof' },
      { id: 'independent', kind: 'research', objective: 'Independent work', ownerId: 'other' },
    ], groups: [{ id: 'main', objective: 'Original problem', status: 'active', maxConcurrent: 1 }] });
    state = solverState(problem, workspace, { runId: 'canonical-goal-fixture', phase: 'running',
      cooperation: { canonicalCommit: problem.baseCommit, groups: plan.groups.map(group => ({ group, turns: 0 })),
        tasks: plan.tasks.map(task => ({ task, attempts: 0, status: 'pending' })) } });
    const envFile = path.join(directory, 'fixture.env'); fs.writeFileSync(envFile, '');
    environment = { PATH: '/usr/bin:/bin', DEEPSCIENTIST_MATH_ENV_FILE: envFile };
    controller = new AbortController(); allowed = true; emit = vi.fn(); exclusive = operation => operation();
    host.verify.mockReset().mockImplementation(async request => verified(request));
    host.model.mockReset().mockImplementation(() => { throw new Error('fixture_models_forbidden'); });
    cooperative = cooperativeResearch({ state, workers, retrievalRoot: directory, signal: controller.signal, emit,
      access: new Map(workers.map(worker => [worker.id, { environment, retrievalRoot: directory }])),
      modelDispatchAllowed: () => allowed, exclusiveCheck: operation => exclusive(operation),
      modules: { ...directSolverModules, M1: { ...directSolverModules.M1, open: host.model, execute: host.model } } });
    vi.spyOn(TaskTypePreflightCache.prototype, 'check').mockImplementation(async () => {
      throw new Error('original_goal_must_not_use_helper_type_preflight');
    });
  });
  afterEach(async () => {
    controller.abort(); await cooperative.stop(); expect(host.model).not.toHaveBeenCalled();
    vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each(['already', 'value'] as const)('checks a complete original %s independently, without a library or model attempt', async id => {
    activate(id);
    const before = canonical();
    expect(node(id).task.type).toBeUndefined();
    expect(await next()).toMatchObject({ kind: 'task', task: { id: 'followup' } });
    expect(node(id)).toMatchObject({ status: 'integrated', attempts: 0, proof: { passed: true, changes: [] },
      integratedCheck: { passed: true, changes: [] } });
    expect(freshlyAccepted(node(id), taskVersion(node(id).task))).toBe(true);
    expect(freshlyAccepted(structuredClone(node(id)), taskVersion(node(id).task))).toBe(false);
    expect(host.verify).toHaveBeenCalledOnce();
    expect(host.verify.mock.calls[0][0].items).toHaveLength(1);
    expect(host.verify.mock.calls[0][0].items[0].theoremName).toBe(`Canonical.${id}`);
    expect(host.verify.mock.calls[0][1].expectedDeclarationType).toBeUndefined();
    expect(state.cooperation!.tasks.filter(item => item.task.kind === 'goal' && item.task.id !== id)
      .every(item => item.status === 'pending' && !item.proof)).toBe(true);
    expect(state.check).toBeUndefined(); expect(state.turns).toBe(0); expect(state.cooperation!.groups![0].turns).toBe(0);
    expect(state.cooperation!.deliveries).toContainEqual(expect.objectContaining({ taskId: id, kind: 'proof', status: 'verified' }));
    expect(canonical()).toBe(before);
  });

  it('makes a rejected existing proof advisory input and returns ordinary model work without failure memory', async () => {
    host.verify.mockImplementationOnce(async request => failedBatch(verified(request),
      { stdoutPreview: () => 'Submission.lean:2:1: error: inherited proof does not close this target' }));
    const action = await next();
    expect(action).toMatchObject({ kind: 'task', task: { id: 'already' } });
    if (action?.kind !== 'task') throw new Error('expected_task_assignment');
    expect(action.assignment.canonicalProbe).toMatchObject({ evidence: 'advisory-canonical-check', proofAcceptance: 'not-accepted',
      sourceCommit: action.assignment.seedCommit, environmentDigest: state.environmentDigest, verificationStatus: 'failed' });
    expect(action.assignment.canonicalProbe!.feedback).toContain('inherited proof does not close');
    expect(action.assignment.canonicalProbe!.receiptIds).toHaveLength(1);
    expect(node().status).toBe('running'); expect(node().repair).toBeUndefined();
    expect(node().feedback).toBeUndefined(); expect(host.verify).toHaveBeenCalledOnce(); noAcceptance();
  });

  it('falls through after checker unavailability with bounded advisory diagnostics', async () => {
    (cooperative as any).input.modules.M2 = { ...directSolverModules.M2,
      checkTask: vi.fn().mockRejectedValue(new Error('fixture_checker_unavailable: ' + '诊断'.repeat(3000))) };
    const action = await next();
    expect(action).toMatchObject({ kind: 'task', task: { id: 'already' } });
    if (action?.kind !== 'task') throw new Error('expected_task_assignment');
    expect(action.assignment.canonicalProbe).toMatchObject({ evidence: 'advisory-canonical-check', proofAcceptance: 'not-accepted' });
    expect(action.assignment.canonicalProbe!.feedback).toContain('fixture_checker_unavailable');
    expect(Buffer.byteLength(action.assignment.canonicalProbe!.feedback)).toBeLessThanOrEqual(2000);
    expect(action.assignment.canonicalProbe!.feedback).not.toContain('\uFFFD');
    expect(host.verify).not.toHaveBeenCalled(); noAcceptance();
  });

  it.each(['sorry', 'admit', 'saved-assignment', 'conditional', 'wrong-namespace', 'not-original', 'duplicate-leaf'] as const)
  ('keeps %s work on the model path without a canonical probe', async kind => {
    if (kind === 'sorry') activate('unfinished');
    if (kind === 'admit') { activate('unfinished'); writeCanonical(source.replace('by sorry', 'by admit')); }
    if (kind === 'saved-assignment') node().assignment = { taskId: 'already', taskDigest: taskVersion(node().task),
      workerId: workers[1].id, seedCommit: state.cooperation!.canonicalCommit!, assignmentId: 'saved-goal' };
    if (kind === 'conditional') node().task = { ...node().task, conditional: true };
    if (kind === 'wrong-namespace') node().task = { ...node().task, theoremName: 'Other.already' };
    if (kind === 'not-original') {
      node().task = { ...node().task, theoremName: 'Canonical.extra' };
      writeCanonical(source.replace('theorem unfinished', 'theorem extra : True := by trivial\ntheorem unfinished'));
    }
    if (kind === 'duplicate-leaf') writeCanonical(source.replace('theorem unfinished',
      'theorem Other.already : True := by trivial\ntheorem unfinished'));
    const saved = node().assignment, id = kind === 'sorry' || kind === 'admit' ? 'unfinished' : 'already';
    expect(await next()).toMatchObject({ kind: 'task', task: { id } });
    if (kind === 'saved-assignment') expect(node().assignment).toBe(saved);
    expect(host.verify).not.toHaveBeenCalled(); noAcceptance(id);
  });

  it('preserves conditional connection work when an explicit helper dependency is not checked', async () => {
    node().task = { ...node().task, dependsOn: ['child'] };
    state.cooperation!.tasks.push({ task: { id: 'child', kind: 'lemma', theoremName: 'Canonical.child', type: 'True',
      proofPath: 'Submission.lean', objective: 'Unproved dependency', ownerId: 'other', revision: 0, dependsOn: [] },
      status: 'pending', attempts: 0 });
    expect(await next()).toMatchObject({ kind: 'task', task: { id: 'already' },
      assignment: { connectionCheck: expect.any(Object) } });
    expect(host.verify).not.toHaveBeenCalled(); noAcceptance();
  });

  it.each(['header', 'context'] as const)('keeps the frozen %s constraint in the independent checker', async change => {
    const changed = change === 'header' ? source.replace('n + 0 = n := by rfl', 'True := by trivial') :
      source.replace('namespace Canonical', 'namespace Canonical\nset_option autoImplicit false');
    fs.writeFileSync(path.join(workers[0].worktree, state.problem.projectRelative, 'Submission.lean'), changed);
    const error = `math_original_${change === 'header' ? 'declaration' : 'context'}_changed`;
    expect(() => commitSolverSources(state.problem, workers[0].worktree)).toThrow(error);
    // A bad archived commit must not bypass the independent checker even if it
    // entered Git without the ordinary host writer's frozen-source checks.
    git(workers[0].worktree, ['add', '--', `${state.problem.projectRelative}/Submission.lean`]);
    git(workers[0].worktree, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost',
      'commit', '--no-gpg-sign', '--quiet', '-m', 'Deliberately invalid archived source']);
    const commit = git(workers[0].worktree, ['rev-parse', 'HEAD']);
    await expect(checkTaskProof(state.problem, workers[0].worktree, commit, node().task,
      { taskId: 'already', taskDigest: taskVersion(node().task), workerId: workers[0].id, seedCommit: commit },
      [], environment, controller.signal)).rejects.toThrow(error);
    noAcceptance(); expect(host.verify).not.toHaveBeenCalled();
  });

  it('does not probe a complete definition in place of the original theorem kind', async () => {
    writeCanonical(source.replace('theorem already', 'def already'));
    expect(await next()).toMatchObject({ kind: 'task', task: { id: 'already' } });
    noAcceptance(); expect(host.verify).not.toHaveBeenCalled();
  });

  it('lets independent work dispatch while an original proof check is running', async () => {
    state.cooperation!.groups![0].group.maxConcurrent = 2;
    const held = holdVerifier(), pending = next(); await held.entered;
    expect(node()).toMatchObject({ status: 'pending', attempts: 0 }); expect(node().assignment).toBeUndefined();
    try { expect(await next(2)).toMatchObject({ kind: 'task', task: { id: 'independent' } }); }
    finally { held.release(); }
    expect(await pending).toMatchObject({ kind: 'task', task: { id: 'followup' } });
    expect(host.verify).toHaveBeenCalledOnce();
  });

  it.each(['source', 'contract', 'paused', 'route', 'worker-environment', 'lead-environment', 'worker-head', 'worker-stopped', 'problem-receipt'] as const)
  ('discards a result when its %s changes while the original proof is checked', async change => {
    // Observe one dispatch only, so its own identity gate must discard the
    // result even though model admission remains open for a later dispatch.
    const held = holdVerifier(), pending = (cooperative as any).nextPeer(workers[1], budget, true); await held.entered;
    try {
      if (change === 'source') {
        git(workers[0].worktree, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost',
          'commit', '--allow-empty', '--no-gpg-sign', '--quiet', '-m', 'New canonical']);
        state.cooperation!.canonicalCommit = git(workers[0].worktree, ['rev-parse', 'HEAD']);
      }
      if (change === 'contract') node().task = { ...node().task, revision: node().task.revision + 1 };
      if (change === 'paused') node().task = { ...node().task, status: 'paused' };
      if (change === 'route') state.cooperation!.groups![0].group.status = 'paused';
      if (change.endsWith('-environment')) (cooperative as any).input.access.set(workers[change === 'lead-environment' ? 0 : 1].id,
        { environment: {}, retrievalRoot: directory });
      if (change === 'worker-head') git(workers[1].worktree, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost',
        'commit', '--allow-empty', '--no-gpg-sign', '--quiet', '-m', 'Worker advanced']);
      if (change === 'worker-stopped') cooperative.stopped(workers[1]);
      if (change === 'problem-receipt') state.problem = { ...state.problem, receiptDigest: 'changed-receipt' };
    } finally { held.release(); }
    expect(typeof await pending).toBe('symbol'); expect(allowed).toBe(true); noAcceptance();
    expect(node().status).toBe('pending'); expect(node().assignment).toBeUndefined();
    expect(emit.mock.calls.some(call => call[0] === 'task_canonical_probe')).toBe(false);
  });

  it('rechecks publication identity after waiting for the canonical transaction', async () => {
    const entered = deferred<void>(), release = deferred<void>();
    exclusive = async operation => { entered.resolve(); await release.promise; return operation(); };
    const pending = next(); await entered.promise;
    try {
      writeCanonical(source + '-- New canonical snapshot\n'); allowed = false; cooperative.modelBudgetChanged();
    } finally { release.resolve(); }
    expect(await pending).toBeUndefined(); noAcceptance(); expect(node().assignment).toBeUndefined();
  });

  it('waits for cancelled original proof checks to release their worktrees before stop returns', async () => {
    const before = git(workers[0].worktree, ['worktree', 'list', '--porcelain']);
    const held = holdVerifier(), pending = next(); await held.entered;
    let stopped = false;
    const stopping = cooperative.stop().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    try { expect(stopped).toBe(false); } finally { held.release(); }
    expect(await pending).toBeUndefined(); await stopping;
    noAcceptance(); expect(node().assignment).toBeUndefined(); expect(stopped).toBe(true);
    expect(git(workers[0].worktree, ['worktree', 'list', '--porcelain'])).toBe(before);
  });

  it('checks complete original theorem and def bodies with native Lean, retaining only freshly accepted original inputs', async () => {
    const lean = newestLeanBinary();
    if (!lean) throw new Error('Native Lean is required for canonical original-goal regression.');
    const native: { theorem: string; source: string; output: string }[] = [];
    host.verify.mockImplementation(async (request: MathematicsVerifierBatchRequest) => {
      const text = committedSource(workers[0].worktree, request.targetCommit!, `${state.problem.projectRelative}/Submission.lean`);
      const file = path.join(directory, 'NativeCanonicalCheck.lean');
      fs.writeFileSync(file, text + '\n' + request.items.map(item => `#print ${item.theoremName}\n#print axioms ${item.theoremName}`).join('\n'));
      const result = spawnSync(lean, [file], { cwd: request.projectRoot, encoding: 'utf8', timeout: 20_000 });
      expect(result.error).toBeUndefined();
      const output = `${result.stdout}${result.stderr}`;
      for (const item of request.items) native.push({ theorem: item.theoremName!, source: text, output });
      const batch = receiptBatch(request, { sessionId: 'native-canonical-goal-fixture',
        receiptId: (_, name) => `native-${request.targetCommit}-${name}` });
      return result.status === 0 && !output.includes('sorryAx') && !/\b(?:sorry|admit)\b/u.test(text)
        ? batch : failedBatch(batch, { stdoutPreview: () => output });
    });
    for (const id of ['already', 'usesAlready', 'value']) {
      activate(id);
      const action = await next();
      expect(action).toMatchObject({ kind: 'task', task: { id: 'followup' } });
      expect(node(id).status, JSON.stringify(node(id).assignment?.canonicalProbe ?? native.at(-1))).toBe('integrated');
      expect(freshlyAccepted(node(id), taskVersion(node(id).task))).toBe(true);
      expect(node(id).attempts).toBe(0);
      if (action) cooperative.release(workers[1], action);
    }
    expect(native.map(item => item.theorem)).toEqual(['Canonical.already', 'Canonical.usesAlready', 'Canonical.value']);
    expect(native.find(item => item.theorem === 'Canonical.usesAlready')!.source).toContain('theorem already');
    expect(native.every(item => !item.source.includes('theorem unfinished') && !item.output.includes('sorryAx'))).toBe(true);
    expect(canonical()).toBe(source); expect(node('unfinished').proof).toBeUndefined(); expect(state.turns).toBe(0);
  });
});

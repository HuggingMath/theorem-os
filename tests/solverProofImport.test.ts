import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { readSolverRunState, writeSolverRunState, type SolverRunState } from '../src/solver/archive';
import { CooperativeResearch } from '../src/solver/cooperation';
import { applyTaskChanges } from '../src/solver/cooperativeProof';
import { directSolverModules, type SolverModules } from '../src/solver/modules';
import { committedSource, git } from '../src/solver/problem';
import { importAssignedProof, proofFragmentChanges, queueProofImport, syncProofImports } from '../src/solver/proofImport';
import type { ProofImportRequest } from '../src/solver/proofImportRecord';
import { runResearchWorkers } from '../src/solver/research';
import { parseCooperationPlan, type CooperativeAction } from '../src/solver/tasks';
import { WorkerProofLifecycle } from '../src/solver/workerProofLifecycle';
import { deferred } from './helpers/async';
import { cooperativeResearch, workerAccess } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';
import { failedBatch, receiptBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../src/math/mathBuildManifest', () => ({ readMathBuildManifest: vi.fn() }));
vi.mock('../src/math/verifier', async original => ({ ...await original<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify, formalVerificationToolIdentity: () => undefined,
  resolveMathematicsLakePackagesCache: () => undefined,
}));
type TaskAction = Extract<CooperativeAction, { kind: 'task' }>;

describe('deterministic host proof imports', () => {
  const fixtures: ReturnType<typeof fixture>[] = [];
  const batch = (request: Parameters<typeof receiptBatch>[0]) => receiptBatch(request, {
    sessionId: 'proof-import-fixture', receiptId: (_, name) => `import-${request.targetCommit}-${name}` });
  beforeEach(() => { host.verify.mockReset().mockImplementation(async request => batch(request)); });
  afterEach(async () => {
    for (const current of fixtures.splice(0)) {
      current.controller.abort(); await Promise.allSettled(current.instances.map(value => value.stop()));
      fs.rmSync(current.directory, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  function fixture() {
    const example = localExample('solver-proof-import-', 'lead');
    const { directory, problem, workspace } = example, writer = peerWorker(example, 'writer', { role: 'engineer' });
    const workers = [leadWorker(problem, workspace, 'lead'), writer];
    const plan = parseCooperationPlan(problem, { tasks: [
      ...problem.targets.map((target, index) => ({ id: `goal_${index}`, kind: 'goal', ...target,
        objective: 'Original target', status: 'paused' })),
      { id: 'helper', kind: 'lemma', type: 'True', theoremName: 'Tutorial.helper',
        proofPath: 'Submission.lean', objective: 'Prove the helper', ownerId: 'writer' },
    ] });
    let state = solverState(problem, workspace, { runId: 'proof-import', phase: 'prepared', failures: [],
      workers: workers.map(worker => ({ ...worker, phase: 'prepared', turns: 0 })),
      cooperation: { canonicalCommit: problem.baseCommit, tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
        groups: plan.groups.map(group => ({ group, turns: 0 })) } });
    const stateFile = path.join(directory, 'state.json'), fragmentFile = path.join(directory, 'external.lean');
    fs.writeFileSync(fragmentFile, 'lemma helper : True := by trivial\n');
    const controller = new AbortController(), instances: CooperativeResearch[] = [];
    const events: { event: string; details?: Record<string, unknown> }[] = [];
    const emit = (event: string, details?: Record<string, unknown>) => events.push({ event, details });
    const save = () => writeSolverRunState(stateFile, state);
    const create = () => {
      const value = cooperativeResearch({ state, workers, retrievalRoot: directory, signal: controller.signal, save, emit });
      instances.push(value); return value;
    };
    let cooperation = create(); state.cooperation!.planVersion = (cooperation as any).planVersion(); save();
    const sourceFile = path.join(writer.worktree, problem.projectRelative, 'Submission.lean');
    const original = fs.readFileSync(sourceFile, 'utf8');
    const queue = (input: Partial<Parameters<typeof queueProofImport>[1]> = {}, dryRun = false) => queueProofImport(stateFile, {
      taskId: 'helper', fragmentFile, sha256: mathDigest(fs.readFileSync(fragmentFile)),
      baseVersion: state.cooperation!.planVersion!, ...input }, dryRun);
    const assign = async () => {
      const action = await cooperation.next(writer, { maxTurns: Infinity, remainingMs: Infinity });
      if (action?.kind !== 'task') throw new Error('fixture_missing_assignment');
      return action;
    };
    const close = vi.fn(async () => {});
    const lifecycle = () => new WorkerProofLifecycle({ state, research: state.workers![1], worker: writer,
      cooperation, close, save, emit, checked: () => {} });
    const consume = (action: TaskAction, value: Pick<WorkerProofLifecycle, 'resumeFrozen'> = lifecycle()) => importAssignedProof({
      state, directory, worker: writer, action, cooperation, lifecycle: value, close, save, emit });
    const reload = () => { state = readSolverRunState(stateFile); cooperation = create(); };
    const current = { ...example, workers, writer, stateFile, fragmentFile, sourceFile, original,
      controller, instances, events, save, queue, assign, close, lifecycle, consume, reload,
      get state() { return state; }, get cooperation() { return cooperation; } };
    fixtures.push(current); return current;
  }

  it('rejects a wrong hash and stale CAS without changing the checkpoint or creating an intake log', async () => {
    const f = fixture(), before = fs.readFileSync(f.stateFile);
    await expect(f.queue({ sha256: '0'.repeat(64) })).rejects.toThrow('math_proof_import_hash_mismatch');
    await expect(f.queue({ baseVersion: 'stale' })).rejects.toThrow('math_proof_import_version_conflict');
    expect(fs.readFileSync(f.stateFile)).toEqual(before);
    expect(fs.existsSync(path.join(f.directory, 'proof-imports.jsonl'))).toBe(false);
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('captures immutable bytes, provides idempotence, and rejects a conflicting id or second pending import', async () => {
    const f = fixture(), before = fs.readFileSync(f.stateFile);
    expect(await f.queue({ id: 'one' }, true)).toMatchObject({ status: 'validated' });
    expect(await f.queue({ id: 'one' })).toMatchObject({ status: 'queued' });
    expect(await f.queue({ id: 'one' })).toMatchObject({ status: 'already_queued' });
    await expect(f.queue({ id: 'two' })).rejects.toThrow('math_proof_import_task_queued');
    fs.writeFileSync(f.fragmentFile, 'lemma helper : True := by exact True.intro\n');
    await expect(f.queue({ id: 'one' })).rejects.toThrow('math_proof_import_id_conflict');
    expect(fs.readFileSync(f.stateFile)).toEqual(before);
    const request = JSON.parse(fs.readFileSync(path.join(f.directory, 'proof-imports.jsonl'), 'utf8'));
    expect(request.fragment).toBe('lemma helper : True := by trivial\n');
    expect(request.fragmentSha256).toBe(mathDigest(request.fragment));
    await f.assign(); f.save();
    await expect(f.queue({ id: 'busy' })).rejects.toThrow('math_proof_import_task_busy');
  });

  it('exposes a working standalone import-proof CLI', () => {
    const f = fixture(), bun = process.env.BUN_EXEC_PATH ?? 'bun';
    const result = spawnSync(bun, ['bin/math.ts', 'import-proof', '--run', f.stateFile, '--task', 'helper',
      '--fragment', f.fragmentFile, '--sha256', mathDigest(fs.readFileSync(f.fragmentFile)),
      '--base-version', f.state.cooperation!.planVersion!], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ status: 'queued', taskId: 'helper' });
    expect(f.state.cooperation!.proofImports).toBeUndefined();
  });

  it('appends multiple lemmas through the existing source merger without changing original declarations', () => {
    const f = fixture(), fragment = 'lemma first : True := by trivial\n\nlemma helper : True := by exact first\n';
    const prepared = proofFragmentChanges(f.original, { fragment, proofPath: 'Submission.lean', theoremName: 'Tutorial.helper' });
    applyTaskChanges(f.problem, f.writer.worktree, prepared.changes);
    const source = fs.readFileSync(f.sourceFile, 'utf8');
    expect(source).toBe(prepared.source); expect(source.replace(/lemma first[\s\S]*?(?=end Tutorial)/u, '')).toBe(f.original);
    expect(proofFragmentChanges(source, { fragment, proofPath: 'Submission.lean', theoremName: 'Tutorial.helper' }).changes).toEqual([]);
    expect(() => proofFragmentChanges(source, { fragment: 'lemma helper : True := by exact True.intro\n',
      proofPath: 'Submission.lean', theoremName: 'Tutorial.helper' })).toThrow('math_proof_import_declaration_conflict');
  });

  it.each([
    'import Mathlib\nlemma helper : True := by trivial\n',
    'namespace Tutorial\nlemma helper : True := by trivial\nend Tutorial\n',
    'set_option maxRecDepth 0\nlemma helper : True := by trivial\n',
    '@[simp] lemma helper : True := by trivial\n',
    'def helper : True := by trivial\n',
    'lemma helper : True := by sorry\n',
    'axiom helper : True\n',
  ])('rejects source commands and incomplete declarations: %s', fragment => {
    const f = fixture();
    expect(() => proofFragmentChanges(f.original, { fragment, proofPath: 'Submission.lean', theoremName: 'Tutorial.helper' })).toThrow(/math_proof_import_/u);
    expect(fs.readFileSync(f.sourceFile, 'utf8')).toBe(f.original);
  });

  it('checks captured bytes independently and merges only the helper into canonical source without model turns', async () => {
    const f = fixture(); await f.queue(); fs.rmSync(f.fragmentFile); const action = await f.assign();
    expect(await f.consume(action)).toBe(true);
    const record = f.state.cooperation!.proofImports![0], node = f.state.cooperation!.tasks.find(node => node.task.id === 'helper')!;
    expect(record).toMatchObject({ status: 'checked', snapshotCommit: expect.any(String), readyId: expect.any(String) });
    expect(node).toMatchObject({ status: 'integrated', attempts: 0, proof: { passed: true }, integratedCheck: { passed: true } });
    expect(f.state.cooperation!.proofReadyRecords![0]).toMatchObject({ status: 'checked', receiptIds: [expect.any(String)] });
    expect(host.verify.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(committedSource(f.workspace, f.state.cooperation!.canonicalCommit!, `${f.problem.projectRelative}/Submission.lean`)).toContain('lemma helper');
    expect(f.state.check).toBeUndefined(); expect(f.state.cooperation!.tasks[0].integratedCheck).toBeUndefined();
    expect(f.state.turns).toBe(0); expect(f.state.workers!.every(worker => worker.turns === 0)).toBe(true);
  });

  it('supersedes a frozen import if its task changes during the independent check', async () => {
    const f = fixture(); await f.queue(); const action = await f.assign();
    const checking = deferred(), release = deferred();
    host.verify.mockImplementation(async request => { checking.resolve(); await release.promise; return batch(request); });
    const pending = f.consume(action); await checking.promise;
    await (f.cooperation as any).acceptPlan(parseCooperationPlan(f.problem, { tasks: f.state.cooperation!.tasks.map(({ task }) =>
      task.id === 'helper' ? { ...task, type: 'False' } : task) }));
    release.resolve(); expect(await pending).toBe(true);
    expect(f.state.cooperation!.proofImports![0].status).toBe('superseded');
    expect(f.state.cooperation!.canonicalCommit).toBe(f.problem.baseCommit);
    expect(f.state.cooperation!.tasks.find(node => node.task.id === 'helper')!.integratedCheck).toBeUndefined();
  });

  it('restores a frozen snapshot after restart, links interrupted progress, and ignores later mutable files', async () => {
    const f = fixture(); await f.queue(); let action = await f.assign();
    await f.consume(action, { resumeFrozen: async () => false });
    const snapshot = f.state.cooperation!.proofImports![0].snapshotCommit!;
    delete f.state.cooperation!.proofImports![0].readyId; f.state.cooperation!.proofImports![0].status = 'received'; f.save();
    f.reload(); await f.cooperation.restore(); action = await f.assign();
    fs.writeFileSync(f.fragmentFile, 'lemma helper : False := by sorry\n'); fs.appendFileSync(f.sourceFile, '\n-- later live edit\n');
    expect(await f.lifecycle().resumeFrozen(action)).toBe(true); syncProofImports(f.state); f.save();
    expect(f.state.cooperation!.proofImports![0]).toMatchObject({ status: 'checked', snapshotCommit: snapshot, readyId: expect.any(String) });
    expect(committedSource(f.writer.worktree, snapshot, `${f.problem.projectRelative}/Submission.lean`)).not.toContain('later live edit');
    expect(f.state.turns).toBe(0);
  });

  it('resumes an exactly prepared source after interruption before the commit checkpoint', async () => {
    const f = fixture(); await f.queue(); const action = await f.assign();
    const request = JSON.parse(fs.readFileSync(path.join(f.directory, 'proof-imports.jsonl'), 'utf8')) as ProofImportRequest;
    const prepared = proofFragmentChanges(f.original, request); fs.writeFileSync(f.sourceFile, prepared.source);
    f.state.cooperation!.proofImports = [{ id: request.id, requestDigest: mathDigest(canonicalMathJson(request)),
      taskId: request.taskId, taskDigest: request.taskDigest, fragmentSha256: request.fragmentSha256, status: 'received', receivedAt: 1 }];
    f.save(); expect(await f.consume(action)).toBe(true);
    expect(f.state.cooperation!.proofImports[0].status).toBe('checked');
    expect(fs.readFileSync(f.sourceFile, 'utf8').match(/lemma helper/gu)).toHaveLength(1);
  });

  it('records an independently failed proof without canonical adoption or original-goal acceptance', async () => {
    const f = fixture(); await f.queue(); const action = await f.assign();
    host.verify.mockImplementation(async request => failedBatch(batch(request), {
      stdoutPreview: () => 'Submission.lean:1:1: error: unsolved goals', goalsRemaining: 1 }));
    expect(await f.consume(action)).toBe(true);
    expect(f.state.cooperation!.proofImports![0].status).toBe('failed');
    expect(f.state.cooperation!.canonicalCommit).toBe(f.problem.baseCommit); expect(f.state.check).toBeUndefined();
    expect(f.state.cooperation!.tasks[0].integratedCheck).toBeUndefined();
  });

  it('imports through the real runner before M1 opens and without charging model attempts', async () => {
    const f = fixture(); await f.queue();
    const selected = deferred(), open = vi.fn(() => { throw new Error('model_must_not_open'); });
    const next = CooperativeResearch.prototype.next;
    vi.spyOn(CooperativeResearch.prototype, 'start').mockImplementation(() => {});
    vi.spyOn(CooperativeResearch.prototype, 'next').mockImplementation(async function (this: CooperativeResearch, worker, budget) {
      if (worker.role === 'lead') { await selected.promise; return undefined; }
      return next.call(this, worker, budget);
    });
    const modules: SolverModules = { ...directSolverModules, M1: { ...directSolverModules.M1, open } };
    const completion = runResearchWorkers({ state: f.state, workers: f.workers, access: workerAccess(f.workers, f.directory),
      modules, root: f.directory, buildFile: path.join(f.directory, 'build.json'), taskText: 'Offline import',
      executable: 'unused', profile: 'unused', signal: f.controller.signal, deadline: Infinity, maxTurns: Infinity,
      maxTurnMs: Infinity, maxTotalTokens: 0, save: f.save, emit: (event, details) => {
        f.events.push({ event, details }); if (event === 'proof_import_completed') { selected.resolve(); f.controller.abort(); }
      } });
    await expect(completion).rejects.toThrow();
    expect(open).not.toHaveBeenCalled(); expect(f.state.turns).toBe(0);
    expect(f.state.cooperation!.proofImports![0].status).toBe('checked');
    expect(f.state.cooperation!.tasks.find(node => node.task.id === 'helper')!.attempts).toBe(0);
    expect(git(f.writer.worktree, ['rev-parse', 'HEAD'])).toBe(f.state.cooperation!.proofImports![0].snapshotCommit);
  });
});

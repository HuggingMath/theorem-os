import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { landVerifiedHelpers } from '../src/solver/incrementalHelpers';
import { checkSolverProof } from '../src/solver/modules/evidence';
import { commitSolverSources, commitSolverProjection, git, readSolverProblem } from '../src/solver/problem';
import { assignmentDeliveryFile, parseCooperationPlan } from '../src/solver/tasks';
import { cooperativeResearch, workerDeliveryModules } from './helpers/cooperation';
import { temporaryDirectory } from './helpers/files';
import { leadWorker, solverState } from './helpers/solver';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const original = 'namespace Incremental\ndef frozen : Nat := 7\ntheorem target : frozen = 7 := by sorry\nend Incremental\n';
const file = 'Submission.lean';
const helpers = 'theorem first : frozen = 7 := by rfl\n' +
  'theorem second : frozen = 7 := first\n';

function fixture(statement = original) {
  const directory = temporaryDirectory('incremental-helpers-'); roots.push(directory);
  const receipt = bootstrapLeanTask(path.join(directory, 'primary'), { source: statement, task: 'Show frozen equals seven.' });
  const worktree = receipt.workspaceRoot, problem = readSolverProblem(worktree, receipt.activeProblemPath);
  const sourceWorktree = path.join(directory, 'peer-a');
  git(worktree, ['worktree', 'add', '--quiet', '--detach', sourceWorktree, problem.baseCommit]);
  const source = (root: string) => path.join(root, problem.projectRelative, file);
  const toolchain = path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.33.0');
  if (!fs.existsSync(path.join(toolchain, 'bin/lean'))) throw new Error('Real Lean 4.33.0 is required.');
  const env = { PATH: `${toolchain}/bin:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    ELAN_HOME: path.join(os.homedir(), '.elan'), LEAN_PATH: '', LEAN_SYSROOT: '',
    DEEPSCIENTIST_MATH_SANDBOX_BACKEND: 'bwrap', DEEPSCIENTIST_MATH_ENV_FILE: path.join(directory, 'missing.env') };
  const state = solverState(problem, worktree, { runId: 'incremental-helpers-fixture', phase: 'running',
    environmentDigest: mathDigest('real lean standard environment') });
  const input = { state, worktree, sourceWorktree, seedCommit: problem.baseCommit, expectedCommit: problem.baseCommit,
    env, signal: new AbortController().signal, timeoutMs: 30_000 };
  const snapshot = (text: string, valid = true) => {
    fs.writeFileSync(source(sourceWorktree), text);
    return valid ? commitSolverSources(problem, sourceWorktree) : commitSolverProjection(problem, sourceWorktree, 'Invalid helper fixture');
  };
  return { input, problem, worktree, source, snapshot, directory };
}

describe('incrementally land standalone helpers with real Lean', () => {
  it('publishes an assignment-log helper batch before either original goal is solved', async () => {
    const statement = original.replace('end Incremental', 'theorem consumer : frozen = 7 := by sorry\nend Incremental');
    const f = fixture(statement);
    const { state } = f.input, seedCommit = f.problem.baseCommit;
    const lead = leadWorker(f.problem, f.worktree);
    const producer = { ...lead, id: 'producer', role: 'researcher' as const, worktree: f.input.sourceWorktree };
    const peer = { ...producer, id: 'peer', worktree: path.join(f.directory, 'peer-b') };
    git(f.worktree, ['worktree', 'add', '--quiet', '--detach', peer.worktree, seedCommit]);
    const workers = [lead, producer, peer];
    const plan = parseCooperationPlan(f.problem, { tasks: f.problem.targets.map((target, index) => ({
      id: `goal_${index}`, kind: 'goal', objective: `Prove ${target.theoremName}.`, proofPath: target.proofPath,
      theoremName: target.theoremName, ownerId: workers[index + 1].id,
    })) });
    state.workers = workers.map(worker => ({ ...worker, phase: 'running', turns: 0 }));
    state.cooperation = { canonicalCommit: seedCommit, tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
      groups: plan.groups.map(group => ({ group, turns: 0 })) };
    const controller = new AbortController();
    const cooperation = cooperativeResearch({ state, workers, retrievalRoot: f.directory, modules: workerDeliveryModules,
      signal: controller.signal, access: new Map(workers.map(worker =>
        [worker.id, { environment: f.input.env, retrievalRoot: f.directory }])), timeoutMs: 30_000 });
    const budget = { maxTurns: Infinity, remainingMs: Infinity };
    try {
      const action = await cooperation.next(producer, budget);
      if (action?.kind !== 'task') throw new Error('fixture did not assign the producer');
      expect(cooperation.started(producer, action)).toBe(true);
      const notify = vi.fn(async () => {}), interrupt = vi.fn(async () => {});
      cooperation.activate(producer, action, interrupt, notify);
      fs.writeFileSync(f.source(producer.worktree), statement.replace('theorem target', helpers + 'theorem target'));
      const log = path.join(producer.worktree, assignmentDeliveryFile(action.assignment));
      fs.appendFileSync(log, JSON.stringify({ kind: 'helpers', summary: 'Two reusable claims.',
        declarations: [{ file, name: 'Incremental.first' }, { file, name: 'Incremental.second' }] }) + '\n');
      await cooperation.pulse(producer.id);
      expect(state.cooperation.landedHelpers?.map(helper => helper.qualifiedName)).toEqual(['Incremental.first', 'Incremental.second']);
      expect(state.cooperation.canonicalCommit).not.toBe(seedCommit);
      expect(state.cooperation.tasks.map(task => task.status)).toEqual(['running', 'pending']);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining('Incremental.second :'), { mode: 'advisory' });
      expect(interrupt).not.toHaveBeenCalled();
      const dispatch = await cooperation.next(peer, budget);
      expect(dispatch).toMatchObject({ kind: 'task' });
      expect(fs.readFileSync(f.source(peer.worktree), 'utf8')).toBe(statement.replace('theorem target', helpers + 'theorem target'));
      const inbox = fs.readFileSync(path.join(peer.worktree, 'COOPERATION.json'), 'utf8');
      expect(inbox).toContain('Incremental.second');
    } finally {
      controller.abort();
      await cooperation.stop();
    }
  }, 60_000);

  it('checks two helper lemmas, keeps the original goal open, and gives the next peer a proof it can use', async () => {
    const f = fixture();
    const sourceCommit = f.snapshot(original.replace('end Incremental', helpers +
      'def unrelated : Nat := by sorry\nend Incremental'));
    const declarations = [{ file, name: 'Incremental.first' }, { file, name: 'Incremental.second', type: 'Incremental.frozen = 7' }];
    const result = await landVerifiedHelpers({ ...f.input, sourceCommit, declarations });
    expect(result.helpers.map(item => item.qualifiedName)).toEqual(['Incremental.first', 'Incremental.second']);
    expect(result.helpers.every(item => item.commit === result.commit && item.type.includes(item.qualifiedName))).toBe(true);
    expect(fs.readFileSync(f.source(f.worktree), 'utf8')).toEqual(original);
    expect(git(f.worktree, ['rev-parse', `${result.commit}^`])).toBe(f.problem.baseCommit);
    const peer = path.join(f.directory, 'peer-b');
    git(f.worktree, ['worktree', 'add', '--quiet', '--detach', peer, result.commit]);
    const peerSource = fs.readFileSync(f.source(peer), 'utf8');
    expect(peerSource).toBe(original.replace('theorem target', helpers + 'theorem target'));
    expect((await checkSolverProof(f.problem, peer, f.input.env)).passed).toBe(false);
    fs.writeFileSync(f.source(peer), peerSource.replace('by sorry', 'by exact second'));
    expect((await checkSolverProof(f.problem, peer, f.input.env)).passed).toBe(true);
    const duplicate = await landVerifiedHelpers({ ...f.input, expectedCommit: result.commit, sourceCommit, declarations });
    expect(duplicate).toMatchObject({ commit: result.commit, helpers: [], changes: [] });
    const conflicting = f.snapshot(original.replace('end Incremental', helpers.replace('by rfl', 'by exact rfl') + 'end Incremental'));
    await expect(landVerifiedHelpers({ ...f.input, expectedCommit: result.commit, sourceCommit: conflicting, declarations }))
      .rejects.toThrow('math_incremental_helper_conflicting_definition');
  }, 60_000);

  it('includes a named same-file closure dependency and refuses any draft or original goal dependency', async () => {
    const f = fixture();
    const declaration = { file, name: 'Incremental.second' };
    const sourceCommit = f.snapshot(original.replace('end Incremental', helpers + 'end Incremental'));
    const landed = await landVerifiedHelpers({ ...f.input, sourceCommit, declarations: [declaration] });
    expect(landed.helpers.map(item => item.qualifiedName)).toEqual(['Incremental.first', 'Incremental.second']);
    for (const text of [helpers.replace('by rfl', 'by sorry'), helpers.replace(':= first', ':= target')]) {
      const sourceCommit = f.snapshot(original.replace('end Incremental', text + 'end Incremental'));
      await expect(landVerifiedHelpers({ ...f.input, sourceCommit, declarations: [declaration] }))
        .rejects.toThrow('math_incremental_helper_kernel_rejected');
    }
    expect(git(f.worktree, ['rev-parse', 'HEAD'])).toBe(f.problem.baseCommit);
  }, 60_000);

  it('refuses a changed frozen declaration and a nomination of the original target', async () => {
    const f = fixture();
    const sourceCommit = f.snapshot(original.replace(':= 7', ':= 8').replace('end Incremental', helpers + 'end Incremental'), false);
    await expect(landVerifiedHelpers({ ...f.input, sourceCommit, declarations: [{ file, name: 'Incremental.first' }] }))
      .rejects.toThrow('math_original_declaration_changed');
    await expect(landVerifiedHelpers({ ...f.input, sourceCommit: f.problem.baseCommit, declarations: [{ file, name: 'Incremental.target' }] }))
      .rejects.toThrow('math_incremental_helper_original_declaration');
  });

  it('rejects a tactic that implicitly uses an unfinished original goal in canonical source', async () => {
    const statement = 'namespace Incremental\ndef token : Nat := 1\n' +
      '@[simp]\ntheorem unavailable : token = 0 := by sorry\n' +
      'def limit : Nat := token\ntheorem target : token = limit := by sorry\nend Incremental\n';
    const f = fixture(statement);
    const helper = 'theorem implicit : ∃ n, limit = n := by\n' +
      '  first\n  | exact ⟨0, by simpa [limit]⟩\n  | exact ⟨limit, rfl⟩\n';
    const sourceCommit = f.snapshot(statement.replace('end Incremental', helper + 'end Incremental'));
    await expect(landVerifiedHelpers({ ...f.input, sourceCommit, declarations: [{ file, name: 'Incremental.implicit' }] }))
      .rejects.toThrow(/math_incremental_helper_kernel_rejected:.*sorryAx/u);
  }, 60_000);
});

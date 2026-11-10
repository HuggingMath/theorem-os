import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { LIBRARY_PACK_SCHEMA } from '../src/math/libraryPacks';
import { leanReferenceCommands, parseLeanReferenceReport } from '../src/math/leanReferences';
import type { MathematicsVerifierBatchRequest } from '../src/math/verifier';
import { parseCooperationPlan } from '../src/solver/cooperation';
import { checkTaskProof } from '../src/solver/cooperativeProof';
import { readInstalledLibrarySnapshot } from '../src/solver/installedLibraryContext';
import * as installedLibraryContext from '../src/solver/installedLibraryContext';
import { applyOriginalLibraryTasks, prepareLibraryApplication } from '../src/solver/libraryApplication';
import { directSolverModules } from '../src/solver/modules';
import { committedSource, git, readSolverProblem, withSolverWorktree } from '../src/solver/problem';
import { runResearchWorkers } from '../src/solver/research';
import { taskVersion, type CooperativeTask } from '../src/solver/tasks';
import { cooperativeResearch, workerAccess } from './helpers/cooperation';
import { temporaryDirectory } from './helpers/files';
import { newestLeanBinary } from './helpers/lean';
import { leadWorker, solverState } from './helpers/solver';
import { failedBatch, verifiedBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ verify: vi.fn(), model: vi.fn() }));
vi.mock('../src/math/verifier', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/verifier')>(), checkManyFormalVerifications: host.verify,
  formalVerificationToolIdentity: () => 'library-application-fixture', resolveMathematicsLakePackagesCache: () => undefined,
}));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.model }));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});
const file = 'Submission/Library/Fixture/Arithmetic.lean';
const reference = { file, name: 'Frozen.add_zero' };
const challenge = 'namespace Current\ntheorem target (n : Nat) : n + 0 = n := by sorry\nend Current\n';
const source = 'namespace Frozen\nprivate theorem hidden : True := trivial\ntheorem add_zero (n : Nat) : n + 0 = n := Nat.add_zero n\nend Frozen\n';
const environmentDigest = 'installed-library-environment';
const lean = newestLeanBinary();
function fixture(options: { source?: string; challenge?: string } = {}) {
  const root = temporaryDirectory('library-application-'); roots.push(root);
  const receipt = bootstrapLeanTask(path.join(root, 'workspace'), { source: options.challenge ?? challenge, task: 'Prove the addition identity.',
    libraryPack: { schema: LIBRARY_PACK_SCHEMA, modules: [{ file, source: options.source ?? source,
      origin: { kind: 'upstream', repository: 'offline-fixture', commit: 'a'.repeat(40), file: 'Arithmetic.lean' } }] } });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  const library = readInstalledLibrarySnapshot(problem, environmentDigest)!;
  const task: CooperativeTask = { ...problem.targets[0], id: 'goal', kind: 'goal', revision: 0, dependsOn: [], objective: 'Prove the target.' };
  return { root, receipt, problem, library, task, worktree: receipt.workspaceRoot, seedCommit: problem.baseCommit, environmentDigest };
}
const read = (f: ReturnType<typeof fixture>, commit = git(f.worktree, ['rev-parse', 'HEAD'])) =>
  committedSource(f.worktree, commit, `${f.problem.projectRelative}/Submission.lean`);
function searchSections(f: ReturnType<typeof fixture>, groups: { pool: string[]; shown?: string[] }[]) {
  return vi.spyOn(installedLibraryContext, 'installedLibraryRetrievals').mockReturnValue(groups.map(({ pool, shown }, index) => ({
    sectionId: `knowledge:${index}`, catalogDigest: f.library.digest, searchInputDigest: 'offline-search',
      consumer: { taskId: f.task.id, theoremName: f.task.theoremName, proofPath: f.task.proofPath },
      searchCandidateIds: pool, candidateIds: shown ?? pool.slice(0, 3), routeFindingIds: [],
  })));
}
const idFor = (f: ReturnType<typeof fixture>, name: string) => f.library.base.entries.find(entry => entry.name === name)!.id;
beforeEach(() => {
  host.model.mockReset().mockImplementation(() => { throw new Error('fixture_models_forbidden'); });
  host.verify.mockReset().mockImplementation(async (request: MathematicsVerifierBatchRequest) => {
    const batch = verifiedBatch(request, { sessionId: 'library-application-fixture', checks: true });
    return { ...batch, results: batch.results.map(result => ({ ...result,
      declarationReferences: { statement: [], proof: [reference] } })) };
  });
});

describe('host applications of installed theorems', () => {
  it.each(['goal', 'lemma'] as const)('prepares an import and actual application for an exact %s in an isolated commit', async kind => {
    const f = fixture(), task: CooperativeTask = kind === 'goal' ? f.task : { ...f.task, id: 'helper', kind,
      theoremName: 'Current.helper', type: 'forall (n : Nat), n + 0 = n' };
    const candidate = await prepareLibraryApplication({ ...f, task });
    expect(candidate).toMatchObject({ status: 'candidate', candidates: [reference], commit: expect.any(String) });
    const saved = read(f, candidate.commit!);
    expect(saved).toContain('import Submission.Library.Fixture.Arithmetic');
    expect(saved).toContain('exact _root_.Frozen.add_zero');
    expect(saved).toContain('apply _root_.Frozen.add_zero');
    if (kind === 'lemma') expect(saved).toContain('theorem target (n : Nat) : n + 0 = n := by sorry');
    expect(saved).not.toContain('Frozen.hidden');
    expect(read(f)).toBe(challenge);
    expect(git(f.worktree, ['rev-parse', 'HEAD'])).toBe(f.seedCommit);
    expect(committedSource(f.worktree, candidate.commit!, `${f.problem.projectRelative}/${file}`)).toBe(source);
  });

  it('does not turn definitions, stale source identities or empty search results into applications', async () => {
    const f = fixture();
    for (const library of [
      { ...f.library, base: { ...f.library.base, entries: [] } },
      { ...f.library, base: { ...f.library.base, entries: f.library.base.entries.map(entry => ({ ...entry, kind: 'definition' as const })) } },
      { ...f.library, base: { ...f.library.base, contexts: {} } },
    ]) {
      expect(await prepareLibraryApplication({ ...f, library })).toMatchObject({ status: 'skipped', candidates: [] });
    }
    expect(read(f)).toBe(challenge);
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('keeps weight-only hints for the model without trying twelve unrelated theorem applications', async () => {
    const original = 'namespace Current\ndef idealWeight (n : Nat) := n\n' +
      'theorem weight_idempotent (n : Nat) : idealWeight (idealWeight n) = idealWeight n := by sorry\nend Current\n';
    const f = fixture({ challenge: original, source: 'namespace Probability\n' +
      Array.from({ length: 12 }, (_, i) =>
        `theorem sum_biasedWeight_${i} (n : Nat) : n + 0 = n := Nat.add_zero n\n`).join('') + 'end Probability\n' });
    const action = { kind: 'task' as const, task: f.task, assignment: { taskId: f.task.id,
      taskDigest: taskVersion(f.task), workerId: 'host', seedCommit: f.seedCommit } };
    const displayed = installedLibraryContext.installedLibraryRetrievals({ ...f, action });
    expect(displayed[0].searchCandidateIds).toHaveLength(12);
    expect(await prepareLibraryApplication(f)).toMatchObject({ status: 'skipped',
      reason: 'no-matching-installed-theorem', candidates: [] });
    expect(read(f)).toBe(original);
    expect(host.verify).not.toHaveBeenCalled();
    // An explicit request still permits adaptation attempts even without matching conclusion words.
    expect(await prepareLibraryApplication({ ...f, taskText: 'Use Probability.sum_biasedWeight_0.' }))
      .toMatchObject({ status: 'candidate', candidates: [{ file, name: 'Probability.sum_biasedWeight_0' }] });
  });

  it.skipIf(!lean)('reuses the odd-sum theorem with a real Lean check and no model', async () => {
    const original = 'import Submission.Library.Fixture.Arithmetic\nnamespace Consumer\n' +
      'theorem target (n : Nat) : AcceptanceOddSum.oddSum n = n ^ 2 := by sorry\nend Consumer\n';
    const f = fixture({ challenge: original, source: 'import Std\nnamespace AcceptanceOddSum\n' +
      'def oddSum : Nat → Nat\n  | 0 => 0\n  | n + 1 => oddSum n + (2 * n + 1)\n' +
      'theorem odd_square_step (n : Nat) : n ^ 2 + (2 * n + 1) = (n + 1) ^ 2 := by\n' +
      '  simp only [Nat.pow_succ, Nat.pow_zero, Nat.mul_add, Nat.add_mul, Nat.mul_one, Nat.one_mul]\n  omega\n' +
      'theorem odd_sum (n : Nat) : oddSum n = n ^ 2 := by\n' +
      '  induction n with\n  | zero => rfl\n  | succ n ih =>\n' +
      '    change oddSum n + (2 * n + 1) = (n + 1) ^ 2\n    rw [ih, odd_square_step]\nend AcceptanceOddSum\n' });
    const application = await prepareLibraryApplication(f);
    expect(application.status).toBe('candidate');
    expect(application.candidates).toContainEqual({ file, name: 'AcceptanceOddSum.odd_sum' });
    await withSolverWorktree(f.worktree, application.commit!, async checkout => {
      const project = path.join(checkout, f.problem.projectRelative), build = path.join(project, '.lake/build/lib/lean');
      const run = (name: string, output?: string) => {
        if (output) fs.mkdirSync(path.dirname(output), { recursive: true });
        return spawnSync(lean!, ['-j', '2', ...(output ? ['-R', project, '-o', output] : []), name],
          { cwd: project, env: { ...process.env, LEAN_PATH: build, LEAN_NUM_THREADS: '2' }, encoding: 'utf8', timeout: 30_000 });
      };
      const module = run(file, path.join(build, file.replace(/\.lean$/u, '.olean')));
      expect(module.status, module.stdout + module.stderr).toBe(0);
      const consumer = run('Submission.lean', path.join(build, 'Submission.olean'));
      expect(consumer.status, consumer.stdout + consumer.stderr).toBe(0);
      const modules = [{ module: file.replace(/\.lean$/u, '').replaceAll('/', '.'), file }];
      const options = { expectedTheoremName: 'Consumer.target', expectedModules: modules }, marker = 'ODD_SUM_REUSE:';
      fs.writeFileSync(path.join(project, 'Probe.lean'), ['import Lean', 'import Submission',
        ...leanReferenceCommands('Consumer.target', modules, marker, options), '#print axioms Consumer.target'].join('\n') + '\n');
      const probe = run('Probe.lean');
      expect(probe.status, probe.stdout + probe.stderr).toBe(0);
      expect(probe.stdout).not.toContain('sorryAx');
      expect(parseLeanReferenceReport(probe.stdout, marker, [file], options)).toMatchObject({ status: 'complete',
        references: { proof: expect.arrayContaining([{ file, name: 'AcceptanceOddSum.odd_sum' }]) } });
    });
    expect(read(f)).toBe(original);
    expect(host.model).not.toHaveBeenCalled();
  });

  it('retrieves the usable theorem before a matching definition pool fills all application slots', async () => {
    const f = fixture({ source: 'namespace Frozen\n' + Array.from({ length: 12 }, (_, index) =>
      `def Nat_0_predicate_${index + 1} (n : Nat) : Prop := n + 0 = n\n`).join('') +
      'theorem usable (n : Nat) : n = n := rfl\nend Frozen\n' });
    const application = await prepareLibraryApplication(f);
    expect(application).toMatchObject({ status: 'candidate', candidates: [{ file, name: 'Frozen.usable' }] });
    expect(read(f, application.commit!)).toContain('apply _root_.Frozen.usable');
    expect(read(f)).toBe(challenge);
    expect(git(f.worktree, ['rev-parse', 'HEAD'])).toBe(f.seedCommit);
  });

  it('tries the complete retrieval pool after the three displayed candidates', async () => {
    const f = fixture({ source: 'namespace Frozen\n' + [1, 2, 3].map(index =>
      `theorem needs_false_${index} (n : Nat) (h : False) : n + 0 = n := h.elim\n`).join('') +
      'theorem late_identity (n : Nat) : n + 0 = n := Nat.add_zero n\nend Frozen\n' });
    const names = ['Frozen.needs_false_1', 'Frozen.needs_false_2', 'Frozen.needs_false_3', 'Frozen.late_identity'];
    searchSections(f, [{ pool: names.map(name => idFor(f, name)) }]);
    const application = await prepareLibraryApplication(f);
    expect(application.candidates.map(candidate => candidate.name)).toEqual(names);
    expect(read(f, application.commit!)).toContain('apply _root_.Frozen.late_identity');
    expect(read(f)).toBe(challenge);
    expect(git(f.worktree, ['rev-parse', 'HEAD'])).toBe(f.seedCommit);
  });

  it('filters definitions and stale interfaces and deduplicates before the twelve-theorem limit', async () => {
    const names = Array.from({ length: 13 }, (_, index) => `Frozen.identity_${index + 1}`);
    const f = fixture({ source: 'namespace Frozen\nprivate theorem hidden (n : Nat) : n + 0 = n := Nat.add_zero n\n' +
      'def definition_identity (n : Nat) : n + 0 = n := Nat.add_zero n\n' + names.map(name =>
      `theorem ${name.slice('Frozen.'.length)} (n : Nat) : n + 0 = n := Nat.add_zero n\n`).join('') + 'end Frozen\n' });
    expect(f.library.base.entries.some(entry => entry.name === 'Frozen.hidden')).toBe(false);
    const duplicate = { ...f.library.base.entries.find(entry => entry.name === names[0])!, id: 'b'.repeat(64) };
    const stale = { ...duplicate, id: 'c'.repeat(64), name: 'Frozen.stale', contextDigest: 'd'.repeat(64) };
    f.library.base.entries.push(duplicate, stale);
    const ids = names.map(name => idFor(f, name));
    searchSections(f, [
      { pool: [idFor(f, 'Frozen.definition_identity'), stale.id, ids[0], duplicate.id, ...ids.slice(0, 6)] },
      { pool: ids.slice(6) },
    ]);
    const application = await prepareLibraryApplication(f);
    expect(application.candidates.map(candidate => candidate.name)).toEqual(names.slice(0, 12));
    expect(application.candidates).toHaveLength(12);
    expect(read(f)).toBe(challenge);
  });

  it('retains an exact application handoff with no lexical search hits', async () => {
    const f = fixture();
    searchSections(f, [{ pool: [], shown: [idFor(f, reference.name)] }]);
    expect(await prepareLibraryApplication(f)).toMatchObject({ status: 'candidate', candidates: [reference] });
  });

  it('includes the original task text in the installed library retrieval', async () => {
    const f = fixture(), retrieval = searchSections(f, [{ pool: [idFor(f, reference.name)] }]);
    const taskText = 'Use the installed arithmetic library to prove the original addition identity.';
    await prepareLibraryApplication({ ...f, taskText });
    expect(retrieval).toHaveBeenCalledWith(expect.objectContaining({ problem: f.problem, library: f.library, taskText }));
  });

  it('promotes a named installed theorem into the actual application before a full lexical pool', async () => {
    const f = fixture({ source: 'namespace Frozen\n' + Array.from({ length: 12 }, (_, i) =>
      `theorem blocked_${i} (n : Nat) (h : False) : n + 0 = n := h.elim\n`).join('') +
      'theorem designated (n : Nat) : n = n := rfl\nend Frozen\n' });
    const application = await prepareLibraryApplication({ ...f, taskText: 'Use Frozen.designated.' });
    expect(application.status).toBe('candidate');
    expect(application.candidates[0]).toEqual({ file, name: 'Frozen.designated' });
    expect(application.candidates).toHaveLength(12);
    expect(read(f, application.commit!)).toContain('exact _root_.Frozen.designated');
    expect(read(f)).toBe(challenge);
    expect(git(f.worktree, ['rev-parse', 'HEAD'])).toBe(f.seedCommit);
  });

  it.skipIf(!lean)('closes the twelfth theorem in Lean after earlier attempts leave residual goals', async () => {
    const original = 'namespace Current\ntheorem target (a b : Nat) : a + b = b + a := by sorry\nend Current\n';
    const earlier = Array.from({ length: 11 }, (_, index) => index + 1);
    // Lean explicitly supports extending `trivial`; a successful tactic can leave its premise open.
    const f = fixture({ challenge: original, source: 'macro_rules | `(tactic| trivial) => `(tactic| skip)\nnamespace Frozen\n' +
      earlier.map(index => `theorem needs_equality_${index} (a b : Nat) (_h : a + 0 = b + 0) : a + b = b + a := Nat.add_comm a b\n`).join('') +
      'theorem late_commute (a b : Nat) : a + b = b + a := Nat.add_comm a b\nend Frozen\n' });
    const names = [...earlier.map(index => `Frozen.needs_equality_${index}`), 'Frozen.late_commute'];
    searchSections(f, [{ pool: names.map(name => idFor(f, name)) }]);
    const application = await prepareLibraryApplication(f);
    expect(application.candidates.map(candidate => candidate.name)).toEqual(names);
    await withSolverWorktree(f.worktree, application.commit!, async checkout => {
      const project = path.join(checkout, f.problem.projectRelative), build = path.join(project, '.lake/build/lib/lean');
      const run = (file: string, output?: string) => {
        if (output) fs.mkdirSync(path.dirname(output), { recursive: true });
        const result = spawnSync(lean!, [...(output ? ['-R', project, '-o', output] : []), file],
          { cwd: project, env: { ...process.env, LEAN_PATH: build }, encoding: 'utf8', timeout: 30_000 });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        return result;
      };
      run(file, path.join(build, file.replace(/\.lean$/u, '.olean')));
      run('Submission.lean', path.join(build, 'Submission.olean'));
      const modules = [{ module: file.replace(/\.lean$/u, '').replaceAll('/', '.'), file }];
      const options = { expectedTheoremName: 'Current.target', expectedModules: modules }, marker = 'LIBRARY_RECALL:';
      fs.writeFileSync(path.join(project, 'Probe.lean'), ['import Lean', 'import Submission',
        ...leanReferenceCommands('Current.target', modules, marker, options)].join('\n') + '\n');
      const references = parseLeanReferenceReport(run('Probe.lean').stdout, marker, [file], options);
      expect(references).toMatchObject({ status: 'complete', references: { proof: [{ file, name: 'Frozen.late_commute' }] } });
    });
    expect(read(f)).toBe(original);
  });

  it.skipIf(!lean).each([true, false])('infers a predicate from local premises before closing its instance (premise=%s)', async premise => {
    const original = 'namespace Current\ntheorem target (P : Nat → Prop) [DecidablePred P] (n : Nat)' +
      (premise ? ' (h : P n)' : '') + ' (hz : ∀ k, P k → k = 0) : Nat.succ n = 1 := by sorry\nend Current\n';
    const f = fixture({ challenge: original, source: 'namespace Frozen\n' +
      'theorem through_predicate (P : Nat → Prop) [DecidablePred P] (n : Nat) (h : P n)\n' +
      '    (hz : ∀ k, P k → k = 0) : Nat.succ n = 1 := congrArg Nat.succ (hz n h)\nend Frozen\n' });
    searchSections(f, [{ pool: [idFor(f, 'Frozen.through_predicate')] }]);
    const application = await prepareLibraryApplication(f);
    expect(application.status).toBe('candidate');
    await withSolverWorktree(f.worktree, application.commit!, async checkout => {
      const project = path.join(checkout, f.problem.projectRelative), build = path.join(project, '.lake/build/lib/lean');
      const run = (file: string, output?: string) => {
        if (output) fs.mkdirSync(path.dirname(output), { recursive: true });
        return spawnSync(lean!, [...(output ? ['-R', project, '-o', output] : []), file],
          { cwd: project, env: { ...process.env, LEAN_PATH: build }, encoding: 'utf8', timeout: 30_000 });
      };
      const module = run(file, path.join(build, file.replace(/\.lean$/u, '.olean')));
      expect(module.status, module.stdout + module.stderr).toBe(0);
      const consumer = run('Submission.lean', path.join(build, 'Submission.olean'));
      expect(consumer.status, consumer.stdout + consumer.stderr).toBe(premise ? 0 : 1);
      if (!premise) {
        expect(consumer.stdout).not.toMatch(/maximum recursion depth|maximum number of heartbeats|timed out/iu);
        return;
      }
      const modules = [{ module: file.replace(/\.lean$/u, '').replaceAll('/', '.'), file }];
      const options = { expectedTheoremName: 'Current.target', expectedModules: modules }, marker = 'LIBRARY_PREDICATE:';
      fs.writeFileSync(path.join(project, 'Probe.lean'), ['import Lean', 'import Submission',
        ...leanReferenceCommands('Current.target', modules, marker, options), '#print axioms Current.target'].join('\n') + '\n');
      const probe = run('Probe.lean');
      expect(probe.status, probe.stdout + probe.stderr).toBe(0);
      expect(probe.stdout).not.toContain('sorryAx');
      expect(parseLeanReferenceReport(probe.stdout, marker, [file], options)).toMatchObject({ status: 'complete',
        references: { proof: [{ file, name: 'Frozen.through_predicate' }] } });
    });
    expect(read(f)).toBe(original);
    expect(git(f.worktree, ['rev-parse', 'HEAD'])).toBe(f.seedCommit);
  });

  it.skipIf(!lean).each([
    { direction: 'forward', premise: true },
    { direction: 'reverse', premise: true },
    { direction: 'forward', premise: false },
    { direction: 'reverse', premise: false },
  ] as const)('uses an installed iff $direction with premise=$premise', async ({ direction, premise }) => {
    const left = 'Nat.succ n = Nat.succ m', right = 'n = m';
    const hypothesis = direction === 'forward' ? left : right, conclusion = direction === 'forward' ? right : left;
    const original = 'namespace Current\ntheorem target (n m : Nat)' + (premise ? ` (h : ${hypothesis})` : '') +
      ` : ${conclusion} := by sorry\nend Current\n`;
    const f = fixture({ challenge: original, source: 'namespace Frozen\n' +
      'theorem succ_eq_iff (n m : Nat) : Nat.succ n = Nat.succ m ↔ n = m := by\n' +
      '  constructor\n  · exact Nat.succ.inj\n  · exact congrArg Nat.succ\nend Frozen\n' });
    searchSections(f, [{ pool: [idFor(f, 'Frozen.succ_eq_iff')] }]);
    const application = await prepareLibraryApplication(f);
    expect(application.status).toBe('candidate');
    await withSolverWorktree(f.worktree, application.commit!, async checkout => {
      const project = path.join(checkout, f.problem.projectRelative), build = path.join(project, '.lake/build/lib/lean');
      const run = (file: string, output?: string) => {
        if (output) fs.mkdirSync(path.dirname(output), { recursive: true });
        return spawnSync(lean!, [...(output ? ['-R', project, '-o', output] : []), file],
          { cwd: project, env: { ...process.env, LEAN_PATH: build }, encoding: 'utf8', timeout: 30_000 });
      };
      const module = run(file, path.join(build, file.replace(/\.lean$/u, '.olean')));
      expect(module.status, module.stdout + module.stderr).toBe(0);
      const consumer = run('Submission.lean', path.join(build, 'Submission.olean'));
      expect(consumer.status, consumer.stdout + consumer.stderr).toBe(premise ? 0 : 1);
      if (!premise) {
        expect(consumer.stdout).toMatch(/error:.*(?:tactic|Type mismatch)/iu);
        expect(consumer.stdout).not.toMatch(/maximum recursion depth|maximum number of heartbeats|timed out/iu);
        return;
      }
      const modules = [{ module: file.replace(/\.lean$/u, '').replaceAll('/', '.'), file }];
      const options = { expectedTheoremName: 'Current.target', expectedModules: modules }, marker = 'LIBRARY_IFF:';
      fs.writeFileSync(path.join(project, 'Probe.lean'), ['import Lean', 'import Submission',
        ...leanReferenceCommands('Current.target', modules, marker, options), '#print axioms Current.target'].join('\n') + '\n');
      const probe = run('Probe.lean');
      expect(probe.status, probe.stdout + probe.stderr).toBe(0);
      expect(probe.stdout).not.toContain('sorryAx');
      expect(parseLeanReferenceReport(probe.stdout, marker, [file], options)).toMatchObject({
        status: 'complete', references: { proof: [{ file, name: 'Frozen.succ_eq_iff' }] },
      });
    });
    expect(read(f)).toBe(original);
    expect(git(f.worktree, ['rev-parse', 'HEAD'])).toBe(f.seedCommit);
  });

  it.skipIf(!lean).each([
    { direction: 'forward', premise: true },
    { direction: 'reverse', premise: true },
    { direction: 'forward', premise: false },
    { direction: 'reverse', premise: false },
  ] as const)('uses an installed equality $direction with premise=$premise', async ({ direction, premise }) => {
    const conclusion = direction === 'forward' ? 'Nat.succ n = 1' : '1 = Nat.succ n';
    const original = 'namespace Current\ntheorem target (n : Nat)' + (premise ? ' (h : n = 0)' : '') +
      ` : ${conclusion} := by sorry\nend Current\n`;
    const f = fixture({ challenge: original, source: 'namespace Frozen\n' +
      'theorem succ_eq_one (n : Nat) (h : n = 0) : Nat.succ n = 1 := congrArg Nat.succ h\nend Frozen\n' });
    searchSections(f, [{ pool: [idFor(f, 'Frozen.succ_eq_one')] }]);
    const application = await prepareLibraryApplication(f);
    expect(application.status).toBe('candidate');
    await withSolverWorktree(f.worktree, application.commit!, async checkout => {
      const project = path.join(checkout, f.problem.projectRelative), build = path.join(project, '.lake/build/lib/lean');
      const run = (file: string, output?: string) => {
        if (output) fs.mkdirSync(path.dirname(output), { recursive: true });
        return spawnSync(lean!, [...(output ? ['-R', project, '-o', output] : []), file],
          { cwd: project, env: { ...process.env, LEAN_PATH: build }, encoding: 'utf8', timeout: 30_000 });
      };
      const module = run(file, path.join(build, file.replace(/\.lean$/u, '.olean')));
      expect(module.status, module.stdout + module.stderr).toBe(0);
      const consumer = run('Submission.lean', path.join(build, 'Submission.olean'));
      expect(consumer.status, consumer.stdout + consumer.stderr).toBe(premise ? 0 : 1);
      if (!premise) {
        expect(consumer.stdout).toMatch(/error:.*(?:tactic|Type mismatch)/iu);
        expect(consumer.stdout).not.toMatch(/maximum recursion depth|maximum number of heartbeats|timed out/iu);
        return;
      }
      const modules = [{ module: file.replace(/\.lean$/u, '').replaceAll('/', '.'), file }];
      const options = { expectedTheoremName: 'Current.target', expectedModules: modules }, marker = 'LIBRARY_EQUALITY:';
      fs.writeFileSync(path.join(project, 'Probe.lean'), ['import Lean', 'import Submission',
        ...leanReferenceCommands('Current.target', modules, marker, options), '#print axioms Current.target'].join('\n') + '\n');
      const probe = run('Probe.lean');
      expect(probe.status, probe.stdout + probe.stderr).toBe(0);
      expect(probe.stdout).not.toContain('sorryAx');
      expect(parseLeanReferenceReport(probe.stdout, marker, [file], options)).toMatchObject({
        status: 'complete', references: { proof: [{ file, name: 'Frozen.succ_eq_one' }] },
      });
    });
    expect(read(f)).toBe(original);
    expect(git(f.worktree, ['rev-parse', 'HEAD'])).toBe(f.seedCommit);
  });

  it.skipIf(!lean).each([true, false])('rewrites an installed equality inside a target with premise=%s', async premise => {
    const original = 'namespace Current\ntheorem target (n k : Nat)' + (premise ? ' (h : n = 0)' : '') +
      ' : Nat.succ n + k = 1 + k := by sorry\nend Current\n';
    const f = fixture({ challenge: original, source: 'namespace Frozen\n' +
      'theorem succ_eq_one (n : Nat) (h : n = 0) : Nat.succ n = 1 := congrArg Nat.succ h\nend Frozen\n' });
    searchSections(f, [{ pool: [idFor(f, 'Frozen.succ_eq_one')] }]);
    const application = await prepareLibraryApplication(f);
    expect(application.status).toBe('candidate');
    await withSolverWorktree(f.worktree, application.commit!, async checkout => {
      const project = path.join(checkout, f.problem.projectRelative), build = path.join(project, '.lake/build/lib/lean');
      const run = (file: string, output?: string) => {
        if (output) fs.mkdirSync(path.dirname(output), { recursive: true });
        return spawnSync(lean!, [...(output ? ['-R', project, '-o', output] : []), file],
          { cwd: project, env: { ...process.env, LEAN_PATH: build }, encoding: 'utf8', timeout: 30_000 });
      };
      const module = run(file, path.join(build, file.replace(/\.lean$/u, '.olean')));
      expect(module.status, module.stdout + module.stderr).toBe(0);
      const consumer = run('Submission.lean', path.join(build, 'Submission.olean'));
      expect(consumer.status, consumer.stdout + consumer.stderr).toBe(premise ? 0 : 1);
      if (!premise) {
        expect(consumer.stdout).toMatch(/error:.*(?:tactic|Type mismatch)/iu);
        expect(consumer.stdout).not.toMatch(/maximum recursion depth|maximum number of heartbeats|timed out/iu);
        return;
      }
      const modules = [{ module: file.replace(/\.lean$/u, '').replaceAll('/', '.'), file }];
      const options = { expectedTheoremName: 'Current.target', expectedModules: modules }, marker = 'LIBRARY_REWRITE:';
      fs.writeFileSync(path.join(project, 'Probe.lean'), ['import Lean', 'import Submission',
        ...leanReferenceCommands('Current.target', modules, marker, options), '#print axioms Current.target'].join('\n') + '\n');
      const probe = run('Probe.lean');
      expect(probe.status, probe.stdout + probe.stderr).toBe(0);
      expect(probe.stdout).not.toContain('sorryAx');
      expect(parseLeanReferenceReport(probe.stdout, marker, [file], options)).toMatchObject({
        status: 'complete', references: { proof: [{ file, name: 'Frozen.succ_eq_one' }] },
      });
    });
    expect(read(f)).toBe(original);
    expect(git(f.worktree, ['rev-parse', 'HEAD'])).toBe(f.seedCommit);
  });

  it.skipIf(!lean).each([
    { premise: true, crowded: false }, { premise: true, crowded: true }, { premise: false, crowded: false },
  ])('uses a second installed theorem with hypothesis=$premise and crowded=$crowded', async ({ premise, crowded }) => {
    const original = 'namespace Current\ntheorem target (n : Nat)' + (premise ? ' (h : n = 0)' : '') +
      ' : Nat.succ n = 1 := by sorry\nend Current\n';
    const f = fixture({ challenge: original, source: 'namespace Frozen\n' +
      'structure IsZero (n : Nat) : Prop where\n  eq_zero : n = 0\n' +
      'theorem succ_eq_one (n : Nat) (h : IsZero n) : Nat.succ n = 1 := congrArg Nat.succ h.eq_zero\n' +
      Array.from({ length: 12 }, (_, index) =>
        `theorem ${crowded ? `succ_blocked_${index + 1}` : `blocked_${String.fromCharCode(97 + index)}`} (n : Nat) (h : False) : Nat.succ n = 1 := h.elim\n`).join('') +
      'theorem isZero_of_eq (n : Nat) (h : n = 0) : IsZero n := ⟨h⟩\nend Frozen\n' });
    const names = ['Frozen.succ_eq_one', 'Frozen.isZero_of_eq'];
    const initial = installedLibraryContext.installedLibraryRetrievals({ ...f,
      action: { kind: 'task', task: f.task, assignment: { taskId: f.task.id, taskDigest: taskVersion(f.task),
        workerId: 'host', seedCommit: f.seedCommit } } });
    const rank = initial[0]!.searchCandidateIds!.indexOf(idFor(f, names[0]!));
    if (crowded) expect(rank).toBeGreaterThanOrEqual(3);
    else expect(rank).toBe(0);
    expect(initial[0]!.searchCandidateIds).not.toContain(idFor(f, names[1]!));
    const application = await prepareLibraryApplication(f);
    expect(application.status).toBe('candidate');
    if (premise) expect(application.candidates).toEqual(expect.arrayContaining(names.map(name => ({ file, name }))));
    expect(application.candidates).toHaveLength(12);
    await withSolverWorktree(f.worktree, application.commit!, async checkout => {
      const project = path.join(checkout, f.problem.projectRelative), build = path.join(project, '.lake/build/lib/lean');
      const run = (file: string, output?: string) => {
        if (output) fs.mkdirSync(path.dirname(output), { recursive: true });
        return spawnSync(lean!, [...(output ? ['-R', project, '-o', output] : []), file],
          { cwd: project, env: { ...process.env, LEAN_PATH: build }, encoding: 'utf8', timeout: 30_000 });
      };
      const module = run(file, path.join(build, file.replace(/\.lean$/u, '.olean')));
      expect(module.status, module.stdout + module.stderr).toBe(0);
      const consumer = run('Submission.lean', path.join(build, 'Submission.olean'));
      expect(consumer.status, consumer.stdout + consumer.stderr).toBe(premise ? 0 : 1);
      if (!premise) {
        expect(consumer.stdout).toMatch(/error: tactic/iu);
        expect(consumer.stdout).not.toMatch(/maximum recursion depth|maximum number of heartbeats|timed out/iu);
        return;
      }
      const modules = [{ module: file.replace(/\.lean$/u, '').replaceAll('/', '.'), file }];
      const options = { expectedTheoremName: 'Current.target', expectedModules: modules }, marker = 'LIBRARY_PREMISE:';
      fs.writeFileSync(path.join(project, 'Probe.lean'), ['import Lean', 'import Submission',
        ...leanReferenceCommands('Current.target', modules, marker, options), '#print axioms Current.target'].join('\n') + '\n');
      const probe = run('Probe.lean');
      expect(probe.status, probe.stdout + probe.stderr).toBe(0);
      expect(probe.stdout).not.toContain('sorryAx');
      const references = parseLeanReferenceReport(probe.stdout, marker, [file], options);
      expect(references).toMatchObject({ status: 'complete',
        references: { proof: expect.arrayContaining(names.map(name => ({ file, name }))) } });
    });
    expect(read(f)).toBe(original);
    expect(git(f.worktree, ['rev-parse', 'HEAD'])).toBe(f.seedCommit);
  });

  it.skipIf(!lean).each([
    { mode: 'iff-forward', premise: true }, { mode: 'iff-forward', premise: false },
    { mode: 'iff-reverse', premise: true }, { mode: 'iff-reverse', premise: false },
    { mode: 'conditional-iff', premise: true }, { mode: 'conditional-iff', premise: false },
    { mode: 'conditional-iff-local', premise: true }, { mode: 'conditional-iff-local', premise: false },
    { mode: 'symmetry', premise: true }, { mode: 'symmetry', premise: false },
    { mode: 'rewrite', premise: true }, { mode: 'rewrite', premise: false },
  ] as const)('combines $mode with bounded premise closure (hypothesis=$premise)', async ({ mode, premise }) => {
    const iff = mode.includes('iff');
    const localCondition = mode === 'conditional-iff-local';
    const main = iff ? 'Frozen.succ_eq_one_iff' : 'Frozen.succ_eq_one';
    const helper = mode === 'iff-forward' ? 'Frozen.zero_succ_eq_one' : 'Frozen.isZero_of_eq';
    const conclusion = mode === 'iff-forward' || localCondition ? 'Frozen.IsZero n' : mode === 'symmetry' ? '1 = Nat.succ n' :
      mode === 'rewrite' ? 'Nat.succ n + k = 1 + k' : 'Nat.succ n = 1';
    const original = 'import Submission.Library.Fixture.Arithmetic\nnamespace Current\n' +
      `theorem target (n${mode === 'rewrite' ? ' k' : ''} : Nat)` + (premise ? ' (h : n = 0)' : '') +
      (localCondition ? ' (mark : Frozen.Mark n)' : '') +
      ` : ${conclusion} := by sorry\nend Current\n`;
    const f = fixture({ challenge: original, source: 'namespace Frozen\n' +
      'structure IsZero (n : Nat) : Prop where\n  eq_zero : n = 0\n' +
      (localCondition ? 'structure Mark (n : Nat) : Prop where\n  marked : True\n' +
        'theorem succ_eq_one_iff (n : Nat) (h : n = 0) : Mark n ↔ IsZero n :=\n' +
        '  ⟨fun _ => ⟨h⟩, fun _ => ⟨True.intro⟩⟩\n' :
        mode === 'conditional-iff' ? 'theorem succ_eq_one_iff (n : Nat) (h : IsZero n) : Nat.succ n = 1 ↔ n = 0 :=\n' +
        '  ⟨fun _ => h.eq_zero, fun h => congrArg Nat.succ h⟩\n' :
        iff ? 'theorem succ_eq_one_iff (n : Nat) : Nat.succ n = 1 ↔ IsZero n :=\n' +
        '  ⟨fun h => ⟨Nat.succ.inj h⟩, fun h => congrArg Nat.succ h.eq_zero⟩\n' :
        'theorem succ_eq_one (n : Nat) (h : IsZero n) : Nat.succ n = 1 := congrArg Nat.succ h.eq_zero\n') +
      (localCondition ? '' : mode === 'iff-forward' ? 'theorem zero_succ_eq_one (n : Nat) (h : n = 0) : Nat.succ n = 1 := congrArg Nat.succ h\n' :
        'theorem isZero_of_eq (n : Nat) (h : n = 0) : IsZero n := ⟨h⟩\n') + 'end Frozen\n' });
    // Isolate application composition from recall; the Web fixture covers natural retrieval and installation.
    const names = localCondition ? [main] : [main, helper];
    searchSections(f, [{ pool: names.map(name => idFor(f, name)) }]);
    const application = await prepareLibraryApplication(f);
    expect(application.status).toBe('candidate');
    expect(application.candidates.map(candidate => candidate.name)).toEqual(names);
    await withSolverWorktree(f.worktree, application.commit!, async checkout => {
      const project = path.join(checkout, f.problem.projectRelative), build = path.join(project, '.lake/build/lib/lean');
      const run = (name: string, output?: string) => {
        if (output) fs.mkdirSync(path.dirname(output), { recursive: true });
        return spawnSync(lean!, ['-j', '2', ...(output ? ['-R', project, '-o', output] : []), name],
          { cwd: project, env: { ...process.env, LEAN_PATH: build, LEAN_NUM_THREADS: '2' }, encoding: 'utf8', timeout: 30_000 });
      };
      const module = run(file, path.join(build, file.replace(/\.lean$/u, '.olean')));
      expect(module.status, module.stdout + module.stderr).toBe(0);
      const consumer = run('Submission.lean', path.join(build, 'Submission.olean'));
      expect(consumer.error).toBeUndefined();
      expect(consumer.signal).toBeNull();
      expect(consumer.stdout + consumer.stderr).not.toMatch(/maximum recursion depth|maximum number of heartbeats|timed out/iu);
      expect(consumer.status, consumer.stdout + consumer.stderr).toBe(premise ? 0 : 1);
      if (!premise) {
        expect(consumer.stdout).toMatch(/error:.*(?:tactic|unsolved goals|Invalid rewrite argument|Type mismatch)/iu);
        return;
      }
      const modules = [{ module: file.replace(/\.lean$/u, '').replaceAll('/', '.'), file }];
      const options = { expectedTheoremName: 'Current.target', expectedModules: modules }, marker = 'LIBRARY_COMPOSED:';
      fs.writeFileSync(path.join(project, 'Probe.lean'), ['import Lean', 'import Submission',
        ...leanReferenceCommands('Current.target', modules, marker, options), '#print axioms Current.target'].join('\n') + '\n');
      const probe = run('Probe.lean');
      expect(probe.status, probe.stdout + probe.stderr).toBe(0);
      expect(probe.stdout).not.toContain('sorryAx');
      expect(parseLeanReferenceReport(probe.stdout, marker, [file], options)).toMatchObject({ status: 'complete',
        references: { proof: expect.arrayContaining(names.map(name => ({ file, name }))) } });
    });
    expect(read(f)).toBe(original);
    expect(git(f.worktree, ['rev-parse', 'HEAD'])).toBe(f.seedCommit);
  });

  it('checks and saves a single-worker original goal before opening any model', async () => {
    const f = fixture(), emit = vi.fn(), onProof = vi.fn(), prepare = vi.fn(prepareLibraryApplication);
    const taskText = 'Use the installed arithmetic library to prove the original addition identity.';
    expect(await applyOriginalLibraryTasks({ ...f, workerId: 'solver', env: {}, signal: new AbortController().signal,
      timeoutMs: Infinity, taskText, prepare, check: checkTaskProof, emit, onProof })).toBe(1);
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ taskText }));
    expect(read(f)).toContain('exact _root_.Frozen.add_zero');
    expect(read(f)).not.toContain('by sorry');
    expect(onProof).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith('task_library_application', expect.objectContaining({ passed: true,
      referenceCoverage: 'available', usedDeclarations: [reference], receiptIds: expect.any(Array) }));
    expect(host.model).not.toHaveBeenCalled();
  });

  it('resumes a saved single-worker library proof through whole-problem acceptance without a model', async () => {
    const f = fixture(), worker = leadWorker(f.problem, f.worktree);
    const state = solverState(f.problem, f.worktree, { runId: 'library-resume', phase: 'running', environmentDigest });
    const access = workerAccess([worker], f.root);
    access.get(worker.id)!.installedLibrary = f.library;
    const interrupted = new AbortController();
    let saved: typeof state | undefined;
    const input = { state, workers: [worker], access, modules: directSolverModules,
      root: f.root, buildFile: 'unused', taskText: 'Prove the target.', executable: 'unused', profile: 'unused',
      deadline: Infinity, maxTurns: 0, maxTurnMs: Infinity, maxTotalTokens: 0, emit: vi.fn() };
    const interruption = await runResearchWorkers({ ...input, signal: interrupted.signal, save: () => {
      if (!saved && state.phase === 'checking' && !state.check?.passed) {
        saved = JSON.parse(JSON.stringify(state));
        interrupted.abort();
      }
    } }).then(() => undefined, error => error);
    expect(interrupted.signal.aborted, String(interruption)).toBe(true);
    expect(saved).toMatchObject({ phase: 'checking', turns: 0 });
    expect(read(f)).not.toContain('by sorry');
    const winner = await runResearchWorkers({ ...input, state: saved!,
      signal: new AbortController().signal, save: vi.fn() });
    expect(winner?.check.passed).toBe(true);
    expect(saved!.turns).toBe(0);
    expect(host.model).not.toHaveBeenCalled();
  });

  it.each(['rejected', 'unavailable'] as const)('leaves the single-worker source untouched when the kernel is %s', async outcome => {
    const f = fixture(), emit = vi.fn(), onProof = vi.fn();
    host.verify.mockImplementation(async (request: MathematicsVerifierBatchRequest) => {
      if (outcome === 'unavailable') throw new Error('fixture-verifier-unavailable');
      return failedBatch(verifiedBatch(request, { sessionId: 'library-fixture', checks: true }), {
        stdoutPreview: () => 'The installed theorem leaves an unsolved premise.',
      });
    });
    expect(await applyOriginalLibraryTasks({ ...f, workerId: 'solver', env: {}, signal: new AbortController().signal,
      timeoutMs: Infinity, prepare: prepareLibraryApplication, check: checkTaskProof, emit, onProof })).toBe(0);
    expect(onProof).not.toHaveBeenCalled();
    expect(read(f)).toBe(challenge);
    expect(emit).toHaveBeenCalledWith('task_library_application', expect.objectContaining({
      ...(outcome === 'rejected' ? { passed: false, usedDeclarations: [] } : { checkError: expect.any(String) }) }));
  });

  it('keeps a rejected library probe diagnostic out of the original task feedback', async () => {
    const f = fixture(), peer = path.join(f.root, 'proof');
    git(f.worktree, ['worktree', 'add', '--quiet', '--detach', peer, f.seedCommit]);
    const workers = [leadWorker(f.problem, f.worktree), { ...leadWorker(f.problem, peer, 'proof'), role: 'researcher' as const }];
    const plan = parseCooperationPlan(f.problem, { tasks: [{ ...f.task, ownerId: 'proof' }],
      groups: [{ id: 'main', objective: 'Prove the goal', status: 'active', maxConcurrent: 1 }] });
    const originalFeedback = 'Original target diagnostic: preserve the closed-ideal hypotheses.';
    const state = solverState(f.problem, f.worktree, { runId: 'library-probe-rejected', phase: 'running', environmentDigest,
      cooperation: { canonicalCommit: f.seedCommit, tasks: plan.tasks.map(task =>
        ({ task, status: 'pending', attempts: 0, feedback: originalFeedback })),
      groups: plan.groups.map(group => ({ group, turns: 0 })) } });
    const access = workerAccess(workers, f.root);
    for (const worker of access.values()) worker.installedLibrary = f.library;
    const probeDiagnostic = 'Type mismatch: Probability.sum_biasedWeight does not prove the closed-ideal goal.';
    host.verify.mockImplementation(async (request: MathematicsVerifierBatchRequest) =>
      failedBatch(verifiedBatch(request, { sessionId: 'library-probe-rejected', checks: true }), {
        stdoutPreview: () => probeDiagnostic,
      }));
    const emit = vi.fn(), cooperative = cooperativeResearch({ state, workers, access, retrievalRoot: f.root, emit,
      modules: { ...directSolverModules, M1: { ...directSolverModules.M1, open: host.model, execute: host.model } } });
    try {
      expect(await cooperative.next(workers[1], { maxTurns: Infinity, remainingMs: Infinity }))
        .toMatchObject({ kind: 'task', task: { id: f.task.id } });
      const node = state.cooperation!.tasks.find(node => node.task.id === f.task.id)!;
      expect(node.feedback).toContain(originalFeedback);
      expect(node.feedback).toContain('Host library application attempt (advisory)');
      expect(node.feedback).not.toContain(probeDiagnostic);
      expect(node.feedback).not.toContain('Type mismatch');
      expect(emit).toHaveBeenCalledWith('task_library_application', expect.objectContaining({ passed: false,
        diagnostic: expect.stringContaining(probeDiagnostic), receiptIds: expect.any(Array) }));
      expect(host.model).not.toHaveBeenCalled();
    } finally { await cooperative.stop(); }
  });

  it.each(['goal', 'lemma'] as const)('integrates a library-closed %s through normal cooperative acceptance without a model', async kind => {
    const f = fixture(), peer = path.join(f.root, 'proof');
    git(f.worktree, ['worktree', 'add', '--quiet', '--detach', peer, f.seedCommit]);
    const workers = [leadWorker(f.problem, f.worktree), { ...leadWorker(f.problem, peer, 'proof'), role: 'researcher' as const }];
    const task: CooperativeTask = kind === 'goal' ? f.task : { ...f.task, id: 'helper', kind, theoremName: 'Current.helper',
      type: 'forall (n : Nat), n + 0 = n' };
    const plan = parseCooperationPlan(f.problem, { tasks: [
      { ...task, ownerId: 'proof' },
      { id: 'followup', kind: 'research', objective: 'Observe checked dependency', ownerId: 'proof', dependsOn: [task.id] },
      ...(kind === 'lemma' ? [{ ...f.task, status: 'paused' }] : []),
    ], groups: [{ id: 'main', objective: 'Prove the goal', status: 'active', maxConcurrent: 1 }] });
    const state = solverState(f.problem, f.worktree, { runId: 'library-application', phase: 'running', environmentDigest,
      cooperation: { canonicalCommit: f.seedCommit, tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
        groups: plan.groups.map(group => ({ group, turns: 0 })) } });
    const access = workerAccess(workers, f.root);
    for (const worker of access.values()) worker.installedLibrary = f.library;
    const emit = vi.fn(), applyLibrary = vi.fn(prepareLibraryApplication), taskText = 'Use Frozen.add_zero.';
    const cooperative = cooperativeResearch({ state, workers, access, retrievalRoot: f.root, emit, taskText,
      modules: { ...directSolverModules, M2: { ...directSolverModules.M2, applyLibrary },
        M1: { ...directSolverModules.M1, open: host.model, execute: host.model } } });
    try {
      expect(await cooperative.next(workers[1], { maxTurns: Infinity, remainingMs: Infinity }))
        .toMatchObject({ kind: 'task', task: { id: 'followup' } });
      const node = state.cooperation!.tasks.find(node => node.task.id === task.id)!;
      expect(node).toMatchObject({ status: 'integrated', attempts: 0, integratedCheck: { passed: true, taskDigest: taskVersion(node.task) } });
      expect(read(f, state.cooperation!.canonicalCommit)).toContain('exact _root_.Frozen.add_zero');
      expect(state.cooperation!.deliveries!.find(delivery => delivery.taskId === task.id)).toMatchObject({
        knowledgeUses: [expect.objectContaining({ source: 'installed-library', status: 'checked-reference', declaration: reference })] });
      expect(emit).toHaveBeenCalledWith('task_library_application', expect.objectContaining({ passed: true, usedDeclarations: [reference] }));
      expect(applyLibrary).toHaveBeenCalledWith(expect.objectContaining({ taskText }));
      expect(state.turns).toBe(0);
      expect(host.model).not.toHaveBeenCalled();
    } finally { await cooperative.stop(); }
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { checkAgentTeamProofDelivery, integrateAgentTeamProofDelivery, readAgentTeamProofDelivery,
  ReusedTeamCheckFailure, type TeamFailureCache } from '../src/solver/agentTeamProof';
import { commitSolverSources, git, readSolverProblem } from '../src/solver/problem';
import { solverState } from './helpers/solver';
import { temporaryDirectory } from './helpers/files';
import { declarationSubmissionSchema } from '../src/solver/declarationArtifacts';
import { prepareAgentTeamWorkspace } from '../src/solver/agentTeamWorkspace';
import { buildAgentTeamContributions } from '../src/solver/agentTeamContributions';
import { teamDeclarationForwarding } from '../src/solver/agentTeamForwarding';
import { checkSolverProof } from '../src/solver/modules/evidence';
import * as evidence from '../src/solver/modules/evidence';
import { evaluateSolverProof } from '../src/solver/evaluation';
import { buildRunInspection, renderRunInspection } from '../src/solver/inspection';
import { writeSolverRunState } from '../src/solver/archive';
import { readKnowledgeCatalog } from '../src/solver/theoremKnowledgeStore';
import { importTeamKnowledgeDeliveries } from '../src/solver/theoremKnowledgeRuns';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const original = 'namespace Team\ntheorem original : True := by sorry\n' +
  'theorem other : True := by sorry\nend Team\n';
const peerHelper = 'theorem reusable (n : Nat) : n = n := by rfl\n';

function fixture(proof = peerHelper) {
  const directory = temporaryDirectory('agent-team-proof-'); roots.push(directory);
  const receipt = bootstrapLeanTask(path.join(directory, 'primary'), { source: original, task: 'Prove both frozen statements.' });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath), worktree = path.join(directory, 'child');
  git(receipt.workspaceRoot, ['worktree', 'add', '--quiet', '--detach', worktree, problem.baseCommit]);
  const state = solverState(problem, receipt.workspaceRoot, { runId: 'agent-team-proof-fixture', phase: 'running',
    environmentDigest: mathDigest('real lean standard environment') });
  const source = (root: string) => path.join(root, problem.projectRelative, 'Submission.lean');
  fs.writeFileSync(source(worktree), original.replace('end Team', proof + 'end Team'));
  const toolchain = path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.33.0');
  if (!fs.existsSync(path.join(toolchain, 'bin/lean'))) throw new Error('Real Lean 4.33.0 is required.');
  const env = { PATH: `${toolchain}/bin:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    ELAN_HOME: path.join(os.homedir(), '.elan'), LEAN_PATH: '', LEAN_SYSROOT: '',
    DEEPSCIENTIST_MATH_SANDBOX_BACKEND: 'bwrap', DEEPSCIENTIST_MATH_ENV_FILE: path.join(directory, 'missing.env') };
  const common = { state, env, signal: new AbortController().signal, timeoutMs: 30_000,
    assertWriterStopped: () => {}, evidenceDirectory: path.join(directory, 'runtime/agent-team/proofs') };
  const declarations = [{ file: 'Submission.lean', name: 'Team.reusable', type: '∀ n : Nat, n = n' }];
  const check = { ...common, agentId: 'child-1', worktree, seedCommit: problem.baseCommit, declarations };
  return { directory, receipt, problem, state, worktree, source, common, check };
}

function consumerWithDraft(f: ReturnType<typeof fixture>, draft: string) {
  const worktree = path.join(f.directory, 'consumer');
  git(f.receipt.workspaceRoot, ['worktree', 'add', '--quiet', '--detach', worktree, f.problem.baseCommit]);
  const source = original.replace('end Team', draft + 'end Team');
  const notes = 'Consumer draft: waiting for the checked Team.reusable dependency.\n';
  fs.writeFileSync(f.source(worktree), source); fs.writeFileSync(path.join(worktree, 'RESEARCH.md'), notes);
  return { worktree, source, notes, commit: commitSolverSources(f.problem, worktree) };
}

describe('agent-owned declaration deliveries with real Lean', () => {
  it('imports a chosen unadopted delivery from its archive and checks reuse in a different problem', async () => {
    const f = fixture('def shift (n : Nat) : Nat := n + 1\nabbrev first := shift 0\n' +
      'theorem first_eq_one : first = 1 := by rfl\n');
    prepareAgentTeamWorkspace({ sourceWorktree: f.problem.workspace, worktree: f.worktree,
      seedCommit: f.problem.baseCommit, migrationDirectory: path.join(f.directory, 'migration') });
    const declarations = [{ file: 'Submission.lean', name: 'Team.shift', type: 'Nat → Nat', kind: 'definition' as const },
      { file: 'Submission.lean', name: 'Team.first', type: 'Nat', kind: 'definition' as const },
      { file: 'Submission.lean', name: 'Team.first_eq_one', type: 'Team.first = 1' }];
    const delivery = await checkAgentTeamProofDelivery({ ...f.check, declarations,
      provenance: { taskId: 'gap', objectiveRevision: 2, exposures: [] } });
    const file = path.join(f.common.evidenceDirectory, 'deliveries', delivery.id + '.json');
    f.state.agentTeam = { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control', workers: [], events: [],
      operations: [], adoptions: [], deliveries: [{ id: delivery.id, taskId: 'gap', agentId: delivery.agentId, path: file }] };
    const stateFile = path.join(f.directory, 'runtime/state.json'), catalog = path.join(f.directory, 'catalog.json');
    writeSolverRunState(stateFile, f.state);
    fs.rmSync(f.worktree, { recursive: true });
    expect(() => git(f.problem.workspace, ['cat-file', '-e', delivery.commit + '^{commit}'])).toThrow();
    expect(() => importTeamKnowledgeDeliveries(stateFile, ['1'.repeat(64)])).toThrow('team_delivery_not_found');
    execFileSync('bun', ['scripts/mathematics/theoremKnowledge.ts', 'build', '--state', stateFile,
      '--team-delivery', delivery.id, '--output', catalog]);
    const base = readKnowledgeCatalog(catalog).base;
    expect(base).toMatchObject({ evidence: 'recorded-not-replayed', requiresFreshCheck: true });
    expect(base.entries).toHaveLength(3);
    const entries = declarations.map(d => base.entries.find(e => e.name === d.name)!);
    expect(entries.map(e => e.kind)).toEqual(['definition', 'definition', 'lemma']);
    expect(entries[2]!.dependencies.statement).toContainEqual({ file: 'Submission.lean', name: 'Team.first' });
    expect(entries[2]!.provenance[0]).toMatchObject({ taskId: 'gap', sourceCommit: delivery.commit,
      teamDelivery: { id: delivery.id, producerId: delivery.agentId, objectiveRevision: 2 } });
    const dst = bootstrapLeanTask(path.join(f.directory, 'destination'), {
      source: 'namespace Team\ntheorem cross_problem : 1 = (1 : Nat) := by sorry\nend Team\n', task: 'Prove cross_problem' });
    const problem = readSolverProblem(dst.workspaceRoot, dst.activeProblemPath);
    expect((await checkSolverProof(problem, dst.workspaceRoot, f.common.env, f.common.signal)).passed).toBe(false);
    const dstFile = path.join(dst.workspaceRoot, problem.projectRelative, 'Submission.lean');
    fs.writeFileSync(dstFile, fs.readFileSync(dstFile, 'utf8').replace('theorem cross_problem',
      entries.map(e => e.declaration.trimEnd()).join('\n') + '\ntheorem cross_problem').replace('by sorry', 'by exact first_eq_one'));
    expect((await checkSolverProof(problem, dst.workspaceRoot, f.common.env, f.common.signal)).passed).toBe(true);
  }, 90_000);
  it('checks the exact failed inputs once per live team, but retries operational errors and changed inputs', async () => {
    const f = fixture(), failureCache: TeamFailureCache = new Map();
    const declarations = [{ ...f.check.declarations[0]!, type: 'False' }];
    const check = { ...f.check, declarations, failureCache };
    const verify = vi.spyOn(evidence, 'checkProjectedDeclarations');
    verify.mockRejectedValueOnce(new Error('test verifier transport unavailable'));
    await expect(checkAgentTeamProofDelivery(check)).rejects.toThrow('test verifier transport unavailable');
    expect(failureCache.size).toBe(0);
    await expect(checkAgentTeamProofDelivery(check)).rejects.toThrow('math_declaration_artifact_check_failed');
    expect(failureCache.size).toBe(1);
    const firstCommit = git(f.worktree, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(f.worktree, 'RESEARCH.md'), 'Re-examine the same interface.\n');
    await expect(checkAgentTeamProofDelivery(check)).rejects.toMatchObject({ previous: { commit: firstCommit, agentId: 'child-1' } });
    expect(verify).toHaveBeenCalledTimes(2);
    const changedEnv = { ...check.env, LANG: 'C' };
    await expect(checkAgentTeamProofDelivery({ ...check, env: changedEnv })).rejects.toThrow('math_declaration_artifact_check_failed');
    expect(verify).toHaveBeenCalledTimes(3);
    fs.writeFileSync(f.source(f.worktree), fs.readFileSync(f.source(f.worktree), 'utf8').replace(':= by rfl', ':= by exact rfl'));
    const changed = await checkAgentTeamProofDelivery(check).catch(error => error);
    expect(changed).not.toBeInstanceOf(ReusedTeamCheckFailure); expect(verify).toHaveBeenCalledTimes(4);
    const fixed = await checkAgentTeamProofDelivery({ ...check, declarations: f.check.declarations });
    expect(fixed.artifacts[0]?.proof.passed).toBe(true); expect(verify).toHaveBeenCalledTimes(5);
  }, 90_000);

  it('rechecks explicitly nominated auxiliary definitions in the consumer without proving original goals', async () => {
    const def = 'def successor (n : Nat) : Nat := n + 1\nabbrev base : Nat := successor 0\n';
    const f = fixture();
    fs.writeFileSync(f.source(f.worktree), original.replace('theorem original', def + 'theorem original'));
    const declarations = ['successor', 'base'].map((name, i) => ({ file: 'Submission.lean',
      name: 'Team.' + name, type: i === 0 ? 'Nat → Nat' : 'Nat', kind: 'definition' as const }));
    const delivery = await checkAgentTeamProofDelivery({ ...f.check, declarations });
    const restored = readAgentTeamProofDelivery(path.join(f.common.evidenceDirectory, 'deliveries', delivery.id + '.json'), f.state);
    const consumer = consumerWithDraft(f, 'theorem base_eq_one : base = 1 := by rfl\n');
    const adoption = await integrateAgentTeamProofDelivery({ ...f.common, delivery: restored,
      worktree: consumer.worktree, expectedCommit: consumer.commit });
    expect(adoption.artifacts.map(a => [a.declaration.kind, a.proof.commit, a.proof.verification.status]))
      .toEqual(declarations.map(() => ['definition', adoption.commit, 'kernel_verified']));
    const delivered = delivery.artifacts.map(a => a.proof.verification);
    const adopted = adoption.artifacts.map(a => a.proof.verification);
    for (const batch of [delivered, adopted]) {
      expect(new Set(batch.map(v => v.sessionId)).size).toBe(1);
      expect(batch.map(v => v.results.map(r => r.theoremName))).toEqual(declarations.map(d => [d.name]));
      expect(new Set(batch.map(v => v.results[0]!.receiptId)).size).toBe(2);
    }
    expect(delivered[0]!.sessionId).not.toBe(adopted[0]!.sessionId);
    const merged = fs.readFileSync(f.source(consumer.worktree), 'utf8');
    expect(merged).toContain(def); expect(merged.match(/by sorry/gu)).toHaveLength(2);
    expect(f.state.check).toBeUndefined();
    const later = await checkAgentTeamProofDelivery({ ...f.check, worktree: consumer.worktree,
      seedCommit: f.problem.baseCommit, declarations: [...declarations,
        { file: 'Submission.lean', name: 'Team.base_eq_one', type: 'Team.base = 1' }] });
    expect(later.artifacts.at(-1)!.proof.verification.status).toBe('kernel_verified');
  }, 90_000);

  it('adopts two checked helpers even when an unrelated consumer draft fails to elaborate', async () => {
    const f = fixture(peerHelper + 'theorem second : True := by trivial\n');
    const declarations = [...f.check.declarations, { file: 'Submission.lean', name: 'Team.second', type: 'True' }];
    const delivery = await checkAgentTeamProofDelivery({ ...f.check, declarations });
    const draft = 'theorem unresolved : True := by exact missing_proof\n';
    const consumer = consumerWithDraft(f, 'theorem established : True := by trivial\n' + draft);
    const verify = vi.spyOn(evidence, 'checkProjectedDeclarations');
    const adoption = await integrateAgentTeamProofDelivery({ ...f.common, delivery,
      worktree: consumer.worktree, expectedCommit: consumer.commit });
    expect(verify.mock.calls.map(([, , , , targets]) => targets.map(target => target.theoremName)))
      .toEqual([['Team.reusable', 'Team.second'], ['Team.reusable'], ['Team.second']]);
    expect(adoption.artifacts.map(a => a.proof.verification.status)).toEqual(['kernel_verified', 'kernel_verified']);
    expect(fs.readFileSync(f.source(consumer.worktree), 'utf8')).toContain(draft);
  }, 90_000);

  it('refuses incorrect types, incomplete bodies and replacement of an existing definition', async () => {
    const body = 'def encode (n : Nat) : Nat := n + 1\n', f = fixture(body);
    const decl = { file: 'Submission.lean', name: 'Team.encode', type: 'Nat → Nat', kind: 'definition' as const };
    const submit = (type = decl.type, seedCommit = f.problem.baseCommit) =>
      checkAgentTeamProofDelivery({ ...f.check, seedCommit, declarations: [{ ...decl, type }] });
    await expect(submit('Nat → Bool')).rejects.toThrow(/check_failed/);
    const seedCommit = git(f.worktree, ['rev-parse', 'HEAD']);
    fs.writeFileSync(f.source(f.worktree), original.replace('end Team', body.replace('n + 1', 'n + 2') + 'end Team'));
    await expect(submit(decl.type, seedCommit)).rejects.toThrow(/definition_must_be_new/);
    fs.writeFileSync(f.source(f.worktree), original.replace('end Team', body.replace('n + 1', 'by sorry') + 'end Team'));
    await expect(submit()).rejects.toThrow();
    expect(f.state.check).toBeUndefined();
  }, 90_000);

  it('evaluates the checked commit even if the worker keeps editing afterward', async () => {
    const f = fixture();
    const verifiedSource = original.replaceAll('by sorry', 'by trivial');
    fs.writeFileSync(f.source(f.worktree), verifiedSource);
    const checked = await checkSolverProof(f.problem, f.worktree, f.common.env, f.common.signal);
    expect(checked.passed).toBe(true);
    const laterSource = verifiedSource.replaceAll('by trivial', 'by exact True.intro');
    fs.writeFileSync(f.source(f.worktree), laterSource);

    const evaluation = await evaluateSolverProof(f.problem, checked, f.common.env, f.common.signal, {
      command: "grep -qFx 'theorem original : True := by trivial' Submission.lean",
      timeoutMs: 30_000,
    });

    expect(evaluation).toMatchObject({ status: 'passed', method: 'external-command', result: { exitCode: 0 } });
    expect(git(f.problem.workspace, ['rev-parse', 'HEAD'])).toBe(checked.commit);
    expect(fs.readFileSync(f.source(f.worktree), 'utf8')).toBe(laterSource);
  }, 30_000);

  it('matches versions and separates final direct, transitive, absent and unknown references', async () => {
    const f = fixture(), problem = f.problem, lead = path.join(f.directory, 'runtime/worktree');
    git(problem.workspace, ['worktree', 'add', '--quiet', '--detach', lead, problem.baseCommit]);
    const names = ['deep', 'helper', 'side', 'changed'];
    fs.writeFileSync(f.source(f.worktree), original.replace('theorem original',
      names.map(n => 'theorem ' + n + ' : True := by ' + (n === 'helper' ? 'exact deep' : 'trivial')).join('\n') + '\ntheorem original'));
    const declarations = names.map(n => ({ file: 'Submission.lean', name: 'Team.' + n, type: 'True' }));
    const delivery = await checkAgentTeamProofDelivery({ ...f.check, declarations });
    const adoption = await integrateAgentTeamProofDelivery({ ...f.common, delivery, worktree: lead, expectedCommit: problem.baseCommit });
    const state = f.state; state.worktree = lead;
    state.researchMode = 'skill'; state.workerCount = 1; state.researchDelegation = { mode: 'team', maxAgents: 2 };
    const reference = { id: delivery.id, agentId: f.check.agentId, taskId: 'task', path: path.join(f.common.evidenceDirectory, 'deliveries', delivery.id + '.json') };
    state.agentTeam = { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control', workers: [], events: [], operations: [],
      deliveries: [reference], adoptions: [{ id: 'selected', targetId: 'lead', deliveryId: delivery.id,
        expectedCommit: problem.baseCommit, commit: adoption.commit, status: 'completed' }] };
    const edited = fs.readFileSync(f.source(lead), 'utf8').replace('changed : True := by trivial', 'changed : True := True.intro')
      .replace('original : True := by sorry', 'original : True := by exact helper')
      .replace('other : True := by sorry', 'other : True := by exact changed');
    fs.writeFileSync(f.source(lead), edited);
    state.check = await checkSolverProof(problem, lead, f.common.env, f.common.signal);
    expect(state.check.passed).toBe(true);
    const evaluation = await evaluateSolverProof(problem, state.check, f.common.env, f.common.signal, { timeoutMs: 30_000, teamContributions: true });
    expect(evaluation.status).toBe('passed');
    const report = buildAgentTeamContributions(state, evaluation), relations = (r: typeof report) =>
      Object.fromEntries(r.declarations.map(d => [d.name, d.targets.map(t => t.relation)]));
    expect(relations(report)).toEqual({ 'Team.deep': ['indirect', 'not-referenced'], 'Team.helper': ['direct', 'not-referenced'],
      'Team.side': ['not-referenced', 'not-referenced'], 'Team.changed': ['unknown', 'unknown'] });
    const old = structuredClone(evaluation);
    delete (old.verification as typeof state.check).verification.results[0]!.directProofReferences;
    delete (old.verification as typeof state.check).verification.results[1]!.declarationReferences;
    expect(relations(buildAgentTeamContributions(state, old))['Team.helper']).toEqual(['referenced', 'unknown']);
    state.phase = 'finished';
    const inspection = buildRunInspection(state, { runId: state.runId, solution_commit: state.check.commit,
      status: 'evaluated_passed', evaluator: evaluation, teamContributions: report });
    expect(renderRunInspection(inspection)).toContain('Team.deep | Team.original | indirect');
    state.agentTeam.adoptions = [];
    expect(relations(buildAgentTeamContributions(state, evaluation))['Team.helper']).toEqual(['unknown', 'unknown']);
  }, 90_000);
  it('checks independent member evidence, survives source cleanup, and imports only during authorized adoption', async () => {
    const f = fixture(), migrationDirectory = path.join(f.directory, 'runtime/agent-team/migrations');
    const prepare = (worktree: string) => prepareAgentTeamWorkspace({ sourceWorktree: f.receipt.workspaceRoot,
      worktree, seedCommit: f.problem.baseCommit, migrationDirectory });
    prepare(f.worktree);
    const consumer = consumerWithDraft(f, 'theorem ownDraft : True := by sorry\n'); prepare(consumer.worktree);
    const provenance = { objectiveRevision: 3, exposures: [{ deliveryId: mathDigest('prior research'), agentId: 'peer',
      taskId: 'research-1', commit: f.problem.baseCommit, kind: 'inspected' as const, at: '2026-11-17T00:00:00.000Z' }] };
    const delivery = await checkAgentTeamProofDelivery({ ...f.check, provenance });
    expect(delivery.provenance).toEqual(provenance);
    expect(() => git(f.receipt.workspaceRoot, ['show', `${delivery.commit}:${f.problem.projectRelative}/Submission.lean`])).toThrow();
    expect(() => git(consumer.worktree, ['show', `${delivery.commit}:${f.problem.projectRelative}/Submission.lean`])).toThrow();
    const archive = path.join(f.common.evidenceDirectory, 'sources.git');
    expect(git(archive, ['show', `${delivery.commit}:${f.problem.projectRelative}/Submission.lean`])).toContain('theorem reusable');
    for (const artifact of delivery.artifacts)
      expect(git(archive, ['rev-parse', `${artifact.proof.verification.targetCommit}^{commit}`]))
        .toBe(artifact.proof.verification.targetCommit);
    fs.rmSync(f.worktree, { recursive: true });
    const restored = readAgentTeamProofDelivery(path.join(f.common.evidenceDirectory, 'deliveries', `${delivery.id}.json`), f.state);
    const adoption = await integrateAgentTeamProofDelivery({ ...f.common, delivery: restored,
      worktree: consumer.worktree, expectedCommit: consumer.commit });
    expect(git(consumer.worktree, ['rev-parse', 'HEAD'])).toBe(adoption.commit);
    expect(fs.readFileSync(f.source(consumer.worktree), 'utf8')).toContain('theorem ownDraft : True := by sorry');
    expect(fs.readFileSync(f.source(consumer.worktree), 'utf8')).toContain(peerHelper);
    expect(fs.readFileSync(path.join(consumer.worktree, 'RESEARCH.md'), 'utf8')).toBe(consumer.notes);
    expect(await integrateAgentTeamProofDelivery({ ...f.common, delivery: restored,
      worktree: consumer.worktree, expectedCommit: consumer.commit })).toEqual(adoption);
    expect(f.state.check).toBeUndefined();
  }, 90_000);

  it('freezes a helper in a separate worktree, restores its record, and adopts only after a fresh check', async () => {
    const f = fixture(), delivery = await checkAgentTeamProofDelivery(f.check);
    expect(delivery.artifacts[0]!.proof.verification.results[0]).toMatchObject({ status: 'kernel_verified',
      theoremName: 'Team.reusable', sorryCount: 0, admitCount: 0 });
    const file = path.join(f.common.evidenceDirectory, 'deliveries', `${delivery.id}.json`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o400);
    const restored = readAgentTeamProofDelivery(file, f.state);
    expect(restored).toEqual(delivery);
    // Frozen commits, not the mutable child directory, survive thread/worktree cleanup.
    git(f.worktree, ['worktree', 'remove', '--force', f.worktree]);
    fs.writeFileSync(f.source(f.receipt.workspaceRoot), original.replace('end Team',
      'theorem peer : True := by trivial\nend Team'));
    const beforeCommit = commitSolverSources(f.problem, f.receipt.workspaceRoot);
    const adoption = await integrateAgentTeamProofDelivery({ ...f.common, delivery: restored,
      worktree: f.receipt.workspaceRoot, expectedCommit: beforeCommit });
    const merged = fs.readFileSync(f.source(f.receipt.workspaceRoot), 'utf8');
    expect(merged).toContain('theorem reusable'); expect(merged).toContain('theorem peer');
    expect(merged.match(/by sorry/gu)).toHaveLength(2);
    expect(adoption).toMatchObject({ deliveryId: delivery.id, beforeCommit });
    expect(adoption.artifacts[0]!.proof.commit).toBe(adoption.commit);
    expect(adoption.artifacts[0]!.proof.verification.results[0]!.status).toBe('kernel_verified');
    expect(git(f.receipt.workspaceRoot, ['rev-parse', 'HEAD'])).toBe(adoption.commit);
    expect(fs.statSync(path.join(f.common.evidenceDirectory, 'adoptions', `${adoption.id}.json`)).mode & 0o777).toBe(0o400);
    expect(f.state.phase).toBe('running'); expect(f.state.check).toBeUndefined();
  }, 90_000);

  it('imports legacy shared-repository evidence into a migrated independent receiver', async () => {
    const f = fixture(), delivery = await checkAgentTeamProofDelivery(f.check);
    // Older runs retained these objects only in the primary common repository.
    fs.rmSync(path.join(f.common.evidenceDirectory, 'sources.git'), { recursive: true });
    git(f.receipt.workspaceRoot, ['worktree', 'remove', '--force', f.worktree]);
    const consumer = consumerWithDraft(f, 'theorem ownDraft : True := by sorry\n');
    prepareAgentTeamWorkspace({ sourceWorktree: f.receipt.workspaceRoot, worktree: consumer.worktree,
      seedCommit: f.problem.baseCommit, migrationDirectory: path.join(f.directory, 'runtime/agent-team/migrations') });
    expect(() => git(consumer.worktree, ['cat-file', '-e', `${delivery.commit}^{commit}`])).toThrow();
    const adoption = await integrateAgentTeamProofDelivery({ ...f.common, delivery,
      worktree: consumer.worktree, expectedCommit: consumer.commit });
    expect(git(consumer.worktree, ['rev-parse', 'HEAD'])).toBe(adoption.commit);
    expect(fs.readFileSync(f.source(consumer.worktree), 'utf8')).toContain(peerHelper);
    expect(fs.readFileSync(f.source(consumer.worktree), 'utf8')).toContain('theorem ownDraft');
  }, 90_000);

  it('adopts an explicitly delivered original theorem without accepting unfinished original targets', async () => {
    const f = fixture();
    fs.writeFileSync(f.source(f.worktree), original.replace('original : True := by sorry', 'original : True := by trivial'));
    const delivery = await checkAgentTeamProofDelivery({ ...f.check,
      declarations: [{ file: 'Submission.lean', name: 'Team.original', type: 'True' }] });
    const adoption = await integrateAgentTeamProofDelivery({ ...f.common, delivery, worktree: f.receipt.workspaceRoot,
      expectedCommit: f.problem.baseCommit });
    expect(fs.readFileSync(f.source(f.receipt.workspaceRoot), 'utf8')).toBe(
      original.replace('original : True := by sorry', 'original : True := by trivial'));
    expect(adoption.artifacts).toHaveLength(1);
    expect(adoption.artifacts[0]!.declaration.name).toBe('Team.original');
    expect(f.state.check).toBeUndefined();
  }, 90_000);

  it('preserves a fixed unfinished consumer draft while adopting its missing peer dependency and recovering the same transition', async () => {
    const f = fixture();
    fs.writeFileSync(f.source(f.worktree), original.replace('theorem original', peerHelper + 'theorem original'));
    const draft = 'theorem downstream (n : Nat) : n = n := by\n  have h := reusable n\n  sorry\n';
    const consumer = consumerWithDraft(f, draft);
    const downstream = { file: 'Submission.lean', name: 'Team.downstream', type: '∀ n : Nat, n = n' };
    await expect(checkAgentTeamProofDelivery({ ...f.check, agentId: 'consumer', worktree: consumer.worktree,
      declarations: [downstream] })).rejects.toThrow('math_declaration_artifact_check_failed');
    const delivery = await checkAgentTeamProofDelivery(f.check);
    const input = { ...f.common, delivery, worktree: consumer.worktree, expectedCommit: consumer.commit };
    const adoption = await integrateAgentTeamProofDelivery(input);
    const expected = consumer.source.replace('theorem original', peerHelper + 'theorem original');
    expect(fs.readFileSync(f.source(consumer.worktree), 'utf8')).toBe(expected);
    expect(fs.readFileSync(path.join(consumer.worktree, 'RESEARCH.md'), 'utf8')).toBe(consumer.notes);
    expect(git(consumer.worktree, ['show', `${consumer.commit}:${f.problem.projectRelative}/Submission.lean`]))
      .toBe(consumer.source.trim());
    expect(adoption.beforeCommit).toBe(consumer.commit);
    expect(adoption.artifacts.map(artifact => artifact.declaration.name)).toEqual(['Team.reusable']);
    expect(adoption.artifacts[0]!.proof.verification.results[0]).toMatchObject({ status: 'kernel_verified', sorryCount: 0 });
    expect(f.state.check).toBeUndefined();
    const recovered = { ...input, state: structuredClone(f.state), delivery: readAgentTeamProofDelivery(
      path.join(f.common.evidenceDirectory, 'deliveries', `${delivery.id}.json`), f.state) };
    expect(await integrateAgentTeamProofDelivery(recovered)).toEqual(adoption);
    expect(git(consumer.worktree, ['rev-parse', 'HEAD'])).toBe(adoption.commit);
    expect(fs.readFileSync(f.source(consumer.worktree), 'utf8')).toBe(expected);
    fs.writeFileSync(f.source(consumer.worktree), expected.replace(draft,
      'theorem downstream (n : Nat) : n = n := by exact reusable n\n'));
    const completed = await checkAgentTeamProofDelivery({ ...f.check, agentId: 'consumer', worktree: consumer.worktree,
      declarations: [...delivery.declarations, downstream] });
    expect(completed.seedCommit).toBe(f.problem.baseCommit);
    expect(completed.artifacts.map(artifact => artifact.declaration.name)).toEqual(['Team.reusable', 'Team.downstream']);
    expect(completed.artifacts.every(artifact => artifact.proof.verification.status === 'kernel_verified')).toBe(true);
  }, 90_000);

  it('re-delivers an adopted peer and a new consumer declaration into a Lead already owning the identical peer', async () => {
    const f = fixture();
    fs.writeFileSync(f.source(f.worktree), original.replace('theorem original', peerHelper + 'theorem original'));
    const draft = 'theorem downstream (n : Nat) : n = n := by exact reusable n\n';
    const consumer = consumerWithDraft(f, draft), delivery = await checkAgentTeamProofDelivery(f.check);
    const peerAdoption = await integrateAgentTeamProofDelivery({ ...f.common, delivery, worktree: consumer.worktree, expectedCommit: consumer.commit });
    const lead = f.receipt.workspaceRoot;
    const leadAdoption = await integrateAgentTeamProofDelivery({ ...f.common, delivery, worktree: lead,
      expectedCommit: f.problem.baseCommit });
    const downstream = { file: 'Submission.lean', name: 'Team.downstream', type: '∀ n : Nat, n = n' };
    // Keeping the consumer's original delivery baseline requires accounting for the adopted delta too.
    await expect(checkAgentTeamProofDelivery({ ...f.check, agentId: 'consumer', worktree: consumer.worktree,
      declarations: [downstream] })).rejects.toThrow('math_agent_team_proof_undeclared_source_change');
    const combined = await checkAgentTeamProofDelivery({ ...f.check, agentId: 'consumer', worktree: consumer.worktree,
      declarations: [...delivery.declarations, downstream], provenance: { exposures: [{ kind: 'adopted', agentId: delivery.agentId,
        taskId: 'first', deliveryId: delivery.id, commit: delivery.commit, at: new Date().toISOString() }] } });
    expect(combined.changes.map(change => change.name)).toEqual(['reusable', 'downstream']);
    const adoption = await integrateAgentTeamProofDelivery({ ...f.common, delivery: combined, worktree: lead,
      expectedCommit: leadAdoption.commit });
    const source = fs.readFileSync(f.source(lead), 'utf8');
    expect(source.match(/theorem reusable/gu)).toHaveLength(1);
    expect(source).toContain(draft); expect(source.match(/by sorry/gu)).toHaveLength(2);
    expect(adoption.artifacts.map(artifact => artifact.declaration.name)).toEqual(['Team.reusable', 'Team.downstream']);
    expect(adoption.artifacts.every(artifact => artifact.proof.commit === adoption.commit &&
      artifact.proof.verification.status === 'kernel_verified')).toBe(true);
    expect(f.state.check).toBeUndefined();
    f.state.worktree = path.join(f.directory, 'runtime/worktree');
    f.state.agentTeam = { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control', workers: [], events: [], operations: [],
      adoptions: [{ id: 'to-consumer', deliveryId: delivery.id, targetId: 'consumer', status: 'completed',
        commit: peerAdoption.commit, expectedCommit: peerAdoption.beforeCommit }], deliveries: [delivery, combined].map(d =>
        ({ id: d.id, agentId: d.agentId, taskId: d.id === delivery.id ? 'first' : 'second',
          path: path.join(f.common.evidenceDirectory, 'deliveries', d.id + '.json') })) };
    const report = buildAgentTeamContributions(f.state, {});
    expect(report.declarations.find(d => d.agentId === 'consumer' && d.name === 'Team.reusable')?.forwardedFrom).toEqual([delivery.id]);
    expect(report.declarations.find(d => d.agentId === 'consumer' && d.name === 'Team.downstream')?.forwardedFrom).toEqual([]);
    const stateFile = path.join(f.directory, 'runtime/state.json');
    const imported = () => {
      writeSolverRunState(stateFile, f.state);
      const rows = importTeamKnowledgeDeliveries(stateFile, [combined.id]).candidates;
      expect(rows.map(r => r.name)).toEqual(['Team.reusable', 'Team.downstream']);
      return rows.map(r => r.provenance.teamDelivery!);
    };
    const [peer, own] = imported();
    expect(peer).toMatchObject({ id: combined.id, producerId: 'consumer', forwardedFrom: [
      { deliveryId: delivery.id, producerId: delivery.agentId, taskId: 'first' }] });
    expect(own).not.toHaveProperty('forwardedFrom');
    const transfers = teamDeclarationForwarding(f.state, f.common.evidenceDirectory);
    expect(transfers.origins({ ...combined, provenance: { exposures: combined.provenance!.exposures!
      .map(e => ({ ...e, kind: 'inspected' as const })) } }, 'Submission.lean', 'Team.reusable')).toEqual([]);
    expect(transfers.origins({ ...combined, changes: combined.changes.map(c =>
      c.name === 'reusable' ? { ...c, after: c.after.replace('by rfl', 'by simp') } : c) },
      'Submission.lean', 'Team.reusable')).toEqual([]);
    // Adoption without a source change cannot establish that the declaration came from the peer.
    const transfer = f.state.agentTeam.adoptions[0]!;
    transfer.expectedCommit = transfer.commit;
    expect(imported()[0]).not.toHaveProperty('forwardedFrom');
    transfer.expectedCommit = peerAdoption.beforeCommit;
    // Leave the selected delivery intact while its optional upstream record becomes unavailable.
    fs.unlinkSync(path.join(f.common.evidenceDirectory, 'deliveries', delivery.id + '.json'));
    expect(imported()[0]).not.toHaveProperty('forwardedFrom');
  }, 90_000);

  it('freshly checks and restores a host combination of one adopted peer plus a full 32-declaration member submission', async () => {
    const f = fixture();
    fs.writeFileSync(f.source(f.worktree), original.replace('theorem original', peerHelper + 'theorem original'));
    const names = Array.from({ length: 32 }, (_, index) => `own${index}`);
    const draft = names.map(name => `theorem ${name} (n : Nat) : n = n := by exact reusable n\n`).join('');
    const consumer = consumerWithDraft(f, draft), peer = await checkAgentTeamProofDelivery(f.check);
    await integrateAgentTeamProofDelivery({ ...f.common, delivery: peer, worktree: consumer.worktree,
      expectedCommit: consumer.commit });
    const own = names.map(name => ({ file: 'Submission.lean', name: `Team.${name}`, type: '∀ n : Nat, n = n' }));
    const declarations = [...peer.declarations, ...own];
    expect(declarationSubmissionSchema.safeParse({ declarations: own }).success).toBe(true);
    expect(declarationSubmissionSchema.safeParse({ declarations }).success).toBe(false);
    // The last entry repeats the first and leaves a change unnamed.
    await expect(checkAgentTeamProofDelivery({ ...f.check, agentId: 'consumer', worktree: consumer.worktree,
      declarations: [...declarations.slice(0, 32), peer.declarations[0]] }))
      .rejects.toThrow('math_agent_team_proof_undeclared_source_change');
    const combined = await checkAgentTeamProofDelivery({ ...f.check, agentId: 'consumer', worktree: consumer.worktree,
      declarations });
    expect(combined.artifacts).toHaveLength(33);
    expect(combined.artifacts.map(artifact => artifact.declaration.name)).toEqual(['Team.reusable', ...own.map(item => item.name)]);
    expect(combined.artifacts.every(artifact => artifact.proof.commit === combined.commit &&
      artifact.proof.verification.status === 'kernel_verified')).toBe(true);
    const restored = readAgentTeamProofDelivery(path.join(f.common.evidenceDirectory, 'deliveries', `${combined.id}.json`), f.state);
    expect(restored).toEqual(combined);
    const input = { ...f.common, delivery: restored, worktree: f.receipt.workspaceRoot, expectedCommit: f.problem.baseCommit };
    const adoption = await integrateAgentTeamProofDelivery(input);
    expect(adoption.artifacts).toHaveLength(33);
    expect(adoption.artifacts.every(artifact => artifact.proof.commit === adoption.commit &&
      artifact.proof.verification.status === 'kernel_verified')).toBe(true);
    expect(adoption.artifacts[32].declaration.name).toBe('Team.own31');
    expect(await integrateAgentTeamProofDelivery(input)).toEqual(adoption);
    const source = fs.readFileSync(f.source(f.receipt.workspaceRoot), 'utf8');
    expect(source).toContain(draft);
    expect(source.match(/theorem reusable/gu)).toHaveLength(1);
    expect(source.match(/by sorry/gu)).toHaveLength(2);
    expect(f.state.check).toBeUndefined();
  }, 180_000);

  it('rejects an incorrect proof and a false claimed type without publishing evidence', async () => {
    const f = fixture('theorem reusable (n : Nat) : n = n := by exact False.elim (by trivial)\n');
    await expect(checkAgentTeamProofDelivery(f.check)).rejects.toThrow('math_declaration_artifact_check_failed');
    expect(fs.existsSync(f.common.evidenceDirectory)).toBe(false);
    fs.writeFileSync(f.source(f.worktree), original.replace('end Team', peerHelper +
      'theorem second : True := by trivial\nend Team'));
    await expect(checkAgentTeamProofDelivery({ ...f.check,
      declarations: [...f.check.declarations, { file: 'Submission.lean', name: 'Team.second', type: 'False' }] }))
      .rejects.toThrow('math_declaration_artifact_check_failed:Team.second');
    expect(fs.existsSync(f.common.evidenceDirectory)).toBe(false);
    expect(fs.readFileSync(f.source(f.receipt.workspaceRoot), 'utf8')).toBe(original);
  }, 90_000);

  it.each(['helper', 'definition', 'original-proof'] as const)('rejects an undeclared %s change', async kind => {
    const f = fixture(), file = f.source(f.worktree);
    const addition = kind === 'helper' ? 'theorem hidden : True := by trivial\n' : 'def hidden : Nat := 3\n';
    fs.writeFileSync(file, kind === 'original-proof' ? fs.readFileSync(file, 'utf8').replace('original : True := by sorry',
      'original : True := by trivial') : fs.readFileSync(file, 'utf8').replace('end Team', addition + 'end Team'));
    await expect(checkAgentTeamProofDelivery(f.check)).rejects.toThrow('math_agent_team_proof_undeclared_source_change');
    expect(fs.existsSync(f.common.evidenceDirectory)).toBe(false);
  });

  it.each(['name', 'file'] as const)('reports an invalid declaration %s as correctable delivery input', async field => {
    const f = fixture();
    const declaration = { ...f.check.declarations[0]!, ...(field === 'name'
      ? { name: 'Team.missing' } : { file: 'Unowned.lean' }) };
    await expect(checkAgentTeamProofDelivery({ ...f.check, declarations: [declaration] })).rejects.toThrow(
      field === 'name' ? 'math_agent_team_proof_declaration_missing' : 'math_agent_team_proof_declaration_outside_ownership');
    expect(fs.existsSync(f.common.evidenceDirectory)).toBe(false);
    expect(fs.readFileSync(f.source(f.receipt.workspaceRoot), 'utf8')).toBe(original);
  });

  it('preserves actual Git and filesystem failures as infrastructure errors', async () => {
    const f = fixture();
    await expect(checkAgentTeamProofDelivery({ ...f.check, seedCommit: 'f'.repeat(40) }))
      .rejects.toThrow('math_git_failed:merge-base');
    fs.unlinkSync(f.source(f.worktree));
    await expect(checkAgentTeamProofDelivery(f.check)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fs.existsSync(f.common.evidenceDirectory)).toBe(false);
  });

  it('preserves the Git diagnostic when an existing seed commit is missing the owned source', async () => {
    const f = fixture(), file = f.source(f.worktree), source = fs.readFileSync(file);
    const relative = path.relative(f.worktree, file);
    git(f.worktree, ['rm', '--force', '--quiet', '--', relative]);
    git(f.worktree, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit',
      '--no-gpg-sign', '--quiet', '-m', 'Fixture without the owned source']);
    const seedCommit = git(f.worktree, ['rev-parse', 'HEAD']);
    fs.writeFileSync(file, source);
    commitSolverSources(f.problem, f.worktree);
    await expect(checkAgentTeamProofDelivery({ ...f.check, seedCommit })).rejects.toMatchObject({
      message: 'math_task_source_unavailable',
      diagnostic: { command: 'show', commit: seedCommit, file: relative },
    });
    expect(fs.existsSync(f.common.evidenceDirectory)).toBe(false);
  });

  it('rechecks changed dependencies instead of accepting the child\'s historical receipt', async () => {
    const f = fixture();
    const established = original.replace('end Team', 'theorem established : True := by trivial\nend Team');
    fs.writeFileSync(f.source(f.receipt.workspaceRoot), established);
    const seedCommit = commitSolverSources(f.problem, f.receipt.workspaceRoot);
    git(f.worktree, ['reset', '--hard', seedCommit]);
    fs.writeFileSync(f.source(f.worktree), established.replace('end Team',
      'theorem reusable : True := by exact established\nend Team'));
    const delivery = await checkAgentTeamProofDelivery({ ...f.check, seedCommit,
      declarations: [{ file: 'Submission.lean', name: 'Team.reusable', type: 'True' }] });
    const invalidated = established.replace('established : True := by trivial', 'established : True := by sorry');
    fs.writeFileSync(f.source(f.receipt.workspaceRoot), invalidated);
    const before = commitSolverSources(f.problem, f.receipt.workspaceRoot);
    await expect(integrateAgentTeamProofDelivery({ ...f.common, delivery, worktree: f.receipt.workspaceRoot,
      expectedCommit: before })).rejects.toThrow('math_declaration_artifact_check_failed');
    expect(git(f.receipt.workspaceRoot, ['rev-parse', 'HEAD'])).toBe(before);
    expect(fs.readFileSync(f.source(f.receipt.workspaceRoot), 'utf8')).toBe(invalidated);
    expect(fs.existsSync(path.join(f.common.evidenceDirectory, 'adoptions'))).toBe(false);
  }, 90_000);

  it('requires confirmed writer shutdown and preserves the frozen original statement', async () => {
    const f = fixture();
    await expect(checkAgentTeamProofDelivery({ ...f.check, assertWriterStopped: () => {
      throw new Error('writer_stop_unconfirmed');
    } })).rejects.toThrow('writer_stop_unconfirmed');
    expect(git(f.worktree, ['rev-parse', 'HEAD'])).toBe(f.problem.baseCommit);
    fs.writeFileSync(f.source(f.worktree), original.replace('original : True', 'original : False'));
    await expect(checkAgentTeamProofDelivery(f.check)).rejects.toThrow('math_original_declaration_changed');
    expect(fs.existsSync(f.common.evidenceDirectory)).toBe(false);
  });

  it('rejects changed identity, dirty primary source, stale expected commit, and forged patch metadata', async () => {
    const f = fixture(), delivery = await checkAgentTeamProofDelivery(f.check);
    const adopt = { ...f.common, delivery, worktree: f.receipt.workspaceRoot, expectedCommit: f.problem.baseCommit };
    await expect(integrateAgentTeamProofDelivery({ ...adopt, state: { ...f.state, environmentDigest: mathDigest('other') } }))
      .rejects.toThrow('math_agent_team_proof_delivery_identity_changed');
    const forged = { ...delivery, changes: [] }, { id: _id, ...body } = forged;
    forged.id = mathDigest(canonicalMathJson(body));
    await expect(integrateAgentTeamProofDelivery({ ...adopt, delivery: forged })).rejects.toThrow('math_agent_team_proof_delivery_patch_changed');
    fs.appendFileSync(f.source(f.receipt.workspaceRoot), '-- primary is still writing\n');
    await expect(integrateAgentTeamProofDelivery(adopt)).rejects.toThrow('math_agent_team_proof_source_changed');
    commitSolverSources(f.problem, f.receipt.workspaceRoot);
    await expect(integrateAgentTeamProofDelivery(adopt)).rejects.toThrow('math_agent_team_proof_source_changed');
    expect(fs.existsSync(path.join(f.common.evidenceDirectory, 'adoptions'))).toBe(false);
  }, 90_000);

  it('does not overwrite a conflicting declaration or accept a source changed during the fresh check', async () => {
    const f = fixture(), delivery = await checkAgentTeamProofDelivery(f.check);
    fs.writeFileSync(f.source(f.receipt.workspaceRoot), original.replace('end Team',
      'theorem reusable (n : Nat) : n = n := by exact Eq.refl n\nend Team'));
    const conflict = commitSolverSources(f.problem, f.receipt.workspaceRoot);
    await expect(integrateAgentTeamProofDelivery({ ...f.common, delivery, worktree: f.receipt.workspaceRoot,
      expectedCommit: conflict })).rejects.toThrow('math_task_integration_conflict');
    expect(git(f.receipt.workspaceRoot, ['rev-parse', 'HEAD'])).toBe(conflict);
    fs.writeFileSync(f.source(f.receipt.workspaceRoot), original);
    const before = commitSolverSources(f.problem, f.receipt.workspaceRoot);
    const checking = integrateAgentTeamProofDelivery({ ...f.common, delivery, worktree: f.receipt.workspaceRoot,
      expectedCommit: before });
    fs.appendFileSync(f.source(f.receipt.workspaceRoot), '-- changed while checking\n');
    await expect(checking).rejects.toThrow('math_agent_team_proof_source_changed');
    expect(git(f.receipt.workspaceRoot, ['rev-parse', 'HEAD'])).toBe(before);
    expect(fs.readFileSync(f.source(f.receipt.workspaceRoot), 'utf8')).toContain('-- changed while checking');
    expect(fs.existsSync(path.join(f.common.evidenceDirectory, 'adoptions'))).toBe(false);
  }, 90_000);

  it('rejects an edit to the staged adoption while Lean is checking', async () => {
    const f = fixture(), delivery = await checkAgentTeamProofDelivery(f.check);
    const verify = evidence.checkProjectedDeclarations;
    vi.spyOn(evidence, 'checkProjectedDeclarations').mockImplementationOnce(async (...args) => {
      const result = await verify(...args);
      expect(result.passed).toBe(true);
      fs.appendFileSync(f.source(args[2]), '\n-- staged source changed after Lean read it\n');
      return result;
    });
    await expect(integrateAgentTeamProofDelivery({ ...f.common, delivery, worktree: f.receipt.workspaceRoot,
      expectedCommit: f.problem.baseCommit })).rejects.toThrow('math_agent_team_proof_source_changed');
    expect(git(f.receipt.workspaceRoot, ['rev-parse', 'HEAD'])).toBe(f.problem.baseCommit);
    expect(fs.existsSync(path.join(f.common.evidenceDirectory, 'adoption-intents'))).toBe(false);
  }, 90_000);

  it('recovers the exact FF after publication failed and makes the same call idempotent', async () => {
    const f = fixture(), delivery = await checkAgentTeamProofDelivery(f.check);
    const input = { ...f.common, delivery, worktree: f.receipt.workspaceRoot, expectedCommit: f.problem.baseCommit };
    const adoptions = path.join(f.common.evidenceDirectory, 'adoptions'), rename = fs.renameSync;
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).startsWith(adoptions + path.sep)) throw new Error('host_disconnected_after_ff');
      rename(from, to);
    });
    await expect(integrateAgentTeamProofDelivery(input)).rejects.toThrow('host_disconnected_after_ff');
    failure.mockRestore();
    const head = git(f.receipt.workspaceRoot, ['rev-parse', 'HEAD']);
    expect(head).not.toBe(f.problem.baseCommit);
    const directory = path.join(f.common.evidenceDirectory, 'adoption-intents'), files = fs.readdirSync(directory);
    expect(files).toHaveLength(1);
    const file = path.join(directory, files[0]!), intent = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(intent.adoption).toMatchObject({ commit: head, beforeCommit: input.expectedCommit, deliveryId: delivery.id });
    expect(fs.existsSync(path.join(adoptions, `${intent.adoption.id}.json`))).toBe(false);
    const restoredDelivery = readAgentTeamProofDelivery(path.join(f.common.evidenceDirectory, 'deliveries', `${delivery.id}.json`), f.state);
    const restoredInput = { ...input, delivery: restoredDelivery, state: structuredClone(f.state) };
    const recovered = await integrateAgentTeamProofDelivery(restoredInput);
    expect(recovered).toEqual(intent.adoption);
    const publication = path.join(adoptions, `${recovered.id}.json`), stamp = fs.statSync(publication).mtimeMs;
    expect(await integrateAgentTeamProofDelivery(restoredInput)).toEqual(recovered);
    expect(fs.statSync(publication).mtimeMs).toBe(stamp);
    expect(fs.readdirSync(adoptions).filter(name => /^[a-f0-9]{64}\.json$/u.test(name))).toEqual([`${recovered.id}.json`]);
    expect(git(f.receipt.workspaceRoot, ['rev-parse', 'HEAD'])).toBe(head);
    expect(f.state.check).toBeUndefined();
  }, 90_000);

  it('finishes a persisted intent interrupted before FF while preserving the originally checked transition', async () => {
    const f = fixture(), delivery = await checkAgentTeamProofDelivery(f.check);
    const input = { ...f.common, delivery, worktree: f.receipt.workspaceRoot, expectedCommit: f.problem.baseCommit };
    const directory = path.join(f.common.evidenceDirectory, 'adoption-intents');
    await expect(integrateAgentTeamProofDelivery({ ...input, assertWriterStopped: () => {
      if (fs.existsSync(directory) && fs.readdirSync(directory).length) throw new Error('host_disconnected_before_ff');
    } })).rejects.toThrow('host_disconnected_before_ff');
    expect(git(f.receipt.workspaceRoot, ['rev-parse', 'HEAD'])).toBe(input.expectedCommit);
    const file = path.join(directory, fs.readdirSync(directory)[0]!), stamp = fs.statSync(file).mtimeMs;
    const intent = JSON.parse(fs.readFileSync(file, 'utf8'));
    const adoption = await integrateAgentTeamProofDelivery(input);
    expect(adoption).toEqual(intent.adoption);
    expect(git(f.receipt.workspaceRoot, ['rev-parse', 'HEAD'])).toBe(intent.adoption.commit);
    expect(fs.statSync(file).mtimeMs).toBe(stamp);
    expect(fs.readFileSync(f.source(f.receipt.workspaceRoot), 'utf8')).toContain('theorem reusable');
  }, 90_000);

  it('refuses dirty or unrelated HEADs and mismatched identity when recovering a completed transition', async () => {
    const f = fixture(), delivery = await checkAgentTeamProofDelivery(f.check);
    const input = { ...f.common, delivery, worktree: f.receipt.workspaceRoot, expectedCommit: f.problem.baseCommit };
    const adoption = await integrateAgentTeamProofDelivery(input);
    await expect(integrateAgentTeamProofDelivery({ ...input, state: { ...f.state, runId: 'different-run' } }))
      .rejects.toThrow('delivery_identity_changed');
    const anotherDelivery = { ...delivery, agentId: 'different-delivery' }, { id: _id, ...body } = anotherDelivery;
    anotherDelivery.id = mathDigest(canonicalMathJson(body));
    await expect(integrateAgentTeamProofDelivery({ ...input, delivery: anotherDelivery })).rejects.toThrow('source_changed');
    const source = fs.readFileSync(f.source(f.receipt.workspaceRoot), 'utf8');
    fs.appendFileSync(f.source(f.receipt.workspaceRoot), '-- dirty after FF\n');
    await expect(integrateAgentTeamProofDelivery(input)).rejects.toThrow('source_changed');
    fs.writeFileSync(f.source(f.receipt.workspaceRoot), source);
    const directory = path.join(f.common.evidenceDirectory, 'adoption-intents'), file = path.join(directory, fs.readdirSync(directory)[0]!);
    const text = fs.readFileSync(file, 'utf8'), intent = JSON.parse(text);
    intent.runId = 'another-intent-run'; fs.chmodSync(file, 0o600); fs.writeFileSync(file, JSON.stringify(intent));
    await expect(integrateAgentTeamProofDelivery(input)).rejects.toThrow('adoption_intent_changed');
    fs.writeFileSync(file, text); fs.chmodSync(file, 0o400);
    // Identical owned bytes at a later, unrelated HEAD do not prove the recorded FF happened at this HEAD.
    git(f.receipt.workspaceRoot, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost',
      'commit', '--allow-empty', '--no-gpg-sign', '--quiet', '-m', 'Unrelated later commit']);
    expect(git(f.receipt.workspaceRoot, ['rev-parse', 'HEAD'])).not.toBe(adoption.commit);
    await expect(integrateAgentTeamProofDelivery(input)).rejects.toThrow('source_changed');
  }, 90_000);
});

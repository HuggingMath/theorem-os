import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { checkAgentTeamProofDelivery, integrateAgentTeamProofDelivery, readAgentTeamProofDelivery } from '../src/solver/agentTeamProof';
import { commitSolverSources, git, readSolverProblem } from '../src/solver/problem';
import { solverState } from './helpers/solver';
import { temporaryDirectory } from './helpers/files';
import { declarationSubmissionSchema } from '../src/solver/declarationArtifacts';

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
    await integrateAgentTeamProofDelivery({ ...f.common, delivery, worktree: consumer.worktree, expectedCommit: consumer.commit });
    const lead = f.receipt.workspaceRoot;
    const leadAdoption = await integrateAgentTeamProofDelivery({ ...f.common, delivery, worktree: lead,
      expectedCommit: f.problem.baseCommit });
    const downstream = { file: 'Submission.lean', name: 'Team.downstream', type: '∀ n : Nat, n = n' };
    // Keeping the consumer's original delivery baseline requires accounting for the adopted delta too.
    await expect(checkAgentTeamProofDelivery({ ...f.check, agentId: 'consumer', worktree: consumer.worktree,
      declarations: [downstream] })).rejects.toThrow('math_agent_team_proof_undeclared_source_change');
    const combined = await checkAgentTeamProofDelivery({ ...f.check, agentId: 'consumer', worktree: consumer.worktree,
      declarations: [...delivery.declarations, downstream] });
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
    // The duplicate is in the second checker batch; collection-wide delta checks still reject it.
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
    fs.writeFileSync(f.source(f.worktree), original.replace('end Team',
      'theorem reusable (n : Nat) : n = n := by rfl\nend Team'));
    await expect(checkAgentTeamProofDelivery({ ...f.check,
      declarations: [{ ...f.check.declarations[0]!, type: 'False' }] })).rejects.toThrow('math_declaration_artifact_check_failed');
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

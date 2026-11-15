import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import type { MathematicsVerifierBatchRequest } from '../src/math/verifier';
import { writeSolverRunState } from '../src/solver/archive';
import { checkDeclarationArtifacts, DECLARATION_SUBMISSION_FILE, declarationSubmissionSchema,
  readDeclarationArtifacts, readDeclarationSubmission, validateDeclarationArtifact, writeDeclarationArtifacts } from '../src/solver/declarationArtifacts';
import { buildTheoremKnowledge } from '../src/solver/theoremKnowledge';
import { importKnowledgeRuns } from '../src/solver/theoremKnowledgeRuns';
import { commitSolverSources, git, readSolverProblem } from '../src/solver/problem';
import { solverState } from './helpers/solver';
import { temporaryDirectory } from './helpers/files';
import { receiptBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../src/math/verifier', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/verifier')>(), checkManyFormalVerifications: host.verify,
}));
const roots: string[] = [];
beforeEach(() => { host.verify.mockReset().mockImplementation(async (request: MathematicsVerifierBatchRequest) =>
  receiptBatch(request, { sessionId: 'declaration-fixture', receiptId: index => `declaration-${request.targetCommit}-${index}` })); });
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(helper = 'theorem reusable (n : Nat) : n = n := by rfl\n', context = '') {
  const directory = temporaryDirectory('declaration-artifact-'); roots.push(directory);
  const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), {
    source: context + 'namespace Artifact\ntheorem original : True := by sorry\nend Artifact\n', task: 'Prove original.' });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  const file = path.join(receipt.projectRoot, 'Submission.lean');
  const source = fs.readFileSync(file, 'utf8').replace('end Artifact', `${helper}\nend Artifact`);
  fs.writeFileSync(file, source);
  const commit = commitSolverSources(problem, receipt.workspaceRoot);
  const state = solverState(problem, receipt.workspaceRoot, { runId: 'declaration-fixture', phase: 'prepared',
    environmentDigest: mathDigest('fixture environment') });
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', DEEPSCIENTIST_MATH_ENV_FILE: path.join(directory, 'absent.env') };
  const declaration = { file: 'Submission.lean', name: 'Artifact.reusable', type: '∀ n : Nat, n = n',
    description: 'Reflexivity with its full parameter.', premises: ['The quantified parameter is arbitrary.'] };
  const assertWriterStopped = vi.fn();
  const options = { state, worktree: receipt.workspaceRoot, commit, declarations: [declaration], env,
    signal: new AbortController().signal, assertWriterStopped };
  return { directory, receipt, file, source, commit, state, declaration, options };
}

describe('declarations independent of a task graph', () => {
  it('reads a bounded advisory submission and rejects unrelated fields or paths', () => {
    const f = fixture();
    expect(readDeclarationSubmission(f.receipt.workspaceRoot)).toBeUndefined();
    fs.mkdirSync(path.join(f.receipt.workspaceRoot, '.scratch'), { recursive: true });
    const file = path.join(f.receipt.workspaceRoot, '.scratch', DECLARATION_SUBMISSION_FILE);
    fs.writeFileSync(file, JSON.stringify({ declarations: [f.declaration] }));
    expect(readDeclarationSubmission(f.receipt.workspaceRoot)).toEqual({ declarations: [f.declaration] });
    expect(declarationSubmissionSchema.safeParse({ declarations: [{ ...f.declaration, file: '../outside.lean' }] }).success).toBe(false);
    expect(declarationSubmissionSchema.safeParse({ declarations: [f.declaration], passed: true }).success).toBe(false);
  });

  it('checks and imports a helper while the original goal remains unproved, preserving exact types and context', async () => {
    const f = fixture(), before = git(f.receipt.workspaceRoot, ['worktree', 'list', '--porcelain']);
    const artifacts = await checkDeclarationArtifacts(f.options);
    expect(host.verify).toHaveBeenCalledOnce();
    const [request, execution] = host.verify.mock.calls[0]!;
    expect(execution).toMatchObject({ expectedDeclarationType: f.declaration.type, collectDeclarationReferences: true });
    const checkedSource = git(f.receipt.workspaceRoot, ['show', `${request.targetCommit}:${f.state.problem.projectRelative}/Submission.lean`]);
    expect(checkedSource).toContain('theorem reusable'); expect(checkedSource).not.toContain('theorem original');
    expect(fs.readFileSync(f.file, 'utf8')).toBe(f.source);
    expect(git(f.receipt.workspaceRoot, ['worktree', 'list', '--porcelain'])).toBe(before);
    expect(f.state.cooperation).toBeUndefined(); expect(f.state.check).toBeUndefined();
    const output = path.join(f.directory, 'runtime'); fs.mkdirSync(output, { mode: 0o700 });
    writeDeclarationArtifacts(output, f.state, artifacts);
    writeDeclarationArtifacts(output, f.state, artifacts);
    expect(readDeclarationArtifacts(output, f.state)).toHaveLength(1);
    const stateFile = path.join(output, 'state.json'); writeSolverRunState(stateFile, f.state);
    const imported = importKnowledgeRuns([stateFile]);
    expect(imported.skipped).toEqual([]); expect(imported.candidates).toHaveLength(1);
    expect(imported.candidates[0]).toMatchObject({ name: 'Artifact.reusable', type: f.declaration.type,
      typeKind: 'closed-task-type', premises: f.declaration.premises, provenance: { runId: f.state.runId,
        sourceCommit: f.commit, checkedCommit: artifacts[0]!.proof.verification.targetCommit,
        environmentDigest: f.state.environmentDigest, problemReceiptDigest: f.state.problem.receiptDigest } });
    expect(imported.candidates[0]!.files['Submission.lean']).toBe(f.source);
    expect(buildTheoremKnowledge(imported.candidates)).toMatchObject({ requiresFreshCheck: true, evidence: 'recorded-not-replayed' });
  });

  it('requires a stopped writer and a fixed clean source before any independent check', async () => {
    const f = fixture();
    f.options.assertWriterStopped.mockImplementation(() => { throw new Error('math_writer_stop_unconfirmed'); });
    await expect(checkDeclarationArtifacts(f.options)).rejects.toThrow('math_writer_stop_unconfirmed');
    expect(host.verify).not.toHaveBeenCalled();
    f.options.assertWriterStopped.mockReset(); fs.appendFileSync(f.file, '-- changed after freeze\n');
    await expect(checkDeclarationArtifacts(f.options)).rejects.toThrow('math_declaration_artifact_source_changed');
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('rejects a new source axiom before it can become an unconditional artifact', () => {
    expect(() => fixture('axiom unjustified : False\ntheorem reusable : False := unjustified\n'))
      .toThrow('math_original_context_changed');
    expect(host.verify).not.toHaveBeenCalled();
  });

  it.each(['writer', 'source', 'environment'] as const)('rejects a %s change while Lean was checking', async change => {
    const f = fixture();
    host.verify.mockImplementationOnce(async request => {
      if (change === 'writer') f.options.assertWriterStopped.mockImplementation(() => { throw new Error('writer_reopened'); });
      if (change === 'source') fs.appendFileSync(f.file, '-- late writer\n');
      if (change === 'environment') f.options.env.PATH = '/changed/tools:/usr/bin:/bin';
      return receiptBatch(request, { sessionId: 'late', receiptId: () => 'late' });
    });
    await expect(checkDeclarationArtifacts(f.options)).rejects.toThrow(change === 'writer' ? 'writer_reopened' :
      `math_declaration_artifact_${change}_changed`);
    expect(fs.existsSync(path.join(f.directory, 'declarations.json'))).toBe(false);
  });

  it('refuses a cloned or changed receipt and refuses a manifest from another run or environment', async () => {
    const f = fixture(), artifacts = await checkDeclarationArtifacts(f.options);
    const output = path.join(f.directory, 'runtime'); fs.mkdirSync(output);
    expect(() => writeDeclarationArtifacts(output, f.state, structuredClone(artifacts))).toThrow('fresh_check_required');
    writeDeclarationArtifacts(output, f.state, artifacts);
    expect(() => readDeclarationArtifacts(output, { ...f.state, environmentDigest: mathDigest('other environment') }))
      .toThrow('manifest_identity_changed');
    const tampered = structuredClone(artifacts[0]!);
    tampered.proof.verification.results[0]!.axioms = ['sorryAx'];
    const { id: _id, ...body } = tampered;
    const forged = { ...tampered, id: mathDigest(canonicalMathJson(body)) };
    expect(() => validateDeclarationArtifact(forged)).toThrow('receipt_mismatch');
  });

  it('rejects failed type or kernel checks without publishing an artifact', async () => {
    const f = fixture();
    host.verify.mockImplementationOnce(async request => {
      const batch = receiptBatch(request, { sessionId: 'failed', receiptId: () => 'failed' });
      return { ...batch, status: 'failed', results: batch.results.map(receipt => ({ ...receipt,
        status: 'failed', error: 'Lean declaration type does not match the requested type.' })) };
    });
    await expect(checkDeclarationArtifacts(f.options)).rejects.toThrow('math_declaration_artifact_check_failed:Artifact.reusable');
  });

  it('does not import stale source digests and does not use mutable files to repair missing history', async () => {
    const f = fixture(), artifacts = await checkDeclarationArtifacts(f.options);
    const output = path.join(f.directory, 'runtime'); fs.mkdirSync(output);
    writeDeclarationArtifacts(output, f.state, artifacts);
    const file = path.join(output, 'declarations.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const value = manifest.artifacts[0]; value.proof.sourceDigest = mathDigest('different bytes');
    const { id: _id, ...body } = value; value.id = mathDigest(canonicalMathJson(body));
    fs.writeFileSync(file, JSON.stringify(manifest));
    const stateFile = path.join(output, 'state.json'); writeSolverRunState(stateFile, f.state);
    const imported = importKnowledgeRuns([stateFile]);
    expect(imported.candidates).toEqual([]);
    expect(imported.skipped[0]!.reason).toBe('math_knowledge_run_source_digest_mismatch');
  });
});

describe('independent declaration checks with the real verifier and Lean', () => {
  it.each([
    ['independent', 'theorem reusable (n : Nat) : n = n := by rfl\n', '∀ n : Nat, n = n', true, ''],
    ['wrong type', 'theorem reusable (n : Nat) : n = n := by rfl\n', 'False', false, ''],
    ['unproved original', 'theorem reusable : True := original\n', 'True', false, ''],
    ['non-foundational axiom', 'theorem reusable : False := unjustified\n', 'False', false, 'axiom unjustified : False\n'],
  ] as const)('accepts only a complete %s declaration with the requested full type', async (_kind, helper, type, passes, context) => {
    const f = fixture(helper, context);
    const toolchain = path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.33.0');
    if (!fs.existsSync(path.join(toolchain, 'bin/lean'))) throw new Error('Lean 4.33.0 is required for declaration artifact regressions.');
    const actual = await vi.importActual<typeof import('../src/math/verifier')>('../src/math/verifier');
    host.verify.mockImplementation(actual.checkManyFormalVerifications);
    f.options.env = { ...f.options.env, PATH: `${toolchain}/bin:/usr/bin:/bin`,
      ELAN_HOME: path.join(os.homedir(), '.elan'), DEEPSCIENTIST_MATH_SANDBOX_BACKEND: 'bwrap' };
    f.options.declarations[0]!.type = type;
    const result = checkDeclarationArtifacts(f.options);
    if (passes) {
      const records = await result;
      expect(records[0]!.proof.verification.results[0]).toMatchObject({ status: 'kernel_verified',
        sorryCount: 0, admitCount: 0, elaboratedDeclarationType: expect.any(String) });
    } else await expect(result).rejects.toThrow();
    expect(fs.readFileSync(f.file, 'utf8')).toBe(f.source);
  }, 60_000);
});

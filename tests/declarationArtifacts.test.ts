import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectWebDeclarationArtifacts } from '../apps/web/declarationArtifacts';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import type { MathematicsVerifierBatchRequest } from '../src/math/verifier';
import { writeSolverRunState } from '../src/solver/archive';
import { checkDeclarationArtifacts, DECLARATION_SUBMISSION_FILE, declarationSubmissionSchema, DeclarationSubmissionError,
  readDeclarationArtifacts, readDeclarationSubmission, validateDeclarationArtifact, writeDeclarationArtifacts,
  type DeclarationArtifact } from '../src/solver/declarationArtifacts';
import { buildTheoremKnowledge } from '../src/solver/theoremKnowledge';
import { importKnowledgeRuns } from '../src/solver/theoremKnowledgeRuns';
import { commitSolverSources, git, readSolverProblem } from '../src/solver/problem';
import { inspectStoredRun } from '../src/solver/storedRunInspection';
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

// Self-consistent history fixtures share one synthetic host receipt. They do not represent additional Lean checks.
function historicalArtifact(artifact: DeclarationArtifact, index: number): DeclarationArtifact {
  const { id: _id, ...body } = artifact;
  const record = { ...body, declaration: { ...artifact.declaration, description: `Historical metadata ${index}` } };
  return { ...record, id: mathDigest(canonicalMathJson(record)) };
}
function legacyManifest(f: ReturnType<typeof fixture>, artifacts: readonly DeclarationArtifact[]) {
  return { schema: 'theorem-os.declaration-artifacts.v1', runId: f.state.runId,
    problemReceiptDigest: f.state.problem.receiptDigest, environmentDigest: f.state.environmentDigest, artifacts };
}
function archiveFixture(f: ReturnType<typeof fixture>, artifacts: readonly DeclarationArtifact[]) {
  const output = path.join(f.directory, 'runtime'); fs.mkdirSync(output, { mode: 0o700 });
  const file = path.join(output, 'declarations.json');
  fs.writeFileSync(file, canonicalMathJson(legacyManifest(f, artifacts)));
  return { output, file };
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

  it('distinguishes correctable submission content from filesystem failures', () => {
    const f = fixture(), scratch = path.join(f.receipt.workspaceRoot, '.scratch'); fs.mkdirSync(scratch);
    const file = path.join(scratch, DECLARATION_SUBMISSION_FILE);
    for (const text of ['{', JSON.stringify({ declarations: [{ ...f.declaration, file: '../outside.lean' }] }),
      ' '.repeat(1024 * 1024 + 1)]) {
      fs.writeFileSync(file, text);
      expect(() => readDeclarationSubmission(f.receipt.workspaceRoot)).toThrow(DeclarationSubmissionError);
    }
    fs.writeFileSync(file, JSON.stringify({ declarations: [f.declaration] }));
    const failure = Object.assign(new Error('disk read failed'), { code: 'EIO' });
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw failure; });
    expect(() => readDeclarationSubmission(f.receipt.workspaceRoot)).toThrow(failure);
    expect(failure).not.toBeInstanceOf(DeclarationSubmissionError);
  });

  it.each(['missing', 'ownership', 'duplicate', 'type'] as const)('marks an invalid %s request as correctable before checking', async kind => {
    const f = fixture();
    if (kind === 'missing') f.options.declarations[0]!.name = 'Artifact.absent';
    if (kind === 'ownership') f.options.declarations[0]!.file = 'Unowned.lean';
    if (kind === 'duplicate') f.options.declarations.push({ ...f.declaration });
    if (kind === 'type') f.options.declarations[0]!.type = 'theorem reusable (n : Nat) : n = n';
    await expect(checkDeclarationArtifacts(f.options)).rejects.toBeInstanceOf(DeclarationSubmissionError);
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('marks a definition submitted as a theorem as correctable', async () => {
    const f = fixture('def reusable (n : Nat) : Nat := n\n');
    await expect(checkDeclarationArtifacts(f.options)).rejects.toBeInstanceOf(DeclarationSubmissionError);
    expect(host.verify).not.toHaveBeenCalled();
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
    const result = checkDeclarationArtifacts(f.options);
    await expect(result).rejects.not.toBeInstanceOf(DeclarationSubmissionError);
    await expect(result).rejects.toThrow(change === 'writer' ? 'writer_reopened' :
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

describe('durable declaration archive growth', () => {
  it('retains all records across the count boundary and retries an interrupted root publication', async () => {
    const f = fixture(), fresh = await checkDeclarationArtifacts(f.options);
    const history = Array.from({ length: 4096 }, (_, index) => historicalArtifact(fresh[0]!, index));
    const { output, file } = archiveFixture(f, history), before = fs.readFileSync(file);
    expect(readDeclarationArtifacts(output, f.state)).toHaveLength(4096);
    const rename = fs.renameSync, failure = new Error('root publication interrupted');
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === file) throw failure;
      return rename(from, to);
    });
    expect(() => writeDeclarationArtifacts(output, f.state, fresh)).toThrow(failure);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(readDeclarationArtifacts(output, f.state)).toHaveLength(4096);
    const segments = path.join(output, 'declarations.d');
    const segmentFiles = fs.readdirSync(segments).filter(name => name.endsWith('.json'));
    expect(segmentFiles.length).toBeGreaterThan(1);
    const stamps = segmentFiles.map(name => fs.statSync(path.join(segments, name)).mtimeMs);
    spy.mockRestore();
    writeDeclarationArtifacts(output, f.state, fresh);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ schema: 'theorem-os.declaration-artifacts.v2', count: 4097 });
    expect(fs.statSync(file).size).toBeLessThan(1024);
    expect(readDeclarationArtifacts(output, f.state).map(artifact => artifact.id)).toEqual([...history, ...fresh].map(artifact => artifact.id));
    expect(segmentFiles.map(name => fs.statSync(path.join(segments, name)).mtimeMs)).toEqual(stamps);

    const next = await checkDeclarationArtifacts({ ...f.options,
      declarations: [{ ...f.declaration, description: 'Another fresh metadata record.' }] });
    writeDeclarationArtifacts(output, f.state, next);
    const published = fs.readFileSync(file), filesAfter = fs.readdirSync(segments);
    expect(readDeclarationArtifacts(output, f.state)).toHaveLength(4098);
    writeDeclarationArtifacts(output, f.state, next);
    expect(fs.readFileSync(file)).toEqual(published); expect(fs.readdirSync(segments)).toEqual(filesAfter);
    expect(segmentFiles.map(name => fs.statSync(path.join(segments, name)).mtimeMs)).toEqual(stamps);
    expect(() => writeDeclarationArtifacts(output, f.state, structuredClone(next))).toThrow('fresh_check_required');
    expect(() => writeDeclarationArtifacts(output, f.state, readDeclarationArtifacts(output, f.state))).toThrow('fresh_check_required');
    expect(fs.readFileSync(file)).toEqual(published);
  }, 60_000);

  it('recovers a legacy 4097-record manifest instead of permanently blocking subsequent publications', async () => {
    const f = fixture(), fresh = await checkDeclarationArtifacts(f.options);
    const history = Array.from({ length: 4097 }, (_, index) => historicalArtifact(fresh[0]!, index));
    const { output, file } = archiveFixture(f, history);
    expect(() => readDeclarationArtifacts(output, f.state)).toThrow('manifest_identity_changed');
    writeDeclarationArtifacts(output, f.state, fresh);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ schema: 'theorem-os.declaration-artifacts.v2', count: 4098 });
    expect(readDeclarationArtifacts(output, f.state).map(artifact => artifact.id)).toEqual([...history, ...fresh].map(artifact => artifact.id));
  });

  it('segments at the byte boundary and preserves Web, inspection and knowledge provenance', async () => {
    const f = fixture(); f.options.declarations[0]!.premises = Array.from({ length: 64 }, () => 'p'.repeat(8000));
    const fresh = await checkDeclarationArtifacts(f.options), limit = 32 * 1024 * 1024;
    const history: DeclarationArtifact[] = [];
    let bytes = Buffer.byteLength(canonicalMathJson(legacyManifest(f, [])));
    for (let index = 0; ; index++) {
      const artifact = historicalArtifact(fresh[0]!, index), size = Buffer.byteLength(canonicalMathJson(artifact));
      if (bytes + size + (history.length ? 1 : 0) > limit) break;
      bytes += size + (history.length ? 1 : 0); history.push(artifact);
    }
    expect(history.length).toBeLessThan(4096);
    const { output, file } = archiveFixture(f, history);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(limit);
    expect(Buffer.byteLength(canonicalMathJson(legacyManifest(f, [...history, ...fresh])))).toBeGreaterThan(limit);
    writeDeclarationArtifacts(output, f.state, fresh);
    expect(readDeclarationArtifacts(output, f.state).map(artifact => artifact.id)).toEqual([...history, ...fresh].map(artifact => artifact.id));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ schema: 'theorem-os.declaration-artifacts.v2', count: history.length + 1 });
    for (const name of fs.readdirSync(path.join(output, 'declarations.d'))) {
      const segment = path.join(output, 'declarations.d', name);
      expect(fs.statSync(segment).size).toBeLessThanOrEqual(limit);
      expect(JSON.parse(fs.readFileSync(segment, 'utf8')).artifacts.length).toBeLessThanOrEqual(4096);
    }
    const stateFile = path.join(output, 'state.json'); writeSolverRunState(stateFile, f.state);
    const checks = host.verify.mock.calls.length, digest = mathDigest(fs.readFileSync(file));
    const web = projectWebDeclarationArtifacts(stateFile, f.state);
    expect(web).toMatchObject({ status: 'recorded', digest, evidence: 'recorded-not-replayed', requiresFreshCheck: true });
    if (web.status !== 'recorded') throw new Error('Expected readable v2 Web projection.');
    expect(web.declarations.length + web.omitted).toBe(history.length + 1); expect(web.omitted).toBeGreaterThan(0);
    const inspection = await inspectStoredRun(stateFile);
    expect(inspection.artifacts.declarations).toMatchObject({ status: 'recorded', digest,
      acceptance: 'not-assessed', requiresFreshCheck: true });
    const imported = importKnowledgeRuns([stateFile]);
    expect(imported.skipped).toEqual([]); expect(imported.candidates).toHaveLength(history.length + 1);
    expect(imported.candidates[0]!.provenance).toMatchObject({ sourceDigest: digest, sourceCommit: f.commit });
    expect(host.verify.mock.calls.length).toBe(checks); expect(f.state.check).toBeUndefined();
  }, 30_000);

  it('rejects missing, altered or foreign segments without treating the archive as empty', async () => {
    const f = fixture(), fresh = await checkDeclarationArtifacts(f.options);
    const { output, file } = archiveFixture(f, Array.from({ length: 4096 }, (_, index) => historicalArtifact(fresh[0]!, index)));
    writeDeclarationArtifacts(output, f.state, fresh);
    const root = JSON.parse(fs.readFileSync(file, 'utf8')), rootText = fs.readFileSync(file);
    const segmentFile = path.join(output, 'declarations.d', `${root.head}.json`), segmentText = fs.readFileSync(segmentFile);
    fs.renameSync(segmentFile, `${segmentFile}.held`);
    expect(() => readDeclarationArtifacts(output, f.state)).toThrow();
    fs.renameSync(`${segmentFile}.held`, segmentFile);
    fs.chmodSync(segmentFile, 0o600); fs.appendFileSync(segmentFile, ' ');
    expect(() => readDeclarationArtifacts(output, f.state)).toThrow('segment_changed');
    fs.writeFileSync(segmentFile, segmentText); fs.chmodSync(segmentFile, 0o400);
    for (const changed of [{ ...root, count: root.count + 1 }, { ...root, head: '../escape' }, { ...root, runId: 'another-run' }]) {
      fs.writeFileSync(file, canonicalMathJson(changed));
      expect(() => readDeclarationArtifacts(output, f.state)).toThrow('manifest_identity_changed');
    }
    const foreign = { ...JSON.parse(segmentText.toString()), runId: 'another-run' };
    const foreignText = canonicalMathJson(foreign), head = mathDigest(foreignText);
    fs.writeFileSync(path.join(output, 'declarations.d', `${head}.json`), foreignText);
    fs.writeFileSync(file, canonicalMathJson({ ...root, head }));
    expect(() => readDeclarationArtifacts(output, f.state)).toThrow('manifest_identity_changed');
    const duplicate = { ...JSON.parse(segmentText.toString()), artifacts: [fresh[0], fresh[0]] };
    const duplicateText = canonicalMathJson(duplicate), duplicateHead = mathDigest(duplicateText);
    fs.writeFileSync(path.join(output, 'declarations.d', `${duplicateHead}.json`), duplicateText);
    fs.writeFileSync(file, canonicalMathJson({ ...root, head: duplicateHead, count: 4098 }));
    expect(() => readDeclarationArtifacts(output, f.state)).toThrow('manifest_identity_changed');
    expect(() => writeDeclarationArtifacts(output, f.state, fresh)).toThrow('manifest_identity_changed');
    fs.writeFileSync(file, rootText);
    expect(readDeclarationArtifacts(output, f.state)).toHaveLength(4097);
  });

  it('retains the explicit size guard for already oversized legacy manifests', async () => {
    const f = fixture(), fresh = await checkDeclarationArtifacts(f.options);
    const { output, file } = archiveFixture(f, fresh), descriptor = fs.openSync(file, 'r+');
    try { fs.ftruncateSync(descriptor, 32 * 1024 * 1024 + 1); } finally { fs.closeSync(descriptor); }
    expect(() => readDeclarationArtifacts(output, f.state)).toThrow('manifest_too_large');
    expect(() => writeDeclarationArtifacts(output, f.state, fresh)).toThrow('manifest_too_large');
    expect(fs.statSync(file).size).toBe(32 * 1024 * 1024 + 1);
    expect(fs.existsSync(path.join(output, 'declarations.d'))).toBe(false);
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

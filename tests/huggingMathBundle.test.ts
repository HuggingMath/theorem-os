import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportHuggingMathRun, readHuggingMathBundle } from '../src/math/huggingMathBundle';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { canonicalLibraryJson } from '../src/math/libraryRelease';
import { writeSolverRunState } from '../src/solver/archive';
import type { DeclarationArtifact } from '../src/solver/declarationArtifacts';
import { temporaryDirectory } from './helpers/files';
import { createHuggingMathRunFixture } from './fixtures/huggingMathRun';

const directories: string[] = [];
function fixture() { const directory = temporaryDirectory('huggingmath-bundle-'); directories.push(directory); return createHuggingMathRunFixture(directory); }
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function artifact(f: ReturnType<typeof fixture>): DeclarationArtifact {
  const declaration = { file: 'Submission.lean', name: 'Fixture.helper', type: '∀ n : Nat, n = n',
    premises: ['n is arbitrary; this full premise is historical.'], description: 'A synthetic independent historical helper.' };
  const declarationHash = mathDigest('synthetic-helper-header'), declarationDigest = mathDigest(canonicalMathJson({
    file: declaration.file, name: declaration.name, type: declaration.type, declarationHash }));
  const checkedCommit = 'b'.repeat(40), body = { schema: 'theorem-os.declaration-artifact.v1' as const, runId: f.state.runId,
    problemReceiptDigest: f.state.problem.receiptDigest, environmentDigest: f.state.environmentDigest,
    declaration, declarationHash, declarationDigest,
    proof: { ...f.state.check!, verification: { ...f.state.check!.verification, targetCommit: checkedCommit,
      results: [{ ...f.state.check!.verification.results[0]!, targetCommit: checkedCommit, theoremName: declaration.name,
        statementHash: declarationDigest, leanStatementHash: declarationDigest, sourceDeclarationHash: declarationHash }] } },
    references: { sourceCommit: f.state.check!.commit, environmentDigest: f.state.environmentDigest, contextDigest: mathDigest('synthetic-context'),
      root: { file: declaration.file, name: declaration.name }, inputs: [], statement: [], proof: [] } };
  return { ...body, id: mathDigest(canonicalMathJson(body)) };
}

describe('optional HuggingMath frozen run export', () => {
  it('retains all original targets, exact CRLF source bytes, frozen support, configuration, and separate external evidence', () => {
    const f = fixture(), result = exportHuggingMathRun(f.options), manifest = result.manifest;
    expect(manifest.formalizations).toHaveLength(1); expect(manifest.proofs).toHaveLength(1);
    expect(manifest.formalizations[0]!.targets).toEqual(['Fixture.alpha', 'Fixture.beta']);
    expect(fs.readFileSync(path.join(result.directory, manifest.formalizations[0]!.entry), 'utf8')).toBe(f.source);
    expect(fs.readFileSync(path.join(result.directory, manifest.proofs[0]!.entry), 'utf8')).toBe(f.proof);
    expect(manifest.files.find(file => file.path === manifest.proofs[0]!.entry)!.sha256).toBe(mathDigest(f.proof));
    expect(manifest.external_verification[0]!.binds).toEqual({ proof_sha256: mathDigest(f.proof), targets: ['Fixture.alpha', 'Fixture.beta'] });
    expect(fs.readFileSync(path.join(result.directory, 'support/proof/Submission/Library/Helpers.lean'), 'utf8')).toBe(f.helperSource);
    expect(manifest.environment).toEqual({ complete: false,
      files: ['environment/lean-toolchain', 'environment/lakefile.toml', 'environment/lake-manifest.json'] });
    expect(manifest.rights).toHaveLength(manifest.files.length); expect(manifest.rights.every(right => right.status === 'unknown')).toBe(true);
    const provenance = JSON.parse(fs.readFileSync(path.join(result.directory, 'provenance/run.json'), 'utf8'));
    expect(provenance.sourceCommit).toBe(f.state.check!.commit); expect(provenance.sourceDigest).toBe(f.state.check!.sourceDigest);
    expect(provenance.hubVerificationState).toBe('not_run'); expect(result.warnings.some(warning => warning.includes('not_run'))).toBe(true);
    expect(readHuggingMathBundle(result.directory).bundleDigest).toBe(result.bundleDigest);
    expect(readHuggingMathBundle(result.zipFile).manifest).toEqual(manifest);
    expect(readHuggingMathBundle(result.directory).zip).toEqual(fs.readFileSync(result.zipFile));
    expect(fs.existsSync(path.join(result.directory, 'bundle.zip'))).toBe(false);
    expect(() => exportHuggingMathRun(f.options)).toThrow();
  });

  it('reads committed proof sources even when the mutable working file has later changes', () => {
    const f = fixture(); fs.writeFileSync(path.join(f.receipt.projectRoot, 'Submission.lean'), 'mutable work in progress');
    const result = exportHuggingMathRun(f.options);
    expect(fs.readFileSync(path.join(result.directory, result.manifest.proofs[0]!.entry), 'utf8')).toBe(f.proof);
    expect(fs.readFileSync(path.join(f.receipt.projectRoot, 'Submission.lean'), 'utf8')).toBe('mutable work in progress');
  });

  it.each(['runId', 'problemId', 'stateFile', 'solution_commit', 'status', 'completion_signal_valid', 'solver_ready_receipt_valid'] as const)
  ('rejects a mismatched result %s before writing output', key => {
    const f = fixture(), result = { ...f.result, [key]: typeof f.result[key] === 'boolean' ? false : 'wrong' };
    fs.writeFileSync(f.resultFile, JSON.stringify(result));
    expect(() => exportHuggingMathRun(f.options)).toThrow(/result_identity_or_acceptance/);
    expect(fs.existsSync(f.options.outputDirectory)).toBe(false);
  });

  it.each(['source', 'targets', 's3', 'trusted', 'writer'] as const)('rejects invalid %s acceptance evidence', kind => {
    const f = fixture();
    if (kind === 'source') f.state.check = { ...f.state.check!, sourceDigest: '0'.repeat(64) };
    if (kind === 'targets') f.state.check = { ...f.state.check!, verification: { ...f.state.check!.verification, results: f.state.check!.verification.results.slice(0, 1) } };
    if (kind === 'trusted') f.state.problem = { ...f.state.problem, trustedFiles: { ...f.state.problem.trustedFiles, 'lean-toolchain': '0'.repeat(64) } };
    if (kind === 'writer') f.state.writerStopUnconfirmed = { at: 1, reason: 'synthetic writer not stopped' };
    if (kind === 's3') { f.result.evaluator.status = 'failed'; fs.writeFileSync(f.resultFile, JSON.stringify(f.result)); }
    writeSolverRunState(f.stateFile, f.state);
    expect(() => exportHuggingMathRun(f.options)).toThrow(); expect(fs.existsSync(f.options.outputDirectory)).toBe(false);
  });

  it.each(['v1', 'v2'] as const)('preserves a selected %s historical helper as full provenance, with source and checked commits distinct', version => {
    const f = fixture(), helper = artifact(f), identity = { runId: f.state.runId, problemReceiptDigest: f.state.problem.receiptDigest, environmentDigest: f.state.environmentDigest };
    if (version === 'v1') fs.writeFileSync(path.join(path.dirname(f.stateFile), 'declarations.json'), canonicalMathJson({
      schema: 'theorem-os.declaration-artifacts.v1', ...identity, artifacts: [helper] }));
    else {
      const segment = canonicalMathJson({ schema: 'theorem-os.declaration-artifacts.segment.v1', ...identity, previous: null, artifacts: [helper] }), head = mathDigest(segment);
      fs.mkdirSync(path.join(path.dirname(f.stateFile), 'declarations.d'));
      fs.writeFileSync(path.join(path.dirname(f.stateFile), 'declarations.d', `${head}.json`), segment);
      fs.writeFileSync(path.join(path.dirname(f.stateFile), 'declarations.json'), canonicalMathJson({
        schema: 'theorem-os.declaration-artifacts.v2', ...identity, head, count: 1 }));
    }
    const exported = exportHuggingMathRun({ ...f.options, declarationIds: [helper.id] });
    const copied = JSON.parse(fs.readFileSync(path.join(exported.directory, `provenance/declarations/${helper.id}.json`), 'utf8'));
    expect(copied).toEqual(helper); expect(copied.proof.commit).not.toBe(copied.proof.verification.targetCommit);
    expect(exported.manifest.proofs).toHaveLength(1);
    expect(exported.manifest.external_verification[0]!.binds.targets).not.toContain(helper.declaration.name);
  });

  it('does not consult an unrelated damaged artifact archive unless a helper is explicitly selected', () => {
    const f = fixture(); fs.writeFileSync(path.join(path.dirname(f.stateFile), 'declarations.json'), '{ damaged');
    expect(() => exportHuggingMathRun({ ...f.options, declarationIds: ['a'.repeat(64)] })).toThrow();
    expect(fs.existsSync(f.options.outputDirectory)).toBe(false);
    expect(exportHuggingMathRun(f.options).manifest.proofs).toHaveLength(1);
  });

  it('applies only explicit per-file rights and never infers permission from attribution', () => {
    const f = fixture(); fs.writeFileSync(f.metadataFile, JSON.stringify({ attribution: 'Fixture author',
      rights: { 'statement/original.md': { status: 'declared', license: 'Fixture-Permission', notice: 'Synthetic only.' } } }));
    const result = exportHuggingMathRun(f.options);
    expect(result.manifest.rights.find(right => right.files.includes('statement/original.md'))!.status).toBe('declared');
    expect(result.manifest.rights.find(right => right.files.includes('proofs/Submission.lean'))!.status).toBe('unknown');
  });

  it.each(['{"attribution":"first","attribution":"second"}', '{"attribution":"x","extra":1.0}',
    '{"attribution":"\\ud800"}', '{"attribution":"x","extra":9007199254740993}',
    '{"attribution":"x","rights":{"absent.txt":{"status":"declared","license":"X","notice":""}}}'])
  ('rejects unsafe or unsupported export metadata: %s', metadata => {
    const f = fixture(); fs.writeFileSync(f.metadataFile, metadata);
    expect(() => exportHuggingMathRun(f.options)).toThrow(); expect(fs.existsSync(f.options.outputDirectory)).toBe(false);
  });

  it('checks the application projection limit before writing even when the bundle file limit would permit the source', () => {
    const f = fixture(), source = f.proof + `/- ${'x'.repeat(256 * 1024)} -/\n`;
    fs.writeFileSync(path.join(f.receipt.projectRoot, 'Submission.lean'), source);
    const commit = f.git(['add', '--all']); void commit;
    f.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--quiet', '-m', 'Synthetic long proof']);
    const head = f.git(['rev-parse', 'HEAD']), digest = mathDigest(canonicalMathJson(f.state.problem.ownedFiles.map(file =>
      [file, mathDigest(fs.readFileSync(path.join(f.receipt.projectRoot, file)))])));
    const check = { ...f.state.check!, commit: head, sourceDigest: digest, verification: { ...f.state.check!.verification, targetCommit: head,
      results: f.state.check!.verification.results.map(receipt => ({ ...receipt, targetCommit: head })) } };
    f.state.check = check; f.result.solution_commit = head; f.result.evaluator.verification = check;
    writeSolverRunState(f.stateFile, f.state); fs.writeFileSync(f.resultFile, JSON.stringify(f.result));
    expect(() => exportHuggingMathRun(f.options)).toThrow(/lean_projection_too_large/); expect(fs.existsSync(f.options.outputDirectory)).toBe(false);
  });
});

describe('bundle integrity on import', () => {
  it('detects changed raw bytes, omitted files, unlisted files, and symlinked attachments', () => {
    const f = fixture(), result = exportHuggingMathRun(f.options), proof = path.join(result.directory, 'proofs/Submission.lean');
    fs.writeFileSync(proof, f.proof.replaceAll('\r\n', '\n')); expect(() => readHuggingMathBundle(result.directory)).toThrow(/file_changed/);
    fs.unlinkSync(proof); expect(() => readHuggingMathBundle(result.directory)).toThrow(/file_changed/);
    fs.writeFileSync(proof, f.proof); fs.writeFileSync(path.join(result.directory, 'unlisted.txt'), 'extra');
    expect(() => readHuggingMathBundle(result.directory)).toThrow(/unlisted_files/);
    fs.unlinkSync(path.join(result.directory, 'unlisted.txt')); fs.unlinkSync(proof); fs.symlinkSync(f.resultFile, proof);
    expect(() => readHuggingMathBundle(result.directory)).toThrow();
  });

  it('rejects corrupt stored ZIP bytes and handles code-point sorted canonical manifest keys', () => {
    const f = fixture(), result = exportHuggingMathRun(f.options), zip = fs.readFileSync(result.zipFile);
    const proofOffset = zip.indexOf(Buffer.from(f.proof)); expect(proofOffset).toBeGreaterThan(0);
    zip[proofOffset] ^= 1; fs.writeFileSync(result.zipFile, zip);
    expect(() => readHuggingMathBundle(result.zipFile)).toThrow(/zip_crc_or_size_mismatch/);
    const manifest = { ...result.manifest, export: { ...result.manifest.export, '\uE000': 1, '😀': 2, '10': 10, '2': 2 } };
    fs.writeFileSync(path.join(result.directory, 'manifest.json'), JSON.stringify(manifest));
    expect(readHuggingMathBundle(result.directory).bundleDigest).toBe(mathDigest(canonicalLibraryJson(manifest)));
    expect(canonicalLibraryJson({ '\uE000': 1, '😀': 2 })).toBe('{"":1,"😀":2}');
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FIRST_PROOF_BATCH, FIRST_PROOF_GIT_BLOBS, FIRST_PROOF_PROBLEM_IDS, FIRST_PROOF_REPOSITORY_URL,
  FIRST_PROOF_SOURCE_COMMIT, bootstrapFirstProofProblem, firstProofFormalizationInputDigest,
  firstProofFormalizationTargets, readFirstProofCatalog, readFirstProofFormalization, readFirstProofProblem,
  type FirstProofFormalizationManifest } from '../src/math/firstProof';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { readLeanTaskReceipt } from '../src/math/leanTask';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { assertSolverProjectSources, readSolverProblem } from '../src/solver/problem';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/first-proof/batch3');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function temporaryDirectory() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'first-proof-adapter-fixture-')));
  roots.push(root);
  return root;
}

// Synthetic Lean and review records below test adapter mechanics only. They are never benchmark formalizations or results.
const fixtureSource = [
  'namespace FirstProofAdapterFixture',
  'def marker : Nat := 0',
  'theorem left (n : Nat) : n + 0 = n := by sorry',
  'lemma right (n : Nat) : 0 + n = n := by sorry',
  'end FirstProofAdapterFixture',
  '',
].join('\n');
function formalizationFixture() {
  const root = temporaryDirectory(), formalizationsRoot = path.join(root, 'formalizations');
  const problem = readFirstProofCatalog(sourceRoot).problems[0];
  const directory = path.join(formalizationsRoot, problem.id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'Statement.lean'), fixtureSource);
  const targets = firstProofFormalizationTargets(fixtureSource);
  const manifest: FirstProofFormalizationManifest = {
    schema: 'theorem-os.first-proof.formalization.v1', problemId: problem.id,
    problemSourceSha256: problem.sourceSha256, sourceSha256: mathDigest(fixtureSource),
    environment: 'standard', environmentDigest: getLeanTaskEnvironment('standard').dependencyDigest,
    targets, coverage: [{ originalText: problem.source.slice(0, 80), targetNames: targets.map(target => target.name),
      explanation: 'Synthetic adapter fixture only; this does not formalize the quoted First Proof problem.' }],
    assumptions: [], assumptionsExplanation: 'Synthetic fixture has no additional assumptions; not benchmark evidence.',
    definitionsExplanation: 'The marker definition belongs only to this synthetic fixture.', status: 'unreviewed',
  };
  const save = () => fs.writeFileSync(path.join(directory, 'formalization.json'), JSON.stringify(manifest, null, 2) + '\n');
  const recordFixtureReview = (authority: 'human' | 'model' = 'human', verdict: 'approved' | 'changes_requested' = 'approved') => {
    manifest.review = { authority, reviewer: 'synthetic-fixture-reviewer', reviewedAt: '2026-10-22T00:00:00Z', verdict,
      inputDigest: firstProofFormalizationInputDigest(manifest), summary: 'Synthetic test attestation, never an actual First Proof audit.' };
    manifest.reviewDigest = mathDigest(canonicalMathJson(manifest.review));
    manifest.status = verdict;
    save();
  };
  save();
  return { root, formalizationsRoot, problem, directory, manifest, save, recordFixtureReview,
    prepare: () => bootstrapFirstProofProblem({ sourceRoot, formalizationsRoot, problemId: problem.id, workspaceRoot: path.join(root, 'workspace') }) };
}

describe('First Proof batch 3 source identity', () => {
  it('reads exactly ten pinned official problem blobs without solution inputs', () => {
    const catalog = readFirstProofCatalog(sourceRoot);
    expect(catalog).toMatchObject({ schema: 'theorem-os.first-proof.catalog.v1', batch: FIRST_PROOF_BATCH,
      repositoryUrl: FIRST_PROOF_REPOSITORY_URL, sourceCommit: FIRST_PROOF_SOURCE_COMMIT });
    expect(catalog.problems.map(problem => problem.id)).toEqual(FIRST_PROOF_PROBLEM_IDS);
    expect(catalog.problems.map(problem => problem.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(catalog.problems.map(problem => problem.gitBlobOid)).toEqual(FIRST_PROOF_GIT_BLOBS);
    expect(catalog.problems.every(problem => problem.sourceRelativePath.endsWith('/problem.tex') &&
      problem.sourceSha256 === mathDigest(Buffer.from(problem.source, 'utf8')) &&
      problem.sourceUrl.includes(FIRST_PROOF_SOURCE_COMMIT))).toBe(true);
    expect(readFirstProofCatalog(sourceRoot).digest).toBe(catalog.digest);
    expect(readFirstProofProblem(sourceRoot, FIRST_PROOF_PROBLEM_IDS[9])).toEqual(catalog.problems[9]);
  });

  it('rejects changed original bytes, missing problems and symlinked sources', () => {
    const root = temporaryDirectory(), catalog = readFirstProofCatalog(sourceRoot);
    for (const problem of catalog.problems) {
      const file = path.join(root, problem.sourceRelativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, problem.source);
    }
    fs.writeFileSync(path.join(root, 'ignored-solution-fixture.txt'), 'Not a solution; must never be part of a catalog.');
    expect(readFirstProofCatalog(root).digest).toBe(catalog.digest);
    const first = path.join(root, catalog.problems[0].sourceRelativePath);
    fs.appendFileSync(first, '\n');
    expect(() => readFirstProofCatalog(root)).toThrow('first_proof_blob_identity_mismatch:first_proof_batch3_01');
    fs.unlinkSync(first);
    expect(() => readFirstProofCatalog(root)).toThrow();
    fs.symlinkSync(path.join(sourceRoot, catalog.problems[0].sourceRelativePath), first);
    expect(() => readFirstProofCatalog(root)).toThrow('math_path_invalid');
  });

  it.each(['../first_proof_batch3_01', 'first_proof_batch3_00', 'first_proof_batch3_11', 'first_proof_batch3_01\n'])('rejects invalid problem ID %j', id => {
    expect(() => readFirstProofProblem(sourceRoot, id)).toThrow('first_proof_problem_id_invalid');
  });
});

describe('First Proof formalization review gate', () => {
  it('keeps all ten absent formalizations missing and refuses to create a solver workspace', () => {
    const root = temporaryDirectory(), catalog = readFirstProofCatalog(sourceRoot);
    expect(catalog.problems.map(problem => readFirstProofFormalization(path.join(root, 'formalizations'), problem).status))
      .toEqual(Array(10).fill('missing'));
    expect(() => bootstrapFirstProofProblem({ sourceRoot, formalizationsRoot: path.join(root, 'formalizations'),
      problemId: catalog.problems[0].id, workspaceRoot: path.join(root, 'workspace') })).toThrow('first_proof_formalization_missing');
    expect(fs.existsSync(path.join(root, 'workspace'))).toBe(false);
  });

  it('does not approve source presence, model advisory approval or a requested revision', () => {
    const fixture = formalizationFixture();
    expect(readFirstProofFormalization(fixture.formalizationsRoot, fixture.problem).status).toBe('unreviewed');
    expect(() => fixture.prepare()).toThrow('first_proof_formalization_not_approved');
    fixture.recordFixtureReview('model'); fixture.manifest.status = 'unreviewed'; fixture.save();
    expect(readFirstProofFormalization(fixture.formalizationsRoot, fixture.problem).status).toBe('unreviewed');
    expect(() => fixture.prepare()).toThrow('first_proof_formalization_not_approved');
    fixture.manifest.status = 'approved'; fixture.save();
    expect(() => fixture.prepare()).toThrow('first_proof_formalization_human_review_required');
    fixture.recordFixtureReview('human', 'changes_requested');
    expect(() => fixture.prepare()).toThrow('first_proof_formalization_not_approved');
    expect(fs.existsSync(path.join(fixture.root, 'workspace'))).toBe(false);
  });

  it('requires an actual human approval record with a matching review digest', () => {
    const fixture = formalizationFixture();
    fixture.manifest.status = 'approved'; fixture.save();
    expect(() => fixture.prepare()).toThrow('first_proof_formalization_human_review_required');
    fixture.recordFixtureReview(); fixture.manifest.review!.summary += ' changed'; fixture.save();
    expect(() => fixture.prepare()).toThrow('first_proof_formalization_review_digest_mismatch');
    fixture.recordFixtureReview(); delete fixture.manifest.review; fixture.save();
    expect(() => fixture.prepare()).toThrow('first_proof_formalization_review_digest_mismatch');
  });

  it('invalidates approval after source bytes change, including an otherwise harmless comment', () => {
    const fixture = formalizationFixture(); fixture.recordFixtureReview();
    const changed = fixtureSource + '-- fixture edit\n';
    fs.writeFileSync(path.join(fixture.directory, 'Statement.lean'), changed);
    expect(() => fixture.prepare()).toThrow('first_proof_formalization_source_mismatch');
    fixture.manifest.sourceSha256 = mathDigest(changed); fixture.save();
    expect(() => fixture.prepare()).toThrow('first_proof_formalization_review_input_mismatch');
    expect(fs.existsSync(path.join(fixture.root, 'workspace'))).toBe(false);
  });

  it.each(['assumptionsExplanation', 'definitionsExplanation'] as const)('binds the complete review input, including %s', field => {
    const fixture = formalizationFixture(); fixture.recordFixtureReview();
    fixture.manifest[field] += ' Changed after review.'; fixture.save();
    expect(() => fixture.prepare()).toThrow('first_proof_formalization_review_input_mismatch');
  });

  it('binds both the selected environment and its exact dependencies', () => {
    const fixture = formalizationFixture(); fixture.recordFixtureReview();
    fixture.manifest.environmentDigest = '0'.repeat(64); fixture.save();
    expect(() => fixture.prepare()).toThrow('first_proof_formalization_environment_mismatch');
    fixture.manifest.environment = 'mathlib';
    fixture.manifest.environmentDigest = getLeanTaskEnvironment('mathlib').dependencyDigest; fixture.save();
    expect(() => fixture.prepare()).toThrow('first_proof_formalization_review_input_mismatch');
  });

  it('rejects exchanging problem numbers, edited original hashes or forged problem objects', () => {
    const fixture = formalizationFixture(); fixture.recordFixtureReview();
    fixture.manifest.problemId = FIRST_PROOF_PROBLEM_IDS[1]; fixture.save();
    expect(() => fixture.prepare()).toThrow('first_proof_formalization_problem_mismatch');
    fixture.manifest.problemId = fixture.problem.id; fixture.manifest.problemSourceSha256 = '0'.repeat(64); fixture.save();
    expect(() => fixture.prepare()).toThrow('first_proof_formalization_problem_mismatch');
    expect(() => readFirstProofFormalization(fixture.formalizationsRoot, { ...fixture.problem, source: 'synthetic replacement' }))
      .toThrow('first_proof_problem_identity_mismatch');
  });

  it('binds every original target and declaration type, with coverage anchored in the real source', () => {
    const fixture = formalizationFixture();
    fixture.manifest.targets[0].declarationHash = '0'.repeat(64); fixture.save();
    expect(() => fixture.prepare()).toThrow('first_proof_formalization_targets_mismatch');
    fixture.manifest.targets = firstProofFormalizationTargets(fixtureSource);
    fixture.manifest.coverage[0].targetNames = [fixture.manifest.targets[0].name]; fixture.save();
    expect(() => fixture.prepare()).toThrow('first_proof_formalization_coverage_invalid');
    fixture.manifest.coverage[0].targetNames = fixture.manifest.targets.map(target => target.name);
    fixture.manifest.coverage[0].originalText = 'Synthetic invented original clause that is not in the official problem.'; fixture.save();
    expect(() => fixture.prepare()).toThrow('first_proof_formalization_coverage_invalid');
  });

  it('rejects symlinks and malformed or caller-extended manifests', () => {
    const fixture = formalizationFixture();
    const file = path.join(fixture.directory, 'formalization.json');
    fs.writeFileSync(file, JSON.stringify({ ...fixture.manifest, callerApproval: true }));
    expect(() => fixture.prepare()).toThrow('first_proof_formalization_manifest_invalid');
    fs.writeFileSync(file, '{');
    expect(() => fixture.prepare()).toThrow('first_proof_formalization_manifest_invalid');
    fs.unlinkSync(file);
    const actual = path.join(fixture.root, 'actual-manifest.json');
    fs.writeFileSync(actual, JSON.stringify(fixture.manifest)); fs.symlinkSync(actual, file);
    expect(() => fixture.prepare()).toThrow('math_path_invalid');
  });

  it('bootstraps a synthetic approved fixture through the ordinary frozen Lean-task contract', () => {
    const fixture = formalizationFixture(); fixture.recordFixtureReview();
    const checked = readFirstProofFormalization(fixture.formalizationsRoot, fixture.problem);
    expect(checked.status).toBe('approved');
    if (checked.status === 'missing') throw new Error('fixture_missing');
    expect(checked.digest).toBe(mathDigest(fs.readFileSync(path.join(fixture.directory, 'formalization.json'))));
    const receipt = fixture.prepare();
    expect(receipt.kind).toBe('lean-task');
    expect(readLeanTaskReceipt(receipt.activeProblemPath)).toEqual(receipt);
    expect(receipt.contract.formalStatement).toBe(fixtureSource);
    expect(receipt.contract.informalStatement).toContain(fixture.problem.sourceSha256);
    expect(receipt.contract.informalStatement).toContain(checked.inputDigest);
    expect(receipt.contract.informalStatement).toContain(fixture.manifest.reviewDigest);
    expect(receipt.contract.informalStatement).toContain('not First Proof official acceptance');
    const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
    expect(problem.targets.map(target => target.theoremName)).toEqual(fixture.manifest.targets.map(target => target.name));
    expect(() => assertSolverProjectSources(problem, receipt.projectRoot)).not.toThrow();
    fs.writeFileSync(path.join(receipt.projectRoot, 'Submission.lean'), fixtureSource.replace('marker : Nat := 0', 'marker : Nat := 1'));
    expect(() => assertSolverProjectSources(problem, receipt.projectRoot)).toThrow('math_original_declaration_changed');
  });
});

describe('First Proof Lean seed admission', () => {
  it('permits unfinished theorem proof bodies and ignores forbidden words in comments and strings', () => {
    const source = '/- sorry /- unsafe axiom -/ -/\ndef label : String := "sorry unsafe axiom ? #eval"\n' + fixtureSource;
    expect(firstProofFormalizationTargets(source)).toEqual(firstProofFormalizationTargets(fixtureSource));
  });

  it.each([
    ['axiom borrowed : False\n' + fixtureSource, 'unsupported_declaration'],
    ['unsafe def untrusted : Nat := 0\n' + fixtureSource, 'unsupported_declaration'],
    ['constant hidden : Nat\n' + fixtureSource, 'unsupported_declaration'],
    ['#eval IO.println "not executed"\n' + fixtureSource, 'unsupported_declaration'],
    ['set_option debug.skipKernelTC true\n' + fixtureSource, 'unsupported_declaration'],
    ['opaque hidden : Nat\n' + fixtureSource, 'unsupported_declaration'],
    [fixtureSource.replace('n + 0 = n', 'Lean.sorryAx'), 'unsupported_declaration'],
    ['def answer : Nat := by sorry\n' + fixtureSource, 'placeholder_outside_proof'],
    ['def answer : Nat := _\n' + fixtureSource, 'placeholder_outside_proof'],
    [fixtureSource.replace('(n : Nat)', '(n : _)'), 'placeholder_outside_proof'],
    [fixtureSource.replace('n + 0 = n', 'n = (by sorry : Nat)'), 'placeholder_outside_proof'],
    [fixtureSource.replace(':= by sorry', ':= sorry'), 'placeholder_outside_proof'],
    ['def marker : Nat := 0\n', 'targets_missing'],
  ])('rejects invalid statement/definition inputs without kernel or model calls: %s', (source, reason) => {
    expect(() => firstProofFormalizationTargets(source)).toThrow(`first_proof_formalization_${reason}`);
  });
});

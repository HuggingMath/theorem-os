import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { firstProof, firstProofInventory, summarizeFirstProof, type FirstProofCase } from '../scripts/mathematics/firstProof';
import { firstProofFormalizationInputDigest, readFirstProofCatalog, type FirstProofFormalizationManifest } from '../src/math/firstProof';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { readSolverProblem } from '../src/solver/problem';
import { writeSolverRunState, type SolverRunState } from '../src/solver/archive';
import type { ProofCheck } from '../src/solver/modules/evidence';

// These tests exercise local adapter/report mechanics. Every theorem, approval and run below is synthetic,
// exists only in a disposable directory, and is never a benchmark formalization, model run or Lean result.
vi.mock('../src/math/mathBuildManifest', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/mathBuildManifest')>(),
  readMathBuildManifest: (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')),
}));
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/first-proof/batch3');
const catalog = readFirstProofCatalog(sourceRoot);
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function temporaryDirectory() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'first-proof-cli-synthetic-')));
  roots.push(directory); return directory;
}
async function invoke(args: string[]) {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const code = await firstProof(args);
    return { code, report: JSON.parse(String(output.mock.calls.at(-1)?.[0])) };
  } finally { output.mockRestore(); }
}
function draftInputs(index = 0) {
  const directory = temporaryDirectory(), formalizations = path.join(directory, 'formalizations');
  const problem = catalog.problems[index];
  const statement = path.join(directory, 'synthetic-statement.lean'), notes = path.join(directory, 'synthetic-notes.json');
  fs.writeFileSync(statement, 'namespace SyntheticCliFixture\n'
    + 'theorem left (n : Nat) : n + 0 = n := by sorry\n'
    + 'theorem right (n : Nat) : 0 + n = n := by sorry\nend SyntheticCliFixture\n');
  fs.writeFileSync(notes, JSON.stringify({ coverage: [{ originalText: problem.source.slice(0, 80),
    targetNames: ['SyntheticCliFixture.left', 'SyntheticCliFixture.right'],
    explanation: 'Synthetic CLI fixture only; this does not formalize the official statement.' }],
    assumptions: [], assumptionsExplanation: 'No assumptions in this synthetic test.',
    definitionsExplanation: 'No custom definitions in this synthetic test.' }));
  const args = ['--phase', 'draft', '--source-root', sourceRoot, '--formalizations-root', formalizations,
    '--problem', problem.id, '--statement-file', statement, '--notes-file', notes, '--environment', 'standard'];
  return { directory, formalizations, problem, statement, notes, args };
}
async function preparedFixture(index = 0) {
  const fixture = draftInputs(index);
  await invoke(fixture.args);
  const file = path.join(fixture.formalizations, fixture.problem.id, 'formalization.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as FirstProofFormalizationManifest;
  manifest.status = 'approved';
  manifest.review = { authority: 'human', reviewer: 'synthetic-test-attestation', reviewedAt: '2026-10-22T00:00:00Z',
    verdict: 'approved', inputDigest: firstProofFormalizationInputDigest(manifest),
    summary: 'Synthetic attestation only, not an actual review or benchmark result.' };
  manifest.reviewDigest = mathDigest(canonicalMathJson(manifest.review));
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  const buildManifest = path.join(fixture.directory, 'fixture-build.json');
  // Noncanonical formatting catches mismatches against native run.ts, which hashes the original build bytes.
  fs.writeFileSync(buildManifest, '{\n  "syntheticBuild": true\n}\n');
  const campaign = path.join(fixture.directory, 'campaign');
  const prepared = await invoke(['--phase', 'prepare', '--source-root', sourceRoot, '--formalizations-root', fixture.formalizations,
    '--problem', fixture.problem.id, '--directory', campaign, '--build-manifest', buildManifest]);
  const caseFile = prepared.report.caseFile as string;
  const plan = JSON.parse(fs.readFileSync(caseFile, 'utf8')) as FirstProofCase;
  return { ...fixture, campaign, buildManifest, caseFile, plan, caseDirectory: path.dirname(caseFile) };
}
function recordedFixture(fixture: Awaited<ReturnType<typeof preparedFixture>>, turns = 1) {
  const { plan } = fixture;
  const problem = readSolverProblem(plan.workspaceRoot, plan.receiptFile);
  const check = { commit: plan.baseCommit, sourceDigest: 'd'.repeat(64), passed: true,
    verification: { schema: 'deepscientist.mathematics.verification-batch/v1', targetCommit: plan.baseCommit,
      sessionId: 'synthetic-session', status: 'kernel_verified',
      results: problem.targets.map((target, index) => ({ receiptId: `synthetic-${index}`, checkId: `check-${index + 1}`,
        sessionId: 'synthetic-session', targetCommit: plan.baseCommit, status: 'kernel_verified',
        proofPath: target.proofPath, theoremName: target.theoremName, sourceDeclarationHash: target.declarationHash,
        statementHash: problem.contract.statementHash, leanStatementHash: problem.contract.leanStatementHash, claim: 'statement' })) } } as ProofCheck;
  const state: SolverRunState = { schema: 'deepscientist.math.solver.v1', runId: 'synthetic-report-fixture', problem,
    taskDigest: plan.taskDigest, buildDigest: plan.buildDigest, environmentDigest: 'e'.repeat(64), evaluatorDigest: mathDigest('host-default'),
    model: 'synthetic-no-model', effort: 'max', phase: 'finished', turns,
    worktree: path.join(fixture.caseDirectory, 'synthetic-worktree'), check };
  const stateFile = `${plan.resultFile}.runtime/state.json`;
  fs.mkdirSync(path.dirname(stateFile));
  const result = { schema: 'deepscientist.math.run.v2', runId: state.runId, stateFile, status: 'evaluated_passed',
    problemId: problem.contract.problemId, solution_commit: check.commit, completion_signal_valid: true, solver_ready_receipt_valid: true,
    evaluator: { status: 'passed', method: 'host-lean-kernel-all-targets', official: false, verification: check } };
  const save = () => { writeSolverRunState(stateFile, state); fs.writeFileSync(plan.resultFile, JSON.stringify(result)); };
  save(); return { state, result, stateFile, save };
}

describe('First Proof offline CLI and full inventory', () => {
  it('retains all ten missing formalizations, reports zero attempts without a success percentage, and blocks check', async () => {
    const directory = temporaryDirectory(), formalizations = path.join(directory, 'absent');
    const inventory = firstProofInventory(catalog, formalizations);
    expect(inventory.totalProblems).toBe(10); expect(inventory.approvedFormalizations).toBe(0);
    expect(inventory.problems.map(item => item.status)).toEqual(Array(10).fill('missing'));
    expect((await invoke(['--phase', 'check', '--formalizations-root', formalizations])).code).toBe(2);
    const summary = summarizeFirstProof(path.join(directory, 'campaign'), catalog, formalizations);
    expect(summary).toMatchObject({ totalProblems: 10, attemptedRuns: 0, solvedProblems: 0,
      attemptSuccessRate: null, fullBatchSuccessRate: null, invokesModel: false, official: false });
    expect(summary.problems).toHaveLength(10);
  });

  it('never creates a case or workspace when formalization is missing', async () => {
    const directory = temporaryDirectory(), campaign = path.join(directory, 'campaign');
    await expect(invoke(['--phase', 'prepare', '--formalizations-root', path.join(directory, 'absent'),
      '--problem', catalog.problems[0].id, '--directory', campaign, '--build-manifest', 'not-a-build']))
      .rejects.toThrow('first_proof_formalization_missing');
    expect(fs.existsSync(campaign)).toBe(false);
  });

  it('creates only unreviewed drafts and refuses to overwrite them or prepare a run', async () => {
    const fixture = draftInputs();
    const draft = await invoke(fixture.args);
    expect(draft.report).toMatchObject({ status: 'unreviewed', semanticApproval: false, invokesModel: false });
    const manifest = JSON.parse(fs.readFileSync(path.join(draft.report.directory, 'formalization.json'), 'utf8'));
    expect(manifest.review).toBeUndefined(); expect(manifest.reviewDigest).toBeUndefined();
    expect(draft.report.inputDigest).toBe(firstProofFormalizationInputDigest(manifest));
    await expect(invoke(fixture.args)).rejects.toThrow('already exists');
    await expect(invoke(['--phase', 'prepare', '--formalizations-root', fixture.formalizations, '--problem', fixture.problem.id,
      '--directory', path.join(fixture.directory, 'campaign'), '--build-manifest', 'not-a-build']))
      .rejects.toThrow('first_proof_formalization_not_approved');
  });

  it('lists an invalid formalization without dropping any questions or counting it as approved', () => {
    const directory = temporaryDirectory(), formalizations = path.join(directory, 'formalizations');
    const first = path.join(formalizations, catalog.problems[0].id); fs.mkdirSync(first, { recursive: true });
    fs.writeFileSync(path.join(first, 'Statement.lean'), 'theorem malformed');
    fs.writeFileSync(path.join(first, 'formalization.json'), '{}');
    const inventory = firstProofInventory(catalog, formalizations);
    expect(inventory.problems).toHaveLength(10); expect(inventory.problems[0].status).toBe('invalid');
    expect(inventory.approvedFormalizations).toBe(0);
  });

  it('preserves long original TeX, snapshots its review, and keeps native receipt identity intact', async () => {
    const fixture = await preparedFixture(2);
    const task = fs.readFileSync(fixture.plan.taskFile, 'utf8');
    expect(fixture.problem.source.length).toBeGreaterThan(8_000);
    expect(task).toContain(fixture.problem.source);
    expect(fixture.plan.buildDigest).toBe(mathDigest(fs.readFileSync(fixture.buildManifest)));
    expect(readSolverProblem(fixture.plan.workspaceRoot, fixture.plan.receiptFile).kind).toBe('lean-task');
    // A later edit to live authoring material cannot rewrite an already frozen historical case.
    fs.appendFileSync(path.join(fixture.formalizations, fixture.problem.id, 'Statement.lean'), '-- later edit\n');
    const summary = summarizeFirstProof(fixture.campaign, catalog, fixture.formalizations);
    expect(summary.preparedCases).toBe(1); expect(summary.runs[0].status).toBe('not_started');
    expect(summary.invalidRecords).toBe(0); expect(summary.attemptedRuns).toBe(0);
  });

  it('writes reports exclusively and rejects inappropriate flags, escaping IDs and linked case directories', async () => {
    const directory = temporaryDirectory(), output = path.join(directory, 'inventory.json');
    await invoke(['--phase', 'catalog', '--output', output]);
    const previous = fs.readFileSync(output, 'utf8');
    await expect(invoke(['--phase', 'catalog', '--output', output])).rejects.toThrow();
    expect(fs.readFileSync(output, 'utf8')).toBe(previous);
    await expect(invoke(['--phase', 'catalog', '--environment', 'standard'])).rejects.toThrow('not valid');
    await expect(invoke(['--phase', 'check', '--problem', '../escape'])).rejects.toThrow();
    const fixture = await preparedFixture();
    const alias = path.join(path.dirname(fixture.caseDirectory), 'linked-case'); fs.symlinkSync(fixture.caseDirectory, alias);
    const summary = summarizeFirstProof(fixture.campaign, catalog, fixture.formalizations);
    expect(summary.invalidRecords).toBe(1); expect(summary.attemptSuccessRate).toBeNull();
  });
});

describe('First Proof stored S3 evidence reporting (synthetic evidence only)', () => {
  it('counts all-target evidence only inside an identified run and never reports a full batch rate for one problem', async () => {
    const fixture = await preparedFixture(); recordedFixture(fixture);
    const summary = summarizeFirstProof(fixture.campaign, catalog, fixture.formalizations);
    expect(summary).toMatchObject({ attemptedRuns: 1, acceptedRuns: 1, attemptedProblems: 1, solvedProblems: 1,
      attemptSuccessRate: 1, fullBatchSuccessRate: null, evidence: 'recorded-not-replayed' });
  });

  it.each(['task', 'build', 'problem', 'evaluator'] as const)('rejects a run whose %s identity differs from the case', async field => {
    const fixture = await preparedFixture(), run = recordedFixture(fixture);
    if (field === 'task') run.state.taskDigest = '0'.repeat(64);
    if (field === 'build') run.state.buildDigest = '0'.repeat(64);
    if (field === 'problem') run.state.problem = { ...run.state.problem, baseCommit: '0'.repeat(40) };
    if (field === 'evaluator') run.state.evaluatorDigest = mathDigest('external-command');
    run.save();
    const summary = summarizeFirstProof(fixture.campaign, catalog, fixture.formalizations);
    expect(summary.acceptedRuns).toBe(0); expect(summary.invalidRecords).toBe(1); expect(summary.attemptSuccessRate).toBeNull();
  });

  it('refuses model-completed status and partial S3 target evidence as proof acceptance', async () => {
    const fixture = await preparedFixture(), run = recordedFixture(fixture);
    run.result.evaluator.verification = { ...run.result.evaluator.verification,
      verification: { ...run.result.evaluator.verification.verification,
        results: run.result.evaluator.verification.verification.results.slice(0, 1) } };
    run.save();
    let summary = summarizeFirstProof(fixture.campaign, catalog, fixture.formalizations);
    expect(summary.acceptedRuns).toBe(0); expect(summary.runs[0].error).toBe('first_proof_acceptance_evidence_incomplete');
    expect(summary.attemptedRuns).toBe(1); expect(summary.attemptSuccessRate).toBeNull();
    run.result.status = 'completed'; run.save();
    summary = summarizeFirstProof(fixture.campaign, catalog, fixture.formalizations);
    expect(summary.acceptedRuns).toBe(0); expect(summary.runs[0].error).toBe('first_proof_result_status_invalid');
  });

  it('cannot turn zero solver turns into a benchmark success', async () => {
    const fixture = await preparedFixture(); recordedFixture(fixture, 0);
    const summary = summarizeFirstProof(fixture.campaign, catalog, fixture.formalizations);
    expect(summary.attemptedRuns).toBe(0); expect(summary.acceptedRuns).toBe(0);
    expect(summary.runs[0].error).toBe('first_proof_acceptance_without_attempt');
    expect(summary.attemptSuccessRate).toBeNull();
  });

  it('keeps a prepared startup separate from attempted solving and withholds a rate for unfinished or missing results', async () => {
    const fixture = await preparedFixture(), run = recordedFixture(fixture, 0);
    run.state.phase = 'prepared'; run.result.status = 'prepared'; run.save();
    let summary = summarizeFirstProof(fixture.campaign, catalog, fixture.formalizations);
    expect(summary.startedRuns).toBe(1); expect(summary.attemptedRuns).toBe(0); expect(summary.attemptSuccessRate).toBeNull();
    run.state.phase = 'running'; run.state.turns = 1; run.save();
    summary = summarizeFirstProof(fixture.campaign, catalog, fixture.formalizations);
    expect(summary.attemptedRuns).toBe(1); expect(summary.acceptedRuns).toBe(0); expect(summary.attemptSuccessRate).toBeNull();
    run.state.phase = 'finished'; writeSolverRunState(run.stateFile, run.state); fs.unlinkSync(fixture.plan.resultFile);
    summary = summarizeFirstProof(fixture.campaign, catalog, fixture.formalizations);
    expect(summary.runs[0].error).toBe('first_proof_result_missing'); expect(summary.attemptSuccessRate).toBeNull();
    expect(summary.attemptedRuns).toBe(1);
  });

  it.each(['task', 'review'] as const)('detects changed frozen %s instead of accepting attached results', async changed => {
    const fixture = await preparedFixture(); recordedFixture(fixture);
    if (changed === 'task') {
      fs.chmodSync(fixture.plan.taskFile, 0o600); fs.appendFileSync(fixture.plan.taskFile, 'Changed original task.\n');
    } else {
      const file = path.join(fixture.caseDirectory, 'formalization', fixture.problem.id, 'formalization.json');
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as FirstProofFormalizationManifest;
      manifest.review!.summary += ' Changed after case preparation.';
      fs.chmodSync(file, 0o600); fs.writeFileSync(file, JSON.stringify(manifest));
    }
    const summary = summarizeFirstProof(fixture.campaign, catalog, fixture.formalizations);
    expect(summary.acceptedRuns).toBe(0); expect(summary.runs[0].error).toBe(changed === 'task'
      ? 'first_proof_case_identity_mismatch' : 'first_proof_formalization_review_digest_mismatch');
  });
});

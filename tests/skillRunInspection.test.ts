import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { extractRunLibraryModules } from '../src/math/libraryPacks';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import type { MathematicsVerifierBatchRequest } from '../src/math/verifier';
import { writeSolverRunState } from '../src/solver/archive';
import { checkDeclarationArtifacts, writeDeclarationArtifacts } from '../src/solver/declarationArtifacts';
import { buildRunInspection, exportRunPlan, renderRunInspection } from '../src/solver/inspection';
import { inspectStoredRun } from '../src/solver/storedRunInspection';
import { commitSolverSources, git, readSolverProblem } from '../src/solver/problem';
import { temporaryDirectory } from './helpers/files';
import { solverState } from './helpers/solver';
import { receiptBatch } from './helpers/verifier';
import { freezeContinuationInput, type ContinuationManifest } from '../src/solver/continuationInput';
import { continuationSourcePolicyDigest } from '../src/solver/continuationSeed';

const host = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../src/math/verifier', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/verifier')>(), checkManyFormalVerifications: host.verify,
}));
const roots: string[] = [];
beforeEach(() => { host.verify.mockReset().mockImplementation(async (request: MathematicsVerifierBatchRequest) =>
  receiptBatch(request, { sessionId: 'skill-inspection', receiptId: () => `skill-${request.targetCommit}` })); });
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const directory = temporaryDirectory('skill-inspection-'); roots.push(directory);
  const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), {
    source: 'namespace View\ntheorem original : True := by sorry\nend View\n', task: 'Prove original.' });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  const file = path.join(receipt.projectRoot, 'Submission.lean');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('end View',
    'theorem helper (n : Nat) : n = n := by rfl\nend View'));
  const commit = commitSolverSources(problem, receipt.workspaceRoot);
  const state = solverState(problem, receipt.workspaceRoot, { runId: 'skill-inspection', phase: 'running',
    turns: 3, workerCount: 1, coordination: 'independent', environmentDigest: mathDigest('isolated environment'),
    researchMode: 'skill', researchSkill: { name: 'theoremos-research', digest: mathDigest('pinned skill'), loading: 'file' },
    lastActivity: { event: 'commandExecution', at: 1234 } });
  const run = path.join(directory, 'result.json'), runtime = `${run}.runtime`, stateFile = path.join(runtime, 'state.json');
  fs.mkdirSync(runtime, { mode: 0o700 }); writeSolverRunState(stateFile, state);
  fs.writeFileSync(run, JSON.stringify({ schema: 'deepscientist.math.run.v2', runId: state.runId, status: 'running', stateFile }));
  const artifacts = () => checkDeclarationArtifacts({ state, worktree: receipt.workspaceRoot, commit,
    declarations: [{ file: 'Submission.lean', name: 'View.helper', type: '∀ n : Nat, n = n', premises: [] }],
    env: { PATH: '/usr/bin:/bin', DEEPSCIENTIST_MATH_ENV_FILE: path.join(directory, 'absent.env') },
    signal: new AbortController().signal, assertWriterStopped: () => {} });
  return { directory, receipt, commit, state, run, runtime, stateFile, artifacts };
}

describe('skill research inspection', () => {
  it('projects the saved skill and one researcher without creating task, route or Lead progress', async () => {
    const f = fixture(), saved = fs.readFileSync(f.stateFile), report = await inspectStoredRun(f.run);
    expect(report.configuration).toMatchObject({ researchMode: 'skill', researchSkill: f.state.researchSkill, workers: 1 });
    expect(report.workers).toHaveLength(1); expect(report.workers[0]).toMatchObject({ id: 'solver', role: 'researcher', turns: 3 });
    expect(report.tasks).toEqual([]); expect(report.groups).toEqual([]);
    expect(report.mathematics.snapshot.obligations).toEqual([]); expect(report.mathematics.snapshot.routes).toEqual([]);
    expect(report.progress.checkedProofTasks).toBe(0);
    const markdown = renderRunInspection(report);
    expect(markdown).toContain('One Codex researcher'); expect(markdown).toContain('theoremos-research');
    for (const invented of ['not yet planned', '## Tasks', '## Routes', '## Contribution flow', '| solver | lead |'])
      expect(markdown).not.toContain(invented);
    expect(markdown).toContain('Original targets'); expect(markdown).toContain('View.original');
    expect(fs.readFileSync(f.stateFile)).toEqual(saved); expect(f.state.workers).toBeUndefined(); expect(f.state.cooperation).toBeUndefined();
    expect(() => exportRunPlan(f.state)).toThrow('math_edit_plan_unavailable');
  });

  it('shows independent declaration records as historical evidence without altering final acceptance', async () => {
    const f = fixture();
    const records = await f.artifacts(); writeDeclarationArtifacts(f.runtime, f.state, records);
    const before = fs.readFileSync(f.stateFile), manifest = fs.readFileSync(path.join(f.runtime, 'declarations.json'));
    const checks = host.verify.mock.calls.length;
    const report = await inspectStoredRun(f.run);
    expect(report.artifacts.declarations).toMatchObject({ status: 'recorded', evidence: 'recorded-not-replayed',
      acceptance: 'not-assessed', requiresFreshCheck: true, digest: mathDigest(manifest), declarations: [{ name: 'View.helper',
        type: '∀ n : Nat, n = n', sourceCommit: f.commit, checkedCommit: records[0]!.proof.verification.targetCommit,
        receiptIds: [records[0]!.proof.verification.results[0]!.receiptId] }] });
    expect(report.progress.checkedProofTasks).toBe(0); expect(report.recordedOutcome).toBeUndefined(); expect(report.evaluator).toBeUndefined();
    const markdown = renderRunInspection(report);
    expect(markdown).toContain('Recorded declaration artifacts'); expect(markdown).toContain('requires fresh check');
    expect(markdown).toContain('View.helper'); expect(markdown).toContain('not-assessed');
    expect(host.verify.mock.calls.length).toBe(checks);
    expect(fs.readFileSync(f.stateFile)).toEqual(before); expect(fs.readFileSync(path.join(f.runtime, 'declarations.json'))).toEqual(manifest);
  });

  it('retains native child provenance without adding its observational totals to charged usage', async () => {
    const f = fixture();
    f.state.researchDelegation = { mode: 'read-only', maxAgents: 2 };
    f.state.usage = { totalTokens: 60 };
    f.state.nativeAgents = [{ threadId: 'child', parentThreadId: 'parent', startedAt: 1000,
      updatedAt: 1100, status: 'stopped', stoppedAt: 1100, permissionProfile: 'math-investigator',
      usage: { totalTokens: 20 }, message: 'Advisory investigation.' }];
    writeSolverRunState(f.stateFile, f.state);
    const before = fs.readFileSync(f.stateFile), report = await inspectStoredRun(f.run);
    expect(report.delegation).toMatchObject({ evidence: 'recorded-not-replayed', nativeTotals: 'observational-only',
      usageSource: 'shared-upstream-request-receipts', agents: f.state.nativeAgents });
    expect(report.usage).toEqual({ totalTokens: 60 });
    expect(report.progress.checkedProofTasks).toBe(0);
    expect(fs.readFileSync(f.stateFile)).toEqual(before);
  });

  it.each(['corrupt', 'wrong-run', 'wrong-environment'] as const)('retains the inspection when the declaration manifest is %s', async mode => {
    const f = fixture(); writeDeclarationArtifacts(f.runtime, f.state, await f.artifacts());
    const file = path.join(f.runtime, 'declarations.json'), value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (mode === 'corrupt') fs.writeFileSync(file, 'partial write');
    else { value[mode === 'wrong-run' ? 'runId' : 'environmentDigest'] = mode === 'wrong-run' ? 'another-run' : mathDigest('another env');
      fs.writeFileSync(file, JSON.stringify(value)); }
    const report = await inspectStoredRun(f.run);
    expect(report.artifacts.declarations).toMatchObject({ status: 'unknown', evidence: 'recorded-not-replayed', acceptance: 'not-assessed' });
    expect(report.runId).toBe(f.state.runId); expect(report.tasks).toEqual([]);
    expect(renderRunInspection(report)).toContain('Recorded declaration artifacts');
  });

  it('keeps absent legacy sidecars and the established single solver role unchanged', async () => {
    const f = fixture(); delete f.state.researchMode; delete f.state.researchSkill;
    writeSolverRunState(f.stateFile, f.state);
    const report = await inspectStoredRun(f.run);
    expect(report.configuration.researchMode).toBe('legacy'); expect(report.workers[0]!.role).toBe('lead');
    expect(report.artifacts.declarations).toMatchObject({ status: 'absent' });
    expect(renderRunInspection(report)).toContain('not yet planned');
    expect(buildRunInspection(f.state).tasks).toEqual([]);
  });

  it('reads a single-seed raw archived state through its frozen source description and checks both identities', async () => {
    const f = fixture(), oldStateFile = path.join(f.directory, 'unavailable-old.runtime/state.json');
    f.state.taskDigest = mathDigest('unchanged task');
    const archived = { ...f.state, runId: 'old-single-source', turns: 12, buildDigest: mathDigest('source build'),
      methodDigest: mathDigest('source method'), environmentDigest: mathDigest('source environment'),
      usage: { totalTokens: 18000 }, cooperation: { canonicalCommit: f.commit, planVersion: 'old-plan', tasks: [] } };
    const text = canonicalMathJson(archived), sha256 = mathDigest(text);
    const provenance = { source: oldStateFile, runId: archived.runId, evidence: 'recorded-not-replayed' as const, commit: f.commit };
    const manifest: ContinuationManifest = { schema: 'theorem-os.continuation-snapshot.v1', taskDigest: f.state.taskDigest,
      problemReceiptDigest: f.state.problem.receiptDigest, attachments: [{ id: 'seed-history', kind: 'diagnostics',
        path: 'seed-history.json', sha256, bytes: Buffer.byteLength(text), contentPath: `continuation/${sha256}.txt`, provenance }] };
    const snapshot = freezeContinuationInput({ manifest, digest: mathDigest(canonicalMathJson(manifest)),
      contents: new Map([[sha256, text]]) }, f.runtime);
    f.state.continuationDigest = snapshot.digest; f.state.turns = 8;
    writeSolverRunState(f.stateFile, f.state);
    const description = { schema: 'theorem-os.single-continuation-source.v1', taskDigest: f.state.taskDigest,
      problemReceiptDigest: f.state.problem.receiptDigest, sourcePolicyDigest: continuationSourcePolicyDigest(f.state.problem),
      destination: { runId: f.state.runId, stateFile: f.stateFile, configurationDigest: mathDigest('frozen destination configuration') },
      source: { runId: archived.runId, stateFile: oldStateFile, stateDigest: sha256, canonicalCommit: f.commit,
        environmentDigest: archived.environmentDigest, capturedAt: 1234 },
      canonicalSources: { 'Submission.lean': fs.readFileSync(path.join(f.receipt.projectRoot, 'Submission.lean'), 'utf8') },
      canonicalNotes: null, documents: [{ id: 'seed-history', kind: 'diagnostics', text, provenance }], declarations: [] };
    const file = path.join(f.runtime, 'continuation-single-source.json');
    fs.writeFileSync(file, JSON.stringify(description), { mode: 0o400 });
    const stateBefore = fs.readFileSync(f.stateFile), sourceBefore = fs.readFileSync(file);
    const report = await inspectStoredRun(f.run);
    expect(report.artifacts.continuation).toMatchObject({ status: 'recorded', evidence: 'recorded-not-replayed',
      source: { runId: archived.runId, stateFile: oldStateFile, stateDigest: sha256, buildDigest: archived.buildDigest,
        methodDigest: archived.methodDigest, canonicalCommit: f.commit, planVersion: 'old-plan' }, capturedAt: 1234,
      capture: 'single-researcher-frozen-source-and-advisory-history' });
    expect(report.turns).toBe(8); expect(report.usage).toBeUndefined(); expect(report.tasks).toEqual([]);
    expect(renderRunInspection(report)).toContain('old-single-source');
    expect(fs.readFileSync(f.stateFile)).toEqual(stateBefore); expect(fs.readFileSync(file)).toEqual(sourceBefore);
    expect(fs.existsSync(oldStateFile)).toBe(false);
    for (const change of ['destination', 'state-path', 'task', 'problem', 'policy', 'source-run', 'source-digest']) {
      const invalid = structuredClone(description);
      if (change === 'destination') invalid.destination.runId = 'different-run';
      if (change === 'state-path') invalid.destination.stateFile = path.join(f.directory, 'other/state.json');
      if (change === 'task') invalid.taskDigest = mathDigest('different task');
      if (change === 'problem') invalid.problemReceiptDigest = mathDigest('different problem');
      if (change === 'policy') invalid.sourcePolicyDigest = mathDigest('different source policy');
      if (change === 'source-run') invalid.source.runId = 'different-source';
      if (change === 'source-digest') invalid.source.stateDigest = mathDigest('different source bytes');
      fs.chmodSync(file, 0o600); fs.writeFileSync(file, JSON.stringify(invalid)); fs.chmodSync(file, 0o400);
      expect((await inspectStoredRun(f.run)).artifacts.continuation).toMatchObject({ status: 'unknown',
        reason: 'math_inspect_single_source_identity_mismatch' });
    }
  });

  it('extracts a library from an explicit saved skill commit without inventing a canonical task graph', () => {
    const f = fixture(), before = git(f.receipt.workspaceRoot, ['rev-parse', 'HEAD']);
    expect(() => extractRunLibraryModules({ stateFile: f.stateFile, files: ['Submission.lean'] }))
      .toThrow('math_library_extract_commit_required');
    const pack = extractRunLibraryModules({ stateFile: f.stateFile, files: ['Submission.lean'], commit: f.commit, into: 'SkillFixture' });
    expect(pack.modules).toHaveLength(1); expect(pack.modules[0]!.source).toContain('theorem helper');
    expect(pack.modules[0]!.source).not.toContain('theorem original');
    expect(pack.modules[0]!.origin).toMatchObject({ kind: 'run', runId: f.state.runId, commit: f.commit });
    expect(git(f.receipt.workspaceRoot, ['rev-parse', 'HEAD'])).toBe(before); expect(f.state.cooperation).toBeUndefined();
  });
});

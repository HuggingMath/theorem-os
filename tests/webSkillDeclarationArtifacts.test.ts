import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { commitSolverSources, readSolverProblem } from '../src/solver/problem';
import { writeSolverRunState } from '../src/solver/archive';
import { checkDeclarationArtifacts, writeDeclarationArtifacts } from '../src/solver/declarationArtifacts';
import { projectWebDeclarationArtifacts } from '../apps/web/declarationArtifacts';
import { createWebWorkerBridge } from '../apps/web/workerBridge';
import { isWebObservation } from '../apps/web/runner';
import type { WorkerMessage } from '../apps/web/shared';
import { solverState } from './helpers/solver';
import { receiptBatch } from './helpers/verifier';

// The host publishes synthetic receipts for these disposable source fixtures. No Lean or provider process runs.
vi.mock('../src/math/verifier', async original => ({ ...await original<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: vi.fn(async request => receiptBatch(request,
    { sessionId: 'web-declaration-fixture', receiptId: index => `web-declaration-${index}` })) }));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'web-declarations-'))); roots.push(directory);
  const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), { task: 'Prove original.',
    source: 'namespace WebFixture\ntheorem original : True := by sorry\nend WebFixture\n' });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  const file = path.join(receipt.projectRoot, 'Submission.lean');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('end WebFixture',
    'theorem reusable (n : Nat) : n = n := by rfl\nend WebFixture'));
  const commit = commitSolverSources(problem, receipt.workspaceRoot);
  const state = solverState(problem, receipt.workspaceRoot, { runId: 'web-declarations', phase: 'prepared',
    researchMode: 'skill', researchSkill: { name: 'mathematical-research', digest: mathDigest('skill'), loading: 'file' },
    workerCount: 1, coordination: 'independent', environmentDigest: mathDigest('web-fixture-environment') });
  const output = path.join(directory, 'result.json'), stateFile = `${output}.runtime/state.json`;
  fs.mkdirSync(path.dirname(stateFile)); writeSolverRunState(stateFile, state);
  return { directory, receipt, state, output, stateFile, commit };
}

describe('Web independent declaration sidecar projection', () => {
  it('observes sidecar-only arrivals and refreshes the reusable catalog without fabricating task records or accepting the goal', async () => {
    const f = fixture(), messages: WorkerMessage[] = [];
    const bridge = createWebWorkerBridge({ webRunId: 'web-fixture', directory: f.directory, output: f.output,
      onMessage: message => messages.push(message) });
    const before = await bridge.capture({ includeCatalog: true });
    expect(before.observation.declarations?.status).toBe('absent'); expect(before.observation.inspection.tasks).toEqual([]);
    const declaration = { file: 'Submission.lean', name: 'WebFixture.reusable', type: '∀ n : Nat, n = n',
      premises: ['n is universally quantified.'] };
    const artifacts = await checkDeclarationArtifacts({ state: f.state, worktree: f.receipt.workspaceRoot, commit: f.commit,
      declarations: [declaration], env: { PATH: '/usr/bin:/bin', DEEPSCIENTIST_MATH_ENV_FILE: path.join(f.directory, 'absent.env') },
      signal: new AbortController().signal, assertWriterStopped() {} });
    writeDeclarationArtifacts(path.dirname(f.stateFile), f.state, artifacts);
    const after = await bridge.capture();
    expect(after.observation.snapshot.stateDigest).toBe(before.observation.snapshot.stateDigest);
    expect(after.observation.sequence).toBe(before.observation.sequence + 1);
    expect(after.observation.declarations).toMatchObject({ status: 'recorded', evidence: 'recorded-not-replayed',
      acceptance: 'not-assessed', requiresFreshCheck: true, declarations: [{ ...declaration,
        sourceCommit: f.commit, checkedCommit: artifacts[0]!.proof.verification.targetCommit,
        environmentDigest: f.state.environmentDigest, receiptIds: ['web-declaration-0'] }] });
    expect(isWebObservation(after.observation)).toBe(true);
    expect(after.observation.inspection.tasks).toEqual([]); expect(after.observation.plan?.tasks ?? []).toEqual([]);
    expect(f.state.check).toBeUndefined(); expect(after.observation.acceptance).toBe('not-assessed');
    expect(messages.filter(message => message.type === 'catalog')).toHaveLength(2);
    expect(after.catalog?.entries).toHaveLength(1);
    expect(JSON.stringify(after.observation.declarations)).not.toContain(f.directory);
    expect((await bridge.capture()).observation.sequence).toBe(after.observation.sequence);
  });

  it('reports malformed or foreign sidecars as unavailable instead of silently treating them as empty or accepted', () => {
    const f = fixture(), sidecar = path.join(path.dirname(f.stateFile), 'declarations.json');
    for (const value of ['{', JSON.stringify({ schema: 'theorem-os.declaration-artifacts.v1', runId: 'foreign',
      problemReceiptDigest: f.state.problem.receiptDigest, environmentDigest: f.state.environmentDigest, artifacts: [] })]) {
      fs.writeFileSync(sidecar, value);
      expect(projectWebDeclarationArtifacts(f.stateFile, f.state)).toMatchObject({ status: 'unknown',
        acceptance: 'not-assessed', requiresFreshCheck: true });
    }
    fs.rmSync(sidecar);
    expect(projectWebDeclarationArtifacts(f.stateFile, f.state).status).toBe('absent');
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { deliveryDetails } from '../src/solver/deliveries';
import type { NextCheckRecord } from '../src/solver/nextCheckContract';
import { parseCooperationPlan } from '../src/solver/tasks';
import { assignmentDeliveryFile } from '../src/solver/tasks';
import {
  latestProofSearchRecord, MAX_PROOF_SEARCH_CHECKPOINT_BYTES, projectProofSearchRecord,
  proofSearchRecordMatches, proofSearchTargetForAssignment, readProofSearchCheckpoint, retainProofSearchCheckpoint,
  type ProofSearchCheckpointReference, type ProofSearchScope,
} from '../src/solver/proofSearchRecords';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

const forbidden = vi.hoisted(() => ({ model: vi.fn(), lean: vi.fn() }));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: forbidden.model }));
vi.mock('../src/math/leanDiagnostics', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/leanDiagnostics')>(), runLeanDiagnostics: forbidden.lean,
}));

const scope: ProofSearchScope = {
  taskId: 'target', taskDigest: 'task-v1', problemReceiptDigest: 'problem-v1', environmentDigest: 'environment-v1',
};
function saveCheckpoint(project: string, targetScope = scope, generation = 0, extra: Record<string, unknown> = {}) {
  const basis = { scope: targetScope, sourceDigest: mathDigest('source'), projectionDigest: mathDigest('projection'),
    backendDigest: mathDigest('backend'), target: { file: 'Submission.lean', theoremName: 'Tutorial.target', type: 'True' } };
  const basisDigest = mathDigest(canonicalMathJson(basis));
  const checkpoint = { schema: 'theorem-os.proof-search-checkpoint.v1', generation, basis,
    nodes: [{ id: 'root', actions: [], goals: ['⊢ True'] }], counters: { transitions: 0 }, ...extra };
  const bytes = canonicalMathJson(checkpoint);
  const file = path.join(project, '.lake', 'proof-search', basisDigest, `${generation}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return { reference: { path: file, digest: mathDigest(bytes) }, bytes, basisDigest };
}

describe('host-retained advisory proof search records', () => {
  let directory: string, project: string, nextProject: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-search-records-'));
    project = path.join(directory, 'worker', 'project');
    nextProject = path.join(directory, 'replacement', 'project');
    fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(nextProject, { recursive: true });
    forbidden.model.mockImplementation(() => { throw new Error('models must not run'); });
    forbidden.lean.mockImplementation(() => { throw new Error('Lean must not run'); });
  });
  afterEach(() => {
    expect(forbidden.model).not.toHaveBeenCalled(); expect(forbidden.lean).not.toHaveBeenCalled();
    forbidden.model.mockReset(); forbidden.lean.mockReset();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const retain = (reference: ProofSearchCheckpointReference, expectedScope = scope) => retainProofSearchCheckpoint({
    projectRoot: project, runDirectory: directory, reference, scope: expectedScope,
    workerId: 'worker', assignmentKey: 'DELIVERIES-target.jsonl', now: 7,
  });

  it('retains exact bytes across worker scratch removal and restores a worker-readable copy', () => {
    const saved = saveCheckpoint(project), record = retain(saved.reference);
    expect(record).toMatchObject({ ...scope, basisDigest: saved.basisDigest, generation: 0,
      evidence: 'advisory-proof-search', proofAcceptance: 'not-accepted' });
    expect(record.checkpoint.path).toBe(path.join(directory, 'proof-search-artifacts', `${saved.reference.digest}.json`));
    fs.rmSync(path.join(project, '.lake'), { recursive: true });
    expect(fs.readFileSync(record.checkpoint.path, 'utf8')).toBe(saved.bytes);
    const projected = projectProofSearchRecord({ record, scope, projectRoot: nextProject, runDirectory: directory })!;
    expect(projected.checkpoint.path.startsWith(nextProject + path.sep)).toBe(true);
    expect(projected.checkpoint.digest).toBe(record.checkpoint.digest);
    expect(readProofSearchCheckpoint(nextProject, projected.checkpoint).bytes.toString()).toBe(saved.bytes);
    expect(record.checkpoint.path).not.toBe(projected.checkpoint.path);
  });

  it.each(['taskId', 'taskDigest', 'problemReceiptDigest', 'environmentDigest'] as const)(
    'rejects a publication and hides a restoration when %s differs', field => {
      const saved = saveCheckpoint(project), changed = { ...scope, [field]: 'changed' };
      expect(() => retain(saved.reference, changed)).toThrow('math_proof_search_checkpoint_scope_changed');
      const record = retain(saved.reference);
      expect(proofSearchRecordMatches(record, changed)).toBe(false);
      expect(projectProofSearchRecord({ record, scope: changed, projectRoot: nextProject, runDirectory: directory })).toBeUndefined();
    });

  it('rejects changed bytes, mismatched basis folders and references outside project scratch', () => {
    const saved = saveCheckpoint(project);
    expect(() => retain({ ...saved.reference, digest: mathDigest('other bytes') })).toThrow('math_proof_search_checkpoint_invalid');
    const foreign = path.join(directory, 'outside.json'); fs.writeFileSync(foreign, saved.bytes);
    expect(() => retain({ ...saved.reference, path: foreign })).toThrow('math_proof_search_checkpoint_invalid');
    const wrong = path.join(project, '.lake', 'proof-search', mathDigest('other basis'), '0.json');
    fs.mkdirSync(path.dirname(wrong), { recursive: true }); fs.writeFileSync(wrong, saved.bytes);
    expect(() => retain({ ...saved.reference, path: wrong })).toThrow('math_proof_search_checkpoint_invalid');
  });

  it('rejects linked worker files and overlarge or malformed checkpoint bodies', () => {
    const saved = saveCheckpoint(project), outside = path.join(directory, 'linked.json');
    fs.renameSync(saved.reference.path, outside); fs.symlinkSync(outside, saved.reference.path);
    expect(() => retain(saved.reference)).toThrow('math_proof_search_checkpoint_invalid');
    fs.unlinkSync(saved.reference.path);
    fs.writeFileSync(saved.reference.path, ' '.repeat(MAX_PROOF_SEARCH_CHECKPOINT_BYTES + 1));
    expect(() => retain(saved.reference)).toThrow('math_proof_search_checkpoint_invalid');
    fs.writeFileSync(saved.reference.path, JSON.stringify({ schema: 'wrong' }));
    expect(() => retain({ path: saved.reference.path, digest: mathDigest(fs.readFileSync(saved.reference.path)) }))
      .toThrow('math_proof_search_checkpoint_invalid');
  });

  it('does not follow a linked basis directory when projecting host-retained data', () => {
    const saved = saveCheckpoint(project), record = retain(saved.reference), outside = path.join(directory, 'unrelated');
    fs.mkdirSync(outside);
    const scratch = path.join(nextProject, '.lake', 'proof-search'); fs.mkdirSync(scratch, { recursive: true });
    fs.symlinkSync(outside, path.join(scratch, saved.basisDigest));
    expect(projectProofSearchRecord({ record, scope, projectRoot: nextProject, runDirectory: directory })).toBeUndefined();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('does not restore altered retained data or a forged host path', () => {
    const saved = saveCheckpoint(project), record = retain(saved.reference);
    expect(projectProofSearchRecord({ record: { ...record, checkpoint: saved.reference }, scope,
      projectRoot: nextProject, runDirectory: directory })).toBeUndefined();
    fs.chmodSync(record.checkpoint.path, 0o600); fs.writeFileSync(record.checkpoint.path, '{}');
    expect(projectProofSearchRecord({ record, scope, projectRoot: nextProject, runDirectory: directory })).toBeUndefined();
  });

  it('retains the newer generation, accepts a new basis, and rejects two bodies for one generation', () => {
    const first = retain(saveCheckpoint(project).reference), newer = retain(saveCheckpoint(project, scope, 2).reference);
    expect(latestProofSearchRecord(newer, first)).toBe(newer);
    expect(latestProofSearchRecord(first, newer)).toBe(newer);
    expect(() => latestProofSearchRecord(newer, { ...newer,
      checkpoint: { ...newer.checkpoint, digest: mathDigest('different body') } })).toThrow('math_proof_search_checkpoint_invalid');
    const changed = retain(saveCheckpoint(project, { ...scope, environmentDigest: 'env-v2' }).reference,
      { ...scope, environmentDigest: 'env-v2' });
    expect(latestProofSearchRecord(newer, changed)).toBe(changed);
  });

  it('selects only the current assignment’s pending host-authorized next-check target', () => {
    const assignment = { taskId: 'investigation', taskDigest: 'investigation-v1' };
    const target = { taskId: scope.taskId, taskDigest: scope.taskDigest };
    const record: NextCheckRecord = { id: mathDigest('check'), gapDeliveryId: 'gap', createdAt: 0,
      taskId: assignment.taskId, taskDigest: assignment.taskDigest, status: 'pending',
      scope: { problemReceiptDigest: scope.problemReceiptDigest, environmentDigest: scope.environmentDigest,
        target, parent: target, consumer: target, dependencies: [], gapScopeDigest: mathDigest('gap') },
      check: { action: 'construction-check', objective: 'Continue the target prefix.', expectedEvidence: 'Remaining goals.',
        execution: { kind: 'proof-search', ...target } } };
    expect(proofSearchTargetForAssignment(assignment, [record], scope)).toEqual(target);
    expect(proofSearchTargetForAssignment(assignment, [{ ...record, status: 'stale' }], scope)).toEqual(assignment);
    expect(proofSearchTargetForAssignment({ ...assignment, taskDigest: 'new-version' }, [record], scope))
      .toEqual({ ...assignment, taskDigest: 'new-version' });
    expect(proofSearchTargetForAssignment(assignment, [record], { ...scope, environmentDigest: 'new-env' })).toEqual(assignment);
    expect(proofSearchTargetForAssignment(assignment, [], scope)).toEqual(assignment);
  });

  it('permits checkpoint references only in progress events and keeps old progress valid', () => {
    const reference = saveCheckpoint(project).reference;
    expect(deliveryDetails({ kind: 'progress', summary: 'Explored.', searchCheckpoint: reference }).searchCheckpoint).toEqual(reference);
    expect(deliveryDetails({ kind: 'progress', summary: 'Old event.' }).searchCheckpoint).toBeUndefined();
    expect(() => deliveryDetails({ kind: 'proof', searchCheckpoint: reference })).toThrow('math_delivery_invalid');
  });
});

import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localExample, solverState } from './helpers/solver';
import { verifiedBatch } from './helpers/verifier';
import { checkpointVerification, VerificationCheckpointError, withVerificationCheckpoints,
  type VerificationCheckpoint } from '../src/solver/verificationCheckpoint';
import type { MathematicsVerifierBatchRequest } from '../src/math/verifier';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { taskVersion, type CooperativeAction } from '../src/solver/tasks';
import path from 'node:path';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { git } from '../src/solver/problem';

describe('resumable verification scheduling', () => {
  let example: ReturnType<typeof localExample>, request: MathematicsVerifierBatchRequest & { targetCommit: string };
  let checkpoints: VerificationCheckpoint[], events: string[], saved: number;
  const run = <T>(operation: () => Promise<T>, environmentDigest = 'environment') => withVerificationCheckpoints({
    environmentDigest, problemReceiptDigest: example.problem.receiptDigest, checkpoints,
    save: () => { saved++; }, emit: event => events.push(event),
  }, operation);
  const expired = (input: typeof request) => {
    const batch = verifiedBatch(input, { sessionId: 'timeout-fixture' });
    return { ...batch, status: 'blocked' as const, results: batch.results.map(result => ({ ...result,
      status: 'blocked' as const, error: 'Lean verification timed out.' })) };
  };
  beforeEach(() => {
    example = localExample('verification-checkpoint-'); checkpoints = []; events = []; saved = 0;
    request = { projectRoot: example.receipt.projectRoot, targetCommit: example.problem.baseCommit, timeoutMs: 1000,
      items: [{ proofPath: 'Submission.lean', theoremName: 'Tutorial.add_zero', statementHash: 'fixture', leanStatementHash: 'fixture' }] };
  });
  afterEach(() => { vi.useRealTimers(); fs.rmSync(example.directory, { recursive: true, force: true }); });

  it('persists a time limit and gives the identical input more time after restart', async () => {
    await expect(run(() => checkpointVerification(request, async input => expired(input)))).rejects.toBeInstanceOf(VerificationCheckpointError);
    expect(saved).toBe(1); expect(checkpoints[0]).toMatchObject({ timeoutMs: 1000, attempts: 1 });
    const state = solverState(example.problem, example.workspace, { runId: 'same-run', phase: 'finished', verificationCheckpoints: checkpoints });
    const file = path.join(example.directory, 'state.json'); writeSolverRunState(file, state);
    checkpoints = readSolverRunState(file).verificationCheckpoints!;
    let limit = 0;
    await run(() => checkpointVerification(request, async input => { limit = input.timeoutMs!; return verifiedBatch(input, { sessionId: 'resumed' }); }));
    expect(limit).toBe(2000); expect(events).toContain('verification_checkpoint');
    expect(readSolverRunState(file).runId).toBe('same-run');
  });

  it('does not carry the extra allowance to a different environment or target', async () => {
    await expect(run(() => checkpointVerification(request, async input => expired(input)))).rejects.toBeInstanceOf(VerificationCheckpointError);
    for (const [input, environment] of [[request, 'different-environment'],
      [{ ...request, items: [{ ...request.items[0]!, theoremName: 'Other.target' }] }, 'environment']] as const) {
      await run(() => checkpointVerification(input, async bound => {
        expect(bound.timeoutMs).toBe(1000); return verifiedBatch(bound, { sessionId: 'changed' });
      }), environment);
    }
  });

  it('does not inherit the allowance of legacy keys that could misclassify handshake failures', async () => {
    const key = mathDigest(canonicalMathJson({ schema: 'theorem-os.verification-checkpoint.v1',
      tree: git(request.projectRoot, ['rev-parse', `${request.targetCommit}^{tree}`]), items: request.items,
      environmentDigest: 'environment', problemReceiptDigest: example.problem.receiptDigest }));
    const legacy = { key, timeoutMs: 1_800_000, attempts: 1, at: 1,
      targetCommit: request.targetCommit, receiptIds: ['legacy-timeout'] };
    checkpoints.push(legacy);
    await run(() => checkpointVerification(request, async input => {
      expect(input.timeoutMs).toBe(request.timeoutMs);
      return verifiedBatch(input, { sessionId: 'fixed-classification' });
    }));
    expect(checkpoints).toEqual([legacy]);
  });

  it('leaves source failures and unconfirmed cleanup on their original failure paths', async () => {
    for (const result of [
      { ...expired(request), status: 'failed' as const, results: expired(request).results.map(item => ({ ...item, status: 'failed' as const, error: 'Lean exited with status 1.' })) },
      { ...expired(request), results: expired(request).results.map(item => ({ ...item, cleanupError: 'process still alive' })) },
    ]) expect(await run(() => checkpointVerification(request, async () => result))).toEqual(result);
    expect(checkpoints).toEqual([]); expect(saved).toBe(0);
  });

  it('bounds the entire batch and emits progress while the verifier is running', async () => {
    vi.useFakeTimers();
    const result = await run(() => checkpointVerification({ ...request, timeoutMs: 180_000 }, async input => {
      expect(input.batchTimeoutMs).toBe(180_000);
      await vi.advanceTimersByTimeAsync(60_001);
      return verifiedBatch(input, { sessionId: 'heartbeat' });
    }));
    expect(result.status).toBe('kernel_verified'); expect(events).toContain('verification_heartbeat'); expect(vi.getTimerCount()).toBe(0);
  });

  it('honors an explicit unlimited verification allowance', async () => {
    await run(() => checkpointVerification({ ...request, timeoutMs: Infinity }, async input => {
      expect(input.timeoutMs).toBe(Infinity); return expired(input);
    }));
    expect(checkpoints).toEqual([]);
  });

});

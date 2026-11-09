import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import type { MathematicsVerifierBatchRequest, MathematicsVerifierBatchResult } from '../math/verifier';
import { git } from './problem';

export type VerificationCheckpoint = { key: string; timeoutMs: number; attempts: number; at: number;
  targetCommit: string; receiptIds: string[] };
type Context = { environmentDigest: string; problemReceiptDigest: string;
  checkpoints: VerificationCheckpoint[]; save: () => void;
  emit: (event: string, details?: Record<string, unknown>) => void };
const context = new AsyncLocalStorage<Context>();
const MAX_VERIFICATION_MS = 24 * 60 * 60 * 1000;

/** A scheduling checkpoint preserves the candidate; it is neither a failed proof nor an unavailable verifier. */
export class VerificationCheckpointError extends Error {
  constructor(readonly checkpoint: VerificationCheckpoint) { super('math_verification_checkpoint'); }
}

export const withVerificationCheckpoints = <T>(input: Context, run: () => Promise<T>): Promise<T> => context.run(input, run);

/** Bound the complete verification separately from solving; only the identical input gets more time on resume. */
export async function checkpointVerification(request: MathematicsVerifierBatchRequest & { targetCommit: string },
  verify: (request: MathematicsVerifierBatchRequest & { targetCommit: string }) => Promise<MathematicsVerifierBatchResult>): Promise<MathematicsVerifierBatchResult> {
  const current = context.getStore();
  if (!current || request.timeoutMs === Infinity) return verify(request);
  // Legacy keys could include lease-handshake failures mislabeled as proof timeouts.
  const key = mathDigest(canonicalMathJson({ schema: 'theorem-os.verification-checkpoint.v2',
    tree: git(request.projectRoot, ['rev-parse', `${request.targetCommit}^{tree}`]), items: request.items,
    environmentDigest: current.environmentDigest, problemReceiptDigest: current.problemReceiptDigest }));
  const previous = current.checkpoints.find(record => record.key === key);
  const timeoutMs = Math.min(MAX_VERIFICATION_MS, Math.max(request.timeoutMs ?? 180_000,
    previous ? previous.timeoutMs * 2 : 0));
  const details = { key, targetCommit: request.targetCommit, timeoutMs, attempt: (previous?.attempts ?? 0) + 1 };
  current.emit('verification_started', details);
  const startedAt = Date.now();
  const heartbeat = setInterval(() => current.emit('verification_heartbeat', { ...details, elapsedMs: Date.now() - startedAt }), 60_000);
  heartbeat.unref();
  let result: MathematicsVerifierBatchResult;
  try { result = await verify({ ...request, timeoutMs, batchTimeoutMs: Math.min(request.batchTimeoutMs ?? Infinity, timeoutMs) }); }
  finally { clearInterval(heartbeat); }
  const expired = result.results.some(receipt => receipt.status === 'blocked' &&
    /^(?:Lean verification timed out\.|Formal verification batch deadline exceeded\.?)$/u.test(receipt.error ?? ''));
  const diagnostics = result.results.filter(receipt => receipt.status !== 'kernel_verified').slice(0, 8).map(receipt => ({
    receiptId: receipt.receiptId, status: receipt.status, error: receipt.error?.slice(0, 1024),
    stderrPreview: receipt.stderrPreview?.slice(0, 1024), cleanupError: receipt.cleanupError?.slice(0, 1024),
  }));
  // Unconfirmed process cleanup must keep the existing infrastructure failure path.
  if (!expired || result.results.some(receipt => receipt.cleanupError || receipt.status === 'unavailable')) {
    current.emit('verification_finished', { ...details, status: result.status, elapsedMs: Date.now() - startedAt, diagnostics });
    return result;
  }
  const checkpoint: VerificationCheckpoint = { key, timeoutMs, attempts: (previous?.attempts ?? 0) + 1,
    at: Date.now(), targetCommit: request.targetCommit, receiptIds: result.results.map(receipt => receipt.receiptId) };
  if (previous) Object.assign(previous, checkpoint);
  else { current.checkpoints.push(checkpoint); if (current.checkpoints.length > 32) current.checkpoints.shift(); }
  current.save();
  current.emit('verification_checkpoint', { ...checkpoint, elapsedMs: Date.now() - startedAt, diagnostics });
  throw new VerificationCheckpointError(checkpoint);
}

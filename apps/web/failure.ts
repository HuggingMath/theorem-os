import { researchFailureCategory, researchFailureReason } from '../../src/solver/modules/search';
import { webFailureKinds, webFailureReason, type WebFailure, type WebFailureKind } from './shared';

// Earlier entries explain later ones: a rejected key also ends every Agent session.
const priority: WebFailureKind[] = ['authentication', 'rate_limit', 'budget', 'environment', 'source', 'network', 'protocol'];
// Only runtime reason codes leave the worker; provider text may quote the request.
const reasonCode = (value: string) => webFailureReason.test(value) ? value : undefined;

function categoryOf(error: string): WebFailureKind {
  const category = researchFailureCategory(error);
  return category && category !== 'proof' && (webFailureKinds as readonly string[]).includes(category) ? category as WebFailureKind : 'unknown';
}
function failure(kind: WebFailureKind, error?: string): WebFailure {
  // The fallback 'math_model_turn_failed' would only restate that the text was unrecognised.
  const derived = error === undefined ? undefined : researchFailureReason(error);
  const code = error === undefined ? undefined : reasonCode(error) ?? (derived === 'math_model_turn_failed' ? undefined : derived);
  return { kind, ...(code ? { reason: code } : {}) };
}

/** Classify a finished solver result. Accepted and rejected proofs are not failures. */
export function classifyWebResult(raw: Record<string, unknown>): WebFailure | undefined {
  const status = String(raw.status ?? 'runtime_error'), reason = typeof raw.reason === 'string' ? raw.reason : undefined;
  if (!['limit_reached', 'runtime_error', 'incomplete'].includes(status)) return;
  if (reason === 'math_run_stopped' || reason === 'math_preparation_stopped') return failure('time_limit', reason);
  if (reason === 'math_total_token_limit' || reason === 'math_model_usage_unavailable') return failure('budget', reason);
  const workers = Array.isArray(raw.workers) ? raw.workers : [];
  const errors = [reason, ...workers.map(worker => worker && typeof worker === 'object' ? (worker as { error?: unknown }).error : undefined)]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  const classified = errors.map(error => ({ error, kind: categoryOf(error) }));
  const found = priority.map(kind => classified.find(item => item.kind === kind)).find(Boolean);
  if (found) return failure(found.kind, found.error);
  if (status === 'limit_reached') return failure('time_limit');
  return status === 'runtime_error' ? failure('unknown', errors[0]) : undefined;
}

/** Classify an exception thrown before the solver wrote a result. */
export function classifyWebError(error: unknown): WebFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (/^lean_task_/u.test(message)) return failure('source', message);
  const kind = categoryOf(message);
  return failure(kind === 'unknown' ? 'environment' : kind, message);
}

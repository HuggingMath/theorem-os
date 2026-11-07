import { randomUUID } from 'node:crypto';
import { normalizeModelRequestUsage, type ModelRequestReceipt, type ModelRequestIdentity } from '../runtime/modelRequest';

export type UsageAccounting = {
  startedTurns: number;
  reportedTurns: number;
  pending: boolean;
  incomplete: boolean;
};

export type RequestUsageAccounting = {
  startedRequests: number;
  reportedRequests: number;
  pendingRequests: number;
  incomplete: boolean;
  /** Optional for legacy checkpoints. These are the identities behind the existing counters. */
  receipts?: RequestUsageObservation[];
  /** A native session cannot supply a provider request denominator. */
  nativeUsageObserved?: boolean;
};

export type RequestUsageObservation = ModelRequestIdentity & {
  runId?: string; sessionId?: string; taskId?: string; startedAt: number; settledAt?: number;
  status: 'pending' | 'reported' | 'missing';
  usage?: ModelRequestReceipt['usage']; outcome?: ModelRequestReceipt['outcome'];
  missingReason?: ModelRequestReceipt['missingReason']; providerRequestId?: string;
};

export type TokenBudget = {
  maxTotalTokens: number;
  /** Notifications arrive after consumption; this does not cap tokens in requests already in flight. */
  enforcement: 'provider-observed-dispatch-limit' | 'provider-observed-upstream-request-limit';
  status: 'unlimited' | 'available' | 'exhausted' | 'usage-unavailable';
  reportedTotalTokens: number | null;
  usageComplete: boolean;
  overrunTokens: number | null;
  reason?: 'math_total_token_limit' | 'math_model_usage_unavailable';
};

type UsageRecord = {
  turns: number;
  usage?: Record<string, unknown>;
  usageBeforeThread?: Record<string, unknown>;
  usageAccounting?: UsageAccounting;
  requestUsageAccounting?: RequestUsageAccounting;
};

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Cached input and reasoning output are subsets, never additional tokens. */
export function reportedTotalTokens(usage?: Record<string, unknown>): number | null {
  if (count(usage?.totalTokens)) return usage.totalTokens;
  if (count(usage?.inputTokens) && count(usage?.outputTokens)) {
    const total = usage.inputTokens + usage.outputTokens;
    if (count(total)) return total;
  }
  return null;
}

/** A resumed unfinished request and legacy untracked requests have no complete usage receipt. */
export function initializeUsageAccounting(record: UsageRecord): void {
  if (!record.usageAccounting) record.usageAccounting = {
    startedTurns: record.turns, reportedTurns: 0, pending: false, incomplete: record.turns > 0,
  };
  else if (record.usageAccounting.pending) {
    record.usageAccounting.pending = false;
    if (!record.requestUsageAccounting) record.usageAccounting.incomplete = true;
  }
  if (record.requestUsageAccounting?.pendingRequests) {
    for (const receipt of record.requestUsageAccounting.receipts ?? []) if (receipt.status === 'pending') {
      receipt.status = 'missing'; receipt.outcome = 'interrupted'; receipt.missingReason = 'resumed-without-receipt';
      receipt.settledAt = Date.now();
    }
    record.requestUsageAccounting.pendingRequests = 0;
    record.requestUsageAccounting.incomplete = true;
  }
}

/** Preserve known legacy consumption when a resumed session switches to direct request receipts. */
export function initializeRequestUsageAccounting(record: UsageRecord): void {
  record.requestUsageAccounting ??= { startedRequests: 0, reportedRequests: 0, pendingRequests: 0,
    incomplete: Boolean(record.usageAccounting?.incomplete ||
      (record.usageAccounting && record.usageAccounting.startedTurns > record.usageAccounting.reportedTurns) ||
      (!record.usageAccounting && record.turns > 0)) };
}

/** Each lease represents exactly one attempted upstream request, independent of native thread counters. */
export function beginRequestUsage(record: UsageRecord, identity: Partial<ModelRequestIdentity> & {
  runId?: string; sessionId?: string; taskId?: string; startedAt?: number;
} = {}): (receipt: ModelRequestReceipt) => void {
  const accounting = record.requestUsageAccounting!;
  const requestId = identity.requestId ?? randomUUID();
  const receipts = accounting.receipts ??= [];
  let observation = receipts.find(item => item.requestId === requestId);
  if (!observation) {
    observation = { ...identity, requestId, startedAt: identity.startedAt ?? Date.now(), status: 'pending' };
    receipts.push(observation);
    accounting.startedRequests++;
    accounting.pendingRequests++;
  }
  return receipt => {
    // The persisted identity also deduplicates settlement after checkpoint serialization/replay.
    if (observation.status !== 'pending') return;
    accounting.pendingRequests--;
    const usage = normalizeModelRequestUsage(receipt.usage);
    let valid = usage !== undefined;
    const merged = { ...record.usage };
    for (const [key, value] of Object.entries(usage ?? {})) {
      const previous = merged[key] ?? 0;
      if (!count(value) || !count(previous) || !count(previous + value)) { valid = false; continue; }
      merged[key] = previous + value;
    }
    if (valid) record.usage = merged;
    observation.settledAt = Date.now(); observation.outcome = receipt.outcome ?? 'unknown';
    if (usage) observation.usage = usage;
    if (receipt.providerRequestId) observation.providerRequestId = receipt.providerRequestId;
    if (receipt.complete && valid) { observation.status = 'reported'; accounting.reportedRequests++; }
    else {
      observation.status = 'missing'; accounting.incomplete = true;
      observation.missingReason = receipt.missingReason ?? (receipt.usage === undefined ? 'provider-usage-missing' :
        !valid ? 'provider-usage-invalid' : 'unknown');
    }
  };
}

/** Merge a provider's thread total with prior threads, without counting duplicate notifications twice. */
export function recordThreadUsage(record: UsageRecord, reported: Record<string, unknown>): boolean {
  const merged = { ...record.usage };
  for (const [key, value] of Object.entries(reported)) {
    if (!count(value)) continue;
    const baseline = record.usageBeforeThread?.[key];
    const total = (count(baseline) ? baseline : 0) + value;
    if (count(total)) merged[key] = Math.max(count(merged[key]) ? merged[key] : 0, total);
  }
  const reportedTotal = reportedTotalTokens(reported);
  if (reportedTotal !== null) {
    const baseline = reportedTotalTokens(record.usageBeforeThread) ?? 0;
    const total = baseline + reportedTotal;
    const previous = reportedTotalTokens(record.usage) ?? 0;
    if (!count(total) || total < previous) {
      if (record.usageAccounting) record.usageAccounting.incomplete = true;
      record.usage = merged;
      return false;
    }
    merged.totalTokens = total;
  }
  record.usage = merged;
  return reportedTotal !== null;
}

/** Add the growth of a worker's reported usage to one task; regressions are accounting gaps, not refunds. */
export function attributeTaskUsage(state: { taskUsage?: Record<string, Record<string, number>> }, taskId: string,
  before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): void {
  for (const [key, value] of Object.entries(after ?? {})) {
    const previous = before?.[key] ?? 0;
    if (!count(value) || !count(previous)) continue;
    const delta = value - previous;
    if (delta <= 0) continue;
    const usage = (state.taskUsage ??= {})[taskId] ??= {};
    const total = (usage[key] ?? 0) + delta;
    if (count(total)) usage[key] = total;
  }
}

export function aggregateUsage(records: readonly UsageRecord[]): Record<string, unknown> {
  const usage: Record<string, unknown> = {};
  for (const record of records) for (const [key, value] of Object.entries(record.usage ?? {})) {
    if (!count(value)) continue;
    if (usage[key] === null) continue;
    const total = Number(usage[key] ?? 0) + value;
    usage[key] = count(total) ? total : null;
  }
  return usage;
}

export type UsageAttemptObservation = {
  runId: string; sourceRunId?: string; observedAt: number; records: readonly UsageRecord[];
};

/** A report over explicit attempt ancestry, not another budget or a reconstruction of missing provider data. */
export function summarizeUsageObservation(attempts: readonly UsageAttemptObservation[], input: {
  runId: string; startedAt: number; endedAt: number;
}) {
  const latest = new Map<string, UsageAttemptObservation>();
  for (const attempt of attempts) if (!latest.has(attempt.runId) || latest.get(attempt.runId)!.observedAt < attempt.observedAt)
    latest.set(attempt.runId, attempt);
  const selected: UsageAttemptObservation[] = [], missingRunIds: string[] = [], visited = new Set<string>();
  let runId: string | undefined = input.runId;
  while (runId && !visited.has(runId)) {
    visited.add(runId);
    const attempt = latest.get(runId);
    if (!attempt) { missingRunIds.push(runId); break; }
    selected.push(attempt); runId = attempt.sourceRunId;
  }
  const ancestryCycle = runId !== undefined && visited.has(runId) && missingRunIds.length === 0;
  const receipts = new Map<string, RequestUsageObservation>();
  let duplicateReceipts = 0, unidentifiedRequests = 0, nativeRecordsWithUnknownRequests = 0;
  for (const attempt of selected) for (const record of attempt.records) {
    const accounting = record.requestUsageAccounting;
    if ((!accounting && (record.usageAccounting?.startedTurns ?? record.turns) > 0) || accounting?.nativeUsageObserved)
      nativeRecordsWithUnknownRequests++;
    if (accounting) unidentifiedRequests += Math.max(0, accounting.startedRequests - (accounting.receipts?.length ?? 0));
    for (const receipt of accounting?.receipts ?? []) {
      if (receipt.startedAt < input.startedAt || receipt.startedAt > input.endedAt) continue;
      const key = attempt.runId + '\0' + receipt.requestId, previous = receipts.get(key);
      if (previous) duplicateReceipts++;
      if (!previous || (receipt.settledAt ?? receipt.startedAt) > (previous.settledAt ?? previous.startedAt)) receipts.set(key, receipt);
    }
  }
  const observed = [...receipts.values()], reported = observed.filter(item => item.status === 'reported'),
    pending = observed.filter(item => item.status === 'pending'), missing = observed.filter(item => item.status === 'missing');
  const reasons: Record<string, number> = {};
  for (const item of missing) reasons[item.missingReason ?? 'unknown'] = (reasons[item.missingReason ?? 'unknown'] ?? 0) + 1;
  const unknownDenominator = missingRunIds.length > 0 || ancestryCycle || unidentifiedRequests > 0 || nativeRecordsWithUnknownRequests > 0;
  const budget = buildTokenBudget(0, selected.flatMap(attempt => [...attempt.records]));
  return {
    schema: 'theorem-os.usage-observation.v1' as const,
    interval: { startedAt: input.startedAt, endedAt: input.endedAt },
    runIds: selected.map(attempt => attempt.runId), missingRunIds, ancestryCycle,
    duplicateAttemptSnapshots: attempts.length - latest.size, duplicateReceiptRecords: duplicateReceipts,
    denominator: { scope: 'observed-upstream-request-identities-started-in-interval' as const,
      observedRequestStarts: observed.length, actualProviderRequestStarts: unknownDenominator ? null : observed.length,
      coverage: unknownDenominator ? 'unknown' as const : 'observed' as const },
    completedRequests: reported.length + missing.length, pendingRequests: pending.length,
    requestsWithCompleteUsage: reported.length, knownMissingRequests: missing.length, missingReasons: reasons,
    unidentifiedHistoricalRequests: unidentifiedRequests, nativeRecordsWithUnknownRequests,
    observedRequestReceiptCoverage: pending.length || missing.length ? 'incomplete' as const : 'complete' as const,
    knownIntervalTokens: observed.reduce((total, item) => total + (reportedTotalTokens(item.usage) ?? 0), 0),
    cumulativeKnownTokens: budget.reportedTotalTokens, cumulativeUsageComplete: budget.usageComplete && !missingRunIds.length && !ancestryCycle,
    costComparison: 'unsupported' as const,
  };
}

/** Partial reported consumption stays visible; missing reports never become zero-cost completed work. */
export function buildTokenBudget(maxTotalTokens: number, records: readonly UsageRecord[],
  enforcement: TokenBudget['enforcement'] = 'provider-observed-dispatch-limit'): TokenBudget {
  if (!count(maxTotalTokens)) throw new Error('invalid --max-total-tokens');
  let total = 0;
  let reported = false;
  let worked = false;
  let incomplete = false;
  let pending = false;
  for (const record of records) {
    const accounting = record.usageAccounting;
    const requests = record.requestUsageAccounting;
    const hadWork = requests ? requests.startedRequests > 0 || requests.incomplete
      : (accounting?.startedTurns ?? record.turns) > 0;
    const tokens = reportedTotalTokens(record.usage);
    worked ||= hadWork;
    incomplete ||= requests ? requests.incomplete || requests.startedRequests - requests.reportedRequests > requests.pendingRequests
      : Boolean(accounting?.incomplete || (!accounting && hadWork) ||
        (accounting && accounting.startedTurns - accounting.reportedTurns > Number(accounting.pending)));
    pending ||= requests ? requests.pendingRequests > 0 : Boolean(accounting?.pending);
    if (tokens !== null) { total += tokens; reported = true; }
  }
  if (!count(total)) { incomplete = true; reported = false; }
  const reportedTotal = count(total) && (reported || !worked) ? total : null;
  const status = !maxTotalTokens ? 'unlimited' : incomplete ? 'usage-unavailable' :
    reportedTotal !== null && reportedTotal >= maxTotalTokens ? 'exhausted' : 'available';
  return { maxTotalTokens, enforcement, status,
    reportedTotalTokens: reportedTotal, usageComplete: !incomplete && !pending,
    overrunTokens: reportedTotal === null ? null : maxTotalTokens ? Math.max(0, reportedTotal - maxTotalTokens) : 0,
    ...(status === 'exhausted' ? { reason: 'math_total_token_limit' as const } :
      status === 'usage-unavailable' ? { reason: 'math_model_usage_unavailable' as const } : {}) };
}

export const modelDispatchAllowed = (budget: TokenBudget): boolean =>
  budget.status === 'unlimited' || budget.status === 'available';

/** Whether reported consumption has reached a finite allowance, for stopping turns already in flight; unreported usage adds nothing. */
export function allowanceReached(maxTotalTokens: number, records: readonly UsageRecord[]): boolean {
  if (!maxTotalTokens) return false;
  let total = 0;
  for (const record of records) total += reportedTotalTokens(record.usage) ?? 0;
  return total >= maxTotalTokens;
}

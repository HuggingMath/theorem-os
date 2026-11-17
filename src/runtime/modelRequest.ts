export type ModelRequestUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
};

export type ModelRequestMissingReason = 'provider-usage-missing' | 'provider-usage-invalid' | 'upstream-http-error' |
  'upstream-transport-error' | 'request-cancelled' | 'response-not-terminal' | 'resumed-without-receipt' | 'unknown';
export type ModelRequestOutcome = 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';
export type ModelRequestIdentity = { requestId: string; source?: 'chat-completions-bridge' | 'responses-relay' | 'native-model-relay';
  /** Native session metadata/header, when supplied; missing attribution is never inferred from arrival order. */
  threadId?: string };
export type ModelRequestReceipt = {
  usage?: ModelRequestUsage;
  /** Complete usage accounting, independently of whether generation succeeded. */
  complete: boolean; outcome?: ModelRequestOutcome; missingReason?: ModelRequestMissingReason; providerRequestId?: string;
};
export type ModelRequestStopReason = 'math_total_token_limit' | 'math_model_usage_unavailable' |
  'math_model_request_stopped' | 'math_initial_planning_limit';
export type ModelRequestAdmission =
  | { allowed: true; settle: (receipt: ModelRequestReceipt) => void }
  | { allowed: false; reason: ModelRequestStopReason };

/** Admission and settlement are synchronous so another request cannot observe stale receipts. */
export type ModelRequestGate = ((identity?: ModelRequestIdentity) => ModelRequestAdmission) & {
  /** Ask for a resumable handoff at an unpaid request boundary. This is scheduling,
   * not a model allowance; the caller may continue the same thread afterwards. */
  checkpoint?: () => boolean;
  /** Transport coordination before admission; waiting neither reserves nor charges a provider request. */
  beforeRequest?: (signal: AbortSignal) => Promise<void>;
};

/** Reject inconsistent provider counts; cached/reasoning counts are subsets. */
export function normalizeModelRequestUsage(value: unknown): ModelRequestUsage | undefined {
  if (!value || typeof value !== 'object') return;
  const usage = value as Record<string, unknown>;
  const count = (item: unknown): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0;
  if (!count(usage.inputTokens) || !count(usage.outputTokens) || !count(usage.totalTokens) ||
      usage.totalTokens !== usage.inputTokens + usage.outputTokens ||
      usage.cachedInputTokens !== undefined && (!count(usage.cachedInputTokens) || usage.cachedInputTokens > usage.inputTokens) ||
      usage.reasoningOutputTokens !== undefined && (!count(usage.reasoningOutputTokens) || usage.reasoningOutputTokens > usage.outputTokens)) return;
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens,
    ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens as number }),
    ...(usage.reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens: usage.reasoningOutputTokens as number }) };
}

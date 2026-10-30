export const CODEX_FAILURE_CODES = [
  'contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'rateLimitExceeded', 'flexUnavailable',
  'serverOverloaded', 'cyberPolicy', 'misalignmentPolicyViolation', 'tooManyDenials', 'httpConnectionFailed',
  'responseStreamConnectionFailed', 'internalServerError', 'unauthorized', 'badRequest', 'threadRollbackFailed',
  'sandboxError', 'responseStreamDisconnected', 'responseTooManyFailedAttempts', 'activeTurnNotSteerable', 'other',
] as const;
export const CODEX_FAILURE_REASONS = [
  'account_concurrency_limit', 'upstream_request_failed', 'invalid_tool_call_arguments',
] as const;
export type MathAgentFailureReason = typeof CODEX_FAILURE_REASONS[number];
export type MathAgentFailureDiagnostic = Readonly<{
  code: typeof CODEX_FAILURE_CODES[number];
  httpStatusCode?: number;
  /** Safe, allowlisted category; provider messages and tool arguments are never copied here. */
  reason?: MathAgentFailureReason;
}>;
export const HTTP_FAILURE_CODES = new Set(['httpConnectionFailed', 'responseStreamConnectionFailed',
  'responseStreamDisconnected', 'responseTooManyFailedAttempts']);
const TRANSIENT_FAILURE_CODES = new Set([...HTTP_FAILURE_CODES, 'other', 'rateLimitExceeded',
  'flexUnavailable', 'serverOverloaded', 'internalServerError']);

/** Accept a status value, never digits extracted from provider text or URLs. */
export function safeHttpStatusCode(value: unknown): number | undefined {
  const status = typeof value === 'string' && /^[1-5][0-9]{2}$/u.test(value) ? Number(value) : value;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

// Some gateways expose actionable failures as the `other` wrapper or as a bare
// message with no structured cause. Keep native authentication, policy, budget
// and client failures authoritative, and persist only the matched category
// rather than raw provider text.
const FAILURE_REASON_PATTERNS: ReadonlyArray<readonly [MathAgentFailureReason, RegExp]> = [
  ['account_concurrency_limit',
    /concurrency limit exceeded for account|timeout waiting for account concurrency slot|account_slot_acquire_failed/iu],
  ['invalid_tool_call_arguments',
    /invalid tool call arguments from upstream|(?:tool|function) call\b[^\n]{0,240}\barguments (?:are|is) invalid JSON|(?:error parsing|failed to (?:parse|deserialize)) (?:function|tool) (?:call|arguments)/iu],
  ['upstream_request_failed', /stream disconnected before completion|upstream request failed|error sending request/iu],
];

/** Classify a transient failure by its bounded category, never by copying provider text. */
export function safeFailureReason(code: MathAgentFailureDiagnostic['code'] | undefined,
  httpStatusCode: number | undefined, message: string): MathAgentFailureReason | undefined {
  if (code && !TRANSIENT_FAILURE_CODES.has(code)) return undefined;
  if (httpStatusCode !== undefined && httpStatusCode !== 408 && httpStatusCode !== 429 && httpStatusCode < 500) return undefined;
  return FAILURE_REASON_PATTERNS.find(([, pattern]) => pattern.test(message))?.[0];
}

/** Copy only bounded provider metadata across event, archive and inspection boundaries. */
export function safeFailureDiagnostic(value: unknown): MathAgentFailureDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const diagnostic = value as Record<string, unknown>;
  const code = CODEX_FAILURE_CODES.find(candidate => candidate === diagnostic.code);
  if (!code) return undefined;
  const status = HTTP_FAILURE_CODES.has(code) ? safeHttpStatusCode(diagnostic.httpStatusCode) : undefined;
  const reason = CODEX_FAILURE_REASONS.find(candidate => candidate === diagnostic.reason);
  return { code, ...(status !== undefined ? { httpStatusCode: status } : {}), ...(reason ? { reason } : {}) };
}

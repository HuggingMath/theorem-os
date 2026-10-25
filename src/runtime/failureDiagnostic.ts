export const CODEX_FAILURE_CODES = [
  'contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'rateLimitExceeded', 'flexUnavailable',
  'serverOverloaded', 'cyberPolicy', 'misalignmentPolicyViolation', 'tooManyDenials', 'httpConnectionFailed',
  'responseStreamConnectionFailed', 'internalServerError', 'unauthorized', 'badRequest', 'threadRollbackFailed',
  'sandboxError', 'responseStreamDisconnected', 'responseTooManyFailedAttempts', 'activeTurnNotSteerable', 'other',
] as const;
export type MathAgentFailureDiagnostic = Readonly<{
  code: typeof CODEX_FAILURE_CODES[number];
  httpStatusCode?: number;
}>;
const HTTP_FAILURE_CODES = new Set(['httpConnectionFailed', 'responseStreamConnectionFailed',
  'responseStreamDisconnected', 'responseTooManyFailedAttempts']);

/** Accept a status value, never digits extracted from provider text or URLs. */
export function safeHttpStatusCode(value: unknown): number | undefined {
  const status = typeof value === 'string' && /^[1-5][0-9]{2}$/u.test(value) ? Number(value) : value;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

/** Copy only bounded provider metadata across event, archive and inspection boundaries. */
export function safeFailureDiagnostic(value: unknown): MathAgentFailureDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const diagnostic = value as Record<string, unknown>;
  const code = CODEX_FAILURE_CODES.find(candidate => candidate === diagnostic.code);
  if (!code) return undefined;
  const status = HTTP_FAILURE_CODES.has(code) ? safeHttpStatusCode(diagnostic.httpStatusCode) : undefined;
  return { code, ...(status !== undefined ? { httpStatusCode: status } : {}) };
}

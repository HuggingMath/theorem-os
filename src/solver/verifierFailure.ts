import { z } from 'zod';
import type { MathematicsVerifierBatchResult } from '../math/verifier';

const text = z.string().max(4096);
const context = {
  stage: z.string().min(1).max(128), taskId: text.optional(), taskDigest: text.optional(),
  sourceCommit: text.optional(), seedCommit: text.optional(), projectionMode: z.enum(['compact', 'full']).optional(),
  conditions: z.array(z.object({ taskId: text, taskDigest: text })).max(64).optional(),
};
const diagnosticSchema = z.object({
  schema: z.literal('theorem-os.verifier-failure.v1'), at: z.number().int().nonnegative(), ...context,
  verification: z.object({ status: text, targetCommit: text.optional(), sessionId: text.optional(),
    results: z.array(z.object({ status: text, theoremName: text.optional(), proofPath: text.optional(),
      receiptId: text.optional(), checkId: text.optional(), error: text.optional(), cleanupError: text.optional(),
      stdoutPreview: text.optional(), stderrPreview: text.optional() })).max(32),
  }).optional(),
  changes: z.record(z.boolean()).optional(),
  causes: z.array(z.object({ name: text, message: text, stack: text.optional() })).max(4),
});
export type VerifierFailureDiagnostic = z.infer<typeof diagnosticSchema>;
type FailureContext = z.infer<z.ZodObject<typeof context>> & {
  verification?: MathematicsVerifierBatchResult; changes?: Record<string, boolean>;
};

// Lean output is useful evidence, but it must not turn an exception into an environment dump.
function bounded(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.replace(/\bBearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/gu, '[redacted]')
    .replace(/((?:api[_-]?key|authorization|access[_-]?token|password)\s*[:=]\s*)\S+/giu, '$1[redacted]')
    .slice(0, 4096);
}

/** Diagnosis is advisory. It never supplies a proof receipt or changes acceptance. */
export class VerifierFailureError extends Error {
  readonly diagnostic: VerifierFailureDiagnostic;
  constructor(input: FailureContext, cause?: unknown, reason = 'math_verifier_unavailable') {
    super(reason, cause === undefined ? undefined : { cause });
    const causes: VerifierFailureDiagnostic['causes'] = [];
    const seen = new Set<unknown>();
    for (let error = cause; error !== undefined && causes.length < 4 && !seen.has(error);) {
      seen.add(error);
      causes.push({ name: bounded(error instanceof Error ? error.name : 'Error')!,
        message: bounded(error instanceof Error ? error.message : String(error))!,
        ...(error instanceof Error && error.stack ? { stack: bounded(error.stack) } : {}) });
      error = error instanceof Error ? error.cause : undefined;
    }
    const { verification, ...identity } = input;
    this.diagnostic = diagnosticSchema.parse({ schema: 'theorem-os.verifier-failure.v1', at: Date.now(),
      ...identity, causes, ...(verification ? { verification: {
        status: verification.status, targetCommit: bounded(verification.targetCommit), sessionId: bounded(verification.sessionId),
        results: verification.results.slice(0, 32).map(result => Object.fromEntries([
          ['status', result.status], ['theoremName', result.theoremName], ['proofPath', result.proofPath],
          ['receiptId', result.receiptId], ['checkId', result.checkId], ['error', result.error],
          ['cleanupError', result.cleanupError], ['stdoutPreview', result.stdoutPreview], ['stderrPreview', result.stderrPreview],
        ].flatMap(([key, value]) => value === undefined ? [] : [[key, bounded(value)]]))),
      } } : {}) });
  }
}

export function safeVerifierFailureDiagnostic(value: unknown): VerifierFailureDiagnostic | undefined {
  const result = diagnosticSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

/** Follow wrappers without copying arbitrary properties, environment variables or tool arguments. */
export function verifierFailureDiagnostic(error: unknown): VerifierFailureDiagnostic | undefined {
  const seen = new Set<unknown>();
  for (let current = error; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (current instanceof VerifierFailureError) return safeVerifierFailureDiagnostic(current.diagnostic);
  }
  return undefined;
}

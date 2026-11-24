export type PlanIssue = { path: string; message: string };

/** Keep the established Lead error text and provide fields for structured command output. */
export class PlanValidationError extends Error {
  constructor(readonly code: string, message: string, readonly issues: PlanIssue[]) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'PlanValidationError';
  }
}

export const invalidPlanField = (code: string, path: string, message: string) =>
  new PlanValidationError(code, message, [{ path, message }]);

export function planFieldPath(keys: readonly (string | number)[]): string {
  return keys.map((key, index) => typeof key === 'number' ? `[${key}]` : (index ? '.' : '') + key).join('');
}

export function planError(code: string, detail: Record<string, unknown>, hint = '') {
  const task = typeof detail.taskId === 'string' ? `tasks[${detail.taskId}]` : undefined;
  const group = typeof detail.index === 'number' && code.includes('group') ? `groups[${detail.index}]` : undefined;
  const field = typeof detail.field === 'string' ? detail.field : undefined;
  const path = [task ?? group, field].filter(Boolean).join('.') || '$';
  const message = JSON.stringify(detail) + (hint ? '. ' + hint : '');
  return new PlanValidationError(code, message, [{ path, message }]);
}

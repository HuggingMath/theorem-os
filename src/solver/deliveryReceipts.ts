import { z } from 'zod';
import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import { parseMathResponse } from './deliveries';
import { assignmentDeliveryFile, type TaskAssignment } from './tasks';

export const deliveryReceiptSchema = z.object({
  id: z.string(), submissionDigest: z.string(), workerId: z.string(),
  assignmentKey: z.string(), taskId: z.string(), taskDigest: z.string(),
  seedCommit: z.string(), environmentDigest: z.string(), createdAt: z.number().int().nonnegative(),
  status: z.enum(['needs-correction', 'recorded', 'superseded']),
  code: z.string(), issues: z.array(z.object({ path: z.string(), message: z.string() })),
  /** Verified link to an earlier rejected submission in this exact assignment. */
  replacesReceipt: z.string().optional(),
});
export type DeliveryReceipt = z.infer<typeof deliveryReceiptSchema>;

export function assignmentDeliveryReceipts(receipts: readonly DeliveryReceipt[] | undefined, assignment: TaskAssignment,
  environmentDigest: string | undefined, workerId = assignment.workerId): DeliveryReceipt[] {
  const assignmentKey = assignmentDeliveryFile(assignment);
  return (receipts ?? []).filter(receipt => receipt.workerId === workerId && receipt.assignmentKey === assignmentKey &&
    receipt.taskId === assignment.taskId && receipt.taskDigest === assignment.taskDigest &&
    receipt.seedCommit === assignment.seedCommit && receipt.environmentDigest === environmentDigest);
}

/** Protocol feedback is durable evidence about intake, never Lean acceptance. */
export function rejectedDeliveryReceipt(input: { assignment: TaskAssignment; workerId: string;
  environmentDigest: string; submission: string; error: Error; now: number;
  receipts?: readonly DeliveryReceipt[] }): DeliveryReceipt {
  const assignmentKey = assignmentDeliveryFile(input.assignment);
  const submissionDigest = mathDigest(input.submission);
  const details = input.error as Error & { issues?: readonly { path: string; message: string }[] };
  const code = input.error.message.split(/[\n:]/u, 1)[0];
  const issues = details.issues?.map(issue => ({ path: issue.path, message: issue.message })) ??
    [{ path: code === 'math_delivery_invalid_json' ? '$' : 'submission', message: input.error.message }];
  let replacement: unknown;
  try {
    const value = parseMathResponse(input.submission, 'math-result', {}, 'summary');
    replacement = value.kind === 'research' ? value.finding?.replacesReceipt : value.replacesReceipt;
  } catch { /* An unreadable submission cannot establish a correction link. */ }
  const prior = typeof replacement === 'string'
    ? assignmentDeliveryReceipts(input.receipts, input.assignment, input.environmentDigest, input.workerId)
      .find(receipt => receipt.id === replacement && receipt.status !== 'superseded')
    : undefined;
  return { id: mathDigest(canonicalMathJson({ assignmentKey, submissionDigest, code, issues })),
    submissionDigest, workerId: input.workerId, assignmentKey,
    taskId: input.assignment.taskId, taskDigest: input.assignment.taskDigest,
    seedCommit: input.assignment.seedCommit, environmentDigest: input.environmentDigest,
    createdAt: input.now, status: 'needs-correction', code, issues,
    ...(prior ? { replacesReceipt: prior.id } : {}) };
}

export function deliveryReceiptFeedback(receipt: DeliveryReceipt): string {
  const gapFeedback = receipt.issues.some(issue => issue.path.startsWith('mathematicalGap'))
    ? '\nSubmit the complete mathematicalGap object, keeping required consumer, previousGap, reduced, remaining, evidenceScope and reconsiderWhen fields. ' +
      'The consumer must be a visible kind:"goal" contract with its exact taskId and taskDigest from COOPERATION.json. ' +
      'Optional previousDeliveryId must come from COOPERATION.json mathematicalGaps[].deliveryId for that goal; an ordinary research delivery is not a scoped prior gap. ' +
      'If no such prior gap exists, omit only previousDeliveryId and keep the required previousGap description.' : '';
  return 'Host delivery receipt (intake feedback, not proof acceptance):\n' + JSON.stringify(receipt) +
    '\nCorrect the indicated fields and rerun research-observe. ' +
    'include replacesReceipt:' + JSON.stringify(receipt.id) + ' in the corrected finding to resolve this receipt. ' +
    'If that correction is rejected again, replace the new receipt; a recorded correction resolves its verified chain of earlier attempts. ' +
    'Do not repeat the rejected event or truncate the log. Read COOPERATION.json for current receipts.' + gapFeedback;
}

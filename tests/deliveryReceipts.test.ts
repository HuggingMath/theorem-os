import { describe, expect, it } from 'vitest';

import { deliveryReceiptFeedback, deliveryReceiptSchema, rejectedDeliveryReceipt, type DeliveryReceipt } from '../src/solver/deliveryReceipts';
import { assignmentDeliveryFile, taskVersion, type CooperativeAction, type CooperativeTask } from '../src/solver/tasks';

const task: CooperativeTask = { id: 'research', kind: 'research', objective: 'Resolve the exact gap', dependsOn: [], revision: 0 };
const action: Extract<CooperativeAction, { kind: 'task' }> = { kind: 'task', task, assignment: {
  taskId: task.id, taskDigest: taskVersion(task), workerId: 'writer', seedCommit: 'a'.repeat(40), assignmentId: 'dispatch',
} };
const reject = (submission: unknown, receipts: readonly DeliveryReceipt[] = []) => rejectedDeliveryReceipt({
  assignment: action.assignment, workerId: 'writer', environmentDigest: 'environment',
  submission: typeof submission === 'string' ? submission : JSON.stringify(submission), error: new Error('math_delivery_invalid'),
  now: receipts.length, receipts,
});

describe('delivery receipt correction chains', () => {
  it.each(['event', 'notes'] as const)('retains the explicit prior receipt on a rejected %s correction', kind => {
    const first = reject({ kind: 'research', finding: { summary: 'The initial rejected report' } });
    const finding = { summary: 'The incomplete correction', replacesReceipt: first.id };
    const submission = kind === 'event' ? JSON.stringify({ kind: 'research', finding }) :
      '```math-result\n' + JSON.stringify(finding) + '\n```';
    const second = reject(submission, [first]);
    expect(second.replacesReceipt).toBe(first.id);
    expect(deliveryReceiptSchema.parse(JSON.parse(JSON.stringify(second)))).toEqual(second);
    expect(first.status).toBe('needs-correction');
  });

  it.each(['workerId', 'assignmentKey', 'taskId', 'taskDigest', 'seedCommit', 'environmentDigest'] as const)(
    'does not link a receipt from another %s', field => {
      const first = { ...reject({ summary: 'Original rejection' }), [field]: 'other-scope' };
      const second = reject({ kind: 'research', finding: { summary: 'Correction', replacesReceipt: first.id } }, [first]);
      expect(second.replacesReceipt).toBeUndefined();
    });

  it('ignores unreadable correction references and superseded prior receipts', () => {
    const first = reject({ summary: 'Original rejection' });
    expect(reject('{"replacesReceipt":', [first]).replacesReceipt).toBeUndefined();
    expect(reject({ summary: 'Correction', replacesReceipt: first.id }, [{ ...first, status: 'superseded' }])
      .replacesReceipt).toBeUndefined();
  });

});

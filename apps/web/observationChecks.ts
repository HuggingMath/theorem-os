import type { WebCheckReceipt, WebObservation } from './collaboration';

/** Earlier frames copied each original-goal receipt onto every goal in its batch. */
export function projectStoredObservationChecks(observation: WebObservation): WebObservation {
  const targets = observation.inspection.problem?.targets ?? [];
  if (targets.length < 2 || observation.checks.length < 2) return observation;

  const targetByName = new Map(targets.map(target => [target.theoremName, target]));
  const taskKey = (id: string, version: string) => `${id}\0${version}`;
  const goalTargets = new Map(observation.inspection.tasks.filter(task => task.kind === 'goal' && task.theorem)
    .map(task => [taskKey(task.id, task.version), targetByName.get(task.theorem!)]));
  const assignedTarget = (check: WebCheckReceipt) => goalTargets.get(taskKey(check.taskId, check.taskVersion));
  const receiptKey = (check: WebCheckReceipt) =>
    `${check.id}\0${check.commit}\0${check.sourceDigest}\0${check.environmentDigest}`;

  const copied = new Set<string>();
  for (const check of observation.checks) {
    const assigned = assignedTarget(check), { theoremName, proofPath } = check.record;
    if (!assigned || typeof theoremName !== 'string' || theoremName === assigned.theoremName) continue;
    const checked = targetByName.get(theoremName);
    if (checked && checked.proofPath === proofPath) copied.add(receiptKey(check));
  }
  if (!copied.size) return observation;

  const checks = observation.checks.flatMap(check => {
    const target = assignedTarget(check);
    if (!target || !copied.has(receiptKey(check))) return [check];
    const { record } = check;
    if (record.theoremName !== target.theoremName || record.proofPath !== target.proofPath) return [];
    // The per-target verdict must bind to this frozen declaration and this exact commit.
    const passed = record.status === 'kernel_verified' && record.claim === 'statement' &&
      record.targetCommit === check.commit && Boolean(target.declarationHash) &&
      record.sourceDeclarationHash === target.declarationHash;
    if (typeof record.passed !== 'boolean') return [check];
    return [{ ...check, record: { ...record, originalProblemPassed: record.passed, passed: passed || record.passed } }];
  });
  return { ...observation, checks };
}

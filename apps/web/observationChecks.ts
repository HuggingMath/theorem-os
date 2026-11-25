import { canonicalMathJson } from '../../src/math/mathRuntimeIo';
import type { WebCheckReceipt, WebObservation } from './collaboration';

export function projectStoredObservationChecks(observation: WebObservation): WebObservation {
  const projected = projectOriginalProblemChecks(observation);
  // Task checks bind both statement hashes to the task revision. Older workers could also
  // publish them as whole-problem checks, storing the actual task verdict in the batch field.
  const isTaskCheck = ({ taskVersion, record }: WebCheckReceipt) =>
    record.statementHash === taskVersion && record.leanStatementHash === taskVersion;
  if (!projected.checks.some(check => isTaskCheck(check) && typeof check.record.originalProblemPassed === 'boolean')) return projected;

  const taskChecks = new Set<string>();
  const checks = projected.checks.flatMap(check => {
    if (!isTaskCheck(check)) return [check];
    const { originalProblemPassed, ...record } = check.record;
    const normalized = typeof originalProblemPassed === 'boolean' ?
      { ...check, record: { ...record, passed: originalProblemPassed } } : check;
    const key = canonicalMathJson(normalized);
    if (taskChecks.has(key)) return [];
    taskChecks.add(key);
    return [normalized];
  });
  return { ...projected, checks };
}

/** Earlier frames copied each original-goal receipt onto every goal in its batch. */
function projectOriginalProblemChecks(observation: WebObservation): WebObservation {
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

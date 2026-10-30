import type { SolverWorkerState } from './archive';
import { deliveryFinding, type DeliveryRecord } from './deliveries';
import type { TaskRecord } from './tasks';

/** What the previous Lead turn saw when it started; a continuation reports changes since then. */
export type LeadInboxBasis = { at: number; planVersion?: string; statuses: Record<string, TaskRecord['status']> };
export type LeadInbox = {
  since: number;
  planChanged: boolean;
  deliveries: { id: string; kind: DeliveryRecord['kind']; status: DeliveryRecord['status']; producer: string; taskId?: string;
    summary: string; needsDecision?: true; lemmaRequests?: number }[];
  omittedDeliveries: number;
  statusChanges: { taskId: string; from?: TaskRecord['status']; to?: TaskRecord['status'] }[];
  omittedStatusChanges: number;
  idleWorkers: { workerId: string; role: string; idleMs: number; stage?: string; candidateCount?: number;
    reasons?: Record<string, number> }[];
  /** Peers stopped since the basis; their reservations no longer bind live peers in this process. */
  stoppedWorkers?: { workerId: string; role: string; error?: string; releasedTaskIds: string[] }[];
};

const MAX_DELIVERIES = 16, MAX_STATUS_CHANGES = 32, SUMMARY_BYTES = 600;
/** A peer idle this long with no startable work, while others run, is owed one Lead turn. */
export const IDLE_PEER_WAKE_MS = 10 * 60_000;
// Wait stages meaning the accepted plan has nothing this peer can start; host gates and budgets are excluded.
export const NO_WORK_STAGES: ReadonlySet<string> = new Set(['m3-no-ready', 'dependency-blocked', 'm5-no-selection']);

/**
 * Peers that went idle after `seenAt` (the basis of the last deciding Lead turn, or an idle wake) and have had no
 * startable work for IDLE_PEER_WAKE_MS, counted from the later of their idle start and the Lead's own. A peer an
 * unanswered earlier wake already named (idle since `retry.at` or before) is due no earlier than `retry.notBefore`.
 * `dueAt` is the earliest time a not-yet-due peer qualifies.
 */
export function idlePeersAwaitingLead(workers: readonly SolverWorkerState[], leadId: string, seenAt: number, now = Date.now(),
  retry?: { at: number; notBefore: number }) {
  const lead = workers.find(worker => worker.id === leadId)?.scheduling;
  const leadIdleSince = lead?.status === 'idle' ? lead.since : now;
  const due: string[] = [];
  let dueAt: number | undefined;
  for (const worker of workers) {
    const scheduling = worker.scheduling, wait = scheduling?.wait;
    if (worker.id === leadId || scheduling?.status !== 'idle' || scheduling.since <= seenAt ||
        !wait || wait.endedAt !== undefined || !NO_WORK_STAGES.has(wait.stage)) continue;
    const at = Math.max(Math.max(scheduling.since, leadIdleSince) + IDLE_PEER_WAKE_MS,
      retry && scheduling.since <= retry.at ? retry.notBefore : 0);
    if (at <= now) due.push(worker.id);
    else dueAt = Math.min(dueAt ?? at, at);
  }
  return { due, dueAt };
}
const needsDecision = (record: DeliveryRecord) => {
  try { const finding = JSON.parse(deliveryFinding(record) ?? 'null'); return finding?.needsDecision === true || finding?.conclusion === 'refuted'; }
  catch { return false; }
};

export const leadInboxBasis = (tasks: readonly TaskRecord[], planVersion: string | undefined, at = Date.now()): LeadInboxBasis =>
  ({ at, planVersion, statuses: Object.fromEntries(tasks.map(node => [node.task.id, node.status])) });

/** A bounded index into COOPERATION.json; complete records remain there, and nothing here is proof acceptance. */
export function leadInbox(basis: LeadInboxBasis | undefined, input: { tasks: readonly TaskRecord[]; planVersion?: string;
  deliveries?: readonly DeliveryRecord[]; leadId: string; workers?: readonly SolverWorkerState[];
  roles: ReadonlyMap<string, string>; now?: number }): LeadInbox | undefined {
  if (!basis) return;
  const now = input.now ?? Date.now();
  const fresh = (input.deliveries ?? []).filter(record => record.createdAt >= basis.at &&
    record.status !== 'superseded' && record.producer !== input.leadId);
  const current = new Map(input.tasks.map(node => [node.task.id, node.status]));
  const changes = [...new Set([...Object.keys(basis.statuses), ...current.keys()])]
    .filter(id => basis.statuses[id] !== current.get(id))
    .map(taskId => ({ taskId, from: basis.statuses[taskId], to: current.get(taskId) }));
  const idleWorkers = (input.workers ?? []).filter(worker => worker.id !== input.leadId && worker.scheduling?.status === 'idle')
    .map(worker => {
      const wait = worker.scheduling!.wait?.endedAt === undefined ? worker.scheduling!.wait : undefined;
      const reasons: Record<string, number> = {};
      for (const candidate of wait?.candidates ?? []) reasons[candidate.reason] = (reasons[candidate.reason] ?? 0) + 1;
      return { workerId: worker.id, role: input.roles.get(worker.id) ?? 'unknown', idleMs: Math.max(0, now - worker.scheduling!.since),
        ...(wait ? { stage: wait.stage, candidateCount: wait.candidateCount, ...(Object.keys(reasons).length ? { reasons } : {}) } : {}) };
    });
  const stoppedWorkers = (input.workers ?? []).filter(worker => worker.id !== input.leadId &&
    worker.scheduling?.status === 'stopped' && worker.scheduling.since >= basis.at).map(worker => ({
    workerId: worker.id, role: input.roles.get(worker.id) ?? 'unknown', ...(worker.error ? { error: worker.error } : {}),
    releasedTaskIds: input.tasks.filter(node => !['integrated', 'completed'].includes(node.status) && !node.capacityExploration &&
      (node.task.ownerId === worker.id || node.assignment?.workerId === worker.id)).map(node => node.task.id).slice(0, 32) }));
  return {
    since: basis.at, planChanged: basis.planVersion !== input.planVersion,
    deliveries: fresh.slice(-MAX_DELIVERIES).map(record => ({ id: record.id, kind: record.kind, status: record.status,
      producer: record.producer, ...(record.taskId ? { taskId: record.taskId } : {}),
      summary: Buffer.byteLength(record.summary) > SUMMARY_BYTES
        ? Buffer.from(record.summary).subarray(0, SUMMARY_BYTES).toString('utf8').replace(/�$/u, '') + '…' : record.summary,
      ...(record.kind === 'research' && needsDecision(record) ? { needsDecision: true as const } : {}),
      ...(record.lemmaRequests?.length ? { lemmaRequests: record.lemmaRequests.length } : {}) })),
    omittedDeliveries: Math.max(0, fresh.length - MAX_DELIVERIES),
    statusChanges: changes.slice(0, MAX_STATUS_CHANGES), omittedStatusChanges: Math.max(0, changes.length - MAX_STATUS_CHANGES),
    idleWorkers,
    ...(stoppedWorkers.length ? { stoppedWorkers } : {}),
  };
}

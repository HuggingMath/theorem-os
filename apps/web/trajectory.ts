import type { WebCheckReceipt, WebDelivery, WebGuidanceRecord, WebHumanEdit, WebObservation, WebPlanTask, WebProofRoute, WebTaskSource } from './collaboration';
import type { WebEvent } from './shared';

/**
 * The run's mathematical trajectory, kept apart from the 200-event activity log: milestone events, every checked proof
 * version, plan revisions and the human and Agent records around them. Read incrementally from the immutable event and
 * observation files, so a long run is folded once and each poll only reads what is new.
 */
export const trajectorySchema = 'theorem-os.web-trajectory.v1';

/** Events that mark a mathematical step; heartbeats, context bookkeeping and module notices stay in the activity log. */
export const trajectoryEventTypes = new Set([
  'ready', 'solve_started', 'preparation_failed', 'source_rejected',
  'plan_updated', 'plan_published', 'initial_plan_published', 'initial_plan_fallback',
  'plan_rejected', 'initial_plan_rejected', 'plan_publication_rejected',
  'plan_approval_requested', 'plan_approved', 'plan_approval_unanswered',
  'task_assigned', 'task_checked', 'task_check_reused', 'task_failure_check_reused', 'task_integrated',
  'task_recheck_finished', 'task_conditional_recheck_finished', 'task_recheck_dependency_invalidated',
  'assembly_started', 'proof_checked', 'evaluation_started', 'evaluation_finished',
  'review_assigned', 'review_completed',
  'route_parked', 'routes_idle', 'plan_stalled', 'goal_path_stalled', 'task_mathematical_gap_blocked', 'task_repeated_input_blocked',
  'worker_failed', 'model_budget_stopped', 'planning_budget_stopped',
  'error', 'cancelled', 'interrupted',
]);

export const trajectoryLimits = {
  events: 10_000, versions: 4_000, checks: 100, receipts: 200, plans: 300, planItems: 200,
  deliveries: 1_000, guidance: 300, edits: 300, workers: 64, targets: 200,
} as const;
const textLimits = { guidance: 2_000, headline: 160 } as const;
const readLimits = { events: 5_000, observations: 40 } as const;

/** One Lean check of a task version. An original-problem check separately records the outcome of the whole batch. */
export type TrajectoryCheck = { at: number; passed: boolean; status: string; receiptIds: string[]; theorems: string[]; headline?: string; observation: number;
  originalProblemPassed?: boolean };
/** A task's code at one commit, with every recorded check of it. */
export type TrajectoryVersion = {
  key: string; taskId: string; commit: string; file?: string; source?: number; firstAt: number; checks: TrajectoryCheck[]; revision: number;
};
export type TrajectoryPlanItem = { id: string; kind: WebPlanTask['kind']; name?: string; objective: string; dependsOn: string[]; status?: string;
  revision?: number; taskDigest?: string; proofPath?: string; type?: string; premises?: readonly string[];
  informalStatement?: string; informalProof?: string; citations?: readonly string[]; consumerGoalIds?: readonly string[]; groupId?: string };
/** A plan as first observed, then each observed change; `previousAt` and `at` bracket when the change happened. */
export type TrajectoryPlan = {
  observation: number; at: number; previousAt?: number; added: TrajectoryPlanItem[];
  changed: { before: TrajectoryPlanItem; after: TrajectoryPlanItem }[]; removed: TrajectoryPlanItem[]; omitted: number; revision: number;
  proofRoutes?: WebProofRoute[];
};
export type TrajectoryDelivery = Pick<WebDelivery, 'id' | 'kind' | 'status' | 'producer' | 'taskId' | 'commit' | 'createdAt' | 'summary' | 'finding'> &
  Partial<Pick<WebDelivery, 'taskDigest' | 'sourceDigest' | 'statement' | 'premises' | 'dependencies' | 'remainingObligations' |
  'evidenceRefs' | 'evidence' | 'actualReferences'>> & { revision: number };
export type TrajectoryGuidance = Pick<WebGuidanceRecord, 'id' | 'recipient' | 'taskRef' | 'text' | 'status' | 'createdAt' | 'updatedAt' | 'deliveredTo'> & { revision: number };
/** The edit receipt's own recheck list is not kept: it reports each task's latest state, not what the edit rechecked. */
export type TrajectoryEdit = Pick<WebHumanEdit, 'id' | 'status' | 'receivedAt' | 'appliedAt' | 'affectedTasks'> & { revision: number };
export type TrajectoryContext = { workers: { id: string; role: string }[]; targets: string[] };

export type TrajectoryIndex = {
  instance: string; revision: number; eventCursor: number; observationCursor: number; lastObservedAt?: number;
  events: WebEvent[]; versions: Map<string, TrajectoryVersion>; sources: Map<string, { file: string; observation: number }>;
  plans: TrajectoryPlan[]; plan?: Map<string, TrajectoryPlanItem>; planVersion?: string;
  deliveries: Map<string, TrajectoryDelivery>; guidance: Map<string, TrajectoryGuidance>; edits: Map<string, TrajectoryEdit>;
  workers: Map<string, string>; targets: string[]; contextRevision: number;
  /** Records dropped by a limit; they are not re-added when later observations repeat them. */
  retired: Set<string>;
  dropped: { events: number; versions: number; plans: number; deliveries: number; guidance: number; edits: number };
};

let instances = 0;
const started = Date.now().toString(36);
export function createTrajectoryIndex(): TrajectoryIndex {
  return { instance: `${started}-${++instances}`, revision: 0, eventCursor: 0, observationCursor: 0, events: [], versions: new Map(), sources: new Map(),
    plans: [], deliveries: new Map(), guidance: new Map(), edits: new Map(), workers: new Map(), targets: [], contextRevision: 0, retired: new Set(),
    dropped: { events: 0, versions: 0, plans: 0, deliveries: 0, guidance: 0, edits: 0 } };
}

const clip = (value: string | undefined, limit: number) => value === undefined ? undefined : value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
const millis = (value: string | number | undefined) => typeof value === 'number' ? value : value === undefined ? NaN : Date.parse(value);
const versionKey = (taskId: string, commit: string) => `${taskId}\u0000${commit}`;
/** Drops the oldest entries over the limit, remembering them so a repeated record is not added again. */
function trim<T>(index: TrajectoryIndex, section: keyof TrajectoryIndex['dropped'], items: Map<string, T>, limit: number) {
  for (const key of items.keys()) {
    if (items.size <= limit) break;
    items.delete(key); index.retired.add(`${section}:${key}`); index.dropped[section]++;
  }
}
const retired = (index: TrajectoryIndex, section: keyof TrajectoryIndex['dropped'], key: string) => index.retired.has(`${section}:${key}`);

/** The first Lean error line of a failed receipt, without the file location, as a one-line reason. */
export function checkHeadline(record: Record<string, unknown>): string | undefined {
  for (const field of ['stdoutPreview', 'stderrPreview']) {
    const text = record[field];
    if (typeof text !== 'string') continue;
    const line = /^(?:[^\n]*?:\d+:\d+:\s*)?error(?:\([^\n)]*\))?:\s*([^\n]+)/mu.exec(text);
    // "The rfl tactic failed. Possible reasons:" reads as its first sentence; the list it introduces stays in the output.
    const first = line?.[1]?.trim(), sentence = first && /^(.+?[.!?])\s+[^.!?]*:$/u.exec(first)?.[1];
    if (first) return clip(sentence || first, textLimits.headline);
  }
  return typeof record.error === 'string' && record.error.trim() ? clip(record.error.trim().split('\n', 1)[0], textLimits.headline) : undefined;
}

function foldEvents(index: TrajectoryIndex, events: readonly WebEvent[]) {
  for (const event of events) {
    if (event.sequence <= index.eventCursor) continue;
    index.eventCursor = event.sequence;
    if (!trajectoryEventTypes.has(event.type)) continue;
    index.events.push(event);
    if (index.events.length > trajectoryLimits.events) { index.events.shift(); index.dropped.events++; }
  }
}

function foldSource(index: TrajectoryIndex, source: WebTaskSource, observation: number) {
  const key = versionKey(source.taskId, source.commit);
  const version = index.versions.get(key);
  if (version) {
    if (version.source === undefined) { version.source = observation; version.file = source.file; version.revision = index.revision; }
    return;
  }
  if (index.sources.has(key) || retired(index, 'versions', key)) return;
  index.sources.set(key, { file: source.file, observation });
  // Sources wait here until a check names them; the map is bounded like the versions it feeds.
  for (const old of index.sources.keys()) { if (index.sources.size <= trajectoryLimits.versions) break; index.sources.delete(old); }
}

function foldCheck(index: TrajectoryIndex, receipt: WebCheckReceipt, observation: number, observedAt: number) {
  const key = versionKey(receipt.taskId, receipt.commit);
  if (retired(index, 'versions', key)) return;
  const record = receipt.record ?? {}, verification = record.verification as { checkedAt?: unknown } | undefined;
  const recorded = millis(verification?.checkedAt as number | undefined) || millis(record.checkedAt as number | undefined);
  const at = Number.isFinite(recorded) ? recorded : observedAt;
  let version = index.versions.get(key);
  if (!version) {
    const pending = index.sources.get(key);
    index.sources.delete(key);
    version = { key, taskId: receipt.taskId, commit: receipt.commit, ...(pending ? { file: pending.file, source: pending.observation } : {}),
      firstAt: at, checks: [], revision: index.revision };
    index.versions.set(key, version);
    trim(index, 'versions', index.versions, trajectoryLimits.versions);
    if (!index.versions.has(key)) return;
  }
  const originalProblemPassed = typeof record.originalProblemPassed === 'boolean' ? record.originalProblemPassed : undefined;
  let check = version.checks.find(item => item.at === at && item.originalProblemPassed === originalProblemPassed);
  if (check?.receiptIds.includes(receipt.id)) return;
  if (!check) {
    if (version.checks.length >= trajectoryLimits.checks) version.checks.splice(1, 1); // The first check stays: it is the attempt itself.
    check = { at, passed: true, status: 'kernel_verified', receiptIds: [], theorems: [], observation,
      ...(originalProblemPassed === undefined ? {} : { originalProblemPassed }) };
    version.checks.push(check);
    version.checks.sort((a, b) => a.at - b.at);
    version.firstAt = Math.min(version.firstAt, at);
  }
  if (check.receiptIds.length >= trajectoryLimits.receipts) return;
  check.receiptIds.push(receipt.id);
  const theorem = typeof record.theoremName === 'string' ? record.theoremName : undefined;
  if (theorem && !check.theorems.includes(theorem)) check.theorems.push(theorem);
  if (record.passed !== true && check.passed) {
    check.passed = false;
    check.status = typeof record.status === 'string' ? record.status : 'failed';
    const headline = checkHeadline(record);
    if (headline) check.headline = headline;
  }
  version.revision = index.revision;
}

const planItem = (task: WebPlanTask, taskDigest?: string): TrajectoryPlanItem => ({ id: task.id, kind: task.kind, ...(task.theoremName ? { name: task.theoremName } : {}),
  objective: task.objective, dependsOn: [...task.dependsOn], ...(task.status ? { status: task.status } : {}),
  revision: task.revision, ...(taskDigest ? { taskDigest } : {}),
  ...Object.fromEntries((['proofPath', 'type', 'premises', 'informalStatement', 'informalProof', 'citations', 'consumerGoalIds', 'groupId'] as const)
    .filter(key => task[key] !== undefined).map(key => [key, task[key]])) });
const samePlanItem = (a: TrajectoryPlanItem, b: TrajectoryPlanItem) => {
  // A revision bump alone schedules revalidation; it does not change the displayed mathematical plan.
  const { revision: _aRevision, taskDigest: _aDigest, ...before } = a;
  const { revision: _bRevision, taskDigest: _bDigest, ...after } = b;
  return JSON.stringify(before) === JSON.stringify(after);
};

function foldPlan(index: TrajectoryIndex, observation: WebObservation, at: number) {
  const tasks = observation.plan?.tasks;
  if (!tasks) return;
  const planVersion = observation.inspection.planVersion;
  if (planVersion && planVersion === index.planVersion && index.plan) return;
  const versions = new Map(observation.inspection.tasks.map(task => [task.id, task.version]));
  const next = new Map(tasks.map(task => [task.id, planItem(task, versions.get(task.id))]));
  const previous = index.plan;
  const added: TrajectoryPlanItem[] = [], changed: TrajectoryPlan['changed'] = [], removed: TrajectoryPlanItem[] = [];
  let omitted = 0;
  const keep = <T>(list: T[], item: T) => { if (list.length < trajectoryLimits.planItems) list.push(item); else omitted++; };
  for (const [id, item] of next) {
    const before = previous?.get(id);
    if (!before) keep(added, item);
    else if (!samePlanItem(before, item)) keep(changed, { before, after: item });
  }
  for (const [id, item] of previous ?? []) if (!next.has(id)) keep(removed, item);
  index.plan = next; index.planVersion = planVersion;
  const proofRoutes = observation.plan?.proofRoutes ?? [];
  if (!added.length && !changed.length && !removed.length && JSON.stringify(index.plans.at(-1)?.proofRoutes ?? []) === JSON.stringify(proofRoutes)) return;
  index.plans.push({ observation: observation.sequence, at, ...(index.lastObservedAt !== undefined ? { previousAt: index.lastObservedAt } : {}),
    added, changed, removed, omitted, revision: index.revision, ...(proofRoutes.length ? { proofRoutes } : {}) });
  // The first plan stays, so later revisions always read against it.
  if (index.plans.length > trajectoryLimits.plans) { index.plans.splice(1, 1); index.dropped.plans++; }
}

function foldDelivery(index: TrajectoryIndex, delivery: WebDelivery) {
  const previous = index.deliveries.get(delivery.id);
  if (!previous && retired(index, 'deliveries', delivery.id)) return;
  const next: TrajectoryDelivery = { id: delivery.id, kind: delivery.kind, status: delivery.status, producer: delivery.producer,
    ...(delivery.taskId ? { taskId: delivery.taskId } : {}), ...(delivery.commit ? { commit: delivery.commit } : {}), createdAt: delivery.createdAt,
    summary: delivery.summary, ...(delivery.finding ? { finding: delivery.finding } : {}),
    ...Object.fromEntries((['taskDigest', 'sourceDigest', 'statement', 'premises', 'dependencies', 'remainingObligations',
      'evidenceRefs', 'evidence', 'actualReferences'] as const).filter(key => delivery[key] !== undefined).map(key => [key, delivery[key]])),
    revision: index.revision };
  if (previous && JSON.stringify({ ...previous, revision: 0 }) === JSON.stringify({ ...next, revision: 0 })) return;
  index.deliveries.set(delivery.id, next);
  trim(index, 'deliveries', index.deliveries, trajectoryLimits.deliveries);
}

function foldGuidance(index: TrajectoryIndex, guidance: WebGuidanceRecord) {
  const previous = index.guidance.get(guidance.id);
  if (previous ? previous.status === guidance.status && previous.updatedAt === guidance.updatedAt : retired(index, 'guidance', guidance.id)) return;
  index.guidance.set(guidance.id, { id: guidance.id, recipient: guidance.recipient, ...(guidance.taskRef ? { taskRef: guidance.taskRef } : {}),
    text: clip(guidance.text, textLimits.guidance) ?? '', status: guidance.status, createdAt: guidance.createdAt, updatedAt: guidance.updatedAt,
    ...(guidance.deliveredTo ? { deliveredTo: guidance.deliveredTo.slice(0, 16) } : {}), revision: index.revision });
  trim(index, 'guidance', index.guidance, trajectoryLimits.guidance);
}

function foldEdit(index: TrajectoryIndex, edit: WebHumanEdit) {
  const next: Omit<TrajectoryEdit, 'revision'> = { id: edit.id, status: edit.status, ...(edit.receivedAt !== undefined ? { receivedAt: edit.receivedAt } : {}),
    ...(edit.appliedAt !== undefined ? { appliedAt: edit.appliedAt } : {}), ...(edit.affectedTasks ? { affectedTasks: edit.affectedTasks.slice(0, 64) } : {}) };
  const previous = index.edits.get(edit.id);
  if (previous ? JSON.stringify({ ...previous, revision: 0 }) === JSON.stringify({ ...next, revision: 0 }) : retired(index, 'edits', edit.id)) return;
  index.edits.set(edit.id, { ...next, revision: index.revision });
  trim(index, 'edits', index.edits, trajectoryLimits.edits);
}

function foldContext(index: TrajectoryIndex, observation: WebObservation) {
  let changed = false;
  for (const worker of observation.inspection.workers ?? []) {
    if (index.workers.get(worker.id) === worker.role || index.workers.size >= trajectoryLimits.workers && !index.workers.has(worker.id)) continue;
    index.workers.set(worker.id, worker.role); changed = true;
  }
  const targets = (observation.inspection.problem?.targets ?? []).slice(0, trajectoryLimits.targets).map(target => target.theoremName);
  if (targets.length && targets.join('\n') !== index.targets.join('\n')) { index.targets = targets; changed = true; }
  if (changed) index.contextRevision = index.revision;
}

/** Folds new events and observations in sequence order; anything at or before the cursors is ignored. */
export function extendTrajectory(index: TrajectoryIndex, events: readonly WebEvent[], observations: readonly WebObservation[]) {
  foldEvents(index, events);
  for (const observation of observations) {
    if (observation.sequence <= index.observationCursor) continue;
    index.observationCursor = observation.sequence;
    index.revision++;
    const parsed = Date.parse(observation.observedAt);
    const at = Number.isFinite(parsed) ? parsed : index.lastObservedAt ?? 0;
    for (const source of observation.sources ?? []) foldSource(index, source, observation.sequence);
    for (const check of observation.checks ?? []) foldCheck(index, check, observation.sequence, at);
    foldPlan(index, observation, at);
    for (const delivery of observation.deliveries ?? []) foldDelivery(index, delivery);
    for (const guidance of observation.guidance ?? []) foldGuidance(index, guidance);
    for (const edit of observation.inspection.edits ?? []) foldEdit(index, edit);
    foldContext(index, observation);
    index.lastObservedAt = at;
  }
}

/**
 * What a client is missing: milestone events after `after`, and versions, plans and records changed after revision
 * `since`. A different instance (a restart, or an index rebuilt after eviction) means the client starts over.
 */
export type TrajectoryPage = {
  schema: typeof trajectorySchema; instance: string; revision: number; cursor: number; more: boolean;
  events: WebEvent[]; versions: TrajectoryVersion[]; plans: TrajectoryPlan[];
  deliveries: TrajectoryDelivery[]; guidance: TrajectoryGuidance[]; edits: TrajectoryEdit[];
  context?: TrajectoryContext; dropped: TrajectoryIndex['dropped'];
};
export type TrajectoryQuery = { after: number; since: number; instance?: string };

export function trajectoryPage(index: TrajectoryIndex, query: TrajectoryQuery, behind = false, limit = readLimits.events): TrajectoryPage {
  const fresh = query.instance !== index.instance;
  const after = fresh ? 0 : query.after, since = fresh ? 0 : query.since;
  let start = 0, end = index.events.length;
  while (start < end) { const middle = (start + end) >> 1; if (index.events[middle]!.sequence <= after) start = middle + 1; else end = middle; }
  const events = index.events.slice(start, start + limit);
  const more = start + limit < index.events.length;
  const changed = <T extends { revision: number }>(items: Iterable<T>) => [...items].filter(item => item.revision > since);
  return { schema: trajectorySchema, instance: index.instance, revision: index.revision,
    cursor: more ? events.at(-1)!.sequence : Math.max(after, index.eventCursor), more: more || behind,
    events, versions: changed(index.versions.values()), plans: changed(index.plans),
    deliveries: changed(index.deliveries.values()), guidance: changed(index.guidance.values()), edits: changed(index.edits.values()),
    ...(fresh || index.contextRevision > since ? { context: { workers: [...index.workers].map(([id, role]) => ({ id, role })), targets: index.targets } } : {}),
    dropped: index.dropped };
}

/** One version's saved file and receipts, read only from the observations the index recorded for it. */
export type TrajectoryVersionDetail = { taskId: string; commit: string; source?: WebTaskSource; checks: WebCheckReceipt[] };
export function trajectoryVersionDetail(version: TrajectoryVersion, observation: (sequence: number) => WebObservation | undefined): TrajectoryVersionDetail {
  const sequences = [...new Set([...(version.source !== undefined ? [version.source] : []), ...version.checks.map(check => check.observation)])];
  const receipts = new Set(version.checks.flatMap(check => check.receiptIds));
  let source: WebTaskSource | undefined;
  const checks = new Map<string, WebCheckReceipt>();
  for (const sequence of sequences) {
    const item = observation(sequence);
    if (!item) continue;
    source ??= item.sources.find(entry => entry.taskId === version.taskId && entry.commit === version.commit);
    for (const check of item.checks) if (check.taskId === version.taskId && check.commit === version.commit && receipts.has(check.id) && !checks.has(check.id)) checks.set(check.id, check);
  }
  return { taskId: version.taskId, commit: version.commit, ...(source ? { source } : {}), checks: [...checks.values()].slice(-64) };
}

/** Query parameters of the trajectory routes; undefined means the request is malformed. */
export function trajectoryQuery(params: URLSearchParams): TrajectoryQuery | undefined {
  const after = Number(params.get('after') ?? 0), since = Number(params.get('since') ?? 0), instance = params.get('instance') ?? undefined;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(since) || since < 0) return;
  if (instance !== undefined && !/^[a-z0-9-]{1,64}$/u.test(instance)) return;
  return { after, since, ...(instance ? { instance } : {}) };
}
export function trajectoryVersionQuery(params: URLSearchParams): { taskId: string; commit: string } | undefined {
  const taskId = params.get('task') ?? '', commit = params.get('commit') ?? '';
  return taskId && taskId.length <= 200 && /^[A-Za-z0-9]{1,128}$/u.test(commit) ? { taskId, commit } : undefined;
}
export const trajectoryVersion = (index: TrajectoryIndex, taskId: string, commit: string) => index.versions.get(versionKey(taskId, commit));

/** The index of a fixed recording, such as the sample run. */
export function recordedTrajectory(events: readonly WebEvent[], observations: readonly WebObservation[]) {
  const index = createTrajectoryIndex();
  extendTrajectory(index, events, [...observations].sort((a, b) => a.sequence - b.sequence));
  return index;
}

export type TrajectoryReader = {
  listEventsAfter(owner: string, runId: string, after: number, limit: number): WebEvent[];
  listObservationsAfter(owner: string, runId: string, after: number, limit: number): WebObservation[];
  getObservation(owner: string, runId: string, sequence: number): WebObservation | undefined;
};

/**
 * Indexes of recently read runs, keyed by owner and run. Each read folds at most one bounded chunk of new files, so
 * opening a long run never blocks the server; the page says `more` until the index has caught up.
 */
export class WebTrajectories {
  private readonly indexes = new Map<string, TrajectoryIndex>();
  constructor(private readonly reader: TrajectoryReader, private readonly limit = 32) {}

  page(owner: string, runId: string, query: TrajectoryQuery): TrajectoryPage {
    const { index, behind } = this.read(owner, runId);
    return trajectoryPage(index, query, behind);
  }
  version(owner: string, runId: string, taskId: string, commit: string): TrajectoryVersionDetail | undefined {
    let read = this.read(owner, runId);
    // A rebuilt index catches up before answering, a bounded number of chunks at a time.
    for (let chunk = 0; read.behind && !trajectoryVersion(read.index, taskId, commit) && chunk < 50; chunk++) read = this.read(owner, runId);
    const version = trajectoryVersion(read.index, taskId, commit);
    return version && trajectoryVersionDetail(version, sequence => this.reader.getObservation(owner, runId, sequence));
  }
  forget(owner: string, runId: string) { this.indexes.delete(`${owner}\u0000${runId}`); }
  forgetOwner(owner: string) { for (const key of [...this.indexes.keys()]) if (key.startsWith(`${owner}\u0000`)) this.indexes.delete(key); }

  private read(owner: string, runId: string) {
    const key = `${owner}\u0000${runId}`;
    const index = this.indexes.get(key) ?? createTrajectoryIndex();
    this.indexes.delete(key); this.indexes.set(key, index);
    for (const old of this.indexes.keys()) { if (this.indexes.size <= this.limit) break; this.indexes.delete(old); }
    const events = this.reader.listEventsAfter(owner, runId, index.eventCursor, readLimits.events);
    const observations = this.reader.listObservationsAfter(owner, runId, index.observationCursor, readLimits.observations);
    extendTrajectory(index, events, observations);
    return { index, behind: events.length >= readLimits.events || observations.length >= readLimits.observations };
  }
}

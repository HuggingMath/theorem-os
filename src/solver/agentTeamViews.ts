import type { SolverRunState } from './archive';
import type { AgentTeamState, AgentTeamTask, AgentTeamWorker } from './agentTeamState';
import { projectAgentTeamBudget } from './agentTeamBudget';
import { buildTokenBudget } from './usageBudget';

const WORKERS = 4, TASKS = 4, REFERENCES = 8, EVENTS = 8;
const TASK_TEXT = 600, EVENT_TEXT = 800, RESEARCH_TEXT = 2000;
const HISTORY_BYTES = 256 * 1024;

type Activity = NonNullable<AgentTeamWorker['activity']>;

function preview(value: string, limit: number) {
  let index = 0, count = 0;
  for (const character of value) {
    if (count++ === limit) return { text: value.slice(0, index), truncated: true };
    index += character.length;
  }
  return { text: value, truncated: false };
}

function taskProjection(task: AgentTeamTask, historyOffset: number, full = false) {
  const textTruncated: string[] = [];
  const field = (name: string, value?: string) => {
    if (value === undefined) return undefined;
    const result = full ? { text: value, truncated: false } : preview(value, TASK_TEXT);
    if (result.truncated) textTruncated.push(name);
    return result.text;
  };
  const result = {
    id: task.id, sequence: task.sequence, historyOffset, status: task.status,
    objectiveRevision: task.objectiveRevision ?? 1, workKind: task.workKind,
    ...(task.routeId ? { routeId: task.routeId } : {}),
    profileEvidence: full ? task.profileEvidence : task.profileEvidence && {
      skillDigest: task.profileEvidence.skillDigest, selected: task.profileEvidence.selected,
      loaded: task.profileEvidence.loaded, unresolved: task.profileEvidence.unresolved,
      sourceCount: task.profileEvidence.sources.length },
    objectiveHistory: full ? task.objectiveHistory : undefined,
    objectiveHistoryCount: task.objectiveHistory?.length ?? 0,
    progress: (full ? task.progress : task.progress?.slice(-1))?.map(item => ({ ...item,
      summary: field('progress.summary', item.summary), nextStep: field('progress.nextStep', item.nextStep),
      knowledgeUses: full ? item.knowledgeUses : undefined, evidenceRefs: full ? item.evidenceRefs : undefined })),
    progressCount: task.progress?.length ?? 0,
    objective: field('objective', task.message), summary: field('summary', task.summary), error: field('error', task.error),
    createdAt: task.createdAt, startedAt: task.startedAt, lastStartedAt: task.lastStartedAt,
    pausedAt: task.pausedAt, finishedAt: task.finishedAt, turns: task.turns,
    budget: task.budget, seedCommit: task.seedCommit, sourceCommit: task.sourceCommit,
    researchArtifactId: task.researchArtifactId, deliveryId: task.deliveryId,
    failedCheck: full ? task.failedCheck : task.failedCheck && {
      file: task.failedCheck.declaration.file, name: task.failedCheck.declaration.name, commit: task.failedCheck.commit,
    },
    declarationCount: task.declarations?.length,
    cancelRequested: task.cancelRequested && { ...task.cancelRequested,
      reason: field('cancelRequested.reason', task.cancelRequested.reason) },
    pauseRequested: task.pauseRequested && { ...task.pauseRequested,
      reason: field('pauseRequested.reason', task.pauseRequested.reason) },
  };
  return { ...result, ...(textTruncated.length ? { textTruncated } : {}) };
}

function activity(worker: AgentTeamWorker, current: AgentTeamTask | undefined, integrating: boolean): Activity {
  if (worker.writerStopUnconfirmed) return 'stopping';
  if (worker.activity) return worker.activity;
  if (current?.cancelRequested || current?.pauseRequested) return 'stopping';
  if (worker.pendingDelivery || worker.phase === 'checking') return 'checking';
  if (integrating) return 'integrating';
  if (worker.status === 'preparing') return 'preparing';
  if (worker.status === 'running') return 'running';
  if (worker.status === 'paused' || worker.tasks.at(-1)?.status === 'paused') return 'paused';
  return 'idle';
}

function taskBudget(state: Readonly<SolverRunState>, worker: AgentTeamWorker, task: AgentTeamTask) {
  const unavailable = Boolean(worker.requestUsageAccounting?.receipts?.some(receipt =>
    receipt.taskId === task.id && receipt.status === 'missing') ||
    task.turns === undefined && task.status !== 'queued' && state.taskUsage?.[task.id] === undefined);
  const projection = projectAgentTeamBudget({ tokenBudget: state.tokenBudget ?? buildTokenBudget(0, []),
    maxTurns: state.agentTeam?.hostLimits?.maxTurns ?? Infinity, turns: state.turns ?? 0,
    task: { id: task.id, budget: task.budget, turns: task.turns },
    taskUsage: state.taskUsage, taskUsageUnavailable: unavailable }).task!;
  const tokens = unavailable && state.taskUsage?.[task.id] === undefined ? null : projection.used.tokens;
  const turns = task.turns ?? (task.status === 'queued' ? 0 : null);
  return { ...projection.budget, used: { tokens, turns },
    remaining: { tokens: tokens === null ? null : projection.remaining.tokens,
      turns: turns === null ? null : projection.remaining.turns },
    usageUnavailable: projection.usageUnavailable, turnUsageKnown: turns !== null };
}

function workerTaskView(state: Readonly<SolverRunState>, worker: AgentTeamWorker, assignmentTaskId?: string) {
  const selected = new Set<number>();
  let current: AgentTeamTask | undefined, queuedTaskCount = 0;
  for (const [index, task] of worker.tasks.entries()) {
    if (task.status === 'running') {
      current ??= task;
      selected.add(index);
    } else if (task.status === 'queued' && queuedTaskCount++ === 0) selected.add(index);
  }
  let recent = 0;
  for (let index = worker.tasks.length - 1; index >= 0 && selected.size < TASKS && recent < 2; index--) {
    const { status } = worker.tasks[index]!;
    if (status === 'running' || status === 'queued') continue;
    selected.add(index);
    recent++;
  }
  for (let index = worker.tasks.length - 1; index >= 0 && selected.size < TASKS; index--) selected.add(index);
  const tasks = [...selected].sort((left, right) => left - right).slice(-TASKS).map(index => {
    const task = worker.tasks[index]!;
    return { ...taskProjection(task, index),
      ...(task.id === assignmentTaskId ? { objective: undefined, profileEvidence: undefined } : {}),
      budget: taskBudget(state, worker, task) };
  });
  return { current, tasks, queuedTaskCount };
}

function contextBudget(state: Readonly<SolverRunState>, focusAgentId?: string) {
  const team = state.agentTeam, limits = team?.hostLimits;
  if (!state.tokenBudget) return { tokenBudget: undefined, turns: state.turns, maxTurns: limits?.maxTurns,
    turnLimitKnown: Boolean(limits), leadReserve: team?.leadReserve };
  const worker = team?.workers.find(item => item.id === focusAgentId);
  const task = worker?.tasks.find(item => item.status === 'running');
  const budget = projectAgentTeamBudget({ tokenBudget: state.tokenBudget, maxTurns: limits?.maxTurns ?? Infinity,
    turns: state.turns, leadReserve: team?.leadReserve,
    task: task && { id: task.id, budget: task.budget, turns: task.turns }, taskUsage: state.taskUsage,
    taskUsageUnavailable: task && worker?.requestUsageAccounting?.receipts?.some(receipt =>
      receipt.taskId === task.id && receipt.status === 'missing') });
  return { ...budget, maxTurns: limits?.maxTurns, turnLimitKnown: Boolean(limits) };
}

/** A bounded observation shared by poll/wait and both kinds of dispatch context. */
export function agentTeamOverview(state: Readonly<SolverRunState>,
  options: { focusAgentId?: string; assignmentTaskId?: string; budget?: unknown; workerLimit?: number } = {}) {
  const team = state.agentTeam;
  const workers = team?.workers ?? [];
  const research = team?.researchState;
  const researchPreview = research && preview(research.summary, RESEARCH_TEXT);
  const refs = team?.researchArtifacts ?? [], deliveries = team?.deliveries ?? [], adoptions = team?.adoptions ?? [];
  const retiredRoutes = team?.retiredRoutes ?? [];
  const integrating = new Set<string>();
  const selectedAdoptions = new Set<number>();
  for (const [index, item] of adoptions.entries()) {
    if (item.status !== 'queued' && item.status !== 'integrating') continue;
    integrating.add(item.targetId);
    if (selectedAdoptions.size < 4) selectedAdoptions.add(index);
  }
  for (let index = adoptions.length - 1; index >= 0 && selectedAdoptions.size < REFERENCES; index--) selectedAdoptions.add(index);
  const rank = (worker: AgentTeamWorker) => worker.id === options.focusAgentId ? 0 :
    worker.status === 'running' || worker.status === 'preparing' || worker.pendingDelivery || integrating.has(worker.id) ? 1 :
    worker.status === 'stopped' ? 3 : 2;
  const visibleWorkers = workers.map((worker, index) => ({ worker, index, rank: rank(worker) }))
    .sort((left, right) => left.rank - right.rank || right.index - left.index)
    .slice(0, options.workerLimit ?? WORKERS).sort((left, right) => left.index - right.index)
    .map(({ worker }) => {
      const { current, tasks, queuedTaskCount } = workerTaskView(state, worker,
        worker.id === options.focusAgentId ? options.assignmentTaskId : undefined);
      const error = worker.error && preview(worker.error, TASK_TEXT);
      const stopReason = worker.writerStopUnconfirmed && preview(worker.writerStopUnconfirmed.reason, TASK_TEXT);
      const usage = buildTokenBudget(0, [worker]), requests = worker.requestUsageAccounting;
      return { id: worker.id, status: worker.status, activity: activity(worker, current, integrating.has(worker.id)), turns: worker.turns,
        ...(worker.native ? { nativeIdentity: { threadId: worker.native.threadId, agentPath: worker.native.agentPath,
          spawnHistory: worker.native.spawnHistory ?? 'unknown' } } : {}),
        error: error && error.text, ...(error && error.truncated ? { errorTruncated: true } : {}),
        lastActivity: worker.lastActivity && { at: worker.lastActivity.at, event: worker.lastActivity.event,
          itemType: worker.lastActivity.itemType },
        usage: { reportedTotalTokens: usage.reportedTotalTokens, usageComplete: usage.usageComplete,
          startedRequests: requests?.startedRequests, reportedRequests: requests?.reportedRequests,
          pendingRequests: requests?.pendingRequests ?? null, pending: Boolean(requests ? requests.pendingRequests : worker.usageAccounting?.pending) },
        pendingDelivery: worker.pendingDelivery && { taskId: worker.pendingDelivery.taskId, commit: worker.pendingDelivery.commit,
          sourceDigest: worker.pendingDelivery.sourceDigest, declarationCount: worker.pendingDelivery.declarations.length },
        pendingPeerDeliveries: worker.pendingPeerDeliveries?.slice(-REFERENCES) ?? [],
        pendingPeerDeliveryCount: worker.pendingPeerDeliveries?.length ?? 0,
        deliveryExposures: worker.exposures?.slice(-REFERENCES) ?? [],
        deliveryExposureCount: worker.exposures?.length ?? 0,
        tasks, taskCount: worker.tasks.length, tasksOmitted: worker.tasks.length - tasks.length,
        queuedTaskCount,
        writerStopUnconfirmed: worker.writerStopUnconfirmed && { at: worker.writerStopUnconfirmed.at,
          reason: stopReason!.text, ...(stopReason!.truncated ? { reasonTruncated: true } : {}) } };
    });
  const taskCount = workers.reduce((sum, worker) => sum + worker.tasks.length, 0);
  return {
    workers: visibleWorkers,
    ...(research && { researchState: { revision: research.revision, publishedAt: research.publishedAt,
      summary: researchPreview!.text, advisory: true, ...(researchPreview!.truncated ? { summaryTruncated: true } : {}) } }),
    ...(retiredRoutes.length > 0 && { retiredRouteCount: retiredRoutes.length,
      retiredRoutes: retiredRoutes.slice(-REFERENCES).map(route => ({ ...route,
        reason: preview(route.reason, TASK_TEXT).text, evidenceRefs: route.evidenceRefs?.slice(0, 4) })) }),
    completionRequested: team?.completionRequested && { at: team.completionRequested.at,
      summary: preview(team.completionRequested.summary, EVENT_TEXT).text },
    ...(team?.landedHelpers?.length ? { canonicalCommit: team.canonicalCommit,
      landedHelpers: team.landedHelpers.slice(-REFERENCES).map(helper => ({ ...helper, type: preview(helper.type, 240).text })),
      landedHelperCount: team.landedHelpers.length } : {}),
    researchArtifacts: refs.slice(-REFERENCES).map(({ id, agentId, taskId, commit }) => ({ id, agentId, taskId, commit })),
    deliveries: deliveries.slice(-REFERENCES).map(({ id, agentId, taskId, kind }) => ({ id, agentId, taskId, ...(kind ? { kind } : {}) })),
    adoptions: [...selectedAdoptions].sort((left, right) => left - right).map(index => {
      const item = adoptions[index]!, error = item.error && preview(item.error, TASK_TEXT);
      return { id: item.id, deliveryId: item.deliveryId, targetId: item.targetId,
        status: item.status, expectedCommit: item.expectedCommit, commit: item.commit,
        error: error && error.text, ...(error && error.truncated ? { errorTruncated: true } : {}) };
    }),
    budget: options.budget ?? contextBudget(state, options.focusAgentId),
    totals: { workers: workers.length, tasks: taskCount,
      researchArtifacts: refs.length, deliveries: deliveries.length, adoptions: adoptions.length },
    omissions: { workers: workers.length - visibleWorkers.length,
      tasks: taskCount - visibleWorkers.reduce((sum, worker) => sum + worker.tasks.length, 0),
      researchArtifacts: Math.max(0, refs.length - REFERENCES), deliveries: Math.max(0, deliveries.length - REFERENCES),
      adoptions: Math.max(0, adoptions.length - REFERENCES) },
    retrieval: {
      history: { operation: 'history', offset: 0, limit: 4 },
      task: 'Use history with agentId and the task historyOffset, limit 1. Full objective revisions, progress, profile source identities, summary and error are in history. For a rejected Lean check, failedCheck there identifies the submitted declaration, frozen source, environment and verifier diagnostics. It is not proof evidence.',
      research: 'History includes the full latest advisory research summary and each task researchArtifactId; use inspect-research for fixed notes.',
      proof: 'History includes deliveryId. Use inspect for exact checked declarations and evidence; overview omits declaration arrays.',
      omissions: 'Only selected members, current/next/recent tasks and recent references are shown. Use global history for omitted members and tasks; archived state is retained.',
    },
  };
}

function oneLine(value: string, limit: number) {
  const clipped = preview(value.trim().replace(/[\s\p{Cc}]+/gu, ' '), limit);
  return clipped.truncated ? clipped.text + '…' : clipped.text;
}

/** Bound each section by its serialized UTF-8 bytes, including JSON escapes. */
function routeSummaryRows<T, Row>(rows: readonly T[], bytes: number, project: (item: T) => Row) {
  let used = 2; // Array brackets.
  const selected: Row[] = [];
  for (const item of rows) {
    const row = project(item);
    const size = Buffer.byteLength(JSON.stringify(row)) + Number(selected.length > 0);
    if (used + size > bytes) break;
    selected.push(row);
    used += size;
  }
  return selected;
}

const routeTaskRank = { running: 0, queued: 1, paused: 2, completed: 3 } as const;

/** A read-only index for route decisions. Full task and proof evidence stays behind history and inspect. */
export function agentTeamRouteSummary(team: Readonly<AgentTeamState>,
  { routeId, includeRetired = true }: { routeId?: string; includeRetired?: boolean } = {}) {
  const retired = new Map((team.retiredRoutes ?? []).map(route => [route.routeId, route]));
  const matched = team.workers.flatMap(worker => worker.tasks.filter(task =>
    (routeId === undefined || routeId === task.routeId) && (includeRetired || !task.routeId || !retired.has(task.routeId)))
    .map(task => ({ workerId: worker.id, task })));
  const byTask = new Map(matched.map(({ task }) => [task.id, task]));
  const activeRoutes = new Map<string | null, { routeId: string | null; running: number; queued: number; paused: number; completed: number }>();
  const taskRows = matched.flatMap(({ task, workerId }) => {
    const status = task.status;
    if (status !== 'running' && status !== 'queued' && status !== 'paused' && status !== 'completed') return [];
    const key = task.routeId ?? null;
    if (!key || !retired.has(key)) {
      let group = activeRoutes.get(key);
      if (!group) {
        group = { routeId: key, running: 0, queued: 0, paused: 0, completed: 0 };
        activeRoutes.set(key, group);
      }
      group[status]++;
    }
    return [{ task, workerId, status }];
  }).sort((a, b) => routeTaskRank[a.status] - routeTaskRank[b.status] || (b.task.sequence ?? 0) - (a.task.sequence ?? 0));
  const routes = routeSummaryRows([...activeRoutes.values()].sort((a, b) =>
    (b.running + b.queued + b.paused) - (a.running + a.queued + a.paused)), 800, route => route);
  const tasks = routeSummaryRows(taskRows, 2200, ({ task, workerId, status }) => ({
    taskId: oneLine(task.id, 64), workerId, routeId: task.routeId ?? null, status, workKind: task.workKind ?? null,
    objective: oneLine(task.message, 100),
  }));
  const retirementRows = includeRetired ? [...retired.values()].toReversed()
    .filter(route => routeId === undefined || route.routeId === routeId) : [];
  const retiredRoutes = routeSummaryRows(retirementRows, 950, route => ({
    routeId: route.routeId, source: route.source, reason: oneLine(route.reason, 120),
    evidenceRefCount: route.evidenceRefs?.length ?? 0,
  }));
  const helpers = team.landedHelpers ?? [];
  const landedHelpers = routeSummaryRows(helpers.slice(-8).reverse(), 1200, helper => ({
    file: oneLine(helper.file, 96), qualifiedName: oneLine(helper.qualifiedName, 120),
    signature: oneLine(helper.type, 120), landedAt: helper.landedAt ?? null,
  }));
  const deliveries = routeId === undefined && includeRetired ? team.deliveries :
    team.deliveries.filter(delivery => byTask.has(delivery.taskId));
  const recentDeliveries = routeSummaryRows(deliveries.slice(-8).reverse(), 1250, delivery => {
    const task = byTask.get(delivery.taskId);
    return { id: oneLine(delivery.id, 64), producer: delivery.agentId, kind: delivery.kind ?? 'proof',
      declarationCount: delivery.declarationCount ?? (task?.deliveryId === delivery.id && task.declarations ? task.declarations.length : null),
      summary: oneLine(delivery.summary ?? task?.summary ?? 'Independently checked delivery.', 100) };
  });
  const research = team.researchState;
  return {
    ok: true, routeId: routeId ?? null, canonicalCommit: team.canonicalCommit,
    routes, tasks, retiredRoutes, landedHelpers, recentDeliveries,
    research: research ? { revision: research.revision, summary: oneLine(research.summary, 160) } : null,
    omitted: { routes: activeRoutes.size - routes.length, tasks: taskRows.length - tasks.length,
      retiredRoutes: retirementRows.length - retiredRoutes.length, landedHelpers: helpers.length - landedHelpers.length,
      recentDeliveries: deliveries.length - recentDeliveries.length },
  };
}

/** Task order is append-only once the host has filled the optional legacy sequence values. */
export function agentTeamTaskHistory(team: Readonly<AgentTeamState>, input: { agentId?: string; offset?: number; limit?: number } = {}) {
  const { agentId, offset = 0, limit = 4 } = input;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 8)
    throw new Error('math_team_history_arguments_invalid');
  let total: number;
  let entries: { agentId: string; task: AgentTeamTask; index: number }[];
  if (agentId) {
    const worker = team.workers.find(item => item.id === agentId);
    if (!worker) throw new Error('math_team_agent_unknown:' + agentId);
    total = worker.tasks.length;
    entries = worker.tasks.slice(offset, offset + limit).map((task, index) => ({ agentId, task, index: offset + index }));
  } else {
    const all = team.workers.flatMap(worker => worker.tasks.map((task, index) => ({ agentId: worker.id, task, index })));
    all.sort((left, right) => (left.task.sequence ?? Number.MAX_SAFE_INTEGER) - (right.task.sequence ?? Number.MAX_SAFE_INTEGER));
    total = all.length;
    entries = all.slice(offset, offset + limit);
  }
  // Include the next whole task or leave it for the next page; a byte limit never skips a row.
  // One legal task is always returned even when its full text exceeds the ordinary page budget.
  const tasks = [];
  let bytes = Buffer.byteLength(JSON.stringify(team.researchState ?? null));
  for (const entry of entries) {
    const projection = taskProjection(entry.task, entry.index, true);
    const size = Buffer.byteLength(JSON.stringify(projection));
    if (tasks.length && bytes + size > HISTORY_BYTES) break;
    tasks.push({ agentId: entry.agentId, ...projection });
    bytes += size;
  }
  return { ok: true, agentId, offset, total, coordination: team.coordination, tasks,
    nextOffset: offset + tasks.length < total ? offset + tasks.length : null,
    ...(team.researchState && { researchState: { ...team.researchState, advisory: true } }),
    declarations: 'Task text is complete. Declaration arrays are omitted; inspect a checked deliveryId for exact declarations and evidence.',
    pagination: 'Pages stop at a complete task boundary. Follow nextOffset; a single large task can exceed the ordinary 256 KiB page budget.',
  };
}

function eventPreview(event: AgentTeamState['events'][number]) {
  const result = preview(event.text, EVENT_TEXT);
  return { ...event, text: result.text, ...(result.truncated ? { textTruncated: true } : {}) };
}

/** A truncated preview never acknowledges the unreturned message body. */
export function agentTeamInboxPreview(team: Readonly<AgentTeamState>, actor: string, after: number) {
  const events: ReturnType<typeof eventPreview>[] = [];
  let through = after, truncated = false, more = false;
  for (const item of team.events) {
    if (item.to !== actor || item.sequence <= after) continue;
    if (events.length === EVENTS) {
      more = true;
      break;
    }
    const event = eventPreview(item);
    events.push(event);
    truncated ||= Boolean(event.textTruncated);
    if (!truncated) through = event.sequence;
  }
  return { after, through, previewThrough: events.at(-1)?.sequence ?? after, events,
    more: more || truncated,
    continuation: 'Read addressed native messages for complete updates; use history and inspect-research for saved task results. Previews do not acknowledge their bodies.' };
}

export function agentTeamRecentEvents(team: Readonly<AgentTeamState> | undefined, actor: string) {
  const events = team?.events ?? [];
  const recent: ReturnType<typeof eventPreview>[] = [];
  for (let index = events.length - 1; index >= 0 && recent.length < EVENTS; index--) {
    const event = events[index]!;
    if (event.to === actor) recent.push(eventPreview(event));
  }
  return recent.reverse();
}

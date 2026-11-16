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
    objective: field('objective', task.message), summary: field('summary', task.summary), error: field('error', task.error),
    createdAt: task.createdAt, startedAt: task.startedAt, lastStartedAt: task.lastStartedAt,
    pausedAt: task.pausedAt, finishedAt: task.finishedAt, turns: task.turns,
    budget: task.budget, seedCommit: task.seedCommit, sourceCommit: task.sourceCommit,
    researchArtifactId: task.researchArtifactId, deliveryId: task.deliveryId,
    declarationCount: task.declarations?.length,
    cancelRequested: task.cancelRequested && { ...task.cancelRequested,
      reason: field('cancelRequested.reason', task.cancelRequested.reason) },
    pauseRequested: task.pauseRequested && { ...task.pauseRequested,
      reason: field('pauseRequested.reason', task.pauseRequested.reason) },
  };
  return { ...result, ...(textTruncated.length ? { textTruncated } : {}) };
}

function activity(team: Readonly<AgentTeamState>, worker: AgentTeamWorker): Activity {
  if (worker.writerStopUnconfirmed) return 'stopping';
  if (worker.activity) return worker.activity;
  const current = worker.tasks.find(task => task.status === 'running');
  if (current?.cancelRequested || current?.pauseRequested) return 'stopping';
  if (worker.pendingDelivery || worker.phase === 'checking') return 'checking';
  if (team.adoptions.some(item => item.targetId === worker.id && ['queued', 'integrating'].includes(item.status))) return 'integrating';
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
  return { ...task.budget, used: { tokens, turns },
    remaining: { tokens: tokens === null ? null : projection.remaining.tokens,
      turns: turns === null ? null : projection.remaining.turns },
    usageUnavailable: projection.usageUnavailable, turnUsageKnown: turns !== null };
}

function visibleTasks(state: Readonly<SolverRunState>, worker: AgentTeamWorker) {
  const selected = new Set(worker.tasks.filter(task => task.status === 'running').map(task => task.id));
  const next = worker.tasks.find(task => task.status === 'queued');
  if (next) selected.add(next.id);
  for (const task of worker.tasks.toReversed().filter(task => !['running', 'queued'].includes(task.status)).slice(0, 2))
    if (selected.size < TASKS) selected.add(task.id);
  for (const task of worker.tasks.toReversed()) {
    if (selected.size >= TASKS) break;
    selected.add(task.id);
  }
  return worker.tasks.flatMap((task, index) => selected.has(task.id)
    ? [{ ...taskProjection(task, index), budget: taskBudget(state, worker, task) }] : []).slice(-TASKS);
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
export function agentTeamOverview(state: Readonly<SolverRunState>, options: { focusAgentId?: string; budget?: unknown } = {}) {
  const team = state.agentTeam;
  const workers = team?.workers ?? [];
  const selected = [...workers].sort((left, right) => {
    const rank = (worker: AgentTeamWorker) => worker.id === options.focusAgentId ? 0 :
      worker.status === 'running' || worker.status === 'preparing' || worker.pendingDelivery ||
      team!.adoptions.some(item => item.targetId === worker.id && ['queued', 'integrating'].includes(item.status)) ? 1 :
      worker.status === 'stopped' ? 3 : 2;
    return rank(left) - rank(right) || workers.indexOf(right) - workers.indexOf(left);
  }).slice(0, WORKERS);
  const visible = new Set(selected.map(worker => worker.id));
  const research = team?.researchState;
  const researchPreview = research && preview(research.summary, RESEARCH_TEXT);
  const refs = team?.researchArtifacts ?? [], deliveries = team?.deliveries ?? [], adoptions = team?.adoptions ?? [];
  const selectedAdoptions = new Set(adoptions.filter(item => ['queued', 'integrating'].includes(item.status)).slice(0, 4).map(item => item.id));
  for (const item of adoptions.toReversed()) {
    if (selectedAdoptions.size >= REFERENCES) break;
    selectedAdoptions.add(item.id);
  }
  return {
    workers: workers.filter(worker => visible.has(worker.id)).map(worker => {
      const tasks = visibleTasks(state, worker), error = worker.error && preview(worker.error, TASK_TEXT);
      const stopReason = worker.writerStopUnconfirmed && preview(worker.writerStopUnconfirmed.reason, TASK_TEXT);
      const usage = buildTokenBudget(0, [worker]), requests = worker.requestUsageAccounting;
      return { id: worker.id, status: worker.status, activity: activity(team!, worker), turns: worker.turns,
        error: error && error.text, ...(error?.truncated ? { errorTruncated: true } : {}),
        lastActivity: worker.lastActivity && { at: worker.lastActivity.at, event: worker.lastActivity.event,
          itemType: worker.lastActivity.itemType },
        usage: { reportedTotalTokens: usage.reportedTotalTokens, usageComplete: usage.usageComplete,
          startedRequests: requests?.startedRequests, reportedRequests: requests?.reportedRequests,
          pendingRequests: requests?.pendingRequests ?? null, pending: Boolean(requests ? requests.pendingRequests : worker.usageAccounting?.pending) },
        pendingDelivery: worker.pendingDelivery && { taskId: worker.pendingDelivery.taskId, commit: worker.pendingDelivery.commit,
          sourceDigest: worker.pendingDelivery.sourceDigest, declarationCount: worker.pendingDelivery.declarations.length },
        pendingPeerDeliveries: worker.pendingPeerDeliveries?.slice(-REFERENCES) ?? [],
        pendingPeerDeliveryCount: worker.pendingPeerDeliveries?.length ?? 0,
        tasks, taskCount: worker.tasks.length, tasksOmitted: worker.tasks.length - tasks.length,
        queuedTaskCount: worker.tasks.filter(task => task.status === 'queued').length,
        writerStopUnconfirmed: worker.writerStopUnconfirmed && { at: worker.writerStopUnconfirmed.at,
          reason: stopReason!.text, ...(stopReason!.truncated ? { reasonTruncated: true } : {}) } };
    }),
    ...(research && { researchState: { revision: research.revision, publishedAt: research.publishedAt,
      summary: researchPreview!.text, advisory: true, ...(researchPreview!.truncated ? { summaryTruncated: true } : {}) } }),
    researchArtifacts: refs.slice(-REFERENCES).map(({ id, agentId, taskId, commit }) => ({ id, agentId, taskId, commit })),
    deliveries: deliveries.slice(-REFERENCES).map(({ id, agentId, taskId }) => ({ id, agentId, taskId })),
    adoptions: adoptions.filter(item => selectedAdoptions.has(item.id)).map(item => ({ id: item.id, deliveryId: item.deliveryId, targetId: item.targetId,
      status: item.status, expectedCommit: item.expectedCommit, commit: item.commit,
      error: item.error && preview(item.error, TASK_TEXT).text,
      ...(item.error && preview(item.error, TASK_TEXT).truncated ? { errorTruncated: true } : {}) })),
    budget: options.budget ?? contextBudget(state, options.focusAgentId),
    totals: { workers: workers.length, tasks: workers.reduce((sum, worker) => sum + worker.tasks.length, 0),
      researchArtifacts: refs.length, deliveries: deliveries.length, adoptions: adoptions.length },
    omissions: { workers: workers.length - selected.length,
      tasks: workers.reduce((sum, worker) => sum + worker.tasks.length, 0) - selected.reduce((sum, worker) => sum + visibleTasks(state, worker).length, 0),
      researchArtifacts: Math.max(0, refs.length - REFERENCES), deliveries: Math.max(0, deliveries.length - REFERENCES),
      adoptions: Math.max(0, adoptions.length - REFERENCES) },
    retrieval: {
      history: { operation: 'history', offset: 0, limit: 4 },
      task: 'Use history with agentId and the task historyOffset, limit 1. Full task objective, summary and error are in history; current task state may change.',
      research: 'History includes the full latest advisory research summary and each task researchArtifactId; use inspect-research for fixed notes.',
      proof: 'History includes deliveryId. Use inspect for exact checked declarations and evidence; overview omits declaration arrays.',
      omissions: 'Only selected members, current/next/recent tasks and recent references are shown. Use global history for omitted members and tasks; archived state is retained.',
    },
  };
}

/** Task order is append-only once the host has filled the optional legacy sequence values. */
export function agentTeamTaskHistory(team: Readonly<AgentTeamState>, input: { agentId?: string; offset?: number; limit?: number } = {}) {
  const offset = input.offset ?? 0, limit = input.limit ?? 4;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 8)
    throw new Error('math_team_history_arguments_invalid');
  if (input.agentId && !team.workers.some(worker => worker.id === input.agentId))
    throw new Error('math_team_agent_unknown:' + input.agentId);
  const all = team.workers.flatMap(worker => input.agentId && worker.id !== input.agentId ? [] :
    worker.tasks.map((task, index) => ({ agentId: worker.id, task, index })));
  if (!input.agentId) all.sort((left, right) => (left.task.sequence ?? Number.MAX_SAFE_INTEGER) -
    (right.task.sequence ?? Number.MAX_SAFE_INTEGER));
  // Include the next whole task or leave it for the next page; a byte limit never skips a row.
  // One legal task is always returned even when its full text exceeds the ordinary page budget.
  const page: typeof all = [];
  let bytes = Buffer.byteLength(JSON.stringify(team.researchState ?? null));
  for (const entry of all.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(JSON.stringify(taskProjection(entry.task, entry.index, true)));
    if (page.length && bytes + size > HISTORY_BYTES) break;
    page.push(entry); bytes += size;
  }
  return { ok: true, agentId: input.agentId, offset, total: all.length,
    tasks: page.map(item => ({ agentId: item.agentId, ...taskProjection(item.task, item.index, true) })),
    nextOffset: offset + page.length < all.length ? offset + page.length : null,
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
  const unread = team.events.filter(item => item.to === actor && item.sequence > after);
  const events = unread.slice(0, EVENTS).map(eventPreview);
  let through = after, truncated = false;
  for (const event of events) {
    truncated ||= Boolean(event.textTruncated);
    if (!truncated) through = event.sequence;
  }
  return { after, through, previewThrough: events.at(-1)?.sequence ?? after, events,
    more: unread.length > events.length || truncated,
    continuation: 'Poll after through for complete unread messages. textTruncated previews do not acknowledge their bodies; previewThrough is not a receive cursor.' };
}

export function agentTeamRecentEvents(team: Readonly<AgentTeamState> | undefined, actor: string) {
  return team?.events.filter(event => event.to === actor).slice(-EVENTS).map(eventPreview) ?? [];
}

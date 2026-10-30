import type { WebAgentAction, WebEvent } from '../shared';

export type RouteStepKind = 'read' | 'write' | 'check' | 'deliver' | 'accept' | 'stop';
/** What happened inside a step, in time order: the host's events for the Agent and the Agent's own actions. */
export type RouteItem = { type: 'event'; event: WebEvent } | { type: 'action'; action: WebAgentAction };
export type RouteStep = {
  kind: RouteStepKind; at: string; count: number; outcome?: 'passed' | 'failed'; taskId?: string; reviewing?: boolean;
  /** A Lead turn in which the research plan changed. */ planning?: boolean;
  /** The work was for an assignment a later plan replaced (the host superseded its delivery). */ superseded?: boolean;
  /** Taking a task this Agent already had: the plan was revised and the task handed out again. */ again?: boolean;
  items: RouteItem[];
};
export type AgentRoute = { workerId: string; steps: RouteStep[] };

/** Event types that start or extend one route step; anything else (heartbeats, host bookkeeping) is not a step. */
const stepKinds: Record<string, RouteStepKind> = {
  research_action: 'read', context_compiled: 'read', context_restarted: 'read', task_assigned: 'read', review_assigned: 'read', statement_review_assigned: 'read',
  turn_started: 'write',
  proof_check_started: 'check', proof_checked: 'check', assembly_started: 'check', task_checked: 'check', task_check_reused: 'check',
  task_recheck_started: 'check', task_recheck_finished: 'check', proof_ready_checked: 'check', lemma_checked: 'check',
  task_integrated: 'deliver', delivery_published: 'deliver', research_delivered: 'deliver', review_completed: 'deliver', statement_review_completed: 'deliver',
  candidate_selected: 'accept', evaluation_started: 'accept', evaluation_finished: 'accept',
  worker_failed: 'stop', turn_failed: 'stop',
};
// Events that close one occurrence of a step, so merged repeats are counted (two Lean checks read "×2").
const closing = new Set(['proof_checked', 'task_checked', 'task_check_reused', 'task_recheck_finished', 'proof_ready_checked', 'lemma_checked', 'turn_started']);
// Heartbeats say only that a session is alive; every other event about an Agent is shown inside its current step.
const quiet = new Set(['worker_activity']);
const humanEdits = new Set(['human_edit_queued', 'edit_received', 'edit_applied']);
// The host replaced the Agent's assignment or delivery with a newer version of the plan.
const superseding = new Set(['task_delivery_superseded', 'assignment_superseded']);
const verdict = (event: WebEvent): RouteStep['outcome'] => {
  const details = event.details;
  if (event.type === 'evaluation_finished') return details?.status === 'passed' ? 'passed' : 'failed';
  if (typeof details?.passed === 'boolean') return details.passed ? 'passed' : 'failed';
  return undefined;
};

/**
 * One entry per Agent action: a completed report replaces its started one but keeps the started time and place,
 * so a long command stays where it began.
 */
export function mergeAgentActions(actions: readonly WebAgentAction[]): WebAgentAction[] {
  const merged = new Map<string, WebAgentAction>();
  for (const action of actions) {
    const key = `${action.workerId}\u0000${action.itemId}`, first = merged.get(key);
    merged.set(key, first ? { ...action, sequence: first.sequence, at: first.at } : action);
  }
  return [...merged.values()];
}

/**
 * Each Agent's path through the run, read from the recorded progress events: reading the task, writing a candidate,
 * Lean checks, deliveries and the final acceptance. Consecutive events of one kind merge into one step.
 * Events without an Agent go to the Agent that owns their task, or to the one running the acceptance.
 * `actions` (see mergeAgentActions) join the Agent's step at their time; one after a check or a delivery starts a
 * new writing step. `lead` is the Agent whose turn a plan change belongs to.
 */
export function agentRoutes(events: readonly WebEvent[], options: { actions?: readonly WebAgentAction[]; lead?: string } = {}): AgentRoute[] {
  const routes = new Map<string, AgentRoute>(), owners = new Map<string, string>(), reviewing = new Set<string>();
  const taken = new Map<string, Set<string>>();
  let accepting: string | undefined;
  const routeOf = (workerId: string) => {
    let route = routes.get(workerId);
    if (!route) { route = { workerId, steps: [] }; routes.set(workerId, route); }
    return route;
  };
  // A plan change after a person's plan edit, before the Lead's next turn, is that edit and not the Lead's work.
  let edited = '';
  const turns = new Map<string, string>();
  const record = (event: WebEvent) => {
    const kind = stepKinds[event.type], details = event.details ?? {};
    if (event.type === 'turn_started' && details.workerId) turns.set(details.workerId, event.at);
    if (!kind) {
      if (humanEdits.has(event.type)) edited = event.at;
      const workerId = event.type === 'plan_updated' ? options.lead : details.workerId;
      const step = workerId ? routes.get(workerId)?.steps.at(-1) : undefined;
      if (!step || quiet.has(event.type) || (event.type === 'plan_updated' && (turns.get(workerId!) ?? '') < edited)) return;
      step.items.push({ type: 'event', event });
      if (superseding.has(event.type)) step.superseded = true;
      if (event.type === 'plan_updated' && step.kind === 'write') step.planning = true;
      return;
    }
    const workerId = details.workerId ?? (details.taskId ? owners.get(details.taskId) : undefined) ?? (kind === 'accept' ? accepting : undefined);
    if (!workerId) return;
    if (event.type === 'task_assigned' && details.taskId) { owners.set(details.taskId, workerId); reviewing.delete(workerId); }
    if (event.type === 'review_assigned' || event.type === 'statement_review_assigned') reviewing.add(workerId);
    if (kind === 'accept') accepting = workerId;
    const route = routeOf(workerId);
    const last = route.steps.at(-1), outcome = verdict(event);
    const step: RouteStep = last?.kind === kind ? last : { kind, at: event.at, count: 0, items: [], ...((kind === 'write' || kind === 'read') && reviewing.has(workerId) ? { reviewing: true } : {}) };
    if (step !== last) route.steps.push(step);
    if (event.type === 'task_assigned') delete step.reviewing;
    if (event.type === 'review_assigned' || event.type === 'statement_review_assigned') step.reviewing = true;
    if (event.type === 'task_assigned' && details.taskId) {
      const tasks = taken.get(workerId) ?? new Set<string>();
      if (tasks.has(details.taskId)) step.again = true;
      tasks.add(details.taskId); taken.set(workerId, tasks);
    }
    step.items.push({ type: 'event', event });
    if (closing.has(event.type)) step.count++;
    if (outcome) step.outcome = outcome;
    if (details.taskId && (kind === 'read' || kind === 'deliver' || !step.taskId)) step.taskId = details.taskId;
  };
  const act = (action: WebAgentAction) => {
    const route = routeOf(action.workerId), last = route.steps.at(-1);
    // Reading the task and writing are the Agent's own steps; after the host has checked or taken its work, it is writing again.
    const step = last && (last.kind === 'read' || last.kind === 'write') ? last
      : { kind: 'write' as const, at: action.at, count: 0, items: [], ...(reviewing.has(action.workerId) ? { reviewing: true } : {}) };
    if (step !== last) route.steps.push(step);
    step.items.push({ type: 'action', action });
  };
  // Both lists are in server time order; at the same instant the event goes first, since it opens the step an action belongs to.
  const actions = options.actions ?? [];
  for (let e = 0, a = 0; e < events.length || a < actions.length;) {
    if (a >= actions.length || (e < events.length && events[e]!.at <= actions[a]!.at)) record(events[e++]!);
    else act(actions[a++]!);
  }
  for (const route of routes.values()) for (const step of route.steps) step.count = Math.max(1, step.count);
  return [...routes.values()];
}

/**
 * What a reader calls each Agent: its role, numbered only when several Agents share it ("Researcher 1", "Researcher 2").
 * Agents without a known role keep their id.
 */
export function agentNames(workers: readonly { id: string; role?: string }[]): Map<string, string> {
  const shared = new Map<string, number>();
  for (const worker of workers) if (worker.role) shared.set(worker.role, (shared.get(worker.role) ?? 0) + 1);
  const seen = new Map<string, number>(), names = new Map<string, string>();
  for (const worker of workers) {
    if (!worker.role) continue;
    const index = (seen.get(worker.role) ?? 0) + 1;
    seen.set(worker.role, index);
    names.set(worker.id, shared.get(worker.role)! > 1 ? `${worker.role} ${index}` : worker.role);
  }
  return names;
}

/** A task as a reader knows it: the last part of its theorem's name (Tutorial.add_zero → add_zero). */
export const taskNames = (tasks: readonly { id: string; theorem?: string }[]) =>
  new Map(tasks.flatMap(task => task.theorem ? [[task.id, task.theorem.split('.').at(-1)!] as const] : []));

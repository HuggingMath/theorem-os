import type { WebEvent } from '../shared';

export type RouteStepKind = 'read' | 'write' | 'check' | 'deliver' | 'accept' | 'stop';
export type RouteStep = { kind: RouteStepKind; at: string; count: number; outcome?: 'passed' | 'failed'; taskId?: string; reviewing?: boolean };
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
const verdict = (event: WebEvent): RouteStep['outcome'] => {
  const details = event.details;
  if (event.type === 'evaluation_finished') return details?.status === 'passed' ? 'passed' : 'failed';
  if (typeof details?.passed === 'boolean') return details.passed ? 'passed' : 'failed';
  return undefined;
};

/**
 * Each Agent's path through the run, read from the recorded progress events: reading the task, writing a candidate,
 * Lean checks, deliveries and the final acceptance. Consecutive events of one kind merge into one step.
 * Events without an Agent go to the Agent that owns their task, or to the one running the acceptance.
 */
export function agentRoutes(events: readonly WebEvent[]): AgentRoute[] {
  const routes = new Map<string, AgentRoute>(), owners = new Map<string, string>(), reviewing = new Set<string>();
  let accepting: string | undefined;
  for (const event of events) {
    const kind = stepKinds[event.type]; if (!kind) continue;
    const details = event.details ?? {};
    const workerId = details.workerId ?? (details.taskId ? owners.get(details.taskId) : undefined) ?? (kind === 'accept' ? accepting : undefined);
    if (!workerId) continue;
    if (event.type === 'task_assigned' && details.taskId) { owners.set(details.taskId, workerId); reviewing.delete(workerId); }
    if (event.type === 'review_assigned' || event.type === 'statement_review_assigned') reviewing.add(workerId);
    if (kind === 'accept') accepting = workerId;
    let route = routes.get(workerId);
    if (!route) { route = { workerId, steps: [] }; routes.set(workerId, route); }
    const last = route.steps.at(-1), outcome = verdict(event);
    const step: RouteStep = last?.kind === kind ? last : { kind, at: event.at, count: 0, ...(kind === 'write' && reviewing.has(workerId) ? { reviewing: true } : {}) };
    if (step !== last) route.steps.push(step);
    if (closing.has(event.type)) step.count++;
    if (outcome) step.outcome = outcome;
    if (details.taskId && (kind === 'read' || kind === 'deliver' || !step.taskId)) step.taskId = details.taskId;
  }
  for (const route of routes.values()) for (const step of route.steps) step.count = Math.max(1, step.count);
  return [...routes.values()];
}

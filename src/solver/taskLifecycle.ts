import type { TaskRecord } from './tasks';

export type TaskStatus = TaskRecord['status'];

/**
 * Every task status change names its cause, and each cause admits only the transitions it can produce.
 * `TaskRecord.status` is readonly, so the compiler keeps every live write on this path.
 */
const RULES = {
  /** A worker takes a ready task. */
  dispatched: { from: ['pending'], to: ['running'] },
  /** The writer stopped without a delivery: interruption, release, worker loss, ownership change or restart. */
  interrupted: { from: ['running'], to: ['pending'] },
  /** The assignment was withdrawn before or while it ran (reviewer independence, plan owner change). */
  reassigned: { from: ['pending', 'running'], to: ['pending'] },
  /** A block whose cause no longer holds: new input, new output, a recheckable type, an unattempted frontier. */
  reopened: { from: ['blocked'], to: ['pending'] },
  /** The same worker repairs its own failed attempt. */
  'local-repair': { from: ['blocked', 'running', 'pending'], to: ['pending'] },
  /** A delivery or host precheck rejected the attempt. */
  rejected: { from: ['pending', 'running'], to: ['blocked'] },
  /** A repeated failed input or a reported mathematical blocker. */
  'input-blocked': { from: ['pending', 'running', 'blocked'], to: ['blocked'] },
  /** A delivered proof was checked. */
  'proof-checked': { from: ['pending', 'running'], to: ['conditional', 'delivered', 'blocked'] },
  /** An advisory research or sketch delivery completed its task. */
  'research-completed': { from: ['pending', 'running', 'blocked'], to: ['completed'] },
  /** Integration into the canonical source, from a delivery or a staged validation of published work. */
  integrated: { from: ['delivered', 'conditional', 'integrated', 'pending', 'blocked'], to: ['integrated', 'blocked'] },
  /** A recheck of accepted work failed or its inputs were invalidated. */
  invalidated: { from: ['integrated', 'conditional', 'delivered'], to: ['blocked'] },
  /** Host advisory capacity expired with its frozen inputs. */
  expired: { from: ['pending', 'running', 'blocked', 'completed'], to: ['blocked'] },
  /** A retired route stops every unintegrated obligation on that branch. */
  'route-retired': { from: ['pending', 'running', 'blocked', 'completed', 'conditional', 'delivered'], to: ['blocked'] },
  /** Offline reconstruction (continuation seeding, snapshot recovery) rebuilds statuses from checked evidence. */
  reconstructed: { from: ['pending', 'running', 'blocked', 'conditional', 'delivered', 'integrated', 'completed'],
    to: ['pending', 'blocked', 'conditional', 'integrated', 'completed'] },
} as const satisfies Record<string, { from: readonly TaskStatus[]; to: readonly TaskStatus[] }>;

export type TaskTransitionCause = keyof typeof RULES;
export type InvalidTaskTransition = { taskId: string; from: TaskStatus; to: TaskStatus; cause: TaskTransitionCause; at: number };
export const MAX_INVALID_TASK_TRANSITIONS = 32;

export const taskTransitionAllowed = (from: TaskStatus, to: TaskStatus, cause: TaskTransitionCause) =>
  from === to || (RULES[cause].from as readonly TaskStatus[]).includes(from) && (RULES[cause].to as readonly TaskStatus[]).includes(to);

/** Apply the change and report whether its cause admits it; an unexpected transition is recorded, not hidden. */
export function setTaskStatus(node: TaskRecord, to: TaskStatus, cause: TaskTransitionCause): boolean {
  const allowed = taskTransitionAllowed(node.status, to, cause);
  (node as { status: TaskStatus }).status = to;
  return allowed;
}

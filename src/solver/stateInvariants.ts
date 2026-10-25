import type { SolverRunState } from './archive';
import { leadWakeViolations } from './leadWakes';
import { readyResearchTasks } from './modules/search';
import { taskGroup, type TaskRecord } from './tasks';

/** Errors break the cooperation graph; warnings name states that can only advance through outside input. */
export type StateViolation = { code: string; severity: 'error' | 'warning'; message: string; refs: string[] };

const live = (phase: string | undefined) => phase === 'running' || phase === 'checking';
const terminal = (node: TaskRecord) => node.status === 'integrated' || node.status === 'completed';

/**
 * Reads one persisted run state without trusting any cooperation field to be consistent with another.
 * It never repairs state; callers decide whether a violation stops a run, a restore, or only a report.
 */
export function checkSolverRunState(state: SolverRunState): StateViolation[] {
  const violations: StateViolation[] = [];
  const add = (code: string, severity: StateViolation['severity'], message: string, ...refs: string[]) =>
    violations.push({ code, severity, message, refs });
  const cooperation = state.cooperation;
  if (!cooperation) return violations;
  const tasks = cooperation.tasks ?? [];
  const ids = new Map<string, TaskRecord>();
  for (const node of tasks) {
    if (ids.has(node.task.id)) add('task_duplicate_id', 'error', 'Two task records share one id.', node.task.id);
    ids.set(node.task.id, node);
  }
  const workerIds = new Set((state.workers ?? []).map(worker => worker.id));
  const groupIds = cooperation.groups && new Set(cooperation.groups.map(route => route.group.id));
  const running = new Map<string, string[]>();
  for (const node of tasks) {
    const id = node.task.id;
    for (const dependency of node.task.dependsOn)
      if (!ids.has(dependency)) add('task_dependency_missing', 'error', `Dependency ${dependency} is not a task.`, id, dependency);
    if (groupIds && !groupIds.has(taskGroup(node.task)))
      add('task_group_missing', 'error', `Group ${taskGroup(node.task)} is not a route group.`, id);
    const worker = node.assignment?.workerId;
    // Continuation seeds attribute imported proofs to a host producer that is never a live worker.
    if (worker && worker !== 'continuation' && workerIds.size && !workerIds.has(worker))
      add('task_assignment_unknown_worker', 'error', `Assigned worker ${worker} does not exist.`, id, worker);
    if (node.status === 'running') {
      if (!worker) add('task_running_unassigned', 'error', 'A running task has no assignment.', id);
      else running.set(worker, [...running.get(worker) ?? [], id]);
    }
  }
  for (const [worker, owned] of running) if (owned.length > 1)
    add('worker_multiple_running_tasks', 'error', `Worker ${worker} runs ${owned.length} tasks.`, worker, ...owned);
  // Iterative three-color DFS: a cycle makes every task on it permanently unready.
  const color = new Map<string, 1 | 2>();
  for (const root of ids.keys()) {
    if (color.has(root)) continue;
    const stack: [string, number][] = [[root, 0]];
    color.set(root, 1);
    while (stack.length) {
      const frame = stack.at(-1)!, dependencies = ids.get(frame[0])!.task.dependsOn;
      if (frame[1] >= dependencies.length) { color.set(frame[0], 2); stack.pop(); continue; }
      const next = dependencies[frame[1]++]!;
      if (!ids.has(next)) continue;
      if (color.get(next) === 1) {
        add('task_dependency_cycle', 'error', 'Task dependencies form a cycle.',
          ...stack.slice(stack.findIndex(([id]) => id === next)).map(([id]) => id));
      } else if (!color.has(next)) { color.set(next, 1); stack.push([next, 0]); }
    }
  }
  if (cooperation.leadWakes) for (const message of leadWakeViolations(cooperation.leadWakes))
    add('lead_wakes_invalid', 'error', message);
  for (const blocker of cooperation.blockers ?? [])
    if (blocker.status !== 'superseded' && !ids.has(blocker.taskId))
      add('blocker_task_missing', 'warning', `Blocker ${blocker.id} names a removed task.`, blocker.id, blocker.taskId);
  if (!live(state.phase) || !state.workers?.length || violations.some(item => item.severity === 'error')) return violations;
  // Liveness is only meaningful while the host process owns this state. Older builds lack `scheduling`.
  const busy = state.workers.filter(worker => worker.scheduling
    ? ['working', 'preparing', 'stopping'].includes(worker.scheduling.status) : worker.phase === 'running');
  if (busy.length) return violations;
  const ready = readyResearchTasks(tasks, cooperation.groups);
  if (ready.length) add('quiescent_with_ready_work', 'error', 'No worker is active although tasks are ready.',
    ...ready.map(node => node.task.id));
  else if (tasks.some(node => node.task.kind === 'goal' && !terminal(node)))
    add('quiescent_awaiting_external_input', 'warning',
      'No worker is active and no task is ready; only new outside input can advance the run.',
      ...tasks.filter(node => node.task.kind === 'goal' && !terminal(node)).map(node => node.task.id));
  return violations;
}

import type { LeadPlan } from './cooperationShared';
import type { ProofRoute } from './proofRoutes';
import type { RetiredRoute, RouteRetirement } from './routeControl';
import { taskGroup, type CooperativeTask, type TaskRecord } from './tasks';

export function retireCooperativeRoutes(
  proposal: Pick<LeadPlan, 'tasks' | 'groups' | 'proofRoutes'>,
  current: { tasks: readonly TaskRecord[]; proofRoutes?: readonly ProofRoute[]; retiredRoutes?: readonly RetiredRoute[];
    retiredRouteTasks?: Readonly<Record<string, string>> },
  requested: readonly RouteRetirement[] = [],
  at = Date.now(),
) {
  const routes = new Map((current.retiredRoutes ?? []).map(record => [record.routeId, record]));
  const added: RetiredRoute[] = [];
  for (const request of requested) if (!routes.has(request.routeId)) {
    const record = { ...request, source: 'lead' as const, retiredAt: at };
    routes.set(record.routeId, record);
    added.push(record);
  }
  if (!routes.size) return;

  const survivingRoutes = (proposal.proofRoutes ?? []).filter(route => !routes.has(route.id));
  const branchRoutes = [...current.proofRoutes ?? [], ...proposal.proofRoutes ?? []].filter(route => routes.has(route.id));
  const nodes = new Map([...current.tasks.map(node => node.task), ...proposal.tasks].map(task => [task.id, task]));
  const branchInputs = (ids: readonly string[]) => {
    const inputs = new Set<string>();
    const visit = (id: string) => {
      if (inputs.has(id)) return;
      inputs.add(id);
      nodes.get(id)?.dependsOn.forEach(visit);
    };
    ids.forEach(visit);
    return inputs;
  };
  const protectedInputs = branchInputs([
    ...survivingRoutes.flatMap(route => [route.closingTaskId, ...route.prerequisiteTaskIds]),
    ...proposal.tasks.filter(task => task.kind === 'goal' && !routes.has(taskGroup(task))).flatMap(task => task.dependsOn),
  ]);
  const taskRoutes = new Map(Object.entries(current.retiredRouteTasks ?? {}));
  for (const route of branchRoutes) for (const id of branchInputs([route.closingTaskId, ...route.prerequisiteTaskIds])) {
    // An input on a surviving branch only retires when it belongs to a retired group.
    if (!protectedInputs.has(id) && nodes.get(id)?.kind !== 'goal' && !taskRoutes.has(id)) taskRoutes.set(id, route.id);
  }
  for (const node of current.tasks) {
    const routeId = node.assignment?.routeId;
    if (routeId && routes.has(routeId) && node.task.kind !== 'goal' && !protectedInputs.has(node.task.id) && !taskRoutes.has(node.task.id))
      taskRoutes.set(node.task.id, routeId);
  }
  return {
    retiredRoutes: [...routes.values()], added, retiredRouteTasks: Object.fromEntries(taskRoutes),
    plan: {
      tasks: proposal.tasks,
      groups: proposal.groups.map(group => routes.has(group.id) ? { ...group, status: 'stopped' as const } : group),
      proofRoutes: survivingRoutes.length ? survivingRoutes : undefined,
    },
  };
}

export function retiredCooperativeRoute(task: CooperativeTask,
  state: { retiredRoutes?: readonly RetiredRoute[]; retiredRouteTasks?: Readonly<Record<string, string>> }) {
  const branch = state.retiredRouteTasks && Object.hasOwn(state.retiredRouteTasks, task.id)
    ? state.retiredRouteTasks[task.id] : undefined;
  return state.retiredRoutes?.find(record => record.routeId === taskGroup(task) || record.routeId === branch);
}

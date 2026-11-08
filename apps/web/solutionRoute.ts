/** Recorded work and proof structure share this graph in the workbench and archive. */
export type SolutionRouteStatus = 'passed' | 'failed' | 'running' | 'pending' | 'conditional' | 'human' | 'recorded';
export type SolutionRouteKind = 'problem' | 'plan' | 'task' | 'finding' | 'attempt' | 'check' | 'decision' | 'proof' | 'review' | 'acceptance' | 'outcome' | 'declaration' | 'derivation';
export type SolutionRouteSection = { title: string; text: string; code?: boolean };
export type SolutionRouteNode = {
  id: string; kind: SolutionRouteKind; title: string; status: SolutionRouteStatus;
  summary?: string; sections?: SolutionRouteSection[]; at?: string; taskId?: string;
  /** Opens the existing exact record/source reader. Never executes research. */
  action?: { label: string; target: string };
  source?: { name: string; sha256?: string; commit?: string; line?: number; endLine?: number };
  /** Records attached to this node; expanded in the all-steps graph and in its inspector. */
  parentId?: string;
};
export type SolutionRouteEdge = {
  from: string; to: string; kind: 'dependency' | 'sequence' | 'evidence' | 'decision' | 'integration' | 'reference';
};
export type SolutionRoute = {
  schema: 'theoremos.solution-route.v1'; id: string; title: string; locale: 'zh' | 'en';
  basis: 'recorded' | 'source' | 'explanation'; nodes: SolutionRouteNode[]; edges: SolutionRouteEdge[];
  initial?: string; partial?: boolean;
};
export type SolutionRouteInput = {
  id: string; title: string; locale: 'zh' | 'en'; goal: SolutionRouteNode;
  tasks: (SolutionRouteNode & { dependencies: string[] })[];
  records: SolutionRouteNode[];
  outcome?: SolutionRouteNode; partial?: boolean;
};

/** The task DAG stays distinct from dated work; chronology never becomes a mathematical dependency. */
export function buildSolutionRoute(input: SolutionRouteInput): SolutionRoute {
  const nodes = [input.goal, ...input.tasks.map(({ dependencies: _dependencies, ...node }) => node), ...input.records,
    ...(input.outcome ? [input.outcome] : [])];
  const ids = new Set(nodes.map(node => node.id)), edges: SolutionRouteEdge[] = [];
  const connect = (from: string, to: string, kind: SolutionRouteEdge['kind']) => {
    if (from !== to && ids.has(from) && ids.has(to) && !edges.some(edge => edge.from === from && edge.to === to && edge.kind === kind))
      edges.push({ from, to, kind });
  };
  for (const task of input.tasks) {
    const dependencies = task.dependencies.filter(id => ids.has(id));
    if (!dependencies.length) connect(input.goal.id, task.id, 'sequence');
    for (const id of dependencies) connect(id, task.id, 'dependency');
  }
  const lanes = new Map<string, SolutionRouteNode[]>();
  for (const record of input.records) {
    const owner = record.parentId && ids.has(record.parentId) ? record.parentId : input.goal.id;
    const lane = lanes.get(owner) ?? []; lane.push(record); lanes.set(owner, lane);
    connect(owner, record.id, record.kind === 'decision' ? 'decision' : 'evidence');
  }
  for (const lane of lanes.values()) {
    lane.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
    for (let index = 1; index < lane.length; index++) connect(lane[index - 1].id, lane[index].id, 'sequence');
  }
  if (input.outcome) {
    const consumed = new Set(input.tasks.flatMap(task => task.dependencies));
    const leaves = input.tasks.filter(task => !consumed.has(task.id));
    for (const task of leaves) connect(task.id, input.outcome.id, 'integration');
    if (!leaves.length) connect(input.goal.id, input.outcome.id, 'sequence');
    for (const record of input.records.filter(node => !node.parentId && ['proof', 'review', 'acceptance'].includes(node.kind)))
      connect(record.id, input.outcome.id, 'evidence');
  }
  return { schema: 'theoremos.solution-route.v1', id: input.id, title: input.title, locale: input.locale, basis: 'recorded',
    nodes, edges, initial: input.goal.id, ...(input.partial ? { partial: true } : {}) };
}

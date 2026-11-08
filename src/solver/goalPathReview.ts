import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import { splitStatement, type StatementShape } from './theoremKnowledgeGoal';
import { buildProofContinuation, createRecordedTaskSettlement, recordedTaskProofStatus } from './progress';
import type { ProofRoute } from './proofRoutes';
import type { ProjectionDependencyConnection } from './projectionDependencyHints';
import { allRoutesParked, assumableLemma, groupOpen, isAdvisoryTask, isDefinitionTask, taskGroup, taskVersion,
  type RouteRecord, type TaskRecord } from './tasks';

export { splitStatement, type StatementShape } from './theoremKnowledgeGoal';

/**
 * Original-goal path review. The proof-continuation frontier lists the nearest unfinished inputs of each goal;
 * this review adds whether any of them can currently run. A goal whose whole frontier is paused, stopped, closed,
 * blocked, parked or missing cannot progress without a planning decision, however busy the other workers are.
 * Everything here is recorded planning state; nothing is replayed or accepted.
 */
export type GoalPathState = 'runnable' | 'in-progress' | 'paused' | 'stopped' | 'route-closed' | 'blocked' | 'parked' | 'missing';
export type GoalPathCandidateAction = 'resume' | 'reopen-route' | 'revise' | 'add-task' | 'connect' | 'assume' | 'decompose';
export type GoalPathCandidate = {
  /** Stable within one review: action:taskId, plus :relatedTaskId for connect. Task ids never contain a colon. */
  id: string; action: GoalPathCandidateAction; taskId: string; detail: string;
  /** The host can apply it from its id alone (goalPathDecisions.ts); otherwise the adopting revision writes the change. */
  mechanical: boolean;
  /** connect: checked inputs to add to dependsOn; assume: the consumers to mark conditional:true. */
  relatedTaskIds?: string[]; extraPremises?: string[] };
export type GoalPathNode = { taskId: string; taskDigest: string | null; kind?: TaskRecord['task']['kind'];
  state: GoalPathState; attempts: number; feedbackPreview?: string };
export type GoalPathGoal = { taskId: string; taskDigest: string; closed: boolean; stalled: boolean;
  /** The goal itself, or its route group, is explicitly paused or stopped: set aside by the Lead, so never stalled. */
  deferred: boolean;
  /** Typed tasks planned on any route to this goal, including alternatives; auxiliary totals are not completion. */
  path: { typed: number; checked: number; conditional: number; open: number };
  frontier: GoalPathNode[]; omittedFrontier: number; candidates: GoalPathCandidate[]; omittedCandidates: number };
export type GoalPathReview = { evidence: 'recorded-not-replayed'; acceptance: 'not-assessed';
  goals: GoalPathGoal[]; omittedGoals: number;
  /** Checked typed lemmas no planned route connects to an original goal. */
  offPathChecked: number;
  stalledGoalIds: string[]; stalledTaskIds: string[];
  /** Every task reachable from a stalled goal, the goal included: host scheduling only, never Lead evidence. */
  stalledPathTaskIds: string[];
  /** Exact unbounded stall identity: stalled goals and their full frontier states. Undefined when nothing is stalled. */
  stallDigest?: string };

const goalLimit = 4, frontierLimit = 6, candidateLimit = 8, connectLimit = 2, previewLimit = 200;
const actionOrder: Record<GoalPathCandidateAction, number> = { resume: 0, 'reopen-route': 0, revise: 0, 'add-task': 0,
  connect: 1, assume: 2, decompose: 3 };
const preview = (text: string) => text.length > previewLimit ? text.slice(0, previewLimit - 1) + '…' : text;
const feedbackPreview = (text?: string) => text?.trim() ? preview(text.trim().split('\n').slice(0, 2).join(' / ')) : undefined;

export function reviewGoalPaths(tasks: readonly TaskRecord[], options: {
  groups?: readonly RouteRecord[]; proofRoutes?: readonly ProofRoute[]; environmentDigest?: string;
  /** Skip candidate construction when only the stall identity is needed. */
  candidates?: boolean;
  /** Source-bound missing inputs whose exact declarations have current host acceptance. */
  projectionConnections?: readonly ProjectionDependencyConnection[];
} = {}): GoalPathReview {
  // Host capacity work is advisory scheduling, never part of a planned route.
  tasks = tasks.filter(node => !node.capacityExploration);
  const nodes = new Map(tasks.map(node => [node.task.id, node]));
  const routes = options.proofRoutes ?? tasks.flatMap(node => node.alternativeRoutes ?? []);
  const { settled } = createRecordedTaskSettlement(tasks, { proofRoutes: routes, environmentDigest: options.environmentDigest });
  // Paused or stopped original goals still have a mathematical frontier; their own control is reported as deferred.
  const view = tasks.map(node => node.task.kind === 'goal' ? { ...node, task: { ...node.task, status: 'active' as const } } : node);
  const continuation = buildProofContinuation(view, { proofRoutes: routes, environmentDigest: options.environmentDigest });
  const inputs = (node: TaskRecord) => [...new Set([...node.task.dependsOn, ...routes.filter(route => route.targetTaskId === node.task.id)
    .flatMap(route => [...route.prerequisiteTaskIds, route.closingTaskId])])];
  const consumers = new Map<string, string[]>();
  for (const node of tasks) for (const id of inputs(node)) consumers.set(id, [...consumers.get(id) ?? [], node.task.id]);
  const reachable = (goalId: string) => {
    const seen = new Set<string>();
    const visit = (id: string) => { if (seen.has(id)) return; seen.add(id); const node = nodes.get(id); if (node) inputs(node).forEach(visit); };
    visit(goalId);
    return seen;
  };
  const group = (node: TaskRecord) => options.groups?.find(record => record.group.id === taskGroup(node.task));
  const state = (node: TaskRecord): GoalPathState => {
    if (['running', 'delivered', 'conditional'].includes(node.status) || node.pendingValidation) return 'in-progress';
    const control = node.task.status ?? 'active';
    if (control !== 'active') return control;
    if (options.groups && !groupOpen(group(node))) return 'route-closed';
    if (node.routeParking?.length || allRoutesParked(node)) return 'parked';
    // An invalid type, a blocked attempt, an unsettled completed advisory or an integrated proof without a current receipt.
    return node.status === 'pending' && node.typePreflight?.status !== 'invalid' ? 'runnable' : 'blocked';
  };
  const goalPaths = new Map(continuation.goals.map(goal => [goal.taskId, reachable(goal.taskId)]));
  const onPath = new Set([...goalPaths.values()].flatMap(ids => [...ids]));
  const typed = (node: TaskRecord | undefined): node is TaskRecord => Boolean(node && !isAdvisoryTask(node.task));
  const offPath = tasks.filter(node => node.task.kind === 'lemma' && !onPath.has(node.task.id) && settled(node));
  const statements = new Map<string, ReturnType<typeof splitStatement>>();
  const statement = (node: TaskRecord) => {
    if (!statements.has(node.task.id)) statements.set(node.task.id, node.task.type ? splitStatement(node.task.type) : undefined);
    return statements.get(node.task.id);
  };
  const reviewed = continuation.goals.map(goal => {
    const node = nodes.get(goal.taskId)!, path = [...goalPaths.get(goal.taskId)!].filter(id => id !== goal.taskId).map(id => nodes.get(id))
      .filter(typed);
    const checked = path.filter(item => settled(item)).length;
    const conditional = path.filter(item => !settled(item) && recordedTaskProofStatus(item, options.environmentDigest) === 'conditional').length;
    const closed = settled(node);
    const frontier = [...new Set([...goal.frontier, ...goal.missingDependencies])].sort().map((taskId): GoalPathNode => {
      const item = nodes.get(taskId);
      if (!item) return { taskId, taskDigest: null, state: 'missing', attempts: 0 };
      const itemState = state(item);
      return { taskId, taskDigest: taskVersion(item.task), kind: item.task.kind, state: itemState, attempts: item.attempts,
        ...(['blocked', 'parked'].includes(itemState) && feedbackPreview(item.feedback) ? { feedbackPreview: feedbackPreview(item.feedback) } : {}) };
    });
    // An explicit pause of the goal or its whole route is a decision about this goal; a spent turn cap is not.
    const deferred = (node.task.status ?? 'active') !== 'active' || (group(node)?.group.status ?? 'active') !== 'active';
    const stalled = !closed && !deferred && frontier.length > 0 && !frontier.some(item => ['runnable', 'in-progress'].includes(item.state));
    return { node, closed, deferred, stalled, frontier,
      path: { typed: path.length, checked, conditional, open: path.length - checked - conditional } };
  });
  const candidatesFor = (frontier: readonly GoalPathNode[], pathIds: ReadonlySet<string>) => {
    const result: GoalPathCandidate[] = [];
    const add = (candidate: Omit<GoalPathCandidate, 'id' | 'mechanical'>, mechanical = false) => {
      const id = [candidate.action, candidate.taskId, ...(candidate.action === 'connect' ? candidate.relatedTaskIds! : [])].join(':');
      if (!result.some(item => item.id === id)) result.push({ id, ...candidate, mechanical });
    };
    for (const item of frontier) {
      const node = nodes.get(item.taskId);
      if (item.state === 'paused' || item.state === 'stopped')
        add({ action: 'resume', taskId: item.taskId, detail: `Set status "active" in a plan revision if this ${item.state} input is still intended; otherwise replace it on the route.` }, true);
      else if (item.state === 'route-closed') {
        // Reactivating a paused or stopped group is mechanical; a spent turn cap needs a new budget.
        const record = group(node!);
        add({ action: 'reopen-route', taskId: item.taskId, detail: `Route group "${taskGroup(node!.task)}" is not active or has spent its turn cap; reactivate or raise its budget, or move this input to an open group.` },
          Boolean(record && record.group.status !== 'active' && record.turns < (record.group.maxTurns ?? Infinity)));
      } else if (item.state === 'parked')
        add({ action: 'revise', taskId: item.taskId, detail: 'A recorded blocker parks this input; change a relevant mathematical input or assign a discriminating check.' });
      else if (item.state === 'blocked')
        add({ action: 'revise', taskId: item.taskId, detail: 'Its current attempt or type check is blocked; revise its contract from the feedback, or split it.' });
      else if (item.state === 'missing')
        add({ action: 'add-task', taskId: item.taskId, detail: 'A planned input names no task; add it or remove the reference.' });
      if (node && ['blocked', 'parked'].includes(item.state) && node.proof?.passed === false &&
          node.proof.taskDigest === item.taskDigest && !node.task.familyMember) {
        for (const connection of options.projectionConnections ?? []) {
          const dependency = nodes.get(connection.dependency.taskId);
          if (connection.consumer.taskId !== item.taskId || connection.consumer.taskDigest !== item.taskDigest ||
              !dependency || connection.dependency.taskDigest !== taskVersion(dependency.task) ||
              !settled(dependency) || node.task.dependsOn.includes(dependency.task.id)) continue;
          add({ action: 'connect', taskId: item.taskId, relatedTaskIds: [dependency.task.id],
            detail: `The failed projection removed ${connection.hint.root.name}, reached through ${connection.hint.path.slice(1).map(part => part.name).join(' → ')}. ` +
              `Its exact current declaration has host acceptance as ${dependency.task.id}; add that task to dependsOn, then recheck this input.` }, true);
        }
      }
      if (!node || node.task.kind !== 'lemma' || isDefinitionTask(node.task)) continue;
      const target = statement(node);
      if (target) for (const match of offPath.map(candidate => ({ candidate, cover: statementCover(target, statement(candidate)) }))
        .filter(entry => entry.cover).slice(0, connectLimit)) {
        const extra = match.cover!;
        // A family member's inputs belong to its family task, so connecting one is the Lead's edit there.
        add({ action: 'connect', taskId: item.taskId, relatedTaskIds: [match.candidate.task.id],
          ...(extra.length ? { extraPremises: extra.slice(0, 2).map(preview) } : {}),
          detail: extra.length
            ? `Checked off-path lemma ${match.candidate.task.id} has this conclusion under ${extra.length} extra premise(s); add it and typed tasks for those premises to dependsOn, with conditional:true for an early check.`
            : `Checked off-path lemma ${match.candidate.task.id} states the same proposition; prove this input from it or route through it.` },
          !extra.length && !node.task.familyMember);
      }
      if (assumableLemma(node.task)) {
        const open = (consumers.get(item.taskId) ?? []).filter(id => pathIds.has(id) && nodes.get(id)?.task.kind === 'lemma' &&
          !nodes.get(id)!.task.conditional && !nodes.get(id)!.task.familyMember && !settled(nodes.get(id)));
        if (open.length) add({ action: 'assume', taskId: item.taskId, relatedTaskIds: open.slice(0, 4),
          detail: 'Mark these consumers conditional:true to check the rest of the route with this statement as a fixed premise; the goal then closes only conditionally.' }, true);
      }
      add({ action: 'decompose', taskId: item.taskId, detail: 'Split it into weaker typed lemmas, each with a recorded consumer.' });
    }
    return result.map((candidate, index) => ({ candidate, index }))
      .sort((a, b) => actionOrder[a.candidate.action] - actionOrder[b.candidate.action] || a.index - b.index).map(entry => entry.candidate);
  };
  const stalledGoals = reviewed.filter(goal => goal.stalled);
  const stallDigest = stalledGoals.length ? mathDigest(canonicalMathJson(stalledGoals.map(goal => ({ goalId: goal.node.task.id,
    goalDigest: taskVersion(goal.node.task), frontier: goal.frontier.map(({ taskId, taskDigest, state, attempts }) => ({ taskId, taskDigest, state, attempts,
      feedbackDigest: nodes.get(taskId)?.feedback ? mathDigest(nodes.get(taskId)!.feedback!) : null })) })))) : undefined;
  // Stalled goals first: they are the ones a planning decision must answer.
  const ordered = [...stalledGoals, ...reviewed.filter(goal => !goal.stalled)];
  return { evidence: 'recorded-not-replayed', acceptance: 'not-assessed',
    goals: ordered.slice(0, goalLimit).map(goal => {
      const candidates = goal.stalled && options.candidates !== false ? candidatesFor(goal.frontier, goalPaths.get(goal.node.task.id)!) : [];
      return { taskId: goal.node.task.id, taskDigest: taskVersion(goal.node.task), closed: goal.closed, stalled: goal.stalled,
        deferred: goal.deferred, path: goal.path,
        frontier: goal.frontier.slice(0, frontierLimit), omittedFrontier: Math.max(0, goal.frontier.length - frontierLimit),
        candidates: candidates.slice(0, candidateLimit), omittedCandidates: Math.max(0, candidates.length - candidateLimit) };
    }),
    omittedGoals: Math.max(0, ordered.length - goalLimit), offPathChecked: offPath.length,
    stalledGoalIds: stalledGoals.map(goal => goal.node.task.id),
    stalledTaskIds: [...new Set(stalledGoals.flatMap(goal => goal.frontier.map(item => item.taskId)))].sort(),
    stalledPathTaskIds: [...new Set(stalledGoals.flatMap(goal => [...goalPaths.get(goal.node.task.id)!]))].sort(),
    ...(stallDigest ? { stallDigest } : {}) };
}

/**
 * When `candidate` has the target's conclusion and every target binder and premise, return the candidate's
 * remaining premises (possibly none); otherwise undefined.
 */
export function statementCover(target: StatementShape | undefined, candidate: StatementShape | undefined): string[] | undefined {
  if (!target || !candidate || target.conclusion !== candidate.conclusion) return;
  const pool = new Map<string, number>();
  for (const part of candidate.parts) pool.set(part.key, (pool.get(part.key) ?? 0) + 1);
  for (const part of target.parts) {
    const count = pool.get(part.key) ?? 0;
    if (!count) return;
    pool.set(part.key, count - 1);
  }
  const extra: string[] = [];
  for (const part of candidate.parts) {
    const count = pool.get(part.key) ?? 0;
    if (!count) continue;
    pool.set(part.key, count - 1);
    if (!part.binder) extra.push(part.text);
  }
  return extra;
}

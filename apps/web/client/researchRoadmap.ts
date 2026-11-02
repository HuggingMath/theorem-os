import { localizeText, t } from '../i18n';
import type { WebInspectedTask } from '../collaboration';
import type { WebRunStatus } from '../shared';
import { trajectoryLimits, type TrajectoryPlanItem } from '../trajectory';
import { leanTheoremTypeLookup } from './leanTheoremType';
import type { TrajectoryData, TrajectoryOutcome, TrajectoryStep } from './trajectory';

export type RoadmapNode = {
  id: string; kind: 'problem' | 'plan' | 'task' | 'guidance' | 'proof' | 'review' | 'evaluation' | 'end';
  status: 'passed' | 'failed' | 'conditional' | 'running' | 'pending' | 'human' | 'muted';
  title: string; workerId?: string; taskId?: string; stepIndexes: number[]; detail?: string;
  attempts?: { number: number; outcome: TrajectoryOutcome; stepIndex: number }[]; at?: number;
  taskKind?: WebInspectedTask['kind']; theoremName?: string; statement?: string; type?: string; objective?: string;
  guidanceText?: string;
};
export type RoadmapEdge = {
  id: string; from: string; to: string; kind: 'flow' | 'assignment' | 'dependency' | 'guidance' | 'integration'; active: boolean;
};
export type ResearchRoadmap = { nodes: RoadmapNode[]; edges: RoadmapEdge[]; partial: boolean };
export type ResearchRoadmapInput = {
  data: TrajectoryData; steps: readonly TrajectoryStep[]; status: WebRunStatus; tasks: ReadonlyMap<string, string>;
  taskDetails?: readonly Pick<WebInspectedTask, 'id' | 'kind' | 'theorem' | 'type' | 'informalStatement' | 'objective'>[];
  originalSource?: string;
};

const taskKey = (id: string) => `task:${id}`;
const reviewKey = (id: string) => `review:${id}`;
const at = (value: string | number) => typeof value === 'number' ? value : Date.parse(value);
const outcomeText = (outcome: TrajectoryOutcome) => outcome === 'passed' ? t('通过') : outcome === 'failed' ? t('未通过')
  : outcome === 'conditional' ? t('有条件通过') : t('进行中');
const reviewStatus = (status: string): RoadmapNode['status'] => status === 'accepted' ? 'passed'
  : status === 'changes_requested' || status === 'failed' ? 'failed' : status === 'superseded' ? 'muted' : 'pending';

/**
 * A visual account of recorded work. Assignment and integration lines describe the collaboration; only the latest
 * plan's dependsOn makes a dependency line. Local checks and reviews never stand in for independent acceptance.
 * Step indexes refer to the caller's original array so every recorded node can open the existing detail reader.
 */
export function buildResearchRoadmap(input: ResearchRoadmapInput): ResearchRoadmap {
  const { data, steps, status, tasks } = input, running = status === 'running';
  const taskDetails = new Map(input.taskDetails?.map(item => [item.id, item]));
  const originalType = input.originalSource ? leanTheoremTypeLookup(input.originalSource) : undefined;
  const nodes: RoadmapNode[] = [], byId = new Map<string, RoadmapNode>();
  const add = (node: RoadmapNode) => { nodes.push(node); byId.set(node.id, node); return node; };
  const indexes = (kind: TrajectoryStep['kind']) => steps.flatMap((step, index) => step.kind === kind ? [index] : []);
  const reference = (node: RoadmapNode, index: number) => { if (!node.stepIndexes.includes(index)) node.stepIndexes.push(index); };
  const plans = [...data.plans.values()].sort((a, b) => a.observation - b.observation);
  const current = new Map<string, TrajectoryPlanItem>(), removed = new Set<string>();
  for (const plan of plans) {
    for (const item of [...plan.added, ...plan.changed.map(change => change.after)]) { current.set(item.id, item); removed.delete(item.id); }
    for (const item of plan.removed) { current.delete(item.id); removed.add(item.id); }
  }
  const planSteps = steps.flatMap((step, index) => step.kind === 'plan' || step.kind === 'approval' || step.kind === 'edit' ? [index] : []);
  const problemIndexes = indexes('problem');
  add({ id: 'problem', kind: 'problem', title: t('原题'), status: 'muted', stepIndexes: problemIndexes,
    at: problemIndexes.length ? steps[problemIndexes[0]!]!.at : undefined });
  const lead = data.context.workers.find(worker => worker.role === 'lead')?.id;
  const approval = steps.findLast(step => step.kind === 'approval');
  if (plans.length || planSteps.length) add({ id: 'plan', kind: 'plan', title: t('研究计划'), workerId: lead,
    status: approval?.kind === 'approval' && approval.event.type !== 'plan_approved' ? 'human' : 'muted', stepIndexes: planSteps,
    at: planSteps.length ? steps[planSteps[0]!]!.at : plans[0]?.at,
    detail: approval?.kind === 'approval' ? approval.event.type === 'plan_approved' ? t('你批准了研究计划，Agent 开始工作')
      : approval.event.type === 'plan_approval_requested' ? t('研究计划等你批准') : t('运行结束时研究计划仍未批准') : undefined });

  const task = (id: string) => {
    let node = byId.get(taskKey(id));
    if (!node) {
      const item = current.get(id), latest = taskDetails.get(id), name = tasks.get(id);
      const theoremName = latest?.theorem ?? item?.name, objective = latest?.objective ?? item?.objective;
      const taskKind = latest?.kind ?? item?.kind;
      const statement = latest?.informalStatement;
      const repeatsObjective = statement?.trim().replace(/\s+/gu, ' ') === objective?.trim().replace(/\s+/gu, ' ');
      node = add({ id: taskKey(id), kind: 'task', title: theoremName?.split('.').at(-1) || (name && name !== id ? name : objective || id),
        taskId: id, status: 'pending', detail: t('待调度'), stepIndexes: [], attempts: [],
        taskKind, theoremName, objective,
        type: latest?.type ?? (taskKind === 'goal' && theoremName ? originalType?.(theoremName) : undefined),
        statement: statement?.trim() && !repeatsObjective ? statement : undefined });
    }
    return node;
  };
  for (const id of current.keys()) task(id);
  // An observation can name a newly planned task before the incremental trajectory reader has caught up.
  for (const id of taskDetails.keys()) task(id);
  const checkedAt = new Map<string, number>(), latestWorkAt = new Map<string, number>(), integratedAt = new Map<string, number>();
  const integrated = new Set<string>();
  const remember = (times: Map<string, number>, id: string, time: number) => times.set(id, Math.max(times.get(id) ?? -Infinity, time));
  const checked = (id: string, outcome: TrajectoryOutcome, time: number, index: number, detail?: string) => {
    const node = task(id); reference(node, index);
    if (time < (checkedAt.get(id) ?? -Infinity)) return;
    checkedAt.set(id, time); node.status = outcome; node.detail = detail ?? outcomeText(outcome); node.at = time;
  };
  steps.forEach((step, index) => {
    if (step.kind === 'attempt') {
      const node = task(step.taskId); reference(node, index);
      if (!step.reused) {
        node.attempts!.push({ number: step.number, outcome: step.outcome, stepIndex: index });
        remember(latestWorkAt, step.taskId, step.at);
      }
      if (step.workerId) node.workerId = step.workerId;
      checked(step.taskId, step.outcome, step.at, index, step.ref?.check?.headline);
      if (step.integrated) remember(integratedAt, step.taskId, step.at);
    } else if (step.kind === 'recheck' || step.kind === 'edit') {
      for (const result of step.results) {
        const time = result.ref?.check?.at ?? step.at;
        checked(result.taskId, result.passed ? result.conditional ? 'conditional' : 'passed' : 'failed', time, index, result.ref?.check?.headline);
        remember(latestWorkAt, result.taskId, time);
      }
    } else if (step.kind === 'delivery' && step.delivery.taskId) {
      reference(task(step.delivery.taskId), index);
    }
  });
  steps.forEach((step, index) => {
    const plan = step.kind === 'plan' ? step.plan : step.kind === 'edit' ? step.plan : undefined;
    if (!plan) return;
    for (const item of [...plan.added, ...plan.changed.map(change => change.after), ...plan.removed]) {
      const node = byId.get(taskKey(item.id));
      if (node) { reference(node, index); node.at ??= step.at; }
    }
  });
  const deliveredAt = new Map<string, number>();
  for (const delivery of [...data.deliveries.values()].sort((a, b) => a.createdAt - b.createdAt)) {
    if (delivery.kind !== 'research' || !delivery.taskId || !['advisory', 'conditional'].includes(delivery.status)) continue;
    deliveredAt.set(delivery.taskId, delivery.createdAt);
    const node = task(delivery.taskId); node.workerId ??= delivery.producer;
    // A research finding has been delivered; its advisory status is not evidence of a checked proof or completion.
    if (!checkedAt.has(delivery.taskId)) {
      node.status = delivery.status === 'conditional' ? 'conditional' : 'muted'; node.detail = t('已交付'); node.at = delivery.createdAt;
    }
  }
  const assignments = data.events.filter(event => event.type === 'task_assigned' && event.details?.taskId && event.details.workerId);
  for (const event of data.events) {
    const id = event.details?.taskId;
    if (event.type === 'task_assigned' && id && event.details?.workerId) {
      const node = task(id); node.workerId = event.details.workerId;
      if (running && at(event.at) > Math.max(checkedAt.get(id) ?? -Infinity, deliveredAt.get(id) ?? -Infinity)) { node.status = 'running'; node.detail = t('进行中'); }
    }
    if (id && (event.type === 'task_integrated' || event.type === 'task_recheck_finished' && event.details?.passed))
      remember(integratedAt, id, at(event.at));
    if (event.type === 'task_recheck_dependency_invalidated' && id && at(event.at) >= (checkedAt.get(id) ?? -Infinity)) {
      const node = task(id); node.status = 'pending'; node.detail = t('未验证');
    }
  }
  for (const step of steps) if (step.kind === 'live' && running) for (const worker of step.workers) if (worker.task) {
    const node = task(worker.task); node.workerId = worker.id; node.status = 'running'; node.detail = t('进行中');
  }
  for (const node of nodes) if (node.kind === 'task') {
    const item = current.get(node.taskId!);
    if (removed.has(node.taskId!)) { node.status = 'muted'; node.detail = t('已移除'); }
    else if (item?.status === 'paused' || item?.status === 'stopped') { node.status = 'muted'; node.detail = item.status === 'paused' ? t('已暂停') : t('已停止'); }
    // A previous version's integration does not integrate a newer attempt. Reusing its check creates no new work.
    const time = integratedAt.get(node.taskId!);
    if ((node.status === 'passed' || node.status === 'conditional') && time !== undefined && time >= (latestWorkAt.get(node.taskId!) ?? -Infinity))
      integrated.add(node.taskId!);
  }

  const proofIndexes = indexes('proof'), lastProofIndex = proofIndexes.at(-1), lastProof = lastProofIndex === undefined ? undefined : steps[lastProofIndex];
  const assembly = data.events.findLast(event => event.type === 'assembly_started');
  const proofStatus: RoadmapNode['status'] = running && assembly && at(assembly.at) > (lastProof?.at ?? -Infinity) ? 'running'
    : lastProof?.kind === 'proof' ? lastProof.outcome : 'pending';
  add({ id: 'proof', kind: 'proof', title: current.size || lastProof?.kind === 'proof' && lastProof.assembled ? t('组装完整证明') : t('完整证明'),
    status: proofStatus, workerId: lastProof?.kind === 'proof' ? lastProof.workerId ?? lead : lead, stepIndexes: proofIndexes,
    at: lastProof?.at ?? (assembly ? at(assembly.at) : undefined), detail: proofStatus === 'pending' ? t('尚无证明') : outcomeText(proofStatus) });

  const reviewEvents = data.events.filter(event => (event.type === 'review_assigned' || event.type === 'review_completed') && event.details?.workerId);
  const reviewAssignments = reviewEvents.filter(event => event.type === 'review_assigned');
  const reviewDeliveries = [...data.deliveries.values()].filter(delivery => delivery.kind === 'review').sort((a, b) => a.createdAt - b.createdAt);
  const latestReview = new Map<string, number>();
  const reviewer = (workerId: string) => {
    let node = byId.get(reviewKey(workerId));
    if (!node) {
      const role = data.context.workers.find(worker => worker.id === workerId)?.role;
      node = add({ id: reviewKey(workerId), kind: 'review', title: t('审阅意见'), workerId, status: 'pending', stepIndexes: [],
        detail: role && role !== 'reviewer' ? `${role[0]!.toUpperCase()}${role.slice(1)} → Reviewer` : 'Reviewer' });
    }
    return node;
  };
  // Stable lanes belong to worker identities, including when a page has only a completed review or its delivery.
  const reviewIds = new Set([...reviewEvents.map(event => event.details!.workerId!), ...reviewDeliveries.map(delivery => delivery.producer),
    ...steps.flatMap(step => step.kind === 'delivery' && step.delivery.kind === 'review' ? [step.delivery.producer] : [])]);
  for (const id of [...reviewIds].sort()) reviewer(id);
  for (const event of reviewEvents) reviewer(event.details!.workerId!).at ??= at(event.at);
  for (const event of reviewAssignments) {
    const id = event.details!.workerId!, node = reviewer(id), time = at(event.at);
    latestReview.set(id, time); node.at = time; node.status = running ? 'running' : 'pending';
  }
  // Review events contain no verdict in the Web projection; only its saved delivery carries the conclusion.
  for (const delivery of reviewDeliveries) {
    const node = reviewer(delivery.producer);
    if (delivery.createdAt >= (latestReview.get(delivery.producer) ?? -Infinity)) { node.status = reviewStatus(delivery.status); node.at = delivery.createdAt; }
  }
  steps.forEach((step, index) => {
    if (step.kind === 'delivery' && step.delivery.kind === 'review') reference(reviewer(step.delivery.producer), index);
    else if (step.kind === 'notice' && (step.event.type === 'review_assigned' || step.event.type === 'review_completed') && step.event.details?.workerId)
      reference(reviewer(step.event.details.workerId), index);
  });

  const evaluationIndexes = indexes('evaluation'), lastEvaluationIndex = evaluationIndexes.at(-1);
  const evaluation = lastEvaluationIndex === undefined ? undefined : steps[lastEvaluationIndex];
  // `completed` means the host stopped. It says nothing about the independent evaluator's result.
  const evaluationStatus: RoadmapNode['status'] = evaluation?.kind !== 'evaluation' ? 'pending'
    : evaluation.status === 'passed' && evaluation.outcome === 'passed' ? 'passed'
    : evaluation.status === 'failed' || evaluation.status === 'error' ? 'failed'
    : evaluation.outcome === 'running' && running ? 'running' : 'pending';
  add({ id: 'evaluation', kind: 'evaluation', title: t('独立验收完整原题'), status: evaluationStatus, stepIndexes: evaluationIndexes,
    at: evaluation?.at, detail: evaluationStatus === 'passed' ? t('通过') : evaluationStatus === 'failed' ? t('未通过')
      : evaluationStatus === 'running' ? t('验收中') : status === 'completed' || status === 'error' || status === 'cancelled' ? t('未记录') : t('等待验收') });

  const endIndexes = steps.flatMap((step, index) => step.kind === 'stop' || step.kind === 'end' ? [index] : []);
  if (endIndexes.length) {
    const last = steps[endIndexes.at(-1)!]!;
    add({ id: 'end', kind: 'end', title: status === 'cancelled' ? t('运行已取消') : status === 'error' ? t('运行失败') : t('运行结束'),
      status: status === 'error' ? 'failed' : 'muted', stepIndexes: endIndexes, at: last.at });
  }

  const edges: RoadmapEdge[] = [];
  const connect = (from: string, to: string, kind: RoadmapEdge['kind'], active: boolean) => {
    if (!byId.has(from) || !byId.has(to) || from === to) return;
    const id = `${kind}:${from}->${to}`;
    if (!edges.some(edge => edge.id === id)) edges.push({ id, from, to, kind, active });
  };
  if (byId.has('plan')) connect('problem', 'plan', 'flow', true);
  const taskNodes = nodes.filter(node => node.kind === 'task');
  for (const node of taskNodes) {
    connect(byId.has('plan') ? 'plan' : 'problem', node.id, 'assignment', assignments.some(event => event.details?.taskId === node.taskId));
    connect(node.id, 'proof', 'integration', integrated.has(node.taskId!));
  }
  for (const item of current.values()) for (const dependency of item.dependsOn)
    connect(taskKey(dependency), taskKey(item.id), 'dependency', true);
  if (!taskNodes.length) connect(byId.has('plan') ? 'plan' : 'problem', 'proof', 'flow', proofStatus !== 'pending');
  const reviews = nodes.filter(node => node.kind === 'review');
  for (const node of reviews) { connect('proof', node.id, 'flow', true); connect(node.id, 'evaluation', 'flow', evaluationIndexes.length > 0); }
  if (!reviews.length) connect('proof', 'evaluation', 'flow', evaluationIndexes.length > 0);
  if (endIndexes.length) connect('evaluation', 'end', 'flow', evaluationStatus !== 'pending');

  // Worker/Lead guidance joins the work that worker actually held at delivery time. Task guidance keeps its explicit
  // task target. An undelivered line is a destination, and is deliberately inactive.
  const workerTarget = (workerId: string, time: number) => {
    const assignment = assignments.findLast(event => event.details?.workerId === workerId && at(event.at) <= time);
    const review = reviewAssignments.findLast(event => event.details?.workerId === workerId && at(event.at) <= time);
    if (review && (!assignment || at(review.at) > at(assignment.at))) return reviewKey(workerId);
    if (assignment) return taskKey(assignment.details!.taskId!);
    if (workerId === lead) return byId.has('plan') && (!lastProof || time < lastProof.at) ? 'plan' : 'proof';
    return byId.has(reviewKey(workerId)) ? reviewKey(workerId) : undefined;
  };
  for (const guidance of data.guidance.values()) {
    const stepIndexes = steps.flatMap((step, index) => step.kind === 'guidance' && step.guidance.id === guidance.id ? [index] : []);
    const delivered = guidance.status === 'delivered', recipients = delivered ? guidance.deliveredTo ?? [] : [];
    const node = add({ id: `guidance:${guidance.id}`, kind: 'guidance', title: t('你的指导'), status: guidance.status === 'failed' ? 'failed' : delivered ? 'human' : 'pending',
      taskId: guidance.recipient.kind === 'task' ? guidance.recipient.id : guidance.taskRef?.id,
      workerId: recipients[0] ?? (guidance.recipient.kind === 'worker' ? guidance.recipient.id : undefined), stepIndexes, at: at(guidance.createdAt),
      detail: delivered ? t('已送达') : guidance.status === 'queued' ? t('排队中') : guidance.status === 'deferred' ? t('暂缓') : t('失败'),
      guidanceText: guidance.text });
    const time = at(guidance.updatedAt), explicit = guidance.recipient.kind === 'task' ? guidance.recipient.id : undefined;
    if (explicit) connect(node.id, taskKey(explicit), 'guidance', delivered);
    else if (delivered && recipients.length) for (const recipient of recipients) {
      const target = workerTarget(recipient, time); if (target) connect(node.id, target, 'guidance', true);
    } else {
      const recipient = guidance.recipient.kind === 'worker' ? guidance.recipient.id : lead;
      const target = recipient ? workerTarget(recipient, time) : byId.has('plan') ? 'plan' : 'proof';
      if (target) connect(node.id, target, 'guidance', false);
    }
  }
  // Source text is only a fallback label; generated interface text above always goes through t().
  for (const node of nodes) {
    if (node.kind === 'task') node.title = localizeText(node.title);
    node.stepIndexes.sort((a, b) => a - b);
  }
  return { nodes, edges, partial: Object.values(data.dropped).some(Boolean) || plans.some(plan => plan.omitted > 0)
    || data.versions.size >= trajectoryLimits.versions || [...data.versions.values()].some(version => version.checks.length >= trajectoryLimits.checks) };
}

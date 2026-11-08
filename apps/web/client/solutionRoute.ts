import type { WebInspectedTask, WebProofRoute } from '../collaboration';
import { locale, localizeText, t } from '../i18n';
import type { WebRunStatus } from '../shared';
import type { SolutionRoute, SolutionRouteEdge, SolutionRouteNode, SolutionRouteSection, SolutionRouteStatus } from '../solutionRoute';
import type { TrajectoryDelivery, TrajectoryPlanItem } from '../trajectory';
import { buildResearchRoadmap, type ResearchRoadmap } from './researchRoadmap';
import { leanTheoremTypeLookup } from './leanTheoremType';
import { proofDeliveryLookup, trajectoryTaskNames, type RecheckResult, type TrajectoryData, type TrajectoryStep } from './trajectory';

type TaskDetail = Pick<WebInspectedTask, 'id' | 'kind' | 'objective'> & Partial<WebInspectedTask>;
export type RecordedSolutionRouteInput = {
  id: string; title?: string; data: TrajectoryData; steps: readonly TrajectoryStep[]; status: WebRunStatus;
  taskDetails?: readonly TaskDetail[]; originalSource?: string;
  problem?: { statement: string; formalStatement: string; assumptions: readonly string[] };
  proofRoutes?: readonly WebProofRoute[];
  coverage?: { sources: 'recorded' | 'partial'; checks: 'recorded' | 'partial' };
  roadmap?: ResearchRoadmap;
};
const label = (zh: string, en: string) => locale === 'en' ? en : zh;
const taskId = (id: string) => `task:${id}`;
const at = (value: number) => Number.isFinite(value) ? new Date(value).toISOString() : undefined;
const section = (title: string, text: string | undefined, code = false): SolutionRouteSection[] =>
  text?.trim() ? [{ title, text, ...(code ? { code: true } : {}) }] : [];
const strings = (items: readonly string[] | undefined) => items?.length ? items.join('\n') : undefined;
const state = (value: string): SolutionRouteStatus => ['passed', 'failed', 'conditional', 'running', 'pending', 'human'].includes(value)
  ? value as SolutionRouteStatus : 'recorded';
const deliveryState = (delivery: TrajectoryDelivery): SolutionRouteStatus => delivery.status === 'verified' || delivery.status === 'accepted' ? 'passed'
  : delivery.status === 'failed' || delivery.status === 'changes_requested' ? 'failed' : delivery.status === 'conditional' ? 'conditional' : 'recorded';
const recordAction = (index: number, source = false) => ({ label: source ? label('打开这一版源码', 'Open this source version') : label('打开保存记录', 'Open saved record'), target: `step:${index}` });
function stepRecordId(step: TrajectoryStep): string {
  const identity = step.kind === 'plan' ? step.plan.observation : step.kind === 'edit' ? step.edit.id
    : step.kind === 'notice' || step.kind === 'stop' || step.kind === 'approval' ? step.event.sequence
    : step.kind === 'attempt' ? `${step.taskId}:${step.ref?.version.commit ?? ''}:${step.reused}:${step.reused ? step.at : step.ref?.check?.at ?? step.at}`
    : step.kind === 'proof' ? `${step.ref?.version.commit ?? ''}:${step.at}` : step.at;
  return `record:${step.kind}:${identity}`;
}
const dependencyText = (delivery: TrajectoryDelivery) => delivery.dependencies?.map(input => `${input.taskId} · ${input.taskDigest}`).join('\n');
function deliverySections(delivery: TrajectoryDelivery): SolutionRouteSection[] {
  return [
    ...section(label('交付内容', 'Delivery'), delivery.summary),
    ...section(label('研究全文', 'Full finding'), delivery.finding && delivery.finding !== delivery.summary ? delivery.finding : undefined),
    ...section(label('声明', 'Statement'), delivery.statement, true),
    ...section(label('使用的前提', 'Premises'), strings(delivery.premises)),
    ...section(label('输入版本', 'Input versions'), dependencyText(delivery), true),
    ...section(label('尚待证明', 'Remaining obligations'), strings(delivery.remainingObligations)),
    ...section(label('证据引用', 'Evidence references'), strings(delivery.evidenceRefs), true),
    ...section(label('实际引用', 'Actual references'), delivery.actualReferences &&
      [...delivery.actualReferences.statement, ...delivery.actualReferences.proof].map(use => `${use.name} · ${use.file}`).join('\n'), true),
    ...section(label('检查回执', 'Check receipts'), strings(delivery.evidence?.verification.results.map(result => result.receiptId)), true),
    ...section(label('任务版本', 'Task version'), delivery.taskDigest, true),
  ];
}
function recheckSections(results: readonly RecheckResult[], names: ReadonlyMap<string, string>): SolutionRouteSection[] {
  return results.flatMap(result => {
    const outcome = result.passed ? result.conditional ? t('有条件通过') : t('通过') : t('未通过');
    const headline = result.ref?.check?.headline;
    return [
      ...section(`${names.get(result.taskId) ?? result.taskId} · ${label('重新检查', 'Recheck')}`, `${outcome}${headline ? `\n${headline}` : ''}`),
      ...section(label('提交版本', 'Commit'), result.ref?.version.commit, true),
      ...section(label('检查回执', 'Check receipts'), strings(result.ref?.check?.receiptIds), true),
    ];
  });
}
function taskSections(item: TrajectoryPlanItem | undefined, detail?: TaskDetail): SolutionRouteSection[] {
  return [
    ...section(label('要解决的问题', 'Objective'), detail?.objective ?? item?.objective),
    ...section(label('数学陈述', 'Mathematical statement'), detail?.informalStatement ?? item?.informalStatement),
    ...section(label('Lean 声明', 'Lean statement'), detail?.type ?? item?.type, true),
    ...section(label('前提', 'Premises'), strings(detail?.premises ?? item?.premises)),
    ...section(label('推导思路', 'Intended argument'), detail?.informalProof ?? item?.informalProof),
    ...section(label('参考资料', 'References'), strings(detail?.citations ?? item?.citations)),
    ...section(label('研究所服务的目标', 'Goals served by this research'), strings(item?.consumerGoalIds)),
    ...section(label('研究发现', 'Finding'), detail?.finding),
    ...section(label('最近的反馈', 'Latest feedback'), detail?.feedback),
  ];
}

/** Every run uses the same projection. Only saved task dependencies become mathematical edges. */
export function recordedSolutionRoute(input: RecordedSolutionRouteInput): SolutionRoute {
  const { data, steps } = input, names = trajectoryTaskNames(data);
  const roadmap = input.roadmap ?? buildResearchRoadmap({ ...input, tasks: names });
  const details = new Map(input.taskDetails?.map(task => [task.id, task]));
  const current = new Map<string, TrajectoryPlanItem>(), history = new Map<string, TrajectoryPlanItem>();
  const snapshots = new Map<string, TrajectoryPlanItem>();
  const plans = [...data.plans.values()].sort((a, b) => a.observation - b.observation);
  for (const plan of plans) {
    for (const item of [...plan.added, ...plan.changed.flatMap(change => [change.before, change.after]), ...plan.removed]) {
      history.set(item.id, item); if (item.taskDigest) snapshots.set(item.taskDigest, item);
    }
    for (const item of [...plan.added, ...plan.changed.map(change => change.after)]) current.set(item.id, item);
    for (const item of plan.removed) current.delete(item.id);
  }
  const nodes: SolutionRouteNode[] = [], edges: SolutionRouteEdge[] = [], byId = new Map<string, SolutionRouteNode>(), edgeIds = new Set<string>();
  const add = (node: SolutionRouteNode) => { if (!byId.has(node.id)) { nodes.push(node); byId.set(node.id, node); } return byId.get(node.id)!; };
  const connect = (from: string, to: string, kind: SolutionRouteEdge['kind']) => {
    const id = `${kind}\0${from}\0${to}`;
    if (from !== to && byId.has(from) && byId.has(to) && !edgeIds.has(id)) { edges.push({ from, to, kind }); edgeIds.add(id); }
  };
  const deliveryFor = proofDeliveryLookup(data.deliveries.values()), matchedDeliveries = new Set<string>();
  const kind = { problem: 'problem', plan: 'plan', task: 'task', guidance: 'decision', proof: 'proof', review: 'review', evaluation: 'acceptance', end: 'outcome' } as const;
  for (const node of roadmap.nodes) {
    const detail = node.taskId ? details.get(node.taskId) : undefined, item = node.taskId ? current.get(node.taskId) ?? history.get(node.taskId) : undefined;
    const stepIndex = node.stepIndexes.at(-1);
    const guidance = node.kind === 'guidance' ? [...data.guidance.values()].find(value => `guidance:${value.id}` === node.id) : undefined;
    add({ id: node.id, kind: kind[node.kind], title: node.title, status: state(node.status), taskId: node.taskId,
      summary: node.kind === 'task' ? node.statement ?? node.type ?? node.objective : node.kind === 'problem' ? input.problem?.statement : guidance?.text ?? node.detail,
      at: node.at === undefined ? undefined : at(node.at),
      sections: node.kind === 'task' ? [
        ...section(label('Lean 名称', 'Lean name'), node.theoremName, true), ...taskSections(item, detail),
        ...(!detail?.type && !item?.type ? section(label('Lean 声明', 'Lean statement'), node.type, true) : []),
      ] : node.kind === 'problem' ? [
        ...section(label('原题', 'Problem'), input.problem?.statement), ...section(label('完整目标', 'Full target'), input.problem?.formalStatement, true),
        ...section(label('假设', 'Assumptions'), strings(input.problem?.assumptions)), ...section(label('要证明的目标', 'Targets'), strings(data.context.targets), true),
      ] : guidance ? [
        ...section(label('你的指导', 'Your guidance'), guidance.text),
        ...section(label('投递状态', 'Delivery status'), node.detail),
        ...section(label('接收者', 'Recipients'), strings(guidance.deliveredTo)),
        ...section(label('针对的任务版本', 'Target task version'), guidance.taskRef?.version, true),
      ] : section(label('保存的状态', 'Recorded status'), node.detail),
      ...(stepIndex === undefined ? node.taskId ? { action: { label: label('打开任务记录', 'Open task record'), target: taskId(node.taskId) } } : {}
        : { action: recordAction(stepIndex) }),
    });
  }
  // A run without a plan still shows every original target, including ones never attempted.
  const sourceType = input.originalSource ? leanTheoremTypeLookup(input.originalSource) : undefined;
  for (const target of data.context.targets) if (!roadmap.nodes.some(node => node.theoremName === target)) {
    const targetType = sourceType?.(target);
    add({ id: `target:${target}`, kind: 'task', title: target.split('.').at(-1) ?? target, status: 'pending',
      sections: [...section(label('目标', 'Target'), target, true), ...section(label('Lean 声明', 'Lean statement'), targetType, true)] });
    connect(byId.has('plan') ? 'plan' : 'problem', `target:${target}`, 'sequence');
  }
  for (const edge of roadmap.edges) {
    if (edge.kind === 'integration' && !edge.active || edge.kind === 'guidance' && !edge.active) continue;
    connect(edge.from, edge.to, edge.kind === 'assignment' || edge.kind === 'flow' ? 'sequence' : edge.kind === 'guidance' ? 'decision' : edge.kind);
  }
  for (const item of current.values()) for (const goal of item.consumerGoalIds ?? []) connect(taskId(item.id), taskId(goal), 'reference');
  const deliverySteps = new Map(steps.flatMap((step, index) => step.kind === 'delivery' ? [[step.delivery.id, index] as const] : []));
  const records = new Map<string, SolutionRouteNode[]>();
  const attach = (node: SolutionRouteNode, parent?: string) => {
    node.parentId = parent && byId.has(parent) ? parent : 'problem'; add(node);
    const lane = records.get(node.parentId) ?? []; lane.push(node); records.set(node.parentId, lane);
    connect(node.parentId, node.id, node.kind === 'decision' ? 'decision' : 'evidence');
  };
  steps.forEach((step, index) => {
    const id = stepRecordId(step);
    const common = { id, at: at(step.at), action: recordAction(index) };
    if (step.kind === 'attempt' || step.kind === 'proof') {
      const proof = step.kind === 'proof', version = step.ref?.version, check = step.ref?.check;
      const delivery = !proof ? deliveryFor(step.taskId, step.ref) : undefined;
      if (delivery) matchedDeliveries.add(delivery.id);
      const snapshot = delivery?.taskDigest ? snapshots.get(delivery.taskDigest) : undefined;
      attach({ ...common, kind: proof ? 'check' : 'attempt', status: step.outcome,
        title: proof ? step.assembled ? t('组装完整证明') : t('完整证明') : `${t('第 {0} 次', step.number)}${step.reused ? ` · ${t('沿用上次检查')}` : ''}`,
        taskId: proof ? undefined : step.taskId, summary: step.kind === 'attempt' ? step.note ?? check?.headline : check?.headline,
        sections: [
          ...section(label('Agent', 'Agent'), step.workerId),
          ...section(label('检查结论', 'Check result'), check?.headline ?? (step.outcome === 'passed' ? t('Lean 检查通过')
            : step.outcome === 'conditional' ? t('有条件通过：依赖的任务还没有证完') : step.outcome === 'failed' ? t('未通过') : t('检查中'))),
          ...section(label('这一版的声明', 'Statement at this version'), snapshot?.type, true),
          ...section(label('这一版的思路', 'Argument at this version'), snapshot?.informalProof),
          ...(delivery ? deliverySections(delivery) : step.kind === 'attempt' ? section(label('提交说明', 'Submission note'), step.note) : []),
          ...section(label('提交版本', 'Commit'), version?.commit, true),
          ...section(label('检查回执', 'Check receipts'), strings(check?.receiptIds), true),
          ...section(label('上一版', 'Previous version'), step.kind === 'attempt' ? step.previous?.commit : undefined, true),
        ],
        ...(version ? { source: { name: version.file ?? 'Submission.lean', commit: version.commit, sha256: delivery?.sourceDigest }, action: recordAction(index, version.source !== undefined) } : {}),
      }, proof ? 'proof' : taskId(step.taskId));
    } else if (step.kind === 'plan' || step.kind === 'edit') {
      const plan = step.plan;
      attach({ ...common, kind: step.kind === 'edit' ? 'decision' : 'plan', status: step.kind === 'edit' ? step.edit.status === 'rejected' ? 'failed' : 'human' : 'recorded',
        title: step.kind === 'edit' ? t('你修改了计划') : step.first ? t('拟定计划') : t('调整计划'),
        sections: [
          ...section(label('新增任务', 'Added tasks'), plan?.added.map(item => `${item.name ?? item.id}\n${item.type ?? item.objective}\n${item.informalProof ?? ''}`).join('\n\n')),
          ...section(label('修改的任务', 'Changed tasks'), plan?.changed.map(({ before, after }) => `${after.name ?? after.id}\n${before.type ?? before.objective}\n→ ${after.type ?? after.objective}\n${after.informalProof ?? ''}\n${label('依赖', 'Dependencies')}: ${before.dependsOn.join(', ')} → ${after.dependsOn.join(', ')}`).join('\n\n')),
          ...section(label('移除任务', 'Removed tasks'), plan?.removed.map(item => item.name ?? item.id).join('\n')),
          ...section(label('涉及任务', 'Affected tasks'), step.kind === 'edit' ? strings(step.edit.affectedTasks) : undefined),
          ...(step.kind === 'edit' ? recheckSections(step.results, names) : []),
        ],
      }, 'plan');
      if (step.kind === 'edit') for (const task of step.edit.affectedTasks ?? []) connect(id, taskId(task), 'decision');
    } else if (step.kind === 'recheck') {
      attach({ ...common, kind: 'check', title: t('重新检查'), status: step.results.some(result => !result.passed) ? 'failed' : step.results.some(result => result.conditional) ? 'conditional' : 'passed',
        sections: recheckSections(step.results, names) }, step.results.length === 1 ? taskId(step.results[0]!.taskId) : 'plan');
    } else if (step.kind === 'approval') {
      add({ ...common, kind: 'decision', status: step.event.type === 'plan_approved' ? 'human' : 'pending',
        title: step.event.type === 'plan_approved' ? t('你批准了研究计划，Agent 开始工作') : t('研究计划等你批准'),
        sections: section(label('保存的记录', 'Saved record'), localizeText(step.event.message)) });
      connect('plan', id, 'decision');
    } else if (step.kind === 'evaluation') {
      attach({ ...common, kind: 'acceptance', title: t('独立验收完整原题'), status: step.outcome,
        sections: section(label('独立验收结论', 'Independent acceptance'), step.status ?? t('验收中')) }, 'evaluation');
    } else if (step.kind === 'notice' || step.kind === 'stop' || step.kind === 'end') {
      attach({ ...common, kind: step.kind === 'notice' ? 'finding' : 'outcome', title: step.kind === 'end' ? t('运行结束') : localizeText(step.event.message),
        status: step.kind === 'stop' && step.event.type !== 'cancelled' || step.kind === 'end' && step.status === 'error' ? 'failed' : 'recorded',
        sections: step.kind === 'end' ? [] : section(label('保存的记录', 'Saved record'), localizeText(step.event.message)) },
      step.kind !== 'end' && step.event.details?.taskId ? taskId(step.event.details.taskId) : undefined);
    }
  });
  for (const delivery of data.deliveries.values()) {
    if (matchedDeliveries.has(delivery.id)) continue;
    const stepIndex = deliverySteps.get(delivery.id);
    const node = { id: `delivery:${delivery.id}`, kind: delivery.kind === 'review' || delivery.kind === 'statement-review' ? 'review' as const : 'finding' as const,
      title: delivery.kind === 'review' ? t('审阅意见') : delivery.kind === 'failure' ? t('失败报告') : delivery.kind === 'proof' ? t('完整证明') : t('研究发现'),
      status: deliveryState(delivery), taskId: delivery.taskId, summary: delivery.summary, sections: deliverySections(delivery), at: at(delivery.createdAt),
      ...(stepIndex === undefined ? {} : { action: recordAction(stepIndex) }),
      ...(delivery.commit ? { source: { name: 'Submission.lean', commit: delivery.commit, sha256: delivery.sourceDigest } } : {}) };
    attach(node, delivery.taskId ? taskId(delivery.taskId) : delivery.kind === 'review' ? `review:${delivery.producer}` : undefined);
    for (const dependency of delivery.dependencies ?? []) connect(taskId(dependency.taskId), node.id, 'reference');
  }
  const routes = input.proofRoutes ?? plans.at(-1)?.proofRoutes ?? [];
  for (const route of routes) {
    const target = byId.get(taskId(route.targetTaskId));
    if (target) (target.sections ??= []).push({ title: label('备选证明路线', 'Alternative proof route'),
      text: `${route.id}\n${route.prerequisiteTaskIds.map(id => names.get(id) ?? id).join(' + ')}\n→ ${names.get(route.closingTaskId) ?? route.closingTaskId}` });
    // A planned alternative is a reference until an actual checked integration uses it.
    connect(taskId(route.closingTaskId), taskId(route.targetTaskId), 'reference');
  }
  for (const lane of records.values()) {
    lane.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
    for (let index = 1; index < lane.length; index++) connect(lane[index - 1]!.id, lane[index]!.id, 'sequence');
  }
  return { schema: 'theoremos.solution-route.v1', id: input.id, title: input.title ?? t('解题路线图'), locale, basis: 'recorded', nodes, edges,
    initial: 'problem', ...(roadmap.partial || input.coverage?.sources === 'partial' || input.coverage?.checks === 'partial' ? { partial: true } : {}) };
}

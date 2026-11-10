import type { ResearchBrief, ResearchBriefTask } from '../researchWorkspaceTypes';
import { buildSolutionRoute, type SolutionRoute, type SolutionRouteStatus } from '../solutionRoute';
import type { ResearchProblem, ResearchRouteComparison } from '../researchProblemTypes';

const state = (task: ResearchBriefTask): SolutionRouteStatus => task.checks.some(check => check.passed) ? 'passed'
  : task.proofStatus === 'conditional' ? 'conditional' : task.proofStatus === 'failed' || task.checks.some(check => !check.passed) ? 'failed'
    : ['working', 'running'].includes(task.status) ? 'running' : ['completed', 'integrated', 'done'].includes(task.status) ? 'recorded' : 'pending';
export function problemSolutionRoute(brief: ResearchBrief, language: 'zh' | 'en'): SolutionRoute {
  const tx = (zh: string, en: string) => language === 'en' ? en : zh;
  const model = buildSolutionRoute({ id: `problem:${brief.selectedRunId}`, title: brief.title, locale: language,
    goal: { id: 'problem', kind: 'problem', status: 'recorded', title: tx('原题', 'Problem'), summary: brief.statement,
      sections: [{ title: tx('原题', 'Problem'), text: brief.statement }, { title: 'Lean', text: brief.leanStatement, code: true }] },
    tasks: brief.tasks.map(task => ({ id: `task:${task.id}`, taskId: task.id, kind: 'task', title: task.title,
      status: state(task), summary: task.statement || task.objective, dependencies: task.dependsOn.map(id => `task:${id}`),
      sections: [
        { title: tx('目标', 'Objective'), text: task.objective },
        ...(task.premises.length ? [{ title: tx('前提', 'Premises'), text: task.premises.join('\n') }] : []),
        ...(task.derivation ? [{ title: tx('怎样推出', 'Derivation'), text: task.derivation }] : []),
        ...(task.finding ? [{ title: tx('研究结论', 'Finding'), text: task.finding }] : []),
        ...(task.feedback ? [{ title: tx('反馈与阻碍', 'Feedback and blockers'), text: task.feedback }] : []),
        { title: tx('任务版本', 'Task version'), text: task.version, code: true },
        ...(task.commit ? [{ title: 'Commit', text: task.commit, code: true }] : []),
      ], action: { label: tx('查看任务与源码', 'Open task and source'), target: task.id } })),
    records: [...brief.tasks.flatMap(task => task.checks.map(check => ({ id: `check:${check.id}`, kind: 'check' as const,
      parentId: `task:${task.id}`, status: check.passed ? 'passed' as const : 'failed' as const,
      title: tx('任务检查', 'Task check'), sections: [{ title: tx('检查回执', 'Check receipt'), text: check.id, code: true }],
      action: { label: tx('查看对应源码', 'Open checked source'), target: task.id } }))),
      ...brief.decisions.map(decision => ({ id: `decision:${decision.id}`, kind: 'decision' as const, status: 'human' as const,
        title: decision.kind === 'plan-edit' ? tx('人工修改计划', 'Human plan edit') : decision.kind === 'plan-approval' ? tx('人工批准计划', 'Human plan approval') : tx('人工指导', 'Human guidance'),
        summary: decision.kind === 'plan-edit' ? tx('对保存的研究计划作出修改', 'A recorded change to the research plan') : decision.kind === 'plan-approval' ? tx('批准一个明确版本的研究计划', 'Approval of a specific research plan version') : decision.text,
        sections: [ { title: tx('投递', 'Delivery'), text: decision.delivery }, { title: tx('采纳决定', 'Adoption decision'), text: decision.decision },
          ...(decision.reason ? [{ title: tx('理由', 'Reason'), text: decision.reason }] : []),
          ...(decision.execution ? [{ title: tx('执行', 'Execution'), text: decision.execution }] : []),
          ...(decision.evidenceRefs.length ? [{ title: tx('引用证据', 'Referenced evidence'), text: decision.evidenceRefs.join('\n'), code: true }] : []) ] }))],
    outcome: { id: 'acceptance', kind: 'acceptance', status: brief.accepted ? 'passed' : 'pending',
      title: tx('独立验收', 'Independent acceptance'), summary: brief.accepted ? tx('Lean 陈述证明通过', 'Lean statement accepted') : brief.status,
      sections: [{ title: tx('保存的验收状态', 'Recorded acceptance status'), text: brief.acceptance.status }] },
    partial: !brief.tasks.length });
  for (const route of brief.routes) {
    const add = (from: string, to: string, kind: 'dependency' | 'integration') => {
      if (from !== to && model.nodes.some(node => node.id === from) && model.nodes.some(node => node.id === to)
        && !model.edges.some(edge => edge.from === from && edge.to === to)) model.edges.push({ from, to, kind });
    };
    for (const prerequisite of route.prerequisites) add(`task:${prerequisite}`, `task:${route.closingTaskId}`, 'dependency');
    add(`task:${route.closingTaskId}`, `task:${route.targetTaskId}`, 'integration');
  }
  model.edges = model.edges.filter(edge => edge.kind !== 'sequence' || (!edge.from.startsWith('decision:') && !edge.to.startsWith('decision:')));
  for (const decision of brief.decisions) for (const ref of decision.taskRefs ?? []) {
    if (!brief.tasks.some(task => task.id === ref.id && task.version === ref.version)) continue;
    const kind = ref.relation === 'execution' ? 'decision' as const : 'reference' as const;
    const existing = model.edges.find(edge => edge.from === `decision:${decision.id}` && edge.to === `task:${ref.id}`);
    if (existing) { if (kind === 'decision') existing.kind = kind; }
    else model.edges.push({ from: `decision:${decision.id}`, to: `task:${ref.id}`, kind });
  }
  return model;
}

export type ProblemAttentionItem = {
  id: string; kind: 'approval' | 'dependency' | 'blocker' | 'feedback' | 'handoff' | 'issue' | 'claim';
  title: string; detail: string; owners: { id: string; name: string; kind: 'human' | 'agent' }[];
  taskRef?: { id: string; version: string; commit?: string }; feedbackId?: string; href?: string; action: string;
};
export function problemTaskOwners(problem: ResearchProblem, task: ResearchBriefTask): ProblemAttentionItem['owners'] {
  const humans = (problem.project?.assignments ?? []).filter(item => item.status === 'claimed' && item.continuation?.action !== 'end'
    && item.target.runId === problem.brief.selectedRunId && item.target.taskRef?.id === task.id && item.target.taskRef.version === task.version)
    .map(item => ({ id: item.author.id, name: item.author.displayName, kind: 'human' as const }));
  return [...humans, ...(task.agents ?? []).map(agent => ({ id: agent.id, name: [agent.role, agent.id].filter(Boolean).join(' · '), kind: 'agent' as const }))];
}
/** Summarize existing work; this view owns no additional todo state. */
export function problemAttention(problem: ResearchProblem, language: 'zh' | 'en', selfId?: string): ProblemAttentionItem[] {
  const tx = (zh: string, en: string) => language === 'en' ? en : zh;
  const { brief, project } = problem, items: ProblemAttentionItem[] = [];
  const currentTask = (target: { runId: string; taskRef?: { id: string; version: string } }) => target.runId === brief.selectedRunId
    ? brief.tasks.find(task => task.id === target.taskRef?.id && task.version === target.taskRef.version) : undefined;
  const taskRef = (task: ResearchBriefTask) => ({ id: task.id, version: task.version, commit: task.commit });
  const taskHref = (task: ResearchBriefTask) => project ? `theorems.html?${new URLSearchParams({ id: project.id, run: brief.selectedRunId, task: task.id, taskVersion: task.version })}#collaboration-task-workspace` : task.href;
  if (!brief.accepted && brief.planApproval?.status === 'pending') items.push({ id: 'plan-approval', kind: 'approval', title: tx('研究计划等待你审阅', 'Research plan awaits human review'),
    detail: brief.planApproval.planVersion ?? tx('当前计划', 'Current plan'), owners: [], href: brief.runHref, action: tx('审阅并决定是否执行', 'Review and decide whether to proceed') });
  for (const task of brief.tasks) {
    const dependencies = task.dependsOn.map(id => brief.tasks.find(item => item.id === id)).filter((item): item is ResearchBriefTask => Boolean(item));
    const unresolved = dependencies.filter(item => !item.checks.some(check => check.passed) && !['proved', 'checked'].includes(item.proofStatus)
      && !['completed', 'integrated', 'done'].includes(item.status));
    const missing = task.dependsOn.filter(id => !brief.tasks.some(item => item.id === id));
    if (!brief.accepted && (unresolved.length || missing.length)) {
      const next = unresolved[0];
      items.push({ id: `dependency:${task.id}`, kind: 'dependency', title: tx(`${task.title} 的前置步骤尚待完成`, `Prerequisites for ${task.title} remain open`),
        detail: [...unresolved.map(item => item.title), ...missing.map(id => tx(`${id}（当前记录缺失）`, `${id} (absent from this record)`))].join(tx('；', '; ')),
        owners: problemTaskOwners(problem, next ?? task), taskRef: taskRef(next ?? task), action: next ? tx('查看这个前置步骤', 'Review this prerequisite') : tx('核对依赖记录', 'Review dependency records') });
    }
    const blockers = (brief.blockers ?? []).filter(item => item.taskId === task.id && item.taskVersion === task.version && !['closed', 'superseded', 'resolved'].includes(item.status));
    if (!brief.accepted && (task.feedback || blockers.length || (!task.checks.some(check => check.passed) && (task.proofStatus === 'failed' || task.checks.some(check => !check.passed))))) items.push({ id: `blocker:${task.id}`, kind: 'blocker',
      title: task.title, detail: task.feedback || blockers.map(item => `${item.mechanism} · ${item.status}`).join('\n') || tx('这一版本的证明或检查未通过。', 'The proof or check for this version failed.'),
      owners: problemTaskOwners(problem, task), taskRef: taskRef(task), action: tx('核对推导与检查', 'Review derivation and checks') });
    const humans = problemTaskOwners(problem, task).filter(owner => owner.kind === 'human');
    if (humans.length && !task.checks.some(check => check.passed)) items.push({ id: `claim:${task.id}`, kind: 'claim', title: task.title,
      detail: tx('这一任务版本已有人认领。', 'This task version has been claimed.'), owners: humans, taskRef: taskRef(task), href: taskHref(task), action: tx('打开认领与提交工作区', 'Open claim and submission workspace') });
  }
  for (const feedback of project?.feedback ?? []) {
    if (feedback.target?.runId !== brief.selectedRunId || feedback.kind === 'discussion' || feedback.continuation?.action === 'end' || feedback.supersededBy
      || feedback.execution.status === 'superseded' || feedback.proofCheck?.status === 'superseded') continue;
    const needsInfo = feedback.decision.status === 'needs-info';
    const candidate = feedback.kind === 'proof-submission';
    const needsReview = feedback.candidateDelivery?.status === 'awaiting-review' || Boolean(candidate && feedback.review && feedback.decision.status === 'pending');
    const pending = !candidate && feedback.decision.status === 'pending';
    const newAttempt = feedback.candidateDelivery?.status === 'approved' && feedback.payload && 'base' in feedback.payload && feedback.payload.libraryTrial?.requiresNewAttempt;
    const failed = feedback.delivery.status === 'failed' || feedback.execution.status === 'failed';
    if (!needsInfo && !needsReview && !failed && !pending && !newAttempt) continue;
    const task = currentTask(feedback.target), reviewer = feedback.review?.reviewer ?? (feedback.candidateDelivery?.status === 'awaiting-review' ? project!.owner : undefined);
    items.push({ id: `feedback:${feedback.id}`, kind: 'feedback', title: needsInfo ? tx('评审需要补充信息', 'Review needs more information')
      : needsReview ? tx('候选结果等待评审', 'Candidate awaits review') : newAttempt ? tx('已批准的方案需要新尝试', 'Approved proposal requires a new attempt')
        : pending ? tx('反馈正在等待处理', 'Feedback awaits a response') : tx('反馈执行遇到问题', 'Feedback execution failed'), detail: feedback.decision.reason || feedback.delivery.reason || feedback.text,
      owners: needsInfo ? [{ id: feedback.author.id, name: feedback.author.displayName, kind: 'human' }]
        : reviewer ? [{ id: reviewer.id, name: reviewer.displayName, kind: 'human' }] : pending && task ? problemTaskOwners(problem, task) : [],
      ...(task ? { taskRef: taskRef(task) } : {}), feedbackId: feedback.id,
      href: `problem.html?${new URLSearchParams({ run: brief.selectedRunId, project: project!.id, tab: 'discussion', feedback: feedback.id,
        ...(task ? { task: task.id, taskVersion: task.version, ...(task.commit ? { commit: task.commit } : {}) } : {}) })}#feedback-${feedback.id}`,
      action: needsInfo ? tx('查看意见并补充', 'Read comments and respond') : needsReview ? tx('打开评审记录', 'Open review record')
        : newAttempt ? tx('查看方案并准备新尝试', 'Review proposal and prepare a new attempt') : pending ? tx('查看处理记录', 'Open response record') : tx('查看失败回执', 'Inspect failure record') });
  }
  for (const handoff of problem.collaboration?.handoffs ?? []) {
    if (handoff.status !== 'pending' || handoff.continuation?.action === 'end') continue;
    const task = currentTask(handoff.target); if (!task) continue;
    items.push({ id: `handoff:${handoff.id}`, kind: 'handoff', title: tx('任务交接等待确认', 'Task handoff awaits confirmation'), detail: handoff.note,
      owners: [{ id: handoff.recipient.id, name: handoff.recipient.displayName, kind: 'human' }], taskRef: taskRef(task), href: taskHref(task), action: tx('查看并回应交接', 'Review and respond to handoff') });
  }
  const version = project?.runs.find(binding => binding.runId === brief.selectedRunId)?.statementVersionId;
  for (const issue of problem.collaboration?.issues ?? []) if (issue.status === 'open' && (issue.target ? issue.target.runId === brief.selectedRunId : !issue.statementVersionId || issue.statementVersionId === version)) {
    const task = issue.target ? currentTask(issue.target) : undefined;
    items.push({ id: `issue:${issue.id}`, kind: 'issue', title: issue.title, detail: issue.text, owners: [], ...(task ? { taskRef: taskRef(task) } : {}),
      href: `problem.html?${new URLSearchParams({ run: brief.selectedRunId, project: project!.id, tab: 'discussion' })}#issue-${issue.id}`, action: tx('参与议题并提出方案', 'Join the issue and propose a solution') });
  }
  const rank = (item: ProblemAttentionItem) => {
    if (item.kind === 'approval') return 0;
    const personal = Boolean(selfId && item.owners.some(owner => owner.kind === 'human' && owner.id === selfId));
    if (item.kind === 'feedback') {
      const record = project?.feedback.find(feedback => feedback.id === item.feedbackId);
      return record?.decision.status === 'needs-info' || record?.candidateDelivery?.status === 'awaiting-review' || Boolean(record?.review && record.decision.status === 'pending') ? personal ? 1 : 2 : 4;
    }
    return ({ handoff: personal ? 1 : 3, blocker: 4, dependency: 5, issue: 6, claim: 7 })[item.kind];
  };
  const personal = (item: ProblemAttentionItem) => Number(Boolean(selfId && item.owners.some(owner => owner.kind === 'human' && owner.id === selfId)));
  return items.sort((a, b) => rank(a) - rank(b) || personal(b) - personal(a));
}
const normalized = (value: string) => value.replace(/\r\n?/gu, '\n');
const same = (before: unknown, after: unknown) => JSON.stringify(before) === JSON.stringify(after);
export function compareProblemRoutes(before: ResearchBrief, after: ResearchBrief): ResearchRouteComparison {
  const comparable = Boolean(before.environmentDigest) && before.sourceDigest === after.sourceDigest && before.environment === after.environment
    && before.environmentDigest === after.environmentDigest && normalized(before.statement) === normalized(after.statement)
    && before.formalization?.evidenceDigest === after.formalization?.evidenceDigest;
  const ids = [...new Set([...before.tasks, ...after.tasks].map(task => task.id))];
  const tasks: ResearchRouteComparison['tasks'] = ids.map(id => {
    const a = before.tasks.find(task => task.id === id), b = after.tasks.find(task => task.id === id);
    if (!a || !b) return { id, kind: a ? 'removed' : 'added', changes: [] };
    const changes: ResearchRouteComparison['tasks'][number]['changes'] = [];
    if (!same([a.statement, a.objective, a.premises], [b.statement, b.objective, b.premises])) changes.push('statement');
    if (!same([...a.dependsOn].sort(), [...b.dependsOn].sort())) changes.push('dependencies');
    if (!same([a.derivation, a.finding], [b.derivation, b.finding])) changes.push('derivation');
    if (!same([a.version, a.commit, a.sourceDigest, a.environmentDigest, a.status, a.proofStatus], [b.version, b.commit, b.sourceDigest, b.environmentDigest, b.status, b.proofStatus])) changes.push('proof');
    if (!same(a.checks.map(check => [check.id, check.passed]).sort(), b.checks.map(check => [check.id, check.passed]).sort())) changes.push('checks');
    if (a.feedback !== b.feedback) changes.push('feedback');
    return { id, kind: changes.length ? 'changed' : 'unchanged', changes };
  });
  const edges = (brief: ResearchBrief) => {
    const ids = new Set(brief.tasks.map(task => task.id));
    const values = [...brief.tasks.flatMap(task => task.dependsOn.map(from => ({ from, to: task.id }))),
      ...brief.routes.flatMap(route => [...route.prerequisites.map(from => ({ from, to: route.closingTaskId })),
        { from: route.closingTaskId, to: route.targetTaskId }])].filter(edge => edge.from !== edge.to && ids.has(edge.from) && ids.has(edge.to));
    return values.filter((edge, index) => values.findIndex(value => value.from === edge.from && value.to === edge.to) === index);
  };
  const a = edges(before), b = edges(after);
  const includes = (items: typeof a, edge: typeof a[number]) => items.some(item => item.from === edge.from && item.to === edge.to);
  return { comparable, before, after, tasks: comparable ? tasks : [], edges: comparable ? [
    ...a.map(edge => ({ ...edge, kind: includes(b, edge) ? 'unchanged' as const : 'removed' as const })),
    ...b.filter(edge => !includes(a, edge)).map(edge => ({ ...edge, kind: 'added' as const })),
  ] : [] };
}

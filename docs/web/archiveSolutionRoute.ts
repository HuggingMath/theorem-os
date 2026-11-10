import { buildSolutionRoute, type SolutionRoute, type SolutionRouteNode, type SolutionRouteStatus } from '../../apps/web/solutionRoute';
import type { Locale } from './site';
import type { ArchiveIndexSource, ArchiveProcess, ArchiveRecord, ArchiveSourceRoute } from './types';
import { selectedProofWalkthrough } from './proofWalkthrough';

type Run = ArchiveProcess['runs'][number];
type RouteRecord = Pick<ArchiveRecord, 'id' | 'title' | 'summary' | 'en' | 'status' | 'updatedAt' | 'campaign'> & { sources: ArchiveIndexSource[] };
type SourceFile = ArchiveSourceRoute['files'][number];
const text = (locale: Locale, zh: string, en: string) => locale === 'en' ? en : zh;
const escaped = (value: string) => value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const status = (value?: string): SolutionRouteStatus => ['kernel_verified', 'evaluated_passed', 'passed', 'accepted', 'integrated', 'verified'].includes(value ?? '')
  ? 'passed' : ['failed', 'evaluated_failed', 'runtime_error', 'changes_requested', 'blocked', 'limit_reached'].includes(value ?? '')
    ? 'failed' : ['running', 'researching', 'assigned', 'checking'].includes(value ?? '') ? 'running'
      : value === 'pending' ? 'pending' : value === 'conditional' ? 'conditional' : 'recorded';
const target = (run: Run, node: string, step = '', code?: 'source') => JSON.stringify({ run: run.runId, node, step, ...(code ? { code } : {}) });
const goal = (record: RouteRecord, locale: Locale): SolutionRouteNode => ({ id: 'problem', kind: 'problem', title: record.title,
  status: 'recorded', summary: locale === 'en' ? record.en?.summary ?? record.summary : record.summary,
  sections: [{ title: text(locale, '题目', 'Problem'), text: locale === 'en' ? record.en?.summary ?? record.summary : record.summary }] });

function recordedRoute(record: RouteRecord, process: ArchiveProcess, run: Run, locale: Locale): SolutionRoute {
  const known = new Set(run.tasks.map(task => task.id));
  const owner = (taskId?: string) => taskId && known.has(taskId) ? `task:${taskId}` : 'problem';
  const open = (node: string, step = '', code?: 'source') => ({ label: text(locale, '打开原始记录', 'Open the saved record'), target: target(run, node, step, code) });
  const tasks = run.tasks.map(task => {
    const checkStatus = task.checkStatus ?? run.checks?.filter(check => check.scope === 'task' && check.taskId === task.id)
      .sort((a, b) => a.at.localeCompare(b.at)).at(-1)?.status;
    return { id: `task:${task.id}`, kind: 'task' as const, taskId: task.id,
      title: task.theorem ?? task.id, summary: task.objective, status: task.status === 'completed' ? status(checkStatus) : status(task.status),
      dependencies: task.dependencies.filter(id => known.has(id)).map(id => `task:${id}`),
      sections: [{ title: text(locale, '任务目标', 'Task objective'), text: task.objective },
        { title: text(locale, '保存的任务状态', 'Saved task state'), text: `${task.status} · ${task.attempts} ${text(locale, '次尝试', 'attempts')}` },
        ...(checkStatus ? [{ title: text(locale, '对应的检查结果', 'Corresponding check result'), text: checkStatus }] : []),
        ...(task.dependencies.length ? [{ title: text(locale, '保存的任务依赖', 'Saved task dependencies'), text: task.dependencies.join('\n'), code: true }] : []),
        ...(task.theorem ? [{ title: text(locale, '声明', 'Declaration'), text: task.theorem, code: true }] : []),
        ...(task.proofCommit ? [{ title: text(locale, '证明版本', 'Proof commit'), text: task.proofCommit, code: true }] : [])],
      action: open(`task:${task.id}`) };
  });
  const records: SolutionRouteNode[] = [];
  for (const [index, event] of run.events.entries()) {
    // The corresponding saved checks below carry the exact feedback and source version.
    if (event.kind === 'lean-check' && run.checks?.length) continue;
    const plan = event.kind === 'plan-edit';
    // The archive event has no actor field; a plan revision does not establish human participation.
    records.push({ id: `event:${index}`, kind: plan ? 'plan' : event.kind === 'lean-check' ? 'check' : 'finding',
      title: plan ? text(locale, '调整任务计划', 'Revise the task plan') : event.kind,
      status: status(event.status), at: event.at, taskId: event.taskId, parentId: owner(event.taskId), summary: event.message,
      sections: [{ title: text(locale, '事件类型', 'Recorded event'), text: event.kind },
        ...(event.message ? [{ title: text(locale, '保存的内容', 'Saved content'), text: event.message }] : []),
        ...(event.status ? [{ title: text(locale, '状态', 'Status'), text: event.status }] : [])],
      ...(plan || event.message || event.kind === 'lean-check' ? { action: open(plan ? 'plan' : owner(event.taskId), `event:${index}`) } : {}) });
  }
  for (const delivery of run.deliveries ?? []) {
    const kind = delivery.kind === 'review' ? 'review' : delivery.kind === 'proof' ? 'proof' : delivery.kind === 'failure' ? 'attempt' : 'finding';
    const node = delivery.taskId ? owner(delivery.taskId) : delivery.kind === 'review' ? 'review' : 'problem';
    const names = { review: text(locale, '审阅意见', 'Review'), proof: text(locale, '证明候选', 'Proof candidate'),
      attempt: text(locale, '受阻尝试', 'Blocked attempt'), finding: text(locale, '研究发现与进展', 'Research finding and progress') };
    records.push({ id: `delivery:${delivery.id}`, kind, title: names[kind], status: status(delivery.status), at: delivery.at,
      taskId: delivery.taskId, parentId: owner(delivery.taskId), summary: delivery.summary,
      sections: [{ title: text(locale, '完整研究记录', 'Complete saved research record'), text: delivery.summary },
        { title: text(locale, '交付类型与状态', 'Delivery kind and status'), text: `${delivery.kind} · ${delivery.status}` },
        ...(delivery.workerId || delivery.role ? [{ title: text(locale, '记录的参与者', 'Recorded contributor'), text: [delivery.workerId, delivery.role].filter(Boolean).join(' · ') }] : []),
        ...(delivery.commit ? [{ title: text(locale, '源码版本', 'Source commit'), text: delivery.commit, code: true }] : [])],
      action: open(node, `delivery:${delivery.id}`) });
  }
  for (const check of run.checks ?? []) {
    const source = check.sourceDigest && process.sources?.[check.sourceDigest];
    const parentId = owner(check.taskId), node = check.scope === 'original' ? 'original' : parentId;
    records.push({ id: `check:${check.id}`, kind: 'check', title: check.scope === 'original'
      ? text(locale, '完整原题检查', 'Whole-problem check') : text(locale, '任务证明检查', 'Task proof check'),
      status: status(check.status), at: check.at, taskId: check.taskId, parentId,
      summary: check.status, sections: [{ title: text(locale, '检查结果', 'Check result'), text: check.status },
        ...(check.diagnostics ? [{ title: text(locale, '完整检查反馈', 'Complete check feedback'), text: check.diagnostics, code: true }] : []),
        ...(check.receiptIds.length ? [{ title: text(locale, '保存的回执', 'Saved receipts'), text: check.receiptIds.join('\n'), code: true }] : []),
        ...(check.sourceDigest ? [{ title: text(locale, '检查的源码 SHA-256', 'Checked source SHA-256'), text: check.sourceDigest, code: true }] : [])],
      ...(source ? { source: { name: source.path, sha256: check.sourceDigest, commit: check.commit } } : {}),
      action: open(node, `check:${check.id}`, source ? 'source' : undefined) });
  }
  if (run.review) records.push({ id: 'review-state', kind: 'review', title: text(locale, '保存的审阅结论', 'Saved review conclusion'),
    status: status(run.review.status), at: run.finishedAt, parentId: 'problem', summary: run.review.summary,
    sections: [{ title: text(locale, '审阅状态', 'Review status'), text: run.review.status },
      ...(run.review.summary ? [{ title: text(locale, '审阅正文', 'Review text'), text: run.review.summary }] : [])], action: open('review') });
  const accepted = record.campaign?.runId === run.runId && run.resultStatus === 'evaluated_passed';
  const outcome: SolutionRouteNode | undefined = accepted || run.resultStatus || run.finishedAt ? {
    id: accepted ? 'acceptance' : 'end', kind: accepted ? 'acceptance' : 'outcome',
    title: accepted ? text(locale, '完整原题通过本地独立验收', 'Original problem passed independent local acceptance') : text(locale, '本轮结果', 'Run outcome'),
    status: status(accepted ? 'evaluated_passed' : run.resultStatus ?? run.phase), at: run.finishedAt ?? record.updatedAt,
    summary: run.reason ?? run.resultStatus ?? run.phase,
    sections: [{ title: text(locale, '保存的结果', 'Saved outcome'), text: run.resultStatus ?? run.phase },
      ...(run.reason ? [{ title: text(locale, '结束原因', 'Reason the run ended'), text: run.reason }] : []),
      ...(accepted ? [{ title: text(locale, '最终证明 SHA-256', 'Final proof SHA-256'), text: record.campaign!.proofSha256, code: true },
        { title: text(locale, '独立验收回执', 'Independent acceptance receipts'), text: record.campaign!.kernelReceiptIds.join('\n'), code: true }] : [])],
    action: open(accepted ? 'acceptance' : 'end', accepted ? 'acceptance' : 'end') } : undefined;
  const route = buildSolutionRoute({ id: `${record.id}:recorded:${run.runId}`, title: text(locale, '真实解题路线', 'Recorded solution route'), locale,
    goal: goal(record, locale), tasks, records, outcome,
    partial: !run.tasks.length && !records.length });
  // A failed or pending branch never becomes part of an accepted proof merely because it is a leaf.
  const integrated = new Set(run.tasks.filter(task => task.status === 'integrated').map(task => `task:${task.id}`));
  route.edges = route.edges.flatMap(edge => edge.kind !== 'integration' ? [edge] : accepted ? integrated.has(edge.from) ? [edge] : [] : [{ ...edge, kind: 'sequence' as const }]);
  return route;
}

const fileCode = (file: SourceFile, process: ArchiveProcess) => process.sources?.[file.sha256]?.code ?? file.code ?? '';
function sourceRoute(record: RouteRecord, process: ArchiveProcess, run: Run | undefined, locale: Locale): SolutionRoute {
  const available = process.sourceRoute?.files ?? [];
  const historical = Boolean(run && run.runId !== record.campaign?.runId);
  let files = available.filter(file => file.recordSource);
  if (historical) {
    const lastByPath = new Map<string, string>();
    for (const check of [...run!.checks ?? []].sort((a, b) => a.at.localeCompare(b.at))) {
      const source = check.sourceDigest && process.sources?.[check.sourceDigest];
      if (source && check.sourceDigest) lastByPath.set(source.path, check.sourceDigest);
    }
    const digests = new Set(lastByPath.values());
    files = available.filter(file => digests.has(file.sha256));
  }
  const nodes: SolutionRouteNode[] = [goal(record, locale)], edges: SolutionRoute['edges'] = [];
  const ids = new Set(files.flatMap(file => file.declarations.map(declaration => declaration.id)));
  for (const file of files) {
    const code = fileCode(file, process), lines = code.split('\n');
    const sourceName = process.sources?.[file.sha256]?.path ?? file.name;
    const check = run?.checks?.filter(item => item.sourceDigest === file.sha256).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
    const action = (line?: number, endLine?: number) => ({ label: text(locale, '打开对应源码', 'Open the corresponding source'),
      target: JSON.stringify({ ...(run ? { run: run.runId } : {}),
        ...(check ? { node: check.scope === 'original' ? 'original' : check.taskId ? `task:${check.taskId}` : 'problem', step: `check:${check.id}`, code: 'source' } : {}),
        sourceName, sourceDigest: file.sha256, ...(line ? { sourceLine: line, sourceEndLine: endLine ?? line } : {}) }) });
    const fileId = `source:${file.sha256}`;
    nodes.push({ id: fileId, kind: 'proof', title: file.name, status: 'recorded',
      summary: text(locale, `${file.declarations.length} 个声明 · ${file.declarations.reduce((sum, item) => sum + item.steps.length, 0)} 个源码步骤`,
        `${file.declarations.length} declarations · ${file.declarations.reduce((sum, item) => sum + item.steps.length, 0)} source steps`),
      source: { name: sourceName, sha256: file.sha256, ...(check?.commit ? { commit: check.commit } : {}) },
      sections: [{ title: 'SHA-256', text: file.sha256, code: true },
        ...(check ? [{ title: text(locale, '对应的检查结果', 'Corresponding check result'), text: check.status }] : []),
        ...(!file.declarations.length ? [{ title: text(locale, '保存的源码', 'Saved source'), text: code, code: true }] : [])], action: action() });
    edges.push({ from: 'problem', to: fileId, kind: 'evidence' });
    const groupSize = 80, grouped = file.declarations.length > groupSize;
    if (grouped) for (let start = 0; start < file.declarations.length; start += groupSize) {
      const members = file.declarations.slice(start, start + groupSize), first = members[0], last = members.at(-1)!;
      const groupId = `${fileId}:declarations:${start}`;
      nodes.push({ id: groupId, parentId: fileId, kind: 'group', status: 'recorded',
        title: text(locale, `声明 ${start + 1}–${start + members.length}`, `Declarations ${start + 1}–${start + members.length}`),
        summary: `${first.name} … ${last.name}`,
        source: { name: sourceName, sha256: file.sha256, line: first.line, endLine: last.endLine },
        sections: [{ title: text(locale, '声明范围', 'Declaration range'), text: `${first.name}\n…\n${last.name}`, code: true }], action: action(first.line, last.endLine) });
      edges.push({ from: fileId, to: groupId, kind: 'evidence' });
    }
    for (const [declarationIndex, declaration] of file.declarations.entries()) {
      const parentId = grouped ? `${fileId}:declarations:${Math.floor(declarationIndex / groupSize) * groupSize}` : undefined;
      const references = declaration.references.filter(id => ids.has(id));
      nodes.push({ id: declaration.id, kind: 'declaration', title: declaration.name, status: 'recorded', summary: declaration.type,
        ...(parentId ? { parentId } : {}),
        source: { name: sourceName, sha256: file.sha256, line: declaration.line, endLine: declaration.endLine },
        sections: [{ title: text(locale, '声明类型', 'Declaration type'), text: declaration.type, code: true },
          { title: text(locale, '对应源码', 'Corresponding source'), text: lines.slice(declaration.line - 1, declaration.endLine).join('\n'), code: true },
          ...(references.length ? [{ title: text(locale, '源码中的引用', 'References in the source'),
            text: text(locale, '连线表示这段源码写到了相应声明的名字。', 'An edge means this source text mentions the named declaration.') }] : [])], action: action(declaration.line, declaration.endLine) });
      edges.push({ from: parentId ?? fileId, to: declaration.id, kind: 'evidence' });
      for (const reference of references) edges.push({ from: reference, to: declaration.id, kind: 'reference' });
      for (const [index, step] of declaration.steps.entries()) {
        nodes.push({ id: step.id, kind: 'derivation', parentId: declaration.id, title: text(locale, `源码步骤 ${index + 1}`, `Source step ${index + 1}`),
          status: 'recorded', summary: `${file.name}:${step.line}–${step.endLine}`,
          source: { name: sourceName, sha256: file.sha256, line: step.line, endLine: step.endLine },
          sections: [{ title: text(locale, '源码步骤', 'Source step'), text: step.code, code: true },
            { title: text(locale, '阅读顺序', 'Reading order'), text: text(locale, '步骤按原始源码先后排列，连线表示源码阅读顺序。', 'Steps follow the original source; connecting arrows show source reading order.') }], action: action(step.line, step.endLine) });
        edges.push({ from: index ? declaration.steps[index - 1].id : declaration.id, to: step.id, kind: index ? 'sequence' : 'evidence' });
      }
    }
  }
  if (!files.length) nodes[0].sections!.push({ title: text(locale, '源码记录', 'Source record'), text: historical
    ? text(locale, '本轮未保存可关联的检查源码。', 'No checked source was saved for this run.')
    : text(locale, '没有保存可展示的源码。', 'No source was saved for this record.') });
  return { schema: 'theoremos.solution-route.v1', id: `${record.id}:source:${run?.runId ?? 'archive'}`, locale, basis: 'source',
    title: text(locale, historical ? '本轮源码结构' : '证明源码结构', historical ? 'Source structure for this run' : 'Proof source structure'),
    nodes, edges, initial: 'problem', ...(files.length ? {} : { partial: true }) };
}

function explanationRoute(record: RouteRecord, process: ArchiveProcess, run: Run, locale: Locale): SolutionRoute | undefined {
  // Keep the same proof-byte and accepted-run binding as the detailed reading below the graph.
  const walkthrough = selectedProofWalkthrough(record, process, run);
  if (!walkthrough) return;
  const localized = (value: { zh: string; en: string }) => value[locale];
  const source = process.sources![walkthrough.proofSha256];
  const check = run.checks?.find(item => item.scope === 'original' && item.sourceDigest === walkthrough.proofSha256 && item.status === 'kernel_verified');
  const nodes: SolutionRouteNode[] = walkthrough.steps.map(step => ({ id: step.id, kind: 'derivation', title: localized(step.title), status: 'recorded',
    summary: localized(step.claim), source: { name: step.evidence.source.name, sha256: walkthrough.proofSha256, line: step.evidence.source.line, endLine: step.evidence.source.endLine },
    sections: [{ title: text(locale, '已知', 'Given'), text: localized(step.given) },
      { title: text(locale, '推出', 'Establishes'), text: localized(step.claim) },
      ...step.derivation.map((line, index) => ({ title: text(locale, `推导 ${index + 1}`, `Derivation ${index + 1}`), text: `${localized(line.statement)}\n${localized(line.reason)}` })),
      { title: text(locale, '接到下一步', 'Connection to the next step'), text: localized(step.next) },
      { title: text(locale, '对应源码', 'Corresponding source'), text: source.code.split('\n').slice(step.evidence.source.line - 1, step.evidence.source.endLine).join('\n'), code: true }],
    ...(check ? { action: { label: text(locale, '打开已检查源码', 'Open the checked source'), target: JSON.stringify({ run: run.runId,
      node: 'original', step: `check:${check.id}`, code: 'source', sourceName: step.evidence.source.name,
      sourceDigest: walkthrough.proofSha256, sourceLine: step.evidence.source.line, sourceEndLine: step.evidence.source.endLine }) } } : {}) }));
  return { schema: 'theoremos.solution-route.v1', id: `${record.id}:explanation:${run.runId}`, title: text(locale, '逐步证明讲解', 'Step-by-step proof explanation'), locale,
    basis: 'explanation', nodes, edges: walkthrough.steps.flatMap(step => step.dependsOn.map(from => ({ from, to: step.id, kind: 'dependency' as const }))), initial: nodes[0]?.id };
}

/** Every record has a source route; recorded runs and precise explanations add independent views. */
export function archiveSolutionRoutes(record: RouteRecord, process: ArchiveProcess, run: Run | undefined, locale: Locale): SolutionRoute[] {
  const selected = run ?? process.runs.find(item => item.runId === record.campaign?.runId) ?? process.runs.at(-1);
  const explanation = selected && explanationRoute(record, process, selected, locale);
  return [...(selected ? [recordedRoute(record, process, selected, locale)] : []), sourceRoute(record, process, selected, locale), ...(explanation ? [explanation] : [])];
}

export function renderArchiveSolutionRoute(record: Pick<ArchiveRecord, 'id'>, run?: Run): string {
  return `<div data-solution-route data-solution-route-record="${escaped(record.id)}" data-solution-route-run="${escaped(run?.runId ?? '')}" data-solution-route-mode="${run ? 'recorded' : 'source'}"></div>`;
}

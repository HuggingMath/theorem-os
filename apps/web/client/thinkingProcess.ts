import type { WebAgentAction } from '../shared';
import { t } from '../i18n';
import { checkLeanFile } from './agentRoute';
import { workerNames } from './collaborationUi';
import type { LiveCheck, SolveProcessInput } from './solveProcess';

export type ThinkingEntry = { id: string; at: string; who?: string } & (
  | { kind: 'summary'; text: string; clipped?: boolean; running: boolean }
  | { kind: 'action'; action: WebAgentAction }
  | { kind: 'check'; check: LiveCheck; action?: WebAgentAction }
  | { kind: 'work'; category: 'plan' | 'research' | 'proof' | 'review' | 'progress'; label: string;
    text?: string; status?: string; observed?: boolean;
    task?: { id: string; version?: string; relationship: 'current' | 'historical' | 'unknown' };
    candidate?: { commit: string; sourceDigest: string };
    sections: { label: string; text: string; code?: boolean }[] }
);

export type ThinkingMatch = { before: string; match: string; after: string };
export type ThinkingStep = Extract<ThinkingEntry, { kind: 'summary' | 'work' }>;

/** Quote the selected public snapshot, including folded math and its recorded version. */
export function quoteThinkingStep(entry: ThinkingStep): string {
  const parts = [[entry.who, entry.at].filter(Boolean).join(' · ')];
  if (entry.kind === 'work') {
    parts.push([entry.label, entry.status].filter(Boolean).join(' · '));
    if (entry.task) parts.push([entry.task.id, entry.task.relationship === 'current' ? t('当前任务版本')
      : entry.task.relationship === 'historical' ? t('历史任务版本') : t('任务版本未确认'), entry.task.version].filter(Boolean).join(' · '));
    if (entry.candidate) parts.push(`${t('审阅的候选版本')}\n${entry.candidate.commit}\n${entry.candidate.sourceDigest}`);
    if (entry.text) parts.push(entry.text);
    for (const section of entry.sections) parts.push(`${section.label}\n${section.code ? `\`\`\`lean\n${section.text}\n\`\`\`` : section.text}`);
  } else parts.push(entry.text);
  if (entry.kind === 'summary' && entry.clipped) parts.push(t('内容较长，后面的部分没有显示。'));
  return `${t('引用解题记录')}\n${parts.join('\n\n').split('\n').map(line => `> ${line}`).join('\n')}`;
}

/** Search only the public fields represented in the log; excerpts are plain text, never rendered as markup. */
export function thinkingEntryMatch(entry: ThinkingEntry, query: string): ThinkingMatch | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return;
  const actionFields = (action?: WebAgentAction) => action ? [action.command, action.output, action.text, action.query, action.url, action.tool, action.arguments,
    ...action.lean?.messages.map(message => message.text) ?? [],
    ...action.found?.flatMap(found => [found.query, ...found.names]) ?? [],
    ...action.changes?.flatMap(change => [change.path, change.movedTo, change.diff]) ?? [],
    ...action.intents?.flatMap(intent => [intent.path, intent.query]) ?? []] : [];
  const fields = entry.kind === 'summary' ? [entry.text] : entry.kind === 'action' ? actionFields(entry.action)
    : entry.kind === 'check' ? [entry.check.label, entry.check.text, entry.check.file, entry.check.source,
      ...entry.check.lean?.messages.map(message => message.text) ?? [], ...actionFields(entry.action)]
      : [entry.label, entry.text, entry.status, entry.task?.id, entry.task?.version, entry.candidate?.commit, entry.candidate?.sourceDigest,
        ...entry.sections.flatMap(section => [section.label, section.text])];
  for (const field of [entry.who, ...fields]) {
    if (!field) continue;
    const index = field.toLowerCase().indexOf(needle);
    if (index < 0) continue;
    const start = Math.max(0, index - 70), end = Math.min(field.length, index + needle.length + 100);
    return { before: `${start ? '…' : ''}${field.slice(start, index)}`, match: field.slice(index, index + needle.length),
      after: `${field.slice(index + needle.length, end)}${end < field.length ? '…' : ''}` };
  }
}

export const thinkingEntryMatches = (entry: ThinkingEntry, query: string): boolean => !query.trim() || !!thinkingEntryMatch(entry, query);

type WorkEntry = Extract<ThinkingEntry, { kind: 'work' }>;
const section = (label: string, text?: string, code = false): WorkEntry['sections'] => text?.trim() ? [{ label, text, ...(code ? { code } : {}) }] : [];
const list = (values?: readonly string[]) => values?.map(value => `- ${value}`).join('\n');
const statuses = () => ({ advisory: t('提示性材料'), conditional: t('有条件结果'), verified: t('已记录检查'),
  failed: t('失败'), superseded: t('已被替代'), accepted: t('审阅接受'), approved: t('审阅接受'),
  changes_requested: t('请求修改'), supporting: t('支持当前路线'), refuted: t('发现反例或缺口'), inconclusive: t('尚无确定结论') });

/** Project saved mathematical records into explanations, without exposing their control protocol as prose. */
function proofWork(input: SolveProcessInput, names: Map<string, string>): WorkEntry[] {
  const observation = input.run?.observation;
  if (!observation) return [];
  const tasks = observation.inspection.tasks ?? [], events = input.events ?? input.run?.events ?? [];
  const labels: Record<string, string> = statuses();
  const stamp = (types: string[], taskId?: string) => {
    const event = events.filter(event => types.includes(event.type) && (!taskId || event.details?.taskId === taskId)).at(-1);
    return event ? { at: event.at } : { at: observation.observedAt, observed: true };
  };
  const taskRef = (id: string, version?: string): WorkEntry['task'] => ({ id, ...(version ? { version } : {}),
    relationship: !version ? 'unknown' : tasks.some(task => task.id === id && task.version === version) ? 'current'
      : observation.history?.some(task => task.id === id && task.version === version) ? 'historical' : 'unknown' });
  const dependency = (id: string) => tasks.find(task => task.id === id)?.objective ?? id;
  const result: WorkEntry[] = [];
  for (const plan of observation.plan?.tasks ?? []) {
    const task = tasks.find(task => task.id === plan.id);
    result.push({ id: `work:plan:${plan.id}:${task?.version ?? plan.revision}`, kind: 'work', category: 'plan', label: t('证明计划'),
      ...stamp(['plan_updated', 'plan_published', 'initial_plan_published']),
      ...(plan.ownerId ? { who: names.get(plan.ownerId) ?? plan.ownerId } : {}),
      task: taskRef(plan.id, task?.version), text: plan.objective,
      sections: [...section(t('待证命题'), plan.informalStatement), ...section(t('证明思路'), plan.informalProof),
        ...section(t('前提'), list(plan.premises)), ...section(t('依赖'), list(plan.dependsOn.map(dependency))),
        ...section(t('Lean 陈述'), plan.type, true), ...section(t('引用资料'), list(plan.citations))] });
  }
  const finding = (raw?: string): { summary?: string; status?: string; sections: WorkEntry['sections'] } => {
    if (!raw?.trim()) return { sections: [] };
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return /^[\s]*[\[{]/u.test(raw) ? { sections: [] } : { summary: raw, sections: [] }; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { sections: [] };
    const data = value as Record<string, unknown>;
    const string = (key: string) => typeof data[key] === 'string' ? data[key] as string : undefined;
    const strings = (key: string) => Array.isArray(data[key]) ? (data[key] as unknown[]).filter((value): value is string => typeof value === 'string') : [];
    const gap = data.mathematicalGap && typeof data.mathematicalGap === 'object' ? data.mathematicalGap as Record<string, unknown> : {};
    const gapText = (key: string) => typeof gap[key] === 'string' ? gap[key] as string : undefined;
    return { summary: string('summary'), status: labels[string('conclusion') ?? ''], sections: [
      ...section(t('结论'), string('statement')), ...section(t('前提'), list(strings('premises'))),
      ...section(t('待完成'), list(strings('remainingObligations'))), ...section(t('原有缺口'), gapText('previousGap')),
      ...section(t('已推进'), gapText('reduced')), ...section(t('剩余缺口'), gapText('remaining')), ...section(t('证据范围'), gapText('evidenceScope'))] };
  };
  const delivered = new Set<string>();
  for (const delivery of observation.deliveries ?? []) {
    const found = finding(delivery.finding);
    const category = delivery.kind === 'research' ? 'research' : ['review', 'statement-review', 'backtranslation'].includes(delivery.kind) ? 'review'
      : delivery.kind === 'proof' ? 'proof' : 'progress';
    const sections = [...section(t('声明'), delivery.statement), ...section(t('前提'), list(delivery.premises)),
      ...section(t('待完成'), list(delivery.remainingObligations)),
      ...section(t('依赖版本'), list(delivery.dependencies.map(item => `${item.taskId} · ${item.taskDigest}`))),
      ...section(t('研究结论'), found.summary !== delivery.summary ? found.summary : undefined), ...found.sections];
    if (!delivery.summary?.trim() && !sections.length) continue;
    if (delivery.taskId && delivery.taskDigest && (found.summary || found.sections.length)) delivered.add(`${delivery.taskId}:${delivery.taskDigest}`);
    result.push({ id: `work:delivery:${delivery.id}`, kind: 'work', category,
      label: category === 'research' ? t('研究发现') : category === 'review' ? t('审阅意见') : category === 'proof' ? t('证明交付') : t('解题进展'),
      at: new Date(delivery.createdAt).toISOString(), who: names.get(delivery.producer) ?? delivery.producer,
      text: delivery.summary, status: labels[delivery.status] ?? found.status,
      ...(delivery.taskId ? { task: taskRef(delivery.taskId, delivery.taskDigest) } : {}), sections });
  }
  for (const task of tasks) {
    if (task.finding && !delivered.has(`${task.id}:${task.version}`)) {
      const found = finding(task.finding);
      if (found.summary || found.sections.length) result.push({ id: `work:finding:${task.id}:${task.version}`, kind: 'work', category: 'research', label: t('研究发现'),
        ...stamp(['research_delivered'], task.id), ...(task.owner ? { who: names.get(task.owner) ?? task.owner } : {}),
        task: taskRef(task.id, task.version), text: found.summary, status: found.status, sections: found.sections });
    }
    const proofState = task.proof?.status;
    if (task.kind !== 'research' && (task.feedback || ['checked', 'conditional', 'stale', 'unverified'].includes(proofState) || ['running', 'integrated', 'failed'].includes(task.status))) {
      const status = proofState === 'checked' ? t('局部 Lean 检查通过') : proofState === 'conditional' ? t('有条件结果')
        : task.status === 'failed' ? t('失败') : proofState === 'stale' ? t('旧版本证据') : task.status === 'running' ? t('正在证明') : t('未验证');
      result.push({ id: `work:task:${task.id}:${task.version}`, kind: 'work', category: 'proof', label: task.kind === 'goal' ? t('原题证明进展') : t('引理进展'),
        ...stamp(['task_assigned', 'task_checked', 'task_integrated', 'task_recheck_finished', 'proof_ready_checked'], task.id),
        ...(task.owner ? { who: names.get(task.owner) ?? task.owner } : {}), task: taskRef(task.id, task.version), text: task.objective, status,
        sections: [...section(t('反馈'), task.feedback), ...(!observation.plan?.tasks.some(plan => plan.id === task.id) ? [
          ...section(t('待证命题'), task.informalStatement), ...section(t('证明思路'), task.informalProof),
          ...section(t('前提'), list(task.premises)), ...section(t('Lean 陈述'), task.type, true), ...section(t('引用资料'), list(task.citations))] : [])] });
    }
  }
  for (const review of observation.inspection.statementReviews ?? []) {
    result.push({ id: `work:statement-review:${review.taskId}:${review.version}:${review.id ?? ''}`, kind: 'work', category: 'review', label: t('声明审阅'),
      ...stamp(['statement_review_completed'], review.taskId), ...(review.workerId ? { who: names.get(review.workerId) ?? review.workerId } : {}),
      task: taskRef(review.taskId, review.version), status: labels[review.status], text: review.summary,
      sections: [...section(t('待证命题'), review.intendedStatement), ...section(t('Lean 陈述'), review.leanStatement, true), ...section(t('前提'), list(review.premises))] });
  }
  const review = observation.inspection.review;
  if (review?.summary) result.push({ id: `work:review:${review.commit}:${review.sourceDigest}`, kind: 'work', category: 'review', label: t('候选证明审阅'),
    ...stamp(['review_completed', 'review_assigned', 'review_requested']), ...(review.workerId ? { who: names.get(review.workerId) ?? review.workerId } : {}),
    text: review.summary, status: labels[review.status], candidate: { commit: review.commit, sourceDigest: review.sourceDigest }, sections: [] });
  return result;
}

/**
 * The 简洁 reading keeps one record per task: once a task has a progress record, its plan record folds into it, so the
 * objective is not said twice. The plan's sections stay behind the progress record's details.
 */
export function condenseThinking(entries: readonly ThinkingEntry[]): ThinkingEntry[] {
  const progress = new Map<string, WorkEntry>(), plans = new Map<string, WorkEntry>();
  for (const entry of entries) if (entry.kind === 'work' && entry.task && entry.id.startsWith('work:task:')) progress.set(entry.task.id, entry);
  for (const entry of entries) if (entry.kind === 'work' && entry.task && entry.category === 'plan' && progress.has(entry.task.id)) plans.set(entry.task.id, entry);
  if (!plans.size) return [...entries];
  const folded = new Set(plans.values());
  return entries.filter(entry => !folded.has(entry as WorkEntry)).map(entry => {
    const plan = entry.kind === 'work' && entry.task && progress.get(entry.task.id) === entry ? plans.get(entry.task.id) : undefined;
    return plan && entry.kind === 'work' ? { ...entry, sections: [...entry.sections,
      ...plan.sections.filter(section => !entry.sections.some(own => own.label === section.label))] } : entry;
  });
}

/** Only explicitly public summaries and commentary become prose. Old unlabelled reasoning stays out. */
export function buildThinkingEntries(input: SolveProcessInput, checks: readonly LiveCheck[]): ThinkingEntry[] {
  const entries = new Map<string, ThinkingEntry>();
  const checkActions = new Map<string, string>();
  const names = workerNames(input.run?.observation?.inspection.workers ?? []);
  for (const entry of proofWork(input, names)) entries.set(entry.id, entry);
  const formalizers = new Map<string, string>();
  const roles = { plan: t('理解题目'), generate: t('写 Lean 陈述'), backtranslate: t('独立回译'), compare: t('审核'), refute: t('查找反例') };
  for (const entry of input.activity ?? []) if (entry.type === 'step' && entry.step.step === 'role') {
    formalizers.set(entry.step.workerId, `${t('第 {0} 轮', entry.step.round)} · ${roles[entry.step.role]}`);
  }
  const put = (stage: 'formalize' | 'prove', action: WebAgentAction) => {
    const id = `${stage}:${action.workerId}:${action.itemId}`;
    const prior = entries.get(id), at = prior?.at ?? action.at;
    const who = stage === 'formalize' ? formalizers.get(action.workerId) ?? t('形式化') : names.get(action.workerId) ?? action.workerId;
    if (action.kind === 'reasoning' || action.kind === 'message' || action.kind === 'plan') {
      if (action.kind === 'reasoning' && action.textSource !== 'summary'
        || action.kind === 'message' && action.textSource !== 'commentary' || !action.text?.trim()) return;
      entries.set(id, { id, at, who, kind: 'summary', text: action.text,
        ...(action.textClipped ? { clipped: true } : {}), running: action.status === 'running' });
    } else if (action.kind !== 'compaction') {
      entries.set(id, { id, at, who, kind: 'action', action });
      if (stage === 'prove' && checkLeanFile(action) !== undefined) checkActions.set(`p:${action.workerId}:${action.itemId}`, id);
    }
  };
  for (const entry of input.activity ?? []) if (entry.type === 'action') {
    put('formalize', { ...entry.action, sequence: entry.sequence, at: entry.at });
  }
  for (const route of input.routes ?? []) for (const step of route.steps) for (const item of step.items) {
    if (item.type === 'action') put('prove', item.action);
  }
  for (const check of checks) {
    const linked = entries.get(checkActions.get(check.id) ?? '');
    if (linked) entries.delete(linked.id);
    entries.set(`check:${check.id}`, {
      id: `check:${check.id}`, at: linked?.at ?? check.at, ...(check.who ? { who: check.who } : {}), kind: 'check', check,
      ...(linked?.kind === 'action' ? { action: linked.action } : {}),
    });
  }
  return [...entries.values()].sort((a, b) => a.at.localeCompare(b.at));
}

import type { ArchiveIndexRecord, ArchiveProcess } from './types';
import type { Locale } from './site';
import { compareSources } from '../../apps/web/client/sourceDiff';
import { buildArchiveRoadmap, renderArchiveRoadmap } from './processRoadmap';
import { archiveRoadmapTaskLabel } from './roadmapLabels';
import { renderGlobalTrajectory } from './globalTrajectory';
import { readableProcessText } from './processText';
import { selectedProofWalkthrough } from './proofWalkthrough';
import type { Localized, ProofWalkthrough } from './proofWalkthroughTypes';

type Run = ArchiveProcess['runs'][number];
type Task = Run['tasks'][number];
type Check = NonNullable<Run['checks']>[number];
type Delivery = NonNullable<Run['deliveries']>[number];
export interface ProcessSelection {
  run: string;
  task: string;
  step: string;
  filter: 'all' | 'checks' | 'decisions';
  code: 'closed' | 'source' | 'diff';
  view: 'global' | 'roadmap' | 'steps';
  node: string;
}
export const emptyProcessSelection = (): ProcessSelection => ({ run: '', task: '', step: '', filter: 'all', code: 'closed', view: 'global', node: '' });
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const choose = (locale: Locale, zh: string, en: string) => locale === 'en' ? en : zh;
const short = (value: string) => value.slice(0, 12);
const icon = (name: string) => `<i data-lucide="${name}"></i>`;

export { readableProcessText } from './processText';

export function processStatus(value: string | undefined, locale: Locale): string {
  const labels: Record<string, [string, string]> = {
    evaluated_passed: ['本轮验收通过', 'Run passed acceptance'], kernel_verified: ['Lean 检查通过', 'Lean check passed'],
    limit_reached: ['本轮达到运行限制', 'Run limit reached'], prepared: ['准备记录', 'Preparation record'], finished: ['运行结束', 'Run finished'],
    runtime_error: ['本轮运行出错', 'Run encountered an error'], evaluated_failed: ['本轮验收未通过', 'Run did not pass acceptance'], incomplete: ['本轮未完成', 'Run incomplete'],
    failed: ['检查未通过', 'Check failed'], passed: ['检查通过', 'Check passed'], error: ['运行出错', 'Run error'],
    pending: ['未完成', 'Unfinished'], blocked: ['受阻', 'Blocked'], integrated: ['已集成', 'Integrated'],
    completed: ['已完成', 'Completed'], running: ['进行中', 'In progress'], verified: ['检查通过', 'Verified'],
    superseded: ['已被后续版本替代', 'Superseded'], changes_requested: ['需要修改', 'Changes requested'],
    accepted: ['审阅通过', 'Review accepted'], rejected: ['未获采用', 'Rejected'], applied: ['已应用', 'Applied'],
    checked: ['已检查', 'Checked'], not_assessed: ['未评估', 'Not assessed'], 'not-assessed': ['未评估', 'Not assessed'],
    advisory: ['供后续研究参考', 'For research reference'], conditional: ['附带待完成条件', 'Remaining conditions'], delivered: ['已交付', 'Delivered'],
  };
  const label = value && labels[value];
  return label ? label[locale === 'en' ? 1 : 0] : value || choose(locale, '未记录', 'Not recorded');
}
const tone = (status?: string) => status && ['kernel_verified', 'evaluated_passed', 'passed', 'accepted', 'verified', 'integrated', 'completed'].includes(status)
  ? 'passed' : status && ['failed', 'error', 'blocked', 'changes_requested', 'limit_reached', 'rejected'].includes(status) ? 'attention' : 'neutral';
function time(at: string | undefined, locale: Locale, compact = false): string {
  if (!at || !Number.isFinite(Date.parse(at))) return '—';
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'zh-CN', { timeZone: 'UTC',
    ...(compact ? {} : { month: 'short', day: 'numeric' }), hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(at));
}
function duration(run: Run, locale: Locale): string {
  const ms = Date.parse(run.finishedAt ?? '') - Date.parse(run.startedAt ?? '');
  if (!(ms >= 0)) return '';
  const minutes = Math.floor(ms / 60_000), seconds = Math.floor(ms / 1000) % 60;
  return minutes >= 60 ? choose(locale, `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`, `${Math.floor(minutes / 60)}h ${minutes % 60}m`)
    : choose(locale, `${minutes} 分 ${seconds} 秒`, `${minutes}m ${seconds}s`);
}
/** Names state what the task had to establish; identifier-only tasks fall back to their recorded wording. */
export const processTaskName = (task: Task, locale: Locale) => archiveRoadmapTaskLabel(task, locale);
export function selectedProcessRun(process: ArchiveProcess, record: ArchiveIndexRecord, selection: ProcessSelection): Run | undefined {
  return process.runs.find(run => run.runId === selection.run)
    ?? process.runs.find(run => run.runId === record.campaign?.runId) ?? process.runs.at(-1);
}
type Step = { id: string; at: string; kind: 'start' | 'plan' | 'check' | 'delivery' | 'progress' | 'end' | 'acceptance';
  title: string; taskId?: string; status?: string; message?: string; check?: Check; delivery?: Delivery };
function stepsFor(run: Run, record: ArchiveIndexRecord, locale: Locale): Step[] {
  const steps: Step[] = [];
  if (run.startedAt) steps.push({ id: 'start', at: run.startedAt, kind: 'start', title: choose(locale, '开始本轮研究', 'Research started') });
  const checks = run.checks ?? [];
  for (const check of checks) steps.push({ id: `check:${check.id}`, at: check.at, kind: 'check', taskId: check.taskId, status: check.status,
    title: check.scope === 'original' ? choose(locale, '检查完整原题', 'Check the original problem') : choose(locale, '检查任务证明', 'Check a task proof'), check });
  for (const delivery of run.deliveries ?? []) steps.push({ id: `delivery:${delivery.id}`, at: delivery.at, kind: 'delivery', taskId: delivery.taskId,
    status: delivery.status, title: delivery.kind === 'review' ? choose(locale, '审阅证明', 'Review the proof')
      : delivery.kind === 'proof' ? choose(locale, '提交证明候选', 'Submit a proof candidate')
        : delivery.kind === 'failure' ? choose(locale, '记录受阻尝试', 'Record a blocked attempt')
          : delivery.kind === 'progress' ? choose(locale, '提交研究进展', 'Submit research progress') : choose(locale, '提交研究发现', 'Submit research findings'),
    message: delivery.summary, delivery });
  for (const [index, event] of run.events.entries()) {
    if (event.kind === 'lean-check') {
      if (!checks.length) steps.push({ id: `event:${index}`, at: event.at, kind: 'check', taskId: event.taskId, status: event.status,
        title: choose(locale, '检查任务证明', 'Check a task proof'), message: event.message });
    } else if (event.kind === 'plan-edit') steps.push({ id: `event:${index}`, at: event.at, kind: 'plan', status: event.status,
      title: choose(locale, '调整任务计划', 'Revise the task plan'), message: event.message });
    else if (event.message?.trim()) steps.push({ id: `event:${index}`, at: event.at, kind: 'progress', status: event.status,
      title: choose(locale, '记录研究进展', 'Record research progress'), message: event.message });
  }
  if (run.finishedAt) steps.push({ id: 'end', at: run.finishedAt, kind: 'end', status: run.resultStatus ?? run.phase,
    title: choose(locale, '本轮运行结束', 'Run finished'), message: run.reason });
  if (run.runId === record.campaign?.runId) steps.push({ id: 'acceptance', at: record.updatedAt, kind: 'acceptance', status: 'evaluated_passed',
    title: choose(locale, '完整原题通过本地独立验收', 'Original problem passed independent local acceptance') });
  return steps.sort((a, b) => a.at.localeCompare(b.at));
}
function rawDetails(values: [string, string | undefined][], locale: Locale): string {
  return `<details class="process-record-details"><summary>${choose(locale, '记录详情', 'Record details')}</summary><dl>${values.filter(([, value]) => value)
    .map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl></details>`;
}
function acceptance(record: ArchiveIndexRecord, locale: Locale): string {
  const final = record.campaign;
  if (!final) return '';
  return `<div class="process-acceptance" data-process-acceptance>
    <div class="process-detail-icon" data-tone="passed">${icon('shield-check')}</div>
    <p class="process-eyebrow">${choose(locale, '本地独立验收', 'Independent local acceptance')}</p>
    <h3>${choose(locale, '完整原题已通过', 'The original problem passed')}</h3>
    <p>${choose(locale, 'Lean 内核检查通过，原题比较器退出码为 0。', 'The Lean kernel check passed and the original comparator exited with code 0.')}</p>
    <div class="process-targets">${final.targets.map(target => `<code>${escape(target)}</code>`).join('')}</div>
    <div class="process-detail-actions"><button class="button button-primary" data-process-open-tab="source">${icon('file-code-2')}${choose(locale, '阅读最终证明', 'Read the final proof')}</button>
      <button class="button" data-process-open-tab="evidence">${icon('shield-check')}${choose(locale, '查看验收证据', 'View acceptance evidence')}</button></div>
    ${rawDetails([['Run ID', final.runId], ['Proof commit', final.proofCommit], ['SHA-256', final.proofSha256], ['Lean receipts', final.kernelReceiptIds.join('\n')]], locale)}
  </div>`;
}
function checkSource(check: Check, run: Run, process: ArchiveProcess, selection: ProcessSelection, locale: Locale): string {
  const source = check.sourceDigest && process.sources?.[check.sourceDigest];
  if (!source) return '';
  const previous = (run.checks ?? []).filter(item => item.at <= check.at && item.id !== check.id && item.scope === check.scope && item.taskId === check.taskId)
    .sort((a, b) => b.at.localeCompare(a.at)).find(item => item.sourceDigest && process.sources?.[item.sourceDigest]?.path === source.path);
  const before = previous?.sourceDigest && process.sources?.[previous.sourceDigest];
  const open = selection.code !== 'closed';
  let content = '';
  if (open && selection.code === 'diff' && before) {
    const comparison = compareSources(before.code, source.code);
    content = comparison.status === 'identical' ? `<p class="process-empty">${choose(locale, '与上次已存检查的源码相同。', 'The source matches the previous saved check.')}</p>`
      : comparison.status === 'unavailable' ? `<p class="process-empty">${choose(locale, '这两份源码较大，可分别下载后比较。', 'These sources are large. Download them to compare the complete files.')}</p>`
        : `<p class="process-code-meta">+${comparison.added} / −${comparison.removed} · ${escape(previous?.commit ? short(previous.commit) : time(previous?.at, locale))} → ${escape(check.commit ? short(check.commit) : time(check.at, locale))}</p>
          <pre class="process-code process-diff" tabindex="0">${comparison.rows.map(row => row.kind === 'gap'
            ? `<span class="process-diff-gap">${choose(locale, `… ${row.count} 行未改动`, `… ${row.count} unchanged lines`)}</span>`
            : `<span data-diff="${row.kind}">${row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' '} ${escape(row.text)}</span>`).join('')}${comparison.omittedLines ? `<span>${choose(locale, '更多内容见完整源码。', 'See the full source for the remaining lines.')}</span>` : ''}</pre>`;
  } else if (open) content = `<pre class="process-code" tabindex="0" aria-label="${choose(locale, '检查时的 Lean 源码', 'Lean source at this check')}"><code>${escape(source.code)}</code></pre>`;
  return `<section class="process-check-source"><button class="process-source-toggle" data-process-code="${open ? 'closed' : 'source'}" aria-expanded="${open}">${icon('file-code-2')}${choose(locale, '检查时的源码', 'Source at this check')}${icon(open ? 'chevron-down' : 'chevron-right')}</button>
    ${open ? `<div class="process-code-toolbar"><span>${escape(source.path)}</span><div><button data-process-code="source" aria-pressed="${selection.code !== 'diff'}">${choose(locale, '源码', 'Source')}</button>
      ${before ? `<button data-process-code="diff" aria-pressed="${selection.code === 'diff'}">${choose(locale, '与上次已存检查比较', 'Compare with previous saved check')}</button>` : ''}
      <button data-process-copy-source="${escape(check.sourceDigest)}">${choose(locale, '复制', 'Copy')}</button><button data-process-download-source="${escape(check.sourceDigest)}">${choose(locale, '下载', 'Download')}</button></div></div>${content}
      <p class="process-code-digest">SHA-256 ${escape(source.sha256)}</p>` : ''}</section>`;
}
function stepDetail(step: Step, run: Run, record: ArchiveIndexRecord, process: ArchiveProcess, selection: ProcessSelection, locale: Locale): string {
  if (step.kind === 'acceptance') return acceptance(record, locale);
  const task = run.tasks.find(task => task.id === step.taskId);
  const check = step.check;
  const glyph = step.kind === 'check' ? 'file-check-2' : step.kind === 'delivery' ? 'message-circle' : step.kind === 'plan' ? 'git-branch' : step.kind === 'start' ? 'play' : 'clock';
  const summary = step.message ? readableProcessText(step.message, 1400) : '';
  return `<div class="process-detail-icon" data-tone="${tone(step.status)}">${icon(glyph)}</div>
    <p class="process-eyebrow"><time datetime="${escape(step.at)}">${escape(time(step.at, locale))} UTC</time></p><h3>${escape(step.title)}</h3>
    ${step.status ? `<p class="process-detail-status" data-tone="${tone(step.status)}">${escape(processStatus(step.status, locale))}</p>` : ''}
    ${step.delivery?.workerId ? `<p class="process-actor">${escape(step.delivery.role ? ({ researcher: choose(locale, '研究 Agent', 'Researcher'), engineer: choose(locale, '证明 Agent', 'Engineer'), lead: choose(locale, 'Lead', 'Lead') }[step.delivery.role] ?? step.delivery.role) + ' · ' : '')}${escape(step.delivery.workerId)}</p>` : ''}
    ${task ? `<p class="process-detail-task">${choose(locale, '关联任务', 'Task')} <button data-process-task="${escape(task.id)}">${escape(processTaskName(task, locale))}</button></p>` : ''}
    ${step.kind === 'start' ? `<p>${choose(locale, '从保存的原题和任务计划开始本轮研究。', 'This run starts from the saved original problem and task plan.')}</p>
      <p>${choose(locale, `配置 ${run.workers} 个 Agent · 记录 ${run.turns} 轮`, `${run.workers} configured Agents · ${run.turns} recorded turns`)}</p>` : ''}
    ${step.kind === 'end' && !summary ? `<p>${choose(locale, '本轮任务的状态保存在下方的运行记录中。', 'Task outcomes are preserved in this run’s records.')}</p>` : ''}
    ${summary && step.kind === 'plan' ? `<div class="process-dependencies"><span>${choose(locale, '调整的任务', 'Updated tasks')}</span>${summary.split(',').map(id => {
      const task = run.tasks.find(task => task.id === id.trim());
      return task ? `<button data-process-task="${escape(task.id)}">${escape(processTaskName(task, locale))}</button>` : `<span>${escape(id.trim())}</span>`;
    }).join('')}</div>` : summary ? `<div class="process-message">${escape(summary)}</div>` : ''}
    ${check ? `<p class="process-check-scope">${check.scope === 'original' ? choose(locale, '完整原题检查', 'Original problem check') : choose(locale, '局部任务检查', 'Task proof check')}</p>
      ${check.diagnostics ? checkFeedback(check, locale) : ''}
      ${checkSource(check, run, process, selection, locale)}` : ''}
    ${rawDetails([['Kind', step.delivery?.kind ?? step.kind], ['Status', step.status], ['Task ID', step.taskId], ['Commit', check?.commit ?? step.delivery?.commit],
      ['Lean receipts', check?.receiptIds.join('\n')], ['Worker', step.delivery?.workerId], ['Role', step.delivery?.role]], locale)}`;
}
/** A verdict a reader can start from; the raw Lean bytes stay one disclosure away. */
function checkFeedback(check: Check, locale: Locale): string {
  const diagnostics = check.diagnostics ?? '';
  const failed = ['failed', 'error'].includes(check.status ?? '');
  const verdict = failed
    ? choose(locale, 'Lean 拒绝了这份证明。下面的输出是它给出的原因，逐条对应需要修改的声明。', 'Lean rejected this proof. The output below gives the reasons, clause by clause.')
    : choose(locale, 'Lean 接受了这份文件：原题目标已由这份证明推出，没有未解决的占位，没有额外的公理。下面保留当时检查的原始输出。', 'Lean accepted this file: the proof establishes the target with no unsolved placeholders and no extra axioms. The original check output is kept below.');
  const axioms = /depends on axioms:\s*\[([^\]]*)\]/u.exec(diagnostics)?.[1];
  const pre = `<pre tabindex="0">${escape(diagnostics)}</pre>`;
  return `<section class="process-diagnostics" data-tone="${failed ? 'attention' : 'passed'}"><h4>${choose(locale, '检查反馈', 'Check feedback')}</h4><p class="process-verdict">${verdict}</p>
    ${failed ? pre : `<details class="process-raw-output"><summary>${choose(locale, '原始输出', 'Original output')}</summary>${pre}</details>`}
    ${axioms ? `<p class="process-axioms">${choose(locale, '内核记录的依赖公理：', 'Axioms recorded by the kernel:')}<code>${escape(axioms)}</code></p>` : ''}</section>`;
}
function taskBrowser(run: Run, selection: ProcessSelection, locale: Locale): string {
  const selected = run.tasks.find(task => task.id === selection.task);
  return `<details class="process-task-browser" ${selected ? 'open' : ''}><summary>${icon('git-branch')}<span>${choose(locale, '任务与依赖', 'Tasks and dependencies')}</span><b>${run.tasks.length}</b>${selected ? `<span>${escape(processTaskName(selected, locale))}</span>` : ''}</summary>
    <div class="process-task-grid">${run.tasks.map(task => `<button data-process-task="${escape(task.id)}" aria-pressed="${selection.task === task.id}" data-tone="${tone(task.status)}">
      <strong>${escape(processTaskName(task, locale))}</strong><span>${escape(processStatus(task.status, locale))} · ${choose(locale, `${task.attempts} 次任务尝试`, `${task.attempts} task attempts`)}</span></button>`).join('')}</div>
    ${selected ? `<section class="process-task-detail"><div class="process-task-heading"><h4>${escape(selected.theorem ?? selected.id)}</h4><button data-process-task="">${choose(locale, '显示全部任务', 'Show all tasks')}</button></div>
      <p class="process-message">${escape(readableProcessText(selected.objective))}</p>
      ${selected.dependencies.length ? `<div class="process-dependencies"><span>${choose(locale, '依赖', 'Depends on')}</span>${selected.dependencies.map(id => {
        const dependency = run.tasks.find(task => task.id === id);
        return dependency ? `<button data-process-task="${escape(id)}">${icon('git-branch')}${escape(processTaskName(dependency, locale))}</button>` : `<code>${escape(id)}</code>`;
      }).join('')}</div>` : `<p>${choose(locale, '没有记录任务依赖。', 'No task dependencies were recorded.')}</p>`}
      ${rawDetails([['Task ID', selected.id], ['Proof commit', selected.proofCommit], ['Lean status', selected.checkStatus], ['Lean receipts', selected.receiptIds.join('\n')]], locale)}</section>` : ''}
    <p class="process-task-footnote">${choose(locale, '任务状态来自本轮结束时的记录。原题的最终验收见轨迹终点。', 'Task statuses are recorded at the end of this run. Final acceptance of the original problem appears at the end of the trajectory.')}</p></details>`;
}

const prose = (value: Localized, locale: Locale) => locale === 'en' ? value.en : value.zh;
const ordinal = (index: number) => String(index + 1).padStart(2, '0');
const leaf = (name: string) => name.split('.').filter(Boolean).at(-1) ?? name;
/** A task's record maps onto the reading's explanation of the same result, when the reading has one. */
function walkthroughStep(walkthrough: ProofWalkthrough | undefined, task: Task) {
  if (!walkthrough) return undefined;
  const theorem = task.theorem ? leaf(task.theorem) : '';
  const step = walkthrough.steps.find(candidate => candidate.evidence.taskIds?.includes(task.id))
    ?? (theorem ? walkthrough.steps.find(candidate => candidate.evidence.theorems.some(name => leaf(name) === theorem)) : undefined);
  if (!step) return undefined;
  const index = walkthrough.steps.indexOf(step);
  const stageIndex = Math.max(0, walkthrough.stages.findIndex(stage => stage.stepIds.includes(step.id)));
  return { step, index, stage: walkthrough.stages[stageIndex]!, stageIndex };
}
/** Nodes carry what a reader needs: what was established, from what, and where the reasoning is written out. */
function taskContext(task: Task, run: Run, walkthrough: ProofWalkthrough | undefined, locale: Locale): string {
  const found = walkthroughStep(walkthrough, task);
  const dependencies = task.dependencies.length ? `<div class="process-dependencies"><span>${choose(locale, '依赖', 'Depends on')}</span>${task.dependencies.map(id => {
    const dependency = run.tasks.find(item => item.id === id);
    return dependency ? `<button data-process-node="task:${escape(id)}">${escape(archiveRoadmapTaskLabel(dependency, locale))}</button>` : '';
  }).join('')}</div>` : '';
  const brief = `<details class="process-map-objective"><summary>${choose(locale, '当时交给 Agent 的任务说明', 'Task brief given to the agent')}</summary><p>${escape(readableProcessText(task.objective, 1600))}</p></details>`;
  if (found && walkthrough) return `<p class="process-map-step-note">${choose(locale, `第 ${ordinal(found.index)} 步 · 阶段 ${found.stageIndex + 1}`, `Step ${ordinal(found.index)} · Part ${found.stageIndex + 1}`)}<i>${escape(prose(found.stage.title, locale))}</i></p>
    <div class="process-map-claim"><span>${choose(locale, '这一步推出', 'This step establishes')}</span><p>${escape(prose(found.step.claim, locale))}</p></div>
    <p class="process-map-given"><span>${choose(locale, '已知', 'Given')}</span>${escape(prose(found.step.given, locale))}</p>
    ${found.step.because.zh || found.step.because.en ? `<details class="process-map-why"><summary>${choose(locale, '为什么这一步成立', 'Why this step holds')}</summary><p>${escape(prose(found.step.because, locale))}</p></details>` : ''}
    <button class="process-map-read" data-open-reading-step="proof-derivation-${escape(found.step.id)}" data-open-reading-sha="${escape(walkthrough.proofSha256)}">${icon('book-open')}${choose(locale, `在阅读页读第 ${ordinal(found.index)} 步的逐行推导`, `Read the line-by-line derivation of step ${ordinal(found.index)}`)}${icon('arrow-right')}</button>
    ${dependencies}${brief}`;
  const research = /^initial_research_/u.test(task.id);
  const capacity = /^capacity_/u.test(task.id);
  const outcome = task.status === 'integrated'
    ? choose(locale, '它的结论已经并入最终证明。', 'Its result is part of the accepted proof.')
    : task.status === 'blocked' ? choose(locale, '这条路线中途受阻，没有进入最终证明。', 'This route was blocked and is not part of the final proof.')
      : choose(locale, '本轮结束时这项工作尚未完成，因此没有并入最终证明。', 'This work was unfinished when the run ended, so it is not part of the final proof.');
  const nature = research ? choose(locale, '这是一项研究工作：它查证可用的库引理与证明路线，本身不产生一条定理。', 'This is a research task: it checks available library lemmas and routes rather than proving a theorem itself.')
    : capacity ? choose(locale, '这是一条探索性的备选路线。', 'This is an exploratory alternative route.')
      : choose(locale, '归档没有为这条任务单列推导段落。', 'The record has no separate derivation section for this task.');
  return `<p>${outcome}${nature}</p>${dependencies}${brief}`;
}
function roadmap(record: ArchiveIndexRecord, process: ArchiveProcess, run: Run, steps: Step[], selection: ProcessSelection, locale: Locale): string {
  const model = buildArchiveRoadmap(record, run, locale);
  const requested = steps.find(step => step.id === selection.step);
  const nodeId = selection.node || (selection.task ? `task:${selection.task}` : '');
  const node = model.nodes.find(node => node.id === nodeId) ?? model.nodes.find(node => requested && (node.stepId === requested.id
    || node.checkIds.includes(requested.check?.id ?? '') || node.deliveryIds.includes(requested.delivery?.id ?? ''))) ?? model.nodes[0]!;
  selection.node = node.id;
  const task = run.tasks.find(task => task.id === node.taskId);
  const related = steps.filter(step => task ? step.taskId === task.id : node.kind === 'plan' ? step.kind === 'plan'
    : node.checkIds.includes(step.check?.id ?? '') || node.deliveryIds.includes(step.delivery?.id ?? '') || step.id === node.stepId);
  const selected = related.find(step => step.id === selection.step) ?? related.at(-1);
  const walkthrough = selectedProofWalkthrough(record, process, run);
  const stages = walkthrough ? `<ol class="process-map-stages">${walkthrough.stages.map((stage, index) => `<li><span>${ordinal(index)}</span><strong>${escape(prose(stage.title, locale))}</strong><p>${escape(prose(stage.summary, locale))}</p></li>`).join('')}</ol>` : '';
  const context = node.kind === 'problem'
    ? `<p>${escape(record.summary)}</p>${walkthrough ? `<p class="process-map-goal">${escape(prose(walkthrough.goal, locale))}</p>
      <p class="process-map-note">${choose(locale, `证明的阅读按 ${walkthrough.stages.length} 个阶段、${walkthrough.steps.length} 步展开；点开任一任务节点可以读这一步推出的结论。`, `The proof reads in ${walkthrough.stages.length} parts and ${walkthrough.steps.length} steps; open any task node to read what it establishes.`)}</p>` : ''}
      <div class="process-targets">${record.campaign?.targets.map(target => `<code>${escape(target)}</code>`).join('') ?? ''}</div>`
    : task ? taskContext(task, run, walkthrough, locale)
      : node.kind === 'plan' ? `${walkthrough ? `<p class="process-map-strategy">${escape(prose(walkthrough.strategy, locale))}</p>${stages}`
        : `<p>${choose(locale, `本轮有 ${run.tasks.length} 项任务。图中的实线保留归档中的引理依赖。`, `${run.tasks.length} tasks in this run. Solid arrows preserve the recorded lemma dependencies.`)}</p>`}`
        : node.kind === 'review' && run.review?.summary && !related.length ? `<p class="process-message">${escape(readableProcessText(run.review.summary, 1600))}</p>` : '';
  return `${renderArchiveRoadmap(model, run, node.id, locale)}
    <section class="process-map-inspector" id="process-map-inspector" aria-label="${choose(locale, '路线节点详情', 'Roadmap node details')}">
      <div class="process-map-context"><div class="process-map-context-heading"><h4>${escape(node.title)}</h4>${node.status ? `<span data-tone="${tone(node.status)}">${escape(processStatus(node.status, locale))}</span>` : ''}</div>${context}
        ${related.length ? `<div class="process-map-task-records" aria-label="${choose(locale, '这个节点的记录', 'Records for this node')}">${related.map(step => `<button data-process-step="${escape(step.id)}" aria-pressed="${step === selected}" data-tone="${tone(step.status)}"><time>${escape(time(step.at, locale, true))}</time><strong>${escape(step.title)}</strong>${step.status ? `<span>${escape(processStatus(step.status, locale))}</span>` : ''}</button>`).join('')}</div>` : ''}</div>
      ${selected ? `<article class="process-step-detail" id="process-step-detail" tabindex="-1" aria-live="polite">${stepDetail(selected, run, record, process, selection, locale)}</article>` : ''}
    </section>`;
}

export function renderArchiveProcess(record: ArchiveIndexRecord, process: ArchiveProcess, selection: ProcessSelection, locale: Locale, researchEvidence = ''): string {
  const run = selectedProcessRun(process, record, selection);
  if (!run) return `<div class="archive-process" data-process-layout="global"><div class="process-view-toolbar"><h4>${choose(locale, '证明源码路线', 'Proof source route')}</h4></div>${renderGlobalTrajectory(record, process, locale, value => processStatus(value, locale))}</div>`;
  const steps = stepsFor(run, record, locale);
  const filtered = steps.filter(step => (!selection.task || step.taskId === selection.task || ['acceptance', 'start', 'end'].includes(step.kind))
    && (selection.filter === 'all' || selection.filter === 'checks' && ['check', 'acceptance'].includes(step.kind)
      || selection.filter === 'decisions' && ['plan', 'delivery', 'progress'].includes(step.kind)));
  const selected = filtered.find(step => step.id === selection.step)
    ?? (selection.task ? filtered.filter(step => step.taskId === selection.task).at(-1) : undefined) ?? filtered.at(-1);
  const selectedIndex = selected ? filtered.indexOf(selected) : -1;
  const current = process.runs.indexOf(run);
  const taskCount = new Set(process.runs.flatMap(run => run.tasks.map(task => task.id))).size;
  const checks = process.runs.reduce((sum, run) => sum + (run.checks?.length ?? run.events.filter(event => event.kind === 'lean-check').length), 0);
  const meaningfulEvents = run.events.filter(event => event.kind === 'baseline' || event.kind === 'transition' && !event.message?.trim());
  const viewToolbar = `<div class="process-view-toolbar"><h4${selection.view === 'global' ? ' class="sr-only"' : ''}>${selection.view === 'global' ? choose(locale, '全局解题轨迹', 'Whole-problem trajectory') : choose(locale, '解题路线', 'Proof roadmap')}</h4><div class="process-step-filters" role="group" aria-label="${choose(locale, '轨迹视图', 'Process view')}"><button data-process-view="global" aria-pressed="${selection.view === 'global'}">${choose(locale, '全局轨迹', 'Global trajectory')}</button><button data-process-view="roadmap" aria-pressed="${selection.view === 'roadmap'}">${icon('git-branch')}${choose(locale, '本轮路线图', 'Run roadmap')}</button><button data-process-view="steps" aria-pressed="${selection.view === 'steps'}">${choose(locale, '逐步记录', 'Step records')}</button></div></div>`;
  if (selection.view === 'global') return `<div class="archive-process" data-process-layout="global" data-process-run-id="${escape(run.runId)}">${viewToolbar}${renderGlobalTrajectory(record, process, locale, value => processStatus(value, locale), { run: run.runId, acceptance: acceptance(record, locale), evidence: researchEvidence })}</div>`;
  return `<div class="archive-process" data-process-run-id="${escape(run.runId)}" data-process-layout="${selection.view}">
    ${viewToolbar}<div class="process-introduction"><p>${escape(record.summary)}</p>${record.campaign ? `<div class="process-final-mark">${icon('shield-check')}<span>${choose(locale, '完整原题', 'Original problem')}<strong>${choose(locale, '本地验收通过', 'Locally accepted')}</strong></span></div>` : ''}</div>
    <dl class="process-overview"><div><dt>${choose(locale, '记录运行', 'Recorded runs')}</dt><dd>${process.runs.length}</dd></div><div><dt>${choose(locale, '归档任务', 'Archived tasks')}</dt><dd>${taskCount}</dd></div>
      <div><dt>${choose(locale, '已存检查', 'Saved checks')}</dt><dd>${checks}</dd></div><div><dt>${choose(locale, '最终验收', 'Final acceptance')}</dt><dd class="process-overview-date">${escape(new Date(record.updatedAt).toISOString().slice(0, 10))}</dd></div></dl>
    <nav class="process-run-nav ${process.runs.length === 1 ? 'process-single-run' : ''}" aria-label="${choose(locale, '选择运行记录', 'Choose a recorded run')}">${process.runs.map((item, index) => `<button class="process-run" data-process-run="${escape(item.runId)}" aria-pressed="${item === run}">
      <span class="process-run-number">${choose(locale, `第 ${index + 1} 次运行`, `Run ${String(index + 1).padStart(2, '0')}`)}${item.runId === record.campaign?.runId ? `<b>${choose(locale, '最终验收', 'Final acceptance')}</b>` : ''}</span>
      <strong data-tone="${tone(item.resultStatus ?? item.phase)}">${escape(processStatus(item.resultStatus ?? item.phase, locale))}</strong><time>${escape(time(item.startedAt, locale))}</time></button>`).join('')}</nav>
    <section class="process-current-run"><header class="process-run-header"><div><h3>${choose(locale, `第 ${current + 1} 次运行`, `Run ${current + 1}`)}</h3><p>${escape(time(run.startedAt, locale))}${run.finishedAt ? ` — ${escape(time(run.finishedAt, locale))}` : ''} UTC${duration(run, locale) ? ` · ${escape(duration(run, locale))}` : ''}</p></div>
      <a class="inline-link" href="${escape((locale === 'en' ? '../' : '') + record.archiveUrl)}" target="_blank" rel="noreferrer">${choose(locale, '原始记录', 'Original records')}${icon('arrow-up-right')}</a></header>
      ${run.reason ? `<p class="process-run-reason">${escape(readableProcessText(run.reason, 650))}</p>` : ''}
      ${selection.view === 'roadmap' ? roadmap(record, process, run, steps, selection, locale) : `${taskBrowser(run, selection, locale)}
      <div class="process-timeline-toolbar"><h4>${choose(locale, '研究步骤', 'Research steps')} <span>${filtered.length}</span></h4><div class="process-step-filters" role="group" aria-label="${choose(locale, '筛选研究步骤', 'Filter research steps')}">${([
        ['all', choose(locale, '全部', 'All')], ['checks', choose(locale, '证明检查', 'Proof checks')], ['decisions', choose(locale, '计划与交付', 'Plans and deliveries')],
      ] as const).map(([value, label]) => `<button data-process-filter="${value}" aria-pressed="${selection.filter === value}">${label}</button>`).join('')}</div></div>
      ${selection.task ? `<p class="process-filter-note">${choose(locale, '正在查看所选任务的步骤', 'Showing steps for the selected task')} <button data-process-task="">${choose(locale, '显示全部', 'Show all')}</button></p>` : ''}
      <div class="process-reader"><ol class="process-step-list" id="process-step-list" aria-label="${choose(locale, '按时间排列的研究步骤', 'Research steps in time order')}">${filtered.map((step, index) => `<li data-kind="${step.kind}" data-tone="${tone(step.status)}"><button data-process-step="${escape(step.id)}" aria-pressed="${step === selected}" aria-controls="process-step-detail">
        <span class="process-step-count">${String(index + 1).padStart(2, '0')}</span><span><time datetime="${escape(step.at)}">${escape(time(step.at, locale, true))}</time><strong>${escape(step.title)}</strong>
        ${step.taskId ? `<span class="process-step-task">${escape(processTaskName(run.tasks.find(task => task.id === step.taskId) ?? { id: step.taskId, objective: '' } as Task, locale))}</span>` : ''}
        ${step.status ? `<span class="process-step-status">${escape(processStatus(step.status, locale))}</span>` : ''}</span></button></li>`).join('')}</ol>
      <article class="process-step-detail" id="process-step-detail" tabindex="-1" aria-live="polite">${selected ? stepDetail(selected, run, record, process, selection, locale)
        : `<p class="process-empty">${choose(locale, '这个筛选条件下没有保存的步骤。', 'No saved steps match this filter.')}</p>`}
        ${filtered.length > 1 ? `<nav class="process-step-navigation" aria-label="${choose(locale, '逐步阅读', 'Read step by step')}"><button data-process-step="${escape(filtered[Math.max(0, selectedIndex - 1)].id)}" ${selectedIndex <= 0 ? 'disabled' : ''}>${icon('chevron-left')}${choose(locale, '上一步', 'Previous')}</button>
          <span>${selectedIndex + 1} / ${filtered.length}</span><button data-process-step="${escape(filtered[Math.min(filtered.length - 1, selectedIndex + 1)].id)}" ${selectedIndex === filtered.length - 1 ? 'disabled' : ''}>${choose(locale, '下一步', 'Next')}${icon('chevron-right')}</button></nav>` : ''}</article></div>`}
      <div class="process-supporting-records">${run.review ? `<details class="process-review"><summary>${icon('badge-check')}${choose(locale, '本轮审阅记录', 'Review record')}<span>${escape(processStatus(run.review.status, locale))}</span></summary><p class="process-message">${escape(readableProcessText(run.review.summary ?? '', 12_000))}</p></details>` : ''}
      ${researchEvidence}
      ${meaningfulEvents.length ? `<details class="process-raw-events"><summary>${choose(locale, '进度快照', 'Progress snapshots')}<span>${meaningfulEvents.length}</span></summary><ol>${meaningfulEvents.map(event => `<li><time>${escape(time(event.at, locale))} UTC</time><span>${escape(event.kind)} · ${escape(event.status ?? '')}</span></li>`).join('')}</ol></details>` : ''}
      ${rawDetails([['Run ID', run.runId], ['Result status', run.resultStatus], ['Phase', run.phase]], locale)}</div>
    </section>
  </div>`;
}

import type { ArchiveIndexRecord, ArchiveProcess } from './types';
import type { Locale } from './site';
import { compareSources } from '../../apps/web/client/sourceDiff';

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
}
export const emptyProcessSelection = (): ProcessSelection => ({ run: '', task: '', step: '', filter: 'all', code: 'closed' });
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const choose = (locale: Locale, zh: string, en: string) => locale === 'en' ? en : zh;
const short = (value: string) => value.slice(0, 12);
const icon = (name: string) => `<i data-lucide="${name}"></i>`;

/** Loader commands and encoded candidates are retained in the downloadable record, not in the reading column. */
export function readableProcessText(value: string, limit = 1000): string {
  const lines = value.replace(/\r\n?/gu, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*(?:```|(?:\/usr\/bin\/)?python3?\b|from pathlib import|import (?:base64|Mathlib)|Reconstruct (?:from|with)|.*PAYLOAD_BEGIN|.*<<['"]?\w)/iu.test(line)
      || /\S{240}/u.test(line)) break;
    kept.push(line);
  }
  const text = kept.join('\n').trim();
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}

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
export const processTaskName = (task: Task) => task.theorem?.split('.').at(-1) || task.id.replaceAll('_', ' ');
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
    ${task ? `<p class="process-detail-task">${choose(locale, '关联任务', 'Task')} <button data-process-task="${escape(task.id)}">${escape(processTaskName(task))}</button></p>` : ''}
    ${step.kind === 'start' ? `<p>${choose(locale, '从保存的原题和任务计划开始本轮研究。', 'This run starts from the saved original problem and task plan.')}</p>
      <p>${choose(locale, `配置 ${run.workers} 个 Agent · 记录 ${run.turns} 轮`, `${run.workers} configured Agents · ${run.turns} recorded turns`)}</p>` : ''}
    ${step.kind === 'end' && !summary ? `<p>${choose(locale, '本轮任务的状态保存在下方的运行记录中。', 'Task outcomes are preserved in this run’s records.')}</p>` : ''}
    ${summary && step.kind === 'plan' ? `<div class="process-dependencies"><span>${choose(locale, '调整的任务', 'Updated tasks')}</span>${summary.split(',').map(id => {
      const task = run.tasks.find(task => task.id === id.trim());
      return task ? `<button data-process-task="${escape(task.id)}">${escape(processTaskName(task))}</button>` : `<span>${escape(id.trim())}</span>`;
    }).join('')}</div>` : summary ? `<div class="process-message">${escape(summary)}</div>` : ''}
    ${check ? `<p class="process-check-scope">${check.scope === 'original' ? choose(locale, '完整原题检查', 'Original problem check') : choose(locale, '局部任务检查', 'Task proof check')}</p>
      ${check.diagnostics ? `<section class="process-diagnostics"><h4>${choose(locale, '检查反馈', 'Check feedback')}</h4><pre tabindex="0">${escape(check.diagnostics)}</pre></section>`
        : ''}
      ${checkSource(check, run, process, selection, locale)}` : ''}
    ${rawDetails([['Kind', step.delivery?.kind ?? step.kind], ['Status', step.status], ['Task ID', step.taskId], ['Commit', check?.commit ?? step.delivery?.commit],
      ['Lean receipts', check?.receiptIds.join('\n')], ['Worker', step.delivery?.workerId], ['Role', step.delivery?.role]], locale)}`;
}
function taskBrowser(run: Run, selection: ProcessSelection, locale: Locale): string {
  const selected = run.tasks.find(task => task.id === selection.task);
  return `<details class="process-task-browser" ${selected ? 'open' : ''}><summary>${icon('git-branch')}<span>${choose(locale, '任务与依赖', 'Tasks and dependencies')}</span><b>${run.tasks.length}</b>${selected ? `<span>${escape(processTaskName(selected))}</span>` : ''}</summary>
    <div class="process-task-grid">${run.tasks.map(task => `<button data-process-task="${escape(task.id)}" aria-pressed="${selection.task === task.id}" data-tone="${tone(task.status)}">
      <strong>${escape(processTaskName(task))}</strong><span>${escape(processStatus(task.status, locale))} · ${choose(locale, `${task.attempts} 次任务尝试`, `${task.attempts} task attempts`)}</span></button>`).join('')}</div>
    ${selected ? `<section class="process-task-detail"><div class="process-task-heading"><h4>${escape(selected.theorem ?? selected.id)}</h4><button data-process-task="">${choose(locale, '显示全部任务', 'Show all tasks')}</button></div>
      <p class="process-message">${escape(readableProcessText(selected.objective))}</p>
      ${selected.dependencies.length ? `<div class="process-dependencies"><span>${choose(locale, '依赖', 'Depends on')}</span>${selected.dependencies.map(id => {
        const dependency = run.tasks.find(task => task.id === id);
        return dependency ? `<button data-process-task="${escape(id)}">${icon('git-branch')}${escape(processTaskName(dependency))}</button>` : `<code>${escape(id)}</code>`;
      }).join('')}</div>` : `<p>${choose(locale, '没有记录任务依赖。', 'No task dependencies were recorded.')}</p>`}
      ${rawDetails([['Task ID', selected.id], ['Proof commit', selected.proofCommit], ['Lean status', selected.checkStatus], ['Lean receipts', selected.receiptIds.join('\n')]], locale)}</section>` : ''}
    <p class="process-task-footnote">${choose(locale, '任务状态来自本轮结束时的记录。原题的最终验收见轨迹终点。', 'Task statuses are recorded at the end of this run. Final acceptance of the original problem appears at the end of the trajectory.')}</p></details>`;
}

export function renderArchiveProcess(record: ArchiveIndexRecord, process: ArchiveProcess, selection: ProcessSelection, locale: Locale, researchEvidence = ''): string {
  const run = selectedProcessRun(process, record, selection);
  if (!run) return `<p class="process-empty">${choose(locale, '没有保存运行记录。', 'No run records were saved.')}</p>`;
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
  return `<div class="archive-process" data-process-run-id="${escape(run.runId)}">
    <div class="process-introduction"><p>${escape(record.summary)}</p>${record.campaign ? `<div class="process-final-mark">${icon('shield-check')}<span>${choose(locale, '完整原题', 'Original problem')}<strong>${choose(locale, '本地验收通过', 'Locally accepted')}</strong></span></div>` : ''}</div>
    <dl class="process-overview"><div><dt>${choose(locale, '记录运行', 'Recorded runs')}</dt><dd>${process.runs.length}</dd></div><div><dt>${choose(locale, '归档任务', 'Archived tasks')}</dt><dd>${taskCount}</dd></div>
      <div><dt>${choose(locale, '已存检查', 'Saved checks')}</dt><dd>${checks}</dd></div><div><dt>${choose(locale, '最终验收', 'Final acceptance')}</dt><dd class="process-overview-date">${escape(new Date(record.updatedAt).toISOString().slice(0, 10))}</dd></div></dl>
    <nav class="process-run-nav ${process.runs.length === 1 ? 'process-single-run' : ''}" aria-label="${choose(locale, '选择运行记录', 'Choose a recorded run')}">${process.runs.map((item, index) => `<button class="process-run" data-process-run="${escape(item.runId)}" aria-pressed="${item === run}">
      <span class="process-run-number">${choose(locale, `第 ${index + 1} 次运行`, `Run ${String(index + 1).padStart(2, '0')}`)}${item.runId === record.campaign?.runId ? `<b>${choose(locale, '最终验收', 'Final acceptance')}</b>` : ''}</span>
      <strong data-tone="${tone(item.resultStatus ?? item.phase)}">${escape(processStatus(item.resultStatus ?? item.phase, locale))}</strong><time>${escape(time(item.startedAt, locale))}</time></button>`).join('')}</nav>
    <section class="process-current-run"><header class="process-run-header"><div><h3>${choose(locale, `第 ${current + 1} 次运行`, `Run ${current + 1}`)}</h3><p>${escape(time(run.startedAt, locale))}${run.finishedAt ? ` — ${escape(time(run.finishedAt, locale))}` : ''} UTC${duration(run, locale) ? ` · ${escape(duration(run, locale))}` : ''}</p></div>
      <a class="inline-link" href="${escape((locale === 'en' ? '../' : '') + record.archiveUrl)}" target="_blank" rel="noreferrer">${choose(locale, '原始记录', 'Original records')}${icon('arrow-up-right')}</a></header>
      ${run.reason ? `<p class="process-run-reason">${escape(readableProcessText(run.reason, 650))}</p>` : ''}
      ${taskBrowser(run, selection, locale)}
      <div class="process-timeline-toolbar"><h4>${choose(locale, '研究步骤', 'Research steps')} <span>${filtered.length}</span></h4><div class="process-step-filters" role="group" aria-label="${choose(locale, '筛选研究步骤', 'Filter research steps')}">${([
        ['all', choose(locale, '全部', 'All')], ['checks', choose(locale, '证明检查', 'Proof checks')], ['decisions', choose(locale, '计划与交付', 'Plans and deliveries')],
      ] as const).map(([value, label]) => `<button data-process-filter="${value}" aria-pressed="${selection.filter === value}">${label}</button>`).join('')}</div></div>
      ${selection.task ? `<p class="process-filter-note">${choose(locale, '正在查看所选任务的步骤', 'Showing steps for the selected task')} <button data-process-task="">${choose(locale, '显示全部', 'Show all')}</button></p>` : ''}
      <div class="process-reader"><ol class="process-step-list" id="process-step-list" aria-label="${choose(locale, '按时间排列的研究步骤', 'Research steps in time order')}">${filtered.map((step, index) => `<li data-kind="${step.kind}" data-tone="${tone(step.status)}"><button data-process-step="${escape(step.id)}" aria-pressed="${step === selected}" aria-controls="process-step-detail">
        <span class="process-step-count">${String(index + 1).padStart(2, '0')}</span><span><time datetime="${escape(step.at)}">${escape(time(step.at, locale, true))}</time><strong>${escape(step.title)}</strong>
        ${step.taskId ? `<span class="process-step-task">${escape(processTaskName(run.tasks.find(task => task.id === step.taskId) ?? { id: step.taskId } as Task))}</span>` : ''}
        ${step.status ? `<span class="process-step-status">${escape(processStatus(step.status, locale))}</span>` : ''}</span></button></li>`).join('')}</ol>
      <article class="process-step-detail" id="process-step-detail" tabindex="-1" aria-live="polite">${selected ? stepDetail(selected, run, record, process, selection, locale)
        : `<p class="process-empty">${choose(locale, '这个筛选条件下没有保存的步骤。', 'No saved steps match this filter.')}</p>`}
        ${filtered.length > 1 ? `<nav class="process-step-navigation" aria-label="${choose(locale, '逐步阅读', 'Read step by step')}"><button data-process-step="${escape(filtered[Math.max(0, selectedIndex - 1)].id)}" ${selectedIndex <= 0 ? 'disabled' : ''}>${icon('chevron-left')}${choose(locale, '上一步', 'Previous')}</button>
          <span>${selectedIndex + 1} / ${filtered.length}</span><button data-process-step="${escape(filtered[Math.min(filtered.length - 1, selectedIndex + 1)].id)}" ${selectedIndex === filtered.length - 1 ? 'disabled' : ''}>${choose(locale, '下一步', 'Next')}${icon('chevron-right')}</button></nav>` : ''}</article></div>
      <div class="process-supporting-records">${run.review ? `<details class="process-review"><summary>${icon('badge-check')}${choose(locale, '本轮审阅记录', 'Review record')}<span>${escape(processStatus(run.review.status, locale))}</span></summary><p class="process-message">${escape(readableProcessText(run.review.summary ?? '', 12_000))}</p></details>` : ''}
      ${researchEvidence}
      ${meaningfulEvents.length ? `<details class="process-raw-events"><summary>${choose(locale, '进度快照', 'Progress snapshots')}<span>${meaningfulEvents.length}</span></summary><ol>${meaningfulEvents.map(event => `<li><time>${escape(time(event.at, locale))} UTC</time><span>${escape(event.kind)} · ${escape(event.status ?? '')}</span></li>`).join('')}</ol></details>` : ''}
      ${rawDetails([['Run ID', run.runId], ['Result status', run.resultStatus], ['Phase', run.phase]], locale)}</div>
    </section>
  </div>`;
}

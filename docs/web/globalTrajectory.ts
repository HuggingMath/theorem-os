import type { ArchiveIndexRecord, ArchiveProcess } from './types';
import type { Locale } from './site';
import { archiveRoadmapTaskLabel } from './roadmapLabels';
import { buildArchiveRoadmap, renderArchiveRoadmap, roadmapTone } from './processRoadmap';
import { processMessage, readableProcessText } from './processText';
import { workflowNote } from './workflowNotes';
import { selectedProofWalkthrough } from './proofWalkthrough';
import type { ProofWalkthrough } from './proofWalkthroughTypes';
import { renderArchiveSolutionRoute } from './archiveSolutionRoute';

type Run = ArchiveProcess['runs'][number];
type Check = NonNullable<Run['checks']>[number];
type Delivery = NonNullable<Run['deliveries']>[number];
const text = (locale: Locale, zh: string, en: string) => locale === 'en' ? en : zh;
const html = (value: unknown) => String(value ?? '').replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const icon = (name: string) => `<i data-lucide="${name}"></i>`;
const date = (at?: string) => at && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString().slice(5, 19).replace('T', ' ') : '';

/** Shared checked bytes and task identity establish retained evidence, not a guessed parent run. */
export function retainedTaskSources(before: Run, after: Run): number {
  const identities = new Set((before.checks ?? []).filter(check => check.taskId && check.sourceDigest)
    .map(check => `${check.taskId}\0${check.sourceDigest}`));
  return new Set((after.checks ?? []).filter(check => check.taskId && check.sourceDigest && identities.has(`${check.taskId}\0${check.sourceDigest}`))
    .map(check => `${check.taskId}\0${check.sourceDigest}`)).size;
}
function destination(run: Run, node: string, step = ''): string {
  return `data-global-run="${html(run.runId)}" data-global-node="${html(node)}"${step ? ` data-global-step="${html(step)}"` : ''}`;
}
function prose(value: string, locale: Locale, note?: string): string {
  const full = processMessage(value, locale);
  if (!full && !note) return '';
  const preview = note ?? (full.length > 720 ? `${full.slice(0, 720).trimEnd()}…` : full);
  return `<p class="workflow-prose">${html(preview)}</p>${note || full.length > 720 ? `<details class="workflow-full-text"><summary>${text(locale, '展开原始记录', 'Read the full record')}</summary><p class="workflow-prose">${html(full)}</p></details>` : ''}`;
}
function checkExcerpt(check: Check): string {
  const lines = (check.diagnostics ?? '').split('\n');
  const first = Math.max(0, lines.findIndex(line => /error:|error\(|unsolved goals|sorry|admit/iu.test(line)));
  return lines.slice(first, first + 8).join('\n').slice(0, 550);
}
function renderWalkthroughDigest(walkthrough: ProofWalkthrough, locale: Locale): string {
  const linesCount = walkthrough.steps.reduce((sum, step) => sum + step.derivation.length, 0);
  const positions = new Map(walkthrough.steps.map((step, index) => [step.id, String(index + 1).padStart(2, '0')]));
  return `<div class="proof-walkthrough-digest" data-proof-walkthrough-digest="${html(walkthrough.recordId)}" data-proof-sha="${html(walkthrough.proofSha256)}">
    <div class="proof-walkthrough-digest-header">
      <h6>${html(walkthrough.title[locale])}</h6>
      <span class="proof-walkthrough-digest-meta">${text(locale, `${walkthrough.steps.length} 步 · ${linesCount} 行推导`, `${walkthrough.steps.length} steps · ${linesCount} lines`)}</span>
      <button type="button" class="button button-primary" data-tab="reading">${text(locale, '阅读完整逐步证明', 'Read full step-by-step proof')} →</button>
    </div>
    <p class="proof-walkthrough-strategy">${html(walkthrough.strategy[locale])}</p>
    <ol class="proof-overview" aria-label="${text(locale, '证明主线', 'Proof outline')}">${walkthrough.stages.map((stage, index) => {
      const first = stage.stepIds[0]!, last = stage.stepIds.at(-1)!;
      const range = [positions.get(first)!, positions.get(last)!].filter((value, i, values) => i === 0 || value !== values[0]).join('–');
      return `<li><button type="button" data-proof-overview-stage="${index}" data-proof-overview-steps="${stage.stepIds.join(' ')}" data-open-reading-step="proof-derivation-${html(first)}" data-open-reading-sha="${html(walkthrough.proofSha256)}"><span class="proof-overview-range">${range}</span><span class="proof-overview-copy"><strong>${html(stage.title[locale])}</strong><span>${html(stage.summary[locale])}</span></span><span class="proof-overview-link" aria-hidden="true">↗</span></button></li>`;
    }).join('')}</ol>
  </div>`;
}

export function renderGlobalTrajectory(record: ArchiveIndexRecord, process: ArchiveProcess, locale: Locale,
  statusLabel: (value: string | undefined) => string, options: { run?: string; acceptance?: string; evidence?: string } = {}): string {
  const run = process.runs.find(item => item.runId === options.run)
    ?? process.runs.find(item => item.runId === record.campaign?.runId) ?? process.runs.at(-1);
  if (!run) return renderArchiveSolutionRoute(record);
  const walkthrough = selectedProofWalkthrough(record, process, run);
  const index = process.runs.indexOf(run), final = run.runId === record.campaign?.runId;
  const sharedSources = index ? retainedTaskSources(process.runs[index - 1]!, run) : 0;
  const title = (taskId?: string) => {
    const task = run.tasks.find(task => task.id === taskId);
    return task ? archiveRoadmapTaskLabel(task, locale) : taskId ?? '';
  };
  const earlierIds = new Set(process.runs.slice(0, index).flatMap(item => (item.deliveries ?? []).map(delivery => delivery.id)));
  const retained = (at: string, id?: string) => (id && earlierIds.has(id)) || (run.startedAt && at < run.startedAt);
  const stamp = (at: string, id?: string) => `<time datetime="${html(at)}">${date(at)} UTC</time>${retained(at, id) ? `<span class="workflow-retained">${text(locale, '较早保存的记录', 'Earlier saved record')}</span>` : ''}`;
  const deliveryEntry = (delivery: Delivery) => {
    const node = run.tasks.some(task => task.id === delivery.taskId) ? `task:${delivery.taskId}` : delivery.kind === 'review' ? 'review' : 'problem';
    const kind = { research: text(locale, '研究发现', 'Research finding'), progress: text(locale, '保存研究进展', 'Research progress'),
      proof: text(locale, '证明候选', 'Proof candidate'), failure: text(locale, '尝试受阻', 'Attempt blocked'), review: text(locale, '审阅意见', 'Review') }[delivery.kind] ?? delivery.kind;
    return `<li class="workflow-record" data-workflow-entry="delivery:${html(delivery.id)}" data-workflow-kind="${html(delivery.kind)}" data-tone="${roadmapTone(delivery.status)}">
      <div class="workflow-record-meta">${stamp(delivery.at, delivery.id)}<span>${html(delivery.workerId ?? delivery.role ?? '')}</span></div>
      <div class="workflow-record-heading"><span class="workflow-record-kind">${kind}</span><h6>${html(title(delivery.taskId) || text(locale, '完整原题', 'Original problem'))}</h6><span class="workflow-record-status">${html(statusLabel(delivery.status))}</span></div>
      ${prose(delivery.summary, locale, workflowNote(delivery.id, locale))}
      <button class="workflow-record-link" ${destination(run, node, `delivery:${delivery.id}`)}>${text(locale, '查看这份交付', 'Inspect this delivery')}${icon('arrow-up-right')}</button>
    </li>`;
  };
  const checkEntry = (check: Check) => {
    const node = check.scope === 'original' ? 'original' : run.tasks.some(task => task.id === check.taskId) ? `task:${check.taskId}` : 'problem';
    const before = (run.checks ?? []).filter(item => item.id !== check.id && item.at < check.at && item.taskId === check.taskId && item.scope === check.scope)
      .sort((a, b) => b.at.localeCompare(a.at)).find(item => item.sourceDigest && check.sourceDigest &&
        process.sources?.[item.sourceDigest]?.path === process.sources?.[check.sourceDigest]?.path);
    const changed = before && before.sourceDigest !== check.sourceDigest;
    return `<li class="workflow-record" data-workflow-entry="check:${html(check.id)}" data-workflow-kind="check" data-tone="${roadmapTone(check.status)}">
      <div class="workflow-record-meta">${stamp(check.at)}${changed ? `<span>${text(locale, '后续源码版本', 'Later source version')}</span>` : ''}</div>
      <div class="workflow-record-heading"><span class="workflow-record-kind">${check.scope === 'original' ? text(locale, '整题检查', 'Whole-problem check') : text(locale, 'Lean 检查', 'Lean check')}</span><h6>${html(title(check.taskId) || text(locale, '完整原题', 'Original problem'))}</h6><span class="workflow-record-status">${html(statusLabel(check.status))}</span></div>
      ${check.status === 'failed' && checkExcerpt(check) ? `<pre class="workflow-check-excerpt" tabindex="0">${html(checkExcerpt(check))}</pre>` : check.sourceDigest ? `<p class="workflow-check-result">${text(locale, '这次检查对应的源码与回执已保存。', 'The checked source and receipt are saved for this check.')}</p>` : ''}
      <button class="workflow-record-link" ${destination(run, node, `check:${check.id}`)}>${text(locale, changed ? '查看反馈与源码变化' : '查看反馈、源码与回执', changed ? 'Inspect feedback and source changes' : 'Inspect feedback, source and receipt')}${icon('arrow-up-right')}</button>
    </li>`;
  };
  const research = (run.deliveries ?? []).filter(delivery => ['research', 'progress'].includes(delivery.kind)).sort((a, b) => a.at.localeCompare(b.at));
  const implementation = [...(run.deliveries ?? []).filter(delivery => ['proof', 'failure'].includes(delivery.kind)).map(delivery => ({ at: delivery.at, body: deliveryEntry(delivery) })),
    ...(run.checks ?? []).map(check => ({ at: check.at, body: checkEntry(check) }))].sort((a, b) => a.at.localeCompare(b.at));
  const reviews = (run.deliveries ?? []).filter(delivery => delivery.kind === 'review').sort((a, b) => a.at.localeCompare(b.at));
  const other = (run.deliveries ?? []).filter(delivery => !['research', 'progress', 'proof', 'failure', 'review'].includes(delivery.kind));
  const planEdits = run.events.map((event, i) => ({ ...event, index: i })).filter(event => event.kind === 'plan-edit' && event.message?.trim());
  const sectionHeading = (number: string, heading: string, count?: number) => `<div class="workflow-section-heading"><span>${number}</span><h5 tabindex="-1">${heading}</h5>${count === undefined ? '' : `<small>${count}</small>`}</div>`;
  const shortStatus = (item: Run) => item.runId === record.campaign?.runId ? text(locale, '最终通过', 'Accepted')
    : item.resultStatus === 'evaluated_passed' ? text(locale, '本轮通过', 'Run passed')
      : item.resultStatus === 'limit_reached' ? text(locale, '未完成', 'Incomplete')
        : item.phase === 'prepared' ? text(locale, '准备', 'Prepared') : statusLabel(item.resultStatus ?? item.phase);
  const planSection = `<section class="workflow-section" id="global-plan" data-workflow-stage="plan">${sectionHeading(walkthrough ? '02' : '01', text(locale, '任务路线', 'Task roadmap'), run.tasks.length)}
    <div class="workflow-section-actions"><p>${text(locale, '本轮保存的任务拆分与依赖', 'The saved task decomposition and dependencies for this run')}</p><button class="global-research" ${destination(run, 'problem')}>${text(locale, '展开节点详情', 'Open node details')}${icon('arrow-up-right')}</button></div>
    ${renderArchiveRoadmap(buildArchiveRoadmap(record, run, locale), run, '', locale, null)}
    ${run.tasks.length ? `<details class="workflow-task-objectives"><summary>${text(locale, '阅读全部任务目标', 'Read every task objective')} (${run.tasks.length})</summary><dl>${run.tasks.map(task => `<div data-workflow-task="${html(task.id)}"><dt><button ${destination(run, `task:${task.id}`)}>${html(archiveRoadmapTaskLabel(task, locale))}</button><span data-tone="${roadmapTone(task.status)}">${html(statusLabel(task.status))}</span></dt><dd>${html(readableProcessText(task.objective, Number.MAX_SAFE_INTEGER))}${task.dependencies.length ? `<div class="workflow-task-dependencies">${text(locale, '依赖：', 'Depends on: ')}${task.dependencies.map(id => `<button ${destination(run, `task:${id}`)}>${html(title(id))}</button>`).join('')}</div>` : ''}</dd></div>`).join('')}</dl></details>` : `<p class="workflow-empty">${text(locale, '本轮没有保存任务拆分。', 'No task decomposition was saved for this run.')}</p>`}
    ${planEdits.length ? `<ol class="workflow-records">${planEdits.map(event => `<li class="workflow-record" data-workflow-entry="event:${event.index}"><div class="workflow-record-meta">${stamp(event.at)}</div><h6>${text(locale, '调整任务计划', 'Revise the task plan')}</h6>${prose(event.message!, locale)}<button class="workflow-record-link" ${destination(run, 'plan', `event:${event.index}`)}>${text(locale, '查看这次计划调整', 'Inspect this plan revision')}${icon('arrow-up-right')}</button></li>`).join('')}</ol>` : ''}
  </section>`;
  const researchSection = `<section class="workflow-section" id="global-findings" data-workflow-stage="research">${sectionHeading(walkthrough ? '01' : '02', text(locale, '研究发现与进展', 'Research findings and progress'), research.length)}
    ${walkthrough ? renderWalkthroughDigest(walkthrough, locale) + `<h6 class="workflow-journal-heading">${text(locale, '研究记录', 'Research journal')}<span>${research.length}</span></h6>` : ''}
    ${research.length ? `<ol class="workflow-records">${research.map(deliveryEntry).join('')}</ol>` : `<p class="workflow-empty">${text(locale, '本轮没有保存研究发现正文。', 'No research finding text was saved for this run.')}</p>`}${other.length ? `<ol class="workflow-records">${other.map(deliveryEntry).join('')}</ol>` : ''}${options.evidence ?? ''}
  </section>`;
  const stages = walkthrough ? [
    ['global-findings', text(locale, '逐步推导', 'Proof derivation')], ['global-plan', text(locale, '任务路线', 'Task roadmap')],
  ] : [['global-plan', text(locale, '任务路线', 'Task roadmap')], ['global-findings', text(locale, '研究发现', 'Research findings')]];
  return `<section class="process-global-trajectory" aria-label="${text(locale, '整题全局轨迹', 'Whole-problem trajectory')}">
    ${walkthrough ? '' : `<div class="global-trajectory-origin">${icon('book-open')}<p>${html(record.summary)}</p></div>`}
    <article class="global-workflow" data-global-selected-run="${html(run.runId)}"><header class="global-workflow-heading"><div><h5>${text(locale, `第 ${index + 1} 轮`, `Run ${index + 1}`)}</h5><span data-tone="${final ? 'passed' : roadmapTone(run.resultStatus ?? run.phase)}">${html(final ? text(locale, '本地验收通过', 'Locally accepted') : statusLabel(run.resultStatus ?? run.phase))}</span></div>
      <details class="global-history-panel"><summary>${text(locale, '历次运行', 'Recorded runs')}<span>${process.runs.length}</span></summary><div class="global-history-content"><p>${date(run.startedAt)}${run.startedAt ? ' UTC' : ''}${sharedSources ? ` · ${text(locale, `${sharedSources} 份检查源码与前轮相同`, `${sharedSources} checked sources match the previous run`)}` : ''}</p><nav class="global-history" aria-label="${text(locale, '历次运行', 'Recorded runs')}"><ol class="global-run-lanes">${process.runs.map((item, i) => `<li class="global-run-lane" data-global-run-id="${html(item.runId)}" data-final="${item.runId === record.campaign?.runId}"><button data-global-select="${html(item.runId)}" aria-pressed="${item === run}"><span>${text(locale, `第 ${i + 1} 轮`, `Run ${i + 1}`)}</span><strong>${html(shortStatus(item))}</strong>${icon('arrow-right')}</button></li>`).join('')}</ol></nav></div></details>
    </header>
      ${renderArchiveSolutionRoute(record, run)}
      <nav class="global-workflow-stages" aria-label="${text(locale, '研究流程阶段', 'Workflow stages')}">${[
        ...stages,
        ['global-implementation', text(locale, '证明与检查', 'Proofs and checks')], ['global-review', text(locale, '审阅与验收', 'Review and acceptance')],
      ].map(([id, label], i) => `<button data-global-scroll="${id}"><span>0${i + 1}</span>${label}${icon('chevron-right')}</button>`).join('')}</nav>
      ${walkthrough ? researchSection + planSection : planSection + researchSection}
      <section class="workflow-section" id="global-implementation" data-workflow-stage="implementation">${sectionHeading('03', text(locale, '证明候选、检查与后续版本', 'Proof candidates, checks and later versions'), implementation.length)}
        ${implementation.length ? `<ol class="workflow-records">${implementation.map(item => item.body).join('')}</ol>` : `<p class="workflow-empty">${text(locale, '本轮没有保存证明候选或检查记录。', 'No proof candidates or checks were saved for this run.')}</p>`}
      </section>
      <section class="workflow-section" id="global-review" data-workflow-stage="review">${sectionHeading('04', text(locale, '审阅与原题验收', 'Review and original-problem acceptance'))}
        ${reviews.length ? `<ol class="workflow-records">${reviews.map(deliveryEntry).join('')}</ol>` : run.review?.summary ? prose(run.review.summary, locale) : `<p class="workflow-empty">${text(locale, '本轮没有保存独立审阅正文。', 'No independent review text was saved for this run.')}</p>`}
        ${final ? `<div class="global-final-badge">${options.acceptance ?? `<button ${destination(run, 'acceptance')}>${text(locale, '完整原题通过 · 查看证明与验收', 'Original problem accepted · inspect proof and acceptance')}</button>`}</div>` : `<div class="workflow-run-outcome"><strong>${html(statusLabel(run.resultStatus ?? run.phase))}</strong>${prose(run.reason ?? '', locale)}<button class="global-outcome" ${destination(run, 'end')}>${text(locale, '查看本轮结束记录', 'Inspect the run outcome')}${icon('arrow-up-right')}</button></div>`}
      </section>
    </article>
  </section>`;
}

import type { ArchiveIndexRecord, ArchiveProcess } from './types';
import type { Locale } from './site';
import { archiveRoadmapTaskLabel } from './roadmapLabels';
import { roadmapTone } from './processRoadmap';

type Run = ArchiveProcess['runs'][number];
const text = (locale: Locale, zh: string, en: string) => locale === 'en' ? en : zh;
const html = (value: unknown) => String(value ?? '').replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const icon = (name: string) => `<i data-lucide="${name}"></i>`;

/** Shared checked bytes and task identity establish retained evidence, not a guessed parent run. */
export function retainedTaskSources(before: Run, after: Run): number {
  const identities = new Set((before.checks ?? []).filter(check => check.taskId && check.sourceDigest)
    .map(check => `${check.taskId}\0${check.sourceDigest}`));
  return new Set((after.checks ?? []).filter(check => check.taskId && check.sourceDigest && identities.has(`${check.taskId}\0${check.sourceDigest}`))
    .map(check => `${check.taskId}\0${check.sourceDigest}`)).size;
}
export function renderGlobalTrajectory(record: ArchiveIndexRecord, process: ArchiveProcess, locale: Locale,
  statusLabel: (value: string | undefined) => string): string {
  const taskCount = process.runs.reduce((sum, run) => sum + run.tasks.length, 0);
  const checkCount = process.runs.reduce((sum, run) => sum + (run.checks?.length ?? 0), 0);
  return `<section class="process-global-trajectory" aria-label="${text(locale, '整题全局轨迹', 'Whole-problem trajectory')}">
    <div class="global-trajectory-origin">${icon('book-open')}<div><strong>${text(locale, '原题', 'Original problem')}</strong><p>${html(record.summary)}</p></div>
      <span>${text(locale, `${process.runs.length} 轮运行 · ${taskCount} 项任务记录 · ${checkCount} 次检查`, `${process.runs.length} runs · ${taskCount} task records · ${checkCount} checks`)}</span></div>
    <div class="global-stage-headings" aria-hidden="true"><span>${text(locale, '历史运行', 'Recorded runs')}</span><span>${text(locale, '研究与引理分支', 'Research and lemma branches')}</span><span>${text(locale, '检查与审阅', 'Checks and reviews')}</span><span>${text(locale, '本轮结果', 'Run outcome')}</span></div>
    <ol class="global-run-lanes">${process.runs.map((run, index) => {
      const failed = (run.checks ?? []).filter(check => check.status === 'failed');
      const original = (run.checks ?? []).filter(check => check.scope === 'original');
      const reviews = (run.deliveries ?? []).filter(delivery => delivery.kind === 'review');
      const blocked = run.tasks.filter(task => task.status === 'blocked');
      const integrated = run.tasks.filter(task => task.status === 'integrated');
      const final = run.runId === record.campaign?.runId;
      const selectedCheck = failed[0] ?? original.at(-1) ?? run.checks?.at(-1);
      const checkNode = selectedCheck?.scope === 'original' ? 'original' : selectedCheck?.taskId ? `task:${selectedCheck.taskId}` : 'problem';
      const samples = [...run.tasks.filter(task => task.status === 'integrated' && !run.tasks.some(other => other.status === 'integrated' && other.dependencies.includes(task.id))),
        ...run.tasks.filter(task => task.status === 'blocked')].slice(0, 3);
      const retained = index ? retainedTaskSources(process.runs[index - 1]!, run) : 0;
      const date = run.startedAt ? new Date(run.startedAt).toISOString().slice(5, 16).replace('T', ' ') : '';
      return `<li class="global-run-lane" data-global-run-id="${html(run.runId)}" data-final="${final}">
        <div class="global-run-label"><span>${String(index + 1).padStart(2, '0')}</span><strong>${text(locale, `第 ${index + 1} 轮`, `Run ${index + 1}`)}</strong>${date ? `<time>${date} UTC</time>` : ''}
          ${retained ? `<small>${text(locale, `保留前轮 ${retained} 份检查源码`, `${retained} checked sources retained`)}</small>` : ''}</div>
        <button class="global-stage global-research" data-global-run="${html(run.runId)}" data-global-node="problem"><span class="global-stage-kind">${icon('git-branch')}${text(locale, '研究路线', 'Research route')}<b>${run.tasks.length}</b></span>
          <strong>${run.tasks.length ? text(locale, `${run.tasks.length} 个引理与研究任务`, `${run.tasks.length} lemma and research tasks`) : text(locale, '准备与候选记录', 'Preparation and candidates')}</strong>
          ${samples.length ? `<span class="global-branch-names">${samples.map(task => `<span data-tone="${roadmapTone(task.status)}">${html(archiveRoadmapTaskLabel(task, locale))}</span>`).join('')}</span>`
            : `<span class="global-stage-meta">${text(locale, `保存 ${run.deliveries?.length ?? 0} 条交付`, `${run.deliveries?.length ?? 0} saved deliveries`)}</span>`}
          <span class="global-stage-meta">${integrated.length ? text(locale, `${integrated.length} 已集成`, `${integrated.length} integrated`) : ''}${blocked.length ? ` · ${text(locale, `${blocked.length} 受阻`, `${blocked.length} blocked`)}` : ''}<em>${text(locale, '展开路线图', 'Open roadmap')} ${icon('arrow-up-right')}</em></span></button>
        <button class="global-stage global-checks" data-global-run="${html(run.runId)}" data-global-node="${html(checkNode)}" ${selectedCheck ? `data-global-step="check:${html(selectedCheck.id)}"` : ''}><span class="global-stage-kind">${icon('file-check-2')}${text(locale, '验证与反馈', 'Verification and feedback')}</span>
          <strong>${text(locale, `${run.checks?.length ?? 0} 次检查 · ${reviews.length} 次审阅`, `${run.checks?.length ?? 0} checks · ${reviews.length} reviews`)}</strong><span class="global-stage-meta">${original.length ? text(locale, `${original.length} 次完整原题检查`, `${original.length} whole-problem checks`) : text(locale, '保存的局部检查', 'Saved task checks')}</span>
          ${failed.length ? `<span class="global-stage-alert">${text(locale, `${failed.length} 次未通过，查看反馈`, `${failed.length} failed checks · inspect feedback`)}</span>` : `<span class="global-stage-meta">${selectedCheck ? text(locale, '查看源码与回执', 'Inspect source and receipts') : text(locale, '本轮未保存检查记录', 'No saved checks in this run')}</span>`}</button>
        <button class="global-stage global-outcome" data-tone="${final ? 'passed' : roadmapTone(run.resultStatus ?? run.phase)}" data-global-run="${html(run.runId)}" data-global-node="${final ? 'acceptance' : 'end'}"><span class="global-stage-kind">${icon(final ? 'shield-check' : 'clock')}${final ? text(locale, '最终独立验收', 'Final independent acceptance') : text(locale, '运行记录', 'Run record')}</span>
          <strong>${final ? text(locale, '完整原题通过', 'Original problem accepted') : html(statusLabel(run.resultStatus ?? run.phase))}</strong><span class="global-stage-meta">${final ? text(locale, '完整证明 · Lean 回执 · 原题验收', 'Final proof · Lean receipt · acceptance') : text(locale, '保留本轮结果与尝试', 'Saved outcome and attempts')}</span>${final ? `<span class="global-final-badge">${icon('check')}${text(locale, '本地验收通过', 'Locally accepted')}</span>` : ''}</button>
      </li>`;
    }).join('')}</ol>
  </section>`;
}

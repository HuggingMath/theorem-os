import type { WebTaskSource } from '../collaboration';
import { createElement, escapeHtml as h, factList, patchSection } from './collaborationUi';
import { compareSources, type SourceComparison } from './sourceDiff';
import { sourceDiffRows } from './sourceDiffMarkup';
import { t } from '../i18n';

export const taskSourceKey = (source: WebTaskSource) => JSON.stringify([source.taskId, source.taskVersion, source.commit, source.sourceDigest, source.environmentDigest, source.file]);

/** Compare only actual snapshots recorded for one task; source identities stay attached to both sides. */
export class TaskSourceComparison {
  readonly element = createElement('section', 'collab-task-source');
  private snapshots = new Map<string, WebTaskSource>();
  private before = '';
  private after: string;
  private mode: 'source' | 'diff' = 'source';
  private folded = true;
  private comparison?: { before: string; after: string; folded: boolean; value: SourceComparison };

  constructor(private initial: WebTaskSource, sources: readonly WebTaskSource[], private currentVersion: string) {
    this.after = taskSourceKey(initial);
    this.element.innerHTML = `<div class="collab-section-heading"><h4>${t('源码 · {0}', h(initial.taskId))}</h4><div class="source-switch" role="group" aria-label="${t('任务源码视图')}"><button type="button" data-task-source-mode="source">${t('查看源码')}</button><button type="button" data-task-source-mode="diff">${t('差异对比')}</button></div></div><p class="collab-help">${t('检查状态请以对应任务版本、commit 和摘要的回执为准。')}</p><div class="collab-source-comparison-controls" data-task-source-controls></div><div class="collab-source-identities" data-task-source-identities></div><p class="collab-help" role="status" data-task-source-status></p><div data-task-source-toolbar></div><div data-task-source-body></div>`;
    this.element.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-task-source-mode]');
      if (!button || button.disabled) return;
      this.mode = button.dataset.taskSourceMode === 'diff' ? 'diff' : 'source'; this.render();
    });
    this.element.addEventListener('change', event => {
      const input = event.target as HTMLInputElement | HTMLSelectElement;
      if (input.hasAttribute('data-task-source-fold')) this.folded = (input as HTMLInputElement).checked;
      else if (input.hasAttribute('data-task-source-before') && this.snapshots.has(input.value)) this.before = input.value;
      else if (input.hasAttribute('data-task-source-after') && this.snapshots.has(input.value)) this.after = input.value;
      else return;
      this.render();
    });
    this.update(sources, currentVersion);
  }

  update(sources: readonly WebTaskSource[], currentVersion: string) {
    this.currentVersion = currentVersion;
    for (const source of [...sources, this.initial]) if (source.taskId === this.initial.taskId) this.snapshots.set(taskSourceKey(source), source);
    if (!this.before) this.before = [...this.snapshots.keys()].find(key => key !== this.after) ?? '';
    this.render();
  }

  private identity(source: WebTaskSource, side: 'before' | 'after', title: string) {
    return `<section class="collab-source-identity" data-task-source-side="${side}"><h5>${title}</h5>${factList([[t('任务'),source.taskId],[t('任务版本'),source.taskVersion],[t('版本关系'),source.taskVersion === this.currentVersion ? t('当前任务版本') : t('历史任务版本；当前为 {0}', this.currentVersion)],['commit',source.commit],[t('源码摘要'),source.sourceDigest],[t('环境摘要'),source.environmentDigest],[t('文件'),source.file]])}</section>`;
  }

  private options(selected: string) {
    return [...this.snapshots].map(([key, source]) => `<option value="${h(key)}"${key === selected ? ' selected' : ''}>${h(source.taskVersion)} · ${h(source.commit.slice(0, 12))} · ${h(source.file)}</option>`).join('');
  }

  private render() {
    const after = this.snapshots.get(this.after)!;
    const before = this.snapshots.get(this.before);
    for (const button of this.element.querySelectorAll<HTMLButtonElement>('[data-task-source-mode]')) {
      button.setAttribute('aria-pressed', String(button.dataset.taskSourceMode === this.mode));
      button.disabled = button.dataset.taskSourceMode === 'diff' && !before;
    }
    patchSection(this.element.querySelector('[data-task-source-controls]')!, `${this.mode === 'diff' ? `<label>${t('基线')}<select data-task-source-before data-focus-key="task-source-before">${this.options(this.before)}</select></label>` : ''}<label>${this.mode === 'diff' ? t('对照') : t('源码快照')}<select data-task-source-after data-focus-key="task-source-after">${this.options(this.after)}</select></label>`);
    patchSection(this.element.querySelector('[data-task-source-identities]')!, `${this.mode === 'diff' && before ? this.identity(before, 'before', t('基线')) : ''}${this.identity(after, 'after', this.mode === 'diff' ? t('对照') : t('已保存源码'))}`);
    const status = this.element.querySelector<HTMLElement>('[data-task-source-status]')!;
    const body = this.element.querySelector<HTMLElement>('[data-task-source-body]')!;
    const toolbar = this.element.querySelector<HTMLElement>('[data-task-source-toolbar]')!;
    if (this.mode === 'source' || !before) {
      status.textContent = before ? t('可选择同任务的已记录快照进行比较。') : t('尚无同任务的其他已记录源码快照。');
      patchSection(toolbar, '');
      patchSection(body, `<pre class="collab-code" data-task-source-code tabindex="0" aria-label="${t('任务 {0} 的已保存源码', h(after.taskId))}">${h(after.source)}</pre>`);
      return;
    }
    if (!this.comparison || this.comparison.before !== this.before || this.comparison.after !== this.after || this.comparison.folded !== this.folded) {
      this.comparison = { before: this.before, after: this.after, folded: this.folded, value: compareSources(before.source, after.source, this.folded) };
    }
    const comparison = this.comparison.value;
    if (comparison.status === 'unavailable') {
      status.textContent = t('差异过多，无法生成逐行对比。选择源码快照后，可切换“查看源码”读取完整文本。');
      patchSection(toolbar, ''); patchSection(body, `<div data-task-source-diff class="collab-empty">${t('逐行差异暂不可用')}</div>`); return;
    }
    if (comparison.status === 'identical') {
      status.textContent = comparison.lineEndingsChanged ? t('仅换行格式不同') : t('源码内容相同');
      patchSection(toolbar, ''); patchSection(body, `<div data-task-source-diff class="collab-empty">${t('两侧保留各自的版本与来源身份。')}</div>`); return;
    }
    status.textContent = t('新增 {0} 行 · 删除 {1} 行{2}', comparison.added, comparison.removed, comparison.omittedLines ? t(' · 另有 {0} 行未展示', comparison.omittedLines) : '');
    patchSection(toolbar, `<div class="diff-toolbar"><div class="diff-counts"><span class="diff-count-added">+${comparison.added}</span><span class="diff-count-removed">-${comparison.removed}</span></div><label class="diff-toggle"><input type="checkbox" data-task-source-fold data-focus-key="task-source-fold"${this.folded ? ' checked' : ''}><span>${t('折叠未改动')}</span></label></div>`);
    patchSection(body, `<div class="collab-source-diff" data-task-source-diff tabindex="0" aria-label="${t('任务 {0} 的源码差异', h(after.taskId))}"><table class="diff-table"><caption class="sr-only">${t('同一任务两份已保存源码的逐行差异')}</caption><thead><tr><th scope="col">${t('基线')}</th><th scope="col">${t('对照')}</th><th scope="col">${t('源码')}</th></tr></thead><tbody>${sourceDiffRows(comparison.rows).markup}</tbody></table></div>`);
  }
}

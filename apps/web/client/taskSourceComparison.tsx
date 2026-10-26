import type { WebTaskSource } from '../collaboration';
import { createElement } from './collaborationUi';
import { compareSources, type SourceComparison } from './sourceDiff';
import { DiffRows, Empty, Facts, renderSection } from './ui/Section';
import { t } from '../i18n';

export const taskSourceKey = (source: WebTaskSource) => JSON.stringify([source.taskId, source.taskVersion, source.commit, source.sourceDigest, source.environmentDigest, source.file]);

type Mode = 'source' | 'diff';

/** Compare only actual snapshots recorded for one task; source identities stay attached to both sides. */
export class TaskSourceComparison {
  readonly element = createElement('section', 'collab-task-source');
  private snapshots = new Map<string, WebTaskSource>();
  private before = '';
  private after: string;
  private mode: Mode = 'source';
  private folded = true;
  private comparison?: { before: string; after: string; folded: boolean; value: SourceComparison };

  constructor(private initial: WebTaskSource, sources: readonly WebTaskSource[], private currentVersion: string) {
    this.after = taskSourceKey(initial);
    this.update(sources, currentVersion);
  }

  update(sources: readonly WebTaskSource[], currentVersion: string) {
    this.currentVersion = currentVersion;
    for (const source of [...sources, this.initial]) if (source.taskId === this.initial.taskId) this.snapshots.set(taskSourceKey(source), source);
    if (!this.before) this.before = [...this.snapshots.keys()].find(key => key !== this.after) ?? '';
    this.render();
  }

  private readonly setMode = (mode: Mode) => { this.mode = mode; this.render(); };
  private readonly setFolded = (folded: boolean) => { this.folded = folded; this.render(); };
  private readonly select = (side: 'before' | 'after', key: string) => {
    if (!this.snapshots.has(key)) return;
    if (side === 'before') this.before = key; else this.after = key;
    this.render();
  };

  private identity(source: WebTaskSource, side: 'before' | 'after', title: string) {
    return <section class="collab-source-identity" data-task-source-side={side}><h5>{title}</h5><Facts facts={[[t('任务'), source.taskId], [t('任务版本'), source.taskVersion],
      [t('版本关系'), source.taskVersion === this.currentVersion ? t('当前任务版本') : t('历史任务版本；当前为 {0}', this.currentVersion)], ['commit', source.commit],
      [t('源码摘要'), source.sourceDigest], [t('环境摘要'), source.environmentDigest], [t('文件'), source.file]]} /></section>;
  }

  private snapshotSelect(side: 'before' | 'after') {
    const selected = side === 'before' ? this.before : this.after;
    const attributes = side === 'before' ? { 'data-task-source-before': true } : { 'data-task-source-after': true };
    return <select {...attributes} data-focus-key={`task-source-${side}`} value={selected} onChange={event => this.select(side, event.currentTarget.value)}>
      {[...this.snapshots].map(([key, source]) => <option key={key} value={key}>{source.taskVersion} · {source.commit.slice(0, 12)} · {source.file}</option>)}
    </select>;
  }

  /** Status line, optional diff toolbar and body for the current mode. */
  private content(after: WebTaskSource, before: WebTaskSource | undefined) {
    if (this.mode === 'source' || !before) return {
      status: before ? t('可选择同任务的已记录快照进行比较。') : t('尚无同任务的其他已记录源码快照。'),
      body: <pre class="collab-code" data-task-source-code tabIndex={0} aria-label={t('任务 {0} 的已保存源码', after.taskId)}>{after.source}</pre>,
    };
    if (!this.comparison || this.comparison.before !== this.before || this.comparison.after !== this.after || this.comparison.folded !== this.folded) {
      this.comparison = { before: this.before, after: this.after, folded: this.folded, value: compareSources(before.source, after.source, this.folded) };
    }
    const comparison = this.comparison.value;
    if (comparison.status === 'unavailable') return {
      status: t('差异过多，无法生成逐行对比。选择源码快照后，可切换“查看源码”读取完整文本。'),
      body: <Empty data-task-source-diff>{t('逐行差异暂不可用')}</Empty>,
    };
    if (comparison.status === 'identical') return {
      status: comparison.lineEndingsChanged ? t('仅换行格式不同') : t('源码内容相同'),
      body: <Empty data-task-source-diff>{t('两侧保留各自的版本与来源身份。')}</Empty>,
    };
    return {
      status: t('新增 {0} 行 · 删除 {1} 行{2}', comparison.added, comparison.removed, comparison.omittedLines ? t(' · 另有 {0} 行未展示', comparison.omittedLines) : ''),
      toolbar: <div class="diff-toolbar"><div class="diff-counts"><span class="diff-count-added">+{comparison.added}</span><span class="diff-count-removed">-{comparison.removed}</span></div>
        <label class="diff-toggle"><input type="checkbox" data-task-source-fold data-focus-key="task-source-fold" checked={this.folded} onChange={event => this.setFolded(event.currentTarget.checked)} /><span>{t('折叠未改动')}</span></label></div>,
      body: <div class="collab-source-diff" data-task-source-diff tabIndex={0} aria-label={t('任务 {0} 的源码差异', after.taskId)}><table class="diff-table">
        <caption class="sr-only">{t('同一任务两份已保存源码的逐行差异')}</caption>
        <thead><tr><th scope="col">{t('基线')}</th><th scope="col">{t('对照')}</th><th scope="col">{t('源码')}</th></tr></thead>
        <tbody><DiffRows rows={comparison.rows} /></tbody></table></div>,
    };
  }

  private render() {
    const after = this.snapshots.get(this.after)!;
    const before = this.snapshots.get(this.before);
    const diff = this.mode === 'diff';
    const { status, toolbar, body } = this.content(after, before);
    const modeButton = (mode: Mode, label: string) => <button type="button" data-task-source-mode={mode} aria-pressed={this.mode === mode}
      disabled={mode === 'diff' && !before} onClick={() => this.setMode(mode)}>{label}</button>;
    renderSection(this.element, <>
      <div class="collab-section-heading"><h4>{t('源码 · {0}', this.initial.taskId)}</h4>
        <div class="source-switch" role="group" aria-label={t('任务源码视图')}>{modeButton('source', t('查看源码'))}{modeButton('diff', t('差异对比'))}</div></div>
      <p class="collab-help">{t('检查状态请以对应任务版本、commit 和摘要的回执为准。')}</p>
      <div class="collab-source-comparison-controls" data-task-source-controls>
        {diff && <label>{t('基线')}{this.snapshotSelect('before')}</label>}
        <label>{diff ? t('对照') : t('源码快照')}{this.snapshotSelect('after')}</label>
      </div>
      <div class="collab-source-identities" data-task-source-identities>
        {diff && before && this.identity(before, 'before', t('基线'))}
        {this.identity(after, 'after', diff ? t('对照') : t('已保存源码'))}
      </div>
      <p class="collab-help" role="status" data-task-source-status>{status}</p>
      <div data-task-source-toolbar>{toolbar}</div>
      <div data-task-source-body>{body}</div>
    </>);
  }
}

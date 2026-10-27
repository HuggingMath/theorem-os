import { render } from 'preact';
import { Icon, Spinner } from './Icon';
import { fill } from './Section';
import { t } from '../../i18n';

export type DraftPreviewProps = {
  title: string; facts: ReadonlyArray<readonly [id: string, label: string, value: string, mono: boolean]>;
  size: string; truncated: boolean; task: string; view: 'source' | 'modules';
};

/**
 * The draft workspace in #run-detail, sharing the Preact root with the run header. The line numbers and code text are
 * written by the caller (SourceReader decorates them), and the module workspace and reader toolbar belong to their views.
 */
export function renderDraftPreview(root: HTMLElement, props: DraftPreviewProps) { render(<DraftPreview {...props} />, root); }
/** Shown in #run-detail until the session loads. */
export function renderConnecting(root: HTMLElement) {
  render(<div class="empty-state detail-empty"><Spinner /><h2>{t('正在连接工作台')}</h2></div>, root);
}

function DraftPreview(props: DraftPreviewProps) {
  const modules = props.view === 'modules';
  const tab = (view: DraftPreviewProps['view'], id: string, panel: string, label: string, icon: string) =>
    <button type="button" role="tab" id={id} data-draft-view={view} aria-selected={props.view === view} aria-controls={panel} tabIndex={props.view === view ? 0 : -1}>{fill(label, <Icon name={icon} />)}</button>;
  return <div class="detail-empty draft-preview" id="draft-preview">
    <header class="preview-heading"><div><span class="preview-eyebrow">{t('Lean 工作区')}</span><h2>{props.title}</h2></div>
      <div class="detail-actions"><span class="badge preview-status">{fill(t('{0}未提交'), <Icon name="file-code-2" />)}</span>
        <button type="button" class="icon-button" data-draft-action="edit" aria-label={t('编辑原始题目')} title={t('编辑原始题目')}><Icon name="square-pen" /></button>
        <button type="button" class="icon-button" data-draft-action="settings" aria-label={t('配置证明环境')} title={t('配置证明环境')}><Icon name="sliders-horizontal" /></button></div></header>
    <dl class="preview-facts">{props.facts.map(([id, label, value, mono]) => <div key={id}><dt>{label}</dt><dd data-preview-value={id} class={mono ? 'mono' : undefined}>{value}</dd></div>)}</dl>
    <div class="preview-view-tabs" role="tablist" aria-label={t('草稿工作区视图')}>
      {tab('source', 'draft-tab-source', 'draft-source-panel', t('{0}Lean 源码'), 'file-code-2')}{tab('modules', 'draft-tab-modules', 'draft-module-panel', t('{0}模块'), 'network')}</div>
    <section class="preview-source" id="draft-source-panel" role="tabpanel" aria-labelledby="draft-tab-source" hidden={modules}>
      <div class="preview-source-heading"><h3 id="preview-source-heading"><Icon name="file-code-2" />Submission.lean</h3><span data-truncated={props.truncated ? '' : undefined}>{props.size}</span></div>
      <div class="source-reader" />
      <div class="draft-source-scroll" tabIndex={0} aria-label={t('原始题目草稿')}><pre class="preview-line-numbers" aria-hidden="true" /><pre id="draft-preview-code"><code /></pre></div>
    </section>
    <div class="draft-module-panel" id="draft-module-panel" role="tabpanel" aria-labelledby="draft-tab-modules" hidden={!modules}><div class="module-workspace" /></div>
    <details class="preview-task" hidden={modules}><summary>{t('研究任务')}</summary><p class="task-content" id="draft-preview-task">{props.task}</p></details>
  </div>;
}

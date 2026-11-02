import { TermHint } from './TermHint';
import { t } from '../../i18n';

type TaskView = 'graph' | 'list';

/**
 * The collaboration skeleton, rendered once per run. Each placeholder is then owned by one renderer
 * (a section component, a Preact root or renderSection); this tree is never re-rendered over them.
 */
export function CollaborationSurface(props: { runId: string; taskView: TaskView; taskStates: ReadonlyArray<readonly [string, string]> }) {
  const { runId, taskView } = props;
  const viewButton = (mode: TaskView, label: string) => <button type="button" data-collab-task-view={mode} aria-pressed={taskView === mode}>{label}</button>;
  return <>
    <div class="collab-heading"><h2 class="sr-only">{t('研究协作')}</h2>
      <p class="collab-help collab-observation-line"><span data-collab-observation></span><TermHint id="observation" /></p>
      <div class="collab-heading-actions">
        <div class="collab-detail-toggle" role="group" aria-label={t('信息详略')} title={t('简洁和详细对协作与轨迹同时生效')}><button type="button" data-collab-detail="simple">{t('简洁')}</button><button type="button" data-collab-detail="full">{t('详细')}</button></div>
        <button type="button" class="button" data-collab-refresh>{t('刷新观察')}</button><button type="button" class="button" data-collab-plan disabled>{t('编辑计划')}</button><button type="button" class="button" data-collab-archive disabled>{t('归档知识')}</button></div></div>
    <div data-collab-navigation></div><div data-collab-summary></div><p data-collab-status class="collab-help collab-operation-status" role="status"></p>
    <section class="collab-agent-route"><div class="collab-section-heading"><h3>{t('Agent 操作明细')}</h3></div><div data-agent-route></div></section>
    <section class="collab-now"><div class="collab-section-heading"><h3>{t('现在在做什么')}</h3></div><div data-collab-now></div></section>
    <div data-collab-progress></div>
    <div class="collab-layout">
      <section class="collab-map" data-task-view={taskView}>
        <div class="collab-section-heading"><span class="term-heading"><h3>{t('数学任务')}</h3><TermHint id="plan" /></span>
          <div class="collab-task-view" role="group" aria-label={t('任务显示方式')}>{viewButton('graph', t('依赖图'))}{viewButton('list', t('任务列表'))}</div></div>
        <div class="collab-map-tools">
          <label class="sr-only" htmlFor={`task-search-${runId}`}>{t('搜索任务、类型或负责人')}</label><input id={`task-search-${runId}`} data-collab-task-search type="search" placeholder={t('搜索任务、类型或负责人')} />
          <label class="sr-only" htmlFor={`route-${runId}`}>{t('筛选证明路线')}</label><select id={`route-${runId}`} data-collab-route><option value="">{t('全部路线')}</option></select>
          <label class="sr-only" htmlFor={`task-state-${runId}`}>{t('筛选任务状态')}</label>
          <select id={`task-state-${runId}`} data-collab-task-state><option value="">{t('全部状态')}</option>{props.taskStates.map(([state, label]) => <option key={state} value={state}>{label}</option>)}</select>
        </div>
        <div class="collab-task-result"><span data-collab-task-count role="status"></span><button type="button" class="text-button" data-collab-task-reset hidden>{t('清除筛选')}</button></div>
        <div data-collab-task-selection class="collab-task-selection" hidden></div><div data-collab-routes class="collab-route-summary"></div><div data-collab-task-empty class="collab-task-empty" hidden></div>
        <div class="collab-graph-frame">
          <div class="collab-graph-scroll" tabIndex={0} data-focus-key="task-graph-scroll" aria-label={t('任务依赖图，可滚动、拖动平移和缩放')}><div data-collab-graph class="collab-graph"></div></div>
          <div class="collab-graph-legend">
            <p class="collab-help"><span class="collab-legend-and">{t('先完成')}</span><span class="collab-legend-or">{t('可选路线')}</span><TermHint id="graph" /><span class="collab-legend-usage" data-collab-usage-legend hidden></span><span>{t('拖动平移')}</span></p>
            <div class="collab-graph-zoom" role="group" aria-label={t('依赖图缩放')}>
              <button type="button" data-collab-graph-zoom="out" aria-label={t('缩小')}>−</button><button type="button" data-collab-graph-zoom="reset" aria-label={t('恢复 100%')} data-collab-graph-zoom-level>100%</button>
              <button type="button" data-collab-graph-zoom="in" aria-label={t('放大')}>+</button><button type="button" data-collab-graph-zoom="fit">{t('适应')}</button></div>
          </div>
        </div>
        <div data-collab-task-list class="collab-task-list" data-focus-key="task-list-scroll" tabIndex={0} aria-label={t('任务列表')}></div>
      </section>
      <section class="collab-inspector"><div class="collab-section-heading"><h3>{t('任务检查器')}</h3>
        <div class="collab-inspector-actions"><button type="button" class="text-button" data-collab-back-to-list hidden>{t('返回任务列表')}</button><button type="button" class="text-button" data-collab-guide-task data-focus-key="guide-task">{t('指导此任务')}</button></div></div>
        <div data-collab-inspector></div><div data-collab-artifact class="collab-artifact" aria-live="polite"></div></section>
    </div>
    <div data-collab-reviews></div><div data-collab-math-changes></div>
    <section class="collab-agents"><div class="collab-section-heading"><span class="term-heading"><h3>{t('Agent 分工')}</h3><TermHint id="roles" /></span><span class="collab-help">{t('固定角色 / 当前会话角色')}</span></div><div data-collab-agents class="collab-agent-list"></div></section>
    <div data-collab-deliveries></div><div data-collab-guidance></div>
    <p class="collab-expand"><button type="button" class="text-button" data-collab-detail="full">{t('显示完整协作视图')}</button>
      <span class="collab-help">{t('依赖图、任务检查器、审阅、数学变化、Agent 分工、交付、记录与知识目录')}</span></p>
    <div data-collab-records>
      <section class="collab-edit-records"><div class="collab-section-heading"><span class="term-heading"><h3>{t('计划应用与重新检查')}</h3><TermHint id="recheck" /></span></div><div data-collab-edits></div></section>
      <section class="collab-archives"><div class="collab-section-heading"><span class="term-heading"><h3 tabIndex={-1} data-collab-archives-heading>{t('归档与知识目录')}</h3><TermHint id="archive" /></span></div><div data-collab-archives></div></section>
    </div>
  </>;
}

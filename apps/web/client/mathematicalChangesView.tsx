import { Fragment, type VNode } from 'preact';
import type { WebGoalFrontier, WebMathematicalChange, WebObservation, WebRecordedAdvisory, WebRecordedBlocker, WebRecordedObligation, WebRouteObservation } from '../collaboration';
import { createElement, observedTime, coverageStateLabel } from './collaborationUi';
import { recordedTask } from './researchProgressView';
import { Detail, Facts, renderSection } from './ui/Section';
import { t } from '../i18n';

type Reference = { taskId: string; taskDigest: string | null };
type Side<T> = { title: string; before?: T; after?: T };
type Bag<T> = Record<string, (T | { before: T; after: T })[]>;
const categories = [['baseline', t('观察基线')], ['obligations', t('证明义务')], ['frontiers', t('原始目标前沿')], ['blockers', t('数学阻塞')], ['routes', t('OR 路线')], ['advisory', t('提示性研究')], ['environment', t('环境变化')]] as const;
const statuses: Record<string, string> = { none: t('尚无证明'), conditional: t('有条件结果'), checked: t('记录为已检查'), stale: t('旧版本证据'), unverified: t('未验证'), open: t('待解决'), parked: t('已停放'), reopened: t('已重开'), superseded: t('已被替代'), advisory: t('提示性材料') };
const status = (value: string) => statuses[value] ?? value;
const time = (value: number) => observedTime(value);
export const mathematicalChangeKey = (receipt: WebMathematicalChange) => JSON.stringify([receipt.kind, receipt.at, receipt.beforeDigest ?? null, receipt.afterDigest]);
const count = (bag: Record<string, unknown[]>) => Object.values(bag).reduce((sum, values) => sum + values.length, 0);
function sides<T extends object>(bag: Bag<T>, titles: Record<string, string>): Side<T>[] {
  return Object.entries(bag).flatMap(([key, items]) => items.map(item => ({ title: titles[key] ?? key,
    ...('before' in item && 'after' in item ? item as { before: T; after: T } : key === 'removed' ? { before: item as T } : { after: item as T }) })));
}
function receiptCategories(receipt: WebMathematicalChange): string[] {
  if (receipt.kind === 'baseline') return ['baseline'];
  return [count(receipt.obligations) && 'obligations', receipt.goalFrontiers.length && 'frontiers', count(receipt.blockers) && 'blockers', receipt.routes.length && 'routes', count(receipt.advisory) && 'advisory', receipt.environmentChanged && 'environment'].filter(Boolean) as string[];
}
function summary(receipt: WebMathematicalChange) {
  if (receipt.kind === 'baseline') return t('建立观察基线');
  return [
    receipt.obligations.new.length && t('新增义务 {0}', receipt.obligations.new.length),
    receipt.obligations.closed.length && t('局部闭合 {0}', receipt.obligations.closed.length),
    receipt.obligations.reopened.length && t('义务重开 {0}', receipt.obligations.reopened.length),
    receipt.obligations.removed.length && t('移除义务 {0}', receipt.obligations.removed.length),
    receipt.obligations.changed.length && t('义务记录变化 {0}', receipt.obligations.changed.length),
    receipt.goalFrontiers.length && t('前沿变化 {0}', receipt.goalFrontiers.length),
    count(receipt.blockers) && t('阻塞变化 {0}', count(receipt.blockers)),
    receipt.routes.length && t('路线变化 {0}', receipt.routes.length),
    count(receipt.advisory) && t('研究记录变化 {0}', count(receipt.advisory)),
    receipt.environmentChanged && t('环境变化'),
  ].filter(Boolean).join(' · ') || t('数学快照变化');
}
function references(receipt: WebMathematicalChange): Reference[] {
  const result: Reference[] = [];
  for (const side of sides(receipt.obligations, {})) for (const item of [side.before, side.after]) if (item) result.push(item, ...item.conditions);
  for (const side of [...sides(receipt.blockers, {}), ...sides(receipt.advisory, {})]) for (const item of [side.before, side.after]) if (item) result.push(item);
  for (const change of receipt.goalFrontiers) for (const item of [change.before, change.after]) if (item) result.push(item, ...item.frontier, ...(item.alternatives ?? []).flatMap(route => route.frontier));
  for (const change of receipt.routes) for (const item of [change.before, change.after]) if (item) for (const taskId of [item.targetTaskId, item.closingTaskId, ...item.prerequisiteTaskIds]) result.push({ taskId, taskDigest: null });
  return result;
}
const help = (text: string) => <p class="collab-help">{text}</p>;
const yes = (value: boolean) => value ? t('是') : t('否');
const listed = (values: readonly string[], none = t('无')) => values.join(', ') || none;

/** A retained window of recorded snapshot differences; reading it never replays proof checks. */
export class MathematicalChangesView {
  readonly element = createElement('section', 'collab-math-changes');
  private observation?: WebObservation;
  private selected = '';
  private category = '';
  private task = '';
  private query = '';
  private tasks: string[] = [];
  private actionStatus = '';

  constructor(private runId: string, private appendReference: (text: string) => boolean) {
    this.render();
  }

  update(observation: WebObservation) {
    if (this.observation && observation.sequence < this.observation.sequence) return;
    this.observation = observation;
    this.tasks = [...new Set([...observation.inspection.tasks.map(task => task.id), ...this.records().flatMap(receipt => references(receipt).map(ref => ref.taskId)), ...(this.task ? [this.task] : [])])].sort();
    if (!this.selected) this.selected = this.filtered()[0] ? mathematicalChangeKey(this.filtered()[0]) : '';
    this.render();
  }

  showForTask(id: string) {
    if (!this.tasks.includes(id)) this.tasks = [...this.tasks, id].sort();
    this.task = id; this.category = ''; this.query = ''; this.filter();
    this.element.querySelector<HTMLElement>('[data-math-heading]')!.focus({ preventScroll: true });
    this.element.scrollIntoView({ block: 'start' });
  }
  private records() { return this.observation?.inspection.mathematics.recentChanges ?? []; }
  private filtered() {
    const query = this.query.trim().toLocaleLowerCase();
    return this.records().filter(receipt => (!this.category || receiptCategories(receipt).includes(this.category)) && (!this.task || references(receipt).some(ref => ref.taskId === this.task)) && (!query || `${summary(receipt)}\n${JSON.stringify(receipt)}`.toLocaleLowerCase().includes(query)))
      .sort((a, b) => b.at - a.at || mathematicalChangeKey(a).localeCompare(mathematicalChangeKey(b)));
  }
  private filter() {
    const items = this.filtered();
    if (!items.some(receipt => mathematicalChangeKey(receipt) === this.selected)) this.selected = items[0] ? mathematicalChangeKey(items[0]) : '';
    this.render(); this.element.querySelector('[data-math-list]')!.scrollTop = 0;
  }
  private readonly clear = () => { this.category = ''; this.task = ''; this.query = ''; this.filter(); };
  private readonly choose = (key: string) => { this.selected = key; this.render(); };
  private selectedReceipt() { return this.records().find(receipt => mathematicalChangeKey(receipt) === this.selected); }
  private coverage() {
    const times = this.records().map(receipt => receipt.at);
    return { scope: 'current-observation', retainedChangeLimit: this.observation?.inspection.mathematics.retainedChangeLimit ?? 0,
      retainedRecords: times.length, oldestAt: times.length ? Math.min(...times) : null, newestAt: times.length ? Math.max(...times) : null };
  }
  private row(receipt: WebMathematicalChange) {
    const key = mathematicalChangeKey(receipt), selected = key === this.selected;
    return <article key={key} class="collab-math-row" data-math-row={key}>
      <button type="button" class={`collab-math-choice${selected ? ' selected' : ''}`} data-math-key={key} data-focus-key={`math-${key}`} aria-pressed={selected} onClick={() => this.choose(key)}>
        <span class="collab-math-meta"><time dateTime={new Date(receipt.at).toISOString()}>{time(receipt.at)}</time><span>{receipt.kind === 'baseline' ? t('观察基线') : t('记录变化')}</span></span>
        <strong>{summary(receipt)}</strong><small>{[...new Set(references(receipt).map(ref => ref.taskId))].join(', ') || t('未记录具体任务')}</small>
      </button></article>;
  }
  private render() {
    const items = this.filtered(), coverage = this.coverage(), receipt = this.selectedReceipt(), id = this.runId;
    // Keep the first visible retained row in place when rows above it appear or disappear.
    const list = this.element.querySelector<HTMLElement>('[data-math-list]');
    const anchor = list && [...list.querySelectorAll<HTMLElement>(':scope > [data-math-row]')].find(row => row.getBoundingClientRect().bottom > list.getBoundingClientRect().top);
    const anchorTop = anchor?.getBoundingClientRect().top, top = list?.scrollTop ?? 0;
    renderSection(this.element, <>
      <div class="collab-section-heading"><h3 tabIndex={-1} data-math-heading>{t('数学变化')}</h3><span class="collab-help" data-math-count>{t('{0} / {1} 条记录', items.length, coverage.retainedRecords)}</span></div>
      <p class="collab-help collab-math-coverage" data-math-coverage>{this.observation ? t('本次观察保留 {0} 条，运行时上限 {1} 条{2}。此处未提供完整历史覆盖；没有新记录不表示研究停滞。', coverage.retainedRecords, coverage.retainedChangeLimit, coverage.oldestAt !== null ? t('；{0} 至 {1}', time(coverage.oldestAt), time(coverage.newestAt!)) : '') : t('正在等待运行时数学变化观测。')}</p>
      <div class="collab-math-filters">
        <label htmlFor={`math-category-${id}`}>{t('变化类型')}<select id={`math-category-${id}`} data-math-category value={this.category} onChange={event => { this.category = event.currentTarget.value; this.filter(); }}>
          <option value="">{t('全部类型')}</option>{categories.map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>
        <label htmlFor={`math-task-${id}`}>{t('关联任务')}<select id={`math-task-${id}`} data-math-task value={this.task} onChange={event => { this.task = event.currentTarget.value; this.filter(); }}>
          <option value="">{t('全部任务')}</option>{this.tasks.map(task => <option key={task} value={task}>{task}</option>)}</select></label>
        <label htmlFor={`math-query-${id}`}>{t('检索')}<input id={`math-query-${id}`} type="search" data-math-query placeholder={t('搜索版本、路线或阻塞机制')} value={this.query} onInput={event => { this.query = event.currentTarget.value; this.filter(); }} /></label>
        <button type="button" class="button" data-math-clear onClick={this.clear}>{t('清除筛选')}</button>
      </div>
      <div class="collab-math-layout">
        <div class="collab-math-list" data-math-list tabIndex={0} aria-label={t('本次观察保留的数学变化')}>
          {items.map(item => this.row(item))}
          {!items.length && help(this.records().length ? t('没有匹配的变化记录') : t('本次观察尚无保留的数学变化记录'))}
        </div>
        <div class="collab-math-detail" data-math-detail>{receipt ? this.details(receipt) : help(this.selected ? t('所选记录已不在本次观察的保留窗口中，未切换到其他记录。') : t('选择一条变化查看前后内容。'))}</div>
      </div>
      <div class="collab-math-actions">
        <button type="button" class="button" data-math-reference disabled={!receipt} onClick={() => this.reference()}>{t('加入指导草稿')}</button>
        <button type="button" class="button" data-math-download disabled={!receipt} onClick={() => this.download()}>{t('下载所选记录')}</button>
        <p class="collab-help" data-math-status role="status">{this.actionStatus}</p>
      </div>
    </>);
    if (list && top > 0 && anchor?.isConnected && anchorTop !== undefined) list.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
  }

  private taskLink(ref: Reference, key: string) {
    const record = ref.taskDigest && this.observation && recordedTask(this.observation, ref.taskId, ref.taskDigest);
    return <div class="collab-math-reference">
      {record ? <button type="button" class="text-button collab-reference" data-collab-task={ref.taskId} data-task-version={ref.taskDigest!} data-focus-key={`math-task-${key}`}>{ref.taskId}{record.historical ? t(' · 历史合同') : t(' · 任务合同')}</button>
        : <span>{ref.taskId} · {ref.taskDigest ? t('合同未保留') : t('版本未记录')}</span>}
      <code>{ref.taskDigest ?? t('未记录版本')}</code></div>;
  }
  private links(refs: Reference[], key: string) { return <div class="collab-reference-list">{refs.map((ref, index) => this.taskLink(ref, `${key}-${index}`))}</div>; }
  private pairs<T>(title: string, rows: Side<T>[], render: (value: T, key: string) => VNode, key: string) {
    if (!rows.length) return null;
    const side = (value: T | undefined, suffix: string) => value ? render(value, `${key}-${suffix}`) : help(t('本侧无记录'));
    return <><h5>{title}</h5>{rows.map((row, index) => <article key={`${key}-${index}`} class="collab-math-delta"><strong>{row.title}</strong><div class="collab-math-sides">
      <div><h6>{t('变化前')}</h6>{side(row.before, `${index}-before`)}</div><div><h6>{t('变化后')}</h6>{side(row.after, `${index}-after`)}</div></div></article>)}</>;
  }
  private obligation(item: WebRecordedObligation, key: string) {
    return <>{this.taskLink(item, key)}<Facts facts={[[t('记录证明'), status(item.recordedProof)], [t('局部闭合'), yes(item.closed)], [t('分组'), item.groupId], [t('引用覆盖'), coverageStateLabel(item.referenceCoverage)], [t('数学证据摘要'), item.evidenceDigest]]} />
      {item.conditions.length ? <><p>{t('未完成条件')}</p>{this.links(item.conditions, `${key}-conditions`)}</> : null}</>;
  }
  private frontier(item: WebGoalFrontier, key: string) {
    const refs = (values: Reference[], suffix: string) => values.length ? this.links(values, `${key}-${suffix}`) : help(t('未记录开放前沿'));
    return <>{this.taskLink(item, key)}{help(item.closed ? t('记录中局部闭合') : t('目标尚未闭合'))}
      {item.routeCombination === 'any' && item.alternatives?.length ? <><p>{t('OR：路线择一')}</p>{item.alternatives.map((route, index) => <div key={index} class="collab-frontier-route"><strong>{route.routeId}</strong>{refs(route.frontier, `alternative-${index}`)}
        <p>{t('缺失依赖：{0}', listed(route.missingDependencies, t('未记录')))}</p><p>{t('停放依据：{0}', listed(route.parkedBy, t('未记录')))}</p></div>)}</> : refs(item.frontier, 'frontier')}
      {help(t('缺失依赖：{0}', listed(item.missingDependencies, t('未记录'))))}</>;
  }
  private blocker(item: WebRecordedBlocker, key: string) {
    return <>{this.taskLink(item, key)}<p>{item.mechanism}</p><Facts facts={[[t('阻塞 ID'), item.id], [t('状态'), status(item.status)], [t('作用范围'), item.scope], [t('路线'), item.routeId], [t('证据性质'), status(item.evidenceStatus)]]} />
      <Detail title={t('重开条件')} value={item.reopenOn} detailKey={`${key}-reopen`} />{item.reopenedReason ? <p>{item.reopenedReason}</p> : null}
      <Detail title={t('原始提示引用')} value={item.evidenceRefs ?? []} detailKey={`${key}-refs`} /></>;
  }
  private route(item: WebRouteObservation) {
    return <><Facts facts={[[t('路线'), item.routeId], [t('目标 ID'), item.targetTaskId], [t('收尾引理 ID'), item.closingTaskId], [t('前提 AND'), listed(item.prerequisiteTaskIds)], [t('剩余前提'), listed(item.remainingPrerequisiteTaskIds)], [t('记录就绪'), yes(item.ready)],
      [t('收尾记录'), status(item.closingStatus)], [t('目标记录'), status(item.targetStatus)], [t('连接记录'), item.connection], [t('引用覆盖缺失'), listed(item.referenceCoverageMissing)], [t('停放依据'), listed(item.parkedBy)]]} />
      {help(t('本路线记录只保存任务 ID，未据此推定历史合同版本。'))}</>;
  }
  private advisory(item: WebRecordedAdvisory, key: string) {
    return <>{this.taskLink(item, key)}<Facts facts={[[t('类型'), item.kind === 'sketch' ? t('草图') : item.kind === 'research' ? t('研究') : item.kind], [t('研究记录完成'), yes(item.completed)], [t('发现文字摘要'), item.findingDigest]]} />
      {help(t('本记录保存文字摘要，发现全文请另查交付材料。'))}</>;
  }
  private details(receipt: WebMathematicalChange) {
    const key = mathematicalChangeKey(receipt);
    // Keyed by receipt: another selection remounts, so its details start closed unless their keys were open.
    return <Fragment key={key}><h4>{summary(receipt)}</h4>{help(t('局部闭合、研究完成和路线就绪均不代替完整原题的独立验收。任务入口打开所保留的合同。'))}
      <Facts facts={[[t('记录时间'), time(receipt.at)], [t('记录性质'), receipt.kind === 'baseline' ? t('观察基线') : t('快照差异')], [t('变化前快照'), receipt.beforeDigest], [t('变化后快照'), receipt.afterDigest], [t('环境变化'), receipt.environmentChanged ? t('已记录变化，未保存两侧环境摘要') : t('未记录环境变化')]]} />
      {receipt.kind === 'baseline' ? <p class="collab-notice">{t('此条建立观察基线，不将当时已有的证明计为新闭合。')}</p> : <>
        {this.pairs(t('证明义务'), sides(receipt.obligations, { new: t('新增义务'), closed: t('局部闭合'), reopened: t('义务重开'), removed: t('移除义务'), changed: t('义务记录变化') }), (item, key) => this.obligation(item, key), `${key}-obligations`)}
        {this.pairs(t('原始目标前沿'), receipt.goalFrontiers.map(change => ({ title: change.goalId, ...change })), (item, key) => this.frontier(item, key), `${key}-frontiers`)}
        {this.pairs(t('数学阻塞'), sides(receipt.blockers, { new: t('新增阻塞'), parked: t('阻塞停放'), reopened: t('阻塞重开'), superseded: t('阻塞被替代'), removed: t('移除阻塞'), changed: t('阻塞记录变化') }), (item, key) => this.blocker(item, key), `${key}-blockers`)}
        {this.pairs(t('OR 路线'), receipt.routes.map(change => ({ title: change.routeId, ...change })), item => this.route(item), `${key}-routes`)}
        {this.pairs(t('提示性研究'), sides(receipt.advisory, { proposed: t('新增研究记录'), completed: t('研究记录完成'), reopened: t('研究记录重开'), removed: t('移除研究记录'), changed: t('研究记录变化') }), (item, key) => this.advisory(item, key), `${key}-advisory`)}
      </>}
      <Detail title={t('原始变化记录')} value={receipt} detailKey={`math-raw-${key}`} /></Fragment>;
  }
  private reference() {
    const receipt = this.selectedReceipt(), observation = this.observation; if (!receipt || !observation) return;
    const added = this.appendReference(t('[数学变化记录 · 历史观察，未重新执行 Lean]\nWeb 研究：{0}\nSolver 研究：{1}\n记录时间：{2}\n{3}\n变化前快照：{4}\n变化后快照：{5}\n依据观察 #{6} · {7}', observation.webRunId, observation.solverRunId, new Date(receipt.at).toISOString(), summary(receipt), receipt.beforeDigest ?? t('无（观察基线）'), receipt.afterDigest, observation.sequence, observation.snapshot.stateDigest));
    this.actionStatus = added ? t('所选变化的身份与摘要已加入本地指导草稿，尚未发送。') : t('指导草稿长度不足以容纳完整引用，未加入；请缩短草稿后重试。');
    this.render();
  }
  private download() {
    const receipt = this.selectedReceipt(), observation = this.observation; if (!receipt || !observation) return;
    const content = { schema: 'theoremos.web-mathematical-change-export.v1', webRunId: observation.webRunId, solverRunId: observation.solverRunId,
      observation: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest, observedAt: observation.observedAt },
      coverage: this.coverage(), receipt };
    const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `theoremos-${observation.webRunId}-mathematical-change-${receipt.at}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.actionStatus = t('已导出所选原始记录及观察归属；保留窗口范围随文件保存。');
    this.render();
  }
}

import type { WebGoalFrontier, WebMathematicalChange, WebObservation, WebRecordedAdvisory, WebRecordedBlocker, WebRecordedObligation, WebRouteObservation } from '../collaboration';
import { createElement, detailBlock, escapeHtml as h, factList, observedTime, patchSection, coverageStateLabel } from './collaborationUi';
import { recordedTask } from './researchProgressView';
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

/** A retained window of recorded snapshot differences; reading it never replays proof checks. */
export class MathematicalChangesView {
  readonly element = createElement('section', 'collab-math-changes');
  private observation?: WebObservation;
  private selected = '';
  private category: HTMLSelectElement;
  private task: HTMLSelectElement;
  private query: HTMLInputElement;

  constructor(runId: string, private appendReference: (text: string) => boolean) {
    this.element.innerHTML = `<div class="collab-section-heading"><h3 tabindex="-1" data-math-heading>${t('数学变化')}</h3><span class="collab-help" data-math-count></span></div><p class="collab-help collab-math-coverage" data-math-coverage></p>
      <div class="collab-math-filters"><label for="math-category-${h(runId)}">${t('变化类型')}<select id="math-category-${h(runId)}" data-math-category><option value="">${t('全部类型')}</option>${categories.map(([id, title]) => `<option value="${id}">${title}</option>`).join('')}</select></label>
      <label for="math-task-${h(runId)}">${t('关联任务')}<select id="math-task-${h(runId)}" data-math-task><option value="">${t('全部任务')}</option></select></label><label for="math-query-${h(runId)}">${t('检索')}<input id="math-query-${h(runId)}" type="search" data-math-query placeholder="${t('搜索版本、路线或阻塞机制')}"></label><button type="button" class="button" data-math-clear>${t('清除筛选')}</button></div>
      <div class="collab-math-layout"><div class="collab-math-list" data-math-list tabindex="0" aria-label="${t('本次观察保留的数学变化')}"></div><div class="collab-math-detail" data-math-detail></div></div>
      <div class="collab-math-actions"><button type="button" class="button" data-math-reference disabled>${t('加入指导草稿')}</button><button type="button" class="button" data-math-download disabled>${t('下载所选记录')}</button><p class="collab-help" data-math-status role="status"></p></div>`;
    this.category = this.element.querySelector('[data-math-category]')!;
    this.task = this.element.querySelector('[data-math-task]')!;
    this.query = this.element.querySelector('[data-math-query]')!;
    this.category.addEventListener('change', () => this.filter());
    this.task.addEventListener('change', () => this.filter());
    this.query.addEventListener('input', () => this.filter());
    this.element.querySelector('[data-math-clear]')!.addEventListener('click', () => { this.category.value = ''; this.task.value = ''; this.query.value = ''; this.filter(); });
    this.element.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-math-key]'); if (!button) return;
      this.selected = button.dataset.mathKey!; this.render();
    });
    this.element.querySelector('[data-math-reference]')!.addEventListener('click', () => this.reference());
    this.element.querySelector('[data-math-download]')!.addEventListener('click', () => this.download());
    this.render();
  }

  update(observation: WebObservation) {
    if (this.observation && observation.sequence < this.observation.sequence) return;
    this.observation = observation;
    const current = this.task.value;
    const tasks = [...new Set([...observation.inspection.tasks.map(task => task.id), ...this.records().flatMap(receipt => references(receipt).map(ref => ref.taskId)), ...(current ? [current] : [])])].sort();
    const markup = `<option value="">${t('全部任务')}</option>` + tasks.map(id => `<option value="${h(id)}">${h(id)}</option>`).join('');
    if (this.task.dataset.options !== markup) { this.task.innerHTML = markup; this.task.dataset.options = markup; this.task.value = current; }
    if (!this.selected) this.selected = this.filtered()[0] ? mathematicalChangeKey(this.filtered()[0]) : '';
    this.render();
  }

  showForTask(id: string) {
    this.task.value = id; this.category.value = ''; this.query.value = ''; this.filter();
    this.element.querySelector<HTMLElement>('[data-math-heading]')!.focus({ preventScroll: true });
    this.element.scrollIntoView({ block: 'start' });
  }
  private records() { return this.observation?.inspection.mathematics.recentChanges ?? []; }
  private filtered() {
    const query = this.query.value.trim().toLocaleLowerCase();
    return this.records().filter(receipt => (!this.category.value || receiptCategories(receipt).includes(this.category.value)) && (!this.task.value || references(receipt).some(ref => ref.taskId === this.task.value)) && (!query || `${summary(receipt)}\n${JSON.stringify(receipt)}`.toLocaleLowerCase().includes(query)))
      .sort((a, b) => b.at - a.at || mathematicalChangeKey(a).localeCompare(mathematicalChangeKey(b)));
  }
  private filter() {
    const items = this.filtered();
    if (!items.some(receipt => mathematicalChangeKey(receipt) === this.selected)) this.selected = items[0] ? mathematicalChangeKey(items[0]) : '';
    this.render(); this.element.querySelector('[data-math-list]')!.scrollTop = 0;
  }
  private selectedReceipt() { return this.records().find(receipt => mathematicalChangeKey(receipt) === this.selected); }
  private coverage() {
    const times = this.records().map(receipt => receipt.at);
    return { scope: 'current-observation', retainedChangeLimit: this.observation?.inspection.mathematics.retainedChangeLimit ?? 0,
      retainedRecords: times.length, oldestAt: times.length ? Math.min(...times) : null, newestAt: times.length ? Math.max(...times) : null };
  }
  private render() {
    const items = this.filtered(), coverage = this.coverage();
    this.element.querySelector('[data-math-count]')!.textContent = t('{0} / {1} 条记录', items.length, coverage.retainedRecords);
    this.element.querySelector('[data-math-coverage]')!.textContent = this.observation ? t('本次观察保留 {0} 条，运行时上限 {1} 条{2}。此处未提供完整历史覆盖；没有新记录不表示研究停滞。', coverage.retainedRecords, coverage.retainedChangeLimit, coverage.oldestAt !== null ? t('；{0} 至 {1}', time(coverage.oldestAt), time(coverage.newestAt!)) : '') : t('正在等待运行时数学变化观测。');
    const list = this.element.querySelector<HTMLElement>('[data-math-list]')!, top = list.scrollTop, left = list.scrollLeft;
    const children = [...list.children] as HTMLElement[], existing = new Map(children.filter(row => row.dataset.mathRow).map(row => [row.dataset.mathRow!, row]));
    const anchor = children.find(row => row.getBoundingClientRect().bottom > list.getBoundingClientRect().top), anchorTop = anchor?.getBoundingClientRect().top;
    const retained = new Set(items.map(mathematicalChangeKey));
    for (const row of children) if (!row.dataset.mathRow || !retained.has(row.dataset.mathRow)) row.remove();
    items.forEach((receipt, index) => {
      const key = mathematicalChangeKey(receipt), row = existing.get(key) ?? createElement('article', 'collab-math-row'); row.dataset.mathRow = key;
      patchSection(row, `<button type="button" class="collab-math-choice${key === this.selected ? ' selected' : ''}" data-math-key="${h(key)}" data-focus-key="math-${h(key)}" aria-pressed="${key === this.selected}"><span class="collab-math-meta"><time datetime="${h(new Date(receipt.at).toISOString())}">${h(time(receipt.at))}</time><span>${receipt.kind === 'baseline' ? t('观察基线') : t('记录变化')}</span></span><strong>${h(summary(receipt))}</strong><small>${h([...new Set(references(receipt).map(ref => ref.taskId))].join(', ') || t('未记录具体任务'))}</small></button>`);
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
    });
    if (!items.length) { const empty = createElement('p', 'collab-help'); empty.textContent = this.records().length ? t('没有匹配的变化记录') : t('本次观察尚无保留的数学变化记录'); list.append(empty); }
    list.scrollTop = top; list.scrollLeft = left;
    if (top > 0 && anchor?.isConnected && anchorTop !== undefined) list.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    const receipt = this.selectedReceipt();
    patchSection(this.element.querySelector('[data-math-detail]')!, receipt ? this.details(receipt) : `<p class="collab-help">${this.selected ? t('所选记录已不在本次观察的保留窗口中，未切换到其他记录。') : t('选择一条变化查看前后内容。')}</p>`);
    for (const button of this.element.querySelectorAll<HTMLButtonElement>('[data-math-reference],[data-math-download]')) button.disabled = !receipt;
  }

  private taskLink(ref: Reference, key: string) {
    const record = ref.taskDigest && this.observation && recordedTask(this.observation, ref.taskId, ref.taskDigest);
    return `<div class="collab-math-reference">${record ? `<button type="button" class="text-button collab-reference" data-collab-task="${h(ref.taskId)}" data-task-version="${h(ref.taskDigest)}" data-focus-key="math-task-${h(key)}">${h(ref.taskId)}${record.historical ? t(' · 历史合同') : t(' · 任务合同')}</button>` : `<span>${h(ref.taskId)} · ${ref.taskDigest ? t('合同未保留') : t('版本未记录')}</span>`}<code>${h(ref.taskDigest ?? t('未记录版本'))}</code></div>`;
  }
  private links(refs: Reference[], key: string) { return `<div class="collab-reference-list">${refs.map((ref, index) => this.taskLink(ref, `${key}-${index}`)).join('')}</div>`; }
  private pairs<T>(title: string, rows: Side<T>[], render: (value: T, key: string) => string, key: string) {
    if (!rows.length) return '';
    return `<h5>${title}</h5>${rows.map((row, index) => `<article class="collab-math-delta"><strong>${h(row.title)}</strong><div class="collab-math-sides"><div><h6>${t('变化前')}</h6>${row.before ? render(row.before, `${key}-${index}-before`) : `<p class="collab-help">${t('本侧无记录')}</p>`}</div><div><h6>${t('变化后')}</h6>${row.after ? render(row.after, `${key}-${index}-after`) : `<p class="collab-help">${t('本侧无记录')}</p>`}</div></div></article>`).join('')}`;
  }
  private obligation(item: WebRecordedObligation, key: string) {
    return `${this.taskLink(item, key)}${factList([[t('记录证明'), status(item.recordedProof)], [t('局部闭合'), item.closed ? t('是') : t('否')], [t('分组'), item.groupId], [t('引用覆盖'), coverageStateLabel(item.referenceCoverage)], [t('数学证据摘要'), item.evidenceDigest]])}${item.conditions.length ? `<p>${t('未完成条件')}</p>${this.links(item.conditions, `${key}-conditions`)}` : ''}`;
  }
  private frontier(item: WebGoalFrontier, key: string) {
    const refs = (values: Reference[], suffix: string) => values.length ? this.links(values, `${key}-${suffix}`) : `<p class="collab-help">${t('未记录开放前沿')}</p>`;
    return `${this.taskLink(item, key)}<p class="collab-help">${item.closed ? t('记录中局部闭合') : t('目标尚未闭合')}</p>${item.routeCombination === 'any' && item.alternatives?.length ? `<p>${t('OR：路线择一')}</p>${item.alternatives.map((route, index) => `<div class="collab-frontier-route"><strong>${h(route.routeId)}</strong>${refs(route.frontier, `alternative-${index}`)}<p>${t('缺失依赖：{0}', h(route.missingDependencies.join(', ') || t('未记录')))}</p><p>${t('停放依据：{0}', h(route.parkedBy.join(', ') || t('未记录')))}</p></div>`).join('')}` : refs(item.frontier, 'frontier')}<p class="collab-help">${t('缺失依赖：{0}', h(item.missingDependencies.join(', ') || t('未记录')))}</p>`;
  }
  private blocker(item: WebRecordedBlocker, key: string) {
    return `${this.taskLink(item, key)}<p>${h(item.mechanism)}</p>${factList([[t('阻塞 ID'), item.id], [t('状态'), status(item.status)], [t('作用范围'), item.scope], [t('路线'), item.routeId], [t('证据性质'), status(item.evidenceStatus)]])}${detailBlock(t('重开条件'), item.reopenOn, `${key}-reopen`)}${item.reopenedReason ? `<p>${h(item.reopenedReason)}</p>` : ''}${detailBlock(t('原始提示引用'), item.evidenceRefs ?? [], `${key}-refs`)}`;
  }
  private route(item: WebRouteObservation) {
    return `${factList([[t('路线'), item.routeId], [t('目标 ID'), item.targetTaskId], [t('收尾引理 ID'), item.closingTaskId], [t('前提 AND'), item.prerequisiteTaskIds.join(', ') || t('无')], [t('剩余前提'), item.remainingPrerequisiteTaskIds.join(', ') || t('无')], [t('记录就绪'), item.ready ? t('是') : t('否')], [t('收尾记录'), status(item.closingStatus)], [t('目标记录'), status(item.targetStatus)], [t('连接记录'), item.connection], [t('引用覆盖缺失'), item.referenceCoverageMissing.join(', ') || t('无')], [t('停放依据'), item.parkedBy.join(', ') || t('无')]])}<p class="collab-help">${t('本路线记录只保存任务 ID，未据此推定历史合同版本。')}</p>`;
  }
  private advisory(item: WebRecordedAdvisory, key: string) {
    return `${this.taskLink(item, key)}${factList([[t('类型'), item.kind === 'sketch' ? t('草图') : item.kind === 'research' ? t('研究') : item.kind], [t('研究记录完成'), item.completed ? t('是') : t('否')], [t('发现文字摘要'), item.findingDigest]])}<p class="collab-help">${t('本记录保存文字摘要，发现全文请另查交付材料。')}</p>`;
  }
  private details(receipt: WebMathematicalChange) {
    const key = mathematicalChangeKey(receipt);
    return `<h4>${h(summary(receipt))}</h4><p class="collab-help">${t('局部闭合、研究完成和路线就绪均不代替完整原题的 S3 验收。任务入口打开所保留的合同。')}</p>${factList([[t('记录时间'), time(receipt.at)], [t('记录性质'), receipt.kind === 'baseline' ? t('观察基线') : t('快照差异')], [t('变化前快照'), receipt.beforeDigest], [t('变化后快照'), receipt.afterDigest], [t('环境变化'), receipt.environmentChanged ? t('已记录变化，未保存两侧环境摘要') : t('未记录环境变化')]])}${receipt.kind === 'baseline' ? `<p class="collab-notice">${t('此条建立观察基线，不将当时已有的证明计为新闭合。')}</p>` :
      this.pairs(t('证明义务'), sides(receipt.obligations, { new: t('新增义务'), closed: t('局部闭合'), reopened: t('义务重开'), removed: t('移除义务'), changed: t('义务记录变化') }), (item, key) => this.obligation(item, key), `${key}-obligations`) +
      this.pairs(t('原始目标前沿'), receipt.goalFrontiers.map(change => ({ title: change.goalId, ...change })), (item, key) => this.frontier(item, key), `${key}-frontiers`) +
      this.pairs(t('数学阻塞'), sides(receipt.blockers, { new: t('新增阻塞'), parked: t('阻塞停放'), reopened: t('阻塞重开'), superseded: t('阻塞被替代'), removed: t('移除阻塞'), changed: t('阻塞记录变化') }), (item, key) => this.blocker(item, key), `${key}-blockers`) +
      this.pairs(t('OR 路线'), receipt.routes.map(change => ({ title: change.routeId, ...change })), item => this.route(item), `${key}-routes`) +
      this.pairs(t('提示性研究'), sides(receipt.advisory, { proposed: t('新增研究记录'), completed: t('研究记录完成'), reopened: t('研究记录重开'), removed: t('移除研究记录'), changed: t('研究记录变化') }), (item, key) => this.advisory(item, key), `${key}-advisory`)}${detailBlock(t('原始变化记录'), receipt, `math-raw-${key}`)}`;
  }
  private reference() {
    const receipt = this.selectedReceipt(), observation = this.observation; if (!receipt || !observation) return;
    const added = this.appendReference(t('[数学变化记录 · 历史观察，未重新执行 Lean]\nWeb 研究：{0}\nSolver 研究：{1}\n记录时间：{2}\n{3}\n变化前快照：{4}\n变化后快照：{5}\n依据观察 #{6} · {7}', observation.webRunId, observation.solverRunId, new Date(receipt.at).toISOString(), summary(receipt), receipt.beforeDigest ?? t('无（观察基线）'), receipt.afterDigest, observation.sequence, observation.snapshot.stateDigest));
    this.element.querySelector('[data-math-status]')!.textContent = added ? t('所选变化的身份与摘要已加入本地指导草稿，尚未发送。') : t('指导草稿长度不足以容纳完整引用，未加入；请缩短草稿后重试。');
  }
  private download() {
    const receipt = this.selectedReceipt(), observation = this.observation; if (!receipt || !observation) return;
    const content = { schema: 'theoremos.web-mathematical-change-export.v1', webRunId: observation.webRunId, solverRunId: observation.solverRunId,
      observation: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest, observedAt: observation.observedAt },
      coverage: this.coverage(), receipt };
    const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `theoremos-${observation.webRunId}-mathematical-change-${receipt.at}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.element.querySelector('[data-math-status]')!.textContent = t('已导出所选原始记录及观察归属；保留窗口范围随文件保存。');
  }
}

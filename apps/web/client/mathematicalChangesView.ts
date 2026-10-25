import type { WebGoalFrontier, WebMathematicalChange, WebObservation, WebRecordedAdvisory, WebRecordedBlocker, WebRecordedObligation, WebRouteObservation } from '../collaboration';
import { createElement, detailBlock, escapeHtml as h, factList, patchSection } from './collaborationUi';
import { recordedTask } from './researchProgressView';

type Reference = { taskId: string; taskDigest: string | null };
type Side<T> = { title: string; before?: T; after?: T };
type Bag<T> = Record<string, (T | { before: T; after: T })[]>;
const categories = [['baseline', '观察基线'], ['obligations', '证明义务'], ['frontiers', '原始目标前沿'], ['blockers', '数学阻塞'], ['routes', 'OR 路线'], ['advisory', '提示性研究'], ['environment', '环境变化']] as const;
const statuses: Record<string, string> = { none: '尚无证明', conditional: '有条件结果', checked: '记录为已检查', stale: '旧版本证据', unverified: '未验证', open: '待解决', parked: '已停放', reopened: '已重开', superseded: '已被替代', advisory: '提示性材料' };
const status = (value: string) => statuses[value] ?? value;
const time = (value: number) => new Date(value).toLocaleString();
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
  if (receipt.kind === 'baseline') return '建立观察基线';
  return [
    receipt.obligations.new.length && `新增义务 ${receipt.obligations.new.length}`,
    receipt.obligations.closed.length && `局部闭合 ${receipt.obligations.closed.length}`,
    receipt.obligations.reopened.length && `义务重开 ${receipt.obligations.reopened.length}`,
    receipt.obligations.removed.length && `移除义务 ${receipt.obligations.removed.length}`,
    receipt.obligations.changed.length && `义务记录变化 ${receipt.obligations.changed.length}`,
    receipt.goalFrontiers.length && `前沿变化 ${receipt.goalFrontiers.length}`,
    count(receipt.blockers) && `阻塞变化 ${count(receipt.blockers)}`,
    receipt.routes.length && `路线变化 ${receipt.routes.length}`,
    count(receipt.advisory) && `研究记录变化 ${count(receipt.advisory)}`,
    receipt.environmentChanged && '环境变化',
  ].filter(Boolean).join(' · ') || '数学快照变化';
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
    this.element.innerHTML = `<div class="collab-section-heading"><h3 tabindex="-1" data-math-heading>数学变化</h3><span class="collab-help" data-math-count></span></div><p class="collab-help collab-math-coverage" data-math-coverage></p>
      <div class="collab-math-filters"><label for="math-category-${h(runId)}">变化类型<select id="math-category-${h(runId)}" data-math-category><option value="">全部类型</option>${categories.map(([id, title]) => `<option value="${id}">${title}</option>`).join('')}</select></label>
      <label for="math-task-${h(runId)}">关联任务<select id="math-task-${h(runId)}" data-math-task><option value="">全部任务</option></select></label><label for="math-query-${h(runId)}">检索<input id="math-query-${h(runId)}" type="search" data-math-query placeholder="搜索版本、路线或阻塞机制"></label><button type="button" class="button" data-math-clear>清除筛选</button></div>
      <div class="collab-math-layout"><div class="collab-math-list" data-math-list tabindex="0" aria-label="本次观察保留的数学变化"></div><div class="collab-math-detail" data-math-detail></div></div>
      <div class="collab-math-actions"><button type="button" class="button" data-math-reference disabled>加入指导草稿</button><button type="button" class="button" data-math-download disabled>下载所选记录</button><p class="collab-help" data-math-status role="status"></p></div>`;
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
    const markup = '<option value="">全部任务</option>' + tasks.map(id => `<option value="${h(id)}">${h(id)}</option>`).join('');
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
    this.element.querySelector('[data-math-count]')!.textContent = `${items.length} / ${coverage.retainedRecords} 条记录`;
    this.element.querySelector('[data-math-coverage]')!.textContent = this.observation ? `本次观察保留 ${coverage.retainedRecords} 条，运行时上限 ${coverage.retainedChangeLimit} 条${coverage.oldestAt !== null ? `；${time(coverage.oldestAt)} 至 ${time(coverage.newestAt!)}` : ''}。此处未提供完整历史覆盖；没有新记录不表示研究停滞。` : '正在等待运行时数学变化观测。';
    const list = this.element.querySelector<HTMLElement>('[data-math-list]')!, top = list.scrollTop, left = list.scrollLeft;
    const children = [...list.children] as HTMLElement[], existing = new Map(children.filter(row => row.dataset.mathRow).map(row => [row.dataset.mathRow!, row]));
    const anchor = children.find(row => row.getBoundingClientRect().bottom > list.getBoundingClientRect().top), anchorTop = anchor?.getBoundingClientRect().top;
    const retained = new Set(items.map(mathematicalChangeKey));
    for (const row of children) if (!row.dataset.mathRow || !retained.has(row.dataset.mathRow)) row.remove();
    items.forEach((receipt, index) => {
      const key = mathematicalChangeKey(receipt), row = existing.get(key) ?? createElement('article', 'collab-math-row'); row.dataset.mathRow = key;
      patchSection(row, `<button type="button" class="collab-math-choice${key === this.selected ? ' selected' : ''}" data-math-key="${h(key)}" data-focus-key="math-${h(key)}" aria-pressed="${key === this.selected}"><span class="collab-math-meta"><time datetime="${h(new Date(receipt.at).toISOString())}">${h(time(receipt.at))}</time><span>${receipt.kind === 'baseline' ? '观察基线' : '记录变化'}</span></span><strong>${h(summary(receipt))}</strong><small>${h([...new Set(references(receipt).map(ref => ref.taskId))].join(', ') || '未记录具体任务')}</small></button>`);
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
    });
    if (!items.length) { const empty = createElement('p', 'collab-help'); empty.textContent = this.records().length ? '没有匹配的变化记录' : '本次观察尚无保留的数学变化记录'; list.append(empty); }
    list.scrollTop = top; list.scrollLeft = left;
    if (top > 0 && anchor?.isConnected && anchorTop !== undefined) list.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    const receipt = this.selectedReceipt();
    patchSection(this.element.querySelector('[data-math-detail]')!, receipt ? this.details(receipt) : `<p class="collab-help">${this.selected ? '所选记录已不在本次观察的保留窗口中，未切换到其他记录。' : '选择一条变化查看前后内容。'}</p>`);
    for (const button of this.element.querySelectorAll<HTMLButtonElement>('[data-math-reference],[data-math-download]')) button.disabled = !receipt;
  }

  private taskLink(ref: Reference, key: string) {
    const record = ref.taskDigest && this.observation && recordedTask(this.observation, ref.taskId, ref.taskDigest);
    return `<div class="collab-math-reference">${record ? `<button type="button" class="text-button collab-reference" data-collab-task="${h(ref.taskId)}" data-task-version="${h(ref.taskDigest)}" data-focus-key="math-task-${h(key)}">${h(ref.taskId)}${record.historical ? ' · 历史合同' : ' · 任务合同'}</button>` : `<span>${h(ref.taskId)} · ${ref.taskDigest ? '合同未保留' : '版本未记录'}</span>`}<code>${h(ref.taskDigest ?? '未记录版本')}</code></div>`;
  }
  private links(refs: Reference[], key: string) { return `<div class="collab-reference-list">${refs.map((ref, index) => this.taskLink(ref, `${key}-${index}`)).join('')}</div>`; }
  private pairs<T>(title: string, rows: Side<T>[], render: (value: T, key: string) => string, key: string) {
    if (!rows.length) return '';
    return `<h5>${title}</h5>${rows.map((row, index) => `<article class="collab-math-delta"><strong>${h(row.title)}</strong><div class="collab-math-sides"><div><h6>变化前</h6>${row.before ? render(row.before, `${key}-${index}-before`) : '<p class="collab-help">本侧无记录</p>'}</div><div><h6>变化后</h6>${row.after ? render(row.after, `${key}-${index}-after`) : '<p class="collab-help">本侧无记录</p>'}</div></div></article>`).join('')}`;
  }
  private obligation(item: WebRecordedObligation, key: string) {
    return `${this.taskLink(item, key)}${factList([['记录证明', status(item.recordedProof)], ['局部闭合', item.closed ? '是' : '否'], ['分组', item.groupId], ['引用覆盖', item.referenceCoverage], ['数学证据摘要', item.evidenceDigest]])}${item.conditions.length ? `<p>未完成条件</p>${this.links(item.conditions, `${key}-conditions`)}` : ''}`;
  }
  private frontier(item: WebGoalFrontier, key: string) {
    const refs = (values: Reference[], suffix: string) => values.length ? this.links(values, `${key}-${suffix}`) : '<p class="collab-help">未记录开放前沿</p>';
    return `${this.taskLink(item, key)}<p class="collab-help">${item.closed ? '记录中局部闭合' : '目标尚未闭合'}</p>${item.routeCombination === 'any' && item.alternatives?.length ? `<p>OR：路线择一</p>${item.alternatives.map((route, index) => `<div class="collab-frontier-route"><strong>${h(route.routeId)}</strong>${refs(route.frontier, `alternative-${index}`)}<p>缺失依赖：${h(route.missingDependencies.join(', ') || '未记录')}</p><p>停放依据：${h(route.parkedBy.join(', ') || '未记录')}</p></div>`).join('')}` : refs(item.frontier, 'frontier')}<p class="collab-help">缺失依赖：${h(item.missingDependencies.join(', ') || '未记录')}</p>`;
  }
  private blocker(item: WebRecordedBlocker, key: string) {
    return `${this.taskLink(item, key)}<p>${h(item.mechanism)}</p>${factList([['阻塞 ID', item.id], ['状态', status(item.status)], ['作用范围', item.scope], ['路线', item.routeId], ['证据性质', status(item.evidenceStatus)]])}${detailBlock('重开条件', item.reopenOn, `${key}-reopen`)}${item.reopenedReason ? `<p>${h(item.reopenedReason)}</p>` : ''}${detailBlock('原始提示引用', item.evidenceRefs ?? [], `${key}-refs`)}`;
  }
  private route(item: WebRouteObservation) {
    return `${factList([['路线', item.routeId], ['目标 ID', item.targetTaskId], ['收尾引理 ID', item.closingTaskId], ['前提 AND', item.prerequisiteTaskIds.join(', ') || '无'], ['剩余前提', item.remainingPrerequisiteTaskIds.join(', ') || '无'], ['记录就绪', item.ready ? '是' : '否'], ['收尾记录', status(item.closingStatus)], ['目标记录', status(item.targetStatus)], ['连接记录', item.connection], ['引用覆盖缺失', item.referenceCoverageMissing.join(', ') || '无'], ['停放依据', item.parkedBy.join(', ') || '无']])}<p class="collab-help">本路线记录只保存任务 ID，未据此推定历史合同版本。</p>`;
  }
  private advisory(item: WebRecordedAdvisory, key: string) {
    return `${this.taskLink(item, key)}${factList([['类型', item.kind], ['研究记录完成', item.completed ? '是' : '否'], ['发现文字摘要', item.findingDigest]])}<p class="collab-help">本记录保存文字摘要，发现全文请另查交付材料。</p>`;
  }
  private details(receipt: WebMathematicalChange) {
    const key = mathematicalChangeKey(receipt);
    return `<h4>${h(summary(receipt))}</h4><p class="collab-help">局部闭合、研究完成和路线就绪均不代替完整原题的 S3 验收。任务入口打开所保留的合同。</p>${factList([['记录时间', time(receipt.at)], ['记录性质', receipt.kind === 'baseline' ? '观察基线' : '快照差异'], ['变化前快照', receipt.beforeDigest], ['变化后快照', receipt.afterDigest], ['环境变化', receipt.environmentChanged ? '已记录变化，未保存两侧环境摘要' : '未记录环境变化']])}${receipt.kind === 'baseline' ? '<p class="collab-notice">此条建立观察基线，不将当时已有的证明计为新闭合。</p>' :
      this.pairs('证明义务', sides(receipt.obligations, { new: '新增义务', closed: '局部闭合', reopened: '义务重开', removed: '移除义务', changed: '义务记录变化' }), (item, key) => this.obligation(item, key), `${key}-obligations`) +
      this.pairs('原始目标前沿', receipt.goalFrontiers.map(change => ({ title: change.goalId, ...change })), (item, key) => this.frontier(item, key), `${key}-frontiers`) +
      this.pairs('数学阻塞', sides(receipt.blockers, { new: '新增阻塞', parked: '阻塞停放', reopened: '阻塞重开', superseded: '阻塞被替代', removed: '移除阻塞', changed: '阻塞记录变化' }), (item, key) => this.blocker(item, key), `${key}-blockers`) +
      this.pairs('OR 路线', receipt.routes.map(change => ({ title: change.routeId, ...change })), item => this.route(item), `${key}-routes`) +
      this.pairs('提示性研究', sides(receipt.advisory, { proposed: '新增研究记录', completed: '研究记录完成', reopened: '研究记录重开', removed: '移除研究记录', changed: '研究记录变化' }), (item, key) => this.advisory(item, key), `${key}-advisory`)
    }${detailBlock('原始变化记录', receipt, `math-raw-${key}`)}`;
  }
  private reference() {
    const receipt = this.selectedReceipt(), observation = this.observation; if (!receipt || !observation) return;
    const added = this.appendReference(`[数学变化记录 · 历史观察，未重新执行 Lean]\nWeb 研究：${observation.webRunId}\nSolver 研究：${observation.solverRunId}\n记录时间：${new Date(receipt.at).toISOString()}\n${summary(receipt)}\n变化前快照：${receipt.beforeDigest ?? '无（观察基线）'}\n变化后快照：${receipt.afterDigest}\n依据观察 #${observation.sequence} · ${observation.snapshot.stateDigest}`);
    this.element.querySelector('[data-math-status]')!.textContent = added ? '所选变化的身份与摘要已加入本地指导草稿，尚未发送。' : '指导草稿长度不足以容纳完整引用，未加入；请缩短草稿后重试。';
  }
  private download() {
    const receipt = this.selectedReceipt(), observation = this.observation; if (!receipt || !observation) return;
    const content = { schema: 'theoremos.web-mathematical-change-export.v1', webRunId: observation.webRunId, solverRunId: observation.solverRunId,
      observation: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest, observedAt: observation.observedAt },
      coverage: this.coverage(), receipt };
    const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `theoremos-${observation.webRunId}-mathematical-change-${receipt.at}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.element.querySelector('[data-math-status]')!.textContent = '已导出所选原始记录及观察归属；保留窗口范围随文件保存。';
  }
}

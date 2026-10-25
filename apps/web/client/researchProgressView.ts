import type { WebCheckReceipt, WebDelivery, WebObservation } from '../collaboration';
import { codeBlock, createElement, detailBlock, escapeHtml as h, factList, patchSection } from './collaborationUi';
import { taskSourceKey } from './taskSourceComparison';

export function recordedTask(observation: WebObservation, id: string, version?: string) {
  const task = observation.inspection.tasks.find(task => task.id === id && (!version || task.version === version));
  if (task) return { task, historical: false };
  const previous = version && observation.history?.find(task => task.id === id && task.version === version);
  return previous ? { task: previous, historical: true } : undefined;
}

export const taskCheckKey = (check: WebCheckReceipt) => JSON.stringify([check.id, check.taskId, check.taskVersion, check.commit, check.sourceDigest, check.environmentDigest]);
const kindLabels: Record<string, string> = { progress: '研究进展', research: '研究发现', proof: '证明交付', review: '审阅', backtranslation: '声明回译', 'statement-review': '声明审阅', failure: '失败报告' };
const statusLabels: Record<string, string> = { active: '生效中', advisory: '提示性材料', conditional: '有条件结果', verified: '记录为已验证', failed: '失败', superseded: '已被替代', accepted: '审阅接受', changes_requested: '请求修改', open: '待解决', parked: '已停放', reopened: '已重开' };
const label = (value: string) => statusLabels[value] ?? value;
const proofLabels: Record<string, string> = { none: '尚无证明', conditional: '有条件结果', checked: '已记录检查', stale: '旧版本证据', unverified: '未验证' };
const scopeLabels: Record<string, string> = { 'assigned-local-inference': '当前任务的局部推理' };

/** Browse recorded mathematical frontiers and immutable Agent publications without inferring acceptance. */
export class ResearchProgressView {
  readonly overview = createElement('section', 'collab-research-overview');
  readonly element = createElement('section', 'collab-deliveries');
  private observation?: WebObservation;
  private selected = '';
  private producer: HTMLSelectElement;
  private task: HTMLSelectElement;
  private query: HTMLInputElement;

  constructor(runId: string) {
    this.overview.innerHTML = `<div class="collab-section-heading"><h3>证明前沿</h3><span class="collab-help">记录的局部闭合不代表原题通过 S3 验收</span></div><div data-research-frontier class="collab-frontier-list"></div><div data-research-waiting></div><div class="collab-section-heading collab-research-blocker-heading"><h3>数学阻塞</h3><span class="collab-help">作用范围与重开条件</span></div><div data-research-blockers class="collab-blocker-list"></div>`;
    this.element.setAttribute('data-research-deliveries', '');
    this.element.innerHTML = `<div class="collab-section-heading"><h3 tabindex="-1" data-delivery-heading>研究交付</h3><span class="collab-help" data-delivery-count></span></div><p class="collab-help collab-delivery-intro">Agent 的交付内容、所用前提与未完成义务；检查状态以对应材料的回执为准。</p>
      <div class="collab-delivery-filters"><label for="delivery-producer-${h(runId)}">Agent<select id="delivery-producer-${h(runId)}" data-delivery-producer><option value="">全部 Agent</option></select></label><label for="delivery-task-${h(runId)}">任务<select id="delivery-task-${h(runId)}" data-delivery-task><option value="">全部任务</option></select></label><label for="delivery-query-${h(runId)}">检索<input type="search" id="delivery-query-${h(runId)}" data-delivery-query placeholder="搜索声明、发现或交付 ID"></label><button type="button" class="button" data-delivery-clear>清除筛选</button></div>
      <div class="collab-delivery-layout"><div class="collab-delivery-list" data-delivery-list tabindex="0" aria-label="本次观察中的研究交付"></div><div class="collab-delivery-detail" data-delivery-detail></div></div>`;
    this.producer = this.element.querySelector('[data-delivery-producer]')!;
    this.task = this.element.querySelector('[data-delivery-task]')!;
    this.query = this.element.querySelector('[data-delivery-query]')!;
    for (const control of [this.producer, this.task]) control.addEventListener('change', () => this.filter());
    this.query.addEventListener('input', () => this.filter());
    this.element.querySelector('[data-delivery-clear]')!.addEventListener('click', () => { this.producer.value = ''; this.task.value = ''; this.query.value = ''; this.filter(); });
    this.element.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-delivery-id]');
      if (!button) return;
      this.selected = button.dataset.deliveryId!; this.renderDeliveries();
    });
  }

  update(observation: WebObservation) {
    if (this.observation && observation.sequence < this.observation.sequence) return;
    this.observation = observation;
    this.options(this.producer, [...new Set([...(observation.deliveries ?? []).map(item => item.producer), ...observation.inspection.workers.map(worker => worker.id)])], '全部 Agent');
    this.options(this.task, [...new Set([...(observation.deliveries ?? []).flatMap(item => item.taskId ? [item.taskId] : []), ...observation.inspection.tasks.map(task => task.id)])], '全部任务');
    if (!this.selected) this.selected = this.filtered()[0]?.id ?? '';
    this.renderOverview(); this.renderDeliveries();
  }

  showForWorker(id: string) { this.producer.value = id; this.task.value = ''; this.query.value = ''; this.filter(); this.focus(); }
  showForTask(id: string) { this.task.value = id; this.producer.value = ''; this.query.value = ''; this.filter(); this.focus(); }
  private focus() { this.element.querySelector<HTMLElement>('[data-delivery-heading]')!.focus({ preventScroll: true }); this.element.scrollIntoView({ block: 'start' }); }

  private options(select: HTMLSelectElement, values: string[], all: string) {
    const current = select.value;
    if (current && !values.includes(current)) values.push(current);
    const markup = `<option value="">${all}</option>` + values.sort().map(value => `<option value="${h(value)}">${h(value)}</option>`).join('');
    if (select.dataset.options !== markup) { select.innerHTML = markup; select.dataset.options = markup; select.value = current; }
  }

  private taskLink(id: string, version: string | null | undefined, key: string) {
    const record = version && this.observation ? recordedTask(this.observation, id, version) : undefined;
    return record ? `<button type="button" class="text-button collab-reference" data-collab-task="${h(id)}" data-task-version="${h(version)}" data-focus-key="${h(key)}" aria-label="查看任务 ${h(id)} 的版本 ${h(version)}">${h(id)}${record.historical ? ' · 历史版本' : ''}</button>` : `<span class="collab-reference">${h(id)} · ${version ? '合同未保留' : '版本未记录'}</span>`;
  }

  private routeSteps(routeId: string) {
    const route = this.observation!.inspection.mathematics.snapshot.routes.find(item => item.routeId === routeId);
    if (!route) return '';
    const total = route.prerequisiteTaskIds.length, remaining = route.remainingPrerequisiteTaskIds.length;
    const closing = route.closingStatus === 'checked' ? 'done' : route.closingStatus === 'conditional' ? 'partial' : 'waiting';
    const steps: [string, string, string][] = [
      [total ? remaining ? 'partial' : 'done' : 'done', '前置', total ? `${total - remaining} / ${total} 已就绪${remaining ? ` · 等待 ${route.remainingPrerequisiteTaskIds.join(', ')}` : ''}` : '无额外前置'],
      [closing, `收束 ${route.closingTaskId}`, proofLabels[route.closingStatus] ?? route.closingStatus],
      [route.connection === 'closed-by-original-check' ? 'done' : 'waiting', `连通 ${route.targetTaskId}`, route.connection === 'closed-by-original-check' ? '已由原题检查连通' : '等待原题检查'],
    ];
    return `<ol class="collab-route-steps" aria-label="路线 ${h(routeId)} 的记录进度">${steps.map(([state, title, detail]) => `<li data-step-state="${state}"><strong>${h(title)}</strong><span>${h(detail)}</span></li>`).join('')}</ol>`;
  }

  private renderOverview() {
    const observation = this.observation!, snapshot = observation.inspection.mathematics.snapshot;
    const refs = (items: { taskId: string; taskDigest: string | null }[], key: string) => items.map((item, index) => this.taskLink(item.taskId, item.taskDigest, `${key}-${index}`)).join('') || '<span class="collab-help">未记录开放前沿</span>';
    patchSection(this.overview.querySelector('[data-research-frontier]')!, snapshot.goals.map(goal => `<article class="collab-frontier-goal" data-frontier-goal="${h(goal.taskId)}"><div class="collab-section-heading">${this.taskLink(goal.taskId, goal.taskDigest, `goal-${goal.taskId}`)}<span class="badge">${goal.closed ? '记录中局部闭合' : '待推进'}</span></div>${goal.routeCombination === 'any' && goal.alternatives?.length ? `<p class="collab-help">OR：以下路线择一</p>${goal.alternatives.map(route => `<div class="collab-frontier-route"><strong>${h(route.routeId)}</strong>${this.routeSteps(route.routeId)}<div class="collab-reference-list"><span class="collab-reference-caption">当前前沿</span>${refs(route.frontier, `frontier-${goal.taskId}-${route.routeId}`)}</div>${route.missingDependencies.length ? `<p>缺失依赖：${h(route.missingDependencies.join(', '))}</p>` : ''}${route.parkedBy.length ? `<p>停放依据：${h(route.parkedBy.join(', '))}</p>` : ''}</div>`).join('')}` : `<div class="collab-reference-list">${refs(goal.frontier, `frontier-${goal.taskId}`)}</div>`}${goal.missingDependencies.length ? `<p class="collab-help">缺失依赖：${h(goal.missingDependencies.join(', '))}</p>` : ''}</article>`).join('') || `<p class="collab-help">${snapshot.blockers.length ? '本次观察尚无原始目标的证明前沿' : '本次观察尚无原始目标的证明前沿，也没有已记录的数学阻塞'}</p>`);
    this.overview.dataset.empty = String(!snapshot.goals.length && !snapshot.blockers.length);
    const blockerCount = this.overview.querySelector<HTMLElement>('.collab-research-blocker-heading>.collab-help')!;
    const openBlockers = snapshot.blockers.filter(blocker => !['parked', 'superseded'].includes(blocker.status)).length;
    const blockerText = snapshot.blockers.length ? `${openBlockers} 项生效 · 共 ${snapshot.blockers.length} 项记录` : '作用范围与重开条件';
    if (blockerCount.textContent !== blockerText) blockerCount.textContent = blockerText;
    patchSection(this.overview.querySelector('[data-research-waiting]')!, observation.inspection.waiting ? `<div class="collab-research-waiting"><strong>研究正在等待新的数学输入</strong><p>${h(observation.inspection.waiting.reason)}</p>${factList([['等待任务', observation.inspection.waiting.taskIds.join(', ') || '未记录'], ['关联目标', observation.inspection.waiting.goalIds.join(', ') || '未记录']])}</div>` : '');
    patchSection(this.overview.querySelector('[data-research-blockers]')!, snapshot.blockers.map(blocker => `<article class="collab-research-blocker" data-research-blocker="${h(blocker.id)}"><div class="collab-section-heading">${this.taskLink(blocker.taskId, blocker.taskDigest, `blocker-${blocker.id}`)}<span class="badge">${h(label(blocker.status))}</span></div><p><code class="collab-blocker-mechanism">${h(blocker.mechanism)}</code></p>${factList([['阻塞 ID', blocker.id], ['作用范围', scopeLabels[blocker.scope] ?? blocker.scope], ['路线', blocker.routeId ?? '未限定路线'], ['证据性质', label(blocker.evidenceStatus)]])}${detailBlock('重开条件', blocker.reopenOn, `reopen-${blocker.id}`)}${blocker.evidenceRefs?.length ? detailBlock('原始提示引用', blocker.evidenceRefs, `blocker-refs-${blocker.id}`) : ''}</article>`).join('') || '<p class="collab-help">本次观察没有已记录的数学阻塞</p>');
  }

  private filtered() {
    const query = this.query.value.trim().toLocaleLowerCase();
    return (this.observation?.deliveries ?? []).filter(item => (!this.producer.value || item.producer === this.producer.value) && (!this.task.value || item.taskId === this.task.value) && (!query || [item.id, item.summary, item.statement, item.finding, item.taskId, item.taskDigest].join('\n').toLocaleLowerCase().includes(query)))
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }

  private filter() {
    const items = this.filtered();
    if (!items.some(item => item.id === this.selected)) this.selected = items[0]?.id ?? '';
    this.renderDeliveries(); this.element.querySelector('[data-delivery-list]')!.scrollTop = 0;
  }

  private relationship(delivery: WebDelivery) {
    if (!delivery.taskId || !delivery.taskDigest) return '任务版本未记录';
    const task = this.observation && recordedTask(this.observation, delivery.taskId, delivery.taskDigest);
    return task ? task.historical ? '历史任务版本' : '当前任务版本' : '任务合同未保留';
  }

  private renderDeliveries() {
    const items = this.filtered(), observation = this.observation;
    this.element.querySelector('[data-delivery-count]')!.textContent = `${items.length} / ${observation?.deliveries?.length ?? 0} 条记录`;
    const list = this.element.querySelector<HTMLElement>('[data-delivery-list]')!;
    const top = list.scrollTop, left = list.scrollLeft;
    const anchor = [...list.children].find(node => node.getBoundingClientRect().bottom > list.getBoundingClientRect().top);
    const anchorId = (anchor as HTMLElement | undefined)?.dataset.deliveryRow, anchorTop = anchor?.getBoundingClientRect().top;
    const retained = new Set(items.map(item => item.id));
    for (const child of [...list.children]) if (!(child instanceof HTMLElement) || !child.dataset.deliveryRow || !retained.has(child.dataset.deliveryRow)) child.remove();
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      let row = [...list.children].find(child => (child as HTMLElement).dataset.deliveryRow === item.id) as HTMLElement | undefined;
      if (!row) { row = createElement('article', 'collab-delivery-row'); row.dataset.deliveryRow = item.id; }
      patchSection(row, `<button type="button" class="collab-delivery-choice${item.id === this.selected ? ' selected' : ''}" data-delivery-id="${h(item.id)}" data-focus-key="delivery-${h(item.id)}" aria-pressed="${item.id === this.selected}"><span class="collab-delivery-meta"><strong>${h(item.producer)}</strong><span>${h(kindLabels[item.kind] ?? item.kind)} · ${h(label(item.status))}</span></span><span class="collab-delivery-summary">${h(item.summary || item.statement || item.id)}</span><small>${h(item.taskId ?? '未绑定任务')} · ${h(this.relationship(item))}</small></button>`);
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
    }
    if (!items.length) {
      const message = createElement('p', 'collab-help');
      message.textContent = observation?.deliveries === undefined ? '此运行未提供交付记录' : observation.deliveries.length ? '没有匹配的交付记录' : '本次观察尚无 Agent 交付';
      list.append(message);
    }
    list.scrollTop = top; list.scrollLeft = left;
    const movedAnchor = anchorId && [...list.children].find(child => (child as HTMLElement).dataset.deliveryRow === anchorId);
    if (top > 0 && movedAnchor && anchorTop !== undefined) list.scrollTop += movedAnchor.getBoundingClientRect().top - anchorTop;
    const delivery = observation?.deliveries?.find(item => item.id === this.selected);
    patchSection(this.element.querySelector('[data-delivery-detail]')!, delivery ? this.deliveryDetails(delivery) : `<p class="collab-help">${this.selected ? '原选择不在本次观察中，未切换到其他交付。' : '选择一条交付查看声明与证据。'}</p>`);
  }

  private deliveryDetails(delivery: WebDelivery) {
    const observation = this.observation!, environment = observation.inspection.configuration.environmentDigest;
    const mathematicalSource = !['statement-review', 'backtranslation'].includes(delivery.kind);
    const bound = mathematicalSource && delivery.taskId && delivery.taskDigest && delivery.commit && delivery.sourceDigest && recordedTask(observation, delivery.taskId, delivery.taskDigest);
    const same = (item: { taskId: string; taskVersion: string; commit: string; sourceDigest: string; environmentDigest: string }) => Boolean(bound && environment && item.taskId === delivery.taskId && item.taskVersion === delivery.taskDigest && item.commit === delivery.commit && item.sourceDigest === delivery.sourceDigest && item.environmentDigest === environment);
    const sources = observation.sources.filter(same);
    const verification = delivery.evidence?.verification;
    const checkIds = new Set(verification && verification.targetCommit === delivery.commit ? verification.results.map(item => item.receiptId) : []);
    const checks = observation.checks.filter(check => same(check) && checkIds.has(check.id));
    return `<h4 tabindex="-1">${h(kindLabels[delivery.kind] ?? delivery.kind)} · ${h(delivery.producer)}</h4><p class="collab-help">交付状态：${h(label(delivery.status))} · ${h(this.relationship(delivery))}。局部交付与审阅不代表完整原题验收。</p>${factList([['交付 ID', delivery.id], ['任务', delivery.taskId], ['任务版本', delivery.taskDigest], ['创建时间', new Date(delivery.createdAt).toLocaleString()], ['commit', delivery.commit], [mathematicalSource ? '记录摘要' : '声明快照摘要', delivery.sourceDigest]])}
      <div class="collab-reference-list">${delivery.taskId ? this.taskLink(delivery.taskId, delivery.taskDigest, `delivery-task-${delivery.id}`) : '<span class="collab-help">本交付未绑定任务合同</span>'}</div><h5>摘要</h5><p class="collab-delivery-text">${h(delivery.summary || '未记录摘要')}</p><h5>声明</h5>${codeBlock(delivery.statement)}${detailBlock('前提', delivery.premises, `delivery-premises-${delivery.id}`)}<h5>版本固定的依赖</h5><div class="collab-reference-list">${delivery.dependencies.map((item, index) => this.taskLink(item.taskId, item.taskDigest, `delivery-dependency-${delivery.id}-${index}`)).join('') || '<span class="collab-help">未记录任务依赖</span>'}</div>${delivery.dependencies.length ? detailBlock('依赖版本', delivery.dependencies, `delivery-dependencies-${delivery.id}`) : ''}${detailBlock('未完成义务', delivery.remainingObligations, `delivery-obligations-${delivery.id}`)}${delivery.finding ? detailBlock('完整研究发现', delivery.finding, `delivery-finding-${delivery.id}`) : ''}
      <h5>对应材料</h5><div class="collab-artifact-links">${sources.map(source => `<button type="button" class="button" data-collab-source="${h(source.taskId)}" data-source-version="${h(source.taskVersion)}" data-source-snapshot="${h(taskSourceKey(source))}" data-focus-key="delivery-source-${h(taskSourceKey(source))}">已保存源码 · ${h(source.file)} · ${h(source.commit.slice(0, 8))}</button>`).join('')}${checks.map(check => `<button type="button" class="button" data-collab-check="${h(check.id)}" data-check-identity="${h(taskCheckKey(check))}" data-focus-key="delivery-check-${h(taskCheckKey(check))}">关联检查 · ${h(check.id)}</button>`).join('')}</div>${!sources.length ? '<p class="collab-help">本次观察中未关联到身份一致的已保存源码。</p>' : ''}${!checks.length ? '<p class="collab-help">本次观察中未关联到交付明确引用且身份一致的检查回执。</p>' : ''}${sources.length || checks.length ? factList([['材料环境', [...new Set([...sources, ...checks].map(item => item.environmentDigest))].join(', ')]]) : ''}
      <h5>原始提示引用</h5><p class="collab-help">由 Agent 提供的文字引用，未自动解释为检查回执或可访问路径。</p>${codeBlock(delivery.evidenceRefs)}${delivery.evidence ? detailBlock('交付附带的检查记录', delivery.evidence, `delivery-evidence-${delivery.id}`) : ''}`;
  }
}

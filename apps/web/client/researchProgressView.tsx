import { Fragment } from 'preact';
import type { WebCheckReceipt, WebDelivery, WebObservation } from '../collaboration';
import { createElement, observedTime } from './collaborationUi';
import { taskSourceKey } from './taskSourceComparison';
import { Code, Detail, Facts, renderSection } from './ui/Section';
import { locale, localizeText, t } from '../i18n';

const tx = (zh: string, en: string) => locale === 'en' ? en : zh;

export function recordedTask(observation: WebObservation, id: string, version?: string) {
  const task = observation.inspection.tasks.find(task => task.id === id && (!version || task.version === version));
  if (task) return { task, historical: false };
  const previous = version && observation.history?.find(task => task.id === id && task.version === version);
  return previous ? { task: previous, historical: true } : undefined;
}

export const taskCheckKey = (check: WebCheckReceipt) => JSON.stringify([check.id, check.taskId, check.taskVersion, check.commit, check.sourceDigest, check.environmentDigest]);
export const kindLabels: Record<string, string> = { progress: t('研究进展'), research: t('研究发现'), proof: t('证明交付'), review: t('审阅'), backtranslation: t('声明回译'), 'statement-review': t('声明审阅'), failure: t('失败报告') };
export const statusLabels: Record<string, string> = { active: t('生效中'), advisory: t('提示性材料'), conditional: t('有条件结果'), verified: t('记录为已验证'), failed: t('失败'), superseded: t('已被替代'), accepted: t('审阅接受'), changes_requested: t('请求修改'), open: t('待解决'), parked: t('已停放'), reopened: t('已重开') };
const label = (value: string) => statusLabels[value] ?? value;
const proofLabels: Record<string, string> = { none: t('尚无证明'), conditional: t('有条件结果'), checked: t('已记录检查'), stale: t('旧版本证据'), unverified: t('未验证') };
const scopeLabels: Record<string, string> = { 'assigned-local-inference': t('当前任务的局部推理') };
const help = (text: string) => <p class="collab-help">{text}</p>;
/** Filter choices keep the current value even after it leaves the observation. */
const choices = (values: Iterable<string>, current: string) => [...new Set([...values, ...(current ? [current] : [])])].sort();

/** Browse recorded mathematical frontiers and immutable Agent publications without inferring acceptance. */
export class ResearchProgressView {
  readonly overview = createElement('section', 'collab-research-overview');
  readonly element = createElement('section', 'collab-deliveries');
  private observation?: WebObservation;
  private selected = '';
  private producer = '';
  private task = '';
  private query = '';
  private producers: string[] = [];
  private tasks: string[] = [];

  constructor(private runId: string) {
    this.element.setAttribute('data-research-deliveries', '');
    this.renderOverview(); this.renderDeliveries();
  }

  update(observation: WebObservation) {
    if (this.observation && observation.sequence < this.observation.sequence) return;
    this.observation = observation;
    this.producers = choices([...(observation.deliveries ?? []).map(item => item.producer), ...observation.inspection.workers.map(worker => worker.id)], this.producer);
    this.tasks = choices([...(observation.deliveries ?? []).flatMap(item => item.taskId ? [item.taskId] : []), ...observation.inspection.tasks.map(task => task.id)], this.task);
    if (!this.selected) this.selected = this.filtered()[0]?.id ?? '';
    this.renderOverview(); this.renderDeliveries();
  }

  showForWorker(id: string) { this.producer = id; this.producers = choices(this.producers, id); this.task = ''; this.query = ''; this.filter(); this.focus(); }
  showForTask(id: string) { this.task = id; this.tasks = choices(this.tasks, id); this.producer = ''; this.query = ''; this.filter(); this.focus(); }
  private focus() { this.element.querySelector<HTMLElement>('[data-delivery-heading]')!.focus({ preventScroll: true }); this.element.scrollIntoView({ block: 'start' }); }

  private taskLink(id: string, version: string | null | undefined, key: string) {
    const record = version && this.observation ? recordedTask(this.observation, id, version) : undefined;
    return record ? <button key={key} type="button" class="text-button collab-reference" data-collab-task={id} data-task-version={version!} data-focus-key={key} aria-label={t('查看任务 {0} 的版本 {1}', id, version!)}>{id}{record.historical ? t(' · 历史版本') : ''}</button>
      : <span key={key} class="collab-reference">{id} · {version ? t('合同未保留') : t('版本未记录')}</span>;
  }

  private routeSteps(routeId: string) {
    const route = this.observation!.inspection.mathematics.snapshot.routes.find(item => item.routeId === routeId);
    if (!route) return null;
    const total = route.prerequisiteTaskIds.length, remaining = route.remainingPrerequisiteTaskIds.length;
    const closing = route.closingStatus === 'checked' ? 'done' : route.closingStatus === 'conditional' ? 'partial' : 'waiting';
    const steps: [string, string, string][] = [
      [total ? remaining ? 'partial' : 'done' : 'done', tx('依赖任务', 'Dependencies'), total ? t('{0} / {1} 已就绪{2}', total - remaining, total, remaining ? t(' · 等待 {0}', route.remainingPrerequisiteTaskIds.join(', ')) : '') : tx('无额外依赖', 'No additional dependencies')],
      [closing, `${closing === 'done' ? tx('证明任务', 'Proof task') : tx('待证明', 'To prove')} ${route.closingTaskId}`, proofLabels[route.closingStatus] ?? route.closingStatus],
      [route.connection === 'closed-by-original-check' ? 'done' : 'waiting', `${tx('原目标检查', 'Original goal check')} ${route.targetTaskId}`, route.connection === 'closed-by-original-check' ? tx('已记录通过', 'Pass recorded') : tx('尚未记录通过', 'No pass recorded')],
    ];
    return <ol class="collab-route-steps" aria-label={t('路线 {0} 的记录进度', routeId)}>{steps.map(([state, title, detail]) => <li key={title} data-step-state={state}><strong>{title}</strong><span>{detail}</span></li>)}</ol>;
  }
  private frontier(observation: WebObservation) {
    if (observation.inspection.configuration.researchMode === 'skill') return <>
      {help(tx('研究直接围绕固定原题进行，尚未记录为完整原题验收通过。', 'Research works directly on the frozen original problem; this observation does not establish acceptance.'))}
      <Facts facts={observation.inspection.problem.targets.map(target => [target.theoremName, target.proofPath] as const)} />
    </>;
    const snapshot = observation.inspection.mathematics.snapshot;
    const refs = (items: { taskId: string; taskDigest: string | null }[], key: string) => items.length ? items.map((item, index) => this.taskLink(item.taskId, item.taskDigest, `${key}-${index}`)) : <span class="collab-help">{tx('未记录待完成任务', 'No remaining tasks recorded')}</span>;
    if (!snapshot.goals.length) return help(tx('尚无原目标的任务记录', 'No tasks for the original goal recorded yet'));
    return snapshot.goals.map(goal => <article key={goal.taskId} class="collab-frontier-goal" data-frontier-goal={goal.taskId}>
      <div class="collab-section-heading">{this.taskLink(goal.taskId, goal.taskDigest, `goal-${goal.taskId}`)}<span class="badge">{goal.closed ? tx('记录为局部完成', 'Recorded as locally complete') : tx('尚待完成', 'Remaining work')}</span></div>
      {goal.routeCombination === 'any' && goal.alternatives?.length ? <>{help(tx('以下路线任选一条', 'Any one of these routes'))}{goal.alternatives.map(route => <div key={route.routeId} class="collab-frontier-route">
        <strong>{route.routeId}</strong>{this.routeSteps(route.routeId)}
        <div class="collab-reference-list"><span class="collab-reference-caption">{tx('尚待完成', 'Remaining work')}</span>{refs(route.frontier, `frontier-${goal.taskId}-${route.routeId}`)}</div>
        {route.missingDependencies.length ? <p>{t('缺失依赖：{0}', route.missingDependencies.join(', '))}</p> : null}
        {route.parkedBy.length ? <p>{tx('暂不继续的原因', 'Paused because')}: {route.parkedBy.join(', ')}</p> : null}
      </div>)}</> : <div class="collab-reference-list">{refs(goal.frontier, `frontier-${goal.taskId}`)}</div>}
      {goal.missingDependencies.length ? help(t('缺失依赖：{0}', goal.missingDependencies.join(', '))) : null}
    </article>);
  }

  private blockers(observation: WebObservation) {
    const { blockers } = observation.inspection.mathematics.snapshot;
    if (!blockers.length) return help(t('本次观察没有已记录的数学阻塞'));
    return blockers.map(blocker => <article key={blocker.id} class="collab-research-blocker" data-research-blocker={blocker.id}>
      <div class="collab-section-heading">{this.taskLink(blocker.taskId, blocker.taskDigest, `blocker-${blocker.id}`)}<span class="badge">{label(blocker.status)}</span></div>
      <p><code class="collab-blocker-mechanism">{blocker.mechanism}</code></p>
      <Facts facts={[[t('阻塞 ID'), blocker.id], [t('作用范围'), scopeLabels[blocker.scope] ?? blocker.scope], [t('路线'), blocker.routeId ?? t('未限定路线')], [t('证据性质'), label(blocker.evidenceStatus)]]} />
      <Detail title={t('重开条件')} value={blocker.reopenOn} detailKey={`reopen-${blocker.id}`} />
      {blocker.evidenceRefs?.length ? <Detail title={t('原始提示引用')} value={blocker.evidenceRefs} detailKey={`blocker-refs-${blocker.id}`} /> : null}
    </article>);
  }

  private renderOverview() {
    const observation = this.observation, snapshot = observation?.inspection.mathematics.snapshot, waiting = observation?.inspection.waiting;
    const skill = observation?.inspection.configuration.researchMode === 'skill';
    if (snapshot) this.overview.dataset.empty = String(!snapshot.goals.length && !snapshot.blockers.length);
    const openBlockers = snapshot?.blockers.filter(blocker => !['parked', 'superseded'].includes(blocker.status)).length ?? 0;
    renderSection(this.overview, <>
      <div class="collab-section-heading"><h3>{tx('目标与待办', 'Goals and remaining work')}</h3><span class="collab-help">{tx('局部任务完成不代表原题通过独立验收', 'Completing a local task does not establish acceptance of the original goal')}</span></div>
      <div data-research-frontier class="collab-frontier-list">{observation && this.frontier(observation)}</div>
      <div data-research-waiting>{waiting && <div class="collab-research-waiting"><strong>{t('研究正在等待新的数学输入')}</strong><p>{waiting.reason}</p>
        <Facts facts={[[t('等待任务'), waiting.taskIds.join(', ') || t('未记录')], [t('关联目标'), waiting.goalIds.join(', ') || t('未记录')]]} /></div>}</div>
      <div class="collab-section-heading collab-research-blocker-heading"><h3>{tx('未解决的问题', 'Unresolved issues')}</h3>
        <span class="collab-help">{snapshot?.blockers.length ? tx(`${openBlockers} 项待处理 · ${snapshot.blockers.length} 条记录`, `${openBlockers} to address · ${snapshot.blockers.length} records`) : t('作用范围与重开条件')}</span></div>
      <div data-research-blockers class="collab-blocker-list">{observation && this.blockers(observation)}</div>
      {(skill || observation?.declarations?.status === 'recorded') && <section data-independent-declarations>
        <div class="collab-section-heading"><h3>{tx('独立引理记录', 'Independent declaration records')}</h3></div>
        {help(tx('以下是已保存的检查证据；复用时须重新检查，完整原题仍单独验收。', 'These are retained check records. Reuse requires a fresh check, and the complete original problem is accepted separately.'))}
        {observation?.declarations?.status === 'recorded' ? <>
          {observation.declarations.declarations.length ? observation.declarations.declarations.map(item => <article class="collab-frontier-goal" key={item.id} data-independent-declaration={item.id}>
            <h4><code>{item.name}</code></h4><Code value={item.elaboratedType ?? item.type} label={tx('完整类型', 'Complete type')} />
            <Detail title={tx('前提', 'Premises')} value={item.premises} detailKey={`declaration-premises-${item.id}`} />
            <Detail title={tx('检查来源', 'Check provenance')} value={{ file: item.file, declaredType: item.type,
              sourceCommit: item.sourceCommit, checkedCommit: item.checkedCommit, environmentDigest: item.environmentDigest, receiptIds: item.receiptIds }} detailKey={`declaration-provenance-${item.id}`} />
          </article>) : help(tx('尚无独立引理记录。', 'No independent declarations recorded yet.'))}
          {observation.declarations.omitted > 0 && help(tx(`本页另有 ${observation.declarations.omitted} 条记录未展示。`, `${observation.declarations.omitted} additional records are not shown in this view.`))}
        </> : help(observation?.declarations?.status === 'unknown'
          ? tx('独立引理记录暂时无法读取，当前观察不据此确认任何结果。', 'Independent declaration records could not be read; this observation establishes no result from them.')
          : tx('尚无独立引理记录。', 'No independent declarations recorded yet.'))}
      </section>}
    </>);
  }

  private filtered() {
    const query = this.query.trim().toLocaleLowerCase();
    return (this.observation?.deliveries ?? []).filter(item => (!this.producer || item.producer === this.producer) && (!this.task || item.taskId === this.task) && (!query || [item.id, item.summary, item.statement, item.finding, item.taskId, item.taskDigest].join('\n').toLocaleLowerCase().includes(query)))
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }

  private filter() {
    const items = this.filtered();
    if (!items.some(item => item.id === this.selected)) this.selected = items[0]?.id ?? '';
    this.renderDeliveries(); this.element.querySelector('[data-delivery-list]')!.scrollTop = 0;
  }
  private readonly clear = () => { this.producer = ''; this.task = ''; this.query = ''; this.filter(); };
  private readonly choose = (id: string) => { this.selected = id; this.renderDeliveries(); };

  private relationship(delivery: WebDelivery) {
    if (!delivery.taskId || !delivery.taskDigest) return t('任务版本未记录');
    const task = this.observation && recordedTask(this.observation, delivery.taskId, delivery.taskDigest);
    return task ? task.historical ? t('历史任务版本') : t('当前任务版本') : t('任务合同未保留');
  }
  private row(item: WebDelivery) {
    const selected = item.id === this.selected;
    return <article key={item.id} class="collab-delivery-row" data-delivery-row={item.id}>
      <button type="button" class={`collab-delivery-choice${selected ? ' selected' : ''}`} data-delivery-id={item.id} data-focus-key={`delivery-${item.id}`} aria-pressed={selected} onClick={() => this.choose(item.id)}>
        <span class="collab-delivery-meta"><strong>{item.producer}</strong><span>{kindLabels[item.kind] ?? item.kind} · {label(item.status)}</span></span>
        <span class="collab-delivery-summary">{item.summary ? localizeText(item.summary) : item.statement || item.id}</span><small>{item.taskId ?? t('未绑定任务')} · {this.relationship(item)}</small>
      </button></article>;
  }

  private renderDeliveries() {
    const items = this.filtered(), observation = this.observation, id = this.runId;
    const delivery = observation?.deliveries?.find(item => item.id === this.selected);
    // Keep the first visible retained row in place when rows above it appear or disappear.
    const list = this.element.querySelector<HTMLElement>('[data-delivery-list]');
    const anchor = list && [...list.querySelectorAll<HTMLElement>(':scope > [data-delivery-row]')].find(row => row.getBoundingClientRect().bottom > list.getBoundingClientRect().top);
    const anchorTop = anchor?.getBoundingClientRect().top, top = list?.scrollTop ?? 0;
    const empty = observation?.deliveries === undefined ? t('此运行未提供交付记录') : observation.deliveries.length ? t('没有匹配的交付记录') : t('本次观察尚无 Agent 交付');
    renderSection(this.element, <>
      <div class="collab-section-heading"><h3 tabIndex={-1} data-delivery-heading>{t('研究交付')}</h3><span class="collab-help" data-delivery-count>{t('{0} / {1} 条记录', items.length, observation?.deliveries?.length ?? 0)}</span></div>
      <p class="collab-help collab-delivery-intro">{t('Agent 的交付内容、所用前提与未完成义务；检查状态以对应材料的回执为准。')}</p>
      <div class="collab-delivery-filters">
        <label htmlFor={`delivery-producer-${id}`}>Agent<select id={`delivery-producer-${id}`} data-delivery-producer value={this.producer} onChange={event => { this.producer = event.currentTarget.value; this.filter(); }}>
          <option value="">{t('全部 Agent')}</option>{this.producers.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label htmlFor={`delivery-task-${id}`}>{t('任务')}<select id={`delivery-task-${id}`} data-delivery-task value={this.task} onChange={event => { this.task = event.currentTarget.value; this.filter(); }}>
          <option value="">{t('全部任务')}</option>{this.tasks.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label htmlFor={`delivery-query-${id}`}>{t('检索')}<input type="search" id={`delivery-query-${id}`} data-delivery-query placeholder={t('搜索声明、发现或交付 ID')} value={this.query} onInput={event => { this.query = event.currentTarget.value; this.filter(); }} /></label>
        <button type="button" class="button" data-delivery-clear onClick={this.clear}>{t('清除筛选')}</button>
      </div>
      <div class="collab-delivery-layout">
        <div class="collab-delivery-list" data-delivery-list tabIndex={0} aria-label={t('本次观察中的研究交付')}>{items.map(item => this.row(item))}{!items.length && help(empty)}</div>
        <div class="collab-delivery-detail" data-delivery-detail>{delivery ? this.deliveryDetails(delivery) : help(this.selected ? t('原选择不在本次观察中，未切换到其他交付。') : t('选择一条交付查看声明与证据。'))}</div>
      </div>
    </>);
    if (list && top > 0 && anchor?.isConnected && anchorTop !== undefined) list.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
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
    const key = delivery.id;
    // Keyed by delivery: another selection remounts, so its details start closed unless their keys were open.
    return <Fragment key={key}>
      <h4 tabIndex={-1}>{kindLabels[delivery.kind] ?? delivery.kind} · {delivery.producer}</h4>
      {help(t('交付状态：{0} · {1}。局部交付与审阅不代表完整原题验收。', label(delivery.status), this.relationship(delivery)))}
      <h5>{t('摘要')}</h5><p class="collab-delivery-text">{delivery.summary ? localizeText(delivery.summary) : t('未记录摘要')}</p>
      <h5>{t('声明')}</h5><Code value={delivery.statement} />
      <Detail title={t('前提')} value={delivery.premises} detailKey={`delivery-premises-${key}`} />
      <h5>{tx('依赖任务', 'Dependencies')}</h5>
      <div class="collab-reference-list">{delivery.dependencies.length ? delivery.dependencies.map((item, index) => this.taskLink(item.taskId, item.taskDigest, `delivery-dependency-${key}-${index}`)) : <span class="collab-help">{t('未记录任务依赖')}</span>}</div>
      <Detail title={t('未完成义务')} value={delivery.remainingObligations} detailKey={`delivery-obligations-${key}`} />
      {delivery.finding ? <Detail title={t('完整研究发现')} value={delivery.finding} detailKey={`delivery-finding-${key}`} /> : null}
      <h5>{t('对应材料')}</h5>
      <div class="collab-artifact-links">
        {sources.map(source => { const identity = taskSourceKey(source); return <button key={identity} type="button" class="button" data-collab-source={source.taskId} data-source-version={source.taskVersion} data-source-snapshot={identity} data-focus-key={`delivery-source-${identity}`}>{t('已保存源码 · {0} · {1}', source.file, source.commit.slice(0, 8))}</button>; })}
        {checks.map(check => { const identity = taskCheckKey(check); return <button key={identity} type="button" class="button" data-collab-check={check.id} data-check-identity={identity} data-focus-key={`delivery-check-${identity}`}>{t('关联检查 · {0}', check.id)}</button>; })}
      </div>
      {!sources.length && help(t('本次观察中未关联到身份一致的已保存源码。'))}
      {!checks.length && help(t('本次观察中未关联到交付明确引用且身份一致的检查回执。'))}
      <details class="collab-detail" data-delivery-identity data-detail-key={`delivery-identity-${key}`}><summary>{tx('版本与来源', 'Versions and sources')}</summary>
      <Facts facts={[[t('交付 ID'), delivery.id], [t('任务'), delivery.taskId], [t('任务版本'), delivery.taskDigest], [t('创建时间'), observedTime(delivery.createdAt)], ['commit', delivery.commit], [mathematicalSource ? t('记录摘要') : t('声明快照摘要'), delivery.sourceDigest]]} />
      <div class="collab-reference-list">{delivery.taskId ? this.taskLink(delivery.taskId, delivery.taskDigest, `delivery-task-${key}`) : <span class="collab-help">{t('本交付未绑定任务合同')}</span>}</div>
      {delivery.dependencies.length ? <Detail title={t('依赖版本')} value={delivery.dependencies} detailKey={`delivery-dependencies-${key}`} /> : null}
      {sources.length || checks.length ? <Facts facts={[[t('材料环境'), [...new Set([...sources, ...checks].map(item => item.environmentDigest))].join(', ')]]} /> : null}
      <h5>{t('原始提示引用')}</h5>{help(t('由 Agent 提供的文字引用，未自动解释为检查回执或可访问路径。'))}<Code value={delivery.evidenceRefs} />
      {delivery.evidence ? <Detail title={t('交付附带的检查记录')} value={delivery.evidence} detailKey={`delivery-evidence-${key}`} /> : null}
      </details>
    </Fragment>;
  }
}

import { Fragment } from 'preact';
import type { WebObservation, WebStatementReview, WebTaskReference } from '../collaboration';
import type { WebRun } from '../shared';
import { isAcceptedRun, isRejectedRun, resultDescription } from '../presentation';
import { createElement, jsonText } from './collaborationUi';
import { recordedTask } from './researchProgressView';
import { Code, Facts, renderSection } from './ui/Section';
import { localizeText, t } from '../i18n';

const statuses: Record<string, string> = { pending: t('等待回译'), translating: t('独立回译中'), translated: t('回译完成，等待比较'),
  reviewing: t('声明比较中'), accepted: t('审阅接受'), changes_requested: t('请求修改'), superseded: t('已被替代') };
const candidateStatuses: Record<string, string> = { pending: t('等待候选审阅'), running: t('候选审阅中'), accepted: t('审阅接受'), changes_requested: t('请求修改') };
const status = (value: string) => statuses[value] ?? value;
export const statementReviewKey = (review: WebStatementReview) => JSON.stringify([review.id ?? null, review.taskId, review.version,
  review.snapshotDigest ?? null, review.environmentDigest ?? null, review.commit ?? null]);
const help = (text: string) => <p class="collab-help">{text}</p>;
/** A status transition must not move the reader within unchanged text: the block is keyed by its text, so only changed text remounts at the top. */
const reading = (value: unknown, key: string) => <Code key={`${key}\u0000${typeof value === 'string' ? value : jsonText(value)}`} value={value} data-review-text-key={key} data-focus-key={`review-text-${key}`} />;
const expandable = (title: string, value: unknown, key: string) => <details class="collab-detail" data-detail-key={key}><summary>{title}</summary>{reading(value, key)}</details>;

/** Reads fixed statement/candidate reviews; none of these controls accepts a proof. */
export class ReviewView {
  readonly element = createElement('section', 'collab-reviews');
  private observation?: WebObservation;
  private run?: WebRun;
  private selected = '';
  private task = '';
  private state = '';
  private query = '';
  private tasks: string[] = [];
  private message = '';
  private readingIdentity = { detail: '', candidate: '' };

  constructor(private runId: string, private appendReference: (text: string) => boolean) {
    this.render();
  }

  update(observation: WebObservation, run: WebRun) {
    if (this.observation && observation.sequence < this.observation.sequence) return;
    this.observation = observation; this.run = run;
    this.tasks = [...new Set([...observation.inspection.statementReviews.map(review => review.taskId), ...(this.task ? [this.task] : [])])].sort();
    if (!this.selected) this.selected = this.filtered()[0] ? statementReviewKey(this.filtered()[0]) : '';
    this.render();
  }

  showForTask(id: string) {
    if (!this.tasks.includes(id)) this.tasks = [...this.tasks, id];
    this.task = id; this.state = ''; this.query = ''; this.filter();
    this.element.querySelector<HTMLElement>('[data-review-heading]')!.focus({ preventScroll: true });
    this.element.scrollIntoView({ block: 'nearest' });
  }

  private records() { return this.observation?.inspection.statementReviews ?? []; }
  private filtered() {
    const query = this.query.trim().toLocaleLowerCase();
    return this.records().filter(review => (!this.task || review.taskId === this.task) && (!this.state || review.status === this.state) &&
      (!query || JSON.stringify(review).toLocaleLowerCase().includes(query)));
  }
  private selectedReview() {
    const matches = this.records().filter(review => statementReviewKey(review) === this.selected);
    return matches.length === 1 ? matches[0] : undefined;
  }
  private filter() {
    const items = this.filtered();
    if (!items.some(review => statementReviewKey(review) === this.selected)) this.selected = items[0] ? statementReviewKey(items[0]) : '';
    this.render(); this.element.querySelector('[data-review-list]')!.scrollTop = 0;
  }
  private readonly clear = () => { this.task = ''; this.state = ''; this.query = ''; this.filter(); };
  private readonly choose = (key: string) => { this.selected = key; this.render(); };
  private selectionStatus(review: WebStatementReview) {
    return t('所选声明审阅状态：{0}。{1} 完整原题以 S3 独立验收为准。', status(review.status), review.status === 'superseded' ? t('此审阅已被替代，保留供追溯。') : review.status === 'accepted' ? t('已接受的是此声明快照；新任务版本只有在原意和形式声明快照不变时才能沿用审阅。') : review.status === 'changes_requested' ? t('此记录请求修改；具体原因见保存的摘要。') : ['pending', 'translating', 'translated', 'reviewing'].includes(review.status) ? t('当前状态尚未接受审阅。{0}', review.summary ? t('恢复后可能保留先前摘要。') : '') : t('回译保存后仍需完成声明比较。'));
  }
  private choices(items: WebStatementReview[]) {
    if (!items.length) return help(this.records().length ? t('没有匹配的声明审阅') : t('本次观察尚无声明审阅记录；无法据此判断是否需要审阅。'));
    const seen = new Map<string, number>();
    return items.map(review => {
      const key = statementReviewKey(review), occurrence = seen.get(key) ?? 0, selected = key === this.selected;
      seen.set(key, occurrence + 1);
      const historical = this.observation && recordedTask(this.observation, review.taskId, review.version)?.historical;
      return <button key={`${key}#${occurrence}`} type="button" class={`collab-review-choice${selected ? ' selected' : ''}`} data-review-key={key} data-review-id={review.id || undefined} data-focus-key={`review-${key}`} aria-pressed={selected} onClick={() => this.choose(key)}>
        <span>{status(review.status)}{historical ? t(' · 历史合同') : ''}</span><strong>{review.taskId}</strong><code>{review.version}</code><small>{review.summary ? localizeText(review.summary) : t('尚无审阅结论')}</small></button>;
    });
  }
  private taskLink(ref: WebTaskReference, key: string) {
    const record = this.observation && ref.taskDigest && recordedTask(this.observation, ref.taskId, ref.taskDigest);
    return <div key={key} class="collab-review-task-ref">
      {record ? <button type="button" class="text-button collab-reference" data-collab-task={ref.taskId} data-task-version={ref.taskDigest!} data-focus-key={`review-task-${key}`}>{ref.taskId} · {record.historical ? t('历史合同') : t('任务合同')} →</button>
        : <span>{ref.taskId} · {ref.taskDigest ? t('合同未保留') : t('版本未记录')}</span>}
      <code>{ref.taskDigest || t('未记录')}</code></div>;
  }
  private translation(review: WebStatementReview, key: string) {
    const value = review.translation;
    if (value === undefined || value === null) return help(t('尚无已保存的独立回译。'));
    if (typeof value !== 'object' || Array.isArray(value) || !('mathematics' in value)) return <>{reading(value, `${key}-translation`)}{help(t('旧记录未提供结构化回译，按原文展示。'))}</>;
    const translation = value as Record<string, unknown>;
    return <>{reading(translation.mathematics, `${key}-translation`)}{expandable(t('回译中的假设'), translation.assumptions ?? t('未记录'), `${key}-assumptions`)}
      {expandable(t('回译中的定义'), translation.definitions ?? t('未记录'), `${key}-definitions`)}{expandable(t('回译原始引用'), translation.evidenceRefs ?? t('未记录'), `${key}-translation-refs`)}
      {help(t('引用按回译原文保存，未据此关联检查回执。'))}</>;
  }
  private details(review: WebStatementReview) {
    const key = statementReviewKey(review);
    const complete = review.id && review.snapshotDigest && review.environmentDigest && review.commit;
    // Keyed by review identity: another review remounts, so its details start closed unless their keys were open.
    return <Fragment key={key}>
      <h4>{review.taskId}</h4>{this.taskLink({ taskId: review.taskId, taskDigest: review.version }, key)}
      {!complete && <p class="collab-notice">{t('旧记录未保存完整审阅身份，缺失字段保持未知。')}</p>}
      <div class="collab-review-comparison"><div><h5>{t('原始数学意图')}</h5>{reading(review.intendedStatement, `${key}-intent`)}</div><div><h5>{t('Lean 形式声明')}</h5>{reading(review.leanStatement, `${key}-lean`)}</div></div>
      {expandable(t('审阅前提'), review.premises ?? t('未记录'), `${key}-premises`)}
      <h5>{t('独立回译')}</h5>{this.translation(review, key)}<h5>{t('保存的审阅摘要')}</h5>{reading(review.summary ? localizeText(review.summary) : t('尚无摘要'), `${key}-summary`)}
      <details class="collab-detail" data-detail-key={`${key}-identity`}><summary>{t('审阅身份')}</summary>
        <Facts facts={[[t('审阅 ID'), review.id], [t('声明快照摘要'), review.snapshotDigest], [t('快照 commit'), review.commit], [t('审阅环境摘要'), review.environmentDigest], [t('执行 Agent'), review.workerId], [t('分配 ID'), review.assignmentId]]} />
        {help(t('声明快照供语义一致性审阅；其摘要不用于关联普通证明源码或 Lean 检查。快照 commit 表示采集来源，不要求与复用后的集成提交相同。'))}
        <h5>{t('固定版本依赖')}</h5>{review.dependencies === undefined ? help(t('未记录')) : review.dependencies.length ? review.dependencies.map((ref, index) => this.taskLink(ref, `${key}-dependency-${index}`)) : help(t('记录中无依赖'))}
      </details>
    </Fragment>;
  }
  private candidate() {
    const review = this.observation?.inspection.review;
    const key = JSON.stringify([review?.commit, review?.sourceDigest]);
    return { key, status: review ? t('{0}。{1} 固定到记录中的候选 commit 与源码摘要；不表示当前源码已验收。', candidateStatuses[review.status] ?? review.status, ['pending', 'running'].includes(review.status) && review.summary ? t('当前状态尚未接受审阅；恢复后可能保留先前摘要。') : '') : '',
      view: <Fragment key={key}><h4>{t('最近记录的候选审阅')}</h4>{review ? <>
        <h5>{t('保存的审阅摘要')}</h5>{reading(review.summary ? localizeText(review.summary) : t('尚无候选审阅摘要'), `${key}-candidate-summary`)}
        <details class="collab-detail" data-detail-key={`${key}-candidate-identity`}><summary>{t('候选身份与分配')}</summary>
          <Facts facts={[[t('候选 commit'), review.commit], [t('候选源码摘要'), review.sourceDigest], [t('执行 Agent'), review.workerId], [t('分配 ID'), review.assignmentId]]} /></details>
        <button type="button" class="button" data-review-candidate-reference data-focus-key="review-candidate-reference" onClick={() => this.referenceCandidate()}>{t('候选审阅加入指导草稿')}</button>
      </> : help(t('本次观察尚无候选审阅记录。'))}</Fragment> };
  }
  /** Another review identity starts its reading area at the top; the same identity keeps the reader's position. */
  private resetReading(selector: string, side: 'detail' | 'candidate', identity: string) {
    if (this.readingIdentity[side] === identity) return;
    this.readingIdentity[side] = identity;
    const node = this.element.querySelector<HTMLElement>(selector);
    if (node) node.scrollTop = node.scrollLeft = 0;
  }
  private render() {
    const items = this.filtered(), review = this.selectedReview(), candidate = this.candidate(), id = this.runId;
    const accepted = this.run && isAcceptedRun(this.run), rejected = this.run && isRejectedRun(this.run);
    // A run that ended on a limit or an error never reached acceptance; 尚未 would promise a verdict still to come.
    const ended = this.run && !['queued', 'running'].includes(this.run.status);
    this.resetReading('[data-review-detail]', 'detail', this.selected);
    this.resetReading('[data-review-candidate]', 'candidate', candidate.key);
    renderSection(this.element, <>
      <div class="collab-section-heading"><h3 tabIndex={-1} data-review-heading>{t('审阅与验收')}</h3><span class="collab-help" data-review-count>{t('{0} / {1} 条声明审阅', items.length, this.records().length)}</span></div>
      <div class="collab-review-verdicts">
        <article><p class="collab-help" data-review-candidate-status role="status">{candidate.status}</p><div data-review-candidate>{candidate.view}</div></article>
        <article data-review-acceptance><h4>{t('完整原题 · 独立验收 S3')}</h4><strong class={`collab-review-verdict${accepted ? ' collab-accepted' : rejected ? ' collab-rejected' : ''}`}>{accepted ? t('验收通过') : rejected ? t('验收未通过') : ended ? t('没有验收结果') : t('尚未验收通过')}</strong>
          <p>{this.run ? resultDescription(this.run) : t('等待运行结果。')}</p>{help(t('声明审阅与候选 Reviewer 接受均不替代完整原题的独立 Lean 验收。此处沿用运行的最终验收结果。'))}</article>
      </div>
      <div class="collab-review-statements"><h4>{t('声明与原意对照')}</h4>{help(t('独立回译后比较原意与形式声明。审阅可在声明快照不变时复用到新任务版本；接受结论本身不表示重新审阅。'))}</div>
      <div class="collab-review-filters">
        <label htmlFor={`review-task-${id}`}>{t('任务')}<select id={`review-task-${id}`} data-review-task value={this.task} onChange={event => { this.task = event.currentTarget.value; this.filter(); }}>
          <option value="">{t('全部任务')}</option>{this.tasks.map(task => <option key={task} value={task}>{task}</option>)}</select></label>
        <label htmlFor={`review-status-${id}`}>{t('审阅状态')}<select id={`review-status-${id}`} data-review-status value={this.state} onChange={event => { this.state = event.currentTarget.value; this.filter(); }}>
          <option value="">{t('全部状态')}</option>{Object.entries(statuses).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>
        <label htmlFor={`review-query-${id}`}>{t('检索')}<input id={`review-query-${id}`} data-review-query type="search" placeholder={t('搜索声明、回译或审阅身份')} value={this.query} onInput={event => { this.query = event.currentTarget.value; this.filter(); }} /></label>
        <button type="button" class="button" data-review-clear onClick={this.clear}>{t('清除筛选')}</button>
      </div>
      <div class="collab-review-layout">
        <div class="collab-review-list" data-review-list tabIndex={0} aria-label={t('本次观察的声明审阅')}>{this.choices(items)}</div>
        <div class="collab-review-detail" data-review-detail>{review ? this.details(review) : help(this.selected ? t('所选审阅身份已不在本次观察中，或旧记录身份不足以区分；未切换到其他记录。') : t('选择一份声明审阅，查看原意、形式声明与回译。'))}</div>
      </div>
      <p class="collab-help" data-review-selected-status role="status">{review ? this.selectionStatus(review) : ''}</p>
      <div class="collab-review-actions"><button type="button" class="button" data-review-reference disabled={!review} onClick={() => this.referenceStatement()}>{t('加入指导草稿')}</button><p class="collab-help" data-review-status-message role="status">{this.message}</p></div>
    </>);
  }
  private provenance() {
    const observation = this.observation!;
    return { webRunId: observation.webRunId, solverRunId: observation.solverRunId, observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest },
      observedAt: observation.observedAt, evidence: observation.evidence, acceptance: observation.acceptance };
  }
  private referenceStatement() {
    const review = this.selectedReview(); if (!review || !this.observation) return;
    const { id, taskId, version, snapshotDigest, environmentDigest, commit, status } = review;
    const added = this.appendReference(t('声明审阅引用（记录材料，完整原题以 S3 独立验收为准）\n{0}', JSON.stringify({ ...this.provenance(),
      review: { id, taskId, version, snapshotDigest, environmentDigest, commit, status, summaryExcerpt: review.summary?.slice(0, 180) } }, null, 2)));
    this.referenceNotice(added, t('声明审阅'));
  }
  private referenceCandidate() {
    const review = this.observation?.inspection.review; if (!review) return;
    const { commit, sourceDigest, status, assignmentId } = review;
    const added = this.appendReference(t('固定候选审阅引用（结论只属于所列 commit 与源码摘要，完整原题以 S3 独立验收为准）\n{0}', JSON.stringify({ ...this.provenance(),
      review: { commit, sourceDigest, status, assignmentId, summaryExcerpt: review.summary?.slice(0, 180) } }, null, 2)));
    this.referenceNotice(added, t('候选审阅'));
  }
  private referenceNotice(added: boolean, kind: string) {
    this.message = added ? t('{0}已加入本地指导草稿，尚未发送。', kind) : t('指导草稿长度不足以容纳完整引用，未加入；请缩短草稿后重试。');
    this.render();
  }
}

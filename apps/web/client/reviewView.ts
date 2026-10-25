import type { WebObservation, WebStatementReview, WebTaskReference } from '../collaboration';
import type { WebRun } from '../shared';
import { isAcceptedRun, resultDescription } from '../presentation';
import { codeBlock, createElement, detailBlock, escapeHtml as h, factList, patchSection } from './collaborationUi';
import { recordedTask } from './researchProgressView';

const statuses: Record<string, string> = { pending: '等待回译', translating: '独立回译中', translated: '回译完成，等待比较',
  reviewing: '声明比较中', accepted: '审阅接受', changes_requested: '请求修改', superseded: '已被替代' };
const candidateStatuses: Record<string, string> = { pending: '等待候选审阅', running: '候选审阅中', accepted: '审阅接受', changes_requested: '请求修改' };
const status = (value: string) => statuses[value] ?? value;
export const statementReviewKey = (review: WebStatementReview) => JSON.stringify([review.id ?? null, review.taskId, review.version,
  review.snapshotDigest ?? null, review.environmentDigest ?? null, review.commit ?? null]);
const readable = (markup: string, key: string) => markup.replace('<pre ', `<pre data-review-text-key="${h(key)}" data-focus-key="review-text-${h(key)}" `);
const textBlock = (value: unknown, key: string) => readable(codeBlock(value), key);
const expandable = (title: string, value: unknown, key: string) => readable(detailBlock(title, value, key), key);

/** A status transition must not move the reader within unchanged text of the same review. */
function patchReading(node: HTMLElement, markup: string, identity: string) {
  const same = node.dataset.reviewIdentity === identity;
  const positions = new Map(same ? [...node.querySelectorAll<HTMLElement>('[data-review-text-key]')].map(block =>
    [block.dataset.reviewTextKey, { text: block.textContent, top: block.scrollTop, left: block.scrollLeft }] as const) : []);
  if (!same) node.scrollTop = node.scrollLeft = 0;
  patchSection(node, markup); node.dataset.reviewIdentity = identity;
  for (const block of node.querySelectorAll<HTMLElement>('[data-review-text-key]')) {
    const position = positions.get(block.dataset.reviewTextKey);
    if (position && position.text === block.textContent) { block.scrollTop = position.top; block.scrollLeft = position.left; }
  }
}

/** Reads fixed statement/candidate reviews; none of these controls accepts a proof. */
export class ReviewView {
  readonly element = createElement('section', 'collab-reviews');
  private observation?: WebObservation;
  private run?: WebRun;
  private selected = '';
  private task: HTMLSelectElement;
  private state: HTMLSelectElement;
  private query: HTMLInputElement;

  constructor(runId: string, private appendReference: (text: string) => boolean) {
    this.element.innerHTML = `<div class="collab-section-heading"><h3 tabindex="-1" data-review-heading>审阅与验收</h3><span class="collab-help" data-review-count></span></div>
      <div class="collab-review-verdicts"><article><p class="collab-help" data-review-candidate-status role="status"></p><div data-review-candidate></div></article><article data-review-acceptance></article></div>
      <div class="collab-review-statements"><h4>声明与原意对照</h4><p class="collab-help">独立回译后比较原意与形式声明。审阅可在声明快照不变时复用到新任务版本；接受结论本身不表示重新审阅。</p></div>
      <div class="collab-review-filters"><label for="review-task-${h(runId)}">任务<select id="review-task-${h(runId)}" data-review-task><option value="">全部任务</option></select></label>
      <label for="review-status-${h(runId)}">审阅状态<select id="review-status-${h(runId)}" data-review-status><option value="">全部状态</option>${Object.entries(statuses).map(([id, title]) => `<option value="${id}">${title}</option>`).join('')}</select></label>
      <label for="review-query-${h(runId)}">检索<input id="review-query-${h(runId)}" data-review-query type="search" placeholder="搜索声明、回译或审阅身份"></label><button type="button" class="button" data-review-clear>清除筛选</button></div>
      <div class="collab-review-layout"><div class="collab-review-list" data-review-list tabindex="0" aria-label="本次观察的声明审阅"></div><div class="collab-review-detail" data-review-detail></div></div>
      <p class="collab-help" data-review-selected-status role="status"></p>
      <div class="collab-review-actions"><button type="button" class="button" data-review-reference disabled>加入指导草稿</button><p class="collab-help" data-review-status-message role="status"></p></div>`;
    this.task = this.element.querySelector('[data-review-task]')!;
    this.state = this.element.querySelector('[data-review-status]')!;
    this.query = this.element.querySelector('[data-review-query]')!;
    this.task.addEventListener('change', () => this.filter());
    this.state.addEventListener('change', () => this.filter());
    this.query.addEventListener('input', () => this.filter());
    this.element.querySelector('[data-review-clear]')!.addEventListener('click', () => { this.task.value = ''; this.state.value = ''; this.query.value = ''; this.filter(); });
    this.element.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button'); if (!button) return;
      if (button.dataset.reviewKey) { this.selected = button.dataset.reviewKey; this.renderStatements(); }
      else if (button.hasAttribute('data-review-reference')) this.referenceStatement();
      else if (button.hasAttribute('data-review-candidate-reference')) this.referenceCandidate();
    });
    this.renderStatements(); this.renderVerdicts();
  }

  update(observation: WebObservation, run: WebRun) {
    if (this.observation && observation.sequence < this.observation.sequence) return;
    this.observation = observation; this.run = run;
    const selectedTask = this.task.value;
    const tasks = [...new Set([...observation.inspection.statementReviews.map(review => review.taskId), ...(selectedTask ? [selectedTask] : [])])].sort();
    const markup = '<option value="">全部任务</option>' + tasks.map(id => `<option value="${h(id)}">${h(id)}</option>`).join('');
    if (this.task.dataset.options !== markup) { this.task.innerHTML = markup; this.task.dataset.options = markup; this.task.value = selectedTask; }
    if (!this.selected) this.selected = this.filtered()[0] ? statementReviewKey(this.filtered()[0]) : '';
    this.renderStatements(); this.renderVerdicts();
  }

  showForTask(id: string) {
    if (![...this.task.options].some(option => option.value === id)) this.task.add(new Option(id, id));
    this.task.value = id; this.state.value = ''; this.query.value = ''; this.filter();
    this.element.querySelector<HTMLElement>('[data-review-heading]')!.focus({ preventScroll: true });
    this.element.scrollIntoView({ block: 'nearest' });
  }

  private records() { return this.observation?.inspection.statementReviews ?? []; }
  private filtered() {
    const query = this.query.value.trim().toLocaleLowerCase();
    return this.records().filter(review => (!this.task.value || review.taskId === this.task.value) && (!this.state.value || review.status === this.state.value) &&
      (!query || JSON.stringify(review).toLocaleLowerCase().includes(query)));
  }
  private selectedReview() {
    const matches = this.records().filter(review => statementReviewKey(review) === this.selected);
    return matches.length === 1 ? matches[0] : undefined;
  }
  private filter() {
    const items = this.filtered();
    if (!items.some(review => statementReviewKey(review) === this.selected)) this.selected = items[0] ? statementReviewKey(items[0]) : '';
    this.renderStatements(); this.element.querySelector('[data-review-list]')!.scrollTop = 0;
  }

  private renderStatements() {
    const items = this.filtered();
    this.element.querySelector('[data-review-count]')!.textContent = `${items.length} / ${this.records().length} 条声明审阅`;
    const list = this.element.querySelector<HTMLElement>('[data-review-list]')!;
    patchSection(list, items.map(review => {
      const key = statementReviewKey(review), historical = this.observation && recordedTask(this.observation, review.taskId, review.version)?.historical;
      return `<button type="button" class="collab-review-choice${key === this.selected ? ' selected' : ''}" data-review-key="${h(key)}"${review.id ? ` data-review-id="${h(review.id)}"` : ''} data-focus-key="review-${h(key)}" aria-pressed="${key === this.selected}"><span>${h(status(review.status))}${historical ? ' · 历史合同' : ''}</span><strong>${h(review.taskId)}</strong><code>${h(review.version)}</code><small>${h(review.summary ?? '尚无审阅结论')}</small></button>`;
    }).join('') || `<p class="collab-help">${this.records().length ? '没有匹配的声明审阅' : '本次观察尚无声明审阅记录；无法据此判断是否需要审阅。'}</p>`);
    const review = this.selectedReview();
    this.element.querySelector<HTMLElement>('[data-review-selected-status]')!.textContent = review
      ? `所选声明审阅状态：${status(review.status)}。${review.status === 'superseded' ? '此审阅已被替代，保留供追溯。' : review.status === 'accepted' ? '已接受的是此声明快照；新任务版本只有在原意和形式声明快照不变时才能沿用审阅。' : review.status === 'changes_requested' ? '此记录请求修改；具体原因见保存的摘要。' : ['pending', 'translating', 'translated', 'reviewing'].includes(review.status) ? `当前状态尚未接受审阅。${review.summary ? '恢复后可能保留先前摘要。' : ''}` : '回译保存后仍需完成声明比较。'} 完整原题以 S3 独立验收为准。`
      : '';
    patchReading(this.element.querySelector('[data-review-detail]')!, review ? this.details(review) : `<p class="collab-help">${this.selected ? '所选审阅身份已不在本次观察中，或旧记录身份不足以区分；未切换到其他记录。' : '选择一份声明审阅，查看原意、形式声明与回译。'}</p>`, this.selected);
    this.element.querySelector<HTMLButtonElement>('[data-review-reference]')!.disabled = !review;
  }

  private taskLink(ref: WebTaskReference, key: string) {
    const record = this.observation && ref.taskDigest && recordedTask(this.observation, ref.taskId, ref.taskDigest);
    return `<div class="collab-review-task-ref">${record ? `<button type="button" class="text-button collab-reference" data-collab-task="${h(ref.taskId)}" data-task-version="${h(ref.taskDigest)}" data-focus-key="review-task-${h(key)}">${h(ref.taskId)} · ${record.historical ? '历史合同' : '任务合同'} →</button>` : `<span>${h(ref.taskId)} · ${ref.taskDigest ? '合同未保留' : '版本未记录'}</span>`}<code>${h(ref.taskDigest || '未记录')}</code></div>`;
  }
  private translation(review: WebStatementReview, key: string) {
    const value = review.translation;
    if (value === undefined || value === null) return '<p class="collab-help">尚无已保存的独立回译。</p>';
    if (typeof value !== 'object' || Array.isArray(value) || !('mathematics' in value)) return `${textBlock(value, `${key}-translation`)}<p class="collab-help">旧记录未提供结构化回译，按原文展示。</p>`;
    const translation = value as Record<string, unknown>;
    return `${textBlock(translation.mathematics, `${key}-translation`)}${expandable('回译中的假设', translation.assumptions ?? '未记录', `${key}-assumptions`)}${expandable('回译中的定义', translation.definitions ?? '未记录', `${key}-definitions`)}${expandable('回译原始引用', translation.evidenceRefs ?? '未记录', `${key}-translation-refs`)}<p class="collab-help">引用按回译原文保存，未据此关联检查回执。</p>`;
  }
  private details(review: WebStatementReview) {
    const key = statementReviewKey(review);
    const complete = review.id && review.snapshotDigest && review.environmentDigest && review.commit;
    return `<h4>${h(review.taskId)}</h4>${this.taskLink({ taskId: review.taskId, taskDigest: review.version }, key)}
      ${complete ? '' : '<p class="collab-notice">旧记录未保存完整审阅身份，缺失字段保持未知。</p>'}
      <div class="collab-review-comparison"><div><h5>原始数学意图</h5>${textBlock(review.intendedStatement, `${key}-intent`)}</div><div><h5>Lean 形式声明</h5>${textBlock(review.leanStatement, `${key}-lean`)}</div></div>
      ${expandable('审阅前提', review.premises ?? '未记录', `${key}-premises`)}
      <h5>独立回译</h5>${this.translation(review, key)}<h5>保存的审阅摘要</h5>${textBlock(review.summary ?? '尚无摘要', `${key}-summary`)}
      <details class="collab-detail" data-detail-key="${h(key)}-identity"><summary>审阅身份</summary>${factList([['审阅 ID', review.id], ['声明快照摘要', review.snapshotDigest], ['快照 commit', review.commit], ['审阅环境摘要', review.environmentDigest], ['执行 Agent', review.workerId], ['分配 ID', review.assignmentId]])}
      <p class="collab-help">声明快照供语义一致性审阅；其摘要不用于关联普通证明源码或 Lean 检查。快照 commit 表示采集来源，不要求与复用后的集成提交相同。</p>
      <h5>固定版本依赖</h5>${review.dependencies === undefined ? '<p class="collab-help">未记录</p>' : review.dependencies.length ? review.dependencies.map((ref, index) => this.taskLink(ref, `${key}-dependency-${index}`)).join('') : '<p class="collab-help">记录中无依赖</p>'}</details>`;
  }

  private renderVerdicts() {
    const review = this.observation?.inspection.review;
    const key = JSON.stringify([review?.commit, review?.sourceDigest]);
    this.element.querySelector<HTMLElement>('[data-review-candidate-status]')!.textContent = review
      ? `${candidateStatuses[review.status] ?? review.status}。${['pending', 'running'].includes(review.status) && review.summary ? '当前状态尚未接受审阅；恢复后可能保留先前摘要。' : ''} 固定到记录中的候选 commit 与源码摘要；不表示当前源码已验收。`
      : '';
    patchReading(this.element.querySelector('[data-review-candidate]')!, `<h4>最近记录的候选审阅</h4>${review ? `<h5>保存的审阅摘要</h5>${textBlock(review.summary ?? '尚无候选审阅摘要', `${key}-candidate-summary`)}<details class="collab-detail" data-detail-key="${h(key)}-candidate-identity"><summary>候选身份与分配</summary>${factList([['候选 commit', review.commit], ['候选源码摘要', review.sourceDigest], ['执行 Agent', review.workerId], ['分配 ID', review.assignmentId]])}</details><button type="button" class="button" data-review-candidate-reference data-focus-key="review-candidate-reference">候选审阅加入指导草稿</button>` : '<p class="collab-help">本次观察尚无候选审阅记录。</p>'}`, key);
    const accepted = this.run && isAcceptedRun(this.run);
    patchSection(this.element.querySelector('[data-review-acceptance]')!, `<h4>完整原题 · 独立验收 S3</h4><strong class="collab-review-verdict${accepted ? ' collab-accepted' : ''}">${accepted ? '验收通过' : '尚未验收通过'}</strong><p>${h(this.run ? resultDescription(this.run) : '等待运行结果。')}</p><p class="collab-help">声明审阅与候选 Reviewer 接受均不替代完整原题的独立 Lean 验收。此处沿用运行的最终验收结果。</p>`);
  }
  private provenance() {
    const observation = this.observation!;
    return { webRunId: observation.webRunId, solverRunId: observation.solverRunId, observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest },
      observedAt: observation.observedAt, evidence: observation.evidence, acceptance: observation.acceptance };
  }
  private referenceStatement() {
    const review = this.selectedReview(); if (!review || !this.observation) return;
    const { id, taskId, version, snapshotDigest, environmentDigest, commit, status } = review;
    const added = this.appendReference(`声明审阅引用（记录材料，完整原题以 S3 独立验收为准）\n${JSON.stringify({ ...this.provenance(),
      review: { id, taskId, version, snapshotDigest, environmentDigest, commit, status, summaryExcerpt: review.summary?.slice(0, 180) } }, null, 2)}`);
    this.referenceNotice(added, '声明审阅');
  }
  private referenceCandidate() {
    const review = this.observation?.inspection.review; if (!review) return;
    const { commit, sourceDigest, status, assignmentId } = review;
    const added = this.appendReference(`固定候选审阅引用（结论只属于所列 commit 与源码摘要，完整原题以 S3 独立验收为准）\n${JSON.stringify({ ...this.provenance(),
      review: { commit, sourceDigest, status, assignmentId, summaryExcerpt: review.summary?.slice(0, 180) } }, null, 2)}`);
    this.referenceNotice(added, '候选审阅');
  }
  private referenceNotice(added: boolean, kind: string) {
    this.element.querySelector('[data-review-status-message]')!.textContent = added ? `${kind}已加入本地指导草稿，尚未发送。` : '指导草稿长度不足以容纳完整引用，未加入；请缩短草稿后重试。';
  }
}

import type { WebSession, WebFormalizationReport } from '../shared';
import type { WebFormalization, WebFormalizationCapabilities, WebFormalizationRequest } from '../formalizationTypes';
import { locale, localeTag, localizeDocument, localizeMessage, mountLocaleSwitch, sentences, t } from '../i18n';
import { researchExamples } from '../problemExamples';
import { renderFormalization } from './formalizationView';
import { formalizationReasonText } from './formalizationReasons';
import { correspondenceSpans, fragmentLadder } from './correspondence';
import { buildLeanRows, highlightSpans } from './leanPane';

const embedded = document.body.dataset.formalizeEmbedded === 'true';
const shell = document.querySelector<HTMLElement>(embedded ? '#natural-research' : '.formalize-shell')!;
const $ = <T extends HTMLElement>(selector: string) => shell.querySelector<T>(selector)!;
if (embedded) {
  shell.classList.add('formalize-embedded');
  $('#formalize-start').textContent = t('发送');
  $('#history-heading').textContent = t('解题记录');
  $('#current-heading').textContent = t('当前解题');
  $<HTMLDetailsElement>('#formalize-settings').open = false;
  $<HTMLDetailsElement>('#formalize-history-details').open = false;
  $<HTMLTextAreaElement>('#formalize-original').placeholder = t('输入你想解决的数学问题…');
  $<HTMLTextAreaElement>('#formalize-original').rows = 3;
  $('#formalize-use').textContent = t('继续证明研究');
  localizeDocument(shell);
} else mountLocaleSwitch(document.querySelector<HTMLButtonElement>('#locale-switch')!);
const original = $<HTMLTextAreaElement>('#formalize-original'), key = $<HTMLInputElement>('#formalize-key');
const environment = $<HTMLSelectElement>('#formalize-environment'), effort = $<HTMLSelectElement>('#formalize-effort');
if (embedded) { environment.value = 'mathlib'; effort.value = 'max'; }
const exampleSelect = $<HTMLSelectElement>('#formalize-example');
for (const example of researchExamples) exampleSelect.add(new Option(locale === 'en' ? example.nameEn : example.name, example.id));
let selectedExample = '';
let draftStorageKey = '', draftEdited = false;
function saveDraft() {
  draftEdited = true;
  if (!draftStorageKey) return;
  try {
    sessionStorage.setItem(draftStorageKey, JSON.stringify({ original: original.value, environment: environment.value,
      effort: effort.value, selected: state.selected, example: selectedExample }));
  } catch { /* The editable draft remains usable when browser storage is unavailable. */ }
}
function restoreDraft(session: WebSession) {
  if (!embedded) return;
  draftStorageKey = `theorem-os.natural-research-draft.v1:${session.account?.email ?? 'anonymous'}`;
  if (draftEdited) { saveDraft(); return; }
  try {
    const saved = JSON.parse(sessionStorage.getItem(draftStorageKey) ?? 'null') as Record<string, unknown> | null;
    if (!saved || typeof saved.original !== 'string') return;
    draftEdited = true;
    original.value = saved.original;
    environment.value = 'mathlib'; effort.value = 'max';
    state.selected = typeof saved.selected === 'string' ? saved.selected : '';
    const example = researchExamples.find(item => item.id === saved.example);
    if (example) {
      exampleSelect.value = selectedExample = example.id;
      $('#formalize-example-note').textContent = locale === 'en' ? example.summaryEn : example.summary;
    }
  } catch { /* A missing or invalid session draft starts with an empty problem. */ }
}
function rememberSelection() {
  if (embedded) { saveDraft(); return; }
  history.replaceState(null, '', state.selected ? `formalize.html?id=${encodeURIComponent(state.selected)}` : 'formalize.html');
}
function loadExample(id: string) {
  const example = researchExamples.find(item => item.id === id);
  if (!example) { selectedExample = ''; return; }
  original.value = locale === 'en' ? example.originalEn : example.original;
  environment.value = example.environment;
  exampleSelect.value = selectedExample = id;
  $('#formalize-example-note').textContent = locale === 'en' ? example.summaryEn : example.summary;
}
// Loading an example only fills the editable original; generation still needs an explicit submit.
if (!embedded) loadExample(new URLSearchParams(location.search).get('example') ?? '');
const state = { csrf: '', capabilities: undefined as WebFormalizationCapabilities | undefined, items: [] as WebFormalization[],
  selected: embedded ? '' : new URLSearchParams(location.search).get('id') ?? '', item: undefined as WebFormalization | undefined, busy: false,
  pane: 'prose' as 'prose' | 'lean', active: new Set<number>() };
let timer: ReturnType<typeof setTimeout> | undefined, rows: HTMLElement[] = [], report: WebFormalizationReport | undefined;
// Only the request started in this page can navigate automatically. Reloading a record only exposes its result link.
let autoOpen = '';
let conversationGeneration = 0;
const ladder = fragmentLadder();
const solving = (item: WebFormalization) => item.workflow === 'solve';
const active = (item: WebFormalization) => item.status === 'queued' || item.status === 'running'
  || solving(item) && item.status === 'confirmed' && !item.runId && !item.researchError;
const statusNames: Record<WebFormalization['status'], string> = { queued: t('等待执行'), running: t('生成中'), review: t('待你确认'), confirmed: t('已确认陈述'), exhausted: t('未在预算内完成'), cancelled: t('已取消'), error: t('生成失败') };
const phaseNames: Record<string, string> = { queued: t('等待执行'), preparing: t('准备环境'), planning: t('规划陈述'), generating: t('编写 Lean'), compiling: t('检查 Lean 编译'), translating: t('独立回译'), reviewing: t('审核原题一致性'), finishing: t('整理形式化结果') };
function statusName(item: WebFormalization) {
  if (!solving(item)) return statusNames[item.status];
  if (item.researchError) return t('证明研究未启动');
  if (item.runId) return t('已进入证明研究');
  if (item.status === 'confirmed') return t('正在启动证明研究');
  if (item.status === 'review') return t('检查原题一致性');
  return statusNames[item.status];
}
function error(message = '') { $('#formalize-error').textContent = message; $('#formalize-error').hidden = !message; }
async function call<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store', headers: {
    Accept: 'application/json', ...(method === 'GET' ? {} : { 'X-CSRF-Token': state.csrf }),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
  if (!response.ok) throw new Error(localizeMessage(payload?.error ?? t('请求失败 ({0})', response.status)));
  return payload as T;
}
const failure = (cause: unknown) => error(cause instanceof Error ? cause.message : t('请求失败，请稍后重试。'));
const endpoint = (id: string) => `/api/formalizations/${encodeURIComponent(id)}`;
const matchesInput = (item: WebFormalization) => environment.value === item.environment
  && (original.value === item.original || embedded && !original.value && state.selected === item.id);
function loadOriginal(item: WebFormalization) {
  original.value = item.original; environment.value = item.environment; effort.value = item.effort;
  clearExample(); saveDraft(); controls();
}
function mayReplaceOriginal(item: WebFormalization) {
  return matchesInput(item) || (!original.value && !state.item) || (state.item && matchesInput(state.item))
    || confirm(t('当前输入尚未生成匹配的陈述。用这份记录的原题与环境替换当前输入？'));
}
function controls() {
  if (embedded && shell.getClientRects().length) {
    original.style.height = 'auto';
    original.style.height = `${Math.min(320, Math.max(116, original.scrollHeight))}px`;
  }
  const caps = state.capabilities;
  const changed = Boolean(state.item && !matchesInput(state.item));
  $('#formalize-changed').hidden = embedded || !changed;
  const checked = $<HTMLInputElement>('#formalize-checked');
  checked.disabled = changed || state.busy;
  if (changed) checked.checked = false;
  const use = $<HTMLAnchorElement>('#formalize-use');
  const usable = state.item?.status === 'confirmed' && !changed && !state.busy;
  use.setAttribute('aria-disabled', String(!usable));
  if (usable) use.href = `/?formalization=${encodeURIComponent(state.item!.id)}`;
  else use.removeAttribute('href');
  $<HTMLButtonElement>('#formalize-start').disabled = state.busy || !caps?.available || !original.value.trim() || state.items.some(active)
    || (!embedded && caps.key === 'required' && !key.value.trim());
  const sendStatus = $('#formalize-send-status');
  sendStatus.hidden = !embedded || Boolean(caps) && !state.items.some(active) && !state.busy;
  sendStatus.textContent = !caps ? t('正在连接，连接后即可发送。') : state.busy ? t('正在发送…')
    : t('上一道题正在形式化。你可以先输入，处理完成后即可发送。');
  $<HTMLButtonElement>('#formalize-confirm').disabled = state.busy || changed || !checked.checked || state.item?.status !== 'review';
  for (const element of document.querySelectorAll<HTMLButtonElement>('#formalize-actions button')) element.disabled = state.busy;
  $<HTMLButtonElement>('#formalize-refresh').disabled = state.busy;
  exampleSelect.disabled = state.busy;
}
function drawCapabilities() {
  const caps = state.capabilities;
  if (!caps) return;
  $('#formalize-key-note').textContent = caps.key === 'saved' ? t('留空使用已保存的 Key；填写则仅用于这次生成。')
    : caps.key === 'server' ? t('留空使用服务器 Key；填写则仅用于这次生成。') : t('填写当前服务商的 Key，仅用于这次生成。');
  key.required = !embedded && caps.key === 'required';
  const budget = caps.defaults ?? caps.limits;
  $('#formalize-budget').textContent = t('模型 {0} · 最多 {1} 分钟 / {2} Token · {3} 轮写作 · {4} 位审核模型', caps.model,
    Math.ceil(budget.maxRunSeconds / 60), budget.maxTotalTokens ? budget.maxTotalTokens.toLocaleString(localeTag) : t('不限'), caps.limits.maxRounds, caps.limits.reviewers);
  if (embedded) {
    const research = caps.defaults?.research ?? { maxRunSeconds: 300, maxTurns: 5, maxTotalTokens: 200_000 };
    $('#formalize-budget').append(document.createTextNode(' ' + t('随后证明研究最多 {0} 分钟、{1} 轮研究、{2} Token，共用本次 Key。',
      Math.ceil(research.maxRunSeconds / 60), research.maxTurns, research.maxTotalTokens.toLocaleString(localeTag))));
  }
  const note = $('#formalize-unavailable'); note.hidden = caps.available;
  note.textContent = caps.reason === 'provider' ? t('当前未配置支持形式化的服务商，请联系管理员配置。') : t('当前运行环境尚未支持在线形式化。已有结果仍可查看。');
  if (embedded && !caps.available) $<HTMLDetailsElement>('#formalize-settings').open = true;
  controls();
}
function drawList() {
  if (embedded) $('.formalize-history').hidden = !state.items.length;
  const list = $('#formalize-list'); list.replaceChildren();
  if (!state.items.length) { const empty = document.createElement('p'); empty.className = 'field-note'; empty.textContent = t('还没有形式化记录。'); list.append(empty); }
  for (const item of state.items) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'formalize-record'; button.dataset.id = item.id;
    button.setAttribute('aria-pressed', String(item.id === state.selected));
    const title = document.createElement('span'); title.className = 'formalize-record-title'; title.textContent = item.original; title.translate = false;
    const meta = document.createElement('span'); meta.className = 'formalize-record-meta';
    meta.textContent = `${statusName(item)} · ${new Date(item.createdAt).toLocaleString(localeTag, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    button.append(title, meta); button.addEventListener('click', () => { if (!state.busy) void select(item.id); }); list.append(button);
  }
}
function store(item: WebFormalization) {
  state.items = [item, ...state.items.filter(other => other.id !== item.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (state.selected === item.id) state.item = item;
}
function drawReport() {
  if (!report) return;
  const step = ladder.step();
  renderFormalization({ toolbar: $('#formalize-report-toolbar'), chosen: $('#formalize-chosen'), prose: $('#formalize-prose') }, {
    report, pane: state.pane, active: state.active, confirmed: state.item?.status === 'confirmed' && state.item.confirmation !== 'automatic', ...(step ? { step } : {}) });
  $('#formalize-split').dataset.pane = state.pane;
  const spans = correspondenceSpans(report.correspondences, [...state.active]);
  rows.forEach(row => row.classList.toggle('is-active', spans.some(span => span.line === Number(row.dataset.line))));
  highlightSpans('explain-use', rows, spans);
}
function drawCurrent() {
  const item = state.item; $('#formalize-current').hidden = !item;
  if (!item) return;
  $('#formalize-progress').textContent = [statusName(item), active(item) && item.progress ? phaseNames[item.progress.phase] : '',
    item.progress?.round ? t('第 {0} 轮', item.progress.round) : '', item.progress?.tokens !== undefined ? t('已用 {0} Token', item.progress.tokens.toLocaleString(localeTag)) : ''].filter(Boolean).join(' · ');
  $('#formalize-source-text').textContent = item.original;
  if (embedded) $<HTMLDetailsElement>('#formalize-source').open = true;
  const automatic = solving(item);
  $('#formalize-stages').hidden = !automatic;
  const stage = item.status === 'confirmed' ? 'research' : ['translating', 'reviewing', 'finishing'].includes(item.progress?.phase ?? '') ? 'review' : 'formalize';
  for (const node of shell.querySelectorAll<HTMLElement>('[data-stage]')) {
    if (node.dataset.stage === stage) node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current');
  }
  const researchStatus = $('#formalize-research-status'); researchStatus.hidden = !automatic;
  researchStatus.textContent = item.researchError ? t('原题形式化已完成，但证明研究未能启动。没有生成证明结果，可重新发起解题。')
    : item.runId ? t('原题检查已通过，已进入证明研究。是否完成证明以最终 Lean 验证结果为准。')
    : item.status === 'confirmed' ? t('原题检查已通过，正在创建证明研究。')
    : t('正在形式化并检查原题。通过后自动开始证明，无需再次确认。');
  if (['error', 'exhausted', 'cancelled'].includes(item.status)) researchStatus.textContent = t('形式化尚未完成，未启动证明研究。');
  $('#formalize-result').hidden = !item.runId;
  const resultLink = $<HTMLAnchorElement>('#formalize-result-link');
  if (item.runId) resultLink.href = `/?run=${encodeURIComponent(item.runId)}`; else resultLink.removeAttribute('href');
  const reason = $('#formalize-reason'); reason.hidden = !item.reason;
  reason.textContent = item.reason ? sentences(formalizationReasonText(item.reason), t('可复制原题修改后重新生成，不会自动重试。')) : '';
  $('#formalize-failure').hidden = !item.reason;
  $('#formalize-failure-code').textContent = item.reason ?? '';
  const actions = $('#formalize-actions'); actions.replaceChildren();
  function action(label: string, name: string, handler: () => void) {
    const button = document.createElement('button'); button.className = 'button'; button.type = 'button'; button.textContent = label; button.dataset.action = name;
    button.addEventListener('click', handler); actions.append(button);
  }
  if (item.status === 'queued' || item.status === 'running') action(t('取消生成'), 'cancel', () => void mutate('cancel'));
  else action(t('复制原题到输入框'), 'reuse', () => {
    if (!mayReplaceOriginal(item)) return;
    loadOriginal(item); original.focus(); original.scrollIntoView({ block: 'center' });
  });
  if (!active(item)) action(t('删除记录'), 'delete', () => void remove());
  $('#formalize-review').hidden = !item.report;
  if (item.report && report?.evidenceSha256 !== item.report.evidenceSha256) {
    report = item.report; state.active.clear(); ladder.reset();
    rows = buildLeanRows(report.statement); $('#formalize-code').replaceChildren(...rows);
  }
  if (item.report) drawReport();
  $('.formalize-review-note').textContent = automatic ? t('下方保留原题形式化与一致性检查记录。陈述通过检查不等于证明完成，请查看研究中的最终 Lean 验证结果。')
    : t('请核对原题、Lean 陈述与独立回译。模型审核通过仅表示陈述待你确认，证明仍需研究与独立验收。');
  $('#formalize-confirmation').hidden = automatic || item.status !== 'review';
  $('#formalize-confirmed').hidden = automatic || item.status !== 'confirmed';
  controls();
  if (embedded && autoOpen === item.id && item.runId && matchesInput(item) && document.body.dataset.entry === 'natural') {
    autoOpen = ''; window.postMessage({ type: 'theoremos:natural-run', id: item.runId }, location.origin);
  }
}
async function select(id: string) {
  const chosen = state.items.find(item => item.id === id);
  if (!chosen || !mayReplaceOriginal(chosen)) return;
  autoOpen = '';
  loadOriginal(chosen);
  state.selected = id; state.item = undefined; report = undefined;
  $<HTMLInputElement>('#formalize-checked').checked = false; $('#formalize-current').hidden = true; drawList();
  rememberSelection();
  try {
    const result = await call<{ formalization: WebFormalization }>(endpoint(id));
    if (state.selected !== id) return;
    store(result.formalization); drawCurrent(); drawList();
  } catch (cause) { failure(cause); }
  schedule();
}
async function refresh() {
  const result = await call<{ formalizations: WebFormalization[]; generation: WebFormalizationCapabilities }>('/api/formalizations');
  state.items = result.formalizations; state.capabilities = result.generation; drawCapabilities(); drawList();
  if (embedded && state.selected && !state.items.some(item => item.id === state.selected)) {
    state.selected = ''; state.item = undefined; report = undefined; saveDraft(); drawCurrent();
  }
  const id = state.selected;
  if (id) {
    const result = await call<{ formalization: WebFormalization }>(endpoint(id));
    if (state.selected === id) { store(result.formalization); drawCurrent(); drawList(); }
  }
}
function schedule() {
  clearTimeout(timer);
  if (state.items.some(active)) timer = setTimeout(() => void poll(), document.hidden ? 15_000 : 3_000);
}
async function poll() { try { await refresh(); } catch (cause) { failure(cause); } finally { schedule(); } }
async function remove() {
  const item = state.item;
  if (!item || state.busy || !confirm(t('删除这份形式化记录及其对照结果？此操作无法撤销。'))) return;
  state.busy = true; controls(); error();
  try {
    await call(endpoint(item.id), 'DELETE');
    state.selected = ''; state.item = undefined; report = undefined;
    rememberSelection(); $('#formalize-current').hidden = true;
    await refresh();
    if (!embedded && state.items[0]) await select(state.items[0].id);
  } catch (cause) { failure(cause); }
  finally { state.busy = false; controls(); schedule(); }
}
async function mutate(kind: 'cancel' | 'confirm') {
  const item = state.item; if (!item || state.busy) return;
  if (kind === 'confirm' && (item.status !== 'review' || !matchesInput(item) || !item.report || !$<HTMLInputElement>('#formalize-checked').checked)) return;
  state.busy = true; controls(); error();
  try {
    const { formalization } = await call<{ formalization: WebFormalization }>(`${endpoint(item.id)}/${kind}`, 'POST',
      kind === 'confirm' ? { evidenceSha256: item.report!.evidenceSha256 } : {});
    store(formalization); drawCurrent(); drawList();
  } catch (cause) { failure(cause); /* Re-read after an uncertain write; never automatically repeat it. */
    try { await refresh(); } catch { /* Keep the original action error visible. */ }
  } finally { state.busy = false; controls(); schedule(); }
}
$('#formalize-form').addEventListener('submit', async event => {
  event.preventDefault(); if ($<HTMLButtonElement>('#formalize-start').disabled) return;
  const caps = state.capabilities!;
  if (embedded && caps.key === 'required' && !key.value.trim()) {
    $<HTMLDetailsElement>('#formalize-settings').open = true;
    key.focus(); key.scrollIntoView({ block: 'center' }); return;
  }
  if (new TextEncoder().encode(original.value).length > caps.limits.maxOriginalBytes) { error(t('原题超过 {0} 字节，请缩短后重试。', caps.limits.maxOriginalBytes)); return; }
  if (embedded) window.dispatchEvent(new CustomEvent('theoremos:begin-natural'));
  const generation = conversationGeneration;
  state.busy = true; controls(); error();
  const input: WebFormalizationRequest = { original: original.value, environment: environment.value === 'mathlib' ? 'mathlib' : 'standard',
    effort: effort.value as WebFormalizationRequest['effort'], apiKey: key.value, ...(embedded ? { solve: true } : {}) };
  key.value = '';
  try {
    const { formalization } = await call<{ formalization: WebFormalization }>('/api/formalizations', 'POST', input);
    if (generation !== conversationGeneration) { store(formalization); drawList(); return; }
    state.selected = formalization.id; autoOpen = embedded ? formalization.id : ''; store(formalization); report = undefined;
    if (embedded) {
      if (original.value === input.original) original.value = '';
      $<HTMLDetailsElement>('#formalize-settings').open = false;
    }
    $<HTMLInputElement>('#formalize-checked').checked = false;
    rememberSelection();
    drawCurrent(); drawList(); $('#formalize-current').scrollIntoView({ block: 'start' });
  } catch (cause) { failure(cause); try { await refresh(); } catch { /* No automatic retry of a paid request. */ } }
  finally { state.busy = false; controls(); schedule(); }
});
function clearExample() {
  exampleSelect.value = selectedExample = '';
  $('#formalize-example-note').textContent = t('选择后填入完整原题与证明环境，可修改后再生成。');
}
exampleSelect.addEventListener('change', () => {
  const next = exampleSelect.value;
  if (!next) { clearExample(); saveDraft(); return; }
  if (next !== selectedExample && original.value.trim() && !confirm(t('用所选例题替换当前输入的原题？'))) {
    exampleSelect.value = selectedExample; return;
  }
  autoOpen = ''; loadExample(next); saveDraft(); controls();
});
original.addEventListener('input', () => { autoOpen = ''; clearExample(); saveDraft(); controls(); });
if (embedded) {
  original.addEventListener('focus', controls);
  window.addEventListener('resize', controls);
  original.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.altKey || matchMedia('(pointer:coarse)').matches) return;
    event.preventDefault();
    if (!$<HTMLButtonElement>('#formalize-start').disabled) $<HTMLFormElement>('#formalize-form').requestSubmit();
  });
}
environment.addEventListener('change', () => { autoOpen = ''; clearExample(); saveDraft(); controls(); });
effort.addEventListener('change', saveDraft);
key.addEventListener('input', controls);
$('#formalize-use').addEventListener('click', event => {
  if (state.busy || state.item?.status !== 'confirmed' || !matchesInput(state.item)) { event.preventDefault(); controls(); return; }
  if (!embedded) return;
  event.preventDefault();
  window.postMessage({ type: 'theoremos:formalization-confirmed', id: state.item.id }, location.origin);
});
$('#formalize-result-link').addEventListener('click', event => {
  if (!embedded || !state.item?.runId) return;
  event.preventDefault(); window.postMessage({ type: 'theoremos:natural-run', id: state.item.runId }, location.origin);
});
if (embedded) window.addEventListener('theoremos:natural-original', event => {
  const text = (event as CustomEvent<{ original?: unknown }>).detail?.original;
  if (typeof text !== 'string' || !text.trim() || state.busy) return;
  if (original.value && original.value !== text && !confirm(t('用这段文字替换当前输入的原题？'))) return;
  autoOpen = ''; original.value = text; clearExample(); saveDraft(); controls();
  original.focus(); original.scrollIntoView({ block: 'center' });
});
if (embedded) window.addEventListener('theoremos:new-natural', () => {
  conversationGeneration++;
  autoOpen = ''; original.value = ''; key.value = ''; environment.value = 'mathlib'; effort.value = 'max';
  state.selected = ''; state.item = undefined; report = undefined;
  clearExample(); saveDraft(); error(); drawCurrent(); drawList(); controls();
  $<HTMLDetailsElement>('#formalize-settings').open = false;
  $<HTMLDetailsElement>('#formalize-history-details').open = false;
  original.focus(); original.scrollIntoView({ block: 'center' });
});
$('#formalize-checked').addEventListener('change', controls);
$('#formalize-confirm').addEventListener('click', () => void mutate('confirm'));
$('#formalize-refresh').addEventListener('click', () => { error(); void poll(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.items.some(active)) { clearTimeout(timer); void poll(); } });
$('#formalize-review').addEventListener('click', event => {
  if (!report || !(getSelection()?.isCollapsed ?? true)) return;
  const target = event.target as HTMLElement, action = target.closest<HTMLElement>('[data-action]'), row = target.closest<HTMLElement>('.lean-row');
  if (action?.dataset.action === 'pane') state.pane = action.dataset.pane === 'lean' ? 'lean' : 'prose';
  else if (action?.dataset.action === 'correspondence') {
    state.active = new Set(ladder.climb(action));
    if (matchMedia('(max-width:900px)').matches && correspondenceSpans(report.correspondences, [...state.active]).length) state.pane = 'lean';
  } else if (action?.dataset.action === 'wider') { const next = ladder.next(); if (next) state.active = new Set(next); }
  else if (row) {
    state.active = new Set(report.correspondences.flatMap((item, index) => item.lean.some(span => span.line === Number(row.dataset.line)) ? [index] : []));
    ladder.reset(); if (state.active.size && matchMedia('(max-width:900px)').matches) state.pane = 'prose';
  } else return;
  drawReport();
  const spans = correspondenceSpans(report.correspondences, [...state.active]);
  const focus = row ? $('#formalize-prose').querySelector<HTMLElement>(`[data-item="${[...state.active][0]}"]`) : spans[0] ? rows[spans[0].line - 1] : undefined;
  if (focus) focus.scrollIntoView({ block: 'nearest' });
});
$('#formalize-prose').addEventListener('keydown', event => {
  const target = event.target as HTMLElement;
  if ((event.key === 'Enter' || event.key === ' ') && target.matches('[role="button"][data-action]')) { event.preventDefault(); target.click(); }
});
async function start() {
  try {
    const session = await call<WebSession>('/api/session');
    if (session.auth === 'email' && !session.account) { location.replace('login.html'); return; }
    state.csrf = session.csrfToken; restoreDraft(session);
    await refresh();
    if (!embedded && !draftEdited && !selectedExample) {
      if (state.item) loadOriginal(state.item);
      else if (!state.selected && state.items.length) await select(state.items[0]!.id);
    }
    schedule();
  } catch (cause) { failure(cause); }
}
void start();

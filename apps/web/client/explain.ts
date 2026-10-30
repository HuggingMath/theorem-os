import { createIcons, ArrowLeft } from 'lucide';
import type { WebExplanation, WebExplanationDocument, WebExplanationLines, WebExplanationOverview, WebExplanationSpan, WebSession } from '../shared';
import { locale, mountLocaleSwitch, t } from '../i18n';
import { anchorSpan, leanGutter, leanLines, proseAt, refLines, stepAtLine, type StepRef } from './explainText';
import { renderExplain, type ExplainView } from './explainView';

/**
 * The explanation page (explain.html?run=…&target=…): the accepted Lean proof on the left, its natural-language proof on
 * the right. Choosing a step marks its Lean lines; choosing a Lean line finds its step; the panes can scroll together.
 */
createIcons({ icons: { ArrowLeft }, attrs: { 'aria-hidden': 'true' } });
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
mountLocaleSwitch($<HTMLButtonElement>('#locale-switch'));
const params = new URLSearchParams(location.search);
const hosts = { toolbar: $('#explain-toolbar'), head: $('#explain-prose-head'), prose: $('#explain-prose'), dialog: $('#explain-dialog'),
  legend: $('#explain-lean-legend') };
const leanScroll = $('#explain-lean'), proseScroll = $('#explain-prose'), dialog = $<HTMLDialogElement>('#explain-dialog');
const state = {
  runId: params.get('run') ?? '', target: params.get('target') ?? '',
  language: (params.get('language') === 'en' || params.get('language') === 'zh' ? params.get('language') : locale) as 'zh' | 'en',
  csrf: '', overview: undefined as WebExplanationOverview | undefined, documents: new Map<string, WebExplanationDocument>(),
  loading: new Set<string>(), documentError: undefined as string | undefined, active: undefined as StepRef | undefined,
  gap: undefined as number | undefined, pane: 'prose' as 'lean' | 'prose', sync: true, dialog: undefined as ExplainView['dialog'], busy: false, error: undefined as string | undefined,
};
let toastTimer: ReturnType<typeof setTimeout> | undefined;

class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function call<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', ...(method === 'GET' ? {} : { 'X-CSRF-Token': state.csrf }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch { throw new RequestError(t('暂时无法连接服务，请稍后重试。'), 0); }
  const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
  if (!response.ok) throw new RequestError(payload?.error ?? t('请求失败 ({0})', response.status), response.status);
  return payload as T;
}
const message = (error: unknown) => error instanceof Error ? error.message : t('请求失败，请稍后重试。');
function toast(text: string) {
  const target = $('#explain-toast');
  target.textContent = text; target.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { target.hidden = true; }, 3000);
}
const base = () => `/api/runs/${encodeURIComponent(state.runId)}/explanations`;
const query = () => new URLSearchParams({ target: state.target, language: state.language }).toString();
const current = () => state.overview?.explanations.find(item => item.target === state.target && item.language === state.language);
const activeStatus = (item?: WebExplanation) => item?.status === 'queued' || item?.status === 'running';
const currentDocument = () => { const item = current(); return item?.status === 'approved' ? state.documents.get(item.id) : undefined; };
function store(explanation: WebExplanation | undefined, target = state.target, language = state.language) {
  if (!state.overview) return;
  const rest = state.overview.explanations.filter(item => item.target !== target || item.language !== language);
  state.overview.explanations = explanation ? [...rest, explanation] : rest;
  if (explanation?.document) state.documents.set(explanation.id, explanation.document);
}
// The Lean pane is drawn once per proof and only its row classes change, so a long proof is never re-rendered.
let leanRows: HTMLElement[] = [], drawnProof: string | undefined;
function drawLean(proof: string) {
  if (drawnProof === proof) return;
  drawnProof = proof;
  const code = $('#explain-lean-code'), fragment = document.createDocumentFragment();
  leanRows = leanLines(proof).map((segments, index) => {
    const row = document.createElement('div'), number = document.createElement('span'), gutter = document.createElement('span'),
      text = document.createElement('span');
    row.className = 'lean-row'; row.dataset.line = String(index + 1);
    number.className = 'lean-number'; number.textContent = String(index + 1); number.setAttribute('aria-hidden', 'true');
    gutter.className = 'lean-mark'; gutter.setAttribute('aria-hidden', 'true');
    text.className = 'lean-text';
    for (const segment of segments) {
      if (!segment.kind) { text.append(segment.text); continue; }
      const token = document.createElement('span');
      token.className = `lean-tok-${segment.kind}`; token.textContent = segment.text;
      text.append(token);
    }
    row.append(number, gutter, text);
    fragment.append(row);
    return row;
  });
  code.replaceChildren(fragment);
  $('#explain-lean-count').textContent = t('{0} 行', leanRows.length);
  marked.clear(); painted = undefined;
}
/** The margin beside each line number: its step's number on the first line of a run, a bar for the rest. */
let painted: WebExplanationDocument | undefined;
function paintGutter(explained?: WebExplanationDocument) {
  if (painted === explained) return;
  painted = explained;
  const marks = explained ? leanGutter(explained) : new Map();
  leanRows.forEach((row, index) => {
    const gutter = row.children[1] as HTMLElement, mark = marks.get(index + 1);
    gutter.className = mark ? `lean-mark is-${mark.kind}${mark.first ? ' is-first' : ''}` : 'lean-mark';
    gutter.textContent = mark?.kind === 'step' && mark.first ? String(mark.step + 1) : '';
  });
}
const marked = new Map<string, { key: string; rows: HTMLElement[] }>();
function mark(kind: 'section' | 'active' | 'hover' | 'quoted' | 'use', lines: readonly WebExplanationLines[]) {
  const key = lines.map(item => `${item.start}-${item.end}`).join(','), previous = marked.get(kind);
  if (previous?.key === key) return;
  for (const row of previous?.rows ?? []) row.classList.remove(`is-${kind}`);
  const rows: HTMLElement[] = [];
  for (const item of lines) for (let line = Math.max(1, item.start); line <= Math.min(leanRows.length, item.end); line++) rows.push(leanRows[line - 1]!);
  for (const row of rows) row.classList.add(`is-${kind}`);
  marked.set(kind, { key, rows });
}
function markLean(explained?: WebExplanationDocument) {
  paintGutter(explained);
  mark('quoted', explained ? explained.sections.flatMap(section => section.steps.flatMap(step => step.lines)) : []);
  mark('section', explained && state.active ? [explained.sections[state.active.section]!.lines] : []);
  mark('active', explained && state.active ? state.gap !== undefined ? [{ start: state.gap, end: state.gap }] : refLines(explained, state.active) : []);
  if (!explained) { pinned = []; markUse(undefined); }
}
// Where a cited name is written: its row is marked, and the name itself where the browser can highlight text ranges.
const canHighlight = () => typeof CSS !== 'undefined' && Boolean(CSS.highlights) && typeof Highlight !== 'undefined';
let pinned: WebExplanationSpan[] = [];
function rangeOf(span: WebExplanationSpan): Range | undefined {
  const text = leanRows[span.line - 1]?.children[2];
  if (!text) return undefined;
  const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT), range = document.createRange();
  let offset = 0, started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent!.length;
    if (!started && span.start < offset + length) { range.setStart(node, span.start - offset); started = true; }
    if (started && span.end <= offset + length) { range.setEnd(node, span.end - offset); return range; }
    offset += length;
  }
  return undefined;
}
/** Marks the spans of the name being pointed at; with none, the spans of the name last clicked. */
function markUse(spans: readonly WebExplanationSpan[] | undefined) {
  const shown = spans ?? pinned;
  mark('use', shown.map(span => ({ start: span.line, end: span.line })));
  if (!canHighlight()) return;
  const ranges = shown.flatMap(span => { const range = rangeOf(span); return range ? [range] : []; });
  if (ranges.length) CSS.highlights.set('explain-use', new Highlight(...ranges)); else CSS.highlights.delete('explain-use');
}
const useSpans = (element: HTMLElement): WebExplanationSpan[] => {
  const explained = currentDocument();
  return explained?.sections[Number(element.dataset.section)]?.steps[Number(element.dataset.step)]?.uses[Number(element.dataset.use)]?.spans ?? [];
};

function draw() {
  const overview = state.overview;
  if (!overview) return;
  const explanation = current(), explained = currentDocument();
  renderExplain(hosts, { overview, target: state.target, language: state.language, pane: state.pane, sync: state.sync,
    ...(explanation ? { explanation } : {}), ...(explained ? { document: explained } : {}), ...(state.documentError ? { documentError: state.documentError } : {}),
    ...(state.active ? { active: state.active } : {}), ...(state.gap !== undefined ? { gap: state.gap } : {}),
    ...(state.dialog ? { dialog: state.dialog } : {}), busy: state.busy,
    ...(state.error ? { error: state.error } : {}), now: Date.now() });
  $('#explain-split').dataset.pane = state.pane;
  markLean(explained);
  // The heading exists only while a dialog is drawn, so the name points at it only then.
  if (state.dialog) dialog.setAttribute('aria-labelledby', 'explain-dialog-heading'); else dialog.removeAttribute('aria-labelledby');
  if (state.dialog && !dialog.open) dialog.showModal();
  if (!state.dialog && dialog.open) dialog.close();
}
// While the shown explanation is queued or running: poll it, and tick the elapsed time each second.
let pollTimer: ReturnType<typeof setTimeout> | undefined, tickTimer: ReturnType<typeof setInterval> | undefined;
function schedule() {
  clearTimeout(pollTimer);
  const active = activeStatus(current());
  if (active && !tickTimer) tickTimer = setInterval(() => { if (!document.hidden) draw(); }, 1000);
  if (!active) { clearInterval(tickTimer); tickTimer = undefined; return; }
  pollTimer = setTimeout(() => void poll(), document.hidden ? 30_000 : 5_000);
}
async function poll() {
  const target = state.target, language = state.language;
  try {
    const { explanation } = await call<{ explanation: WebExplanation }>(`${base()}/item?${query()}`);
    if (target !== state.target || language !== state.language) return;
    store(explanation);
  } catch (error) {
    if (error instanceof RequestError && error.status === 404 && target === state.target && language === state.language) store(undefined);
  }
  if (target === state.target && language === state.language) { draw(); void loadDocument(); schedule(); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && activeStatus(current())) void poll(); });

/** The list carries no documents; an approved one is fetched once and kept. */
async function loadDocument() {
  const item = current();
  if (item?.status !== 'approved' || state.documents.has(item.id) || state.loading.has(item.id)) return;
  state.loading.add(item.id); state.documentError = undefined;
  try {
    const { explanation } = await call<{ explanation: WebExplanation }>(`${base()}/item?${new URLSearchParams({ target: item.target, language: item.language })}`);
    if (explanation.document) state.documents.set(explanation.id, explanation.document);
    // The server checks the saved evidence against the proof on every read; a reason means it no longer matches.
    else state.documentError = explanation.reason ? t('已保存的讲解没有通过完整性检查，无法显示。可以删除后重新生成。') : t('这份讲解没有可显示的内容。');
  } catch (error) { state.documentError = message(error); }
  finally { state.loading.delete(item.id); }
  draw();
}
const narrow = () => matchMedia('(max-width: 900px)').matches;
const smooth = () => matchMedia('(prefers-reduced-motion: no-preference)').matches ? 'smooth' as const : 'auto' as const;
const offsetIn = (scroll: HTMLElement, element: HTMLElement) => element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
const anchorOf = (ref: StepRef) => proseScroll.querySelector<HTMLElement>(ref.step === undefined
  ? `[data-anchor="${ref.section}"]:not([data-step])` : `[data-anchor="${ref.section}"][data-step="${ref.step}"]`);
// A programmatic reveal scrolls both panes itself; scroll sync stays out of the way until it settles.
let holdUntil = 0;
function revealLine(line: number) {
  const row = leanRows[line - 1];
  if (!row) return;
  holdUntil = performance.now() + 700;
  leanScroll.scrollTo({ top: Math.max(0, offsetIn(leanScroll, row) - leanScroll.clientHeight / 3), behavior: smooth() });
}
function revealStep(ref: StepRef) {
  const anchor = anchorOf(ref);
  if (!anchor) return;
  holdUntil = performance.now() + 700;
  proseScroll.scrollTo({ top: Math.max(0, offsetIn(proseScroll, anchor) - 16), behavior: smooth() });
}
/**
 * Marks a step, statement or declaration and brings the other side into view; on phones it switches to that side.
 * `gap` is a proof line no step quotes, `spans` where a clicked name is written; either replaces the lines shown.
 */
function select(ref: StepRef, show: 'lean' | 'prose', options: { gap?: number; spans?: WebExplanationSpan[] } = {}) {
  const explained = currentDocument();
  if (!explained) return;
  state.active = ref; state.gap = options.gap;
  pinned = options.spans ?? [];
  markUse(undefined);
  if (narrow()) state.pane = show;
  draw();
  // The pane may have just become visible; positions are only meaningful after layout.
  requestAnimationFrame(() => {
    if (show === 'lean') revealLine(options.spans?.[0]?.line ?? options.gap ?? refLines(explained, ref)[0]?.start ?? 1);
    else revealStep(ref);
  });
}

// Scroll sync: the pane the reader is moving leads, the other follows; a programmatic scroll never leads.
let driver: 'lean' | 'prose' | undefined, frame = 0;
for (const [pane, element] of [['lean', leanScroll], ['prose', proseScroll]] as const)
  for (const type of ['pointerdown', 'wheel', 'touchstart', 'keydown'])
    element.addEventListener(type, () => { driver = pane; }, { passive: true });
function follow(from: 'lean' | 'prose') {
  if (from !== driver || !state.sync || narrow() || performance.now() < holdUntil || frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const explained = currentDocument();
    if (!explained || !leanRows.length) return;
    if (from === 'prose') alignLean(explained); else alignProse(explained);
  });
}
leanScroll.addEventListener('scroll', () => follow('lean'), { passive: true });
proseScroll.addEventListener('scroll', () => follow('prose'), { passive: true });
// Rows have one height, so a line's position is arithmetic; the margin keeps the followed line off the very top.
const rowHeight = () => leanRows[0]?.offsetHeight || 20, firstRow = () => leanRows[0] ? offsetIn(leanScroll, leanRows[0]) : 0, margin = 24;
function alignLean(explained: WebExplanationDocument) {
  if (proseScroll.scrollTop <= 0) { leanScroll.scrollTop = 0; return; }
  const top = proseScroll.getBoundingClientRect().top;
  const anchors = [...proseScroll.querySelectorAll<HTMLElement>('[data-anchor]')];
  const anchor = anchors.find(item => item.getBoundingClientRect().bottom > top + 8) ?? anchors.at(-1);
  if (!anchor) return;
  const ref: StepRef = { section: Number(anchor.dataset.anchor), ...(anchor.dataset.step ? { step: Number(anchor.dataset.step) } : {}) };
  const span = anchorSpan(explained, ref), box = anchor.getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (top - box.top) / Math.max(1, box.height)));
  const line = span.start + fraction * (span.end - span.start + 1);
  leanScroll.scrollTop = Math.max(0, firstRow() + (line - 1) * rowHeight() - margin);
}
function alignProse(explained: WebExplanationDocument) {
  if (leanScroll.scrollTop <= 0) { proseScroll.scrollTop = 0; return; }
  const place = proseAt(explained, (leanScroll.scrollTop + margin - firstRow()) / rowHeight() + 1);
  const anchor = place && anchorOf(place.ref);
  if (!anchor) return;
  proseScroll.scrollTop = Math.max(0, offsetIn(proseScroll, anchor) + place!.fraction * anchor.offsetHeight - 8);
}
const refOf = (element: HTMLElement): StepRef => ({ section: Number(element.dataset.section ?? element.dataset.anchor),
  ...(element.dataset.step ? { step: Number(element.dataset.step) } : {}), ...(element.dataset.statement !== undefined ? { statement: true as const } : {}) });
const selecting = () => !(getSelection()?.isCollapsed ?? true);
document.addEventListener('click', event => {
  const target = event.target as HTMLElement;
  const row = target.closest<HTMLElement>('.lean-row');
  if (row && !selecting()) {
    const explained = currentDocument(), line = Number(row.dataset.line), ref = explained && stepAtLine(explained, line);
    // A proof line no step quotes opens its declaration with a note saying so.
    const gap = ref && ref.step === undefined && !ref.statement && explained!.sections[ref.section]!.unexplained.includes(line) ? line : undefined;
    if (ref) select(ref, 'prose', gap === undefined ? {} : { gap });
    return;
  }
  // Opening the auditors' notes or the goals is reading, not choosing a step.
  if (target.closest('.explain-reviews')) return;
  const action = target.closest<HTMLElement>('[data-action]');
  if (!action) {
    // A click on a step's or statement's text marks its Lean lines, unless the reader is selecting text.
    const step = target.closest<HTMLElement>('.explain-steps > li[data-step]');
    const statement = !step && target.closest<HTMLElement>('.explain-statement-block');
    if (selecting()) return;
    if (step) select(refOf(step), 'lean');
    else if (statement) select({ section: Number(statement.dataset.anchor), statement: true }, 'lean');
    return;
  }
  const name = action.dataset.action;
  if (name === 'lines') select(refOf(action), 'lean');
  else if (name === 'use') select({ section: Number(action.dataset.target) }, 'prose');
  else if (name === 'use-lean') select(refOf(action), 'lean', { spans: useSpans(action) });
  else if (name === 'generate' || name === 'cancel' || name === 'delete') { state.dialog = name; state.error = undefined; draw(); }
  else if (name === 'close-dialog') { state.dialog = undefined; draw(); }
  else if (name === 'confirm-cancel') void stop();
  else if (name === 'confirm-delete') void remove();
  else if (name === 'pane') { state.pane = action.dataset.pane === 'lean' ? 'lean' : 'prose'; draw(); }
  else if (name === 'language' && action.dataset.language !== state.language) choose(state.target, action.dataset.language === 'en' ? 'en' : 'zh');
});
document.addEventListener('change', event => {
  const target = event.target as HTMLElement;
  if (target instanceof HTMLSelectElement && target.id === 'explain-target-select') choose(target.value, state.language);
  if (target instanceof HTMLInputElement && target.id === 'explain-sync') { state.sync = target.checked; draw(); }
});
// Pointing at a step or statement previews its Lean lines; at a cited name, where the name is written.
proseScroll.addEventListener('mouseover', event => {
  const target = event.target as HTMLElement, explained = currentDocument();
  const step = target.closest<HTMLElement>('.explain-steps > li[data-step]'), statement = !step && target.closest<HTMLElement>('.explain-statement-block');
  const ref = step ? refOf(step) : statement ? { section: Number(statement.dataset.anchor), statement: true as const } : undefined;
  mark('hover', ref && explained ? refLines(explained, ref) : []);
  const use = target.closest<HTMLElement>('.explain-use[data-use]');
  markUse(use ? useSpans(use) : undefined);
});
proseScroll.addEventListener('mouseleave', () => { mark('hover', []); markUse(undefined); });
proseScroll.addEventListener('focusin', event => {
  const use = (event.target as HTMLElement).closest<HTMLElement>('.explain-use[data-use]');
  if (use) markUse(useSpans(use));
});
proseScroll.addEventListener('focusout', () => markUse(undefined));
dialog.addEventListener('submit', event => {
  event.preventDefault();
  const key = (event.target as HTMLFormElement).querySelector<HTMLInputElement>('[name="apiKey"]');
  void generate(key?.value.trim() ?? '');
});
// Escape is ignored while a request runs, so its answer is never lost behind a closed dialog.
dialog.addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });
dialog.addEventListener('close', () => { if (state.dialog) { state.dialog = undefined; state.error = undefined; draw(); } });

async function act(work: () => Promise<void>) {
  state.busy = true; state.error = undefined; draw();
  try { await work(); state.dialog = undefined; }
  catch (error) { state.error = message(error); }
  finally { state.busy = false; draw(); schedule(); }
}
const generate = (apiKey: string) => act(async () => {
  const { explanation } = await call<{ explanation: WebExplanation }>(base(), 'POST', { target: state.target, language: state.language, ...(apiKey ? { apiKey } : {}) });
  store(explanation);
  toast(t('已开始生成讲解'));
});
const stop = () => act(async () => {
  const { explanation } = await call<{ explanation: WebExplanation }>(`${base()}/cancel?${query()}`, 'POST');
  store(explanation);
  toast(t('已停止生成'));
});
const remove = () => act(async () => {
  await call(`${base()}/item?${query()}`, 'DELETE');
  store(undefined);
  state.active = undefined; state.gap = undefined; pinned = [];
  toast(t('讲解已删除'));
});

function choose(target: string, language: 'zh' | 'en') {
  state.target = target; state.language = language; state.active = undefined; state.gap = undefined; state.documentError = undefined;
  pinned = [];
  history.replaceState(null, '', `?${new URLSearchParams({ run: state.runId, target, language })}`);
  proseScroll.scrollTop = 0;
  draw(); void loadDocument(); schedule();
}
function missing(text: string) {
  $('#explain-loading').hidden = true;
  $('#explain-missing-text').textContent = text;
  $('#explain-missing').hidden = false;
}
async function start() {
  if (!/^[a-f0-9-]{36}$/u.test(state.runId)) { missing(t('链接不完整，请从工作台的验收报告重新打开证明讲解。')); return; }
  $<HTMLAnchorElement>('#explain-back').href = `./?run=${encodeURIComponent(state.runId)}`;
  try {
    const session = await call<WebSession>('/api/session');
    if (session.auth === 'email' && !session.account) { location.replace('login.html'); return; }
    state.csrf = session.csrfToken;
    const overview = await call<WebExplanationOverview>(base());
    if (!overview.targets.length) { missing(t('证明中没有找到原题的目标定理，无法生成讲解。')); return; }
    state.overview = overview;
    if (!overview.targets.some(item => item.name === state.target)) state.target = overview.targets[0]!.name;
    // A link without a language opens the explanation that exists (approved first), else the interface language.
    if (!params.has('language')) {
      const rank = (item: WebExplanation) => (item.status === 'approved' ? 0 : activeStatus(item) ? 2 : 4) + (item.language === locale ? 0 : 1);
      const existing = overview.explanations.filter(item => item.target === state.target).sort((a, b) => rank(a) - rank(b))[0];
      if (existing) state.language = existing.language;
    }
    document.title = `${overview.run.title} · ${t('证明讲解')} · TheoremOS`;
    $('#explain-run-title').textContent = overview.run.title;
    drawLean(overview.run.proof);
    $('#explain-loading').hidden = true;
    $('#explain-content').hidden = false;
    choose(state.target, state.language);
  } catch (error) {
    missing(error instanceof RequestError && error.status === 404 ? t('运行不存在，或不属于当前账号。') : message(error));
  }
}
void start();

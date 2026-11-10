import { createIcons, Copy, Download, ShieldCheck } from 'lucide';
import { h, render } from 'preact';
import { effortLabels, formatDateTime, readableMetric, statementConfirmation } from '../presentation';
import { webShareToken, type WebShareSnapshot } from '../shareTypes';
import { locale, localizeMessage, localizeText, mountLocaleSwitch, t } from '../i18n';
import type { WebSession } from '../shared';
import type { SharedProofReading } from '../sharedProofTypes';
import { localizeSiteLinks } from './feedback';
import { leanFileName } from './leanOutline';
import { leanLineTokens } from './sourceText';
import { Rich } from './richText';
import { ShareReadingView } from './ShareReadingView';
import { ShareReceiverActions } from './ShareReceiverActions';
import { finishShareLoginReturn, shareLoginLink } from './shareContinuation';
import './shareContinuation.css';

createIcons({ icons: { Copy, Download, ShieldCheck }, attrs: { 'aria-hidden': 'true' } });
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
mountLocaleSwitch($<HTMLButtonElement>('#locale-switch'));
localizeSiteLinks();
let view: 'proof' | 'source' = 'proof', snapshot: WebShareSnapshot | undefined, toastTimer: ReturnType<typeof setTimeout> | undefined;
const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
const returned = new URLSearchParams(location.search);
if (returned.has('shareReturn')) {
  finishShareLoginReturn(location.search); returned.delete('shareReturn');
  history.replaceState(null, '', `${location.pathname}${returned.size ? `?${returned}` : ''}${location.hash}`);
}

function toast(text: string) {
  const target = $('#share-toast');
  target.textContent = text; target.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { target.hidden = true; }, 3000);
}
function facts(target: HTMLElement, items: [string, string, boolean?][]) {
  target.replaceChildren(...items.map(([label, value, mono]) => {
    const row = document.createElement('div'), term = document.createElement('dt'), detail = document.createElement('dd');
    term.textContent = label; detail.textContent = value;
    if (mono) detail.className = 'mono';
    row.append(term, detail);
    return row;
  }));
}
function prose(target: HTMLElement, text: string) { render(h(Rich, { text }), target); }
function missing(text?: string) {
  $('#share-loading').hidden = true;
  if (text) $('#share-missing-text').textContent = text;
  $('#share-missing').hidden = false;
}
/** The code numbered and coloured like the result tab's, one `.lean-line` per line so a phone can wrap it under its number. */
function drawCode(text: string) {
  const rows: (Node | string)[] = [], lines = leanLineTokens(text);
  for (const [index, line] of lines.entries()) {
    const row = document.createElement('span');
    let offset = line.start;
    row.className = 'lean-line';
    for (const token of line.tokens) {
      if (token.start > offset) row.append(text.slice(offset, token.start));
      const part = document.createElement('span');
      part.className = `lean-${token.kind}`; part.textContent = text.slice(token.start, token.end);
      row.append(part);
      offset = token.end;
    }
    if (offset < line.end) row.append(text.slice(offset, line.end));
    if (index) rows.push('\n');
    rows.push(row);
  }
  // A final line break stays in the text, so copying the code keeps it.
  if (text.endsWith('\n')) rows.push('\n');
  $('#share-code').replaceChildren(...rows);
  $('#share-line-numbers').textContent = Array.from(lines, (_, index) => index + 1).join('\n');
}
function showCode() {
  if (!snapshot) return;
  drawCode(view === 'proof' ? snapshot.proof : snapshot.source);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-share-view]'))
    button.setAttribute('aria-pressed', String(button.dataset.shareView === view));
}
function show(share: WebShareSnapshot, context: { token?: string; readingId?: string }) {
  snapshot = share;
  document.title = `${share.title} · TheoremOS`;
  prose($('#share-title'), share.title);
  facts($('#share-facts'), [
    [t('证明环境'), share.environment === 'mathlib' ? 'Mathlib' : t('Lean 标准库')],
    [t('模型'), share.model, true], [t('推理强度'), effortLabels[share.effort] ?? share.effort], [t('Agent 数量'), String(share.workers)],
    ...share.metrics.map(readableMetric).map(item => [item.label, item.value] as [string, string]),
    [t('完成时间'), formatDateTime(share.finishedAt ?? share.createdAt)], [t('分享时间'), formatDateTime(share.sharedAt)],
  ]);
  prose($('#share-task'), share.formalization?.original ?? share.task);
  const formalization = share.formalization;
  $('#share-verdict').textContent = t('Lean 陈述证明通过');
  $('#share-confirmation').textContent = formalization ? formalization.reviewMode === 'direct' ? t('Lean 编译通过') : statementConfirmation(formalization.confirmation, true)
    : t('此分享仅包含 Lean 陈述与证明，未提供自然语言原题的确认记录。');
  if (formalization) {
    $('#share-task-heading').textContent = t('自然语言原题');
    const review = formalization.review;
    if (review?.backtranslation) {
      $('#share-review').hidden = false;
      prose($('#share-backtranslation'), [review.backtranslation.mathematics, ...review.backtranslation.assumptions,
        ...review.backtranslation.definitions].join('\n\n'));
      const relations = { direct: t('直接对应'), equivalent: t('等价表达'), unresolved: t('待核对'), mismatch: t('不一致') };
      $('#share-correspondences').replaceChildren(...review.correspondences.map(item => {
        const row = document.createElement('article'), heading = document.createElement('strong');
        heading.textContent = relations[item.relation]; row.dataset.relation = item.relation;
        const original = document.createElement('blockquote'), lean = document.createElement('pre');
        prose(original, item.original); original.translate = false; lean.textContent = item.leanText; lean.translate = false;
        row.append(heading, original, lean, ...item.explanations.map(text => {
          const explanation = document.createElement('p'); prose(explanation, text); explanation.translate = false; return explanation;
        }));
        return row;
      }));
    }
  }
  $('#share-checks').replaceChildren(...share.checks.map(check => {
    const item = document.createElement('li'), heading = document.createElement('div'), label = document.createElement('strong');
    const badge = document.createElement('span');
    heading.className = 'share-check-heading'; label.textContent = localizeText(check.label);
    badge.className = `badge ${check.tone}`; badge.textContent = localizeText(check.status);
    heading.append(label, badge);
    item.append(heading);
    if (check.method) {
      const method = document.createElement('p');
      method.className = 'share-check-method'; method.textContent = t('方式：{0}', localizeText(check.method));
      item.append(method);
    }
    if (check.targets.length) {
      const list = document.createElement('ul');
      list.className = 'share-targets';
      list.append(...check.targets.map(target => {
        const row = document.createElement('li'), name = document.createElement('code'), state = document.createElement('span');
        name.textContent = target.name; state.className = `share-target-status ${target.tone}`; state.textContent = localizeText(target.status);
        row.append(name, state);
        return row;
      }));
      item.append(list);
    }
    return item;
  }));
  facts($('#share-identity'), share.identity.map(item => [localizeText(item.label), item.value, true]));
  $('#share-credentials').hidden = !share.identity.length;
  render(h(ShareReadingView, { share, shareId: context.readingId ?? context.token ?? 'shared-proof' }), $('#share-reading-host'));
  render(h(ShareReceiverActions, { share, ...context }), $('#share-receiver-host'));
  showCode();
  $('#share-loading').hidden = true;
  $('#share-content').hidden = false;
}
async function load() {
  const token = location.hash.slice(1);
  const readingId = new URLSearchParams(location.search).get('reading');
  if (!token && readingId && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(readingId)) {
    try {
      const sessionResponse = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
      const session = await sessionResponse.json() as WebSession;
      if (!sessionResponse.ok) throw new Error(tx('暂时无法读取登录状态，请稍后重试。', 'Could not read your sign-in status. Please retry.'));
      if (session.auth === 'email' && (!session.account || session.termsRequired)) {
        missing(tx('请登录收藏这份分享的账号后继续。', 'Sign in to the account that saved this proof.'));
        const action = new URLSearchParams(location.search).get('action') === 'prepare' ? 'prepare' : 'bookmark';
        const link = document.createElement('a'); link.className = 'button'; link.dataset.sharePrivateSignin = '';
        link.href = shareLoginLink({ readingId, action, language: locale }); link.textContent = tx('登录并继续', 'Sign in and continue');
        $('#share-missing').append(link); return;
      }
      const response = await fetch(`/api/research/shared-proofs/${encodeURIComponent(readingId)}`, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
      const payload = await response.json() as { item?: SharedProofReading; error?: string };
      if (!response.ok || !payload.item) { missing(payload.error ? localizeMessage(payload.error) : undefined); return; }
      show(payload.item.share, { readingId }); return;
    } catch (cause) { missing(cause instanceof Error ? localizeMessage(cause.message) : t('暂时无法连接服务，请稍后重试。')); return; }
  }
  if (!webShareToken.test(token)) { missing(t('链接不完整，请向分享者重新获取。')); return; }
  try {
    // No credentials: a share reads the same for everyone, signed in or not.
    const response = await fetch(`/api/share/${token}`, { credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => undefined) as { share?: WebShareSnapshot; error?: string } | undefined;
    if (!response.ok || !payload?.share) { missing(response.status === 404 ? undefined : payload?.error ? localizeMessage(payload.error) : t('暂时无法读取分享内容，请稍后重试。')); return; }
    show(payload.share, { token });
  } catch { missing(t('暂时无法连接服务，请稍后重试。')); }
}

document.addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!target || !snapshot) return;
  if (target.dataset.shareJump) {
    const section = document.getElementById(target.dataset.shareJump);
    if (section) { section.scrollIntoView({ block: 'start', behavior: 'instant' }); section.focus({ preventScroll: true }); }
  }
  if (target.dataset.shareView === 'proof' || target.dataset.shareView === 'source') { view = target.dataset.shareView; showCode(); }
  if (target.id === 'share-copy') {
    const text = view === 'proof' ? snapshot.proof : snapshot.source;
    void (navigator.clipboard?.writeText ? navigator.clipboard.writeText(text) : Promise.reject(new Error('clipboard')))
      .then(() => toast(t('Lean 源码已复制')), () => toast(t('无法访问剪贴板')));
  }
  if (target.id === 'share-download') {
    const url = URL.createObjectURL(new Blob([view === 'proof' ? snapshot.proof : snapshot.source], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    // Named like the workbench's download, after the theorem; the original problem keeps its placeholders.
    link.href = url; link.download = leanFileName(snapshot.source, view === 'proof' ? '' : '-problem');
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
});
window.addEventListener('hashchange', () => { location.reload(); });
void load();

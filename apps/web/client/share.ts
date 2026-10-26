import { createIcons, Copy, Download, ShieldCheck } from 'lucide';
import { effortLabels, formatDateTime } from '../presentation';
import { webShareToken, type WebShareSnapshot } from '../share';

createIcons({ icons: { Copy, Download, ShieldCheck }, attrs: { 'aria-hidden': 'true' } });
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
let view: 'proof' | 'source' = 'proof', snapshot: WebShareSnapshot | undefined, toastTimer: ReturnType<typeof setTimeout> | undefined;

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
function missing(text?: string) {
  $('#share-loading').hidden = true;
  if (text) $('#share-missing-text').textContent = text;
  $('#share-missing').hidden = false;
}
function showCode() {
  if (!snapshot) return;
  $('#share-code').textContent = view === 'proof' ? snapshot.proof : snapshot.source;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-share-view]'))
    button.setAttribute('aria-pressed', String(button.dataset.shareView === view));
}
function show(share: WebShareSnapshot) {
  snapshot = share;
  document.title = `${share.title} · TheoremOS`;
  $('#share-title').textContent = share.title;
  facts($('#share-facts'), [
    ['证明环境', share.environment === 'mathlib' ? 'Mathlib' : 'Lean 标准库'],
    ['模型', share.model, true], ['推理强度', effortLabels[share.effort] ?? share.effort], ['Agent 数量', String(share.workers)],
    ...share.metrics.map(item => [item.label, item.value] as [string, string]),
    ['完成时间', formatDateTime(share.finishedAt ?? share.createdAt)], ['分享时间', formatDateTime(share.sharedAt)],
  ]);
  $('#share-task').textContent = share.task;
  $('#share-checks').replaceChildren(...share.checks.map(check => {
    const item = document.createElement('li'), heading = document.createElement('div'), label = document.createElement('strong');
    const badge = document.createElement('span');
    heading.className = 'share-check-heading'; label.textContent = check.label;
    badge.className = `badge ${check.tone}`; badge.textContent = check.status;
    heading.append(label, badge);
    item.append(heading);
    if (check.method) {
      const method = document.createElement('p');
      method.className = 'share-check-method'; method.textContent = `方式：${check.method}`;
      item.append(method);
    }
    if (check.targets.length) {
      const list = document.createElement('ul');
      list.className = 'share-targets';
      list.append(...check.targets.map(target => {
        const row = document.createElement('li'), name = document.createElement('code'), state = document.createElement('span');
        name.textContent = target.name; state.className = `share-target-status ${target.tone}`; state.textContent = target.status;
        row.append(name, state);
        return row;
      }));
      item.append(list);
    }
    return item;
  }));
  facts($('#share-identity'), share.identity.map(item => [item.label, item.value, true]));
  $('#share-identity').hidden = !share.identity.length;
  showCode();
  $('#share-loading').hidden = true;
  $('#share-content').hidden = false;
}
async function load() {
  const token = location.hash.slice(1);
  if (!webShareToken.test(token)) { missing('链接不完整，请向分享者重新获取。'); return; }
  try {
    // No credentials: a share reads the same for everyone, signed in or not.
    const response = await fetch(`/api/share/${token}`, { credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => undefined) as { share?: WebShareSnapshot; error?: string } | undefined;
    if (!response.ok || !payload?.share) { missing(response.status === 404 ? undefined : payload?.error ?? '暂时无法读取分享内容，请稍后重试。'); return; }
    show(payload.share);
  } catch { missing('暂时无法连接服务，请稍后重试。'); }
}

document.addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!target || !snapshot) return;
  if (target.dataset.shareView === 'proof' || target.dataset.shareView === 'source') { view = target.dataset.shareView; showCode(); }
  if (target.id === 'share-copy') {
    const text = view === 'proof' ? snapshot.proof : snapshot.source;
    void (navigator.clipboard?.writeText ? navigator.clipboard.writeText(text) : Promise.reject(new Error('clipboard')))
      .then(() => toast('Lean 源码已复制'), () => toast('无法访问剪贴板'));
  }
  if (target.id === 'share-download') {
    const url = URL.createObjectURL(new Blob([view === 'proof' ? snapshot.proof : snapshot.source], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = view === 'proof' ? 'Proof.lean' : 'Problem.lean';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
});
window.addEventListener('hashchange', () => { location.reload(); });
void load();

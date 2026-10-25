export type WebApi = <T>(url: string, init?: RequestInit) => Promise<T>;
export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));
export const jsonText = (value: unknown) => JSON.stringify(value, null, 2) ?? '—';
export const errorText = (error: unknown) => error instanceof Error ? error.message : '请求失败，请重试';
export const commandId = () => crypto.randomUUID();
export function createElement<T extends keyof HTMLElementTagNameMap>(tag: T, className = '', markup?: string) {
  const node = document.createElement(tag); node.className = className;
  if (markup !== undefined) node.innerHTML = markup;
  return node;
}
export function patchSection(node: HTMLElement, markup: string) {
  if (node.dataset.markup === markup) return;
  const top = node.scrollTop, left = node.scrollLeft;
  const focused = document.activeElement instanceof HTMLElement && node.contains(document.activeElement) ? document.activeElement : undefined;
  const key = focused?.dataset.focusKey;
  const expanded = [...node.querySelectorAll<HTMLDetailsElement>('details[open][data-detail-key]')].map(item => item.dataset.detailKey);
  node.innerHTML = markup; node.dataset.markup = markup;
  for (const item of node.querySelectorAll<HTMLDetailsElement>('details[data-detail-key]')) if (expanded.includes(item.dataset.detailKey)) item.open = true;
  if (key) [...node.querySelectorAll<HTMLElement>('[data-focus-key]')].find(item => item.dataset.focusKey === key)?.focus({ preventScroll: true });
  node.scrollTop = top; node.scrollLeft = left;
}
export const codeBlock = (value: unknown) => `<pre class="collab-code" tabindex="0">${escapeHtml(typeof value === 'string' ? value : jsonText(value))}</pre>`;
export const detailBlock = (title: string, value: unknown, key = title) => `<details class="collab-detail" data-detail-key="${escapeHtml(key)}"><summary>${escapeHtml(title)}</summary>${codeBlock(value)}</details>`;
export const factList = (facts: ReadonlyArray<readonly [string, unknown]>) => `<dl class="collab-facts">${facts.map(([name,value]) => `<div><dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value ?? '未记录')}</dd></div>`).join('')}</dl>`;
